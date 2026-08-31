import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import express from "express";
import { Server } from "socket.io";
import type { AccessMode, Action, ConsentMode, DoseCode, ParticipantAssignment, ParticipantEventRecord, ParticipantProgress, ParticipantSnapshot, ProtocolVersion, RoomSnapshot, RoundOffer, RoundResult } from "../shared/types.js";
import { buildConditions, guardianLabel, makeId, participantPayoff, stableIndex, totalTrialsForDose, trialsPerCompanion } from "./experiment.js";
import { PERSONAL_ALPHA_LONG, PERSONAL_ALPHA_SHORT, PROTOCOL_VERSION, buildSequenceBank, sequenceTrial, type SequenceTrial } from "./sequence-bank.js";
import { audit, db, nowIso } from "./db.js";

type Prediction = { action: Action | null; rtMs: number | null; timedOut: boolean };

interface PendingRound {
  offer: RoundOffer;
  seed: string;
  companionAction: Action;
  companionRouteAction: Action;
  companionDisplayPoints: number;
  participantRouteAction: Action;
  template: SequenceTrial;
  personalValueBasis: number;
  previousParticipant?: Action;
  previousCompanion?: Action;
  delayProfile: string;
  intendedDelayMs: number;
  actualDelayMs?: number;
  prediction?: Prediction;
  submitting?: boolean;
}

interface RuntimeParticipant {
  participantId: string;
  subjectId: string;
  sessionId: string;
  roomCode: string;
  studyId: string;
  resumeToken: string;
  socketId?: string;
  connected: boolean;
  assignment: ParticipantAssignment;
  assignmentLocked: boolean;
  protocolVersion: ProtocolVersion;
  doseCode: DoseCode | "legacy240";
  sequenceId: string;
  protocolDeviation: boolean;
  consentMode: ConsentMode;
  macroBlock: number;
  companionIndex: number;
  validRound: number;
  cumulativePoints: number;
  previousParticipant?: Action;
  previousCompanion?: Action;
  selfQShort: [number, number];
  selfQLong: [number, number];
  pending?: PendingRound;
  status: ParticipantProgress["status"];
  predictionTimeouts: number;
  choiceTimeouts: number;
  ready: boolean;
  restStartedAt?: string;
  consented: boolean;
  forceAccess: boolean;
}

