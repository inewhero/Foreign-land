from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path


def number(row: dict[str, str], key: str, default: float = 0.0) -> float:
    try:
        return float(row.get(key, ""))
    except (TypeError, ValueError):
        return default


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare ctp-v2 trial export for Stan.")
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("output_json", type=Path)
    args = parser.parse_args()

    with args.input_csv.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row.get("protocol_version") == "ctp-v2"]
    if not rows:
        raise SystemExit("No ctp-v2 trials were found; legacy-v1 data must use the legacy analyzer.")

    rows.sort(key=lambda row: (row["study_id"], row["wave_code"], row.get("created_at", "")))
    subject_ids = sorted({row["subject_id"] for row in rows})
    session_ids = sorted(
        {row["session_id"] for row in rows},
        key=lambda session_id: min(
            (row["study_id"], int(row["wave_code"][1:]), row.get("created_at", ""))
            for row in rows if row["session_id"] == session_id
        ),
    )
    subject_index = {value: index + 1 for index, value in enumerate(subject_ids)}
    session_index = {value: index + 1 for index, value in enumerate(session_ids)}
    games = ["pd", "stag", "snow", "harmony"]
    game_index = {value: index + 1 for index, value in enumerate(games)}
    max_wave = max(int(row["wave_code"][1:]) for row in rows)

    session_rows: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        session_rows[row["session_id"]].append(row)

    session_subject: list[int] = []
    session_wave: list[int] = []
    session_group: list[int] = []
    previous_session: list[int] = []
    latest_by_subject: dict[int, int] = {}
    for session_id in session_ids:
        first = session_rows[session_id][0]
        subject = subject_index[first["subject_id"]]
        session_subject.append(subject)
        session_wave.append(int(first["wave_code"][1:]) + 1)
        session_group.append(1 if first.get("group_code") == "实验" else 0)
        previous_session.append(latest_by_subject.get(subject, 0))
        latest_by_subject[subject] = session_index[session_id]

    data = {
        "N": len(rows),
        "S": len(subject_ids),
        "J": len(session_ids),
        "W": max_wave + 1,
        "G": 4,
        "subj": [subject_index[row["subject_id"]] for row in rows],
        "sess": [session_index[row["session_id"]] for row in rows],
        "wave": [int(row["wave_code"][1:]) + 1 for row in rows],
        "group": [1 if row.get("group_code") == "实验" else 0 for row in rows],
        "game": [game_index[row["game_key"]] for row in rows],
        "regime": [1 if row.get("social_regime") == "stable" else -1 for row in rows],
        "social_mean": [number(row, "social_value_mean") for row in rows],
        "social_contrast": [number(row, "social_value_contrast") for row in rows],
        "imitation": [1 if row.get("companion_action") == "cooperate" else -1 for row in rows],
        "self_value": [number(row, "personal_value_basis") for row in rows],
        "previous_choice": [number(row, "previous_choice") for row in rows],
        "trial_position": [
            -1 + 2 * (number(row, "valid_round") - 1) / max(1, (12 if row.get("dose_code") == "short96" else 24) - 1)
            for row in rows
        ],
        "y": [1 if row.get("participant_action") == "cooperate" else 0 for row in rows],
        "session_subject": session_subject,
        "session_wave": session_wave,
        "session_group": session_group,
        "session_dose": [session_rows[session_id][0].get("dose_code", "") for session_id in session_ids],
        "previous_session": previous_session,
    }
    manifest = {
        "protocol_version": "ctp-v2",
        "source_csv": str(args.input_csv.resolve()),
        "subject_ids": subject_ids,
        "session_ids": session_ids,
        "session_subject": session_subject,
        "session_wave": session_wave,
        "session_group": session_group,
        "games": games,
        "n_trials": len(rows),
    }
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    args.output_json.with_suffix(".manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    prediction_rows: list[dict[str, object]] = []
    for session_id in session_ids:
        session = session_rows[session_id]
        scored: list[tuple[int, int]] = []
        timeouts = 0
        by_companion: dict[str, list[dict[str, str]]] = defaultdict(list)
        for row in session:
            by_companion[row["companion_ordinal"]].append(row)
            timeouts += int(number(row, "prediction_timed_out"))
        for companion_trials in by_companion.values():
            companion_trials.sort(key=lambda row: int(row["valid_round"]))
            for index, row in enumerate(companion_trials[:-1]):
                prediction = row.get("prediction_action")
                if prediction not in {"cooperate", "betray"}:
                    continue
                scored.append((index + 1, int(prediction == companion_trials[index + 1].get("companion_action"))))
        if scored:
            x = [position for position, _ in scored]
            y_score = [correct for _, correct in scored]
            mean_x = sum(x) / len(x)
            mean_y = sum(y_score) / len(y_score)
            denominator = sum((value - mean_x) ** 2 for value in x)
            slope = sum((x_value - mean_x) * (y_value - mean_y) for x_value, y_value in scored) / denominator if denominator else 0.0
        else:
            mean_y = 0.0
            slope = 0.0
        first = session[0]
        prediction_rows.append({
            "subject_id": first["subject_id"], "session_id": session_id, "wave_code": first["wave_code"],
            "n_scored_predictions": len(scored), "prediction_accuracy": mean_y,
            "prediction_brier": 1 - mean_y, "prediction_update_slope": slope,
            "prediction_timeout_rate": timeouts / len(session),
        })
    prediction_path = args.output_json.with_suffix(".prediction-calibration.csv")
    with prediction_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(prediction_rows[0]))
        writer.writeheader()
        writer.writerows(prediction_rows)
    print(json.dumps({"output": str(args.output_json.resolve()), "N": len(rows), "S": len(subject_ids), "J": len(session_ids)}))


if __name__ == "__main__":
    main()
