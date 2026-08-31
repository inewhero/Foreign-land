from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np
from scipy.stats import t


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "intervention-checkpoint-simulation"
RECOVERY_SUMMARY = ROOT / "output" / "recovery-v2" / "recovery-summary.json"
CHECKPOINTS = (20, 30, 40)
TRUE_EFFECTS = (0.0, 0.3, 0.5)
TEST_RETEST_R = 0.60
REPETITIONS = 100_000
SEED = 20260831


def welch_df(var_a: np.ndarray, var_b: np.ndarray, n: int) -> np.ndarray:
    numerator = (var_a / n + var_b / n) ** 2
    denominator = (var_a / n) ** 2 / (n - 1) + (var_b / n) ** 2 / (n - 1)
    return numerator / denominator


def simulate_condition(
    rng: np.random.Generator,
    n_per_group: int,
    true_effect: float,
    measurement_variance: float,
) -> tuple[dict[str, float | int], np.ndarray]:
    shape = (REPETITIONS, n_per_group)

    def group_changes(intervention: bool) -> np.ndarray:
        baseline = rng.normal(size=shape)
        innovation = rng.normal(size=shape)
        followup = TEST_RETEST_R * baseline + np.sqrt(1 - TEST_RETEST_R**2) * innovation
        if intervention:
            followup += true_effect
        observed_baseline = baseline + rng.normal(scale=np.sqrt(measurement_variance), size=shape)
        observed_followup = followup + rng.normal(scale=np.sqrt(measurement_variance), size=shape)
        return observed_followup - observed_baseline

    control_change = group_changes(False)
    intervention_change = group_changes(True)
    estimate = intervention_change.mean(axis=1) - control_change.mean(axis=1)
    var_control = control_change.var(axis=1, ddof=1)
    var_intervention = intervention_change.var(axis=1, ddof=1)
    standard_error = np.sqrt(var_control / n_per_group + var_intervention / n_per_group)
    degrees_freedom = welch_df(var_control, var_intervention, n_per_group)
    statistic = estimate / standard_error
    critical_95 = t.ppf(0.975, degrees_freedom)
    critical_90 = t.ppf(0.95, degrees_freedom)
    detected = np.abs(statistic) > critical_95
    covered90 = (estimate - critical_90 * standard_error <= true_effect) & (
        estimate + critical_90 * standard_error >= true_effect
    )
    result = {
        "n_per_group": n_per_group,
        "total_n": n_per_group * 2,
        "true_group_by_wave_svs": true_effect,
        "mean_estimate": float(estimate.mean()),
        "bias": float((estimate - true_effect).mean()),
        "rmse": float(np.sqrt(np.mean((estimate - true_effect) ** 2))),
        "mean_standard_error": float(standard_error.mean()),
        "coverage90": float(covered90.mean()),
        "two_sided_detection_rate": float(detected.mean()),
        "estimate_q05": float(np.quantile(estimate, 0.05)),
        "estimate_q95": float(np.quantile(estimate, 0.95)),
    }
    return result, estimate


def main() -> None:
    recovery = json.loads(RECOVERY_SUMMARY.read_text(encoding="utf-8"))
    recovery_r = {
        row["doseCode"]: float(row["recoveryCorrelation"])
        for row in recovery["results"]
    }
    # Translate the existing truth-versus-estimate recovery correlation into
    # an additive measurement-error variance on a unit true-SVS scale.
    measurement_variance = {dose: 1 / value**2 - 1 for dose, value in recovery_r.items()}

    rng = np.random.default_rng(SEED)
    rows: list[dict[str, float | int | str]] = []
    recovery_by_dose_n: list[dict[str, float | int | str]] = []
    for dose, error_variance in measurement_variance.items():
        for n_per_group in CHECKPOINTS:
            estimates_by_effect: list[np.ndarray] = []
            truths_by_effect: list[np.ndarray] = []
            for true_effect in TRUE_EFFECTS:
                metrics, estimates = simulate_condition(
                    rng, n_per_group, true_effect, error_variance
                )
                rows.append({"dose_code": dose, **metrics})
                estimates_by_effect.append(estimates)
                truths_by_effect.append(np.full(REPETITIONS, true_effect))
            all_estimates = np.concatenate(estimates_by_effect)
            all_truths = np.concatenate(truths_by_effect)
            recovery_by_dose_n.append(
                {
                    "dose_code": dose,
                    "n_per_group": n_per_group,
                    "total_n": n_per_group * 2,
                    "effect_grid": "0.0,0.3,0.5",
                    "effect_recovery_correlation": float(np.corrcoef(all_truths, all_estimates)[0, 1]),
                    "effect_recovery_rmse": float(np.sqrt(np.mean((all_estimates - all_truths) ** 2))),
                    "effect_recovery_bias": float((all_estimates - all_truths).mean()),
                }
            )

    OUTPUT.mkdir(parents=True, exist_ok=True)
    metrics_path = OUTPUT / "checkpoint-power-recovery.csv"
    with metrics_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    recovery_path = OUTPUT / "effect-recovery-by-checkpoint.csv"
    with recovery_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(recovery_by_dose_n[0]))
        writer.writeheader()
        writer.writerows(recovery_by_dose_n)

    report = {
        "method": (
            "100,000-replicate two-group pre/post Monte Carlo, calibrated to the existing v2 sequence-level "
            "truth-versus-estimate recovery correlation for each dose"
        ),
        "estimand": "experimental-minus-control difference in T1-minus-T0 SVS change",
        "test": "two-sided Welch change-score test at alpha 0.05; formal analysis remains trial-level hierarchical Stan",
        "assumptions": {
            "baseline_svs_sd": 1.0,
            "latent_t0_t1_correlation": TEST_RETEST_R,
            "no_attrition": True,
            "balanced_groups": True,
            "repetitions_per_cell": REPETITIONS,
            "seed": SEED,
            "recovery_correlation_used": recovery_r,
            "derived_measurement_variance": measurement_variance,
        },
        "acceptance_targets": {
            "null_false_positive_max": 0.05,
            "target_power": 0.80,
            "coverage90_range": [0.85, 0.95],
        },
        "results": rows,
        "effect_recovery": recovery_by_dose_n,
        "limitations": [
            "This is a calibrated fast screening simulation, not repeated full Stan refitting.",
            "It assumes stable nuisance mechanisms and missing completely at random; differential imitation/self-learning changes can bias the SVS contrast.",
            "Recovery correlation across a three-value effect grid depends on the chosen grid; bias, RMSE, coverage, and power are the primary diagnostics.",
        ],
    }
    report_path = OUTPUT / "checkpoint-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
