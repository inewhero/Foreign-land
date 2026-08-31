#!/usr/bin/env node

/*
 * Monte-Carlo parameter-recovery and power grid for the "异域同行" choice
 * experiment.
 *
 * The generator below intentionally mirrors server/experiment.ts and the
 * design matrix in scripts/analyze-social-beta.mjs.  It is kept self
 * contained so that a large grid does not require starting the server, using
 * SQLite, or opening port 3000.
 *
 * Primary estimates use the same (known) learning-rate values as the data
 * generator and a Newton fit of the same penalised logistic likelihood.  The
 * existing 7 x 7 learning-rate search / Adam optimiser is run on a small,
 * explicitly labelled calibration subset.  This makes the large Monte-Carlo
 * grid reproducible without pretending that an acceleration is the exact
 * production estimator.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUTPUT_DIR = resolve("output/power/power_grid");
const TRIAL_GRID = [64, 128, 240, 480];
// Values through 1.5 are included so that a strong baseline (1.0) can also
// receive the +0.25/+0.5 intervention shifts without silently dropping a
// power cell.  The named recovery levels remain 0/.25/.5/1.
const TRUE_BETAS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
const REPORT_BETAS = [0, 0.25, 0.5, 1];
const RANK_BETAS = [0, 0.25, 0.5, 1];
const N_TOTALS = [20, 40, 60, 80, 120, 160];
const EFFECT_SIZES = [0, 0.25, 0.5];
const RECOVERY_REPS = 500;
const POWER_REPS = 500;
const CALIBRATION_REPS = 4;
const ALPHA_SOCIAL_TRUE = 0.35;
const ALPHA_SELF_TRUE = 0.30;
const LAMBDA = 0.7;
const SIG_Z_95 = 1.959963984540054;
const SIG_Z_90_ONE_SIDED = 1.6448536269514722;
const ANALYZER_ALPHA_GRID = [0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9];

const argv = new Set(process.argv.slice(2));
const numericArg = (name, fallback) => {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  if (!value) return fallback;
  const parsed = Number(value.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
const recoveryReps = numericArg("reps", RECOVERY_REPS);
const powerReps = numericArg("power-reps", POWER_REPS);
const calibrationReps = numericArg("calibration-reps", CALIBRATION_REPS);
const baseSeed = process.argv.find((arg) => arg.startsWith("--seed="))?.slice(7) ?? "power-grid-2026-08-30";
const skipFullGrid = argv.has("--skip-full-grid");

const sigmoid = (value) => {
  if (value >= 0) {
    const e = Math.exp(-Math.min(700, value));
    return 1 / (1 + e);
  }
  const e = Math.exp(Math.max(-700, value));
  return e / (1 + e);
};
const actionSign = (action) => action === "cooperate" ? 1 : -1;
const rewardValue = (points) => (Number(points) - 20) / 20;
const otherAction = (action) => action === "cooperate" ? "betray" : "cooperate";

function stableIndex(value, modulo) {
  const hash = createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) % modulo;
}

function seededRandom(seed) {
  let state = stableIndex(`${seed}:rng`, 0x1_0000_0000);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const GAMES = {
  pd: makeGame("pd", -0.4, 0.4),
  stag: makeGame("stag", 0.4, 0.4),
  snow: makeGame("snow", -0.4, -0.4),
  harmony: makeGame("harmony", 0.4, -0.4),
};

function makeGame(key, a, b) {
  const normalized = [[1, -b], [1 - a, 0]];
  const displayed = normalized.map((row) => row.map((value) => Math.round(20 * value + 20)));
  return { key, a, b, normalized, displayed };
}

// This is the Williams sequence in server/experiment.ts.  The four reversed
// entries are written out to avoid mutating an earlier array by .reverse().
const WILLIAMS = [
  ["pd", "stag", "harmony", "snow"],
  ["stag", "snow", "pd", "harmony"],
  ["snow", "harmony", "stag", "pd"],
  ["harmony", "pd", "snow", "stag"],
  ["pd", "stag", "harmony", "snow"],
  ["stag", "snow", "pd", "harmony"],
  ["snow", "harmony", "stag", "pd"],
  ["harmony", "pd", "snow", "stag"],
];

function buildConditions(studyId, formCode = "A") {
  const sequenceIndex = stableIndex(`${studyId}:${formCode}:sequence`, WILLIAMS.length);
  const games = WILLIAMS[sequenceIndex];
  const lowFirst = stableIndex(`${studyId}:${formCode}:bot-order`, 2) === 0;
  return games.flatMap((game, macroBlock) => {
    const levels = (macroBlock + (lowFirst ? 0 : 1)) % 2 === 0
      ? ["low", "high"]
      : ["high", "low"];
    return levels.map((botLevel, withinBlock) => ({
      macroBlock,
      game,
      companionOrdinal: macroBlock * 2 + withinBlock,
      botLevel,
      high: botLevel === "high" ? 1 : 0,
    }));
  });
}

function participantPayoff(game, participant, companion) {
  const row = participant === "cooperate" ? 0 : 1;
  const column = companion === "cooperate" ? 0 : 1;
  return {
    normalized: GAMES[game].normalized[row][column],
    displayed: GAMES[game].displayed[row][column],
  };
}

function chooseCompanionAction({ game, level, previousParticipant, previousCompanion, draw }) {
  if (!previousParticipant || !previousCompanion) {
    return { action: draw < 0.5 ? "cooperate" : "betray", switchProbability: 0.5, deltaPayoff: 0 };
  }
  const matrix = GAMES[game].normalized;
  const current = previousCompanion === "cooperate" ? 0 : 1;
  const alternative = current === 0 ? 1 : 0;
  const participant = previousParticipant === "cooperate" ? 0 : 1;
  const deltaPayoff = matrix[alternative][participant] - matrix[current][participant];
  const botBeta = level === "high" ? 8 : 2;
  const switchProbability = sigmoid(botBeta * deltaPayoff);
  return {
    action: draw < switchProbability ? otherAction(previousCompanion) : previousCompanion,
    switchProbability,
    deltaPayoff,
  };
}

/*
 * Simulate a balanced experiment.  The server currently has 30 trials per
 * companion (240 total).  The grid uses 8/16/30/60 per companion, giving
 * 64/128/240/480 total trials.  The 480 condition is an explicitly marked
 * extension of the same design, not a claim that the current server already
 * serves 480 trials.
 */
