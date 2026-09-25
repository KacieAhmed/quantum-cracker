/**
 * Shared segmented toggle: a role="group" of aria-pressed buttons. Used for
 * the header's chain/mode switches and the own-wallet panel's in-panel chain
 * choice — one pattern everywhere a small exclusive option set is presented.
 */
export function Segmented<T extends string>({
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
