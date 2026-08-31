from __future__ import annotations

import argparse
import csv
import json
import os
import platform
from pathlib import Path

import numpy as np
import pandas as pd
from cmdstanpy import CmdStanModel, set_cmdstan_path


PHENOTYPES = ["BIAS", "SVS", "TIMESCALE", "IMI", "SELF", "PER"]
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CMDSTAN = ROOT / ".cmdstan-phenotype" / "cmdstan-2.38.0"


def configure_toolchain(cmdstan: Path) -> None:
    """Use the repository's locked CmdStan and the installed RTools45 on Windows."""
    resolved_cmdstan = cmdstan.resolve()
    if not resolved_cmdstan.is_dir():
        raise FileNotFoundError(f"CmdStan directory not found: {resolved_cmdstan}")
    set_cmdstan_path(str(resolved_cmdstan))

    if platform.system() != "Windows":
        return
    rtools = Path("C:/rtools45")
    make = rtools / "usr" / "bin" / "make.exe"
    compiler = rtools / "x86_64-w64-mingw32.static.posix" / "bin"
    tbb = resolved_cmdstan / "stan" / "lib" / "stan_math" / "lib" / "tbb"
    if not make.is_file() or not compiler.is_dir():
        raise FileNotFoundError("RTools45 is required at C:/rtools45 for Stan compilation on Windows.")
    os.environ["MAKE"] = str(make)
    os.environ["PATH"] = os.pathsep.join([str(make.parent), str(compiler), str(tbb), os.environ.get("PATH", "")])


