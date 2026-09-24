interface TickerProps {
  phrases: string[];
}

/** Recent seed-phrase candidates being tested, newest first. */
export function Ticker({ phrases }: TickerProps) {
  return (
    <section className="card" aria-label="Recent candidates">
      <h2>Recently tested phrases</h2>
      {phrases.length === 0 ? (
        <p className="note muted">waiting for lane output…</p>
      ) : (
        <ul className="ticker">
          {phrases.map((phrase, i) => (
            <li key={`${i}-${phrase}`} className={i === 0 ? "newest" : undefined}>
              {phrase}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
