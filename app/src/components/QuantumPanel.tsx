import { QUANTUM_MODE_NOTE } from "../constants";
import { formatYears, groverExtrapolation12Words, sci } from "../grover";
import { LotteryDisclosure } from "./LotteryDisclosure";

interface QuantumPanelProps {
  /**
   * Whether the run pins the user's own phrase first (own-wallet target) —
   * false pins the shared calibration phrase. Drives the lottery
   * disclosure's pinned-candidate copy, mirroring the API's lotteryNote().
   */
  pinnedIsUserPhrase: boolean;
}

/**
 * Quantum mode's honest leg: the ANALYTIC Grover extrapolation panel.
 * Closed-form arithmetic from the pinned research note's formulas
 * (art_MRbA2s2H §1.4/§3, decision doc §3 mode-3 table) — no toy run, no
 * fake progress bar, nothing spins. The classical search beside it is the
 * same full-space lottery every other mode runs; this panel is where the
 * honesty about the quantum part lives.
 */
export function QuantumPanel({ pinnedIsUserPhrase }: QuantumPanelProps) {
  const x = groverExtrapolation12Words();
  return (
    <section className="card quantum-panel" aria-label="Quantum mode — Grover extrapolation">
      <div className="card-title-row">
        <h2>Quantum mode — the honest Grover math</h2>
        <span className="level-badge normal">analytic — nothing runs</span>
      </div>
      <p className="verdict ok panel-copy">
        Grover's √N speedup is real; it turns an impossible number into a
        different impossible number.
      </p>
      <div className="kv">
        <span className="kv-key">phrase space (raw, pre-checksum)</span>
        <span className="kv-value mono">
          2048^12 = 2^132 ≈ {sci(x.rawPhrases)} phrases
        </span>
        <span className="kv-key">
          phrase space (checksum-valid — what the lottery draws)
        </span>
        <span className="kv-value mono">
          2^128 ≈ {sci(x.validPhrases)} phrases
        </span>
        <span className="kv-key">Grover oracle calls</span>
        <span className="kv-value mono">
          (π/4)·2^66 ≈ {sci(x.oracleCalls)} (≈{x.effectiveSecurityBits}-bit
          effective security)
        </span>
        <span className="kv-key">wall-clock at a fantastical 1 ns/oracle-call</span>
        <span className="kv-value mono">≈ {formatYears(x.yearsAtOneNs)} years</span>
      </div>
      <p className="verdict bad the-catch">
        The catch, always: each “call” is a reversible PBKDF2→address circuit
        ≈ 4×10^3–8×10^3 SHA-512 compressions [derived] — and even a plain
        SHA-256 oracle costs ≈ 12 s/call on a planet-scale fault-tolerant
        machine (Amy et al., arXiv:1603.09383). Multiply, don’t divide: the
        per-call depth is exactly what the 1 ns figure above pretends away.
      </p>
      <p className="note">
        This panel is closed-form arithmetic, computed from the pinned Grover
        research note’s formulas — no simulation runs here, no progress bar,
        nothing spins. Pressing Start does NOT run Grover: it starts the
        classical full-space lottery (odds{" "}
        below) and this math stands next to it unchanged.
      </p>
      <LotteryDisclosure pinnedIsUserPhrase={pinnedIsUserPhrase} />
      <p className="note muted">{QUANTUM_MODE_NOTE}</p>
    </section>
  );
}
