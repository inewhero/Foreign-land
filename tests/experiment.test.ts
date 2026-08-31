import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOT_BETA, GAMES, REGION_THEMES, buildConditions, chooseCompanionAction, delayFor, guardianLabel, regionThemeSequence, totalTrialsForDose, trialsPerCompanion } from "../server/experiment.js";
import { PROTOCOL_VERSION, buildSequenceBank } from "../server/sequence-bank.js";

test("the four requested game families have the intended A/B signs", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(GAMES).map(([key, game]) => [key, [Math.sign(game.a), Math.sign(game.b)]])),
    { pd: [-1, 1], stag: [1, 1], snow: [-1, -1], harmony: [1, -1] },
  );
});

test("each participant receives companions A-H and both beta levels in every game", () => {
  const conditions = buildConditions("PILOT_017", "B");
  assert.equal(conditions.length, 8);
  assert.equal(conditions.map((condition) => condition.companionLabel).join(""), "ABCDEFGH");
  assert.equal(new Set(conditions.map((condition) => condition.game)).size, 4);
  for (const game of Object.keys(GAMES)) {
    const levels = conditions.filter((condition) => condition.game === game).map((condition) => condition.botLevel).sort();
    assert.deepEqual(levels, ["high", "low"]);
  }
});

test("v2 has deterministic nested 96/192 sequence banks with 24 anchors", () => {
  const conditions = buildConditions("PILOT_017", "C");
  const games = [0, 1, 2, 3].map((block) => conditions[block * 2].game);
  const short = buildSequenceBank({ doseCode: "short96", formCode: "C", waveCode: "T0", games });
  const long = buildSequenceBank({ doseCode: "long192", formCode: "C", waveCode: "T0", games });
  assert.equal(short.protocolVersion, PROTOCOL_VERSION);
  assert.equal(short.trials.length, 96);
  assert.equal(long.trials.length, 192);
  assert.equal(short.trials.filter((trial) => trial.anchorId).length, 24);
  assert.equal(trialsPerCompanion("short96"), 12);
  assert.equal(trialsPerCompanion("long192"), 24);
  assert.equal(totalTrialsForDose("short96"), 96);
  assert.equal(buildSequenceBank({ doseCode: "short96", formCode: "C", waveCode: "T0", games }).hash, short.hash);
  for (const trial of short.trials) {
    const nested = long.trials.find((candidate) => candidate.trialTemplateId === trial.trialTemplateId);
    assert.ok(nested);
    assert.deepEqual(
      [nested.observedAction, nested.observedRouteAction, nested.participantRouteAction, nested.evidenceClass, nested.anchorId],
      [trial.observedAction, trial.observedRouteAction, trial.participantRouteAction, trial.evidenceClass, trial.anchorId],
    );
  }
});

test("every v2 companion balances evidence classes and both actions", () => {
  const conditions = buildConditions("BALANCE_021", "A");
  const games = [0, 1, 2, 3].map((block) => conditions[block * 2].game);
  for (const doseCode of ["short96", "long192"] as const) {
    const bank = buildSequenceBank({ doseCode, formCode: "A", waveCode: "T3", games });
    for (let companion = 0; companion < 8; companion += 1) {
      const trials = bank.trials.filter((trial) => trial.companionOrdinal === companion);
      const expectedPerClass = trials.length / 3;
      for (const evidenceClass of ["aligned", "conflict", "neutral"] as const) {
        assert.equal(trials.filter((trial) => trial.evidenceClass === evidenceClass).length, expectedPerClass);
      }
      assert.equal(trials.filter((trial) => trial.observedAction === "cooperate").length, trials.length / 2);
      assert.equal(trials.filter((trial) => trial.observedRouteAction === "cooperate").length, trials.length / 2);
      assert.equal(trials.filter((trial) => trial.participantRouteAction === "cooperate").length, trials.length / 2);
    }
  }
});

