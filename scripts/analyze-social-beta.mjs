import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("用法: node scripts/analyze-social-beta.mjs <export.csv> [output.csv]");
  process.exit(1);
}
const outputPath = process.argv[3] ?? (inputPath === "-" ? "social-beta.csv" : inputPath.replace(/\.csv$/i, "") + ".social-beta.csv");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter((values) => values.length === header.length).map((values) =>
    Object.fromEntries(header.map((name, index) => [name, values[index]])),
  );
}

const sigmoid = (value) => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const gameIndex = { pd: 0, stag: 1, snow: 2, harmony: 3 };
const actionSign = (action) => action === "cooperate" ? 1 : -1;
const rewardValue = (displayPoints) => (Number(displayPoints) - 20) / 20;

function buildDesign(trials, alphaSocial, alphaSelf) {
  const x = [], y = [];
  let socialQ = [0, 0], selfQ = [0, 0], previousChoice = 0;
  let previousCompanion = null, previousGame = null;
  for (const trial of trials) {
    if (trial.companion_ordinal !== previousCompanion) socialQ = [0, 0];
    if (trial.game_key !== previousGame) { selfQ = [0, 0]; previousChoice = 0; }
    previousCompanion = trial.companion_ordinal;
    previousGame = trial.game_key;

    const observedIndex = trial.companion_action === "cooperate" ? 0 : 1;
    socialQ[observedIndex] += alphaSocial * (rewardValue(trial.companion_display_points) - socialQ[observedIndex]);
    const ds = socialQ[0] - socialQ[1];
    const dp = selfQ[0] - selfQ[1];
    const game = gameIndex[trial.game_key];
    const high = trial.bot_level === "high" ? 1 : 0;
    x.push([
      1,
      game === 1 ? 1 : 0, game === 2 ? 1 : 0, game === 3 ? 1 : 0,
      ds,
      game === 1 ? ds : 0, game === 2 ? ds : 0, game === 3 ? ds : 0,
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

function fitLogistic(x, y, lambda = 0.7) {
  const p = x[0].length, weights = Array(p).fill(0), m = Array(p).fill(0), v = Array(p).fill(0);
  let lastObjective = -Infinity;
  for (let step = 1; step <= 2600; step += 1) {
    const gradient = Array(p).fill(0);
    let logLikelihood = 0;
    for (let i = 0; i < x.length; i += 1) {
      const probability = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(dot(x[i], weights))));
      const error = y[i] - probability;
      logLikelihood += y[i] * Math.log(probability) + (1 - y[i]) * Math.log(1 - probability);
      for (let j = 0; j < p; j += 1) gradient[j] += x[i][j] * error;
    }
    for (let j = 1; j < p; j += 1) {
      gradient[j] -= lambda * weights[j];
      logLikelihood -= 0.5 * lambda * weights[j] ** 2;
    }
    for (let j = 0; j < p; j += 1) {
      const g = gradient[j] / x.length;
      m[j] = 0.9 * m[j] + 0.1 * g;
      v[j] = 0.999 * v[j] + 0.001 * g * g;
      const mHat = m[j] / (1 - 0.9 ** step);
      const vHat = v[j] / (1 - 0.999 ** step);
      weights[j] += 0.025 * mHat / (Math.sqrt(vHat) + 1e-8);
    }
    if (step % 100 === 0 && Math.abs(logLikelihood - lastObjective) < 1e-7) break;
    if (step % 100 === 0) lastObjective = logLikelihood;
  }
  let objective = 0;
  for (let i = 0; i < x.length; i += 1) {
    const probability = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(dot(x[i], weights))));
    objective += y[i] * Math.log(probability) + (1 - y[i]) * Math.log(1 - probability);
  }
  for (let j = 1; j < p; j += 1) objective -= 0.5 * lambda * weights[j] ** 2;
  return { weights, objective };
}

function estimate(trials) {
  const grid = [0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9];
  let best = null;
  for (const alphaSocial of grid) for (const alphaSelf of grid) {
    const design = buildDesign(trials, alphaSocial, alphaSelf);
    const fit = fitLogistic(design.x, design.y);
    if (!best || fit.objective > best.objective) best = { ...fit, alphaSocial, alphaSelf };
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
  };
}

const inputText = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(inputPath), "utf8");
const rows = parseCsv(inputText);
if (rows.some((row) => row.protocol_version === "ctp-v2")) {
  console.error("检测到 ctp-v2 固定基函数数据；请改用 analysis/prepare_stan_data.py 与 CmdStanPy 层级模型。旧逐人 α/β 搜索不会分析 v2 数据。");
  process.exit(3);
}
const usable = rows.filter((row) => row.study_id && row.protocol_version !== "ctp-v2" && row.companion_display_points !== "" && row.participant_route_action);
const grouped = Map.groupBy(usable, (row) => row.study_id);
const estimates = [...grouped.entries()].map(([studyId, trials]) => ({
  study_id: studyId,
  ...estimate(trials.sort((a, b) => a.created_at.localeCompare(b.created_at))),
}));

if (!estimates.length) {
  console.error("没有找到新版独立同行记录试次；请确认 CSV 含 companion_display_points 与 participant_route_action。 ");
  process.exit(2);
}
const columns = Object.keys(estimates[0]);
const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const output = `\uFEFF${columns.map(quote).join(",")}\n${estimates.map((row) => columns.map((column) => quote(row[column])).join(",")).join("\n")}\n`;
writeFileSync(resolve(outputPath), output, "utf8");
console.log(`已写入 ${estimates.length} 名参与者的探索性估计：${resolve(outputPath)}`);
console.log("注意：正式推断应使用预注册的层级模型，并先通过生成—恢复模拟。");