function simulateParticipant({ studyId, nTrials, betaSocial, betaSelf = 0.75, betaChoice = 0.12, persistence = 0.18, intercept = -0.15 }) {
  if (nTrials % 8 !== 0) throw new Error(`nTrials must be divisible by 8: ${nTrials}`);
  const perCondition = nTrials / 8;
  const conditions = buildConditions(studyId, "A");
  const random = seededRandom(`${baseSeed}:${studyId}:${nTrials}:${betaSocial}`);
  const rows = [];
  let socialQ = [0, 0];
  let selfQ = [0, 0];
  let previousChoice = 0;
  let previousMacro = -1;

  for (const condition of conditions) {
    // The server resets both demonstration-history fields at each new
    // companion; the estimator's previousChoice is the participant's own
    // previous action and is reset at each macro block.
    socialQ = [0, 0];
    let previousParticipantForCompanion;
    let previousCompanion;
    if (condition.macroBlock !== previousMacro) {
      selfQ = [0, 0];
      previousChoice = 0;
      previousMacro = condition.macroBlock;
    }

    for (let trialWithinCondition = 0; trialWithinCondition < perCondition; trialWithinCondition += 1) {
      const companion = chooseCompanionAction({
        game: condition.game,
        level: condition.botLevel,
        previousParticipant: previousParticipantForCompanion,
        previousCompanion,
        draw: random(),
      });
      const companionRouteAction = random() < 0.5 ? "cooperate" : "betray";
      const participantRouteAction = random() < 0.5 ? "cooperate" : "betray";
      const companionPayoff = participantPayoff(condition.game, companion.action, companionRouteAction);

      // Match analyzer buildDesign: update social evidence before the choice.
      const observedIndex = companion.action === "cooperate" ? 0 : 1;
      socialQ[observedIndex] += ALPHA_SOCIAL_TRUE * (rewardValue(companionPayoff.displayed) - socialQ[observedIndex]);
      const ds = socialQ[0] - socialQ[1];
      const dp = selfQ[0] - selfQ[1];
      const probabilityCooperate = sigmoid(
        intercept
        + betaSocial * ds
        + betaSelf * dp
        + betaChoice * actionSign(companion.action)
        + persistence * previousChoice,
      );
      const participantAction = random() < probabilityCooperate ? "cooperate" : "betray";
      const payoff = participantPayoff(condition.game, participantAction, participantRouteAction);

      rows.push({
        macro_block: condition.macroBlock,
        game_key: condition.game,
        companion_ordinal: condition.companionOrdinal,
        bot_level: condition.botLevel,
        companion_action: companion.action,
        companion_route_action: companionRouteAction,
        companion_display_points: companionPayoff.displayed,
        participant_action: participantAction,
        participant_route_action: participantRouteAction,
        normalized_payoff: payoff.normalized,
        display_points: payoff.displayed,
        ds_true: ds,
        dp_true: dp,
        probability_cooperate: probabilityCooperate,
        switch_probability: companion.switchProbability,
      });

      const ownIndex = participantAction === "cooperate" ? 0 : 1;
      selfQ[ownIndex] += ALPHA_SELF_TRUE * (payoff.normalized - selfQ[ownIndex]);
      previousChoice = actionSign(participantAction);
      previousParticipantForCompanion = companionRouteAction;
      previousCompanion = companion.action;
    }
  }
  return rows;
}

function buildDesign(trials, alphaSocial, alphaSelf) {
  const x = [];
  const y = [];
  let socialQ = [0, 0];
  let selfQ = [0, 0];
  let previousChoice = 0;
  let previousCompanion = null;
  let previousGame = null;
  for (const trial of trials) {
    if (trial.companion_ordinal !== previousCompanion) socialQ = [0, 0];
    if (trial.game_key !== previousGame) {
      selfQ = [0, 0];
      previousChoice = 0;
    }
    previousCompanion = trial.companion_ordinal;
    previousGame = trial.game_key;
    const observedIndex = trial.companion_action === "cooperate" ? 0 : 1;
    socialQ[observedIndex] += alphaSocial * (rewardValue(trial.companion_display_points) - socialQ[observedIndex]);
    const ds = socialQ[0] - socialQ[1];
    const dp = selfQ[0] - selfQ[1];
    const game = { pd: 0, stag: 1, snow: 2, harmony: 3 }[trial.game_key];
    const high = trial.bot_level === "high" ? 1 : 0;
    x.push([
      1,
      game === 1 ? 1 : 0,
      game === 2 ? 1 : 0,
      game === 3 ? 1 : 0,
      ds,
      game === 1 ? ds : 0,
      game === 2 ? ds : 0,
      game === 3 ? ds : 0,
      dp,
      actionSign(trial.companion_action),
      previousChoice,
      high,
      ds * high,
    ]);
    y.push(trial.participant_action === "cooperate" ? 1 : 0);
    const ownIndex = trial.participant_action === "cooperate" ? 0 : 1;
    selfQ[ownIndex] += alphaSelf * (Number(trial.normalized_payoff) - selfQ[ownIndex]);
    previousChoice = actionSign(trial.participant_action);
  }
  return { x, y };
}

function objectiveFor(x, y, weights, lambda = LAMBDA) {
  let objective = 0;
  for (let i = 0; i < x.length; i += 1) {
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(dot(x[i], weights))));
    objective += y[i] * Math.log(probability) + (1 - y[i]) * Math.log(1 - probability);
  }
  for (let j = 1; j < weights.length; j += 1) objective -= 0.5 * lambda * weights[j] ** 2;
  return objective;
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row) => row.slice());
  const b = vector.slice();
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-10) {
      a[pivot][column] += 1e-6;
      if (Math.abs(a[pivot][column]) < 1e-10) return Array(n).fill(0);
    }
    if (pivot !== column) {
      [a[pivot], a[column]] = [a[column], a[pivot]];
      [b[pivot], b[column]] = [b[column], b[pivot]];
    }
    const scale = a[column][column];
    for (let j = column; j < n; j += 1) a[column][j] /= scale;
    b[column] /= scale;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      if (factor === 0) continue;
      for (let j = column; j < n; j += 1) a[row][j] -= factor * a[column][j];
      b[row] -= factor * b[column];
    }
  }
  return b;
}

