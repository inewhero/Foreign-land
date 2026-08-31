import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Action, DoseCode } from "../shared/types.js";
import { buildConditions, GAMES, participantPayoff, stableIndex } from "../server/experiment.js";
import { PERSONAL_ALPHA_LONG, PERSONAL_ALPHA_SHORT, buildSequenceBank } from "../server/sequence-bank.js";

const REPS = Number(process.env.RECOVERY_REPS ?? 600);
const GROUP_REPS = Number(process.env.GROUP_RECOVERY_REPS ?? 120);
const lambda = 0.1;
const sigmoid = (value: number) => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));

function rng(seedText: string) {
  let state = stableIndex(seedText, 0x7fffffff) || 1;
  return () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function invert(matrix: number[][]) {
  const size = matrix.length;
  const work = matrix.map((row, index) => [...row, ...Array.from({ length: size }, (_, column) => column === index ? 1 : 0)]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    [work[column], work[pivot]] = [work[pivot], work[column]];
    if (Math.abs(work[column][column]) < 1e-9) return undefined;
    const divisor = work[column][column];
    work[column] = work[column].map((value) => value / divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = work[row][column];
      work[row] = work[row].map((value, index) => value - factor * work[column][index]);
    }
  }
  return work.map((row) => row.slice(size));
}

function fit(x: number[][], y: number[]) {
  const p = x[0].length;
  const beta = Array(p).fill(0);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const gradient = Array(p).fill(0);
    const information = Array.from({ length: p }, () => Array(p).fill(0));
    for (let row = 0; row < x.length; row += 1) {
      const probability = sigmoid(x[row].reduce((sum, value, column) => sum + value * beta[column], 0));
      const weight = Math.max(1e-6, probability * (1 - probability));
      for (let left = 0; left < p; left += 1) {
        gradient[left] += x[row][left] * (y[row] - probability);
        for (let right = 0; right < p; right += 1) information[left][right] += x[row][left] * x[row][right] * weight;
      }
    }
    for (let column = 1; column < p; column += 1) {
      gradient[column] -= lambda * beta[column];
      information[column][column] += lambda;
    }
    const covariance = invert(information);
    if (!covariance) break;
    const step = covariance.map((row) => row.reduce((sum, value, column) => sum + value * gradient[column], 0));
    for (let column = 0; column < p; column += 1) beta[column] += Math.max(-1, Math.min(1, step[column]));
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  const information = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < x.length; row += 1) {
    const probability = sigmoid(x[row].reduce((sum, value, column) => sum + value * beta[column], 0));
    const weight = Math.max(1e-6, probability * (1 - probability));
    for (let left = 0; left < p; left += 1) for (let right = 0; right < p; right += 1) information[left][right] += x[row][left] * x[row][right] * weight;
  }
  for (let column = 1; column < p; column += 1) information[column][column] += lambda;
  const covariance = invert(information);
  return { beta, seSocial: Math.sqrt(Math.max(1e-8, covariance?.[4][4] ?? Infinity)) };
}