interface RuntimeRoom {
  roomCode: string;
  adminToken: string;
  status: RoomSnapshot["status"];
  activeMacroBlock: number;
  accessMode: AccessMode;
  wifiName: string;
  publicBaseUrl: string;
  participants: Map<string, RuntimeParticipant>;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
const server = createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
const rooms = new Map<string, RuntimeRoom>();
const CONSENT_VERSION = "2026-08-29-v2";
const port = Number(process.env.PORT ?? 3000);
const deliveryDelayScale = Math.min(10, Math.max(0, Number(process.env.DELIVERY_DELAY_SCALE ?? 1)));
const resultCommitDelayMs = Math.min(5_000, Math.max(0, Number(process.env.RESULT_COMMIT_DELAY_MS ?? 180)));

function getLanAddress() {
  const virtualName = /vethernet|wsl|vmware|virtualbox|hyper-v|loopback|docker|tailscale/i;
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((item) => item.family === "IPv4" && !item.internal)
      .map((item) => {
        const privateAddress = /^10\./.test(item.address) || /^192\.168\./.test(item.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(item.address);
        const physicalName = /wi-?fi|wlan|wireless|ethernet|以太网|无线/i.test(name);
        const score = (privateAddress ? 20 : 0) + (physicalName ? 10 : 0) + (/^192\.168\./.test(item.address) ? 4 : 0) - (virtualName.test(name) ? 50 : 0);
        return { address: item.address, score };
      }),
  );
  return candidates.sort((a, b) => b.score - a.score)[0]?.address ?? "127.0.0.1";
}

function normalizePublicBaseUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("公网入口必须是完整的 http:// 或 https:// 地址");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("公网入口必须是无账号信息的 http:// 或 https:// 地址");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function joinUrlFor(room: RuntimeRoom) {
  const base = room.accessMode === "public" && room.publicBaseUrl
    ? room.publicBaseUrl
    : `http://${getLanAddress()}:${port}`;
  return `${base.replace(/\/+$/, "")}/?room=${encodeURIComponent(room.roomCode)}`;
}

const stateForDb = (p: RuntimeParticipant) => JSON.stringify({
  macroBlock: p.macroBlock,
  companionIndex: p.companionIndex,
  validRound: p.validRound,
  cumulativePoints: p.cumulativePoints,
  previousParticipant: p.previousParticipant,
  previousCompanion: p.previousCompanion,
  selfQShort: p.selfQShort,
  selfQLong: p.selfQLong,
  status: p.status,
  predictionTimeouts: p.predictionTimeouts,
  choiceTimeouts: p.choiceTimeouts,
  ready: p.ready,
  restStartedAt: p.restStartedAt,
  forceAccess: p.forceAccess,
});

function saveParticipant(p: RuntimeParticipant) {
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE participants SET subject_id=?, session_id=?, group_code=?, wave_code=?, form_code=?, notes=?,
      assignment_method=?, assignment_locked=?, protocol_version=?, dose_code=?, sequence_id=?, protocol_deviation=?,
      consent_mode=?, state_json=?, connected=?, updated_at=? WHERE participant_id=?
  `).run(
    p.subjectId,
    p.sessionId,
    p.assignment.groupCode,
    p.assignment.waveCode,
    p.assignment.formCode,
    p.assignment.notes,
    p.assignment.assignmentMethod ?? "",
    p.assignmentLocked ? 1 : 0,
    p.protocolVersion,
    p.doseCode,
    p.sequenceId,
    p.protocolDeviation ? 1 : 0,
    p.consentMode,
    stateForDb(p),
    p.connected ? 1 : 0,
    updatedAt,
    p.participantId,
  );
  db.prepare(`
    INSERT INTO assessment_sessions(
      session_id, subject_id, participant_id, room_code, wave_code, protocol_version, dose_code,
      form_code, sequence_id, status, protocol_deviation, state_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET wave_code=excluded.wave_code, protocol_version=excluded.protocol_version,
      dose_code=excluded.dose_code, form_code=excluded.form_code, sequence_id=excluded.sequence_id,
      status=excluded.status, protocol_deviation=excluded.protocol_deviation,
      state_json=excluded.state_json, updated_at=excluded.updated_at
  `).run(
    p.sessionId, p.subjectId, p.participantId, p.roomCode, p.assignment.waveCode, p.protocolVersion,
    p.doseCode, p.assignment.formCode, p.sequenceId, p.status, p.protocolDeviation ? 1 : 0,
    stateForDb(p), updatedAt, updatedAt,
  );
  db.prepare("UPDATE subjects SET group_code=?, dose_code=?, updated_at=? WHERE subject_id=?")
    .run(p.assignment.groupCode, p.doseCode, updatedAt, p.subjectId);
}

function progressOf(p: RuntimeParticipant): ParticipantProgress {
  const perCompanion = trialsPerCompanion(p.doseCode);
  const totalTrials = totalTrialsForDose(p.doseCode);
  const completedTrials = Math.min(totalTrials, p.macroBlock * perCompanion * 2 + p.companionIndex * perCompanion + p.validRound);
  const doseLocked = [...(rooms.get(p.roomCode)?.participants.values() ?? [])]
    .some((session) => session.subjectId === p.subjectId && session.assignmentLocked);
  return {
    participantId: p.participantId,
    subjectId: p.subjectId,
    sessionId: p.sessionId,
    studyId: p.studyId,
    connected: p.connected,
    assignmentLocked: p.assignmentLocked,
    groupCode: p.assignment.groupCode,
    waveCode: p.assignment.waveCode,
    notes: p.assignment.notes,
    protocolVersion: p.protocolVersion,
    doseCode: p.doseCode,
    sequenceId: p.sequenceId,
    totalTrials,
    completedTrials,
    protocolDeviation: p.protocolDeviation,
    doseLocked,
    macroBlock: p.macroBlock,
    companionIndex: p.companionIndex,
    validRound: p.validRound,
    status: p.status,
    ready: p.ready,
    consented: p.consented,
    restReadyAt: p.restStartedAt
      ? new Date(new Date(p.restStartedAt).getTime() + 60_000).toISOString()
      : undefined,
    predictionTimeouts: p.predictionTimeouts,
    choiceTimeouts: p.choiceTimeouts,
  };
}

function snapshot(room: RuntimeRoom): RoomSnapshot {
  return {
    roomCode: room.roomCode,
    status: room.status,
    activeMacroBlock: room.activeMacroBlock,
    accessMode: room.accessMode,
    wifiName: room.wifiName,
    publicBaseUrl: room.publicBaseUrl,
    lanAddress: getLanAddress(),
    joinUrl: joinUrlFor(room),
    participants: [...room.participants.values()].map(progressOf),
  };
}

function participantSnapshot(room: RuntimeRoom, participant: RuntimeParticipant): ParticipantSnapshot {
  const progress = progressOf(participant);
  const currentCondition = participant.macroBlock >= 0 && participant.macroBlock < 4
    ? buildConditions(participant.studyId, participant.assignment.formCode)[participant.macroBlock * 2]
    : undefined;
  return {
    roomStatus: participant.forceAccess ? "running" : room.status,
    activeMacroBlock: participant.forceAccess ? participant.macroBlock : room.activeMacroBlock,
    self: {
      macroBlock: progress.macroBlock,
      status: progress.status,
      ready: progress.ready,
      consented: progress.consented,
      restReadyAt: progress.restReadyAt,
      cumulativePoints: participant.cumulativePoints,
      regionTheme: currentCondition?.regionTheme,
      locationName: currentCondition?.locationName,
      remainingTrialsInBlock: participant.macroBlock >= 4
        ? 0
        : (1 - participant.companionIndex) * trialsPerCompanion(participant.doseCode)
          + (trialsPerCompanion(participant.doseCode) - participant.validRound),
      consentMode: participant.consentMode,
    },
  };
}

function broadcast(room: RuntimeRoom) {
  for (const participant of room.participants.values()) {
    if (participant.socketId) io.to(participant.socketId).emit("participant_snapshot", participantSnapshot(room, participant));
  }
}

function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function formCodeFor(studyId: string, waveCode: string) {
  const wave = Number(waveCode.replace(/^T/i, "")) || 0;
  return String.fromCharCode(65 + (stableIndex(`${studyId}:parallel-form-base`, 4) + wave) % 4);
}

function bankForParticipant(p: Pick<RuntimeParticipant, "studyId" | "assignment" | "doseCode">) {
  if (p.doseCode === "legacy240") throw new Error("legacy-v1 会话不能调用 ctp-v2 序列库");
  const conditions = buildConditions(p.studyId, p.assignment.formCode);
  const games = [0, 1, 2, 3].map((macroBlock) => conditions[macroBlock * 2].game);
  return buildSequenceBank({
    doseCode: p.doseCode,
    formCode: p.assignment.formCode,
    waveCode: p.assignment.waveCode,
    games,
  });
}

function personalValueBasis(p: RuntimeParticipant) {
  const shortDifference = p.selfQShort[0] - p.selfQShort[1];
  const longDifference = p.selfQLong[0] - p.selfQLong[1];
  return (shortDifference + longDifference) / Math.SQRT2;
}

function createRuntimeSession(args: {
  room: RuntimeRoom;
  studyId: string;
  subjectId: string;
  groupCode: string;
  waveCode: string;
  doseCode: DoseCode;
  consentMode: ConsentMode;
}): RuntimeParticipant {
  const participantId = makeId("session");
  const formCode = formCodeFor(args.studyId, args.waveCode);
  const base: RuntimeParticipant = {
    participantId,
    subjectId: args.subjectId,
    sessionId: participantId,
    roomCode: args.room.roomCode,
    studyId: args.studyId,
    resumeToken: makeId("resume"),
    connected: false,
    assignment: {
      studyId: args.studyId,
      groupCode: args.groupCode,
      waveCode: args.waveCode,
      formCode,
      notes: "",
      assignmentMethod: "automatic",
    },
    assignmentLocked: false,
    protocolVersion: PROTOCOL_VERSION,
    doseCode: args.doseCode,
    sequenceId: "",
    protocolDeviation: false,
    consentMode: args.consentMode,
    macroBlock: 0,
    companionIndex: 0,
    validRound: 0,
    cumulativePoints: 0,
    selfQShort: [0, 0],
    selfQLong: [0, 0],
    status: "lobby",
    predictionTimeouts: 0,
    choiceTimeouts: 0,
    ready: false,
    consented: false,
    forceAccess: false,
  };
  base.sequenceId = bankForParticipant(base).sequenceId;
  return base;
}

function insertRuntimeSession(p: RuntimeParticipant) {
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO participants(
      participant_id, subject_id, session_id, room_code, study_id, resume_token, group_code, wave_code,
      form_code, notes, assignment_method, assignment_locked, protocol_version, dose_code, sequence_id,
      protocol_deviation, consent_mode, state_json, connected, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.participantId, p.subjectId, p.sessionId, p.roomCode, p.studyId, p.resumeToken,
    p.assignment.groupCode, p.assignment.waveCode, p.assignment.formCode, p.assignment.notes,
    p.assignment.assignmentMethod ?? "", p.assignmentLocked ? 1 : 0, p.protocolVersion, p.doseCode,
    p.sequenceId, p.protocolDeviation ? 1 : 0, p.consentMode, stateForDb(p), p.connected ? 1 : 0,
    createdAt, createdAt,
  );
  db.prepare(`
    INSERT INTO assessment_sessions(
      session_id, subject_id, participant_id, room_code, wave_code, protocol_version, dose_code,
      form_code, sequence_id, status, protocol_deviation, state_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.sessionId, p.subjectId, p.participantId, p.roomCode, p.assignment.waveCode, p.protocolVersion,
    p.doseCode, p.assignment.formCode, p.sequenceId, p.status, p.protocolDeviation ? 1 : 0,
    stateForDb(p), createdAt, createdAt,
  );
}

function ensureDefaultRoom() {
  const existing = db.prepare("SELECT * FROM rooms ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const roomCode = existing ? String(existing.room_code) : process.env.ROOM_CODE ?? makeRoomCode();
  const adminToken = existing ? String(existing.admin_token) : process.env.ADMIN_TOKEN ?? makeId("admin");
  if (!existing) {
    const wifiName = String(process.env.WIFI_NAME ?? "").trim().slice(0, 80);
    const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL ?? "");
    const accessMode: AccessMode = process.env.ACCESS_MODE === "public" && publicBaseUrl ? "public" : "lan";
    db.prepare(`
      INSERT INTO rooms(
        room_code, admin_token, status, active_macro_block, access_mode, wifi_name, public_base_url, created_at, updated_at
      ) VALUES (?, ?, 'lobby', -1, ?, ?, ?, ?, ?)
    `).run(roomCode, adminToken, accessMode, wifiName, publicBaseUrl, nowIso(), nowIso());
  }
  const restoredStatus = (existing?.status as RuntimeRoom["status"]) ?? "lobby";
  const safeStatus: RuntimeRoom["status"] = restoredStatus === "running" ? "paused" : restoredStatus;
  if (existing && safeStatus !== restoredStatus) {
    db.prepare("UPDATE rooms SET status='paused', updated_at=? WHERE room_code=?").run(nowIso(), roomCode);
    audit(roomCode, "server", "restart_forced_pause", { previousStatus: restoredStatus });
  }
  const room: RuntimeRoom = {
    roomCode,
    adminToken,
    status: safeStatus,
    activeMacroBlock: Number(existing?.active_macro_block ?? -1),
    accessMode: existing?.access_mode === "public" && existing?.public_base_url
      ? "public"
      : (!existing && process.env.ACCESS_MODE === "public" && process.env.PUBLIC_BASE_URL ? "public" : "lan"),
    wifiName: String(existing?.wifi_name ?? process.env.WIFI_NAME ?? ""),
    publicBaseUrl: String(existing?.public_base_url ?? normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL ?? "")),
    participants: new Map(),
  };
  const rows = db.prepare("SELECT * FROM participants WHERE room_code=?").all(roomCode) as Record<string, unknown>[];
  for (const row of rows) {
    const state = JSON.parse(String(row.state_json));
    const participant: RuntimeParticipant = {
      participantId: String(row.participant_id),
      subjectId: String(row.subject_id ?? `subject_${row.participant_id}`),
      sessionId: String(row.session_id ?? row.participant_id),
      roomCode,
      studyId: String(row.study_id),
      resumeToken: String(row.resume_token),
      connected: false,
      assignment: {
        studyId: String(row.study_id),
        groupCode: String(row.group_code || "实验"),
        waveCode: String(row.wave_code || "T0"),
        formCode: String(row.form_code),
        notes: String(row.notes ?? ""),
        assignmentMethod: String(row.assignment_method),
      },
      assignmentLocked: Boolean(row.assignment_locked),
      protocolVersion: row.protocol_version === "ctp-v2" ? "ctp-v2" : "legacy-v1",
      doseCode: row.dose_code === "short96" || row.dose_code === "long192" ? row.dose_code : "legacy240",
      sequenceId: String(row.sequence_id ?? "legacy-v1"),
      protocolDeviation: Boolean(row.protocol_deviation),
      consentMode: row.consent_mode === "continuation" ? "continuation" : "full",
      macroBlock: state.macroBlock ?? 0,
      companionIndex: state.companionIndex ?? 0,
      validRound: state.validRound ?? 0,
      cumulativePoints: state.cumulativePoints ?? 0,
      previousParticipant: state.previousParticipant,
      previousCompanion: state.previousCompanion,
      selfQShort: Array.isArray(state.selfQShort) && state.selfQShort.length === 2 ? state.selfQShort : [0, 0],
      selfQLong: Array.isArray(state.selfQLong) && state.selfQLong.length === 2 ? state.selfQLong : [0, 0],
      status: state.status ?? "lobby",
      predictionTimeouts: state.predictionTimeouts ?? 0,
      choiceTimeouts: state.choiceTimeouts ?? 0,
      ready: state.ready ?? false,
      restStartedAt: state.restStartedAt,
      consented: Boolean(db.prepare("SELECT 1 FROM consents WHERE participant_id=? AND accepted=1").get(String(row.participant_id))),
      forceAccess: state.forceAccess ?? false,
    };
    room.participants.set(participant.participantId, participant);
  }
  rooms.set(roomCode, room);
  return room;
}

const defaultRoom = ensureDefaultRoom();

function isLoopback(req: express.Request) {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip.endsWith("::ffff:127.0.0.1");
}

app.get("/api/health", (_req, res) => res.json({ ok: true, time: nowIso() }));
app.get("/api/local-bootstrap", (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "仅主试本机可读取控制凭据" });
  const lanAddress = getLanAddress();
  return res.json({
    roomCode: defaultRoom.roomCode,
    adminToken: defaultRoom.adminToken,
    lanAddress,
    joinUrl: joinUrlFor(defaultRoom),
  });
});