test("volatile companions have more action transitions than stable companions", () => {
  const conditions = buildConditions("REGIME_009", "B");
  const games = [0, 1, 2, 3].map((block) => conditions[block * 2].game);
  const bank = buildSequenceBank({ doseCode: "short96", formCode: "B", waveCode: "T2", games });
  const transitions = (companionOrdinal: number) => {
    const actions = bank.trials.filter((trial) => trial.companionOrdinal === companionOrdinal).map((trial) => trial.observedAction);
    return actions.slice(1).filter((action, index) => action !== actions[index]).length;
  };
  for (let block = 0; block < 4; block += 1) assert.ok(transitions(block * 2 + 1) > transitions(block * 2));
});

test("latency profiles are orthogonal to beta and stay inside the declared bounds", () => {
  const conditions = buildConditions("PILOT_017", "B");
  for (const level of ["low", "high"] as const) {
    const profiles = conditions.filter((condition) => condition.botLevel === level).map((condition) => condition.delayProfile).sort();
    assert.deepEqual(profiles, ["deliberate", "steady", "swift", "variable"]);
  }
  for (const profile of ["swift", "steady", "deliberate", "variable"] as const) {
    const first = delayFor(profile, "fixed-seed");
    assert.equal(first, delayFor(profile, "fixed-seed"));
    assert.ok(first >= 320 && first <= 2400);
  }
});

test("high beta produces a more payoff-sensitive switch probability", () => {
  const common = {
    game: "pd" as const,
    previousParticipant: "cooperate" as const,
    previousCompanion: "cooperate" as const,
    seed: "same-seed",
  };
  const low = chooseCompanionAction({ ...common, level: "low" });
  const high = chooseCompanionAction({ ...common, level: "high" });
  assert.equal(BOT_BETA.low, 2);
  assert.equal(BOT_BETA.high, 8);
  assert.ok(Math.abs(high.switchProbability - 0.5) > Math.abs(low.switchProbability - 0.5));
});

test("each location has one stable, location-linked guardian role", () => {
  assert.equal(guardianLabel("青屿"), "青屿守关者");
  assert.equal(guardianLabel("澄港"), "澄港守关者");
});

test("every participant gets all four region colors in a stable randomized order", () => {
  const first = regionThemeSequence("PILOT_017", "A");
  assert.deepEqual(regionThemeSequence("PILOT_017", "A"), first);
  assert.deepEqual([...first].sort(), [...REGION_THEMES].sort());
  const orders = new Set(Array.from({ length: 24 }, (_, index) => regionThemeSequence(`P_${index}`, "A").join("/")));
  assert.ok(orders.size > 1);
  const conditions = buildConditions("PILOT_017", "A");
  for (let block = 0; block < 4; block += 1) {
    assert.equal(conditions[block * 2].regionTheme, conditions[block * 2 + 1].regionTheme);
  }
});

test("participant-facing page metadata keeps the study purpose blinded", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<title>异域同行<\/title>/);
  assert.doesNotMatch(html, /社会学习|beta|β|博弈/i);
});

