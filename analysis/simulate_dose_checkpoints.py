from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "dose-checkpoint-simulation"
RECOVERY_CORRELATION = {
    "short96": 0.9536321178428119,
    "long192": 0.9783472824160686,
}
CHECKPOINTS = (20, 30, 40)
LATENT_RELIABILITIES = (0.60, 0.70, 0.80)
REPETITIONS = 50_000
SEED = 20260831


def row_correlation(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    left_centered = left - left.mean(axis=1, keepdims=True)
    right_centered = right - right.mean(axis=1, keepdims=True)
    numerator = np.sum(left_centered * right_centered, axis=1)
    denominator = np.sqrt(np.sum(left_centered**2, axis=1) * np.sum(right_centered**2, axis=1))
    return numerator / denominator


def simulate_correlations(
    rng: np.random.Generator,
    sample_size: int,
    latent_reliability: float,
    measurement_variance: float,
) -> np.ndarray:
    baseline = rng.normal(size=(REPETITIONS, sample_size))
    innovation = rng.normal(size=(REPETITIONS, sample_size))
    followup = latent_reliability * baseline + np.sqrt(1 - latent_reliability**2) * innovation
    observed_baseline = baseline + rng.normal(scale=np.sqrt(measurement_variance), size=baseline.shape)
    observed_followup = followup + rng.normal(scale=np.sqrt(measurement_variance), size=followup.shape)
    return row_correlation(observed_baseline, observed_followup)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)
    measurement_variance = {
        dose: 1 / recovery**2 - 1 for dose, recovery in RECOVERY_CORRELATION.items()
    }
    measurement_sd_ratio = np.sqrt(
        measurement_variance["short96"] / measurement_variance["long192"]
    )

    rows: list[dict[str, float | int]] = []
    for latent_reliability in LATENT_RELIABILITIES:
        expected_observed = {
            dose: latent_reliability / (1 + measurement_variance[dose])
            for dose in RECOVERY_CORRELATION
        }
        for sample_size in CHECKPOINTS:
            short_r = simulate_correlations(
                rng, sample_size, latent_reliability, measurement_variance["short96"]
            )
            long_r = simulate_correlations(
                rng, sample_size, latent_reliability, measurement_variance["long192"]
            )
            rows.append(
                {
                    "per_dose_n": sample_size,
                    "total_n": sample_size * 2,
                    "latent_test_retest_r": latent_reliability,
                    "expected_observed_short_r": expected_observed["short96"],
                    "expected_observed_long_r": expected_observed["long192"],
                    "short_sample_r_q05": np.quantile(short_r, 0.05),
                    "short_sample_r_median": np.median(short_r),
                    "short_sample_r_q95": np.quantile(short_r, 0.95),
                    "long_sample_r_q05": np.quantile(long_r, 0.05),
                    "long_sample_r_median": np.median(long_r),
                    "long_sample_r_q95": np.quantile(long_r, 0.95),
                    "p_long_sample_r_at_least_0_60": np.mean(long_r >= 0.60),
                    "p_short_within_0_10_of_long": np.mean(short_r >= long_r - 0.10),
                    "p_both_reliability_rules": np.mean(
                        (long_r >= 0.60) & (short_r >= long_r - 0.10)
                    ),
                    "p_sample_ranks_long_above_short": np.mean(long_r > short_r),
                }
            )

    csv_path = OUTPUT / "checkpoint-results.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    primary_rows = [row for row in rows if row["latent_test_retest_r"] == 0.70]
    report = {
        "method": "Monte Carlo propagation of the existing 600-replicate per-dose recovery calibration",
        "repetitions_per_condition": REPETITIONS,
        "seed": SEED,
        "recovery_correlation": RECOVERY_CORRELATION,
        "derived_measurement_variance_on_unit_true_svs_scale": measurement_variance,
        "recovery_implied_short_to_long_measurement_sd_ratio": measurement_sd_ratio,
        "preregistered_uncertainty_ratio_limit": 1.15,
        "warning": (
            "The measurement-error SD ratio is not a Stan posterior-SD ratio. It is an early warning only; "
            "the posterior-SD rule must be evaluated from the actual hierarchical pilot fit."
        ),
        "primary_scenario_latent_test_retest_r": 0.70,
        "primary_results": primary_rows,
        "sensitivity_results": rows,
        "interpretation": (
            "The 20/30 checkpoints are QC looks. Even 40 per dose leaves substantial sampling variation in "
            "a difference between two reliability estimates; dose selection should use the full preregistered set "
            "of completion, timeout, posterior uncertainty, and reliability criteria."
        ),
    }
    report_path = OUTPUT / "checkpoint-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