function authorizedRoom(req: express.Request) {
  const room = rooms.get(String(req.query.roomCode ?? req.body?.roomCode ?? ""));
  const token = String(req.query.adminToken ?? req.body?.adminToken ?? "");
  return room && token === room.adminToken ? room : undefined;
}

app.get("/api/admin/room", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  return res.json(snapshot(room));
});

app.post("/api/admin/access", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const accessMode: AccessMode = req.body.accessMode === "public" ? "public" : "lan";
  const wifiName = String(req.body.wifiName ?? "").trim().slice(0, 80);
  let publicBaseUrl = "";
  try {
    publicBaseUrl = normalizePublicBaseUrl(req.body.publicBaseUrl);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "公网入口无效" });
  }
  if (accessMode === "public" && !publicBaseUrl) {
    return res.status(400).json({ error: "切换公网模式前，请填写可从互联网访问的入口地址" });
  }
  room.accessMode = accessMode;
  room.wifiName = wifiName;
  room.publicBaseUrl = publicBaseUrl;
  db.prepare(`
    UPDATE rooms SET access_mode=?, wifi_name=?, public_base_url=?, updated_at=? WHERE room_code=?
  `).run(accessMode, wifiName, publicBaseUrl, nowIso(), room.roomCode);
  audit(room.roomCode, "admin", "access_settings_updated", { accessMode, wifiName, publicBaseUrl });
  return res.json({ ok: true, room: snapshot(room) });
});