function inverseMatrix(matrix) {
  const n = matrix.length;
  const inverse = Array.from({ length: n }, () => Array(n).fill(0));
  for (let column = 0; column < n; column += 1) {
    const unit = Array(n).fill(0);
    unit[column] = 1;
    const solution = solveLinear(matrix, unit);
    for (let row = 0; row < n; row += 1) inverse[row][column] = solution[row];
  }
  return inverse;
}

function informationMatrix(x, y, weights, lambda = LAMBDA) {
  const p = weights.length;
  const info = Array.from({ length: p }, () => Array(p).fill(0));
  for (let i = 0; i < x.length; i += 1) {
    const probability = sigmoid(dot(x[i], weights));
    const variance = Math.max(1e-9, probability * (1 - probability));
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k <= j; k += 1) info[j][k] += variance * x[i][j] * x[i][k];
    }
  }
  for (let j = 0; j < p; j += 1) {
    for (let k = 0; k < j; k += 1) info[k][j] = info[j][k];
    if (j > 0) info[j][j] += lambda;
  }
  return info;
}

/* Fast primary fit: same likelihood, known learning rates, Newton updates. */
function fitNewton(x, y, lambda = LAMBDA) {
  const p = x[0].length;
  const weights = Array(p).fill(0);
  let objective = objectiveFor(x, y, weights, lambda);
  let iterations = 0;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    iterations = iteration + 1;
    const gradient = Array(p).fill(0);
    const info = Array.from({ length: p }, () => Array(p).fill(0));
    for (let i = 0; i < x.length; i += 1) {
      const probability = sigmoid(dot(x[i], weights));
      const variance = Math.max(1e-9, probability * (1 - probability));
      const error = y[i] - probability;
      for (let j = 0; j < p; j += 1) {
        gradient[j] += x[i][j] * error;
        for (let k = 0; k <= j; k += 1) info[j][k] += variance * x[i][j] * x[i][k];
      }
    }
    for (let j = 1; j < p; j += 1) {
      gradient[j] -= lambda * weights[j];
      info[j][j] += lambda;
    }
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < j; k += 1) info[k][j] = info[j][k];
    }
    const step = solveLinear(info, gradient);
    const stepNorm = Math.sqrt(step.reduce((sum, value) => sum + value * value, 0));
    let scale = 1;
    let candidate = weights.map((value, index) => value + step[index]);
    let candidateObjective = objectiveFor(x, y, candidate, lambda);
    while (candidateObjective < objective && scale > 1 / 128) {
      scale /= 2;
      candidate = weights.map((value, index) => value + scale * step[index]);
      candidateObjective = objectiveFor(x, y, candidate, lambda);
    }
    for (let j = 0; j < p; j += 1) weights[j] = candidate[j];
    if (candidateObjective < objective - 1e-9) break;
    objective = candidateObjective;
    if (stepNorm * scale < 1e-6) break;
  }
  const info = informationMatrix(x, y, weights, lambda);
  const covariance = inverseMatrix(info);
  const se = Math.sqrt(Math.max(1e-12, covariance[4][4]));
  return { weights, objective, seSocial: se, iterations };
}

/* Exact optimiser shape used in analyze-social-beta.mjs, for calibration. */
function fitAdam(x, y, lambda = LAMBDA) {
  const p = x[0].length;
  const weights = Array(p).fill(0);
  const m = Array(p).fill(0);
  const v = Array(p).fill(0);
  let lastObjective = -Infinity;
  let iterations = 0;
  for (let step = 1; step <= 2600; step += 1) {
    iterations = step;
    const gradient = Array(p).fill(0);
    let objective = 0;
    for (let i = 0; i < x.length; i += 1) {
      const probability = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(dot(x[i], weights))));
      const error = y[i] - probability;
      objective += y[i] * Math.log(probability) + (1 - y[i]) * Math.log(1 - probability);
      for (let j = 0; j < p; j += 1) gradient[j] += x[i][j] * error;
    }
    for (let j = 1; j < p; j += 1) {
      gradient[j] -= lambda * weights[j];
      objective -= 0.5 * lambda * weights[j] ** 2;
    }
    for (let j = 0; j < p; j += 1) {
      const g = gradient[j] / x.length;
      m[j] = 0.9 * m[j] + 0.1 * g;
      v[j] = 0.999 * v[j] + 0.001 * g * g;
      const mHat = m[j] / (1 - 0.9 ** step);
      const vHat = v[j] / (1 - 0.999 ** step);
      weights[j] += 0.025 * mHat / (Math.sqrt(vHat) + 1e-8);
    }
    if (step % 100 === 0 && Math.abs(objective - lastObjective) < 1e-7) break;
    if (step % 100 === 0) lastObjective = objective;
  }
  return { weights, objective: objectiveFor(x, y, weights, lambda), iterations };
}

function estimateFast(trials) {
  const design = buildDesign(trials, ALPHA_SOCIAL_TRUE, ALPHA_SELF_TRUE);
  const fit = fitNewton(design.x, design.y);
  return {
    n_trials: trials.length,
    alpha_social: ALPHA_SOCIAL_TRUE,
    alpha_self: ALPHA_SELF_TRUE,
    beta_social: fit.weights[4],
    beta_social_high: fit.weights[4] + fit.weights[12],
    beta_self: fit.weights[8],
    beta_choice: fit.weights[9],
    choice_persistence: fit.weights[10],
    se_social: fit.seSocial,
    z_social: fit.weights[4] / fit.seSocial,
    objective: fit.objective,
    iterations: fit.iterations,
  };
}

