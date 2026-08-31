import type { Action, RoundOffer, RoundResult } from "../../shared/types";
import { emitAck } from "../socket";
import { telemetry } from "../telemetry";

type BasicAck = { ok: boolean; error?: string };

export class RoundApi {
  private lastCompanion = "";
  private latestCumulativePoints?: number;

  getLatestCumulativePoints() {
    return this.latestCumulativePoints;
  }

  recordEvent(eventType: string, options: { roundId?: string; phase?: string; payload?: Record<string, unknown> } = {}) {
    telemetry.record(eventType, options);
  }

  async requestRound(): Promise<RoundOffer> {
    const started = performance.now();
    let waitingRecorded = false;
    this.recordEvent("round_requested", { phase: "round_request" });
    for (;;) {
      const response = await emitAck<{ ok: boolean; offer?: RoundOffer; wait?: boolean; error?: string }>("request_round", {});
      if (response.ok && response.offer) {
        this.recordEvent("round_offer_received", {
          roundId: response.offer.roundId,
          phase: "round_request",
          payload: {
            requestDurationMs: Math.round(performance.now() - started),
            macroBlock: response.offer.macroBlock,
            companionOrdinal: response.offer.companionOrdinal,
            validRound: response.offer.validRound,
          },
        });
        return response.offer;
      }
      if (!response.wait) throw new Error(response.error ?? "无法获取轮次");
      if (!waitingRecorded) {
        waitingRecorded = true;
        this.recordEvent("round_waiting", { phase: "round_request", payload: { reason: response.error ?? "waiting" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  shouldIntroduceCompanion(offer: RoundOffer) {
    if (this.lastCompanion === offer.companionLabel) return false;
    this.lastCompanion = offer.companionLabel;
    return true;
  }

  async submitPrediction(roundId: string, action: Action | null, rtMs: number | null, timedOut: boolean) {
    const started = performance.now();
    const response = await emitAck<BasicAck>("submit_prediction", { roundId, action, rtMs, timedOut });
    if (!response.ok) throw new Error(response.error ?? "预测提交失败");
    this.recordEvent("prediction_accepted", {
      roundId,
      phase: "prediction",
      payload: { action, timedOut, networkRoundTripMs: Math.round(performance.now() - started) },
    });
  }

  async registerChoiceTimeout(roundId: string) {
    const response = await emitAck<BasicAck>("choice_timeout", { roundId });
    if (!response.ok) throw new Error(response.error ?? "超时记录失败");
    this.recordEvent("choice_timeout_accepted", { roundId, phase: "choice" });
  }

  async submitChoice(roundId: string, action: Action, rtMs: number): Promise<RoundResult> {
    const started = performance.now();
    this.recordEvent("choice_submit_started", { roundId, phase: "choice", payload: { action, rtMs } });
    let response: { ok: boolean; result?: RoundResult; error?: string } | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await emitAck<{ ok: boolean; result?: RoundResult; error?: string }>(
          "submit_choice", { roundId, action, rtMs }, 16000,
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    if (!response) throw lastError instanceof Error ? lastError : new Error("选择提交暂时中断");
    if (!response.ok || !response.result) throw new Error(response.error ?? "选择提交失败");
    this.latestCumulativePoints = response.result.cumulativePoints;
    this.recordEvent("round_result_received", {
      roundId,
      phase: "result",
      payload: { networkRoundTripMs: Math.round(performance.now() - started) },
    });
    return response.result;
  }
}
