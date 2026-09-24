import { QUANTUM_NOTE } from "../constants";

interface QuantumConfigProps {
  bits: number;
  onBits: (bits: number) => void;
  maxBits: number;
  disabled: boolean;
}

/**
 * Quantum-mode configuration. The algorithm decision is pending; what runs
 * today is the toy Grover simulation over a 2^bits demo keyspace — never a
 * wallet search, and the note says so in exactly those terms.
 */
export function QuantumConfig({ bits, onBits, maxBits, disabled }: QuantumConfigProps) {
  return (
    <section className="card" aria-label="Quantum mode">
      <div className="card-title-row">
        <h2>Toy Grover simulation</h2>
        <span className="level-badge amber">algorithm decision pending</span>
      </div>
      <label className="bits-row">
        demo keyspace: 2<sup>{bits}</sup> = {Math.pow(2, bits).toLocaleString("en-US")} items
        <input
          type="range"
          min={2}
          max={maxBits}
          step={1}
          value={bits}
          onChange={(e) => onBits(Number(e.target.value))}
          disabled={disabled}
          aria-label="Toy keyspace bits"
        />
      </label>
      <p className="note">{QUANTUM_NOTE}</p>
    </section>
  );
}