app.post("/api/admin/assignment", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const p = room.participants.get(String(req.body.participantId));
  if (!p) return res.status(404).json({ error: "被试不存在" });
  const groupCode = String(req.body.groupCode ?? "实验").trim();
  const waveCode = String(req.body.waveCode ?? "T0").trim();
  const doseCode = req.body.doseCode === "long192" ? "long192" : "short96";
  const notes = String(req.body.notes ?? "").trim().slice(0, 200);
  if (p.assignmentLocked) {
    p.assignment.notes = notes;
    saveParticipant(p);
    audit(room.roomCode, "admin", "notes_updated", { notes }, p.participantId);
    broadcast(room);
    return res.json({ ok: true });
  }
  if (!new Set(["实验", "对照"]).has(groupCode)) return res.status(400).json({ error: "组别必须为实验或对照" });
  if (!/^T[0-8]$/.test(waveCode)) return res.status(400).json({ error: "波次必须为 T0–T8" });
  const siblingSessions = [...room.participants.values()].filter((session) => session.subjectId === p.subjectId);
  if (siblingSessions.some((session) => session.participantId !== p.participantId && session.assignment.waveCode === waveCode)) {
    return res.status(409).json({ error: "该研究编号已经存在这一波次" });
  }
  const doseLocked = siblingSessions.some((session) => session.assignmentLocked);
  if (doseLocked && doseCode !== p.doseCode) return res.status(409).json({ error: "测量长度已在首次会话开始时锁定" });
  if (doseLocked && groupCode !== p.assignment.groupCode) return res.status(409).json({ error: "组别已在首次会话开始时锁定" });
  p.assignment = {
    studyId: p.studyId,
    groupCode,
    waveCode,
    formCode: formCodeFor(p.studyId, waveCode),
    notes,
    assignmentMethod: String(req.body.assignmentMethod ?? "").trim(),
  };
  p.doseCode = doseCode;
  p.sequenceId = bankForParticipant(p).sequenceId;
  for (const sibling of siblingSessions) {
    if (!sibling.assignmentLocked) sibling.assignment.groupCode = groupCode;
  }
  saveParticipant(p);
  audit(room.roomCode, "admin", "assignment_updated", p.assignment, p.participantId);
  broadcast(room);
  return res.json({ ok: true });
});

app.post("/api/admin/open-next-wave", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const current = room.participants.get(String(req.body.participantId));
  if (!current) return res.status(404).json({ error: "被试不存在" });
  const sessions = [...room.participants.values()]
    .filter((session) => session.subjectId === current.subjectId)
    .sort((a, b) => Number(a.assignment.waveCode.slice(1)) - Number(b.assignment.waveCode.slice(1)));
  const latest = sessions.at(-1);
  if (!latest || latest.participantId !== current.participantId) return res.status(409).json({ error: "只能从最近一次会话开启下一波次" });
  if (latest.status !== "complete") return res.status(409).json({ error: "最近一次会话尚未完成" });
  const waveNumber = Number(latest.assignment.waveCode.slice(1));
  if (!Number.isInteger(waveNumber) || waveNumber >= 8) return res.status(409).json({ error: "已经到达 T8" });
  if (latest.doseCode === "legacy240") return res.status(409).json({ error: "legacy-v1 会话不能直接续接 v2 波次" });
  const nextWave = `T${waveNumber + 1}`;
  const priorFullConsent = db.prepare(`
    SELECT 1 FROM consents WHERE subject_id=? AND consent_version=? AND signed_as='handwritten' AND accepted=1 LIMIT 1
  `).get(latest.subjectId, CONSENT_VERSION);
  const next = createRuntimeSession({
    room,
    studyId: latest.studyId,
    subjectId: latest.subjectId,
    groupCode: latest.assignment.groupCode,
    waveCode: nextWave,
    doseCode: latest.doseCode,
    consentMode: priorFullConsent ? "continuation" : "full",
  });
  insertRuntimeSession(next);
  room.participants.set(next.participantId, next);
  room.status = "lobby";
  room.activeMacroBlock = -1;
  db.prepare("UPDATE rooms SET status='lobby', active_macro_block=-1, updated_at=? WHERE room_code=?")
    .run(nowIso(), room.roomCode);
  audit(room.roomCode, "admin", "next_wave_opened", {
    subjectId: next.subjectId,
    fromWave: latest.assignment.waveCode,
    waveCode: nextWave,
    doseCode: next.doseCode,
    formCode: next.assignment.formCode,
    sequenceId: next.sequenceId,
  }, next.participantId);
  broadcast(room);
  return res.json({ ok: true, participantId: next.participantId, waveCode: nextWave });
});

app.post("/api/admin/participant-control", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const participant = room.participants.get(String(req.body.participantId));
  if (!participant) return res.status(404).json({ error: "被试不存在" });
  const action = String(req.body.action ?? "");

  if (action === "jump") {
    const macroBlock = Number(req.body.macroBlock);
    const companionIndex = Number(req.body.companionIndex);
    const validRound = Number(req.body.validRound);
    if (!Number.isInteger(macroBlock) || macroBlock < 0 || macroBlock > 3) return res.status(400).json({ error: "区组必须为 1–4" });
    if (!Number.isInteger(companionIndex) || companionIndex < 0 || companionIndex > 1) return res.status(400).json({ error: "同行者序号无效" });
    const perCompanion = trialsPerCompanion(participant.doseCode);
    if (!Number.isInteger(validRound) || validRound < 0 || validRound >= perCompanion) return res.status(400).json({ error: `下一轮必须为 1–${perCompanion}` });
    participant.macroBlock = macroBlock;
    participant.companionIndex = companionIndex;
    participant.validRound = validRound;
    participant.previousParticipant = undefined;
    participant.previousCompanion = undefined;
    participant.selfQShort = [0, 0];
    participant.selfQLong = [0, 0];
    participant.protocolDeviation = true;
    participant.pending = undefined;
    participant.status = "lobby";
    participant.ready = false;
    participant.restStartedAt = undefined;
    participant.forceAccess = false;
    saveParticipant(participant);
    audit(room.roomCode, "admin", "participant_forced_jump", { macroBlock, companionIndex, nextRound: validRound + 1, protocolDeviation: true }, participant.participantId);
    broadcast(room);
    return res.json({ ok: true });
  }

  if (action === "force_start") {
    if (!participant.consented) return res.status(409).json({ error: "该参与者尚未完成知情同意，不能强制开始" });
    participant.assignmentLocked = true;
    participant.status = "active";
    participant.ready = false;
    participant.restStartedAt = undefined;
    participant.forceAccess = true;
    saveParticipant(participant);
    audit(room.roomCode, "admin", "participant_forced_start", { macroBlock: participant.macroBlock }, participant.participantId);
    broadcast(room);
    return res.json({ ok: true });
  }

  if (action === "force_end") {
    const socketId = participant.socketId;
    participant.pending = undefined;
    participant.macroBlock = 4;
    participant.companionIndex = 0;
    participant.validRound = 0;
    participant.status = "complete";
    participant.ready = false;
    participant.restStartedAt = undefined;
    participant.forceAccess = false;
    participant.protocolDeviation = true;
    saveParticipant(participant);
    audit(room.roomCode, "admin", "participant_forced_end", { protocolDeviation: true }, participant.participantId);
    if (room.participants.size > 0 && [...room.participants.values()].every((item) => item.status === "complete")) {
      room.status = "complete";
      db.prepare("UPDATE rooms SET status='complete', updated_at=? WHERE room_code=?").run(nowIso(), room.roomCode);
    }
    if (socketId) io.to(socketId).emit("session_ended", { message: "本次记录已由主试提前结束。" });
    broadcast(room);
    return res.json({ ok: true });
  }

  if (action === "force_delete") {
    if (String(req.body.confirmStudyId ?? "") !== participant.studyId) return res.status(400).json({ error: "删除确认编号不匹配" });
    const subjectSessions = [...room.participants.values()].filter((session) => session.subjectId === participant.subjectId);
    const participantIds = subjectSessions.map((session) => session.participantId);
    const placeholders = participantIds.map(() => "?").join(",");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`DELETE FROM participant_events WHERE participant_id IN (${placeholders})`).run(...participantIds);
      db.prepare(`DELETE FROM trials WHERE participant_id IN (${placeholders})`).run(...participantIds);
      db.prepare(`DELETE FROM consents WHERE participant_id IN (${placeholders})`).run(...participantIds);
      db.prepare(`DELETE FROM audit_events WHERE participant_id IN (${placeholders})`).run(...participantIds);
      db.prepare("DELETE FROM assessment_sessions WHERE subject_id=?").run(participant.subjectId);
      db.prepare("DELETE FROM participants WHERE subject_id=?").run(participant.subjectId);
      db.prepare("DELETE FROM subjects WHERE subject_id=?").run(participant.subjectId);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      return res.status(500).json({ error: `删除失败：${String(error)}` });
    }
    for (const session of subjectSessions) {
      room.participants.delete(session.participantId);
      if (session.socketId) {
        io.to(session.socketId).emit("session_ended", { message: "全部研究记录已由主试删除。" });
        io.in(session.socketId).disconnectSockets(true);
      }
    }
    audit(room.roomCode, "admin", "subject_forced_delete", { studyId: participant.studyId, deletedSessions: participantIds.length });
    broadcast(room);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: "未知的单人控制操作" });
});

