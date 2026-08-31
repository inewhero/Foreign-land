import { createHash, randomBytes } from "node:crypto";
import type { Action, BotLevel, DoseCode, GameKey, RegionTheme, SocialRegime } from "../shared/types.js";

export const TRIALS_PER_COMPANION = 30;
export const BOT_BETA: Record<BotLevel, number> = { low: 2, high: 8 };
export const V2_TRIALS_PER_COMPANION: Record<DoseCode, number> = { short96: 12, long192: 24 };
export const trialsPerCompanion = (doseCode: DoseCode | "legacy240") =>
  doseCode === "legacy240" ? TRIALS_PER_COMPANION : V2_TRIALS_PER_COMPANION[doseCode];
export const totalTrialsForDose = (doseCode: DoseCode | "legacy240") => trialsPerCompanion(doseCode) * 8;

export interface GameDefinition {
  key: GameKey;
  a: number;
  b: number;
  normalized: [[number, number], [number, number]];
  displayed: [[number, number], [number, number]];
}

const makeGame = (key: GameKey, a: number, b: number): GameDefinition => {
  const normalized: GameDefinition["normalized"] = [
    [1, -b],
    [1 - a, 0],
  ];
  const displayed = normalized.map((row) => row.map((value) => Math.round(20 * value + 20))) as GameDefinition["displayed"];
  return { key, a, b, normalized, displayed };
};

export const GAMES: Record<GameKey, GameDefinition> = {
  pd: makeGame("pd", -0.4, 0.4),
  stag: makeGame("stag", 0.4, 0.4),
  snow: makeGame("snow", -0.4, -0.4),
  harmony: makeGame("harmony", 0.4, -0.4),
};

const WILLIAMS: GameKey[][] = [
  ["pd", "stag", "harmony", "snow"],
  ["stag", "snow", "pd", "harmony"],
  ["snow", "harmony", "stag", "pd"],
  ["harmony", "pd", "snow", "stag"],
  ["snow", "harmony", "stag", "pd"].reverse() as GameKey[],
  ["harmony", "pd", "snow", "stag"].reverse() as GameKey[],
  ["pd", "stag", "harmony", "snow"].reverse() as GameKey[],
  ["stag", "snow", "pd", "harmony"].reverse() as GameKey[],
];

export const LOCATION_POOLS = [
  ["岚岛", "星湾", "云谷", "暮原"],
  ["澄港", "雾丘", "青屿", "月川"],
];

export const guardianLabel = (locationName: string) => `${locationName}守关者`;
export const REGION_THEMES: RegionTheme[] = ["moss", "slate", "earth", "plum"];

export type DelayProfile = "swift" | "steady" | "deliberate" | "variable";

export interface ConditionDefinition {
  macroBlock: number;
  game: GameKey;
  locationName: string;
  regionTheme: RegionTheme;
  companionOrdinal: number;
  companionLabel: string;
  botLevel: BotLevel;
  socialRegime: SocialRegime;
  delayProfile: DelayProfile;
}

export function stableIndex(value: string, modulo: number): number {
  const hash = createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) % modulo;
}

export function seededFloat(seed: string): number {
  const hash = createHash("sha256").update(seed).digest();
  return hash.readUInt32BE(0) / 0x1_0000_0000;
}

export function regionThemeSequence(studyId: string, formCode = "A"): RegionTheme[] {
  const themes = [...REGION_THEMES];
  for (let index = themes.length - 1; index > 0; index -= 1) {
    const swapWith = stableIndex(`${studyId}:${formCode}:region-theme:${index}`, index + 1);
    [themes[index], themes[swapWith]] = [themes[swapWith], themes[index]];
  }
  return themes;
}