function estimateFullGrid(trials) {
  let best = null;
  for (const alphaSocial of ANALYZER_ALPHA_GRID) {
    for (const alphaSelf of ANALYZER_ALPHA_GRID) {
      const design = buildDesign(trials, alphaSocial, alphaSelf);
      const fit = fitAdam(design.x, design.y);
      if (!best || fit.objective > best.objective) {
        best = { ...fit, alphaSocial, alphaSelf };
      }
    }
  }
  const weights = best.weights;
  return {
    alpha_social: best.alphaSocial,
    alpha_self: best.alphaSelf,
    beta_social_low: weights[4],
    beta_social_high: weights[4] + weights[12],
    beta_self: weights[8],
    beta_choice: weights[9],
    choice_persistence: weights[10],
    objective: best.objective,
    iterations: best.iterations,
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function variance(values) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

function sd(values) {
  return Math.sqrt(Math.max(0, variance(values)));
}

function quantile(values, probability) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  return `"${String(value).replaceAll('"', '""')}"`;
}

function writeCsv(fileName, rows, columns = rows.length ? Object.keys(rows[0]) : []) {
  const text = `\uFEFF${columns.map(csvCell).join(",")}\n${rows
    .map((row) => columns.map((column) => csvCell(row[column])).join(","))
    .join("\n")}\n`;
  const path = resolve(OUTPUT_DIR, fileName);
  writeFileSync(path, text, "utf8");
  return path;
}

function labelForBeta(beta) {
  if (beta === 0) return "random-social-null";
  if (beta === 0.25) return "weak";
  if (beta === 0.5) return "medium";
  if (beta === 0.75) return "intermediate";
  if (beta === 1) return "strong";
  if (beta === 1.25) return "very-strong";
  if (beta === 1.5) return "extreme";
  return "custom";
}

function recoverySummary(records, nTrials, betaSocial) {
  const estimates = records.map((record) => record.beta_hat);
  const detected = records.map((record) => record.detected_gt_random);
  const coverage = records.map((record) => record.coverage_95);
  const seValues = records.map((record) => record.se_social);
  const bias = mean(estimates) - betaSocial;
  const detectionRate = mean(detected);
  return {
    n_trials: nTrials,
    trials_per_companion: nTrials / 8,
    true_beta_social: betaSocial,
    beta_label: labelForBeta(betaSocial),
    n_mc: records.length,
    mean_beta_hat: mean(estimates),
    median_beta_hat: quantile(estimates, 0.5),
    sd_beta_hat: sd(estimates),
    bias,
    rmse: Math.sqrt(mean(estimates.map((value) => (value - betaSocial) ** 2))),
    mae: mean(estimates.map((value) => Math.abs(value - betaSocial))),
    q025_beta_hat: quantile(estimates, 0.025),
    q975_beta_hat: quantile(estimates, 0.975),
    mean_se_social: mean(seValues),
    coverage_95: mean(coverage),
    individual_detection_rate: detectionRate,
    mc_se_mean_beta_hat: sd(estimates) / Math.sqrt(records.length),
    mc_se_individual_detection_rate: Math.sqrt(Math.max(0, detectionRate * (1 - detectionRate)) / records.length),
    false_positive_rate_if_null: betaSocial === 0 ? detectionRate : null,
    mean_cooperate_rate: mean(records.map((record) => record.cooperate_rate)),
    mean_estimated_beta_self: mean(records.map((record) => record.beta_self_hat)),
    mean_estimated_beta_choice: mean(records.map((record) => record.beta_choice_hat)),
    mean_estimated_persistence: mean(records.map((record) => record.persistence_hat)),
  };
}

function rank(values) {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = Array(values.length);
  indexed.forEach((item, index) => { ranks[item.index] = index + 1; });
  return ranks;
}

function spearman(a, b) {
  if (a.length !== b.length || a.length < 2) return NaN;
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  const numerator = ra.reduce((sum, value, index) => sum + (value - ma) * (rb[index] - mb), 0);
  const denominator = Math.sqrt(
    ra.reduce((sum, value) => sum + (value - ma) ** 2, 0)
    * rb.reduce((sum, value) => sum + (value - mb) ** 2, 0),
  );
  return denominator > 0 ? numerator / denominator : 0;
}

function exactIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function pairwiseOrderAccuracy(truth, estimates) {
  let total = 0;
  let correct = 0;
  for (let i = 0; i < truth.length; i += 1) {
    for (let j = i + 1; j < truth.length; j += 1) {
      total += 1;
      if ((truth[j] - truth[i]) * (estimates[j] - estimates[i]) > 0) correct += 1;
    }
  }
  return total ? correct / total : NaN;
}

function sample(array, random) {
  return array[Math.min(array.length - 1, Math.floor(random() * array.length))];
}

function groupTest(control, treatment) {
  const controlMean = mean(control);
  const treatmentMean = mean(treatment);
  const se = Math.sqrt(Math.max(1e-12, variance(control) / control.length + variance(treatment) / treatment.length));
  return {
    estimate: treatmentMean - controlMean,
    z: (treatmentMean - controlMean) / se,
    reject: Math.abs((treatmentMean - controlMean) / se) >= SIG_Z_95,
  };
}

function pairedTest(pre, post) {
  const differences = post.map((value, index) => value - pre[index]);
  const sdDifference = sd(differences);
  const se = sdDifference / Math.sqrt(Math.max(1, differences.length));
  const z = mean(differences) / Math.max(1e-6, se);
  return { estimate: mean(differences), z, reject: Math.abs(z) >= SIG_Z_95 };
}

function findN80(rows, testName) {
  const eligible = rows.filter((row) => row.test === testName).sort((a, b) => a.n_total - b.n_total);
  return eligible.find((row) => row.power >= 0.8)?.n_total ?? null;
}

function formatNumber(value, digits = 3) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toFixed(digits);
}