def interval(draws: np.ndarray) -> tuple[float, float, float]:
    return tuple(float(value) for value in np.quantile(draws, [0.05, 0.5, 0.95]))


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    if not rows:
        return
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit ctp-v2 hierarchical computational phenotypes.")
    parser.add_argument("data_json", type=Path)
    parser.add_argument("--model", choices=["pilot", "ar1"], default="pilot")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chains", type=int, default=4)
    parser.add_argument("--warmup", type=int, default=1000)
    parser.add_argument("--samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20260830)
    parser.add_argument("--cmdstan", type=Path, default=DEFAULT_CMDSTAN)
    args = parser.parse_args()

    configure_toolchain(args.cmdstan)
    args.output.mkdir(parents=True, exist_ok=True)
    model_file = Path(__file__).with_name(
        "phenotype_pilot.stan" if args.model == "pilot" else "phenotype_longitudinal_ar1.stan"
    )
    model = CmdStanModel(stan_file=str(model_file))
    fit = model.sample(
        data=str(args.data_json), chains=args.chains, parallel_chains=args.chains,
        iter_warmup=args.warmup, iter_sampling=args.samples, seed=args.seed,
        adapt_delta=0.95, max_treedepth=12, show_progress=True,
    )
    fit.save_csvfiles(dir=str(args.output / "draws"))
    summary = fit.summary()
    summary.to_csv(args.output / "posterior-summary.csv", encoding="utf-8-sig")

    manifest = json.loads(args.data_json.with_suffix(".manifest.json").read_text(encoding="utf-8"))
    stan_data = json.loads(args.data_json.read_text(encoding="utf-8"))
    means = fit.stan_variable("phenotype_mean")
    subject_effect = fit.stan_variable("subject_effect")
    session_state = fit.stan_variable("session_state")
    subject_coefficients = means[:, None, :] + subject_effect
    log_gain = fit.stan_variable("log_lik") - fit.stan_variable("log_lik_no_social")
    trial_subject = np.asarray(stan_data["subj"], dtype=int) - 1

    phenotype_rows: list[dict[str, object]] = []
    svs_posterior_mean = subject_coefficients[:, :, 1].mean(axis=0)
    for subject_index, subject_id in enumerate(manifest["subject_ids"]):
        row: dict[str, object] = {"subject_id": subject_id}
        for phenotype_index, phenotype in enumerate(PHENOTYPES):
            low, median, high = interval(subject_coefficients[:, subject_index, phenotype_index])
            row[f"{phenotype.lower()}_mean"] = float(subject_coefficients[:, subject_index, phenotype_index].mean())
            row[f"{phenotype.lower()}_q05"] = low
            row[f"{phenotype.lower()}_median"] = median
            row[f"{phenotype.lower()}_q95"] = high
        row["svs_normative_percentile"] = float(
            100 * (np.sum(svs_posterior_mean < svs_posterior_mean[subject_index]) + 0.5) / len(svs_posterior_mean)
        )
        subject_trials = trial_subject == subject_index
        row["social_predictive_log_gain"] = float(log_gain[:, subject_trials].sum(axis=1).mean())

        mechanism = np.abs(subject_coefficients[:, subject_index][:, [1, 3, 4, 5]])
        dominant = np.argmax(mechanism, axis=1)
        nonresponsive = np.max(mechanism, axis=1) < 0.2
        for mechanism_index, label in enumerate(["social_value", "imitation", "self_outcome", "persistence"]):
            row[f"p_strategy_{label}"] = float(np.mean((dominant == mechanism_index) & ~nonresponsive))
        row["p_strategy_nonresponsive"] = float(np.mean(nonresponsive))
        phenotype_rows.append(row)

    session_rows: list[dict[str, object]] = []
    baseline_by_subject: dict[int, tuple[int, np.ndarray]] = {}
    latest_by_subject: dict[int, tuple[int, np.ndarray]] = {}
    session_svs_draws: list[np.ndarray] = []
    wave_svs = fit.stan_variable("wave_svs") if stan_data["W"] > 1 else np.zeros((means.shape[0], 0))
    group_wave = fit.stan_variable("group_wave_svs") if stan_data["W"] > 1 else np.zeros((means.shape[0], 0))
    for session_index, session_id in enumerate(manifest["session_ids"]):
        subject = int(manifest["session_subject"][session_index]) - 1
        wave = int(manifest["session_wave"][session_index])
        group = int(manifest["session_group"][session_index])
        draws = subject_coefficients[:, subject, 1] + session_state[:, session_index, 0]
        if wave > 1:
            draws = draws + wave_svs[:, wave - 2] + group * group_wave[:, wave - 2]
        session_svs_draws.append(draws)
        if wave == 1:
            baseline_by_subject[subject] = (session_index, draws)
        if subject not in latest_by_subject or wave > int(manifest["session_wave"][latest_by_subject[subject][0]]):
            latest_by_subject[subject] = (session_index, draws)
        low, median, high = interval(draws)
        session_rows.append({
            "session_id": session_id,
            "subject_id": manifest["subject_ids"][subject],
            "wave": wave - 1,
            "svs_state_mean": float(draws.mean()),
            "svs_state_q05": low,
            "svs_state_median": median,
            "svs_state_q95": high,
        })

    baseline_draw_matrix = np.stack([draws for _, draws in baseline_by_subject.values()], axis=1) if baseline_by_subject else None
    threshold_draws = 0.3 * np.std(baseline_draw_matrix, axis=1) if baseline_draw_matrix is not None and baseline_draw_matrix.shape[1] > 1 else np.full(means.shape[0], 0.3)
    for subject, (latest_index, latest_draws) in latest_by_subject.items():
        if subject not in baseline_by_subject or latest_index == baseline_by_subject[subject][0]:
            continue
        baseline_draws = baseline_by_subject[subject][1]
        delta = latest_draws - baseline_draws
        row = next(item for item in phenotype_rows if item["subject_id"] == manifest["subject_ids"][subject])
        row["latest_minus_t0_svs_mean"] = float(delta.mean())
        row["p_change_above_0_3sd"] = float(np.mean(delta > threshold_draws))
        row["p_change_below_minus_0_3sd"] = float(np.mean(delta < -threshold_draws))

    write_csv(args.output / "subject-phenotypes.csv", phenotype_rows)
    write_csv(args.output / "session-phenotypes.csv", session_rows)

    game_social = fit.stan_variable("game_social")
    base_social = means[:, 1]
    game_slopes = np.column_stack([base_social, *[base_social + game_social[:, index] for index in range(game_social.shape[1])]])
    base_sign = np.sign(base_social)
    direction_probability = [float(np.mean(np.sign(game_slopes[:, index]) == base_sign)) for index in range(game_slopes.shape[1])]
    moderation_equivalence = [1.0] + [float(np.mean(np.abs(game_social[:, index]) < 0.5)) for index in range(game_social.shape[1])]
    invariance = {
        "games": manifest["games"],
        "direction_consistency_probability": direction_probability,
        "p_abs_game_moderation_below_0_5": moderation_equivalence,
        "overall_svs_reportable": bool(min(direction_probability) >= 0.9 and min(moderation_equivalence) >= 0.8),
        "note": "This is the preregistered directional/equivalence screen; report the four-game vector when it fails.",
    }
    (args.output / "measurement-invariance.json").write_text(json.dumps(invariance, indent=2), encoding="utf-8")

    phenotype_sd = fit.stan_variable("phenotype_sd")
    state_sd = fit.stan_variable("state_sd")
    svs_trait_proportion = phenotype_sd[:, 1] ** 2 / (phenotype_sd[:, 1] ** 2 + state_sd[:, 0] ** 2)
    reliability = {
        "model_implied_svs_trait_proportion_mean": float(svs_trait_proportion.mean()),
        "model_implied_svs_trait_proportion_q05": float(np.quantile(svs_trait_proportion, 0.05)),
        "model_implied_svs_trait_proportion_q95": float(np.quantile(svs_trait_proportion, 0.95)),
        "dose_descriptive_test_retest": {},
        "warning": "Joint hierarchical fits can inflate apparent reliability; dose correlations below are descriptive checks, not a replacement for recovery simulations.",
    }
    session_frame = pd.DataFrame(session_rows)
    session_frame["dose_code"] = manifest["session_dose"]
    for dose_code, dose_frame in session_frame.groupby("dose_code"):
        pivot = dose_frame.pivot(index="subject_id", columns="wave", values="svs_state_mean")
        reliability["dose_descriptive_test_retest"][dose_code] = {
            "n_complete_pairs": int(pivot.dropna().shape[0]),
            "pearson_t0_t1": float(pivot[[0, 1]].dropna().corr().iloc[0, 1]) if 0 in pivot and 1 in pivot and pivot[[0, 1]].dropna().shape[0] >= 3 else None,
        }
    (args.output / "reliability.json").write_text(json.dumps(reliability, indent=2), encoding="utf-8")

    finite_rhat = summary["R_hat"].replace([np.inf, -np.inf], np.nan).dropna()
    finite_ess = summary["ESS_bulk"].replace([np.inf, -np.inf], np.nan).dropna()
    divergent = int(np.asarray(fit.method_variables()["divergent__"]).sum())
    diagnostics = {
        "model": args.model,
        "max_rhat": float(finite_rhat.max()) if len(finite_rhat) else None,
        "min_ess_bulk": float(finite_ess.min()) if len(finite_ess) else None,
        "divergences": divergent,
        "accepted": bool(len(finite_rhat) and finite_rhat.max() < 1.01 and finite_ess.min() >= 400 and divergent == 0),
        "mcid_note": "0.3 baseline-SVS SD is a preregistered relevant-change threshold, not a clinical anchor.",
    }
    (args.output / "diagnostics.json").write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
    print(json.dumps(diagnostics))


if __name__ == "__main__":
    main()