app.post("/api/admin/start-block", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const macroBlock = Number(req.body.macroBlock);
  if (!Number.isInteger(macroBlock) || macroBlock < 0 || macroBlock > 3) return res.status(400).json({ error: "地点编号无效" });
  const expectedBlock = room.activeMacroBlock + 1;
  if (macroBlock !== expectedBlock) return res.status(409).json({ error: `只能开启第 ${expectedBlock + 1} 站` });
  const incomplete = [...room.participants.values()].filter((p) => p.status !== "complete");
  if (incomplete.length === 0) return res.status(409).json({ error: "没有待完成的参与者" });
  if (macroBlock === 0) {
    if (incomplete.length < 2) return res.status(409).json({ error: "正式实验至少需要 2 名参与者" });
    const notConsented = incomplete.filter((p) => !p.consented);
    if (notConsented.length) return res.status(409).json({ error: `仍有 ${notConsented.length} 人未完成知情同意` });
    const missing = incomplete.filter((p) => !p.assignment.groupCode || !p.assignment.waveCode);
    if (missing.length) return res.status(409).json({ error: `仍有 ${missing.length} 人未填写波次或组别` });
  } else {
    const notReady = incomplete.filter((p) => p.status !== "rest" || !p.ready || p.macroBlock !== macroBlock);
    if (notReady.length) return res.status(409).json({ error: `仍有 ${notReady.length} 人未完成休息或未准备` });
  }
  room.activeMacroBlock = macroBlock;
  room.status = "running";
  db.prepare("UPDATE rooms SET status='running', active_macro_block=?, updated_at=? WHERE room_code=?")
    .run(macroBlock, nowIso(), room.roomCode);
  for (const p of room.participants.values()) {
    if (p.macroBlock === macroBlock && p.status !== "complete") {
      p.assignmentLocked = true;
      p.status = "active";
      p.ready = false;
      p.restStartedAt = undefined;
      p.forceAccess = false;
      saveParticipant(p);
    }
  }
  audit(room.roomCode, "admin", "block_started", { macroBlock });
  broadcast(room);
  return res.json({ ok: true });
});

app.post("/api/admin/pause", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const paused = Boolean(req.body.paused);
  room.status = paused ? "paused" : "running";
  db.prepare("UPDATE rooms SET status=?, updated_at=? WHERE room_code=?").run(room.status, nowIso(), room.roomCode);
  audit(room.roomCode, "admin", paused ? "room_paused" : "room_resumed", {});
  broadcast(room);
  return res.json({ ok: true });
});