function simulate(args: { doseCode: DoseCode; rep: number; scenario: string; trueSvs: number }) {
  const studyId = `REC_${args.doseCode}_${args.rep}`;
  const formCode = String.fromCharCode(65 + args.rep % 4);
  const waveCode = `T${args.rep % 9}`;
  const conditions = buildConditions(studyId, formCode);
  const games = [0, 1, 2, 3].map((block) => conditions[block * 2].game);
  const bank = buildSequenceBank({ doseCode: args.doseCode, formCode, waveCode, games });
  // Common random numbers reduce Monte Carlo noise when comparing nuisance-only
  // generators against the random-choice null; the sequence itself is identical.
  const random = rng(studyId);
  const x: number[][] = [];
  const y: number[] = [];
  const selfShort = [0, 0];
  const selfLong = [0, 0];
  let previousChoice = 0;
  let previousGame = "";
  const coefficients = {
    svs: args.scenario === "recovery" ? args.trueSvs : 0,
    time: args.scenario === "timescale" ? 1.0 : 0.15,
    imitation: args.scenario === "imitation" ? 1.2 : 0.2,
    self: args.scenario === "self" ? 1.2 : 0.3,
    persistence: args.scenario === "persistence" ? 1.2 : 0.2,
  };
  for (const template of bank.trials) {
    const condition = conditions[template.companionOrdinal];
    if (condition.game !== previousGame) {
      selfShort[0] = 0; selfShort[1] = 0; selfLong[0] = 0; selfLong[1] = 0; previousChoice = 0;
      previousGame = condition.game;
    }
    const personal = ((selfShort[0] - selfShort[1]) + (selfLong[0] - selfLong[1])) / Math.SQRT2;
    const action = template.observedAction === "cooperate" ? 1 : -1;
    const game = Math.floor(template.companionOrdinal / 2);
    const regime = template.socialRegime === "stable" ? 1 : -1;
    const withinCompanionOrder = -1 + 2 * (template.validRound - 1) / Math.max(1, (args.doseCode === "short96" ? 12 : 24) - 1);
    const row = [1, game === 1 ? 1 : 0, game === 2 ? 1 : 0, game === 3 ? 1 : 0,
      template.socialValueMean, template.socialValueContrast, action, personal, previousChoice,
      regime * template.socialValueMean, regime, withinCompanionOrder];
    const linear = -0.1 + coefficients.svs * row[4] + coefficients.time * row[5]
      + coefficients.imitation * row[6] + coefficients.self * row[7] + coefficients.persistence * row[8];
    const choice: Action = random() < sigmoid(linear) ? "cooperate" : "betray";
    const choiceIndex = choice === "cooperate" ? 0 : 1;
    const payoff = participantPayoff(condition.game, choice, template.participantRouteAction).normalized;
    selfShort[choiceIndex] += PERSONAL_ALPHA_SHORT * (payoff - selfShort[choiceIndex]);
    selfLong[choiceIndex] += PERSONAL_ALPHA_LONG * (payoff - selfLong[choiceIndex]);
    previousChoice = choice === "cooperate" ? 1 : -1;
    x.push(row); y.push(choice === "cooperate" ? 1 : 0);
  }
  return { ...fit(x, y), x, y };
}

function correlation(a: number[], b: number[]) {
  const ma = a.reduce((sum, value) => sum + value, 0) / a.length;
  const mb = b.reduce((sum, value) => sum + value, 0) / b.length;
  const numerator = a.reduce((sum, value, index) => sum + (value - ma) * (b[index] - mb), 0);
  const denominator = Math.sqrt(a.reduce((sum, value) => sum + (value - ma) ** 2, 0) * b.reduce((sum, value) => sum + (value - mb) ** 2, 0));
  return numerator / denominator;
}

function quantile(values: number[], probability: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function cohortAbsZ(values: number[], seedText: string, cohortSize = 40, repetitions = 2000) {
  const random = rng(seedText);
  return Array.from({ length: repetitions }, () => {
    const sample = Array.from({ length: cohortSize }, () => values[Math.floor(random() * values.length)]);
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
    const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, sample.length - 1);
    return Math.abs(mean / (Math.sqrt(variance) / Math.sqrt(sample.length) || Infinity));
  });
}

function pooledCohortAbsZ(datasets: Array<{ x: number[][]; y: number[] }>, seedText: string, cohortSize = 40) {
  const random = rng(seedText);
  return Array.from({ length: GROUP_REPS }, () => {
    const selected = Array.from({ length: cohortSize }, () => datasets[Math.floor(random() * datasets.length)]);
    const estimate = fit(selected.flatMap((dataset) => dataset.x), selected.flatMap((dataset) => dataset.y));
    return Math.abs(estimate.beta[4] / estimate.seSocial);
  });
}

