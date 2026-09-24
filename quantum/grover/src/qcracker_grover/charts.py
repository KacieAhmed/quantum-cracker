"""Comparison figures per the research doc's chart spec (section 5).

Three figures, all produced headlessly:

* ``fig1_scaling_loglog.png`` - classical O(N) vs Grover O(sqrt(N)) oracle
  calls, shaded simulated region (n = 8..20), extrapolation annotations at
  the real 132-bit keyspace. Pure arithmetic - no simulation needed.
* ``fig2_wallclock.png`` - wall-clock for ~2^66 oracle calls at hypothetically
  perfect per-call rates; the honest-optimism chart.
* ``fig3_amplification.png`` - amplitude amplification at demo scale: measured
  success probability vs iterations with the analytic sin^2((2t+1)theta)
  curve, the t_opt marker, and the marked-state amplitude trajectory.
"""

from __future__ import annotations

import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402

from .engine import sweep  # noqa: E402
from .toy import DEFAULT_TARGET  # noqa: E402

# Research doc section 3: hypothetical oracle rates -> years for ~2^66 calls.
WALLCLOCK_YEARS = {
    "1 ns / call (1 GHz)": 2_340.0,
    "1 us / call": 2.3e6,
    "1 ms / call": 2.3e9,
    "1 s / call": 2.3e12,
}
UNIVERSE_AGE_YEARS = 1.38e10

# Research doc section 5, chart 1.
DEMO_REGION_BITS = (8, 20)
REAL_KEYSPACE_BITS = 132

# Research doc section 1.4: IBM lesson N=8 shot data (t, p).
IBM_LESSON_N8 = [(2, 977 / 1024), (3, 334 / 1024), (4, 14 / 1024)]


