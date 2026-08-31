from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

from scipy.stats import norm


ROOT = Path(__file__).resolve().parents[1]


def required_sample(
    effect_sd: float,
    baseline_followup_r: float,
    attrition: float,
    alpha: float,
    power: float,
) -> dict[str, float | int]:
    """Two-group difference-in-change design, with effect in baseline SD units."""
    z_alpha = float(norm.ppf(1 - alpha / 2))
    z_power = float(norm.ppf(power))
    complete_per_group = 4 * (1 - baseline_followup_r) * (z_alpha + z_power) ** 2 / effect_sd**2
    randomized_per_group = math.ceil(complete_per_group / (1 - attrition))
    return {
        "effect_sd": effect_sd,
        "baseline_followup_r": baseline_followup_r,
        "attrition": attrition,
        "alpha_two_sided": alpha,
        "target_power": power,
        "complete_per_group": math.ceil(complete_per_group),
        "randomized_per_group": randomized_per_group,
        "randomized_total": 2 * randomized_per_group,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Sensitivity grid for the SVS group-by-wave contrast.")
    parser.add_argument("--output", type=Path, default=ROOT / "output" / "power-v2")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, float | int]] = []
    for target_power in (0.80, 0.90):
        for effect_sd in (0.20, 0.30, 0.40, 0.50):
            for correlation in (0.50, 0.60, 0.70):
                rows.append(required_sample(effect_sd, correlation, 0.15, 0.05, target_power))

    csv_path = args.output / "group-wave-sample-grid.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    primary = required_sample(0.30, 0.60, 0.15, 0.05, 0.80)
    optimistic = required_sample(0.30, 0.70, 0.15, 0.05, 0.80)
    conservative = required_sample(0.30, 0.50, 0.15, 0.05, 0.80)
    moderate_effect = required_sample(0.50, 0.60, 0.15, 0.05, 0.80)
    recommendation = {
        "dose_test_retest_pilot": {
            "maximum_total": 80,
            "per_dose": 40,
            "checkpoints_per_dose": [20, 30, 40],
            "note": "Each participant completes T0 and a 7+/-2 day T1 retest at the assigned dose.",
        },
        "main_intervention_primary": primary,
        "sensitivity_for_0_3sd": {
            "r_0_50": conservative,
            "r_0_70": optimistic,
        },
        "if_only_0_5sd_is_required": moderate_effect,
        "interpretation": (
            "The primary calculation powers one preregistered group-by-wave change contrast. "
            "It does not credit unverified efficiency gains from nine-wave modeling; update it with pilot reliability, attrition, "
            "and posterior measurement error before the confirmatory trial."
        ),
    }
    (args.output / "sample-size-recommendation.json").write_text(
        json.dumps(recommendation, indent=2), encoding="utf-8"
    )
    print(json.dumps(recommendation, indent=2))


if __name__ == "__main__":
    main()