export function buildConditions(studyId: string, formCode = "A"): ConditionDefinition[] {
  const sequenceIndex = stableIndex(`${studyId}:${formCode}:sequence`, WILLIAMS.length);
  const games = WILLIAMS[sequenceIndex];
  const pool = LOCATION_POOLS[stableIndex(`${formCode}:locations`, LOCATION_POOLS.length)];
  const locationShift = stableIndex(`${studyId}:${formCode}:location-shift`, 4);
  const locations = games.map((_, i) => pool[(i + locationShift) % 4]);
  const regionThemes = regionThemeSequence(studyId, formCode);
  const lowFirst = stableIndex(`${studyId}:${formCode}:bot-order`, 2) === 0;
  const profiles: DelayProfile[] = ["swift", "steady", "deliberate", "variable"];
  const profileShifts: Record<BotLevel, number> = {
    low: stableIndex(`${studyId}:${formCode}:delay:low`, profiles.length),
    high: stableIndex(`${studyId}:${formCode}:delay:high`, profiles.length),
  };
  const profileCounts: Record<BotLevel, number> = { low: 0, high: 0 };

  return games.flatMap((game, macroBlock) => {
    const levels: BotLevel[] = (macroBlock + (lowFirst ? 0 : 1)) % 2 === 0 ? ["low", "high"] : ["high", "low"];
    return levels.map((botLevel, withinBlock) => {
      const companionOrdinal = macroBlock * 2 + withinBlock;
      return {
        macroBlock,
        game,
        locationName: locations[macroBlock],
        regionTheme: regionThemes[macroBlock],
        companionOrdinal,
        companionLabel: String.fromCharCode(65 + companionOrdinal),
        botLevel,
        socialRegime: withinBlock === 0 ? "stable" : "volatile",
        // Each beta level receives every latency profile exactly once. Latency is
        // lifelike but orthogonal to the social-learning manipulation.
        delayProfile: profiles[(profileCounts[botLevel]++ + profileShifts[botLevel]) % profiles.length],
      };
    });
  });
}

const actionIndex = (action: Action): 0 | 1 => (action === "cooperate" ? 0 : 1);
const otherAction = (action: Action): Action => (action === "cooperate" ? "betray" : "cooperate");

export function chooseCompanionAction(args: {
  game: GameKey;
  level: BotLevel;
  previousParticipant?: Action;
  previousCompanion?: Action;
  seed: string;
}): { action: Action; switchProbability: number; deltaPayoff: number } {
  const draw = seededFloat(`${args.seed}:action`);
  if (!args.previousParticipant || !args.previousCompanion) {
    return { action: draw < 0.5 ? "cooperate" : "betray", switchProbability: 0.5, deltaPayoff: 0 };
  }

  const matrix = GAMES[args.game].normalized;
  const current = actionIndex(args.previousCompanion);
  const alternative = actionIndex(otherAction(args.previousCompanion));
  const participant = actionIndex(args.previousParticipant);
  const deltaPayoff = matrix[alternative][participant] - matrix[current][participant];
  const switchProbability = 1 / (1 + Math.exp(-BOT_BETA[args.level] * deltaPayoff));
  return {
    action: draw < switchProbability ? otherAction(args.previousCompanion) : args.previousCompanion,
    switchProbability,
    deltaPayoff,
  };
}

export function participantPayoff(game: GameKey, participant: Action, companion: Action) {
  const row = actionIndex(participant);
  const column = actionIndex(companion);
  return {
    normalized: GAMES[game].normalized[row][column],
    displayed: GAMES[game].displayed[row][column],
  };
}

export function delayFor(profile: DelayProfile, seed: string): number {
  const u = Math.max(0.0001, seededFloat(`${seed}:delay:u`));
  const v = Math.max(0.0001, seededFloat(`${seed}:delay:v`));
  const gaussian = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const config: Record<DelayProfile, { median: number; sigma: number }> = {
    swift: { median: 520, sigma: 0.24 },
    steady: { median: 850, sigma: 0.2 },
    deliberate: { median: 1320, sigma: 0.22 },
    variable: { median: 900, sigma: 0.48 },
  };
  const { median, sigma } = config[profile];
  return Math.round(Math.min(2400, Math.max(320, median * Math.exp(sigma * gaussian))));
}

export function makeId(prefix: string) {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}