def fig_scaling(path: Path) -> Path:
    """Chart 1: oracle calls vs keyspace, classical vs Grover, log-log."""
    bits = list(range(8, 134))
    classical = [float(1 << n) for n in bits]
    grover = [(math.pi / 4) * math.sqrt(float(1 << n)) for n in bits]

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(bits, classical, label="classical exhaustive: O(N)", lw=2)
    ax.plot(bits, grover, label="Grover: O((pi/4) sqrt(N))", lw=2)
    ax.set_yscale("log")
    ax.axvspan(
        DEMO_REGION_BITS[0],
        DEMO_REGION_BITS[1],
        alpha=0.25,
        color="tab:green",
        label="simulated in this repo (toy oracle)",
    )
    ax.text(
        14,
        1e38,
        "simulated\n(n = 8..20)",
        ha="center",
        va="top",
        fontsize=9,
        color="tab:green",
    )
    ax.axvline(REAL_KEYSPACE_BITS, color="gray", ls="--", lw=1)
    ax.annotate(
        "n = 132 (12-word BIP-39):\n"
        "classical 2^132 ~ 5.4e39\n"
        "Grover (pi/4) 2^66 ~ 5.8e19\n"
        "~10^20 fewer - and still far\n"
        "too many to run (2^66 deep\n"
        "coherent circuits)",
        xy=(REAL_KEYSPACE_BITS, grover[-1]),
        xytext=(96, 1e3),
        fontsize=9,
        arrowprops={"arrowstyle": "->", "color": "gray"},
    )
    ax.set_xlabel("keyspace size (bits n, N = 2^n)")
    ax.set_ylabel("search evaluations (log scale)")
    ax.set_title("Oracle calls vs keyspace: classical O(N) vs Grover O(sqrt N)")
    ax.grid(True, which="both", alpha=0.3)
    ax.legend(loc="lower left", fontsize=9)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def fig_wallclock(path: Path) -> Path:
    """Chart 2: wall-clock at the real keyspace under fictional oracle rates."""
    labels = list(WALLCLOCK_YEARS)
    years = [WALLCLOCK_YEARS[label] for label in labels]

    fig, ax = plt.subplots(figsize=(10, 5))
    bars = ax.barh(labels, years, color="tab:blue", alpha=0.8)
    ax.set_xscale("log")
    ax.axvline(
        UNIVERSE_AGE_YEARS,
        color="tab:red",
        ls="--",
        lw=1.5,
        label="age of the universe (1.4e10 yr)",
    )
    for bar, years_val in zip(bars, years):
        ax.text(
            years_val * 1.3,
            bar.get_y() + bar.get_height() / 2,
            f"{years_val:.1e} yr",
            va="center",
            fontsize=9,
        )
    ax.set_xlim(right=max(years) * 40)
    ax.set_xlabel("years for ~2^66 oracle calls (log scale)")
    ax.set_title(
        "Wall-clock at the 132-bit keyspace - granting a *fictionally perfect* oracle"
    )
    ax.text(
        0.02,
        0.02,
        "Every bar assumes the full PBKDF2 -> address derivation is computed\n"
        "coherently at the stated rate in ONE nanosecond-class step; the real\n"
        "oracle is a deep reversible circuit, multiplying these times manyfold.",
        transform=ax.transAxes,
        fontsize=8,
        va="bottom",
    )
    ax.grid(True, which="both", alpha=0.3, axis="x")
    ax.legend(loc="lower right", fontsize=9)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def fig_amplification(sweep_data: dict, path: Path) -> Path:
    """Chart 3: success probability and amplitude vs iterations, sim + theory."""
    points = sweep_data["points"]
    ts = [p["t"] for p in points]
    p_sim = [p["p_sim"] for p in points]
    p_theory = [p["p_theory"] for p in points]
    n_bits = sweep_data["n_bits"]
    marked = sweep_data["marked_count"]
    t_opt = sweep_data["t_opt"]

    theta = math.asin(math.sqrt(marked / (1 << n_bits)))
    amplitudes = [math.sin((2 * t + 1) * theta) for t in ts]

    fig, (ax_p, ax_a) = plt.subplots(1, 2, figsize=(11, 5))

    ax_p.plot(ts, p_theory, label="theory: sin^2((2t+1) theta)", lw=2)
    ax_p.plot(ts, p_sim, "o", label=f"simulation (n={n_bits}, exact)", ms=5)
    # The IBM lesson's N=8 over-rotation as its own series: its own analytic
    # curve (dashed) with the lesson's three shot-data points on it.
    t_ibm = [p[0] for p in IBM_LESSON_N8]
    theta_n8 = math.asin(math.sqrt(1 / 8))
    t_grid = list(range(0, max(t_ibm) + 3))
    ax_p.plot(
        t_grid,
        [math.sin((2 * t + 1) * theta_n8) ** 2 for t in t_grid],
        ls="--",
        lw=1.2,
        color="tab:red",
        alpha=0.7,
        label="N=8 analytic (lesson keyspace)",
    )
    ax_p.plot(
        t_ibm,
        [p[1] for p in IBM_LESSON_N8],
        "x",
        color="tab:red",
        ms=8,
        label="IBM lesson N=8 shot data",
    )
    ax_p.axvline(t_opt, color="gray", ls="--", lw=1.5, label=f"t_opt = {t_opt}")
    ax_p.set_xlabel("Grover iterations t")
    ax_p.set_ylabel("success probability")
    ax_p.set_title("Amplitude amplification: success vs iterations")
    ax_p.set_ylim(-0.05, 1.05)
    ax_p.grid(True, alpha=0.3)
    ax_p.legend(fontsize=8, loc="lower right")

    ax_a.plot(ts, amplitudes, lw=2, color="tab:purple")
    ax_a.axhline(0.0, color="black", lw=0.8)
    ax_a.axvline(t_opt, color="gray", ls="--", lw=1.5)
    ax_a.text(
        t_opt + 0.3,
        0.05,
        f"t_opt = {t_opt}",
        fontsize=9,
        color="gray",
    )
    ax_a.set_xlabel("Grover iterations t")
    ax_a.set_ylabel("marked-state amplitude  sin((2t+1) theta)")
    ax_a.set_title("The amplitude rotates; probability is its square")
    ax_a.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def make_all(figures_dir: Path, n_bits: int = 8) -> list[Path]:
    """Generate all three figures into ``figures_dir``; default sweep is exact."""
    figures_dir.mkdir(parents=True, exist_ok=True)
    paths = [
        fig_scaling(figures_dir / "fig1_scaling_loglog.png"),
        fig_wallclock(figures_dir / "fig2_wallclock.png"),
    ]
    sweep_data = sweep(
        n_bits=n_bits,
        target=DEFAULT_TARGET & ((1 << n_bits) - 1),
        max_factor=2.0,
        backend="statevector",
    )
    paths.append(fig_amplification(sweep_data, figures_dir / "fig3_amplification.png"))
    return paths
