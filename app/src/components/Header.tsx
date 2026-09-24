import { CHAINS, MODES } from "../api";
import type { Chain, Mode } from "../types";

interface HeaderProps {
  chain: Chain;
  mode: Mode;
  onChain: (chain: Chain) => void;
  onMode: (mode: Mode) => void;
  /** Toggles lock while a run is active — mid-run switching would strand the lanes view. */
  disabled: boolean;
}

function Segmented<T extends string>({
  options,
  value,
  onSelect,
  disabled,
  ariaLabel,
}: {
  options: readonly T[];
  value: T;
  onSelect: (v: T) => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  const labels: Record<T, string> = {
    bitcoin: "Bitcoin",
    ethereum: "Ethereum",
    classic: "Classic",
    quantum: "Quantum",
  } as Record<T, string>;
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`segment${option === value ? " active" : ""}`}
          aria-pressed={option === value}
          disabled={disabled}
          onClick={() => onSelect(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

export function Header({ chain, mode, onChain, onMode, disabled }: HeaderProps) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">⚛</span>
        <div>
          <h1>Quantum Cracker</h1>
          <p className="brand-sub">
            Educational demo — bundled keyspaces only. Real wallets are
            unreachable, classically and quantumly.
          </p>
        </div>
      </div>
      <div className="toggles">
        <Segmented
          options={CHAINS}
          value={chain}
          onSelect={onChain}
          disabled={disabled}
          ariaLabel="Chain"
        />
        <Segmented
          options={MODES}
          value={mode}
          onSelect={onMode}
          disabled={disabled}
          ariaLabel="Mode"
        />
      </div>
    </header>
  );
}
