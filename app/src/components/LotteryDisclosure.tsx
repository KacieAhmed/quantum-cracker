import { lotteryOddsOneInPerHour, lotteryExpectedWaitYears } from "../keyspace";
import { sci } from "../grover";
import { CALIBRATION_PHRASE } from "../calibration";

interface LotteryDisclosureProps {
  /**
   * True when the pinned first candidate is the user's own phrase (own-wallet
   * runs); false when it is the shared calibration phrase (corpus/quantum
   * runs). Mirrors the server's lotteryNote() branch so the panel and the
   * API response always agree.
   */
  pinnedIsUserPhrase: boolean;
}

/**
 * The full-space lottery odds disclosure, shared by every lottery surface
 * (own-wallet panel, quantum mode panel). Odds are disclosed BEFORE start,
 * over the CHECKSUM-VALID space the engine actually samples (2^128 ≈
 * 3.4×10^38); the raw 2048^12 ≈ 5.4×10^39 assembly count is labeled as raw.
 * Never softened: the expected wait is the teaching point.
 */
export function LotteryDisclosure({ pinnedIsUserPhrase }: LotteryDisclosureProps) {
  // lotteryOddsOneInPerHour() IS the "1 in X" denominator (≈6.7×10^31) —
  // render it directly; inverting it here would print the raw probability.
  const odds = lotteryOddsOneInPerHour();
  const waitYears = sci(lotteryExpectedWaitYears(), 1);
  return (
    <div className="keyspace-disclosure">
      <p className="verdict ok">
        ✓ Full-space lottery: every draw picks all 12 words uniformly at
        random and keeps only checksum-valid phrases — 2^128 ≈ 3.4×10^38 valid
        phrases (2048^12 ≈ 5.4×10^39 raw assemblies before checksum
        filtering). At ~1,400 draws/s the odds of one specific phrase are
        about 1 in {sci(odds)} per hour — the expected wait is ~{waitYears}{" "}
        years, many times the age of the universe. That is the honest
        demonstration of why real wallets are safe.
      </p>
      <p className="note">
        {pinnedIsUserPhrase ? (
          <>
            Your phrase is pinned as the first candidate, labeled “pinned —
            not random”, before any sampling starts — a reproducible benchmark
            anchor. If it genuinely derives your address, the run reports a
            real match at candidate #1 and ends — that is correct behavior,
            not a bug.
          </>
        ) : (
          <>
            The calibration phrase (“{CALIBRATION_PHRASE}”) is pinned as the
            first candidate, labeled “pinned — not random”, for a reproducible
            benchmark anchor; it is not the target — the run continues into
            random sampling unless a candidate genuinely derives the address.
          </>
        )}
      </p>
      <p className="note muted">
        The run ends at its draw budget or when you stop it — it never claims
        exhaustive coverage of the 2^128 space, and no end state is a verdict
        on the target's reachability beyond that.
      </p>
    </div>
  );
}
