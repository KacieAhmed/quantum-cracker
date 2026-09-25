import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelFailureMessage,
  cancelRun,
  getCorpus,
  getSystem,
  startCrack,
  validateAddress,
  wsUrl,
} from "./api";
import { FALLBACK_PER_CORE_RATE, estimateAggregateRate, etaSeconds } from "./estimate";
import { LOTTERY_ODDS_NOTE, TICKER_LIMIT, VALIDATE_DEBOUNCE_MS } from "./constants";
import { emptyRunUiState, foldMessage, type RunUiState } from "./reducer";
import type { Chain, CorpusDoc, Mode, ServerMessage, SystemInfo, TargetVerdict } from "./types";
import type { CustomWalletSelection } from "./components/CustomWalletPanel";
import { Header } from "./components/Header";
import { AddressPanel } from "./components/AddressPanel";
import { CustomWalletPanel } from "./components/CustomWalletPanel";
import { WorkerSlider } from "./components/WorkerSlider";
import { QuantumPanel } from "./components/QuantumPanel";
import { StatsBar } from "./components/StatsBar";
import { LaneGrid } from "./components/LaneGrid";
import { Ticker } from "./components/Ticker";
import { ResultPanel } from "./components/ResultPanel";
import { Infeasibility } from "./components/Infeasibility";

const DEFAULT_WORKERS = 8;

/** Live WS feed folded into UI state; capped auto-reconnect with backoff. */
function useRunFeed(): RunUiState {
  const [state, setState] = useState<RunUiState>(emptyRunUiState);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(wsUrl());
      socket.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          setState((prev) => foldMessage(prev, msg));
        } catch (err) {
          setState((prev) => ({
            ...prev,
            socketError: `unparseable live-feed message: ${String(err)}`,
          }));
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        attempts += 1;
        if (attempts <= 5) {
          setTimeout(connect, Math.min(2000 * attempts, 10_000));
        } else {
          setState((prev) => ({
            ...prev,
            socketError: "live feed disconnected after several retries — reload to reconnect",
          }));
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      socket?.close();
    };
  }, []);
  return state;
}

