import { createHash } from "node:crypto";
import type { Action, DoseCode, EvidenceClass, GameKey, SocialRegime } from "../shared/types.js";
import { GAMES, delayFor } from "./experiment.js";

export const PROTOCOL_VERSION = "ctp-v2" as const;
export const SOCIAL_ALPHA_SHORT = 0.5;
export const SOCIAL_ALPHA_LONG = 0.15;
export const PERSONAL_ALPHA_SHORT = 0.5;
export const PERSONAL_ALPHA_LONG = 0.15;

export interface SequenceTrial {
  trialTemplateId: string;
  anchorId?: string;
  evidenceClass: EvidenceClass;
  socialRegime: SocialRegime;
  companionOrdinal: number;
  validRound: number;
  observedAction: Action;
  observedRouteAction: Action;
  participantRouteAction: Action;
  intendedDelayMs: number;
  socialValueShort: number;
  socialValueLong: number;
  socialValueMean: number;
  socialValueContrast: number;
}

export interface SequenceBank {
  protocolVersion: typeof PROTOCOL_VERSION;
  doseCode: DoseCode;
  formCode: string;
  waveCode: string;
  sequenceId: string;
  hash: string;
  trials: SequenceTrial[];
}

interface PatternRow {
  evidenceClass: EvidenceClass;
  observedAction: Action;
  observedRouteAction: Action;
  participantRouteAction: Action;
}

// These accepted rows are the compact source of truth for every formal sequence.
// Forms only permute non-anchor rows; no participant response enters this table.
const CORE_ROWS: PatternRow[] = [
  { evidenceClass: "aligned", observedAction: "cooperate", observedRouteAction: "cooperate", participantRouteAction: "betray" },
  { evidenceClass: "conflict", observedAction: "cooperate", observedRouteAction: "betray", participantRouteAction: "cooperate" },
  { evidenceClass: "neutral", observedAction: "cooperate", observedRouteAction: "cooperate", participantRouteAction: "cooperate" },
  { evidenceClass: "aligned", observedAction: "betray", observedRouteAction: "betray", participantRouteAction: "cooperate" },
  { evidenceClass: "conflict", observedAction: "betray", observedRouteAction: "cooperate", participantRouteAction: "betray" },
  { evidenceClass: "neutral", observedAction: "betray", observedRouteAction: "betray", participantRouteAction: "betray" },
  { evidenceClass: "aligned", observedAction: "cooperate", observedRouteAction: "betray", participantRouteAction: "betray" },
  { evidenceClass: "conflict", observedAction: "cooperate", observedRouteAction: "cooperate", participantRouteAction: "betray" },
  { evidenceClass: "neutral", observedAction: "cooperate", observedRouteAction: "betray", participantRouteAction: "cooperate" },
  { evidenceClass: "aligned", observedAction: "betray", observedRouteAction: "cooperate", participantRouteAction: "cooperate" },
  { evidenceClass: "conflict", observedAction: "betray", observedRouteAction: "betray", participantRouteAction: "cooperate" },
  { evidenceClass: "neutral", observedAction: "betray", observedRouteAction: "cooperate", participantRouteAction: "betray" },
];

const EXTENSION_ROWS: PatternRow[] = CORE_ROWS.map((row) => ({
  evidenceClass: row.evidenceClass,
  observedAction: flip(row.observedAction),
  observedRouteAction: flip(row.observedRouteAction),
  participantRouteAction: flip(row.participantRouteAction),
}));

const ANCHOR_POSITIONS = new Set([0, 4, 8]);
const cache = new Map<string, SequenceBank>();
const VOLATILE_ORDER = [0, 3, 1, 4, 2, 5, 6, 9, 7, 10, 8, 11];

function flip(action: Action): Action {
  return action === "cooperate" ? "betray" : "cooperate";
}

