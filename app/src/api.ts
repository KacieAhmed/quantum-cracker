import type {
  Cancelled,
  Chain,
  CrackRequest,
  CrackStart,
  CorpusDoc,
  DeriveResponse,
  Mode,
  SystemInfo,
  TargetVerdict,
} from "./types";

/** Non-2xx response with the API's structured error body when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, status: number, statusText: string): string {
  if (payload !== null && typeof payload === "object" && "error" in payload) {
    const err = (payload as { error?: unknown }).error;
    if (typeof err === "string" && err.length > 0) return err;
  }
  return `request failed: ${status} ${statusText}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await parseBody(res);
  if (!res.ok) throw new ApiError(errorMessage(body, res.status, res.statusText), res.status, body);
  return body as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    // A bodyless POST (cancel) must not declare a JSON content-type: the
    // API would parse that as an empty JSON body and answer 400 before the
    // cancel handler ever runs.
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await parseBody(res);
  if (!res.ok) throw new ApiError(errorMessage(payload, res.status, res.statusText), res.status, payload);
  return payload as T;
}

export const getSystem = (): Promise<SystemInfo> => fetchJson<SystemInfo>("/system");

export const getCorpus = (): Promise<CorpusDoc> => fetchJson<CorpusDoc>("/corpus");

export const validateAddress = (address: string): Promise<TargetVerdict> =>
  postJson<TargetVerdict>("/validate", { address });

/**
 * Derive every engine-supported address from a mnemonic the user owns.
 * Nothing is exposed by this: the caller already holds the seed — the
 * derivation runs through the same engine code path the search uses.
 */
export const deriveAddresses = (
  mnemonic: string,
  passphrase: string,
): Promise<DeriveResponse> =>
  postJson<DeriveResponse>("/derive", {
    mnemonic,
    ...(passphrase === "" ? {} : { passphrase }),
  });

export const startCrack = (request: CrackRequest): Promise<CrackStart> =>
  postJson<CrackStart>("/crack", request);

export const cancelRun = (runId: string): Promise<Cancelled> =>
  postJson<Cancelled>(`/crack/${encodeURIComponent(runId)}/cancel`);

/**
 * Cancel failures phrased for a human: a run that settled between the button
 * rendering and the click is not an error, so 404 (no such active run) and
 * 409 (run is not running) become a friendly note instead of a raw one.
 */
export function cancelFailureMessage(err: unknown): string {
  if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
    return "No active run to cancel — it may have already finished.";
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Cancel failed: ${detail}`;
}

/** Chain/mode values the toggles show, in order. */
export const CHAINS: readonly Chain[] = ["bitcoin", "ethereum"] as const;
export const MODES: readonly Mode[] = ["classic", "quantum"] as const;

/** WebSocket endpoint for the live run feed (same-origin; proxied in dev). */
export function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}