function findRow(rows, predicate) {
  return rows.find(predicate);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const startedAt = new Date().toISOString();
console.log(JSON.stringify({
  message: "power-grid started",
  outputDir: OUTPUT_DIR,
  recoveryReps,
  powerReps,
  calibrationReps: skipFullGrid ? 0 : calibrationReps,
  trialGrid: TRIAL_GRID,
  trueBetas: TRUE_BETAS,
  nTotals: N_TOTALS,
}, null, 2));

const allIndividualRows = [];
const recoveryDistributions = new Map();
const recoveryRows = [];

for (const nTrials of TRIAL_GRID) {
  for (const betaSocial of TRUE_BETAS) {
    const records = [];
    const distribution = [];
    for (let rep = 0; rep < recoveryReps; rep += 1) {
      const studyId = `PG_${baseSeed}_${nTrials}_b${String(betaSocial).replace(".", "p")}_r${rep}`;
      const trials = simulateParticipant({ studyId, nTrials, betaSocial });
      const estimate = estimateFast(trials);
      const cooperateRate = trials.filter((trial) => trial.participant_action === "cooperate").length / trials.length;
      const record = {
        n_trials: nTrials,
        trials_per_companion: nTrials / 8,
        true_beta_social: betaSocial,
        beta_label: labelForBeta(betaSocial),
        rep,
        beta_hat: estimate.beta_social,
        beta_hat_high: estimate.beta_social_high,
        se_social: estimate.se_social,
        z_social: estimate.z_social,
        detected_gt_random: estimate.z_social > SIG_Z_90_ONE_SIDED ? 1 : 0,
        coverage_95: Math.abs(estimate.beta_social - betaSocial) <= SIG_Z_95 * estimate.se_social ? 1 : 0,
        beta_self_hat: estimate.beta_self,
        beta_choice_hat: estimate.beta_choice,
        persistence_hat: estimate.choice_persistence,
        cooperate_rate: cooperateRate,
        objective: estimate.objective,
        iterations: estimate.iterations,
        estimator: "fixed_true_alpha_newton",
      };
      records.push(record);
      distribution.push(record.beta_hat);
      allIndividualRows.push(record);
    }
    recoveryDistributions.set(`${nTrials}|${betaSocial}`, distribution);
    recoveryRows.push(recoverySummary(records, nTrials, betaSocial));
    console.log(JSON.stringify({ phase: "recovery", nTrials, betaSocial, reps: recoveryReps }));
  }
}

const recoveryPath = writeCsv("individual_estimates.csv", allIndividualRows, [
  "n_trials", "trials_per_companion", "true_beta_social", "beta_label", "rep",
  "beta_hat", "beta_hat_high", "se_social", "z_social", "detected_gt_random",
  "coverage_95", "beta_self_hat", "beta_choice_hat", "persistence_hat", "cooperate_rate",
  "objective", "iterations", "estimator",
]);
const recoverySummaryPath = writeCsv("individual_recovery.csv", recoveryRows, [
  "n_trials", "trials_per_companion", "true_beta_social", "beta_label", "n_mc",
  "mean_beta_hat", "median_beta_hat", "sd_beta_hat", "bias", "rmse", "mae",
  "q025_beta_hat", "q975_beta_hat", "mean_se_social", "coverage_95",
  "individual_detection_rate", "mc_se_mean_beta_hat", "mc_se_individual_detection_rate",
  "false_positive_rate_if_null", "mean_cooperate_rate",
  "mean_estimated_beta_self", "mean_estimated_beta_choice", "mean_estimated_persistence",
]);

const rankingRows = [];
for (const nTrials of TRIAL_GRID) {
  for (const nTotal of N_TOTALS) {
    const random = seededRandom(`${baseSeed}:ranking:${nTrials}:${nTotal}`);
    const spearmanValues = [];
    const exactValues = [];
    const pairwiseValues = [];
    const nPerBeta = nTotal / RANK_BETAS.length;
    for (let rep = 0; rep < powerReps; rep += 1) {
      const estimates = RANK_BETAS.map((beta) => {
        const distribution = recoveryDistributions.get(`${nTrials}|${beta}`);
        const cohort = Array.from({ length: nPerBeta }, () => sample(distribution, random));
        return mean(cohort);
      });
      spearmanValues.push(spearman(RANK_BETAS, estimates));
      exactValues.push(exactIncreasing(estimates) ? 1 : 0);
      pairwiseValues.push(pairwiseOrderAccuracy(RANK_BETAS, estimates));
    }
    rankingRows.push({
      n_trials: nTrials,
      trials_per_companion: nTrials / 8,
      n_total: nTotal,
      n_per_true_beta: nPerBeta,
      n_mc: powerReps,
      mean_spearman: mean(spearmanValues),
      exact_order_rate: mean(exactValues),
      pairwise_order_accuracy: mean(pairwiseValues),
      mc_se_mean_spearman: sd(spearmanValues) / Math.sqrt(powerReps),
      mc_se_exact_order_rate: Math.sqrt(Math.max(0, mean(exactValues) * (1 - mean(exactValues))) / powerReps),
      mc_se_pairwise_order_accuracy: sd(pairwiseValues) / Math.sqrt(powerReps),
    });
  }
}
const rankingPath = writeCsv("ranking_power.csv", rankingRows, [
  "n_trials", "trials_per_companion", "n_total", "n_per_true_beta", "n_mc",
  "mean_spearman", "exact_order_rate", "pairwise_order_accuracy", "mc_se_mean_spearman",
  "mc_se_exact_order_rate", "mc_se_pairwise_order_accuracy",
]);

const nEffectRows = [];
for (const nTrials of TRIAL_GRID) {
  for (const nTotal of N_TOTALS) {
    for (const betaSocial of REPORT_BETAS) {
      const summary = recoveryRows.find((row) => row.n_trials === nTrials && row.true_beta_social === betaSocial);
      nEffectRows.push({
        n_trials: nTrials,
        trials_per_companion: nTrials / 8,
        n_total: nTotal,
        true_beta_social: betaSocial,
        beta_label: labelForBeta(betaSocial),
        individual_detection_rate: summary.individual_detection_rate,
        expected_detected_people: nTotal * summary.individual_detection_rate,
        probability_at_least_one_detected: 1 - (1 - summary.individual_detection_rate) ** nTotal,
        note: "单人检出率不因N改变；N只改变可观察到的检出人数/至少一人事件概率",
      });
    }
  }
}
const nEffectPath = writeCsv("n_effects.csv", nEffectRows, [
  "n_trials", "trials_per_companion", "n_total", "true_beta_social", "beta_label",
  "individual_detection_rate", "expected_detected_people", "probability_at_least_one_detected", "note",
]);

const interventionRows = [];
for (const nTrials of TRIAL_GRID) {
  for (const baselineBeta of REPORT_BETAS) {
    for (const delta of EFFECT_SIZES) {
      const postBeta = baselineBeta + delta;
      if (!TRUE_BETAS.includes(postBeta)) continue;
      const baselineDistribution = recoveryDistributions.get(`${nTrials}|${baselineBeta}`);
      const postDistribution = recoveryDistributions.get(`${nTrials}|${postBeta}`);
      for (const nTotal of N_TOTALS) {
        const nPerArm = nTotal / 2;
        for (const test of ["independent_group", "paired_pre_post_conservative"]) {
          const random = seededRandom(`${baseSeed}:power:${test}:${nTrials}:${baselineBeta}:${delta}:${nTotal}`);
          let significant = 0;
          const estimates = [];
          for (let rep = 0; rep < powerReps; rep += 1) {
            const pre = Array.from({ length: nPerArm }, () => sample(baselineDistribution, random));
            const post = Array.from({ length: nPerArm }, () => sample(postDistribution, random));
            const result = test === "independent_group" ? groupTest(pre, post) : pairedTest(pre, post);
            if (result.reject) significant += 1;
            estimates.push(result.estimate);
          }
          interventionRows.push({
            n_trials: nTrials,
            trials_per_companion: nTrials / 8,
            baseline_beta_social: baselineBeta,
            baseline_beta_label: labelForBeta(baselineBeta),
            delta_beta_social: delta,
            post_beta_social: postBeta,
            n_total: nTotal,
            n_per_arm: nPerArm,
            test,
            n_mc: powerReps,
            power: significant / powerReps,
            mc_se_power: Math.sqrt(Math.max(0, (significant / powerReps) * (1 - significant / powerReps)) / powerReps),
            mean_estimated_effect: mean(estimates),
            empirical_sd_estimated_effect: sd(estimates),
            alpha: 0.05,
            decision: delta === 0 ? "type-I check" : "intervention effect",
          });
        }
      }
    }
  }
}
for (const row of interventionRows) {
  row.required_n80_same_cell = findN80(
    interventionRows.filter((candidate) => candidate.n_trials === row.n_trials
      && candidate.baseline_beta_social === row.baseline_beta_social
      && candidate.delta_beta_social === row.delta_beta_social),
    row.test,
  );
}
const interventionPath = writeCsv("intervention_power.csv", interventionRows, [
  "n_trials", "trials_per_companion", "baseline_beta_social", "baseline_beta_label",
  "delta_beta_social", "post_beta_social", "n_total", "n_per_arm", "test", "n_mc",
  "power", "mean_estimated_effect", "empirical_sd_estimated_effect", "alpha",
  "mc_se_power", "decision", "required_n80_same_cell",
]);

const calibrationRows = [];
if (!skipFullGrid) {
  for (const nTrials of TRIAL_GRID) {
    for (const betaSocial of [0, 0.5, 1]) {
      for (let rep = 0; rep < calibrationReps; rep += 1) {
        const studyId = `CAL_${baseSeed}_${nTrials}_b${String(betaSocial).replace(".", "p")}_r${rep}`;
        const trials = simulateParticipant({ studyId, nTrials, betaSocial });
        const fast = estimateFast(trials);
        const full = estimateFullGrid(trials);
        calibrationRows.push({
          n_trials: nTrials,
          trials_per_companion: nTrials / 8,
          true_beta_social: betaSocial,
          rep,
          fast_beta_social: fast.beta_social,
          fast_alpha_social: fast.alpha_social,
          fast_alpha_self: fast.alpha_self,
          full_grid_beta_social_low: full.beta_social_low,
          full_grid_beta_social_high: full.beta_social_high,
          full_grid_alpha_social: full.alpha_social,
          full_grid_alpha_self: full.alpha_self,
          full_grid_beta_self: full.beta_self,
          absolute_difference_low: Math.abs(fast.beta_social - full.beta_social_low),
          full_grid_objective: full.objective,
          full_grid_iterations: full.iterations,
          estimator_fast: "fixed_true_alpha_newton",
          estimator_reference: "analyze-social-beta-compatible-grid-adam",
        });
        console.log(JSON.stringify({ phase: "full-grid-calibration", nTrials, betaSocial, rep, calibrationReps }));
      }
    }
  }
}
const calibrationPath = writeCsv("full_grid_calibration.csv", calibrationRows, [
  "n_trials", "trials_per_companion", "true_beta_social", "rep", "fast_beta_social",
  "fast_alpha_social", "fast_alpha_self", "full_grid_beta_social_low", "full_grid_beta_social_high",
  "full_grid_alpha_social", "full_grid_alpha_self", "full_grid_beta_self", "absolute_difference_low",
  "full_grid_objective", "full_grid_iterations", "estimator_fast", "estimator_reference",
]);

const calibrationSummary = calibrationRows.length ? {
  n_rows: calibrationRows.length,
  mean_abs_difference_low: mean(calibrationRows.map((row) => row.absolute_difference_low)),
  median_abs_difference_low: quantile(calibrationRows.map((row) => row.absolute_difference_low), 0.5),
  mean_fast_beta: mean(calibrationRows.map((row) => row.fast_beta_social)),
  mean_full_grid_beta_low: mean(calibrationRows.map((row) => row.full_grid_beta_social_low)),
  full_grid_alpha_social_frequency: Object.fromEntries(ANALYZER_ALPHA_GRID.map((alpha) => [alpha, calibrationRows.filter((row) => row.full_grid_alpha_social === alpha).length])),
  full_grid_alpha_self_frequency: Object.fromEntries(ANALYZER_ALPHA_GRID.map((alpha) => [alpha, calibrationRows.filter((row) => row.full_grid_alpha_self === alpha).length])),
} : { n_rows: 0, skipped: true };

const n80Rows = [];
for (const nTrials of TRIAL_GRID) {
  for (const baselineBeta of REPORT_BETAS) {
    for (const delta of [0.25, 0.5]) {
      for (const test of ["independent_group", "paired_pre_post_conservative"]) {
        const eligible = interventionRows.filter((row) => row.n_trials === nTrials
          && row.baseline_beta_social === baselineBeta
          && row.delta_beta_social === delta
          && row.test === test).sort((a, b) => a.n_total - b.n_total);
        const first = eligible.find((row) => row.power >= 0.8);
        n80Rows.push({
          n_trials: nTrials,
          trials_per_companion: nTrials / 8,
          baseline_beta_social: baselineBeta,
          delta_beta_social: delta,
          test,
          required_n80: first?.n_total ?? null,
          power_at_max_n: eligible.at(-1)?.power ?? null,
          max_n_evaluated: eligible.at(-1)?.n_total ?? null,
          result: first ? "reached" : "not reached within evaluated N",
        });
      }
    }
  }
}
const n80Path = writeCsv("required_n80.csv", n80Rows, [
  "n_trials", "trials_per_companion", "baseline_beta_social", "delta_beta_social", "test",
  "required_n80", "power_at_max_n", "max_n_evaluated", "result",
]);

const keyRecovery = findRow(recoveryRows, (row) => row.n_trials === 240 && row.true_beta_social === 0.5);
const keyNull = findRow(recoveryRows, (row) => row.n_trials === 240 && row.true_beta_social === 0);
const keyStrong = findRow(recoveryRows, (row) => row.n_trials === 240 && row.true_beta_social === 1);
const keyRank = findRow(rankingRows, (row) => row.n_trials === 240 && row.n_total === 80);
const keyN80 = n80Rows.filter((row) => row.n_trials === 240 && row.baseline_beta_social === 0.5 && row.delta_beta_social === 0.5);

const reportLines = [
  "# 参数恢复与功效网格（pilot mock）",
  "",
  `生成时间：${new Date().toISOString()}。本次仅使用本地内存模拟，没有连接正式数据库、没有启动/触碰 3000 端口。`,
  "",
  "## 结论先行",
  "",
  `- 主要结果基于 ${recoveryReps} 次/恢复条件与 ${powerReps} 次/功效条件的 Monte Carlo；每人试次网格为 64、128、240、480（每个同行者分别 8、16、30、60 次）。480 是按现有 8 条件设计外推的压力测试。`,
  `- “随机”被定义为对社会证据不敏感（true β_social = 0），并不意味着整体选择概率必为 0.5：生成器仍保留 β_self = 0.75、即时模仿 = 0.12、选择惯性 ρ = 0.18。`,
  `- 个体检出使用 β_hat / SE > 1.645（单侧 α=.05）检验 β_social > 0；干预检出使用两侧 α=.05 的组间差异或保守的独立误差前后差异。两者不能互相替代。`,
  `- 240 试次、中等 β=.5 时，个体平均估计值 ${formatNumber(keyRecovery?.mean_beta_hat)}（偏差 ${formatNumber(keyRecovery?.bias)}，RMSE ${formatNumber(keyRecovery?.rmse)}），β=0 的单人假阳性率为 ${formatNumber(keyNull?.individual_detection_rate)}，β=1 的单人检出率为 ${formatNumber(keyStrong?.individual_detection_rate)}。`,
  `- 240 试次、总 N=80 时，四档 β 的 cohort-mean 排序：平均 Spearman ${formatNumber(keyRank?.mean_spearman)}，完全排序率 ${formatNumber(keyRank?.exact_order_rate)}，两两顺序正确率 ${formatNumber(keyRank?.pairwise_order_accuracy)}。`,
  `- 主功效单元不是把 N×500 个数据集再次完整拟合，而是从每个真 β 的 500 个生成—恢复估计中重采样 500 个 cohort；这相当于用已校准的个体估计分布做 pilot power bootstrap，完整生成—拟合结果另见 individual_estimates.csv。`,
  `- 500 次 Monte Carlo 对比例的最坏二项 MC 标准误约为 ${formatNumber(Math.sqrt(0.25 / powerReps), 4)}（p≈.5）；因此临界功效读数应保留约 ±${formatNumber(1.96 * Math.sqrt(0.25 / powerReps), 3)} 的不确定性。`,
  "",
  "## 设计与量纲",
  "",
  "生成器逐行复用服务器的四种收益矩阵、Williams 顺序、低/高同行者 β=2/8、独立同行路线与参与者路线；显示积分先按 `(points-20)/20` 变为归一化收益，再分别更新社会 Q 和个人 Q。选择概率为：",
  "",
  "```text",
  "logit P(C_t) = -0.15 + β_social ΔQ_social + 0.75 ΔQ_self",
  "               + 0.12 observed_action + 0.18 previous_choice",
  "```",
  "",
  "估计设计矩阵与 `scripts/analyze-social-beta.mjs` 相同（截距、3 个博弈 dummy、社会差值及 3 个交互、个人差值、模仿、惯性、高水平同行者 dummy 及交互，共 13 列）。主网格固定 α_social=.35、α_self=.30（与生成器一致），用同一 λ=.7 的惩罚逻辑做 Newton 加速拟合。",
  "",
  "## 现有完整估计器校准",
  "",
  skipFullGrid
    ? "本次以 `--skip-full-grid` 运行，未执行现有 7×7 α 网格 + Adam 校准；主结果仅代表固定真 α 的加速估计。"
    : `在 ${calibrationSummary.n_rows} 个校准数据集上，固定真 α Newton 与现有 7×7 α 网格 + Adam 的 β_social(low) 平均绝对差为 ${formatNumber(calibrationSummary.mean_abs_difference_low)}，中位数为 ${formatNumber(calibrationSummary.median_abs_difference_low)}。完整估计器的 α 选择频数写入 full_grid_calibration.csv；这部分是校准而非 500 次/条件的主功效结果。`,
  "",
  "## 关键结果（240 试次）",
  "",
  "| 结果 | 数值 |",
  "| --- | ---: |",
  `| β_social=0 单人社会检出/假阳性 | ${formatNumber(keyNull?.individual_detection_rate)} |`,
  `| β_social=.5 单人检出 | ${formatNumber(keyRecovery?.individual_detection_rate)} |`,
  `| β_social=1 单人检出 | ${formatNumber(keyStrong?.individual_detection_rate)} |`,
  `| N=80 排序平均 Spearman | ${formatNumber(keyRank?.mean_spearman)} |`,
  `| N=80 完全排序率 | ${formatNumber(keyRank?.exact_order_rate)} |`,
  ...keyN80.map((row) => `| β=.5、Δ=.5、${row.test} 的 80% 功效所需总 N | ${row.required_n80 ?? "未达到（最大 N=" + row.max_n_evaluated + "，功效=" + formatNumber(row.power_at_max_n) + "）"} |`),
  "",
  "## 如何读 N",
  "",
  "N 是名义总样本量；独立组比较时两组各 N/2，排序模拟时四个真值水平各 N/4。`paired_pre_post_conservative` 为了与两组网格可比也使用 N/2 个配对，因此表中的 paired N=60 实际表示 30 名重复测量被试，而不是 60 名被试。`n_effects.csv` 明确列出：N 不会改变单个被试的检出率，只会改变预期检出人数以及“至少一人被检出”的概率。后者在 β=0 时随 N 上升并不是证据，而是多重机会累积。",
  "",
  "干预功效的 `paired_pre_post_conservative` 用独立的前后估计误差，未假定同一被试的正相关，因此更接近保守下界；若真实重复测量相关性较高，正式配对层级模型可能更有功效，但不能直接用这里的数值替代预注册模型。",
  "",
  `计算量核对：${allIndividualRows.length} 个主网格被试各拟合 1 次固定 α Newton；完整估计器校准为 ${calibrationRows.length} 个数据集 × 49 个 α 组合 = ${calibrationRows.length * 49} 次 Adam 拟合；功效阶段重采样 ${interventionRows.length * powerReps} 个干预 cohort 与 ${rankingRows.length * powerReps} 个排序 cohort，不接触正式 DB。`,
  "",
  "## 输出文件",
  "",
  `- [individual_recovery.csv](${recoverySummaryPath})：每个试次数 × 真 β 的偏差、RMSE、覆盖率、个体检出率。`,
  `- [individual_estimates.csv](${recoveryPath})：${allIndividualRows.length} 个模拟被试级估计，便于复核与重采样。`,
  `- [ranking_power.csv](${rankingPath})：N 对四档 β 的 cohort-mean 排序恢复。`,
  `- [n_effects.csv](${nEffectPath})：N 对单人检出相关指标的影响及多重机会提醒。`,
  `- [intervention_power.csv](${interventionPath})：基线 β、Δ、N 与组间/前后功效。`,
  `- [required_n80.csv](${n80Path})：每个试次 × 基线 β × 效应 × 检验的 80% 功效所需总 N；“not reached” 表示在 N≤160 网格内未达到。`,
  `- [full_grid_calibration.csv](${calibrationPath})：固定真 α Newton 与现有完整 α 网格估计器的校准对照。`,
  "",
  "## 限制",
  "",
  "这是一批 mock/pilot，不是真被试数据。主网格固定了个人学习率与若干 nuisance 参数，未覆盖模型错设、被试间异质性、超时/缺失、重复作答或设备效应；这些因素通常只会让正式功效低于此处。完整 α 网格只在小校准子集运行，避免把加速估计误报为生产估计器。正式研究应以预注册的层级模型复跑，并把 β_social 的个体显著性和 wave×group 的干预差异分开报告。",
];
const reportPath = resolve(OUTPUT_DIR, "report.md");
writeFileSync(reportPath, `${reportLines.join("\n")}\n`, "utf8");

const jsonPath = resolve(OUTPUT_DIR, "power_grid.json");
const metadata = {
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  seed: baseSeed,
  output_dir: OUTPUT_DIR,
  configuration: {
    trial_grid: TRIAL_GRID,
    trials_per_companion: TRIAL_GRID.map((value) => value / 8),
    true_betas: TRUE_BETAS,
    report_betas: REPORT_BETAS,
    n_totals: N_TOTALS,
    effect_sizes: EFFECT_SIZES,
    recovery_reps: recoveryReps,
    power_reps: powerReps,
    calibration_reps: skipFullGrid ? 0 : calibrationReps,
    alpha_social_true: ALPHA_SOCIAL_TRUE,
    alpha_self_true: ALPHA_SELF_TRUE,
    beta_self_true: 0.75,
    beta_choice_true: 0.12,
    persistence_true: 0.18,
    intercept_true: -0.15,
    lambda: LAMBDA,
    individual_detection_threshold_z: SIG_Z_90_ONE_SIDED,
    intervention_threshold_z: SIG_Z_95,
    estimator_primary: "fixed_true_alpha_newton",
    estimator_reference: "analyze-social-beta-compatible-grid-adam",
    power_simulation_method: "resample empirical fixed-alpha individual estimates; no second per-cohort model refit",
    mc_se_worst_case_for_proportion: Math.sqrt(0.25 / powerReps),
  },
  key_metrics: {
    n240_beta0: keyNull,
    n240_beta025: findRow(recoveryRows, (row) => row.n_trials === 240 && row.true_beta_social === 0.25),
    n240_beta05: keyRecovery,
    n240_beta1: keyStrong,
    n240_n80_rank: keyRank,
    n240_beta05_delta05_n80: keyN80,
  },
  recovery_summary: recoveryRows,
  ranking_power: rankingRows,
  intervention_power: interventionRows,
  required_n80: n80Rows,
  full_grid_calibration: calibrationSummary,
  files: {
    individual_estimates: recoveryPath,
    individual_recovery: recoverySummaryPath,
    ranking_power: rankingPath,
    n_effects: nEffectPath,
    intervention_power: interventionPath,
    required_n80: n80Path,
    full_grid_calibration: calibrationPath,
    report: reportPath,
  },
};
writeFileSync(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  message: "power-grid complete",
  outputDir: OUTPUT_DIR,
  reportPath,
  jsonPath,
  recoveryRows: recoveryRows.length,
  individualRows: allIndividualRows.length,
  rankingRows: rankingRows.length,
  interventionRows: interventionRows.length,
  n80Rows: n80Rows.length,
  calibrationRows: calibrationRows.length,
}, null, 2));
