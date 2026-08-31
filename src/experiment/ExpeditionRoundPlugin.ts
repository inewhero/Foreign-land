import { ParameterType, type JsPsych, type JsPsychPlugin } from "jspsych";
import type { Action, RoundOffer, RoundResult } from "../../shared/types";
import type { RoundApi } from "./round-api";

const info = {
  name: "expedition-round",
  version: "1.0.0",
  parameters: {
    api: { type: ParameterType.COMPLEX, default: undefined },
  },
  data: {
    round_id: { type: ParameterType.STRING },
    macro_block: { type: ParameterType.INT },
    region_theme: { type: ParameterType.STRING },
    location_name: { type: ParameterType.STRING },
    companion_label: { type: ParameterType.STRING },
    companion_ordinal: { type: ParameterType.INT },
    observed_action: { type: ParameterType.STRING },
    observed_route_action: { type: ParameterType.STRING },
    observed_display_points: { type: ParameterType.INT },
    guardian_label: { type: ParameterType.STRING },
    valid_round: { type: ParameterType.INT },
    prediction: { type: ParameterType.STRING },
    prediction_rt: { type: ParameterType.INT },
    prediction_timed_out: { type: ParameterType.BOOL },
    choice: { type: ParameterType.STRING },
    choice_rt: { type: ParameterType.INT },
    route_action: { type: ParameterType.STRING },
    display_points: { type: ParameterType.INT },
    normalized_payoff: { type: ParameterType.FLOAT },
    cumulative_points: { type: ParameterType.INT },
    intended_delay_ms: { type: ParameterType.INT },
    actual_delay_ms: { type: ParameterType.INT },
  },
} as const;

type Info = typeof info;

const actionLabel = (action: Action) => (action === "cooperate" ? "合作" : "背叛");
const actionMeaning = (action: Action) => (action === "cooperate" ? "共享补给" : "独占补给");
const actionGlyph = (action: Action) => action === "cooperate"
  ? `<svg class="cooperate-mark" viewBox="0 0 56 48" aria-hidden="true"><circle cx="18" cy="24" r="10"></circle><circle cx="38" cy="24" r="10"></circle><path d="M25 24h6"></path></svg>`
  : `<svg class="betray-mark" viewBox="0 0 56 48" aria-hidden="true"><path d="M20 20v-4a8 8 0 0 1 16 0v4"></path><rect x="14" y="20" width="28" height="22" rx="5"></rect><circle cx="28" cy="31" r="3"></circle></svg>`;

export default class ExpeditionRoundPlugin implements JsPsychPlugin<Info> {
  static info = info;
  private currentApi?: RoundApi;

  constructor(private jsPsych: JsPsych) {}

  async trial(displayElement: HTMLElement, trial: { api: RoundApi }) {
    const api = trial.api;
    this.currentApi = api;
    let offer: RoundOffer;
    displayElement.innerHTML = `
      <main class="trial-shell waiting-shell" aria-live="polite">
        <div class="waiting-orbit"><span></span><span></span><span></span></div>
        <h2>正在接收远方记录</h2>
        <p>不同同行者的记录抵达速度并不相同。</p>
      </main>
    `;
    api.recordEvent("round_loading_shown", { phase: "round_request" });
    try {
      offer = await api.requestRound();
    } catch (error) {
      api.recordEvent("round_request_failed", { phase: "round_request", payload: { message: error instanceof Error ? error.message : String(error) } });
      this.renderError(displayElement, error);
      return;
    }
    displayElement.classList.remove("region-theme-moss", "region-theme-slate", "region-theme-earth", "region-theme-plum");
    displayElement.classList.add(`region-theme-${offer.regionTheme}`);

    if (api.shouldIntroduceCompanion(offer)) {
      await this.showCompanionIntro(displayElement, offer);
    }

    await this.showObservation(displayElement, offer);

    const prediction = await this.askAction(
      displayElement,
      offer,
      `根据刚才的记录，同行者 ${offer.companionLabel} 下一次更可能怎么做？`,
      offer.predictionDeadlineMs,
      "prediction",
      true,
      1,
    );
    await api.submitPrediction(offer.roundId, prediction.action, prediction.rtMs, prediction.timedOut);

    let choice: { action: Action | null; rtMs: number | null; timedOut: boolean };
    let choiceAttempt = 0;
    for (;;) {
      choiceAttempt += 1;
      choice = await this.askAction(
        displayElement,
        offer,
        `轮到你在${offer.locationName}经历一次新的同类遭遇。你会共享补给，还是独占补给？`,
        offer.choiceDeadlineMs,
        "choice",
        false,
        choiceAttempt,
      );
      if (!choice.timedOut && choice.action && choice.rtMs !== null) break;
      await api.registerChoiceTimeout(offer.roundId);
      await this.showRetry(displayElement, offer);
    }

    let result: RoundResult;
    try {
      result = await api.submitChoice(offer.roundId, choice.action, choice.rtMs);
    } catch (error) {
      api.recordEvent("choice_submit_failed", { roundId: offer.roundId, phase: "choice", payload: { message: error instanceof Error ? error.message : String(error) } });
      this.renderError(displayElement, error);
      return;
    }

    await this.showResult(displayElement, offer, result);
    api.recordEvent("round_completed", { roundId: offer.roundId, phase: "round", payload: { choiceAttempts: choiceAttempt } });
    this.jsPsych.finishTrial({
      round_id: offer.roundId,
      macro_block: offer.macroBlock,
      region_theme: offer.regionTheme,
      location_name: offer.locationName,
      companion_label: offer.companionLabel,
      companion_ordinal: offer.companionOrdinal,
      observed_action: offer.observedAction,
      observed_route_action: offer.observedRouteAction,
      observed_display_points: offer.observedDisplayPoints,
      guardian_label: offer.guardianLabel,
      valid_round: offer.validRound,
      prediction: prediction.action,
      prediction_rt: prediction.rtMs,
      prediction_timed_out: prediction.timedOut,
      choice: choice.action,
      choice_rt: choice.rtMs,
      route_action: result.routeAction,
      display_points: result.displayPoints,
      normalized_payoff: result.normalizedPayoff,
      cumulative_points: result.cumulativePoints,
      intended_delay_ms: result.intendedDelayMs,
      actual_delay_ms: result.actualDelayMs,
    });
  }

