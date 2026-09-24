import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, cancelFailureMessage, cancelRun, startCrack } from "./api";

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function stubFetch(status: number, payload: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("api client request shapes", () => {
  it("sends cancel as a bodyless POST without a JSON content-type", async () => {
    // Regression: the console once declared `content-type: application/json`
    // on this bodyless POST; the API parsed the empty payload as JSON and
    // answered 400 (FST_ERR_CTP_EMPTY_JSON_BODY) before the handler ran.
    stubFetch(200, { runId: "run_x", cancelled: true });

    await cancelRun("run_x");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/crack/run_x/cancel");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("keeps the JSON content-type for posts that carry a body", async () => {
    stubFetch(201, {
      runId: "run_y",
      mode: "quantum",
      totalCandidates: 256,
      note: "n",
    });

    await startCrack({
      chain: "bitcoin",
      mode: "quantum",
      address: "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp",
      quantumBits: 8,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.body).toBe(
      JSON.stringify({
        chain: "bitcoin",
        mode: "quantum",
        address: "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp",
        quantumBits: 8,
      }),
    );
  });
});

describe("cancelFailureMessage", () => {
  it("phrases a settled run as nothing to cancel, not an error", () => {
    const noSuchRun = new ApiError("no such active run", 404, {
      error: "no such active run",
    });
    expect(cancelFailureMessage(noSuchRun)).toBe(
      "No active run to cancel — it may have already finished.",
    );

    const notRunning = new ApiError("run is not running", 409, {
      error: "run is not running",
    });
    expect(cancelFailureMessage(notRunning)).toBe(
      "No active run to cancel — it may have already finished.",
    );
  });

  it("keeps the API's message for unexpected cancel failures", () => {
    const boom = new ApiError("engine exploded", 500, {
      error: "engine exploded",
    });
    expect(cancelFailureMessage(boom)).toBe("Cancel failed: engine exploded");

    expect(cancelFailureMessage(new Error("socket hang up"))).toBe(
      "Cancel failed: socket hang up",
    );
  });
});