function sendCsv(res: express.Response, rows: Record<string, unknown>[], emptyColumns: string[], filename: string) {
  const columns = rows.length ? Object.keys(rows[0]) : emptyColumns;
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = `\uFEFF${columns.map(quote).join(",")}\n${rows.map((row) => columns.map((column) => quote(row[column])).join(",")).join("\n")}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  return res.send(csv);
}

app.get("/api/admin/export.csv", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const rows = db.prepare("SELECT * FROM trials WHERE room_code=? ORDER BY study_id, created_at").all(room.roomCode) as Record<string, unknown>[];
  return sendCsv(res, rows, ["round_id"], `expedition-trials-${room.roomCode}.csv`);
});

app.get("/api/admin/export-events.csv", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const rows = db.prepare(`
    SELECT * FROM participant_events WHERE room_code=? ORDER BY study_id, session_id, sequence, server_received_at
  `).all(room.roomCode) as Record<string, unknown>[];
  return sendCsv(
    res,
    rows,
    ["client_event_id", "participant_id", "room_code", "study_id", "session_id", "sequence", "round_id", "event_type", "phase", "client_time", "server_received_at"],
    `expedition-events-${room.roomCode}.csv`,
  );
});

app.get("/api/admin/export-sessions.csv", (req, res) => {
  const room = authorizedRoom(req);
  if (!room) return res.status(401).json({ error: "主试凭据无效" });
  const rows = db.prepare(`
    SELECT p.subject_id, p.session_id, p.study_id, p.group_code, p.wave_code, p.form_code,
      p.protocol_version, p.dose_code, p.sequence_id, p.assignment_locked, p.protocol_deviation,
      CASE p.dose_code WHEN 'short96' THEN 96 WHEN 'long192' THEN 192 ELSE 240 END AS planned_trials,
      (SELECT COUNT(*) FROM trials t WHERE t.session_id=p.session_id) AS observed_trials,
      json_extract(p.state_json, '$.status') AS status,
      json_extract(p.state_json, '$.predictionTimeouts') AS prediction_timeouts,
      json_extract(p.state_json, '$.choiceTimeouts') AS choice_timeouts,
      p.created_at, p.updated_at
    FROM participants p WHERE p.room_code=? ORDER BY p.study_id, p.wave_code
  `).all(room.roomCode) as Record<string, unknown>[];
  return sendCsv(res, rows, ["subject_id", "session_id", "study_id", "wave_code", "dose_code", "status"], `expedition-sessions-${room.roomCode}.csv`);
});

io.on("connection", (socket) => {
  socket.on("participant_join", (payload, ack) => {
    const room = rooms.get(String(payload.roomCode ?? "").trim());
    const studyId = String(payload.studyId ?? "").trim();
    if (!room) return ack({ ok: false, error: "房间码不存在" });
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(studyId)) return ack({ ok: false, error: "研究编号应为 2–32 位字母、数字、_ 或 -" });

    const candidates = [...room.participants.values()]
      .filter((item) => item.studyId === studyId)
      .sort((a, b) => Number(b.assignment.waveCode.slice(1)) - Number(a.assignment.waveCode.slice(1)));
    let p = candidates.find((item) => item.status !== "complete");
    if (!p && candidates.length) return ack({ ok: false, error: "下一波次尚未由主试开放" });
    if (p) {
      const acceptedToken = candidates.some((session) => session.resumeToken === payload.resumeToken);
      if (!acceptedToken) return ack({ ok: false, error: "该研究编号已在其他设备使用，请联系主试恢复" });
    }
    if (!p) {
      const activeCount = [...room.participants.values()].filter((session) => session.status !== "complete").length;
      if (activeCount >= 100) return ack({ ok: false, error: "本房间已达到 100 人上限" });
      const shortCount = Number((db.prepare("SELECT COUNT(*) AS count FROM subjects WHERE room_code=? AND dose_code='short96'").get(room.roomCode) as { count: number }).count);
      const longCount = Number((db.prepare("SELECT COUNT(*) AS count FROM subjects WHERE room_code=? AND dose_code='long192'").get(room.roomCode) as { count: number }).count);
      const doseCode: DoseCode = shortCount === longCount
        ? (stableIndex(`${room.roomCode}:${studyId}:dose`, 2) === 0 ? "short96" : "long192")
        : shortCount < longCount ? "short96" : "long192";
      const subjectId = makeId("subject");
      const createdAt = nowIso();
      db.prepare(`
        INSERT INTO subjects(subject_id, room_code, study_id, group_code, dose_code, created_at, updated_at)
        VALUES (?, ?, ?, '实验', ?, ?, ?)
      `).run(subjectId, room.roomCode, studyId, doseCode, createdAt, createdAt);
      p = createRuntimeSession({ room, studyId, subjectId, groupCode: "实验", waveCode: "T0", doseCode, consentMode: "full" });
      p.socketId = socket.id;
      p.connected = true;
      insertRuntimeSession(p);
      room.participants.set(p.participantId, p);
      audit(room.roomCode, "participant", "participant_joined", {
        studyId,
        subjectId,
        sessionId: p.sessionId,
        waveCode: p.assignment.waveCode,
        doseCode: p.doseCode,
        sequenceId: p.sequenceId,
      }, p.participantId);
    } else {
      p.socketId = socket.id;
      p.connected = true;
      saveParticipant(p);
      audit(room.roomCode, "participant", "participant_rejoined", {}, p.participantId);
    }
    socket.data.participantId = p.participantId;
    socket.data.roomCode = room.roomCode;
    ack({ ok: true, participantId: p.participantId, resumeToken: p.resumeToken });
    socket.emit("participant_snapshot", participantSnapshot(room, p));
    broadcast(room);
  });

  socket.on("record_participant_events", (payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const participant = room?.participants.get(String(socket.data.participantId));
    if (!room || !participant) return ack({ ok: false, error: "会话已失效" });
    const events = Array.isArray(payload?.events) ? payload.events.slice(0, 50) as ParticipantEventRecord[] : [];
    if (!events.length) return ack({ ok: true, accepted: 0 });
    const insert = db.prepare(`
      INSERT OR IGNORE INTO participant_events(
        client_event_id, participant_id, room_code, study_id, session_id, assessment_session_id, sequence,
        round_id, event_type, phase, client_time, client_monotonic_ms, visibility_state,
        fullscreen, online, viewport_width, viewport_height, screen_width, screen_height,
        device_pixel_ratio, payload_json, server_received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let accepted = 0;
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      for (const event of events) {
        const clientEventId = String(event?.clientEventId ?? "").slice(0, 96);
        const sessionId = String(event?.sessionId ?? "").slice(0, 96);
        const eventType = String(event?.eventType ?? "").slice(0, 64);
        if (!/^[A-Za-z0-9:_-]{8,96}$/.test(clientEventId)
          || !/^[A-Za-z0-9:_-]{8,96}$/.test(sessionId)
          || !/^[a-z0-9:_-]{2,64}$/.test(eventType)) continue;
        const payloadJson = JSON.stringify(event.payload ?? {});
        if (payloadJson.length > 20_000) continue;
        const result = insert.run(
          clientEventId,
          participant.participantId,
          room.roomCode,
          participant.studyId,
          sessionId,
          participant.sessionId,
          Number.isInteger(event.sequence) ? event.sequence : 0,
          event.roundId ? String(event.roundId).slice(0, 96) : null,
          eventType,
          event.phase ? String(event.phase).slice(0, 48) : null,
          Number.isFinite(Date.parse(String(event.clientTime))) ? String(event.clientTime) : nowIso(),
          Number.isFinite(event.clientMonotonicMs) ? event.clientMonotonicMs : 0,
          String(event.visibilityState ?? "unknown").slice(0, 24),
          event.fullscreen ? 1 : 0,
          event.online ? 1 : 0,
          Number.isFinite(event.viewportWidth) ? Math.max(0, Math.round(event.viewportWidth)) : 0,
          Number.isFinite(event.viewportHeight) ? Math.max(0, Math.round(event.viewportHeight)) : 0,
          Number.isFinite(event.screenWidth) ? Math.max(0, Math.round(event.screenWidth)) : 0,
          Number.isFinite(event.screenHeight) ? Math.max(0, Math.round(event.screenHeight)) : 0,
          Number.isFinite(event.devicePixelRatio) ? Math.max(0, event.devicePixelRatio) : 0,
          payloadJson,
          nowIso(),
        );
        accepted += Number(result.changes);
      }
      db.exec("COMMIT");
      transactionOpen = false;
      return ack({ ok: true, accepted });
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      }
      audit(room.roomCode, "server", "participant_event_batch_failed", { message: String(error) }, participant.participantId);
      return ack({ ok: false, error: "过程记录暂存失败" });
    }
  });

  socket.on("submit_consent", (payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const participant = room?.participants.get(String(socket.data.participantId));
    if (!room || !participant) return ack({ ok: false, error: "会话已失效" });
    if (participant.consented) return ack({ ok: true });
    const signatureData = String(payload.signatureData ?? "");
    if (payload.accepted !== true) return ack({ ok: false, error: "请确认自愿参加" });
    if (participant.consentMode === "full") {
      if (!signatureData.startsWith("data:image/png;base64,iVBORw0KGgo")
        || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData)
        || signatureData.length < 200) {
        return ack({ ok: false, error: "请在签名板上完成手写签名" });
      }
      if (signatureData.length > 700_000) return ack({ ok: false, error: "签名数据过大，请清除后重新签写" });
    }
    db.prepare(`
      INSERT INTO consents(
        participant_id, room_code, consent_version, signed_as, signature_data, accepted, created_at,
        subject_id, assessment_session_id, consent_mode
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(participant_id) DO UPDATE SET consent_version=excluded.consent_version,
        signed_as=excluded.signed_as, signature_data=excluded.signature_data, accepted=1,
        created_at=excluded.created_at, subject_id=excluded.subject_id,
        assessment_session_id=excluded.assessment_session_id, consent_mode=excluded.consent_mode
    `).run(
      participant.participantId, room.roomCode, CONSENT_VERSION,
      participant.consentMode === "full" ? "handwritten" : "continued",
      participant.consentMode === "full" ? signatureData : null,
      nowIso(), participant.subjectId, participant.sessionId, participant.consentMode,
    );
    participant.consented = true;
    audit(room.roomCode, "participant", "consent_accepted", {
      consentVersion: CONSENT_VERSION,
      consentMode: participant.consentMode,
      sessionId: participant.sessionId,
    }, participant.participantId);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on("request_round", (_payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const p = room?.participants.get(String(socket.data.participantId));
    if (!room || !p) return ack({ ok: false, error: "会话已失效" });
    if (!p.consented) return ack({ ok: false, error: "请先完成知情同意" });
    if (room.status === "paused" && !p.forceAccess) return ack({ ok: false, wait: true, error: "实验已暂停" });
    if (p.status !== "active" || (!p.forceAccess && p.macroBlock !== room.activeMacroBlock)) return ack({ ok: false, wait: true, error: "等待主试开始当前地点" });
    const deliver = (pending: PendingRound) => {
      const delayStartedAt = Date.now();
      setTimeout(() => {
        pending.actualDelayMs = Date.now() - delayStartedAt;
        ack({ ok: true, offer: pending.offer });
      }, Math.round(pending.intendedDelayMs * deliveryDelayScale));
    };
    if (p.pending) return deliver(p.pending);

    if (p.protocolVersion !== PROTOCOL_VERSION || p.doseCode === "legacy240") {
      return ack({ ok: false, error: "该旧版会话已封存，不能继续生成正式试次" });
    }
    const conditions = buildConditions(p.studyId, p.assignment.formCode);
    const condition = conditions[p.macroBlock * 2 + p.companionIndex];
    const bank = bankForParticipant(p);
    const template = sequenceTrial(bank, condition.companionOrdinal, p.validRound);
    if (p.sequenceId !== bank.sequenceId) {
      audit(room.roomCode, "server", "sequence_id_repaired", { stored: p.sequenceId, expected: bank.sequenceId }, p.participantId);
      p.sequenceId = bank.sequenceId;
      saveParticipant(p);
    }
    const seed = `${p.sessionId}:${template.trialTemplateId}`;
    const companionPayoff = participantPayoff(condition.game, template.observedAction, template.observedRouteAction);
    const intendedDelayMs = template.intendedDelayMs;
    const roundId = `round_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
    const personalBasis = personalValueBasis(p);
    const offer: RoundOffer = {
      roundId,
      sessionId: p.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      doseCode: p.doseCode,
      sequenceId: bank.sequenceId,
      trialTemplateId: template.trialTemplateId,
      anchorId: template.anchorId,
      evidenceClass: template.evidenceClass,
      socialRegime: template.socialRegime,
      socialValueShort: template.socialValueShort,
      socialValueLong: template.socialValueLong,
      socialValueMean: template.socialValueMean,
      socialValueContrast: template.socialValueContrast,
      personalValueBasis: personalBasis,
      previousChoice: p.previousParticipant ? (p.previousParticipant === "cooperate" ? 1 : -1) : 0,
      macroBlock: p.macroBlock,
      regionTheme: condition.regionTheme,
      locationName: condition.locationName,
      companionLabel: condition.companionLabel,
      companionOrdinal: condition.companionOrdinal,
      observedAction: template.observedAction,
      observedRouteAction: template.observedRouteAction,
      observedDisplayPoints: companionPayoff.displayed,
      guardianLabel: guardianLabel(condition.locationName),
      validRound: p.validRound + 1,
      totalRoundsWithCompanion: trialsPerCompanion(p.doseCode),
      cumulativePoints: p.cumulativePoints,
      predictionDeadlineMs: 6000,
      choiceDeadlineMs: 6000,
    };
    p.pending = {
      offer,
      seed,
      companionAction: template.observedAction,
      companionRouteAction: template.observedRouteAction,
      companionDisplayPoints: companionPayoff.displayed,
      participantRouteAction: template.participantRouteAction,
      template,
      personalValueBasis: personalBasis,
      previousParticipant: p.previousParticipant,
      previousCompanion: p.previousCompanion,
      delayProfile: condition.delayProfile,
      intendedDelayMs,
    };
    deliver(p.pending);
  });

  socket.on("submit_prediction", (payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const p = room?.participants.get(String(socket.data.participantId));
    if (!p?.pending || p.pending.offer.roundId !== payload.roundId) return ack({ ok: false, error: "轮次不匹配" });
    const action = payload.action === "cooperate" || payload.action === "betray" ? payload.action : null;
    if (p.pending.prediction) return ack({ ok: true });
    p.pending.prediction = { action, rtMs: Number.isFinite(payload.rtMs) ? Number(payload.rtMs) : null, timedOut: Boolean(payload.timedOut) };
    if (payload.timedOut) p.predictionTimeouts += 1;
    ack({ ok: true });
    broadcast(room!);
  });

  socket.on("choice_timeout", (payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const p = room?.participants.get(String(socket.data.participantId));
    if (!p?.pending || p.pending.offer.roundId !== payload.roundId) return ack({ ok: false, error: "轮次不匹配" });
    p.choiceTimeouts += 1;
    audit(p.roomCode, "participant", "choice_timeout", { roundId: payload.roundId, count: p.choiceTimeouts }, p.participantId);
    saveParticipant(p);
    ack({ ok: true });
    broadcast(room!);
  });

  socket.on("submit_choice", (payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const p = room?.participants.get(String(socket.data.participantId));
    if (!room || !p) return ack({ ok: false, error: "会话已失效" });
    if (!p.pending || p.pending.offer.roundId !== payload.roundId) {
      const committed = db.prepare(`
        SELECT round_id, participant_action, participant_route_action, display_points, normalized_payoff,
          cumulative_points, intended_delay_ms, actual_delay_ms
        FROM trials WHERE round_id=? AND participant_id=?
      `).get(String(payload.roundId), p.participantId) as Record<string, unknown> | undefined;
      if (committed) return ack({
        ok: true,
        result: {
          roundId: String(committed.round_id),
          participantAction: committed.participant_action as Action,
          routeAction: committed.participant_route_action as Action,
          displayPoints: Number(committed.display_points),
          normalizedPayoff: Number(committed.normalized_payoff),
          cumulativePoints: Number(committed.cumulative_points),
          intendedDelayMs: Number(committed.intended_delay_ms),
          actualDelayMs: Number(committed.actual_delay_ms),
        } satisfies RoundResult,
      });
      return ack({ ok: false, error: "轮次不匹配" });
    }
    if (payload.action !== "cooperate" && payload.action !== "betray") return ack({ ok: false, error: "选择无效" });

    const pending = p.pending;
    if (pending.submitting) return ack({ ok: false, error: "本轮正在封存，请勿重复提交" });
    pending.submitting = true;
    const participantAction: Action = payload.action;
    const condition = buildConditions(p.studyId, p.assignment.formCode)[pending.offer.companionOrdinal];
    const payoff = participantPayoff(condition.game, participantAction, pending.participantRouteAction);
    const intendedDelayMs = pending.intendedDelayMs;
    const actualDelayMs = pending.actualDelayMs ?? intendedDelayMs;
    const nextCumulative = p.cumulativePoints + payoff.displayed;

    setTimeout(() => {
      const result: RoundResult = {
        roundId: pending.offer.roundId,
        participantAction,
        routeAction: pending.participantRouteAction,
        displayPoints: payoff.displayed,
        normalizedPayoff: payoff.normalized,
        cumulativePoints: nextCumulative,
        intendedDelayMs,
        actualDelayMs,
      };
      const prediction = pending.prediction ?? { action: null, rtMs: null, timedOut: true };
      const before = {
        previousParticipant: p.previousParticipant,
        previousCompanion: p.previousCompanion,
        selfQShort: [...p.selfQShort] as [number, number],
        selfQLong: [...p.selfQLong] as [number, number],
        cumulativePoints: p.cumulativePoints,
        validRound: p.validRound,
        companionIndex: p.companionIndex,
        macroBlock: p.macroBlock,
        status: p.status,
        ready: p.ready,
        restStartedAt: p.restStartedAt,
        pending: p.pending,
        roomStatus: room.status,
      };
      let transactionOpen = false;

      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        db.prepare(`
          INSERT INTO trials(
            round_id, participant_id, subject_id, session_id, room_code, study_id, group_code, wave_code, form_code, notes,
            protocol_version, dose_code, sequence_id, trial_template_id, anchor_id, evidence_class, social_regime,
            social_value_short, social_value_long, social_value_mean, social_value_contrast, personal_value_basis,
            previous_choice, protocol_deviation, macro_block, region_theme, game_key, location_name, companion_label,
            guardian_label, companion_ordinal, bot_level, bot_beta, delay_profile, valid_round,
            previous_participant_action, previous_companion_action,
            companion_action, companion_route_action, companion_display_points, switch_probability, delta_payoff,
            prediction_action, prediction_rt_ms, prediction_timed_out, participant_action, participant_route_action,
            choice_rt_ms, normalized_payoff, display_points,
            cumulative_points, intended_delay_ms, actual_delay_ms, random_seed, created_at
          ) VALUES (${Array.from({ length: 55 }, () => "?").join(", ")})
        `).run(
          pending.offer.roundId, p.participantId, p.subjectId, p.sessionId, p.roomCode, p.studyId,
          p.assignment.groupCode, p.assignment.waveCode, p.assignment.formCode, p.assignment.notes,
          p.protocolVersion, p.doseCode, p.sequenceId, pending.template.trialTemplateId, pending.template.anchorId ?? null,
          pending.template.evidenceClass, pending.template.socialRegime, pending.template.socialValueShort,
          pending.template.socialValueLong, pending.template.socialValueMean, pending.template.socialValueContrast,
          pending.personalValueBasis, pending.offer.previousChoice, p.protocolDeviation ? 1 : 0,
          p.macroBlock, condition.regionTheme, condition.game, condition.locationName,
          condition.companionLabel, pending.offer.guardianLabel, condition.companionOrdinal,
          null, null, null, p.validRound + 1, pending.previousParticipant ?? null, pending.previousCompanion ?? null,
          pending.companionAction, pending.companionRouteAction, pending.companionDisplayPoints,
          null, null, prediction.action, prediction.rtMs,
          prediction.timedOut ? 1 : 0, participantAction, pending.participantRouteAction, Number(payload.rtMs), payoff.normalized,
          payoff.displayed, nextCumulative, intendedDelayMs, actualDelayMs, pending.seed, nowIso(),
        );

        const ownIndex = participantAction === "cooperate" ? 0 : 1;
        p.selfQShort[ownIndex] += PERSONAL_ALPHA_SHORT * (payoff.normalized - p.selfQShort[ownIndex]);
        p.selfQLong[ownIndex] += PERSONAL_ALPHA_LONG * (payoff.normalized - p.selfQLong[ownIndex]);
        p.previousParticipant = participantAction;
        p.previousCompanion = pending.companionAction;
        p.cumulativePoints = nextCumulative;
        p.validRound += 1;
        p.pending = undefined;

        if (p.validRound >= trialsPerCompanion(p.doseCode)) {
          if (p.companionIndex === 0) {
            p.companionIndex = 1;
            p.validRound = 0;
            p.previousCompanion = undefined;
          } else {
            p.macroBlock += 1;
            p.companionIndex = 0;
            p.validRound = 0;
            p.previousParticipant = undefined;
            p.previousCompanion = undefined;
            p.selfQShort = [0, 0];
            p.selfQLong = [0, 0];
            p.status = p.macroBlock >= 4 ? "complete" : "rest";
            p.ready = false;
            p.restStartedAt = p.status === "rest" ? nowIso() : undefined;
            p.forceAccess = false;
          }
        }
        saveParticipant(p);

        if ([...room.participants.values()].every((participant) => participant.status === "complete")) {
          room.status = "complete";
          db.prepare("UPDATE rooms SET status='complete', updated_at=? WHERE room_code=?").run(nowIso(), room.roomCode);
        }
        db.exec("COMMIT");
        transactionOpen = false;
        ack({ ok: true, result });
        broadcast(room);
      } catch (error) {
        if (transactionOpen) {
          try { db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
        }
        p.previousParticipant = before.previousParticipant;
        p.previousCompanion = before.previousCompanion;
        p.selfQShort = before.selfQShort;
        p.selfQLong = before.selfQLong;
        p.cumulativePoints = before.cumulativePoints;
        p.validRound = before.validRound;
        p.companionIndex = before.companionIndex;
        p.macroBlock = before.macroBlock;
        p.status = before.status;
        p.ready = before.ready;
        p.restStartedAt = before.restStartedAt;
        p.pending = before.pending;
        if (p.pending) p.pending.submitting = false;
        room.status = before.roomStatus;
        audit(room.roomCode, "server", "trial_commit_failed", { roundId: pending.offer.roundId, message: String(error) }, p.participantId);
        ack({ ok: false, error: "本轮封存失败，请重新提交" });
        broadcast(room);
      }
    }, resultCommitDelayMs);
  });

  socket.on("participant_ready", (_payload, ack) => {
    const room = rooms.get(String(socket.data.roomCode));
    const p = room?.participants.get(String(socket.data.participantId));
    if (!room || !p) return ack({ ok: false, error: "会话已失效" });
    if (p.status !== "rest" || !p.restStartedAt) return ack({ ok: false, error: "当前不在休整阶段" });
    const elapsed = Date.now() - new Date(p.restStartedAt).getTime();
    if (elapsed < 60_000) return ack({ ok: false, error: `还需休整 ${Math.ceil((60_000 - elapsed) / 1000)} 秒` });
    p.ready = true;
    saveParticipant(p);
    audit(room.roomCode, "participant", "participant_ready", { macroBlock: p.macroBlock }, p.participantId);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(String(socket.data.roomCode));
    const p = room?.participants.get(String(socket.data.participantId));
    if (!room || !p) return;
    if (p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = undefined;
    saveParticipant(p);
    broadcast(room);
  });
});

const clientDist = resolve("dist/client");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("/{*path}", (_req, res) => createReadStream(resolve(clientDist, "index.html")).pipe(res));
}

server.listen(port, "0.0.0.0", () => {
  const lan = getLanAddress();
  console.log(`\n异域同行 Room ${defaultRoom.roomCode}`);
  console.log(`被试入口: http://${lan}:${port}/`);
  console.log(`主试入口: http://127.0.0.1:${port}/admin?room=${defaultRoom.roomCode}&token=${defaultRoom.adminToken}\n`);
});
