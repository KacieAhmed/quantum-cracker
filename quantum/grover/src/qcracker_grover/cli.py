"""Headless CLI: ``python -m qcracker_grover {run,sweep,charts}``.

Every subcommand prints its JSON payload to stdout; ``--output`` also writes
it to a file so the future integration layer can consume results directly.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--n-bits", type=int, default=8, help="keyspace bits n (N = 2^n)")
    p.add_argument(
        "--address-bits", type=int, default=None, help="address width a <= n (default n => M=1)"
    )
    p.add_argument(
        "--target", type=int, default=None, help="target address (default: doc demo constant)"
    )
    p.add_argument("--seed", type=int, default=2026, help="RNG seed for shot backends")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qcracker-grover",
        description=(
            "Educational Grover search over toy seed-phrase keyspaces. "
            "Not an attack tool: see the honest-scaling notes in the README."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="one Grover run; JSON result")
    _add_common(run_p)
    run_p.add_argument("--iterations", type=int, default=None, help="override t (default t_opt)")
    run_p.add_argument("--backend", choices=["sampler", "aer"], default="sampler")
    run_p.add_argument("--shots", type=int, default=1024)
    run_p.add_argument("--no-exact", action="store_true", help="skip the exact success probability")
    run_p.add_argument("--output", type=Path, default=None, help="also write JSON here")

    sweep_p = sub.add_parser("sweep", help="success probability vs iterations; JSON result")
    _add_common(sweep_p)
    sweep_p.add_argument(
        "--max-factor", type=float, default=2.0, help="sweep t up to factor * t_opt"
    )
    sweep_p.add_argument(
        "--backend",
        choices=["statevector", "sampler", "aer"],
        default="statevector",
        help="statevector = exact, no shot noise",
    )
    sweep_p.add_argument("--shots", type=int, default=4096)
    sweep_p.add_argument("--output", type=Path, default=None, help="also write JSON here")

    charts_p = sub.add_parser("charts", help="generate the comparison figures")
    charts_p.add_argument("--figures-dir", type=Path, default=Path("figures"))
    charts_p.add_argument(
        "--n-bits", type=int, default=8, help="keyspace width for the amplification sweep"
    )
    charts_p.add_argument("--seed", type=int, default=2026)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.command == "run":
        # Imported here so --help and charts stay import-light.
        from .engine import run as run_grover

        payload = run_grover(
            n_bits=args.n_bits,
            a_bits=args.address_bits,
            target=args.target,
            iterations=args.iterations,
            backend=args.backend,
            shots=args.shots,
            seed=args.seed,
            exact=not args.no_exact,
        )
    elif args.command == "sweep":
        from .engine import sweep

        payload = sweep(
            n_bits=args.n_bits,
            a_bits=args.address_bits,
            target=args.target,
            max_factor=args.max_factor,
            backend=args.backend,
            shots=args.shots,
            seed=args.seed,
        )
    elif args.command == "charts":
        from .charts import make_all

        paths = make_all(args.figures_dir, n_bits=args.n_bits)
        payload = {"mode": "charts", "figures": [str(p) for p in paths]}
    else:  # pragma: no cover - argparse restricts choices
        raise AssertionError(f"unreachable: {args.command}")

    text = json.dumps(payload, indent=2)
    print(text)
    if getattr(args, "output", None):
        args.output.write_text(text + "\n", encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
