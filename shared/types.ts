export type Action = "cooperate" | "betray";
export type GameKey = "pd" | "stag" | "snow" | "harmony";
export type BotLevel = "low" | "high";
export type AccessMode = "lan" | "public";
export type RegionTheme = "moss" | "slate" | "earth" | "plum";
export type DoseCode = "short96" | "long192";
export type ProtocolVersion = "ctp-v2" | "legacy-v1";
export type EvidenceClass = "aligned" | "conflict" | "neutral";
export type SocialRegime = "stable" | "volatile";
export type ConsentMode = "full" | "continuation";

export interface ParticipantAssignment {
  studyId: string;
  groupCode: string;
  waveCode: string;
  formCode: string;
  notes: string;
  assignmentMethod?: string;
}

export interface ParticipantProgress {
  participantId: string;
  subjectId: string;
  sessionId: string;
  studyId: string;
  connected: boolean;
  assignmentLocked: boolean;
  groupCode: string;
  waveCode: string;
  notes: string;
  protocolVersion: ProtocolVersion;
  doseCode: DoseCode | "legacy240";
  sequenceId: string;
  totalTrials: number;
  completedTrials: number;
  protocolDeviation: boolean;
  doseLocked: boolean;
  macroBlock: number;
  companionIndex: number;
  validRound: number;
  status: "lobby" | "active" | "rest" | "paused" | "complete";
  ready: boolean;
  consented: boolean;
  restReadyAt?: string;
  predictionTimeouts: number;
  choiceTimeouts: number;
}

export interface RoomSnapshot {
  roomCode: string;
  status: "lobby" | "running" | "paused" | "complete";
  activeMacroBlock: number;
  accessMode: AccessMode;
  wifiName: string;
  publicBaseUrl: string;
  lanAddress: string;
  joinUrl: string;
  participants: ParticipantProgress[];
}

export interface ParticipantEventRecord {
  clientEventId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  roundId?: string;
  phase?: string;
  clientTime: string;
  clientMonotonicMs: number;
  visibilityState: string;
  fullscreen: boolean;
  online: boolean;
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  payload?: Record<string, unknown>;
}

export interface ParticipantSnapshot {
  roomStatus: RoomSnapshot["status"];
  activeMacroBlock: number;
  self: Pick<ParticipantProgress, "macroBlock" | "status" | "ready" | "consented" | "restReadyAt"> & {
    cumulativePoints: number;
    regionTheme?: RegionTheme;
    locationName?: string;
    remainingTrialsInBlock: number;
    consentMode: ConsentMode;
  };
}

export interface RoundOffer {
  roundId: string;
  sessionId: string;
  protocolVersion: ProtocolVersion;
  doseCode: DoseCode;
  sequenceId: string;
  trialTemplateId: string;
  anchorId?: string;
  evidenceClass: EvidenceClass;
  socialRegime: SocialRegime;
  socialValueShort: number;
  socialValueLong: number;
  socialValueMean: number;
  socialValueContrast: number;
  personalValueBasis: number;
  previousChoice: number;
  macroBlock: number;
  regionTheme: RegionTheme;
  locationName: string;
  companionLabel: string;
  companionOrdinal: number;
  observedAction: Action;
  observedRouteAction: Action;
  observedDisplayPoints: number;
  guardianLabel: string;
  validRound: number;
  totalRoundsWithCompanion: number;
  cumulativePoints: number;
  predictionDeadlineMs: number;
  choiceDeadlineMs: number;
}

export interface RoundResult {
  roundId: string;
  participantAction: Action;
  routeAction: Action;
  displayPoints: number;
  normalizedPayoff: number;
  cumulativePoints: number;
  intendedDelayMs: number;
  actualDelayMs: number;
}

export interface ServerToClientEvents {
  participant_snapshot: (snapshot: ParticipantSnapshot) => void;
  session_ended: (payload: { message: string }) => void;
}

export interface ClientToServerEvents {
  participant_join: (
    payload: { roomCode: string; studyId: string; resumeToken?: string },
    ack: (result: { ok: boolean; participantId?: string; resumeToken?: string; error?: string }) => void,
  ) => void;
}
