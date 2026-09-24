"""Toy candidate -> address derivation: one source of truth for two engines.

The ordered primitive list produced by :func:`default_schedule` drives both:

* the classical twin, :func:`apply_primitives` (plain Python integers), and
* the reversible quantum oracle, ``qcracker_grover.oracle`` (CNOT / Toffoli /
  SWAP circuits compiled from the same list, gate for gate, in the same order).

A single ordered primitive list guarantees the two cannot drift apart; the
oracle tests additionally verify circuit-vs-classical agreement on *every*
input for small widths, so a compilation bug cannot hide.

This is a toy bit-mixer shaped like the real mnemonic -> address chain (mix
the candidate's bits, compare against the target address) for an educational
Grover demo. It is deliberately NOT BIP-39/PBKDF2 and not an attack tool.
"""

from __future__ import annotations

from dataclasses import dataclass

# 64-bit golden-ratio constant - standard mixer material.
GOLDEN = 0x9E3779B97F4A7C15

# Research doc (art_MRbA2s2H) section 4.1 demo constant, used as the default
# target address once masked to the configured address width.
DEFAULT_TARGET = 0b10110011


@dataclass(frozen=True)
class XorShiftRight:
    """``x ^= x >> r`` - CNOT chain; bit i receives XOR of bit i+r (high -> low)."""

    r: int


@dataclass(frozen=True)
class XorShiftLeft:
    """``x ^= (x << s) mod 2**b`` - CNOT chain; bit i receives XOR of bit i-s."""

    s: int


@dataclass(frozen=True)
class XorConst:
    """``x ^= c`` - X gates on the set bits of c."""

    c: int


@dataclass(frozen=True)
class RotateLeft:
    """``rotl(x, k)`` over b bits - cyclic bit permutation built from SWAPs."""

    k: int


@dataclass(frozen=True)
class ToffoliShift:
    """For i = b-1 down to max(r, s): ``bit_i ^= bit_{i-r} & bit_{i-s}``.

    The only nonlinear layer. Applied sequentially, high to low, exactly as
    the circuit applies its Toffolis - classical twin and circuit agree.
    """

    r: int
    s: int


Primitive = XorShiftRight | XorShiftLeft | XorConst | RotateLeft | ToffoliShift


def default_schedule(b: int) -> tuple[Primitive, ...]:
    """Three mixing rounds with width-adaptive, deterministic parameters.

    Shifts and rotations stay in ``[1, b-1]`` so no round degenerates. The
    nonlinear Toffoli layer needs three distinct bit positions, so it is
    skipped for widths below 3 bits.
    """
    if b < 2:
        raise ValueError("keyspace width must be at least 2 bits")
    out: list[Primitive] = []
    mask = (1 << b) - 1
    for rnd in range(3):
        out.append(XorShiftRight(r=1 + (rnd % (b - 1))))
        out.append(XorShiftLeft(s=1 + ((rnd * 5) % (b - 1))))
        if b >= 3:
            r2 = 1 + (rnd % (b - 1))
            s2 = 1 + ((rnd + 1) % (b - 1))
            if s2 == r2:
                s2 = 1 + (r2 % (b - 1))
            out.append(ToffoliShift(r=r2, s=s2))
        out.append(XorConst(c=(GOLDEN >> (16 * rnd)) & mask))
        out.append(RotateLeft(k=1 + ((rnd * 3) % (b - 1))))
    return tuple(out)


def apply_primitives(x: int, b: int, primitives: tuple[Primitive, ...]) -> int:
    """Classical twin: interpret the primitive list on a b-bit integer."""
    mask = (1 << b) - 1
    x &= mask
    for p in primitives:
        if isinstance(p, XorShiftRight):
            x ^= x >> p.r
        elif isinstance(p, XorShiftLeft):
            x = (x ^ (x << p.s)) & mask
        elif isinstance(p, XorConst):
            x ^= p.c & mask
        elif isinstance(p, RotateLeft):
            k = p.k % b
            if k:
                x = ((x << k) | (x >> (b - k))) & mask
        elif isinstance(p, ToffoliShift):
            for i in range(b - 1, max(p.r, p.s) - 1, -1):
                x ^= (((x >> (i - p.r)) & 1) & ((x >> (i - p.s)) & 1)) << i
        else:  # pragma: no cover - unreachable by construction
            raise TypeError(f"unknown primitive: {p!r}")
    return x


def toy_address(x: int, b: int, a_bits: int, primitives: tuple[Primitive, ...]) -> int:
    """The 'derived address' of candidate x: low ``a_bits`` of the mixed value."""
    return apply_primitives(x, b, primitives) & ((1 << a_bits) - 1)


def find_preimages(
    target: int, n_bits: int, a_bits: int, primitives: tuple[Primitive, ...]
) -> list[int]:
    """Exhaustive classical scan of the full keyspace - the ground truth.

    Every measured candidate in the quantum run is checked against this set,
    and the marked count M feeds the optimal-iteration and sin-squared
    formulas. When the future Rust classical engine lands, this is the seam
    it replaces: same contract (list of candidates deriving to the target).
    """
    return [
        x
        for x in range(1 << n_bits)
        if toy_address(x, n_bits, a_bits, primitives) == target
    ]
