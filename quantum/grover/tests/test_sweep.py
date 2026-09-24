"""Sweep: simulation matches sin^2((2t+1) theta) and peaks at t_opt."""

import pytest

from qcracker_grover.engine import sweep


def test_sweep_matches_theory_and_peaks_at_t_opt():
    data = sweep(n_bits=3, max_factor=2, backend="statevector")
    points = data["points"]
    assert len(points) == 2 * data["t_opt"] + 1
    for point in points:
        assert point["p_sim"] == pytest.approx(point["p_theory"], abs=1e-9)
    best = max(points, key=lambda p: p["p_sim"])
    assert best["t"] == data["t_opt"] == 2
    assert best["p_sim"] == pytest.approx(121 / 128, abs=1e-9)
    # Over-rotation: past the peak the curve falls again (doc section 1.4).
    assert points[3]["p_sim"] < best["p_sim"]
    assert points[4]["p_sim"] < points[3]["p_sim"]


def test_sweep_starts_from_uniform():
    data = sweep(n_bits=3, max_factor=1, backend="statevector")
    assert data["points"][0]["p_sim"] == pytest.approx(1 / 8)
