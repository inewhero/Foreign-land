from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import numpy as np


def read(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate cumulative 20/30/40-per-dose pilot checkpoints without efficacy stopping.")
    parser.add_argument("sessions_csv", type=Path)
    parser.add_argument("trials_csv", type=Path)
    parser.add_argument("session_phenotypes_csv", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sessions, trials, phenotypes = read(args.sessions_csv), read(args.trials_csv), read(args.session_phenotypes_csv)
    phenotype_by_session = {row["session_id"]: row for row in phenotypes}
    sessions_by_subject: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in sessions:
        if row.get("protocol_version") == "ctp-v2":
            sessions_by_subject[row["subject_id"]].append(row)
    trial_by_session: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in trials:
        if row.get("protocol_version") == "ctp-v2":
            trial_by_session[row["session_id"]].append(row)

    reports: list[dict[str, object]] = []
    for checkpoint in [20, 30, 40]:
        for dose in ["short96", "long192"]:
            subjects = sorted(
                [subject for subject, subject_sessions in sessions_by_subject.items() if subject_sessions[0].get("dose_code") == dose],
                key=lambda subject: min(row.get("created_at", "") for row in sessions_by_subject[subject]),
            )[:checkpoint]
            selected_sessions = [row for subject in subjects for row in sessions_by_subject[subject] if row.get("wave_code") in {"T0", "T1"}]
            expected_sessions = max(1, len(subjects) * 2)
            completed_sessions = [row for row in selected_sessions if row.get("status") == "complete"]
            selected_trials = [trial for row in selected_sessions for trial in trial_by_session.get(row["session_id"], [])]
            timeout_count = sum(int(float(row.get("prediction_timed_out") or 0)) for row in selected_trials)
            timeout_count += sum(1 for row in selected_sessions for _ in range(int(float(row.get("choice_timeouts") or 0))))
            paired = []
            interval_sd = []
            for subject in subjects:
                values = {}
                for session in sessions_by_subject[subject]:
                    phenotype = phenotype_by_session.get(session["session_id"])
                    if phenotype and session.get("wave_code") in {"T0", "T1"}:
                        values[session["wave_code"]] = float(phenotype["svs_state_mean"])
                        interval_sd.append((float(phenotype["svs_state_q95"]) - float(phenotype["svs_state_q05"])) / 3.29)
                if "T0" in values and "T1" in values:
                    paired.append((values["T0"], values["T1"]))
            reliability = float(np.corrcoef(np.asarray(paired).T)[0, 1]) if len(paired) >= 3 else None
            reports.append({
                "checkpoint_per_dose": checkpoint, "dose_code": dose, "n_enrolled": len(subjects),
                "completion_rate_two_sessions": len(completed_sessions) / expected_sessions,
                "timeout_rate": timeout_count / max(1, len(selected_trials) * 2),
                "median_svs_posterior_sd": float(np.median(interval_sd)) if interval_sd else None,
                "n_complete_retest_pairs": len(paired), "test_retest_correlation": reliability,
                "efficacy_stopping_permitted": False,
            })

    final = {row["dose_code"]: row for row in reports if row["checkpoint_per_dose"] == 40}
    decision = "continue_to_40_per_dose"
    if all(row["n_enrolled"] >= 40 for row in final.values()):
        short, long = final["short96"], final["long192"]
        long_rel = long["test_retest_correlation"]
        short_rel = short["test_retest_correlation"]
        if long_rel is None or long_rel < 0.60:
            decision = "redesign_sequence_not_more_trials"
        elif (short["completion_rate_two_sessions"] >= 0.85 and short["timeout_rate"] <= 0.10
              and short["median_svs_posterior_sd"] <= 1.15 * long["median_svs_posterior_sd"]
              and short_rel is not None and short_rel >= long_rel - 0.10):
            decision = "select_short96"
        else:
            decision = "select_long192"
    result = {"decision": decision, "checkpoints": reports, "note": "20/30 checkpoints are QC-only; do not stop for efficacy significance."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