function waveNumber(waveCode: string) {
  const parsed = Number(waveCode.replace(/^T/i, ""));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function formNumber(formCode: string) {
  const code = formCode.toUpperCase().charCodeAt(0) - 65;
  return Number.isInteger(code) && code >= 0 ? code % 4 : 0;
}

function permutedCore(formCode: string, waveCode: string, companionOrdinal: number): PatternRow[] {
  const variant = (formNumber(formCode) + waveNumber(waveCode)) % 4;
  const order = companionOrdinal % 2 === 0 ? CORE_ROWS.map((_, index) => index) : VOLATILE_ORDER;
  const selected = order.map((index) => ({ ...CORE_ROWS[index] }));
  return variant >= 2 ? selected.reverse() : selected;
}

function rewardValue(game: GameKey, action: Action, routeAction: Action) {
  const row = action === "cooperate" ? 0 : 1;
  const column = routeAction === "cooperate" ? 0 : 1;
  return GAMES[game].normalized[row][column];
}

function standardize(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  const sd = Math.sqrt(variance) || 1;
  return values.map((value) => (value - mean) / sd);
}

function orthogonalResidual(values: number[], nuisanceColumns: number[][]) {
  const centeredColumns = nuisanceColumns.map((column) => standardize(column));
  const orthonormal: number[][] = [];
  for (const source of centeredColumns) {
    const vector = [...source];
    for (const basis of orthonormal) {
      const projection = vector.reduce((sum, value, index) => sum + value * basis[index], 0);
      for (let index = 0; index < vector.length; index += 1) vector[index] -= projection * basis[index];
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm > 1e-8) orthonormal.push(vector.map((value) => value / norm));
  }
  const residual = [...standardize(values)];
  for (const basis of orthonormal) {
    const projection = residual.reduce((sum, value, index) => sum + value * basis[index], 0);
    for (let index = 0; index < residual.length; index += 1) residual[index] -= projection * basis[index];
  }
  return standardize(residual);
}

export function buildSequenceBank(args: {
  doseCode: DoseCode;
  formCode: string;
  waveCode: string;
  games: GameKey[];
}): SequenceBank {
  const key = `${args.doseCode}:${args.formCode}:${args.waveCode}:${args.games.join("-")}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const raw: Array<Omit<SequenceTrial, "socialValueMean" | "socialValueContrast">> = [];
  for (let companionOrdinal = 0; companionOrdinal < 8; companionOrdinal += 1) {
    const game = args.games[Math.floor(companionOrdinal / 2)];
    const regime: SocialRegime = companionOrdinal % 2 === 0 ? "stable" : "volatile";
    const core = permutedCore(args.formCode, args.waveCode, companionOrdinal);
    const rows = args.doseCode === "long192" ? [...core, ...EXTENSION_ROWS] : core;
    let qShort = [0, 0];
    let qLong = [0, 0];
    rows.forEach((source, index) => {
      const invert = (companionOrdinal % 2 === 1) !== ((formNumber(args.formCode) + waveNumber(args.waveCode)) % 2 === 1);
      const observedAction = invert ? flip(source.observedAction) : source.observedAction;
      const observedRouteAction = invert ? flip(source.observedRouteAction) : source.observedRouteAction;
      const participantRouteAction = (formNumber(args.formCode) + waveNumber(args.waveCode)) % 2 === 0
        ? source.participantRouteAction
        : flip(source.participantRouteAction);
      const actionIndex = observedAction === "cooperate" ? 0 : 1;
      const reward = rewardValue(game, observedAction, observedRouteAction);
      qShort[actionIndex] += SOCIAL_ALPHA_SHORT * (reward - qShort[actionIndex]);
      qLong[actionIndex] += SOCIAL_ALPHA_LONG * (reward - qLong[actionIndex]);
      const phase = index < 12 ? "core" : "extension";
      const slot = index % 12;
      const trialTemplateId = `${PROTOCOL_VERSION}:${args.formCode}:${args.waveCode}:c${companionOrdinal + 1}:${phase}:${slot + 1}`;
      raw.push({
        trialTemplateId,
        anchorId: index < 12 && ANCHOR_POSITIONS.has(slot) ? `${PROTOCOL_VERSION}:anchor:c${companionOrdinal + 1}:${slot / 4 + 1}` : undefined,
        evidenceClass: source.evidenceClass,
        socialRegime: regime,
        companionOrdinal,
        validRound: index + 1,
        observedAction,
        observedRouteAction,
        participantRouteAction,
        intendedDelayMs: delayFor(["swift", "steady", "deliberate", "variable"][(companionOrdinal + slot) % 4] as "swift" | "steady" | "deliberate" | "variable", trialTemplateId),
        socialValueShort: qShort[0] - qShort[1],
        socialValueLong: qLong[0] - qLong[1],
      });
    });
  }

  const shortZ = standardize(raw.map((trial) => trial.socialValueShort));
  const longZ = standardize(raw.map((trial) => trial.socialValueLong));
  const socialMeanRaw = shortZ.map((value, index) => (value + longZ[index]) / Math.SQRT2);
  const socialContrastRaw = shortZ.map((value, index) => (value - longZ[index]) / Math.SQRT2);
  const nuisance = [
    raw.map((trial) => trial.observedAction === "cooperate" ? 1 : -1),
    raw.map((_, index) => index / Math.max(1, raw.length - 1)),
    raw.map((trial) => trial.socialRegime === "stable" ? 1 : -1),
    ...[1, 2, 3].map((gameIndex) => raw.map((trial) => Math.floor(trial.companionOrdinal / 2) === gameIndex ? 1 : 0)),
  ];
  const socialMean = orthogonalResidual(socialMeanRaw, nuisance);
  const socialContrast = orthogonalResidual(socialContrastRaw, [...nuisance, socialMean]);
  const trials: SequenceTrial[] = raw.map((trial, index) => ({
    ...trial,
    socialValueShort: shortZ[index],
    socialValueLong: longZ[index],
    socialValueMean: socialMean[index],
    socialValueContrast: socialContrast[index],
  }));
  const hash = createHash("sha256").update(JSON.stringify(trials)).digest("hex").slice(0, 16);
  const bank: SequenceBank = {
    protocolVersion: PROTOCOL_VERSION,
    doseCode: args.doseCode,
    formCode: args.formCode,
    waveCode: args.waveCode,
    sequenceId: `${PROTOCOL_VERSION}-${args.doseCode}-${args.formCode}-${args.waveCode}-${hash}`,
    hash,
    trials,
  };
  cache.set(key, bank);
  return bank;
}

export function sequenceTrial(bank: SequenceBank, companionOrdinal: number, validRoundZeroBased: number) {
  const trial = bank.trials.find((item) => item.companionOrdinal === companionOrdinal && item.validRound === validRoundZeroBased + 1);
  if (!trial) throw new Error("序列游标超出已验收序列库");
  return trial;
}
