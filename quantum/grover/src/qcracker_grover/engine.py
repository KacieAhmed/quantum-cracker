"""Grover assembly, execution backends, oracle-call accounting, JSON results.

Assembles the search with :func:`qiskit.circuit.library.grover_operator`
(``Q = A * S_0 * A^dg * S_f``, research doc section 4.1), runs it on
statevector-based backends (``sampler``) or Aer, and reports everything the
integration layer needs as a JSON-ready dict:

* keyspace and target, plus the classical ground truth (marked preimage set),
* oracle calls - by construction AND instrumented via ``count_ops``,
* measured outcome, success, and success probability,
* the theoretical sin^2((2t+1)*theta) value to compare against.
"""

from __future__ import annotations

import math
from importlib.metadata import version as _dist_version

from qiskit import ClassicalRegister, QuantumCircuit, transpile
from qiskit.circuit.library import grover_operator
from qiskit.primitives import StatevectorSampler
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator

from .oracle import oracle_gate
from .toy import DEFAULT_TARGET, Primitive, default_schedule, find_preimages

# Statevector-based exact probability is computed automatically up to this width.
EXACT_AUTO_MAX_QUBITS = 14

# Circuit size above which depth() is skipped (cost grows with circuit size).
DEPTH_REPORT_MAX_SIZE = 20_000


def optimal_iterations(n_bits: int, marked: int) -> int:
    """``floor(pi / (4 * asin(sqrt(M/N))))`` - the IBM tutorial formula.

    Reproduces the research doc section 1.4 reference table (t_opt = 2, 12,
    25, 50, 201, 804 for n = 3, 8, 10, 12, 16, 20 with M = 1).
    """
    if marked <= 0:
        raise ValueError("marked count must be positive")
    n_keyspace = 1 << n_bits
    return math.floor(math.pi / (4 * math.asin(math.sqrt(marked / n_keyspace))))


def theoretical_success(n_bits: int, marked: int, iterations: int) -> float:
    """sin^2((2t+1) * theta) with sin(theta) = sqrt(M/N) (research doc section 1.4)."""
    theta = math.asin(math.sqrt(marked / (1 << n_bits)))
    return math.sin((2 * iterations + 1) * theta) ** 2


def build_grover_circuit(
    n_bits: int,
    a_bits: int,
    target: int,
    primitives: tuple[Primitive, ...],
    iterations: int,
) -> QuantumCircuit:
    """H^n, then ``iterations`` Grover operators, then measure the candidates."""
    operator = grover_operator(oracle_gate(n_bits, a_bits, target, primitives))
    creg = ClassicalRegister(n_bits, "result")
    qc = QuantumCircuit(operator.num_qubits, name="grover_search")
    qc.add_register(creg)
    qc.h(range(n_bits))
    for _ in range(iterations):
        qc.compose(operator, inplace=True)
    qc.measure(range(n_bits), creg)
    return qc


def count_oracle_calls(qc: QuantumCircuit) -> int:
    """Instrumented oracle count: the labeled ``oracle`` gate appears once per
    Grover iteration after assembly (research doc section 4.3, layer 2)."""
    return int(qc.count_ops().get("oracle", 0))


def exact_success_probability(
    qc: QuantumCircuit, n_bits: int, marked: set[int]
) -> float:
    """Exact probability of measuring a marked candidate (no shot noise)."""
    qc_nm = qc.remove_final_measurements(inplace=False)
    sv = Statevector.from_int(0, 2**qc_nm.num_qubits).evolve(qc_nm)
    probs = sv.probabilities(qargs=list(range(n_bits)))
    return float(sum(probs[x] for x in marked))


def _run_counts(
    qc: QuantumCircuit, shots: int, seed: int, backend: str, optimization_level: int
) -> dict[int, int]:
    """Sample ``shots`` outcomes; keys are candidate integers."""
    if backend == "sampler":
        sampler = StatevectorSampler(default_shots=shots, seed=seed)
        data = sampler.run([qc]).result()[0].data
        raw = data.result.get_counts()
    elif backend == "aer":
        sim = AerSimulator()
        tqc = transpile(qc, sim, optimization_level=optimization_level)
        raw = sim.run(tqc, shots=shots, seed_simulator=seed).result().get_counts()
    else:
        raise ValueError(f"unknown backend: {backend!r}")
    return {int(key.replace(" ", ""), 2): count for key, count in raw.items()}


