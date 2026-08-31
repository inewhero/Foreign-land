import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { io } from "socket.io-client";

const [baseUrl, roomCode, adminToken, startText = "0", countText = "1", outputName = "batch"] = process.argv.slice(2);
if (!baseUrl || !roomCode || !adminToken) {
  console.error("用法: node scripts/simulate-participants.mjs <baseUrl> <roomCode> <adminToken> [start] [count] [outputName]");
  process.exit(1);
}

const startIndex = Number(startText);
const count = Number(countText);
const sigmoid = (value) => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
const rewardValue = (points) => (Number(points) - 20) / 20;
const actionSign = (action) => action === "cooperate" ? 1 : -1;

function seededRandom(seed) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode, adminToken, ...body }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${result.error ?? response.status}`);
  return result;
}

function makeEvent(sessionId, sequence, eventType, roundId, phase, payload, monotonic) {
  return {
    clientEventId: `ev:${crypto.randomUUID()}`,
    sessionId,
    sequence,
    eventType,
    roundId,
    phase,
    clientTime: new Date().toISOString(),
    clientMonotonicMs: monotonic,
    visibilityState: "visible",
    fullscreen: true,
    online: true,
    viewportWidth: 390,
    viewportHeight: 844,
    screenWidth: 390,
    screenHeight: 844,
    devicePixelRatio: 3,
    payload,
  };
}

async function simulate(index) {
  const studyId = `SIM_${String(index + 1).padStart(2, "0")}`;
  const random = seededRandom(studyId);
  const betaSocial = 0.45 + index * 0.35;
  const betaSelf = 0.75 + (index % 3) * 0.15;
  const imitation = 0.12 + (index % 2) * 0.08;
  const persistence = 0.18 + (index % 4) * 0.05;
  const intercept = -0.15 + (index % 5) * 0.075;
  const alphaSocial = 0.35;
  const alphaSelf = 0.3;
  const sessionId = `session:${crypto.randomUUID()}`;
  const socket = io(baseUrl, { transports: ["websocket", "polling"], reconnection: true });
  const emit = (event, payload, timeout = 12_000) => new Promise((resolvePromise, reject) => {
    socket.timeout(timeout).emit(event, payload, (error, result) => error ? reject(error) : resolvePromise(result));
  });
  await new Promise((resolvePromise, reject) => {
    socket.once("connect", resolvePromise);
    socket.once("connect_error", reject);
  });
  const joined = await emit("participant_join", { roomCode, studyId });
  if (!joined.ok) throw new Error(`${studyId}: ${joined.error}`);
  await post("/api/admin/assignment", {
    participantId: joined.participantId,
    waveCode: "T0",
    groupCode: index % 2 === 0 ? "实验" : "对照",
    notes: `SIM true_beta_social=${betaSocial.toFixed(2)} beta_self=${betaSelf.toFixed(2)}`,
  });
  const signatureData = `data:image/png;base64,iVBORw0KGgo${"A".repeat(320)}`;
  const consent = await emit("submit_consent", { accepted: true, signatureData });
  if (!consent.ok) throw new Error(`${studyId}: ${consent.error}`);

  let socialQ = [0, 0];
  let selfQ = [0, 0];
  let previousChoice = 0;
  let previousCompanion = -1;
  let previousBlock = -1;
  let cumulativePoints = 0;
  let cooperateCount = 0;
  let sequence = 0;
  let monotonic = 0;
  let eventBuffer = [];

  async function flushEvents() {
    if (!eventBuffer.length) return;
    const batch = eventBuffer;
    eventBuffer = [];
    const response = await emit("record_participant_events", { events: batch });
    if (!response.ok) throw new Error(`${studyId}: ${response.error}`);
  }

  await post("/api/admin/participant-control", { participantId: joined.participantId, action: "force_start" });
  for (let trialIndex = 0; trialIndex < 240; trialIndex += 1) {
    if (trialIndex > 0 && trialIndex % 60 === 0) {
      await post("/api/admin/participant-control", { participantId: joined.participantId, action: "force_start" });
    }
    const requestedAt = performance.now();
    const response = await emit("request_round", {}, 20_000);
    if (!response.ok || !response.offer) throw new Error(`${studyId}: ${response.error ?? "offer missing"}`);
    const offer = response.offer;
    if (offer.companionOrdinal !== previousCompanion) socialQ = [0, 0];
    if (offer.macroBlock !== previousBlock) {
      selfQ = [0, 0];
      previousChoice = 0;
    }
    previousCompanion = offer.companionOrdinal;
    previousBlock = offer.macroBlock;
    const observedIndex = offer.observedAction === "cooperate" ? 0 : 1;
    socialQ[observedIndex] += alphaSocial * (rewardValue(offer.observedDisplayPoints) - socialQ[observedIndex]);
    const ds = socialQ[0] - socialQ[1];
    const dp = selfQ[0] - selfQ[1];
    const probabilityCooperate = sigmoid(intercept + betaSocial * ds + betaSelf * dp
      + imitation * actionSign(offer.observedAction) + persistence * previousChoice);
    const action = random() < probabilityCooperate ? "cooperate" : "betray";
    const predictionAction = random() < 0.72 ? offer.observedAction : (offer.observedAction === "cooperate" ? "betray" : "cooperate");
    const predictionRt = Math.round(650 + random() * 2_400);
    const choiceRt = Math.round(720 + random() * 2_500);
    const prediction = await emit("submit_prediction", {
      roundId: offer.roundId,
      action: predictionAction,
      rtMs: predictionRt,
      timedOut: false,
    });
    if (!prediction.ok) throw new Error(`${studyId}: ${prediction.error}`);
    const choice = await emit("submit_choice", { roundId: offer.roundId, action, rtMs: choiceRt }, 20_000);
    if (!choice.ok || !choice.result) throw new Error(`${studyId}: ${choice.error ?? "result missing"}`);
    cumulativePoints = choice.result.cumulativePoints;
    if (action === "cooperate") cooperateCount += 1;
    const ownIndex = action === "cooperate" ? 0 : 1;
    selfQ[ownIndex] += alphaSelf * (choice.result.normalizedPayoff - selfQ[ownIndex]);
    previousChoice = actionSign(action);

    monotonic += Math.round(performance.now() - requestedAt) + predictionRt + choiceRt + 3_000;
    eventBuffer.push(
      makeEvent(sessionId, ++sequence, "round_offer_received", offer.roundId, "round_request", { macroBlock: offer.macroBlock, validRound: offer.validRound }, monotonic),
      makeEvent(sessionId, ++sequence, "observation_continued", offer.roundId, "observation", { durationMs: Math.round(900 + random() * 1_800) }, monotonic + 1),
      makeEvent(sessionId, ++sequence, "prediction_responded", offer.roundId, "prediction", { action: predictionAction, durationMs: predictionRt, attempt: 1 }, monotonic + 2),
      makeEvent(sessionId, ++sequence, "choice_responded", offer.roundId, "choice", { action, durationMs: choiceRt, attempt: 1 }, monotonic + 3),
      makeEvent(sessionId, ++sequence, "feedback_completed", offer.roundId, "feedback", { durationMs: 3_000 }, monotonic + 4),
    );
    if (eventBuffer.length >= 40) await flushEvents();
  }
  await flushEvents();
  socket.close();
  return {
    studyId,
    nTrials: 240,
    trueBetaSocial: betaSocial,
    trueBetaSelf: betaSelf,
    imitation,
    persistence,
    cooperateCount,
    cooperateRate: cooperateCount / 240,
    cumulativePoints,
    eventCount: sequence,
  };
}

const indices = Array.from({ length: count }, (_, offset) => startIndex + offset);
const settled = await Promise.allSettled(indices.map(simulate));
const summaries = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
const failures = settled.filter((result) => result.status === "rejected").map((result) => String(result.reason));
const outputDir = resolve("output/simulation");
mkdirSync(outputDir, { recursive: true });
const outputPath = resolve(outputDir, `${outputName}.json`);
writeFileSync(outputPath, `${JSON.stringify({ baseUrl, roomCode, startIndex, count, summaries, failures }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, completed: summaries.length, failures }, null, 2));
if (failures.length) process.exitCode = 2;
