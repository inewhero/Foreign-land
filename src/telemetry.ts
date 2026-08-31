import type { ParticipantEventRecord } from "../shared/types";
import { emitAck, socket } from "./socket";

interface RecordOptions {
  roundId?: string;
  phase?: string;
  payload?: Record<string, unknown>;
}

type EventAck = { ok: boolean; accepted?: number; error?: string };

class ParticipantTelemetry {
  private readonly sessionId = `session:${crypto.randomUUID()}`;
  private sequence = 0;
  private enabled = false;
  private listenersAttached = false;
  private queue: ParticipantEventRecord[] = [];
  private flushTimer?: number;
  private flushing = false;
  private resizeTimer?: number;

  start(payload: Record<string, unknown> = {}) {
    if (this.enabled) return;
    this.enabled = true;
    this.attachGlobalListeners();
    this.record("session_started", {
      phase: "session",
      payload: {
        ...payload,
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        maxTouchPoints: navigator.maxTouchPoints,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        path: location.pathname,
      },
    });
  }

  record(eventType: string, options: RecordOptions = {}) {
    if (!this.enabled) return;
    const event: ParticipantEventRecord = {
      clientEventId: `ev:${crypto.randomUUID()}`,
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      eventType,
      roundId: options.roundId,
      phase: options.phase,
      clientTime: new Date().toISOString(),
      clientMonotonicMs: Math.round(performance.now() * 10) / 10,
      visibilityState: document.visibilityState,
      fullscreen: Boolean(document.fullscreenElement),
      online: navigator.onLine,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      payload: options.payload,
    };
    this.queue.push(event);
    if (this.queue.length > 2_000) this.queue.splice(0, this.queue.length - 2_000);
    this.scheduleFlush(this.queue.length >= 20 ? 0 : 600);
  }

  flushSoon() {
    this.scheduleFlush(0);
  }

  private scheduleFlush(delayMs: number) {
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, delayMs);
  }

  private async flush() {
    if (this.flushing || !this.queue.length) return;
    if (!socket.connected) {
      this.scheduleFlush(1_500);
      return;
    }
    this.flushing = true;
    const batch = this.queue.slice(0, 50);
    try {
      const response = await emitAck<EventAck>("record_participant_events", { events: batch }, 6_000);
      if (!response.ok) throw new Error(response.error ?? "过程记录提交失败");
      const sentIds = new Set(batch.map((event) => event.clientEventId));
      this.queue = this.queue.filter((event) => !sentIds.has(event.clientEventId));
    } catch {
      // Keep the idempotent batch in memory and retry after the connection recovers.
    } finally {
      this.flushing = false;
      if (this.queue.length) this.scheduleFlush(1_500);
    }
  }

  private attachGlobalListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    document.addEventListener("visibilitychange", () => {
      this.record("visibility_changed", { phase: "device", payload: { state: document.visibilityState } });
      if (document.visibilityState === "hidden") this.flushSoon();
    });
    document.addEventListener("fullscreenchange", () => {
      this.record("fullscreen_changed", { phase: "device", payload: { active: Boolean(document.fullscreenElement) } });
    });
    window.addEventListener("online", () => this.record("network_online", { phase: "device" }));
    window.addEventListener("offline", () => this.record("network_offline", { phase: "device" }));
    window.addEventListener("orientationchange", () => {
      this.record("orientation_changed", { phase: "device", payload: { angle: window.screen.orientation?.angle ?? null } });
    });
    window.addEventListener("resize", () => {
      if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.record("viewport_changed", { phase: "device" });
      }, 350);
    });
    window.addEventListener("pagehide", () => {
      this.record("page_hidden", { phase: "session" });
      this.flushSoon();
    });
  }
}

export const telemetry = new ParticipantTelemetry();
