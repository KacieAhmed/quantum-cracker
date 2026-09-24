"""Reversible oracle: diagonal phase pattern must match the classical predicate.

This is the circuit-vs-classical agreement certificate (research doc 4.1,
"classical twin first"): for every basis state the compiled circuit's phase
must equal -1 exactly when the classical twin derives x to the target.
"""

import numpy as np
import pytest
from qiskit.quantum_info import Operator

from qcracker_grover.oracle import build_toy_oracle, oracle_gate
from qcracker_grover.toy import DEFAULT_TARGET, default_schedule, toy_address


@pytest.mark.parametrize("n,a", [(3, 3), (4, 3), (5, 4)])
@pytest.mark.parametrize("target_pick", [0, 1, 5, DEFAULT_TARGET])
def test_oracle_marks_exactly_the_classical_preimages(n, a, target_pick):
    target = target_pick & ((1 << a) - 1)
    sched = default_schedule(n)
    mat = Operator(build_toy_oracle(n, a, target, sched)).data

    # A phase oracle is diagonal with unit-modulus entries.
    assert np.allclose(mat, np.diag(np.diag(mat)))
    for x in range(1 << n):
        expected = -1.0 if toy_address(x, n, a, sched) == target else 1.0
        assert np.isclose(mat[x, x].real, expected), f"phase wrong at x={x}"
        assert np.isclose(mat[x, x].imag, 0.0)


@pytest.mark.parametrize("n,a", [(3, 3), (5, 3)])
def test_oracle_is_self_inverse(n, a):
    sched = default_schedule(n)
    target = 5 & ((1 << a) - 1)
    mat = Operator(build_toy_oracle(n, a, target, sched)).data
    assert np.allclose(mat @ mat, np.eye(1 << n))


def test_oracle_gate_label_preserved_for_instrumentation():
    sched = default_schedule(3)
    gate = oracle_gate(3, 3, 5, sched)
    assert gate.label == "oracle"
    circuit_form = build_toy_oracle(3, 3, 5, sched)
    assert Operator(gate).equiv(Operator(circuit_form))
