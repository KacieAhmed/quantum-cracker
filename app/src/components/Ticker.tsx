interface TickerProps {
  phrases: string[];
  /** True when a match exists — none of the listed phrases is ever it. */
  matched: boolean;
}

/**
 * Live feed of seed-phrase candidates that were TESTED and did NOT match the
 * target wallet. Every entry here is, by construction, not the wallet's seed:
 * the panel says so standing, and each row carries its own badge. The only
 * valid seed is the match card, which breaks this panel's pattern on purpose.
 */
export function Ticker({ phrases, matched }: TickerProps) {
  return (
    <section className="card ticker-card" aria-label="Recently tested non-matching candidates">
      <div className="card-title-row">
        <h2>Recently tested phrases</h2>
        <span className="no-match-badge">tested — no match</span>
      </div>
      <p className="ticker-note">
        ⚠ Every phrase below was tested against the target and does{" "}
        <strong>NOT belong to the wallet</strong>. These are just the failed
        candidates as they stream past — none of them is a valid seed. Only the
        green "Match found" result, if the run produces one, is a real
        derivation of the target address.
      </p>
      {phrases.length === 0 ? (
        <p className="note muted">waiting for lane output…</p>
      ) : (
        <ul className="ticker">
          {phrases.map((phrase, i) => (
            <li key={`${i}-${phrase}`} className={i === 0 ? "newest" : undefined}>
              <span className="phrase-badge" aria-label="tested, no match">
                not the wallet's seed
              </span>
              <span className="phrase-text">{phrase}</span>
            </li>
          ))}
        </ul>
      )}
      {matched && (
        <p className="verdict ok ticker-cleared">
          ✓ The run matched — the phrase that derives the target address is in
          the result card above, not in this list. Everything listed here was
          tested first and failed.
        </p>
      )}
    </section>
  );
}