def _resolve(
    n_bits: int,
    a_bits: int | None,
    target: int | None,
    primitives: tuple[Primitive, ...] | None,
) -> tuple[int, int, tuple[Primitive, ...]]:
    a = n_bits if a_bits is None else a_bits
    if not 1 <= a <= n_bits:
        raise ValueError("address_bits must be in [1, n_bits]")
    if target is None:
        target = DEFAULT_TARGET & ((1 << a) - 1)
    sched = primitives if primitives is not None else default_schedule(n_bits)
    return a, target, sched


def run(  # noqa: PLR0913 - a demo run genuinely has this many knobs
    n_bits: int = 8,
    a_bits: int | None = None,
    target: int | None = None,
    iterations: int | None = None,
    backend: str = "sampler",
    shots: int = 1024,
    seed: int = 2026,
    exact: bool | None = None,
    primitives: tuple[Primitive, ...] | None = None,
    optimization_level: int = 1,
) -> dict:
    """One Grover run over the toy keyspace; returns a JSON-ready result dict.

    ``exact`` defaults to auto: the exact (shot-noise-free) success probability
    is computed when the circuit fits in EXACT_AUTO_MAX_QUBITS qubits.
    """
    a, t, sched = _resolve(n_bits, a_bits, target, primitives)
    keyspace = 1 << n_bits
    preimages = find_preimages(t, n_bits, a, sched)
    marked = set(preimages)
    m = len(preimages)
    if iterations is None:
        iterations = optimal_iterations(n_bits, m)

    qc = build_grover_circuit(n_bits, a, t, sched, iterations)
    counts = _run_counts(qc, shots, seed, backend, optimization_level)

    measured = max(counts, key=lambda x: counts[x])
    marked_shots = sum(counts.get(x, 0) for x in marked)
    want_exact = (n_bits <= EXACT_AUTO_MAX_QUBITS) if exact is None else exact
    exact_p = (
        exact_success_probability(qc, n_bits, marked) if want_exact else None
    )

    gate_counts = {name: int(cnt) for name, cnt in qc.count_ops().items()}
    return {
        "mode": "run",
        "n_bits": n_bits,
        "keyspace_size": keyspace,
        "address_bits": a,
        "target_address": t,
        "target_address_binary": bin(t),
        "iterations": iterations,
        "oracle_calls_by_construction": iterations,
        "oracle_calls_instrumented": count_oracle_calls(qc),
        "marked_count": m,
        "classical_preimages": preimages,
        "backend": backend,
        "shots": shots,
        "seed": seed,
        "measured_outcome": measured,
        "success": measured in marked,
        "success_probability": marked_shots / shots,
        "exact_success_probability": exact_p,
        "theoretical_success_probability": theoretical_success(n_bits, m, iterations),
        "gate_counts": gate_counts,
        "circuit_depth": qc.depth() if qc.size() <= DEPTH_REPORT_MAX_SIZE else None,
        "qiskit_version": _dist_version("qiskit"),
    }


def sweep(
    n_bits: int = 8,
    a_bits: int | None = None,
    target: int | None = None,
    max_factor: float = 2.0,
    backend: str = "statevector",
    shots: int = 4096,
    seed: int = 2026,
    primitives: tuple[Primitive, ...] | None = None,
    optimization_level: int = 1,
) -> dict:
    """Success probability vs iteration count, simulation AND theory per point.

    ``backend="statevector"`` (default) computes exact, shot-noise-free
    probabilities - the curve the sin^2 agreement certificate is checked
    against. Shot backends (``sampler``, ``aer``) sample like real hardware.
    """
    a, t, sched = _resolve(n_bits, a_bits, target, primitives)
    keyspace = 1 << n_bits
    preimages = find_preimages(t, n_bits, a, sched)
    marked = set(preimages)
    m = len(preimages)
    t_opt = optimal_iterations(n_bits, m)
    t_max = max(1, math.ceil(max_factor * t_opt))

    points = []
    for it in range(t_max + 1):
        qc = build_grover_circuit(n_bits, a, t, sched, it)
        if backend == "statevector":
            p_sim = exact_success_probability(qc, n_bits, marked)
        else:
            counts = _run_counts(qc, shots, seed + it, backend, optimization_level)
            p_sim = sum(counts.get(x, 0) for x in marked) / shots
        points.append(
            {
                "t": it,
                "p_sim": p_sim,
                "p_theory": theoretical_success(n_bits, m, it),
            }
        )

    return {
        "mode": "sweep",
        "n_bits": n_bits,
        "keyspace_size": keyspace,
        "address_bits": a,
        "target_address": t,
        "target_address_binary": bin(t),
        "marked_count": m,
        "classical_preimages": preimages,
        "t_opt": t_opt,
        "t_max": t_max,
        "backend": backend,
        "points": points,
        "qiskit_version": _dist_version("qiskit"),
    }
