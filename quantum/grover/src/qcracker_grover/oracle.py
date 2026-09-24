"""Reversible-circuit compilation of the toy derivation chain (phase oracle).

Builds the phase oracle ``S_f : |x> -> (-1)^{f(x)} |x>`` where ``f(x) = 1``
iff candidate ``x`` derives to the target address - a genuine
compute -> compare -> uncompute circuit, never a hardcoded marked state:

1. **Compute** - the toy mixing chain, compiled gate-for-gate from the same
   primitive list the classical twin interprets (CNOTs for XOR-shifts, SWAPs
   for rotations, Toffolis for the nonlinear layer, Xs for constants).
2. **Compare** - X-conjugated multi-controlled Z on the low ``a_bits``
   qubits flips the phase exactly when they equal the target. No ancillas.
3. **Uncompute** - the inverse mixing circuit restores the candidate register,
   leaving a pure phase on the matching states.

Qubit ``i`` of the oracle circuit is bit ``i`` of the candidate integer
(little-endian), so basis states map directly to candidate integers.
"""

from __future__ import annotations

from qiskit import QuantumCircuit

from .toy import (
    Primitive,
    RotateLeft,
    ToffoliShift,
    XorConst,
    XorShiftLeft,
    XorShiftRight,
)

ORACLE_LABEL = "oracle"


def append_primitive(qc: QuantumCircuit, prim: Primitive, b: int) -> None:
    """Compile one primitive to gates, in the order the classical twin applies it."""
    if isinstance(prim, XorShiftRight):
        # x ^= x >> r: bit_i of (x >> r) is old bit_{i+r}, so information flows
        # from high bits to low bits: bit_i ^= bit_{i+r}, i ascending. Controls
        # sit above every previously touched target, preserving one-shot semantics.
        for i in range(b - prim.r):
            qc.cx(i + prim.r, i)
    elif isinstance(prim, XorShiftLeft):
        # x ^= (x << s): bit_i of (x << s) is old bit_{i-s}: bit_i ^= bit_{i-s},
        # i descending. Controls stay below the already-modified targets.
        for i in range(b - 1, prim.s - 1, -1):
            qc.cx(i - prim.s, i)
    elif isinstance(prim, XorConst):
        for i in range(b):
            if (prim.c >> i) & 1:
                qc.x(i)
    elif isinstance(prim, RotateLeft):
        # rotl(x, k) == rotr(x, b-k); one rotr step is the swap chain
        # swap(0,1), swap(1,2), ..., swap(b-2, b-1).
        chains = (b - (prim.k % b)) % b
        for _ in range(chains):
            for i in range(b - 1):
                qc.swap(i, i + 1)
    elif isinstance(prim, ToffoliShift):
        for i in range(b - 1, max(prim.r, prim.s) - 1, -1):
            qc.ccx(i - prim.r, i - prim.s, i)
    else:  # pragma: no cover - unreachable by construction
        raise TypeError(f"unknown primitive: {prim!r}")


def build_mix_circuit(n: int, primitives: tuple[Primitive, ...]) -> QuantumCircuit:
    """The reversible compute step: candidate register -> mixed register, in place."""
    qc = QuantumCircuit(n, name="mix")
    for prim in primitives:
        append_primitive(qc, prim, n)
    return qc


def _append_compare_flip(qc: QuantumCircuit, a_bits: int, target: int) -> None:
    """Phase flip on the basis state whose low a_bits equal ``target``.

    X-conjugation on the bits where ``target`` is 0 maps 'bits == target' to
    'bits == all ones' (X flips bit i, so |x> -> |x XOR mask>; masking the
    ZERO bits of target makes the XOR map target to 1...1, not to ~target),
    then a multi-controlled Z (H, MCX, H) applies the phase. Restores all bits.
    """
    for i in range(a_bits):
        if not (target >> i) & 1:
            qc.x(i)
    if a_bits == 1:
        qc.z(0)
    else:
        qc.h(a_bits - 1)
        qc.mcx(list(range(a_bits - 1)), a_bits - 1)
        qc.h(a_bits - 1)
    for i in range(a_bits):
        if not (target >> i) & 1:
            qc.x(i)


def build_toy_oracle(
    n: int, a_bits: int, target: int, primitives: tuple[Primitive, ...]
) -> QuantumCircuit:
    """Phase oracle marking candidates that derive to ``target`` - no ancillas."""
    mix = build_mix_circuit(n, primitives)
    qc = QuantumCircuit(n, name=ORACLE_LABEL)
    qc.compose(mix, inplace=True)
    _append_compare_flip(qc, a_bits, target)
    qc.compose(mix.inverse(), inplace=True)
    return qc


def oracle_gate(
    n: int, a_bits: int, target: int, primitives: tuple[Primitive, ...]
):
    """The oracle as a labeled gate.

    Passing the labeled gate (rather than the bare circuit) to
    ``grover_operator`` keeps an ``oracle`` instruction visible in
    ``count_ops``, which is how oracle calls are instrumented per run
    (research doc section 4.3).
    """
    return build_toy_oracle(n, a_bits, target, primitives).to_gate(label=ORACLE_LABEL)