export default function App() {
  const [chain, setChain] = useState<Chain>("bitcoin");
  const [mode, setMode] = useState<Mode>("classic");
  const [address, setAddress] = useState("");
  const [verdict, setVerdict] = useState<TargetVerdict | null>(null);
  const [checking, setChecking] = useState(false);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [corpus, setCorpus] = useState<CorpusDoc | null>(null);
  const [corpusError, setCorpusError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<number>(DEFAULT_WORKERS);
  const [force, setForce] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [tickerPhrases, setTickerPhrases] = useState<string[]>([]);
  const [walletMode, setWalletMode] = useState(false);
  const [customWallet, setCustomWallet] = useState<CustomWalletSelection | null>(
    null,
  );
  const touchedWorkersRef = useRef(false);

  const ui = useRunFeed();
  const report = ui.report;
  const pinnedEntry = ui.pinnedEntry;
  const running = report?.status === "running";
  // Lottery runs sample the full 2^128 space: they have no finishable
  // keyspace, so coverage fractions and ETAs are meaningless and never shown.
  const lotteryRun = report?.searchKind === "lottery";
  // Address-only classic runs are the consented full-space lottery — one
  // random-sampling lane with a disclosed draw budget; no worker knob.
  const addressOnlyLottery = !walletMode && mode === "classic";

  // Machine capabilities + bundled corpus, loaded once.
  useEffect(() => {
    let disposed = false;
    getSystem()
      .then((s) => {
        if (disposed) return;
        setSystem(s);
        if (!touchedWorkersRef.current) setWorkers(s.workersDefault);
      })
      .catch((err: unknown) => {
        if (!disposed) setSystemError(err instanceof ApiError ? err.message : String(err));
      });
    getCorpus()
      .then((c) => {
        if (!disposed) setCorpus(c);
      })
      .catch((err: unknown) => {
        if (!disposed) setCorpusError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Engine-backed address validation, debounced while typing.
  useEffect(() => {
    const trimmed = address.trim();
    if (trimmed === "") {
      setVerdict(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    let stale = false;
    const timer = setTimeout(() => {
      validateAddress(trimmed)
        .then((v) => {
          if (!stale) setVerdict(v);
        })
        .catch((err: unknown) => {
          if (stale) return;
          setVerdict({
            target: trimmed,
            valid: false,
            error: err instanceof ApiError ? err.message : String(err),
          });
        })
        .finally(() => {
          if (!stale) setChecking(false);
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [address]);

  // Ticker: accumulate frontier phrases per snapshot, reset on a new run.
  // Both modes stream a candidate feed now — quantum's classical leg is the
  // same lottery, so its feed renders here too.
  const lastRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!report) return;
    if (lastRunIdRef.current !== report.runId) {
      lastRunIdRef.current = report.runId;
      setTickerPhrases([]);
    }
    const frontier = report.lanes
      .map((lane) => lane.frontierPhrase)
      .filter((p): p is string => p !== null)
      .reverse();
    if (frontier.length > 0) {
      setTickerPhrases((prev) => [...frontier, ...prev].slice(0, TICKER_LIMIT));
    }
  }, [report]);

  const onWorkers = (value: number): void => {
    touchedWorkersRef.current = true;
    setWorkers(value);
  };

  const pickDemoWallet = (): void => {
    if (!corpus || corpus.wallets.length === 0) return;
    const searchable = corpus.wallets.filter((w) => w.searchable);
    const pool = searchable.length > 0 ? searchable : corpus.wallets;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick === undefined) return;
    setAddress(chain === "ethereum" ? pick.addresses.eth : pick.addresses.btc_p2pkh);
  };

  const start = async (): Promise<void> => {
    setStartError(null);
    try {
      if (walletMode && customWallet !== null && customWallet.derived !== null) {
        await startCrack({
          chain,
          mode,
          // The derived address is the only target; a typed address is only
          // a cross-check, and no freeform address is ever sent. Marked words
          // switch the run to the limited-keyspace space that contains the
          // phrase by construction.
          customWallet: {
            mnemonic: customWallet.mnemonic,
            passphrase: customWallet.passphrase,
            ...(customWallet.expectedAddress === ""
              ? {}
              : { expectedAddress: customWallet.expectedAddress }),
            // Marked slots only apply in classic mode; quantum runs the
            // all-words-random lottery, so stale marks are never sent.
            ...(mode === "classic" && customWallet.varySlots.length > 0
              ? { varySlots: customWallet.varySlots }
              : {}),
          },
          workers,
          force,
        });
      } else {
        await startCrack({
          chain,
          mode,
          address: address.trim(),
          // Address-only run (classic or quantum) = the full-space lottery.
          // The odds are disclosed right above the start button
          // (LOTTERY_ODDS_NOTE / the quantum panel's disclosure); sending
          // probe:true is the user's informed consent to them. The server
          // refuses to start without it. Quantum mode sends no bits: its
          // classical leg is this same lottery, and the quantum math is the
          // extrapolation panel only.
          probe: true,
          workers,
          force,
        });
      }
      // A fresh run: clear stale outcome cards and the ticker.
      lastRunIdRef.current = null;
      setTickerPhrases([]);
      setForce(false);
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const cancel = async (): Promise<void> => {
    if (!report) return;
    try {
      await cancelRun(report.runId);
      setStartError(null);
    } catch (err) {
      // The run may settle between the button rendering and the click;
      // phrase every cancel outcome kindly instead of surfacing a raw error.
      setStartError(cancelFailureMessage(err));
    }
  };

  // Pre-run estimates: same model as the server, recomputed as the slider moves.
  const perCoreRate = system?.bench.perCoreDerivationsPerSec ?? FALLBACK_PER_CORE_RATE;
  const totalCandidates = corpus?.space.total_prefixes ?? null;
  const estimatedRate = estimateAggregateRate(workers, system?.cores ?? 8, perCoreRate);
  const estimatedEta =
    totalCandidates === null ? null : etaSeconds(totalCandidates, 0, estimatedRate);

  const canStart =
    !running && systemError === null && (walletMode
      ? customWallet !== null && customWallet.derived !== null
      : verdict?.valid === true && address.trim() !== "");

  const aggregate = report?.aggregate ?? null;

  return (
    <>
      <Header
        chain={chain}
        mode={mode}
        onChain={setChain}
        onMode={setMode}
        disabled={running}
      />
      <main>
        <div className="mode-switch" role="radiogroup" aria-label="Target source">
          <button
            type="button"
            className={walletMode ? "mode-btn" : "mode-btn active"}
            onClick={() => setWalletMode(false)}
            disabled={running}
          >
            Demo corpus
          </button>
          <button
            type="button"
            className={walletMode ? "mode-btn active" : "mode-btn"}
            onClick={() => setWalletMode(true)}
            disabled={running}
          >
            Your own wallet
          </button>
        </div>
        <div className="config-grid">
          {walletMode ? (
            <CustomWalletPanel
              chain={chain}
              onChain={setChain}
              mode={mode}
              disabled={running}
              estimatedRate={estimatedRate}
              onDerived={setCustomWallet}
            />
          ) : (
            <AddressPanel
              address={address}
              onAddress={setAddress}
              verdict={verdict}
              checking={checking}
              corpus={corpus}
              corpusError={corpusError}
              onDemoWallet={pickDemoWallet}
              disabled={running}
            />
          )}
          {mode === "classic" ? (
            addressOnlyLottery ? (
              <section className="card" aria-label="Lottery run shape">
                <div className="card-title-row">
                  <h2>How this run works</h2>
                </div>
                <p className="note">
                  One random-sampling lane draws ALL 12 words at random over the
                  full checksum-valid phrase space, at a disclosed draw budget —
                  worker count does not apply. The pinned calibration phrase is
                  tested first (labeled “pinned — not random”), then random
                  draws begin; the run ends at the budget or when you stop it.
                </p>
              </section>
            ) : (
              <WorkerSlider
                workers={workers}
                onWorkers={onWorkers}
                system={system}
                force={force}
                onForce={setForce}
                disabled={running}
                estimatedRate={estimatedRate}
                estimatedEta={estimatedEta}
                totalCandidates={totalCandidates}
              />
            )
          ) : (
            // The quantum panel is analytic-only — there is nothing to
            // configure. The classical leg beside it uses the same worker
            // setting and lottery the classic modes run.
            <QuantumPanel
              pinnedIsUserPhrase={
                walletMode && customWallet !== null && customWallet.derived !== null
              }
            />
          )}
        </div>

        {addressOnlyLottery && (
          <p className="note lottery-disclosure" role="note">
            {LOTTERY_ODDS_NOTE}
          </p>
        )}
        <div className="start-row">
          <button type="button" className="btn primary" onClick={start} disabled={!canStart}>
            {mode === "quantum"
              ? walletMode
                ? "Run lottery on MY wallet"
                : "Start full-space lottery"
              : walletMode
                ? "Search for MY wallet"
                : "Start search"}
          </button>
          {running && (
            <button type="button" className="btn danger" onClick={cancel}>
              Cancel run
            </button>
          )}
          {startError !== null && <p className="bad-note">{startError}</p>}
        </div>
        {systemError !== null && (
          <p className="note bad-note">
            API unavailable ({systemError}) — start it with <code>npm run dev</code> in api/.
          </p>
        )}
        {ui.socketError !== null && <p className="note bad-note">{ui.socketError}</p>}

        {report !== null && (
          <>
            <StatsBar
              derived={aggregate?.derived ?? 0}
              rate={aggregate?.derivedPerSec ?? null}
              fraction={lotteryRun ? 0 : (aggregate?.fractionOfKeyspace ?? 0)}
              eta={lotteryRun ? null : (aggregate?.etaSeconds ?? null)}
              measured={aggregate !== null}
            />
            <LaneGrid lanes={report.lanes} />
            <Ticker
              phrases={tickerPhrases}
              matched={report.status === "matched"}
              pinned={pinnedEntry}
            />
          </>
        )}

        <ResultPanel ui={ui} chain={chain} />
        {report === null && <Infeasibility />}
      </main>
      <footer>
        <p className="note">
          Educational demonstration. No external wallet APIs are contacted; all derivation is
          local. Demo wallets only.
        </p>
      </footer>
    </>
  );
}
