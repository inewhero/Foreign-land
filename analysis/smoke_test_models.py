from __future__ import annotations

import argparse
import json
import os
import platform
from pathlib import Path

import numpy as np
from cmdstanpy import CmdStanModel, set_cmdstan_path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CMDSTAN = ROOT / ".cmdstan-phenotype" / "cmdstan-2.38.0"


def configure_toolchain(cmdstan: Path) -> None:
    resolved_cmdstan = cmdstan.resolve()
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


def make_smoke_data(seed: int) -> dict[str, object]:
    """Create a small two-wave data set which exercises the AR(1) path."""
    rng = np.random.default_rng(seed)
    subjects = 4
    sessions = subjects * 2
    trials_per_session = 16
    n_trials = sessions * trials_per_session

    subj: list[int] = []
    sess: list[int] = []
    wave: list[int] = []
    group: list[int] = []
    game: list[int] = []
    regime: list[int] = []
    social_mean: list[float] = []
    social_contrast: list[float] = []
    imitation: list[float] = []
    self_value: list[float] = []
    previous_choice: list[float] = []
    trial_position: list[float] = []
    y: list[int] = []

    session_subject: list[int] = []
    session_wave: list[int] = []
    session_group: list[int] = []
    previous_session: list[int] = []

    for session_index in range(sessions):
        subject = session_index // 2 + 1
        session_wave_value = session_index % 2 + 1
        subject_group = (subject - 1) % 2
        session_subject.append(subject)
        session_wave.append(session_wave_value)
        session_group.append(subject_group)
        previous_session.append(0 if session_wave_value == 1 else session_index)

        last_choice = 0.0
        for trial_index in range(trials_per_session):
            social = float(rng.choice([-1.2, -0.6, 0.0, 0.6, 1.2]))
            contrast = float(rng.choice([-1.0, -0.5, 0.0, 0.5, 1.0]))
            imitated = float(rng.choice([-1.0, 1.0]))
            personal = float(rng.normal(0, 0.8))
            position = (trial_index - (trials_per_session - 1) / 2) / trials_per_session
            eta = 0.15 + 0.45 * social + 0.15 * contrast + 0.12 * imitated
            eta += 0.18 * personal + 0.12 * last_choice
            eta += 0.20 * subject_group * (session_wave_value - 1) * social
            choice = int(rng.random() < 1 / (1 + np.exp(-eta)))

            subj.append(subject)
            sess.append(session_index + 1)
            wave.append(session_wave_value)
            group.append(subject_group)
            game.append(trial_index % 4 + 1)
            regime.append([-1, 1][(trial_index // 4) % 2])
            social_mean.append(social)
            social_contrast.append(contrast)
            imitation.append(imitated)
            self_value.append(personal)
            previous_choice.append(last_choice)
            trial_position.append(position)
            y.append(choice)
            last_choice = 1.0 if choice else -1.0

    assert len(y) == n_trials
    return {
        "N": n_trials,
        "S": subjects,
        "J": sessions,
        "W": 2,
        "G": 4,
        "subj": subj,
        "sess": sess,
        "wave": wave,
        "group": group,
        "game": game,
        "regime": regime,
        "social_mean": social_mean,
        "social_contrast": social_contrast,
        "imitation": imitation,
        "self_value": self_value,
        "previous_choice": previous_choice,
        "trial_position": trial_position,
        "y": y,
        "session_subject": session_subject,
        "session_wave": session_wave,
        "session_group": session_group,
        "previous_session": previous_session,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile and sample both ctp-v2 Stan models.")
    parser.add_argument("--cmdstan", type=Path, default=DEFAULT_CMDSTAN)
    parser.add_argument("--output", type=Path, default=ROOT / "output" / "stan-smoke")
    parser.add_argument("--chains", type=int, default=2)
    parser.add_argument("--warmup", type=int, default=100)
    parser.add_argument("--samples", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20260831)
    args = parser.parse_args()

    configure_toolchain(args.cmdstan)
    args.output.mkdir(parents=True, exist_ok=True)
    data = make_smoke_data(args.seed)
    data_path = args.output / "smoke-data.json"
    data_path.write_text(json.dumps(data), encoding="utf-8")

    results: dict[str, dict[str, object]] = {}
    for model_name, stan_name in (
        ("pilot", "phenotype_pilot.stan"),
        ("ar1", "phenotype_longitudinal_ar1.stan"),
    ):
        model = CmdStanModel(stan_file=str(Path(__file__).with_name(stan_name)))
        fit = model.sample(
            data=data,
            chains=args.chains,
            parallel_chains=args.chains,
            iter_warmup=args.warmup,
            iter_sampling=args.samples,
            seed=args.seed,
            adapt_delta=0.95,
            max_treedepth=12,
            show_progress=False,
            output_dir=str(args.output / model_name),
        )
        method = fit.method_variables()
        draws = fit.stan_variable("phenotype_mean")
        results[model_name] = {
            "draws": int(draws.shape[0]),
            "all_draws_finite": bool(np.isfinite(draws).all()),
            "divergences": int(np.asarray(method["divergent__"]).sum()),
            "max_treedepth_hits": int(np.asarray(method["treedepth__"] >= 12).sum()),
        }

    report = {
        "cmdstan": str(args.cmdstan.resolve()),
        "cmdstan_version": "2.38.0",
        "data": {"subjects": data["S"], "sessions": data["J"], "trials": data["N"], "waves": data["W"]},
        "sampler": {"chains": args.chains, "warmup": args.warmup, "samples": args.samples},
        "models": results,
        "passed": all(item["all_draws_finite"] for item in results.values()),
        "note": "This is a toolchain smoke test, not an inferential convergence assessment.",
    }
    (args.output / "smoke-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
