import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, Map, Radio, Sparkles } from "lucide-react";
import { initJsPsych } from "jspsych";
import "jspsych/css/jspsych.css";
import type { ParticipantSnapshot, RegionTheme } from "../shared/types";
import { SignaturePad } from "./SignaturePad";
import ExpeditionRoundPlugin from "./experiment/ExpeditionRoundPlugin";
import { RoundApi } from "./experiment/round-api";
import { emitAck, socket } from "./socket";
import { telemetry } from "./telemetry";

type JoinResult = { ok: boolean; participantId?: string; resumeToken?: string; error?: string };
type JoinCredentials = { roomCode: string; studyId: string; resumeToken: string };

export function ParticipantApp() {
  const roomFromLink = useMemo(
    () => new URLSearchParams(location.search).get("room") ?? sessionStorage.getItem("expedition:last-room") ?? "",
    [],
  );
  const [roomCode, setRoomCode] = useState(roomFromLink);
  const [studyId, setStudyId] = useState("");
  const [participantId, setParticipantId] = useState<string>();
  const [snapshot, setSnapshot] = useState<ParticipantSnapshot>();
  const [joinError, setJoinError] = useState("");
  const [experimentRunning, setExperimentRunning] = useState(false);
  const [activeRegionTheme, setActiveRegionTheme] = useState<RegionTheme>();
  const [briefingBlock, setBriefingBlock] = useState<number>();
  const [briefingSeconds, setBriefingSeconds] = useState(12);
  const [consentSeconds, setConsentSeconds] = useState(15);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [signatureData, setSignatureData] = useState("");
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [consentError, setConsentError] = useState("");
  const [sessionEnded, setSessionEnded] = useState("");
  const [restSeconds, setRestSeconds] = useState(60);
  const displayRef = useRef<HTMLDivElement>(null);
  const jsPsychRef = useRef<ReturnType<typeof initJsPsych> | undefined>(undefined);
  const fullscreenOwnedRef = useRef(false);
  const joinCredentialsRef = useRef<JoinCredentials | undefined>(undefined);
  const lastScreenRef = useRef("");
  const consentViewedAtRef = useRef<number | undefined>(undefined);
  const briefingStartedAtRef = useRef<number | undefined>(undefined);
  const roundApi = useMemo(() => new RoundApi(), []);

  const self = snapshot?.self;

  useEffect(() => {
    const onSnapshot = (next: ParticipantSnapshot) => setSnapshot(next);
    const onSessionEnded = (payload: { message: string }) => setSessionEnded(payload.message);
    const onDisconnect = (reason: string) => telemetry.record("socket_disconnected", { phase: "connection", payload: { reason } });
    const onConnect = async () => {
      const credentials = joinCredentialsRef.current;
      if (!credentials) return;
      try {
        const result = await emitAck<JoinResult>("participant_join", credentials);
        if (!result.ok || !result.participantId) throw new Error(result.error ?? "重新连接失败");
        setParticipantId(result.participantId);
        telemetry.record("socket_reconnected", { phase: "connection" });
        telemetry.flushSoon();
      } catch (error) {
        setSessionEnded(error instanceof Error ? error.message : "重新连接失败，请联系主试");
      }
    };
    socket.on("participant_snapshot", onSnapshot);
    socket.on("session_ended", onSessionEnded);
    socket.on("disconnect", onDisconnect);
    socket.on("connect", onConnect);
    return () => {
      socket.off("participant_snapshot", onSnapshot);
      socket.off("session_ended", onSessionEnded);
      socket.off("disconnect", onDisconnect);
      socket.off("connect", onConnect);
    };
  }, []);

  useEffect(() => {
    if (!participantId || !self) return;
    const screen = sessionEnded
      ? "session_ended"
      : !self.consented
        ? "consent"
        : experimentRunning
          ? "experiment"
          : briefingBlock !== undefined
            ? "block_briefing"
            : self.status === "complete"
              ? "completion"
              : self.status === "rest"
                ? "rest"
                : "lobby";
    if (lastScreenRef.current === screen) return;
    lastScreenRef.current = screen;
    if (screen === "consent") consentViewedAtRef.current = performance.now();
    telemetry.record("screen_shown", {
      phase: screen,
      payload: { screen, macroBlock: self.macroBlock, participantStatus: self.status, cumulativePoints: self.cumulativePoints },
    });
  }, [briefingBlock, experimentRunning, participantId, self, sessionEnded]);

  useEffect(() => {
    if (!participantId || !self || self.consented) return;
    const requiredSeconds = self.consentMode === "continuation" ? 5 : 15;
    const startedAt = Date.now();
    const tick = () => setConsentSeconds(Math.max(0, requiredSeconds - Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [participantId, self?.consented, self?.consentMode]);

  useEffect(() => {
    if (briefingBlock === undefined) return;
    const startedAt = Date.now();
    const tick = () => setBriefingSeconds(Math.max(0, 12 - Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [briefingBlock]);

  useEffect(() => {
    if (self?.status !== "rest" || !self.restReadyAt) return;
    const readyAt = new Date(self.restReadyAt).getTime();
    const tick = () => setRestSeconds(Math.max(0, Math.ceil((readyAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [self?.status, self?.restReadyAt]);

  useEffect(() => {
    // Natural rest/complete transitions arrive before the final 3 s feedback ends.
    // Let jsPsych finish that feedback and its fixed-length block timeline cleanly.
    if (!experimentRunning || (!sessionEnded && self?.status !== "lobby")) return;
    jsPsychRef.current?.abortExperiment();
    jsPsychRef.current = undefined;
    setExperimentRunning(false);
  }, [experimentRunning, self?.status, sessionEnded]);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    setJoinError("");
    try {
      const resumeKey = `expedition:${roomCode}:${studyId}`;
      const savedResumeToken = localStorage.getItem(resumeKey);
      const result = await emitAck<JoinResult>("participant_join", {
        roomCode,
        studyId,
        resumeToken: savedResumeToken ?? undefined,
      });
      if (!result.ok || !result.participantId || !result.resumeToken) throw new Error(result.error ?? "无法加入房间");
      localStorage.setItem(resumeKey, result.resumeToken);
      sessionStorage.setItem("expedition:last-room", roomCode);
      history.replaceState(null, "", location.pathname);
      joinCredentialsRef.current = { roomCode, studyId, resumeToken: result.resumeToken };
      telemetry.start({ roomCode, resumed: Boolean(savedResumeToken) });
      telemetry.record("participant_join_accepted", { phase: "connection" });
      setParticipantId(result.participantId);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "加入失败");
    }
  }

  async function runCurrentBlock() {
    if (experimentRunning) return;
    setActiveRegionTheme(self?.regionTheme);
    telemetry.record("block_briefing_continued", {
      phase: "block_briefing",
      payload: {
        macroBlock: briefingBlock,
        durationMs: briefingStartedAtRef.current === undefined ? null : Math.round(performance.now() - briefingStartedAtRef.current),
      },
    });
    setExperimentRunning(true);
    setBriefingBlock(undefined);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!displayRef.current) {
      setExperimentRunning(false);
      return;
    }
    const jsPsych = initJsPsych({
      display_element: displayRef.current,
      on_finish: () => {
        telemetry.record("block_timeline_finished", { phase: "block", payload: { macroBlock: briefingBlock } });
        telemetry.flushSoon();
        setExperimentRunning(false);
      },
    });
    telemetry.record("block_timeline_started", { phase: "block", payload: { macroBlock: briefingBlock } });
    jsPsychRef.current = jsPsych;
    const serverRemainingTrials = self?.remainingTrialsInBlock;
    const remainingTrials = Number.isInteger(serverRemainingTrials) && Number(serverRemainingTrials) > 0
      ? Number(serverRemainingTrials)
      : 60;
    const timeline = Array.from({ length: remainingTrials }, () => ({ type: ExpeditionRoundPlugin, api: roundApi }));
    await jsPsych.run(timeline);
    if (jsPsychRef.current === jsPsych) jsPsychRef.current = undefined;
  }

  async function markReady() {
    const response = await emitAck<{ ok: boolean; error?: string }>("participant_ready", {});
    if (!response.ok) throw new Error(response.error ?? "准备状态提交失败");
    telemetry.record("rest_ready_submitted", { phase: "rest", payload: { remainingSeconds: restSeconds } });
  }

  async function submitConsent(event: React.FormEvent) {
    event.preventDefault();
    setConsentError("");
    telemetry.record("consent_submit_started", {
      phase: "consent",
      payload: {
        readingDurationMs: consentViewedAtRef.current === undefined ? null : Math.round(performance.now() - consentViewedAtRef.current),
        accepted: consentAccepted,
        signaturePresent: Boolean(signatureData),
      },
    });
    try {
      const response = await emitAck<{ ok: boolean; error?: string }>("submit_consent", { accepted: consentAccepted, signatureData });
      if (!response.ok) throw new Error(response.error ?? "知情同意提交失败");
      telemetry.record("consent_accepted", { phase: "consent" });
      telemetry.flushSoon();
    } catch (error) {
      telemetry.record("consent_submit_failed", { phase: "consent", payload: { message: error instanceof Error ? error.message : String(error) } });
      setConsentError(error instanceof Error ? error.message : "知情同意提交失败");
    }
  }

  function openSignaturePad() {
    telemetry.record("signature_pad_opened", { phase: "consent" });
    setSignatureOpen(true);
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: "hide" })
        .then(() => { fullscreenOwnedRef.current = true; })
        .catch(() => { fullscreenOwnedRef.current = false; });
    }
  }

  function closeSignaturePad(saved = false) {
    telemetry.record("signature_pad_closed", { phase: "consent", payload: { saved: saved || Boolean(signatureData) } });
    setSignatureOpen(false);
    if (fullscreenOwnedRef.current && document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
    fullscreenOwnedRef.current = false;
  }

  function saveSignature(data: string) {
    setSignatureData(data);
    telemetry.record("signature_saved", { phase: "consent", payload: { dataBytesApprox: Math.round(data.length * 0.75) } });
    closeSignaturePad(true);
  }

  function showBlockBriefing() {
    if (!self) return;
    briefingStartedAtRef.current = performance.now();
    telemetry.record("block_briefing_opened", { phase: "block_briefing", payload: { macroBlock: self.macroBlock } });
    setBriefingSeconds(12);
    setBriefingBlock(self.macroBlock);
  }

  if (!participantId) {
    return (
      <main className="landing-shell">
        <section className="landing-card">
          <div className="eyebrow"><Compass size={16} /> 异域同行</div>
          <div className="title-lockup">
            <span className="map-ring" aria-hidden="true"><Map /></span>
            <div>
              <h1>从一段未知旅程开始</h1>
              <p>准备好后，请按照页面提示继续前行。</p>
            </div>
          </div>
          <form onSubmit={join} className="join-form">
            {!/^[0-9]{6}$/.test(roomFromLink) && (
              <label>
                <span>房间码</span>
                <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="6 位数字" required />
              </label>
            )}
            <label>
              <span>研究编号</span>
              <input autoCapitalize="off" autoCorrect="off" value={studyId} onChange={(e) => setStudyId(e.target.value.trim())} placeholder="由主试提供" required />
            </label>
            {joinError && <div className="form-error">{joinError}</div>}
            <button className="primary-button" type="submit">进入集结点</button>
          </form>
        </section>
      </main>
    );
  }

  if (sessionEnded) {
    return (
      <main className="landing-shell">
        <section className="landing-card completion-card">
          <div className="eyebrow">记录已结束</div>
          <h1>请联系现场主试</h1>
          <p>{sessionEnded}</p>
        </section>
      </main>
    );
  }

  if (!snapshot || !self) {
    return <main className="admin-loading">正在载入行程…</main>;
  }

  if (!self.consented) {
    const continuation = self.consentMode === "continuation";
    return (
      <>
        <main className="landing-shell consent-shell">
          <section className="landing-card consent-card">
          <div className="eyebrow">{continuation ? "继续参加确认" : "参与前说明"}</div>
          <h1>{continuation ? "本次行程确认" : "知情同意书"}</h1>
          <div className="consent-copy">
            {continuation ? (
              <>
                <p>你此前已经签署本研究知情同意书。本次仍将观察同行记录、作出预测与选择，并获得虚拟积分。</p>
                <p>继续参加完全自愿；你仍可随时停止并联系主试，不会受到惩罚。数据记录与保密方式没有改变。</p>
              </>
            ) : (
              <>
                <p>本研究关注连续决策情境中的判断过程。你将观察若干匿名同行记录、作出预测与选择，并获得虚拟积分；流程分为四段，中间可以休息，实际时长因行程安排而异。</p>
                <h2>可能的不适与退出</h2>
                <p>连续作答可能带来轻微疲劳。参加完全自愿，你可以随时停止并联系主试，不会受到惩罚。</p>
                <h2>记录与保密</h2>
                <p>系统记录研究编号、手写签名、选择、反应时间与连接状态。数据保存在主试电脑中，仅用于研究分析。</p>
                <h2>必要的信息保留</h2>
                <p>为避免影响判断，任务的部分安排将在全部流程结束后统一说明。届时你可以提问，并按研究方案申请撤回自己的记录。</p>
              </>
            )}
          </div>
          <form className="consent-form" onSubmit={submitConsent}>
            <label className="consent-check">
              <input type="checkbox" checked={consentAccepted} onChange={(event) => setConsentAccepted(event.target.checked)} />
              <span>{continuation ? "我确认继续参加本次行程，并理解仍可随时退出。" : "我已阅读以上说明，理解可以随时退出，并自愿参加。"}</span>
            </label>
            {!continuation && <div className="signature-field">
              <span>手写电子签名</span>
              {signatureData ? (
                <div className="signature-preview">
                  <img src={signatureData} alt="已保存的手写签名" />
                  <button type="button" onClick={openSignaturePad}>重新签写</button>
                </div>
              ) : (
                <button type="button" className="signature-launch" onClick={openSignaturePad}>进入全屏签名板</button>
              )}
            </div>}
            {consentError && <div className="form-error">{consentError}</div>}
            <button className="primary-button" type="submit" disabled={consentSeconds > 0 || !consentAccepted || (!continuation && !signatureData)}>
              {consentSeconds > 0 ? `请继续阅读 ${consentSeconds} 秒` : continuation ? "确认并进入集结点" : "签署并进入集结点"}
            </button>
          </form>
          </section>
        </main>
        <SignaturePad open={signatureOpen} onCancel={closeSignaturePad} onSave={saveSignature} />
      </>
    );
  }

  if (experimentRunning) return <div className={`experiment-viewport ${activeRegionTheme ? `region-theme-${activeRegionTheme}` : ""}`} ref={displayRef} />;

  if (briefingBlock !== undefined) {
    return (
      <main className={`landing-shell briefing-shell ${self.regionTheme ? `region-theme-${self.regionTheme}` : ""}`}>
        <section className="landing-card briefing-card">
          <div className="eyebrow"><Compass size={15} /> 行前说明</div>
          <h1>{self.locationName ? `即将进入${self.locationName}` : "新的路线即将开始"}</h1>
          <p className="briefing-lead">每个地区代表一种稳定的遭遇环境，并有一位同名守关者。在当前地区内，所有遭遇遵循相同规则。</p>
          <ol className="briefing-steps">
            <li><strong>观察</strong><span>查看同行者在本地区与守关者的一次过往遭遇。</span></li>
            <li><strong>判断</strong><span>预测这位同行者下一次更可能采取的行动。</span></li>
            <li><strong>选择</strong><span>在同一地区独立经历一次新的同类遭遇：合作表示共享补给，背叛表示独占补给。</span></li>
          </ol>
          <p className="briefing-note">请凭当下判断作答，不必计算，也不要返回修改。</p>
          <button className="primary-button" disabled={briefingSeconds > 0} onClick={runCurrentBlock}>
            {briefingSeconds > 0 ? `请继续阅读 ${briefingSeconds} 秒` : "我已读完，开始路线"}
          </button>
        </section>
      </main>
    );
  }

  if (self?.status === "complete") {
    const finalPoints = Number.isFinite(self.cumulativePoints)
      ? self.cumulativePoints
      : roundApi.getLatestCumulativePoints();
    return (
      <main className="landing-shell">
        <section className="landing-card completion-card">
          <Sparkles />
          <div className="eyebrow">旅程结束</div>
          <h1>您的积分是 <span className="final-score">{finalPoints?.toLocaleString("zh-CN") ?? "—"}</span> 分</h1>
          <p>请截图保存本页面。感谢您的支持！</p>
        </section>
      </main>
    );
  }

  if (self?.status === "rest") {
    return (
      <main className="landing-shell">
        <section className="landing-card rest-card">
          <div className="eyebrow">营地休整</div>
          <div className="rest-clock">{restSeconds > 0 ? restSeconds : "✓"}</div>
          <h1>{restSeconds > 0 ? "让目光离开屏幕片刻" : "可以继续前行了"}</h1>
          <p>下一处地点将在所有同行者准备完成后，由主试统一开启。</p>
          <button className="primary-button" disabled={restSeconds > 0 || self.ready} onClick={markReady}>
            {self.ready ? "已报告准备" : "我已准备好"}
          </button>
        </section>
      </main>
    );
  }

  const canStart = snapshot?.roomStatus === "running" && self?.status === "active" && snapshot.activeMacroBlock === self.macroBlock;
  return (
    <main className="landing-shell">
      <section className="landing-card lobby-card">
        <div className="eyebrow"><Radio size={15} /> 集结完成</div>
        <h1>{canStart ? "新的路线已经开放" : "请等待主试通知"}</h1>
        <p>{canStart ? "开始前会先显示本段路线的完整说明。" : "页面会在路线开放后自动更新，无需刷新。"}</p>
        <button className="primary-button" disabled={!canStart} onClick={showBlockBriefing}>
          {canStart ? "阅读路线说明" : "等待开放"}
        </button>
        <div className="quiet-note">请勿切换应用或锁定屏幕</div>
      </section>
      <div className="experiment-viewport offscreen" ref={displayRef} />
    </main>
  );
}