test("participant sockets receive only their minimal private snapshot", () => {
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const participant = readFileSync(new URL("../src/ParticipantApp.tsx", import.meta.url), "utf8");
  const roundPlugin = readFileSync(new URL("../src/experiment/ExpeditionRoundPlugin.ts", import.meta.url), "utf8");
  assert.doesNotMatch(server, /\.emit\("room_snapshot"/);
  assert.doesNotMatch(server, /\.emit\("assignment_updated"/);
  assert.match(server, /\.emit\("participant_snapshot"/);
  assert.doesNotMatch(participant, /snapshot\?\.roomCode|participant-token|assignment\?\./);
  assert.doesNotMatch(participant, /仅使用匿名研究编号|独立路线回应|随机挑战者/);
  assert.match(participant, /知情同意书/);
  assert.match(participant, /进入全屏签名板/);
  assert.doesNotMatch(participant, /姓名缩写|signedAs/);
  assert.match(server, /该参与者尚未完成知情同意，不能强制开始/);
  assert.match(server, /predictionDeadlineMs: 6000/);
  assert.match(server, /choiceDeadlineMs: 6000/);
  assert.match(server, /signature_data/);
  assert.doesNotMatch(roundPlugin, /同一地区规则 · 不同的一次遭遇|你的决定已封存|这一轮还没有封存/);
  assert.match(roundPlugin, /这一轮还没有提交/);
  assert.match(roundPlugin, /共享补给/);
  assert.match(roundPlugin, /独占补给/);
});

test("room access mode persists and the LAN QR guidance names the Wi-Fi", () => {
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const database = readFileSync(new URL("../server/db.ts", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../src/AdminApp.tsx", import.meta.url), "utf8");
  assert.match(database, /access_mode TEXT NOT NULL DEFAULT 'lan'/);
  assert.match(database, /wifi_name TEXT NOT NULL DEFAULT ''/);
  assert.match(database, /public_base_url TEXT NOT NULL DEFAULT ''/);
  assert.match(server, /app\.post\("\/api\/admin\/access"/);
  assert.match(server, /切换公网模式前，请填写可从互联网访问的入口地址/);
  assert.match(admin, /现场 Wi‑Fi 名称/);
  assert.match(admin, /第一步 · 连接现场 Wi‑Fi/);
  assert.match(admin, /切换本身不会自动创建公网隧道/);
});

test("fine-grained participant events are idempotently stored and separately exported", () => {
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const database = readFileSync(new URL("../server/db.ts", import.meta.url), "utf8");
  const telemetry = readFileSync(new URL("../src/telemetry.ts", import.meta.url), "utf8");
  const roundPlugin = readFileSync(new URL("../src/experiment/ExpeditionRoundPlugin.ts", import.meta.url), "utf8");
  assert.match(database, /CREATE TABLE IF NOT EXISTS participant_events/);
  assert.match(database, /client_event_id TEXT PRIMARY KEY/);
  assert.match(server, /record_participant_events/);
  assert.match(server, /INSERT OR IGNORE INTO participant_events/);
  assert.match(server, /\/api\/admin\/export-events\.csv/);
  assert.match(telemetry, /visibility_changed/);
  assert.match(telemetry, /socket\.connected/);
  assert.match(roundPlugin, /observation_continued/);
  assert.match(roundPlugin, /choice_retry_shown/);
  assert.match(roundPlugin, /feedback_completed/);
});

test("v2 server uses fixed sequence templates and native longitudinal sessions", () => {
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const database = readFileSync(new URL("../server/db.ts", import.meta.url), "utf8");
  assert.match(server, /buildSequenceBank/);
  assert.match(server, /sequenceTrial/);
  assert.doesNotMatch(server, /chooseCompanionAction\(/);
  assert.match(server, /\/api\/admin\/open-next-wave/);
  assert.match(server, /trialsPerCompanion\(participant\.doseCode\)/);
  assert.match(server, /protocolDeviation = true/);
  assert.match(server, /participant_forced_end", \{ protocolDeviation: true \}/);
  assert.match(server, /AS planned_trials/);
  assert.match(server, /AS observed_trials/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS subjects/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS assessment_sessions/);
  assert.match(database, /UNIQUE\(room_code, study_id, wave_code\)/);
  assert.match(database, /VACUUM INTO/);
});

test("formal phenotype artifacts separate pilot and longitudinal AR1 models", () => {
  const pilot = readFileSync(new URL("../analysis/phenotype_pilot.stan", import.meta.url), "utf8");
  const ar1 = readFileSync(new URL("../analysis/phenotype_longitudinal_ar1.stan", import.meta.url), "utf8");
  const prepare = readFileSync(new URL("../analysis/prepare_stan_data.py", import.meta.url), "utf8");
  assert.match(pilot, /lkj_corr_cholesky\(2\)/);
  assert.match(pilot, /session_state/);
  assert.match(ar1, /state_phi/);
  assert.match(ar1, /previous_session/);
  assert.match(prepare, /protocol_version.*ctp-v2/);
  assert.match(prepare, /prediction_brier/);
});

test("the completion page shows the authoritative cumulative score and screenshot request", () => {
  const participant = readFileSync(new URL("../src/ParticipantApp.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(server, /cumulativePoints: participant\.cumulativePoints/);
  assert.match(participant, /您的积分是/);
  assert.match(participant, /finalPoints\?\.toLocaleString/);
  assert.match(participant, /请截图保存本页面。感谢您的支持！/);
  assert.doesNotMatch(participant, /旅程记录已封存/);
});