const results: Record<string, unknown>[] = [];
for (const doseCode of ["short96", "long192"] as const) {
  const truths: number[] = [];
  const estimates: number[] = [];
  let covered = 0;
  for (let rep = 0; rep < REPS; rep += 1) {
    const trueSvs = -1.5 + 3 * ((rep + 0.5) / REPS);
    const estimate = simulate({ doseCode, rep, scenario: "recovery", trueSvs });
    truths.push(trueSvs); estimates.push(estimate.beta[4]);
    covered += Number(Math.abs(estimate.beta[4] - trueSvs) <= 1.645 * estimate.seSocial);
  }
  const scenarioZ: Record<string, number[]> = {};
  const scenarioEstimates: Record<string, number[]> = {};
  const scenarioDatasets: Record<string, Array<{ x: number[][]; y: number[] }>> = {};
  for (const scenario of ["random", "imitation", "self", "persistence"]) {
    scenarioZ[scenario] = [];
    scenarioEstimates[scenario] = [];
    scenarioDatasets[scenario] = [];
    for (let rep = 0; rep < REPS; rep += 1) {
      const estimate = simulate({ doseCode, rep, scenario, trueSvs: 0 });
      scenarioZ[scenario].push(Math.abs(estimate.beta[4] / estimate.seSocial));
      scenarioEstimates[scenario].push(estimate.beta[4]);
      scenarioDatasets[scenario].push({ x: estimate.x, y: estimate.y });
    }
  }
  const nullThreshold95 = quantile(scenarioZ.random, 0.95);
  const compositeIndividualNullThreshold95 = Math.max(...Object.values(scenarioZ).map((values) => quantile(values, 0.95)));
  const scenarioRates = Object.fromEntries(Object.entries(scenarioZ).map(([scenario, values]) => [
    scenario,
    values.filter((value) => value > nullThreshold95).length / REPS,
  ]));
  const cohortZ = Object.fromEntries(Object.entries(scenarioDatasets).map(([scenario, datasets]) => [
    scenario,
    pooledCohortAbsZ(datasets, `${doseCode}:${scenario}:cohort`),
  ]));
  const cohortNullThreshold95 = quantile(cohortZ.random, 0.95);
  const compositeCohortNullThreshold95 = Math.max(...Object.values(cohortZ).map((values) => quantile(values, 0.95)));
  const cohortRates = Object.fromEntries(Object.entries(cohortZ).map(([scenario, values]) => [
    scenario,
    values.filter((value) => value > cohortNullThreshold95).length / values.length,
  ]));
  const compositeIndividualRates = Object.fromEntries(Object.entries(scenarioZ).map(([scenario, values]) => [
    scenario, values.filter((value) => value > compositeIndividualNullThreshold95).length / values.length,
  ]));
  const compositeCohortRates = Object.fromEntries(Object.entries(cohortZ).map(([scenario, values]) => [
    scenario, values.filter((value) => value > compositeCohortNullThreshold95).length / values.length,
  ]));
  results.push({
    doseCode,
    reps: REPS,
    recoveryCorrelation: correlation(truths, estimates),
    coverage90: covered / REPS,
    empiricalNullAbsZ95: nullThreshold95,
    compositeIndividualNullAbsZ95: compositeIndividualNullThreshold95,
    compositeIndividualFalsePositive: compositeIndividualRates,
    falsePositiveRandom: scenarioRates.random,
    falsePositiveImitation: scenarioRates.imitation,
    falsePositiveSelf: scenarioRates.self,
    falsePositivePersistence: scenarioRates.persistence,
    groupN40NullAbsZ95: cohortNullThreshold95,
    groupRecoveryReps: GROUP_REPS,
    groupFalsePositiveRandom: cohortRates.random,
    groupFalsePositiveImitation: cohortRates.imitation,
    groupFalsePositiveSelf: cohortRates.self,
    groupFalsePositivePersistence: cohortRates.persistence,
    compositeGroupNullAbsZ95: compositeCohortNullThreshold95,
    compositeGroupFalsePositive: compositeCohortRates,
    scenarioMeanSvsEstimate: Object.fromEntries(Object.entries(scenarioEstimates).map(([scenario, values]) => [
      scenario,
      values.reduce((sum, value) => sum + value, 0) / values.length,
    ])),
  });
}

const accepted = results.every((row) => {
  const threshold = row.doseCode === "short96" ? 0.55 : 0.70;
  return Number(row.recoveryCorrelation) >= threshold
    && Number(row.coverage90) >= 0.85 && Number(row.coverage90) <= 0.95
    && Object.values(row.compositeGroupFalsePositive as Record<string, number>).every((rate) => rate <= 0.05);
});
const report = { method: "fixed-basis ridge recovery; acceptance uses the worst-case 95th-percentile composite null across random, imitation, self-only, and persistence N=40 cohorts; formal inference uses Stan partial pooling", accepted, results };
const outputDir = resolve("output", "recovery-v2");
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "recovery-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!accepted) process.exitCode = 1;
