import { buildConditions } from "../server/experiment.js";
import { buildSequenceBank } from "../server/sequence-bank.js";

function correlation(a: number[], b: number[]) {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  const covariance = a.reduce((sum, value, index) => sum + (value - meanA) * (b[index] - meanB), 0);
  const scaleA = Math.sqrt(a.reduce((sum, value) => sum + (value - meanA) ** 2, 0));
  const scaleB = Math.sqrt(b.reduce((sum, value) => sum + (value - meanB) ** 2, 0));
  return scaleA && scaleB ? covariance / (scaleA * scaleB) : 0;
}

function invert(matrix: number[][]) {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [...row, ...Array.from({ length: size }, (_, column) => column === index ? 1 : 0)]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-9) return undefined;
    augmented[column] = augmented[column].map((value) => value / divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, index) => value - factor * augmented[column][index]);
    }
  }
  return augmented.map((row) => row.slice(size));
}

function maxVif(columns: number[][]) {
  const correlationMatrix = columns.map((left) => columns.map((right) => correlation(left, right)));
  const inverse = invert(correlationMatrix);
  return inverse ? Math.max(...inverse.map((row, index) => row[index])) : Infinity;
}

const rows: Array<Record<string, string | number>> = [];
let failed = false;
for (const doseCode of ["short96", "long192"] as const) {
  for (const formCode of ["A", "B", "C", "D"]) {
    for (let wave = 0; wave <= 8; wave += 1) {
      const studyId = `SEQ_${formCode}_${wave}`;
      const conditions = buildConditions(studyId, formCode);
      const games = [0, 1, 2, 3].map((block) => conditions[block * 2].game);
      const bank = buildSequenceBank({ doseCode, formCode, waveCode: `T${wave}`, games });
      const action = bank.trials.map((trial) => trial.observedAction === "cooperate" ? 1 : -1);
      const ordinal = bank.trials.map((_, index) => index / Math.max(1, bank.trials.length - 1));
      const actionCorrelation = Math.abs(correlation(bank.trials.map((trial) => trial.socialValueMean), action));
      const orderCorrelation = Math.abs(correlation(bank.trials.map((trial) => trial.socialValueMean), ordinal));
      const vif = maxVif([
        bank.trials.map((trial) => trial.socialValueMean),
        bank.trials.map((trial) => trial.socialValueContrast),
        action,
        bank.trials.map((trial) => trial.socialRegime === "stable" ? 1 : -1),
        ...[1, 2, 3].map((gameIndex) => bank.trials.map((trial) => Math.floor(trial.companionOrdinal / 2) === gameIndex ? 1 : 0)),
      ]);
      const anchors = bank.trials.filter((trial) => trial.anchorId).length;
      const balanced = Array.from({ length: 8 }, (_, companionOrdinal) => {
        const trials = bank.trials.filter((trial) => trial.companionOrdinal === companionOrdinal);
        return trials.filter((trial) => trial.observedAction === "cooperate").length === trials.length / 2
          && trials.filter((trial) => trial.observedRouteAction === "cooperate").length === trials.length / 2
          && trials.filter((trial) => trial.participantRouteAction === "cooperate").length === trials.length / 2
          && new Set(["aligned", "conflict", "neutral"].map((kind) => trials.filter((trial) => trial.evidenceClass === kind).length)).size === 1;
      }).every(Boolean);
      const accepted = balanced && anchors === 24 && actionCorrelation < 0.1 && orderCorrelation < 0.1 && vif < 2;
      failed ||= !accepted;
      rows.push({ doseCode, formCode, wave, hash: bank.hash, n: bank.trials.length, anchors, actionCorrelation, orderCorrelation, maxVif: vif, balanced: Number(balanced), accepted: Number(accepted) });
    }
  }
}

const worstAction = Math.max(...rows.map((row) => Number(row.actionCorrelation)));
const worstOrder = Math.max(...rows.map((row) => Number(row.orderCorrelation)));
const worstVif = Math.max(...rows.map((row) => Number(row.maxVif)));
console.log(JSON.stringify({ banks: rows.length, accepted: rows.filter((row) => row.accepted === 1).length, worstActionCorrelation: worstAction, worstOrderCorrelation: worstOrder, worstVif }, null, 2));
if (failed) process.exitCode = 1;