  private trialHeader(offer: RoundOffer, points = offer.cumulativePoints) {
    return `
      <header class="trial-header">
        <span class="location-mark">${offer.locationName}</span>
        <span>同行者 ${offer.companionLabel}</span>
        <span>${offer.validRound} / ${offer.totalRoundsWithCompanion}</span>
      </header>
      <div class="score-dock" aria-label="当前累计积分">积分 <strong>${points}</strong></div>
    `;
  }

  private showCompanionIntro(displayElement: HTMLElement, offer: RoundOffer) {
    return new Promise<void>((resolve) => {
      const started = performance.now();
      this.record(offer, "companion_intro_shown", "companion_intro");
      displayElement.innerHTML = `
        <main class="trial-shell companion-intro">
          ${this.trialHeader(offer)}
          <div class="coordinate-label">${offer.locationName} · 新同行者</div>
          <div class="companion-seal" aria-hidden="true">${offer.companionLabel}</div>
          <h1>同行者 ${offer.companionLabel}</h1>
          <p>${offer.locationName}的所有遭遇都由“${offer.guardianLabel}”回应。每次双方都要在合作（共享补给）与背叛（独占补给）之间选择。你先查看同行者过去的一次遭遇，再独立经历一次同类遭遇。</p>
          <button class="primary-button" type="button" disabled>请阅读 5 秒</button>
        </main>
      `;
      const button = displayElement.querySelector<HTMLButtonElement>("button");
      if (!button) return;
      let seconds = 5;
      const timer = window.setInterval(() => {
        seconds -= 1;
        if (seconds > 0) {
          button.textContent = `请阅读 ${seconds} 秒`;
          return;
        }
        window.clearInterval(timer);
        button.disabled = false;
        button.textContent = "接收记录";
      }, 1000);
      button.addEventListener("click", () => {
        this.record(offer, "companion_intro_continued", "companion_intro", { durationMs: Math.round(performance.now() - started) });
        resolve();
      }, { once: true });
    });
  }

  private showObservation(displayElement: HTMLElement, offer: RoundOffer) {
    return new Promise<void>((resolve) => {
      const started = performance.now();
      this.record(offer, "observation_shown", "observation");
      displayElement.innerHTML = `
        <main class="trial-shell observation-shell">
          ${this.trialHeader(offer)}
          <div class="phase-kicker">远方记录</div>
          <h2>同行者 ${offer.companionLabel} 在${offer.locationName}的一次过往遭遇</h2>
          <div class="observation-pair">
            <section>
              <span>同行者 ${offer.companionLabel}</span>
              <div class="result-glyph">${actionGlyph(offer.observedAction)}</div>
              <strong>${actionLabel(offer.observedAction)}</strong>
              <small>${actionMeaning(offer.observedAction)}</small>
            </section>
            <div class="route-line"></div>
            <section>
              <span>${offer.guardianLabel}</span>
              <div class="result-glyph">${actionGlyph(offer.observedRouteAction)}</div>
              <strong>${actionLabel(offer.observedRouteAction)}</strong>
              <small>${actionMeaning(offer.observedRouteAction)}</small>
            </section>
          </div>
          <div class="record-payoff">同行者本轮获得 <strong>+${offer.observedDisplayPoints}</strong></div>
          <button class="primary-button" type="button">记录已看清</button>
        </main>
      `;
      displayElement.querySelector("button")?.addEventListener("click", () => {
        this.record(offer, "observation_continued", "observation", { durationMs: Math.round(performance.now() - started) });
        resolve();
      }, { once: true });
    });
  }

