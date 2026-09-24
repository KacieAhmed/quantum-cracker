import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelRun,
  getCorpus,
  getSystem,
  startCrack,
  validateAddress,
  wsUrl,
} from "./api";
import { FALLBACK_PER_CORE_RATE, estimateAggregateRate, etaSeconds } from "./estimate";
import { TICKER_LIMIT, VALIDATE_DEBOUNCE_MS } from "./constants";
import { emptyRunUiState, foldMessage, type RunUiState } from "./reducer";
import type { Chain, CorpusDoc, Mode, ServerMessage, SystemInfo, TargetVerdict } from "./types";
import { Header } from "./components/Header";
import { AddressPanel } from "./components/AddressPanel";
import { WorkerSlider } from "./components/WorkerSlider";
import { QuantumConfig } from "./components/QuantumConfig";
import { StatsBar } from "./components/StatsBar";
import { LaneGrid } from "./components/LaneGrid";
import { Ticker } from "./components/Ticker";
import { ResultPanel } from "./components/ResultPanel";
import { Infeasibility } from "./components/Infeasibility";

const DEFAULT_WORKERS = 8;
const QUANTUM_BITS_MAX = 16;

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
  const [quantumBits, setQuantumBits] = useState(8);
  const [startError, setStartError] = useState<string | null>(null);
  const [tickerPhrases, setTickerPhrases] = useState<string[]>([]);
  const touchedWorkersRef = useRef(false);

  const ui = useRunFeed();
  const report = ui.report;
  const running = report?.status === "running";

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
  const lastRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!report || report.mode !== "classic") return;
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
      await startCrack({
        chain,
        mode,
        address: address.trim(),
        ...(mode === "classic"
          ? { workers, force }
          : { quantumBits: Math.min(quantumBits, QUANTUM_BITS_MAX) }),
      });
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
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : String(err));
    }
  };

  // Pre-run estimates: same model as the server, recomputed as the slider moves.
  const perCoreRate = system?.bench.perCoreDerivationsPerSec ?? FALLBACK_PER_CORE_RATE;
  const totalCandidates = corpus?.space.total_prefixes ?? null;
  const estimatedRate = estimateAggregateRate(workers, system?.cores ?? 8, perCoreRate);
  const estimatedEta =
    totalCandidates === null ? null : etaSeconds(totalCandidates, 0, estimatedRate);

  const canStart =
    !running && verdict?.valid === true && address.trim() !== "" && systemError === null;

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
        <div className="config-grid">
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
          {mode === "classic" ? (
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
          ) : (
            <QuantumConfig
              bits={quantumBits}
              onBits={setQuantumBits}
              maxBits={QUANTUM_BITS_MAX}
              disabled={running}
            />
          )}
        </div>

        <div className="start-row">
          <button type="button" className="btn primary" onClick={start} disabled={!canStart}>
            {mode === "classic" ? "Start search" : "Run toy simulation"}
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
              fraction={aggregate?.fractionOfKeyspace ?? 0}
              eta={aggregate?.etaSeconds ?? null}
              measured={aggregate !== null}
            />
            {report.mode === "classic" && <LaneGrid lanes={report.lanes} />}
            {report.mode === "classic" && <Ticker phrases={tickerPhrases} />}
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
