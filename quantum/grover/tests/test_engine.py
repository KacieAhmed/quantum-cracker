"""Engine: t_opt table vs the research doc, oracle accounting, end-to-end runs."""

import math

import pytest

from qcracker_grover.engine import (
    build_grover_circuit,
    count_oracle_calls,
    optimal_iterations,
    run,
    theoretical_success,
)
from qcracker_grover.toy import DEFAULT_TARGET, default_schedule

# Research doc section 1.4 reference table (M = 1).
DOC_T_OPT = {3: 2, 8: 12, 10: 25, 12: 50, 16: 201, 20: 804}


@pytest.mark.parametrize(("n_bits", "expected"), sorted(DOC_T_OPT.items()))
def test_optimal_iterations_matches_doc(n_bits, expected):
    assert optimal_iterations(n_bits, 1) == expected


def test_theory_n8_t2_is_exactly_121_over_128():
    # sin^2(5 theta) with sin(theta) = 1/sqrt(8) - the doc's smoke-test anchor.
    assert theoretical_success(3, 1, 2) == pytest.approx(121 / 128)


def test_oracle_call_accounting_matches_construction():
    sched = default_schedule(4)
    qc = build_grover_circuit(4, 4, DEFAULT_TARGET & 0xF, sched, 7)
    assert count_oracle_calls(qc) == 7  # instrumented via count_ops


def test_smoke_smallest_keyspace():
    """Acceptance smoke test: smallest keyspace (N = 8), genuine oracle.

    Asserts the marked item is recovered with high probability and the
    oracle-call count matches theory (t_opt = 2 for N = 8, M = 1).
    """
    result = run(n_bits=3, shots=1024, seed=2026)
    assert result["marked_count"] == 1
    assert result["oracle_calls_by_construction"] == 2
    assert result["oracle_calls_instrumented"] == 2
    assert result["measured_outcome"] == result["classical_preimages"][0]
    assert result["success"] is True
    assert result["success_probability"] >= 0.9
    assert result["exact_success_probability"] == pytest.approx(
        result["theoretical_success_probability"], abs=1e-9
    )


def test_n8_exact_success_near_certainty():
    result = run(n_bits=8, shots=512, seed=2026)
    assert result["oracle_calls_by_construction"] == 12
    assert result["exact_success_probability"] > 0.999
    assert result["success"] is True


def test_run_respects_truncated_address_width():
    result = run(n_bits=8, a_bits=6, shots=512, seed=2026)
    assert result["marked_count"] == 1 << (8 - 6)
    expected_t = math.floor(math.pi / (4 * math.asin(math.sqrt(4 / 256))))
    assert result["iterations"] == expected_t
    assert result["measured_outcome"] in result["classical_preimages"]
