interface TickerProps {
  phrases: string[];
  /** True when a match exists — none of the listed phrases is ever it. */
  matched: boolean;
  /** The pinned first candidate, if this run pinned one. */
  pinned?: { runId: string; phrase: string; label: string; tested: boolean } | null;
  /** "pubkey" = pre-seed draws: rows are public keys, not seed phrases. */
  variant?: "phrase" | "pubkey";
}

/**
 * Live feed of seed-phrase candidates that were TESTED and did NOT match the
 * target wallet. Every entry here is, by construction, not the wallet's seed:
 * the panel says so standing, and each row carries its own badge. The only
 * valid seed is the match card, which breaks this panel's pattern on purpose.
 */
export function Ticker({ phrases, matched, pinned = null, variant = "phrase" }: TickerProps) {
  const pubkeyFeed = variant === "pubkey";
  return (
    <section
      className="card ticker-card"
      aria-label={pubkeyFeed ? "Recently tested non-matching public keys" : "Recently tested non-matching candidates"}
    >
      <div className="card-title-row">
        <h2>{pubkeyFeed ? "Recently tested public keys" : "Recently tested phrases"}</h2>
        <span className="no-match-badge">tested — no match</span>
      </div>
      {pubkeyFeed ? (
        <p className="ticker-note">
          ⚠ Every public key below was derived from a random draw and is{" "}
          <strong>NOT on the watchlist</strong> — these are just the failed
          draws as they stream past. There is no wallet here to belong to:
          only a watchlist DISCOVERY, shown in the result card, stops the run.
        </p>
      ) : (
        <p className="ticker-note">
          ⚠ Every phrase below was tested against the target and does{" "}
          <strong>NOT belong to the wallet</strong>. These are just the failed
          candidates as they stream past — none of them is a valid seed. Only the
          green "Match found" result, if the run produces one, is a real
          derivation of the target address.
        </p>
      )}
      {phrases.length === 0 && pinned === null ? (
        <p className="note muted">waiting for lane output…</p>
      ) : (
        <ul className="ticker">
          {pinned !== null && (
            <li key="pinned-first" className="newest">
              <span
                className="phrase-badge pinned"
                aria-label={pinned.tested ? "pinned, tested first, no match" : "pinned, skipped"}
              >
                {pinned.label}
              </span>
              <span className="phrase-text">{pinned.phrase}</span>
            </li>
          )}
          {phrases.map((phrase, i) => (
            <li key={`${i}-${phrase}`} className={i === 0 && pinned === null ? "newest" : undefined}>
              <span className="phrase-badge" aria-label="tested, no match">
                {pubkeyFeed ? "not on the watchlist" : "not the wallet's seed"}
              </span>
              <span className="phrase-text">{phrase}</span>
            </li>
          ))}
        </ul>
      )}
      {matched && (
        <p className="verdict ok ticker-cleared">
          ✓ The run matched — {pubkeyFeed ? "the discovered key material is in the result card above, not in this list" : "the phrase that derives the target address is in the result card above, not in this list"}. Everything listed here was
          tested first and failed.
        </p>
      )}
    </section>
  );
}
