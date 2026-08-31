/*
 * Null calibration for scripts/analyze-social-beta.mjs.
 *
 * This file deliberately keeps all generated data in memory.  It reproduces
 * the condition and companion-generation logic used by server/experiment.ts,
 * then applies the same seven-by-seven alpha grid and penalized logistic fit
 * used by analyze-social-beta.mjs.  It is intended for pilot/power planning;
 * it does not connect to the experiment server or its SQLite database.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const ROOT = resolve(".");
const OUTPUT_DIR = resolve("output/power/null_calibration");
const ANALYZER = resolve("scripts/analyze-social-beta.mjs");
const ALPHAS = [0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9];
const FEATURES = 13;
const TRIALS_PER_COMPANION = 30;
const COMPANIONS = 8;
const TOTAL_TRIALS = TRIALS_PER_COMPANION * COMPANIONS;
const PRIMARY_FIELD = "beta_social_low";
const SOCIAL_FIELDS = [
  "beta_social_low",
  "beta_social_high",
  "beta_social_pd",
  "beta_social_stag",
  "beta_social_snow",
  "beta_social_harmony",
];

const GAMES = {
  pd: { normalized: [[1, -0.4], [1.4, 0]] },
  stag: { normalized: [[1, -0.4], [0.6, 0]] },
  snow: { normalized: [[1, 0.4], [1.4, 0]] },
  harmony: { normalized: [[1, 0.4], [0.6, 0]] },
};

const WILLIAMS = [
  ["pd", "stag", "harmony", "snow"],
  ["stag", "snow", "pd", "harmony"],
  ["snow", "harmony", "stag", "pd"],
  ["harmony", "pd", "snow", "stag"],
  ["snow", "harmony", "stag", "pd"].reverse(),
  ["harmony", "pd", "snow", "stag"].reverse(),
  ["pd", "stag", "harmony", "snow"].reverse(),
  ["stag", "snow", "pd", "harmony"].reverse(),
];
const LOCATION_POOLS = [
  ["岚岛", "星湾", "云谷", "暮原"],
  ["澄港", "雾丘", "青屿", "月川"],
];
const REGION_THEMES = ["moss", "slate", "earth", "plum"];
const DELAY_PROFILES = ["swift", "steady", "deliberate", "variable"];
const BOT_BETA = { low: 2, high: 8 };

const MODE_DEFINITIONS = [
  {
    name: "iid_50",
    description: "每轮独立 Bernoulli(0.50)",
    behavior: "iid",
  },
  {
    name: "fixed_rate_20",
    description: "每位被试固定合作率 p=0.20，每轮独立抽样",
    behavior: "fixed",
    rate: 0.2,
  },
  {
    name: "fixed_rate_80",
    description: "每位被试固定合作率 p=0.80，每轮独立抽样",
    behavior: "fixed",
    rate: 0.8,
  },
  {
    name: "fixed_rate_mixed",
    description: "每位被试从 U(0.15,0.85) 抽一个固定合作率",
    behavior: "fixed_mixed",
  },
  {
    name: "random_walk",
    description: "logit 合作倾向独立随机游走，步长 SD=0.35",
    behavior: "random_walk",
  },
  {
    name: "inertia_80",
    description: "与上一选择相同的概率 0.80，初始 p=0.50",
    behavior: "inertia",
    persistence: 0.8,
  },
];

function stableIndex(value, modulo) {
  const hash = createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) % modulo;
}

// This is the exact deterministic hash-to-uniform convention from the
// server.  It is used for all condition and route/action draws.
function seededFloat(value) {
  const hash = createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) / 0x1_0000_0000;
}

function sigmoid(value) {
  return value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));
}

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

function normalRandom(random) {
  const u = Math.max(1e-12, random());
  const v = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function buildConditions(studyId, formCode = "A") {
  const games = WILLIAMS[stableIndex(`${studyId}:${formCode}:sequence`, WILLIAMS.length)];
  const pool = LOCATION_POOLS[stableIndex(`${formCode}:locations`, LOCATION_POOLS.length)];
  const locationShift = stableIndex(`${studyId}:${formCode}:location-shift`, 4);
  const locations = games.map((_, i) => pool[(i + locationShift) % 4]);

  const themes = [...REGION_THEMES];
  for (let index = themes.length - 1; index > 0; index -= 1) {
    const swapWith = stableIndex(`${studyId}:${formCode}:region-theme:${index}`, index + 1);
    [themes[index], themes[swapWith]] = [themes[swapWith], themes[index]];
  }

  const lowFirst = stableIndex(`${studyId}:${formCode}:bot-order`, 2) === 0;
  const profileShifts = {
    low: stableIndex(`${studyId}:${formCode}:delay:low`, DELAY_PROFILES.length),
    high: stableIndex(`${studyId}:${formCode}:delay:high`, DELAY_PROFILES.length),
  };
  const profileCounts = { low: 0, high: 0 };

  return games.flatMap((game, macroBlock) => {
    const levels = (macroBlock + (lowFirst ? 0 : 1)) % 2 === 0
      ? ["low", "high"]
      : ["high", "low"];
    return levels.map((botLevel, withinBlock) => {
      const companionOrdinal = macroBlock * 2 + withinBlock;
      return {
        macroBlock,
        game,
        locationName: locations[macroBlock],
        regionTheme: themes[macroBlock],
        companionOrdinal,
        companionLabel: String.fromCharCode(65 + companionOrdinal),
        botLevel,
        delayProfile: DELAY_PROFILES[(profileCounts[botLevel]++ + profileShifts[botLevel]) % DELAY_PROFILES.length],
      };
    });
  });
}

function actionIndex(action) {
  return action === "cooperate" ? 0 : 1;
}

function otherAction(action) {
  return action === "cooperate" ? "betray" : "cooperate";
}

function participantPayoff(game, participant, companion) {
  const normalized = GAMES[game].normalized[actionIndex(participant)][actionIndex(companion)];
  return {
    normalized,
    displayed: Math.round(20 * normalized + 20),
  };
}

function chooseCompanionAction({ game, level, previousParticipant, previousCompanion, seed }) {
  const draw = seededFloat(`${seed}:action`);
  if (!previousParticipant || !previousCompanion) {
    return {
      action: draw < 0.5 ? "cooperate" : "betray",
      switchProbability: 0.5,
      deltaPayoff: 0,
    };
  }
  const matrix = GAMES[game].normalized;
  const current = actionIndex(previousCompanion);
  const alternative = actionIndex(otherAction(previousCompanion));
  const participant = actionIndex(previousParticipant);
  const deltaPayoff = matrix[alternative][participant] - matrix[current][participant];
  const switchProbability = sigmoid(BOT_BETA[level] * deltaPayoff);
  return {
    action: draw < switchProbability ? otherAction(previousCompanion) : previousCompanion,
    switchProbability,
    deltaPayoff,
  };
}

function buildParticipantChoice(mode, random, state) {
  if (mode.behavior === "iid") return random() < 0.5 ? "cooperate" : "betray";
  if (mode.behavior === "fixed") return random() < mode.rate ? "cooperate" : "betray";
  if (mode.behavior === "fixed_mixed") return random() < state.fixedRate ? "cooperate" : "betray";
  if (mode.behavior === "random_walk") {
    state.logit += 0.35 * normalRandom(random);
    state.logit = Math.max(-4, Math.min(4, state.logit));
    return random() < sigmoid(state.logit) ? "cooperate" : "betray";
  }
  if (mode.behavior === "inertia") {
    if (!state.previousChoice) return random() < 0.5 ? "cooperate" : "betray";
    if (random() < mode.persistence) return state.previousChoice;
    return otherAction(state.previousChoice);
  }
  throw new Error(`未知的 null mode: ${mode.behavior}`);
}

function makeTrials({ mode, seed, participantIndex, trialCount = TOTAL_TRIALS }) {
  const studyId = `NULL_${mode.name}_${seed}_${String(participantIndex + 1).padStart(3, "0")}`;
  const random = seededRandom(`${seed}:${mode.name}:${participantIndex}:participant`);
  const conditions = buildConditions(studyId, "A");
  const state = {
    fixedRate: mode.behavior === "fixed_mixed" ? 0.15 + 0.7 * random() : undefined,
    logit: 0,
    previousChoice: undefined,
  };
  const trials = [];
  let previousParticipant;
  let previousCompanion;
  let trialNumber = 0;

  for (const condition of conditions) {
    previousParticipant = undefined;
    previousCompanion = undefined;
    for (let validRound = 0; validRound < TRIALS_PER_COMPANION && trialNumber < trialCount; validRound += 1) {
      const roundSeed = `NULLROOM:${studyId}:T0:A:${condition.companionOrdinal}:${validRound}`;
      const companion = chooseCompanionAction({
        game: condition.game,
        level: condition.botLevel,
        previousParticipant,
        previousCompanion,
        seed: roundSeed,
      });
      const companionRouteAction = seededFloat(`${roundSeed}:companion-route`) < 0.5 ? "cooperate" : "betray";
      const participantRouteAction = seededFloat(`${roundSeed}:participant-route`) < 0.5 ? "cooperate" : "betray";
      const companionPayoff = participantPayoff(condition.game, companion.action, companionRouteAction);
      const participantAction = buildParticipantChoice(mode, random, state);
      const payoff = participantPayoff(condition.game, participantAction, participantRouteAction);
      trials.push({
        study_id: studyId,
        companion_ordinal: condition.companionOrdinal,
        companion_action: companion.action,
        companion_display_points: companionPayoff.displayed,
        participant_route_action: participantRouteAction,
        participant_action: participantAction,
        normalized_payoff: payoff.normalized,
        game_key: condition.game,
        bot_level: condition.botLevel,
        created_at: `2026-08-30T00:00:00.${String(trialNumber).padStart(3, "0")}Z`,
        valid_round: validRound + 1,
        companion_route_action: companionRouteAction,
        mode: mode.name,
        seed,
        participant_index: participantIndex,
        fixed_rate: state.fixedRate ?? mode.rate ?? null,
      });
      previousParticipant = companionRouteAction;
      previousCompanion = companion.action;
      state.previousChoice = participantAction;
      trialNumber += 1;
    }
    if (trialNumber >= trialCount) break;
  }
  return trials;
}

function buildDesign(trials, alphaSocial, alphaSelf) {
  const x = new Float64Array(trials.length * FEATURES);
  const y = new Uint8Array(trials.length);
  let socialQ0 = 0;
  let socialQ1 = 0;
  let selfQ0 = 0;
  let selfQ1 = 0;
  let previousChoice = 0;
  let previousCompanion = null;
  let previousGame = null;

  for (let i = 0; i < trials.length; i += 1) {
    const trial = trials[i];
    if (trial.companion_ordinal !== previousCompanion) {
      socialQ0 = 0;
      socialQ1 = 0;
    }
    if (trial.game_key !== previousGame) {
      selfQ0 = 0;
      selfQ1 = 0;
      previousChoice = 0;
    }
    previousCompanion = trial.companion_ordinal;
    previousGame = trial.game_key;

    const observedIndex = trial.companion_action === "cooperate" ? 0 : 1;
    const rewardValue = (Number(trial.companion_display_points) - 20) / 20;
    if (observedIndex === 0) socialQ0 += alphaSocial * (rewardValue - socialQ0);
    else socialQ1 += alphaSocial * (rewardValue - socialQ1);
    const ds = socialQ0 - socialQ1;
    const dp = selfQ0 - selfQ1;
    const game = trial.game_key === "pd" ? 0 : trial.game_key === "stag" ? 1 : trial.game_key === "snow" ? 2 : 3;
    const high = trial.bot_level === "high" ? 1 : 0;
    const base = i * FEATURES;
    x[base] = 1;
    x[base + 1] = game === 1 ? 1 : 0;
    x[base + 2] = game === 2 ? 1 : 0;
    x[base + 3] = game === 3 ? 1 : 0;
    x[base + 4] = ds;
    x[base + 5] = game === 1 ? ds : 0;
    x[base + 6] = game === 2 ? ds : 0;
    x[base + 7] = game === 3 ? ds : 0;
    x[base + 8] = dp;
    x[base + 9] = trial.companion_action === "cooperate" ? 1 : -1;
    x[base + 10] = previousChoice;
    x[base + 11] = high;
    x[base + 12] = ds * high;
    y[i] = trial.participant_action === "cooperate" ? 1 : 0;

    const ownIndex = y[i] === 1 ? 0 : 1;
    const payoff = Number(trial.normalized_payoff);
    if (ownIndex === 0) selfQ0 += alphaSelf * (payoff - selfQ0);
    else selfQ1 += alphaSelf * (payoff - selfQ1);
    previousChoice = y[i] === 1 ? 1 : -1;
  }
  return { x, y };
}

// Same Adam/L2 optimizer as analyze-social-beta.mjs, with a flat typed-array
// design matrix for lower allocation overhead.  The update order, step size,
// penalty and stopping rule are intentionally unchanged.
function fitLogistic(x, y, lambda = 0.7) {
  const n = y.length;
  const weights = new Float64Array(FEATURES);
  const m = new Float64Array(FEATURES);
  const v = new Float64Array(FEATURES);
  const gradient = new Float64Array(FEATURES);
  let lastObjective = -Infinity;
  let steps = 0;

  for (let step = 1; step <= 2600; step += 1) {
    gradient.fill(0);
    let logLikelihood = 0;
    for (let i = 0; i < n; i += 1) {
      const base = i * FEATURES;
      let linear = 0;
      for (let j = 0; j < FEATURES; j += 1) linear += x[base + j] * weights[j];
      const probability = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(linear)));
      const yi = y[i];
      const error = yi - probability;
      logLikelihood += yi * Math.log(probability) + (1 - yi) * Math.log(1 - probability);
      for (let j = 0; j < FEATURES; j += 1) gradient[j] += x[base + j] * error;
    }
    for (let j = 1; j < FEATURES; j += 1) {
      gradient[j] -= lambda * weights[j];
      logLikelihood -= 0.5 * lambda * weights[j] ** 2;
    }
    for (let j = 0; j < FEATURES; j += 1) {
      const g = gradient[j] / n;
      m[j] = 0.9 * m[j] + 0.1 * g;
      v[j] = 0.999 * v[j] + 0.001 * g * g;
      const mHat = m[j] / (1 - 0.9 ** step);
      const vHat = v[j] / (1 - 0.999 ** step);
      weights[j] += 0.025 * mHat / (Math.sqrt(vHat) + 1e-8);
    }
    steps = step;
    if (step % 100 === 0 && Math.abs(logLikelihood - lastObjective) < 1e-7) break;
    if (step % 100 === 0) lastObjective = logLikelihood;
  }

  let objective = 0;
  for (let i = 0; i < n; i += 1) {
    const base = i * FEATURES;
    let linear = 0;
    for (let j = 0; j < FEATURES; j += 1) linear += x[base + j] * weights[j];
    const probability = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(linear)));
    objective += y[i] * Math.log(probability) + (1 - y[i]) * Math.log(1 - probability);
  }
  for (let j = 1; j < FEATURES; j += 1) objective -= 0.5 * lambda * weights[j] ** 2;
  return { weights, objective, steps };
}

function estimate(trials) {
  let best = null;
  for (const alphaSocial of ALPHAS) {
    for (const alphaSelf of ALPHAS) {
      const design = buildDesign(trials, alphaSocial, alphaSelf);
      const fit = fitLogistic(design.x, design.y);
      if (!best || fit.objective > best.objective) {
        best = { ...fit, alphaSocial, alphaSelf };
      }
    }
  }
  const w = best.weights;
  return {
    n_trials: trials.length,
    alpha_social: best.alphaSocial,
    alpha_self: best.alphaSelf,
    beta_social_low: w[4],
    beta_social_high: w[4] + w[12],
    beta_social_pd: w[4],
    beta_social_stag: w[4] + w[5],
    beta_social_snow: w[4] + w[6],
    beta_social_harmony: w[4] + w[7],
    beta_self: w[8],
    beta_choice: w[9],
    choice_persistence: w[10],
    penalized_log_likelihood: best.objective,
    quality_flag: trials.length >= 200 ? "ok" : "low_trial_count",
    optimizer_steps: best.steps,
  };
}

function csvQuote(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function toCsv(rows, columns) {
  return `\uFEFF${columns.map(csvQuote).join(",")}\n${rows.map((row) => columns.map((column) => csvQuote(row[column])).join(",")).join("\n")}\n`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.filter((values) => values.length === header.length).map((values) =>
    Object.fromEntries(header.map((name, index) => [name, values[index]])),
  );
}

function runOne(task) {
  const mode = MODE_DEFINITIONS.find((candidate) => candidate.name === task.mode);
  if (!mode) throw new Error(`未知 mode: ${task.mode}`);
  const trials = makeTrials({
    mode,
    seed: task.seed,
    participantIndex: task.participantIndex,
    trialCount: task.trialCount,
  });
  return {
    mode: mode.name,
    mode_description: mode.description,
    seed: task.seed,
    participant_index: task.participantIndex,
    study_id: trials[0]?.study_id ?? `NULL_${mode.name}_${task.seed}_${task.participantIndex}`,
    ...estimate(trials),
  };
}

function parseArgs(argv) {
  const args = {
    participantsPerCell: 30,
    seeds: ["seed01", "seed02", "seed03", "seed04"],
    workers: Math.max(1, Math.min(4, cpus().length - 1)),
    trialCount: TOTAL_TRIALS,
    skipVerify: false,
    reuseEstimates: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--participants-per-cell") args.participantsPerCell = Number(argv[++i]);
    else if (arg === "--seeds") args.seeds = String(argv[++i]).split(",").map((value) => value.trim()).filter(Boolean);
    else if (arg === "--workers") args.workers = Number(argv[++i]);
    else if (arg === "--trial-count") args.trialCount = Number(argv[++i]);
    else if (arg === "--skip-verify") args.skipVerify = true;
    else if (arg === "--reuse-estimates") args.reuseEstimates = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/power-null-calibration.mjs [--participants-per-cell 30] [--seeds seed01,seed02] [--workers 4] [--trial-count 240] [--skip-verify] [--reuse-estimates]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(args.participantsPerCell) || args.participantsPerCell < 1) throw new Error("participants-per-cell 必须是正整数");
  if (!Number.isInteger(args.workers) || args.workers < 1) throw new Error("workers 必须是正整数");
  if (!Number.isInteger(args.trialCount) || args.trialCount < 1 || args.trialCount > TOTAL_TRIALS) throw new Error(`trial-count 必须在 1–${TOTAL_TRIALS} 之间`);
  return args;
}

function splitIntoChunks(items, count) {
  const chunks = Array.from({ length: Math.min(count, items.length) }, () => []);
  items.forEach((item, index) => chunks[index % chunks.length].push(item));
  return chunks.filter((chunk) => chunk.length);
}

function runParallel(tasks, options) {
  const chunks = splitIntoChunks(tasks, options.workers);
  if (chunks.length === 1) {
    return Promise.resolve(tasks.map((task) => runOne(task)));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const allRows = [];
    let completed = 0;
    let finishedWorkers = 0;
    let failed = false;
    for (const chunk of chunks) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { tasks: chunk, trialCount: options.trialCount },
      });
      worker.on("message", (message) => {
        if (message.type === "progress") {
          completed += message.count;
          if (completed % 25 === 0 || completed === tasks.length) {
            console.log(`null calibration progress: ${completed}/${tasks.length}`);
          }
        } else if (message.type === "done") {
          allRows.push(...message.rows);
          finishedWorkers += 1;
          if (finishedWorkers === chunks.length) resolvePromise(allRows);
        }
      });
      worker.on("error", (error) => {
        if (!failed) {
          failed = true;
          rejectPromise(error);
        }
      });
    }
  });
}

async function verifyAgainstAnalyzer() {
  const verifyMode = MODE_DEFINITIONS[0];
  const trials = makeTrials({ mode: verifyMode, seed: "verification", participantIndex: 0 });
  const inputPath = resolve(OUTPUT_DIR, "verification_input.csv");
  const outputPath = resolve(OUTPUT_DIR, "verification_reference.csv");
  const columns = [
    "study_id", "companion_ordinal", "companion_action", "companion_display_points",
    "participant_route_action", "participant_action", "normalized_payoff", "game_key",
    "bot_level", "created_at",
  ];
  writeFileSync(inputPath, toCsv(trials, columns), "utf8");
  execFileSync(process.execPath, [ANALYZER, inputPath, outputPath], {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
  });
  const reference = parseCsv(readFileSync(outputPath, "utf8"))[0];
  const own = estimate(trials);
  const numericFields = [
    "alpha_social", "alpha_self", ...SOCIAL_FIELDS, "beta_self", "beta_choice",
    "choice_persistence", "penalized_log_likelihood",
  ];
  const differences = Object.fromEntries(numericFields.map((field) => [
    field,
    Math.abs(Number(reference[field]) - Number(own[field])),
  ]));
  const maxAbsDiff = Math.max(...Object.values(differences));
  return {
    inputPath,
    outputPath,
    max_abs_difference: maxAbsDiff,
    differences,
    own,
    reference,
    pass: maxAbsDiff < 1e-7,
  };
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function summarizeField(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  return {
    n: values.length,
    mean: mean(values),
    sd: sd(values),
    median: quantile(values, 0.5),
    q95: quantile(values, 0.95),
    q99: quantile(values, 0.99),
    min: Math.min(...values),
    max: Math.max(...values),
    proportion_gt_0: values.filter((value) => value > 0).length / values.length,
    proportion_gt_0_25: values.filter((value) => value > 0.25).length / values.length,
    proportion_gt_0_5: values.filter((value) => value > 0.5).length / values.length,
    proportion_gt_1: values.filter((value) => value > 1).length / values.length,
  };
}

function summarizeRows(rows) {
  return Object.fromEntries(SOCIAL_FIELDS.map((field) => [field, summarizeField(rows, field)]));
}

function bootstrapQuantileUncertainty(rows, field, replicates = 2000, seed = "bootstrap") {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  if (values.length < 2) return null;
  const random = seededRandom(`${seed}:${field}:${values.length}`);
  const q95 = [];
  const q99 = [];
  const gt0 = [];
  const gt05 = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const sample = new Array(values.length);
    let countGt0 = 0;
    let countGt05 = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[Math.floor(random() * values.length)];
      sample[index] = value;
      if (value > 0) countGt0 += 1;
      if (value > 0.5) countGt05 += 1;
    }
    sample.sort((a, b) => a - b);
    q95.push(sample[Math.min(sample.length - 1, Math.floor(0.95 * (sample.length - 1)))]);
    q99.push(sample[Math.min(sample.length - 1, Math.floor(0.99 * (sample.length - 1)))]);
    gt0.push(countGt0 / values.length);
    gt05.push(countGt05 / values.length);
  }
  return {
    method: "participant bootstrap with replacement",
    replicates,
    q95_ci: [quantile(q95, 0.025), quantile(q95, 0.975)],
    q99_ci: [quantile(q99, 0.025), quantile(q99, 0.975)],
    proportion_gt_0_ci: [quantile(gt0, 0.025), quantile(gt0, 0.975)],
    proportion_gt_0_5_ci: [quantile(gt05, 0.025), quantile(gt05, 0.975)],
  };
}

function countValues(rows, field) {
  return rows.reduce((counts, row) => {
    counts[row[field]] = (counts[row[field]] ?? 0) + 1;
    return counts;
  }, {});
}

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "NA";
}

function makeReport({ options, rows, summary, verification, command }) {
  const primary = summary.pooled[PRIMARY_FIELD];
  const high = summary.pooled.beta_social_high;
  const monteCarlo = summary.pooled_monte_carlo ?? {};
  const primaryMonteCarlo = monteCarlo[PRIMARY_FIELD];
  const highMonteCarlo = monteCarlo.beta_social_high;
  const formatInterval = (interval) => interval ? `[${fmt(interval[0])}, ${fmt(interval[1])}]` : "NA";
  const modeRows = Object.entries(summary.by_mode).map(([mode, value]) => {
    const field = value[PRIMARY_FIELD];
    return `| ${mode} | ${field.n} | ${fmt(field.mean)} | ${fmt(field.median)} | ${fmt(field.q95)} | ${fmt(field.q99)} | ${(100 * field.proportion_gt_0).toFixed(1)}% | ${(100 * field.proportion_gt_0_5).toFixed(1)}% | ${value.quality_flag_counts.ok ?? 0}/${field.n} |`;
  }).join("\n");
  const pooledRows = [
    `| beta_social_low | ${primary.n} | ${fmt(primary.mean)} | ${fmt(primary.sd)} | ${fmt(primary.median)} | ${fmt(primary.q95)} | ${fmt(primary.q99)} | ${(100 * primary.proportion_gt_0).toFixed(1)}% | ${(100 * primary.proportion_gt_0_25).toFixed(1)}% | ${(100 * primary.proportion_gt_0_5).toFixed(1)}% | ${(100 * primary.proportion_gt_1).toFixed(1)}% |`,
    `| beta_social_high | ${high.n} | ${fmt(high.mean)} | ${fmt(high.sd)} | ${fmt(high.median)} | ${fmt(high.q95)} | ${fmt(high.q99)} | ${(100 * high.proportion_gt_0).toFixed(1)}% | ${(100 * high.proportion_gt_0_25).toFixed(1)}% | ${(100 * high.proportion_gt_0_5).toFixed(1)}% | ${(100 * high.proportion_gt_1).toFixed(1)}% |`,
  ].join("\n");
  const verificationLine = verification
    ? `CLI 一致性校验：${verification.pass ? "通过" : "未通过"}；最大绝对误差 ${verification.max_abs_difference.toExponential(3)}（参考输出保存在 ${verification.outputPath}）。`
    : "CLI 一致性校验：本次使用 `--skip-verify` 跳过。";

  return `# Null calibration of analyze-social-beta

日期：${new Date().toISOString()}

## 结论

本轮共模拟 ${rows.length} 名无社会学习、无自我收益敏感性的被试；每人 ${options.trialCount} 条记录，包含 ${options.seeds.length} 个随机种子和 ${MODE_DEFINITIONS.length} 种零假设行为。同行记录仍按服务器当前的四博弈、A–H 条件、low/high bot 和 companion route 递推生成，未连接 3000 端口、未读写正式 SQLite 数据库。

在这组零假设中，估计器输出的 beta_social_low pooled 经验分布为均值 ${fmt(primary.mean)}、SD ${fmt(primary.sd)}、中位数 ${fmt(primary.median)}、95 百分位 ${fmt(primary.q95)}、99 百分位 ${fmt(primary.q99)}；beta_social_high 的 95/99 百分位为 ${fmt(high.q95)}/${fmt(high.q99)}。下表的“>0”是把点估计正值当作检测标准时的描述性假阳性率，不是模型 p 值。

## Pooled null distribution and descriptive false-positive rates

| 指标 | N | 均值 | SD | 中位数 | 95% | 99% | >0 | >0.25 | >0.5 | >1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${pooledRows}

经验一侧阈值建议只在同一数据结构、同一估计器和同一质量筛选规则下使用：若预注册的阳性方向是 beta_social_low，本轮可把 ${fmt(primary.q95)} 作为约 5% 经验上侧阈值、${fmt(primary.q99)} 作为约 1% 经验上侧阈值。它们不能替代正式标准误、置信区间或层级模型检验。

## Monte Carlo uncertainty of empirical thresholds

以下区间是对 ${rows.length} 名模拟被试做 2,000 次 participant bootstrap（有放回重抽）得到的 95% 区间，表示有限模拟量下分位数/比例的 Monte Carlo 不确定性；不是正式研究参数的置信区间。

| 指标 | q95 bootstrap 95% 区间 | q99 bootstrap 95% 区间 | P(>0) bootstrap 95% 区间 | P(>0.5) bootstrap 95% 区间 |
|---|---|---|---|---|
| beta_social_low | ${formatInterval(primaryMonteCarlo?.q95_ci)} | ${formatInterval(primaryMonteCarlo?.q99_ci)} | ${formatInterval(primaryMonteCarlo?.proportion_gt_0_ci)} | ${formatInterval(primaryMonteCarlo?.proportion_gt_0_5_ci)} |
| beta_social_high | ${formatInterval(highMonteCarlo?.q95_ci)} | ${formatInterval(highMonteCarlo?.q99_ci)} | ${formatInterval(highMonteCarlo?.proportion_gt_0_ci)} | ${formatInterval(highMonteCarlo?.proportion_gt_0_5_ci)} |

## Null behavior cells

| 零假设模式 | N | 均值 | 中位数 | 95% | 99% | >0 | >0.5 | quality=ok |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${modeRows}

模式定义：

${MODE_DEFINITIONS.map((mode) => `- ${mode.name}：${mode.description}`).join("\n")}

所有主体都是纯零假设：固定合作率、随机游走和惯性只改变与社会/自我证据无关的行为生成过程；没有任何模式使用 ds 或 dp 生成参与者选择。

## Estimator reproduction

${verificationLine}

复刻的关键细节包括：alpha_social/alpha_self 的 7×7 网格、社会 Q 和自我 Q 的重置时点、13 列设计矩阵、L2 penalty=0.7、2600 步 Adam 更新、步长 0.025、每 100 步的停止规则和 quality_flag = (n_trials >= 200 ? ok : low_trial_count)。本实现把矩阵展平为 typed array 以减少分配；没有降低估计网格或改变停止条件。

## Run and files

完整估计生成命令（每名被试均重新拟合）：

PowerShell command:
node scripts/power-null-calibration.mjs --participants-per-cell ${options.participantsPerCell} --seeds ${options.seeds.join(",")} --workers ${options.workers} --trial-count ${options.trialCount}

本次报告写入命令：

PowerShell command:
${command}


- [power-null-calibration.mjs](../../../scripts/power-null-calibration.mjs)：独立零假设生成、估计和汇总脚本。
- [null_estimates.csv](null_estimates.csv)：每名模拟被试的估计结果和质量标记。
- [null_summary.json](null_summary.json)：pooled、按模式和按 seed 的完整数值汇总。
- [verification.json](verification.json)：与既有 CLI 的数值一致性校验。
- [verification_input.csv](verification_input.csv)、[verification_reference.csv](verification_reference.csv)：校验用的一名被试及 CLI 参考输出。

## Interpretation and limitations

1. 在没有真社会学习的情况下，单个 240-trial 被试的 beta_social 点估计仍可能为正；因此“估计值 > 0”不是安全的发现标准，最好使用上面的经验阈值或正式模型的不确定性。
2. 这里的阈值是按 null calibration 定义的，未包含多重终点、事后挑选博弈分层、缺失/超时、非独立被试、模型误设或正式样本的筛选损耗。若正式分析改变 trials、α 网格、lambda、质量规则或终点，应重新校准。
3. 同行记录采用服务器当前的独立 companion 递推，route action 和 display payoff 也按服务器种子生成；这反映研究设计，但不覆盖真实参与者可能改变服务器状态的异常行为。
4. random-walk 和 inertia 是比 iid 更保守的随机基线，却仍不是全部人类噪声模型。它们可能通过时间序列结构与 previousChoice 等非社会协变量发生关联；这正是将其单独报告的原因。
5. 本报告只回答零假设下的假阳性校准，不回答一个给定真实 beta_social 的检出率/功效；阳性生成—恢复和样本量曲线需要与本报告配套解读。
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const command = [
    "node scripts/power-null-calibration.mjs",
    `--participants-per-cell ${options.participantsPerCell}`,
    `--seeds ${options.seeds.join(",")}`,
    `--workers ${options.workers}`,
    `--trial-count ${options.trialCount}`,
    ...(options.reuseEstimates ? ["--reuse-estimates"] : []),
  ].join(" ");

  let verification = null;
  if (!options.skipVerify) {
    console.log("running one-person analyzer consistency check...");
    verification = await verifyAgainstAnalyzer();
    writeFileSync(resolve(OUTPUT_DIR, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
    console.log(`analyzer consistency: ${verification.pass ? "pass" : "FAIL"}, max abs diff=${verification.max_abs_difference}`);
    if (!verification.pass) throw new Error(`复刻估计器与 analyze-social-beta.mjs 不一致：${verification.max_abs_difference}`);
  }

  let rows;
  if (options.reuseEstimates) {
    const estimatesPath = resolve(OUTPUT_DIR, "null_estimates.csv");
    rows = parseCsv(readFileSync(estimatesPath, "utf8"));
    if (!rows.length) throw new Error(`--reuse-estimates 找不到有效结果：${estimatesPath}`);
    console.log(`reusing ${rows.length} existing estimates from ${estimatesPath}`);
  } else {
    const tasks = [];
    for (const mode of MODE_DEFINITIONS) {
      for (const seed of options.seeds) {
        for (let participantIndex = 0; participantIndex < options.participantsPerCell; participantIndex += 1) {
          tasks.push({ mode: mode.name, seed, participantIndex, trialCount: options.trialCount });
        }
      }
    }
    console.log(`simulating ${tasks.length} null participants (${options.trialCount} trials each) with ${Math.min(options.workers, tasks.length)} worker(s)...`);
    rows = await runParallel(tasks, options);
  }
  rows.sort((a, b) => `${a.mode}:${a.seed}:${String(a.participant_index).padStart(4, "0")}`.localeCompare(`${b.mode}:${b.seed}:${String(b.participant_index).padStart(4, "0")}`));

  const quality = countValues(rows, "quality_flag");
  const pooled = summarizeRows(rows);
  const pooledMonteCarlo = Object.fromEntries(
    ["beta_social_low", "beta_social_high"].map((field) => [
      field,
      bootstrapQuantileUncertainty(rows, field, 2000, "null-calibration-bootstrap"),
    ]),
  );
  const byMode = {};
  for (const mode of MODE_DEFINITIONS) {
    const modeRows = rows.filter((row) => row.mode === mode.name);
    byMode[mode.name] = {
      ...summarizeRows(modeRows),
      quality_flag_counts: countValues(modeRows, "quality_flag"),
    };
  }
  const bySeed = {};
  for (const seed of options.seeds) {
    const seedRows = rows.filter((row) => row.seed === seed);
    bySeed[seed] = {
      ...summarizeRows(seedRows),
      quality_flag_counts: countValues(seedRows, "quality_flag"),
    };
  }
  const summary = {
    generated_at: new Date().toISOString(),
    options,
    modes: MODE_DEFINITIONS,
    n_participants: rows.length,
    n_trials_total: rows.reduce((sum, row) => sum + Number(row.n_trials), 0),
    quality_flag_counts: quality,
    pooled,
    pooled_monte_carlo: pooledMonteCarlo,
    by_mode: byMode,
    by_seed: bySeed,
  };

  const columns = [
    "mode", "mode_description", "seed", "participant_index", "study_id", "n_trials",
    "alpha_social", "alpha_self", ...SOCIAL_FIELDS, "beta_self", "beta_choice",
    "choice_persistence", "penalized_log_likelihood", "optimizer_steps", "quality_flag",
  ];
  writeFileSync(resolve(OUTPUT_DIR, "null_estimates.csv"), toCsv(rows, columns), "utf8");
  writeFileSync(resolve(OUTPUT_DIR, "null_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const report = makeReport({ options, rows, summary: { pooled, pooled_monte_carlo: pooledMonteCarlo, by_mode: byMode }, verification, command });
  writeFileSync(resolve(OUTPUT_DIR, "report.md"), report, "utf8");
  console.log(JSON.stringify({
    outputDir: OUTPUT_DIR,
    participants: rows.length,
    trialsPerParticipant: options.trialCount,
    quality,
    betaSocialLow: pooled[PRIMARY_FIELD],
  }, null, 2));
}

if (!isMainThread) {
  const rows = [];
  let reported = 0;
  for (let index = 0; index < workerData.tasks.length; index += 1) {
    rows.push(runOne(workerData.tasks[index]));
    if ((index + 1) % 5 === 0 || index + 1 === workerData.tasks.length) {
      const delta = index + 1 - reported;
      reported = index + 1;
      parentPort.postMessage({ type: "progress", count: delta });
    }
  }
  parentPort.postMessage({ type: "done", rows });
} else {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