  private askAction(
    displayElement: HTMLElement,
    offer: RoundOffer,
    title: string,
    deadlineMs: number,
    phase: "prediction" | "choice",
    allowTimeout: boolean,
    attempt: number,
  ) {
    return new Promise<{ action: Action | null; rtMs: number | null; timedOut: boolean }>((resolve) => {
      const started = performance.now();
      const deadlineSeconds = Math.round(deadlineMs / 1000);
      this.record(offer, `${phase}_shown`, phase, { attempt, deadlineMs });
      displayElement.innerHTML = `
        <main class="trial-shell decision-shell ${phase}">
          ${this.trialHeader(offer)}
          <div class="decision-copy">
            <div class="phase-kicker">${phase === "prediction" ? "观察判断" : "你的抉择"}</div>
            <h2>${title}</h2>
            <p>${deadlineSeconds} 秒内作答</p>
          </div>
          <div class="action-grid" role="group" aria-label="合作或背叛">
            <button class="action-button cooperate" data-action="cooperate" type="button">
              <span class="action-glyph">${actionGlyph("cooperate")}</span>
              <strong>合作</strong><small>共享补给</small>
            </button>
            <button class="action-button betray" data-action="betray" type="button">
              <span class="action-glyph">${actionGlyph("betray")}</span>
              <strong>背叛</strong><small>独占补给</small>
            </button>
          </div>
          <div class="time-rail" aria-hidden="true"><span style="animation-duration:${deadlineMs}ms"></span></div>
        </main>
      `;

      let settled = false;
      const finish = (action: Action | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const elapsedMs = Math.round(performance.now() - started);
        this.record(offer, timedOut ? `${phase}_timed_out` : `${phase}_responded`, phase, {
          action,
          attempt,
          durationMs: elapsedMs,
          deadlineMs,
        });
        resolve({ action, rtMs: timedOut ? null : elapsedMs, timedOut });
      };
      displayElement.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
        button.addEventListener("click", () => finish(button.dataset.action as Action, false), { once: true });
      });
      const timer = window.setTimeout(() => finish(null, true), deadlineMs);
      if (!allowTimeout) {
        // Choice timeout is handled by the caller and the same sealed round is retried.
      }
    });
  }

  private showRetry(displayElement: HTMLElement, offer: RoundOffer) {
    return new Promise<void>((resolve) => {
      const started = performance.now();
      this.record(offer, "choice_retry_shown", "choice_retry");
      displayElement.innerHTML = `
        <main class="trial-shell retry-shell">
          ${this.trialHeader(offer)}
          <div class="warning-mark">!</div>
          <h2>这一轮还没有提交</h2>
          <p>请保持页面开启，准备好后重新作答。本轮地区和守关规则不会改变。</p>
          <button class="primary-button" type="button">重新作答</button>
        </main>
      `;
      displayElement.querySelector("button")?.addEventListener("click", () => {
        this.record(offer, "choice_retry_continued", "choice_retry", { durationMs: Math.round(performance.now() - started) });
        resolve();
      }, { once: true });
    });
  }

  private showResult(displayElement: HTMLElement, offer: RoundOffer, result: RoundResult) {
    return new Promise<void>((resolve) => {
      const started = performance.now();
      this.record(offer, "feedback_shown", "feedback", { displayPoints: result.displayPoints, cumulativePoints: result.cumulativePoints });
      displayElement.innerHTML = `
        <main class="trial-shell result-shell" aria-live="polite">
          ${this.trialHeader(offer, result.cumulativePoints)}
          <div class="result-pair">
            <section>
              <span>你</span>
              <div class="result-glyph">${actionGlyph(result.participantAction)}</div>
              <strong>${actionLabel(result.participantAction)}</strong>
              <small>${actionMeaning(result.participantAction)}</small>
            </section>
            <div class="route-line"></div>
            <section>
              <span>${offer.guardianLabel}</span>
              <div class="result-glyph">${actionGlyph(result.routeAction)}</div>
              <strong>${actionLabel(result.routeAction)}</strong>
              <small>${actionMeaning(result.routeAction)}</small>
            </section>
          </div>
          <div class="points-reveal">
            <span>本轮获得</span>
            <strong>+${result.displayPoints}</strong>
            <span>累计 ${result.cumulativePoints}</span>
          </div>
        </main>
      `;
      window.setTimeout(() => {
        this.record(offer, "feedback_completed", "feedback", { durationMs: Math.round(performance.now() - started) });
        resolve();
      }, 3000);
    });
  }

  private record(offer: RoundOffer, eventType: string, phase: string, payload?: Record<string, unknown>) {
    // The API queues idempotent client events; rendering never waits on telemetry.
    this.currentApi?.recordEvent(eventType, { roundId: offer.roundId, phase, payload });
  }

  private renderError(displayElement: HTMLElement, error: unknown) {
    const message = error instanceof Error ? error.message : "未知错误";
    displayElement.innerHTML = `
      <main class="trial-shell retry-shell">
        <div class="warning-mark">!</div>
        <h2>路线暂时中断</h2>
        <p>${message}</p>
        <p>请保持页面开启并联系主试。</p>
      </main>
    `;
  }
}
