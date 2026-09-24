import os from "node:os";
import { PER_WORKER_FOOTPRINT_BYTES } from "./config.js";

export interface SystemInfo {
  cores: number;
  totalMemBytes: number;
  freeMemBytes: number;
  perWorkerFootprintBytes: number;
  safeMaxWorkers: number;
}

/**
 * safe-max uses the factory formula: min(cores, floor(available_ram /
 * per_worker_footprint)). Above it the API refuses /crack unless the client
 * deliberately force-overrides — at some point the computer crashes.
 */
export function safeMaxWorkers(
  cores: number,
  availableMemBytes: number,
  footprintBytes: number = PER_WORKER_FOOTPRINT_BYTES,
): number {
  return Math.min(cores, Math.floor(availableMemBytes / footprintBytes));
}

export function systemInfo(): SystemInfo {
  const cores = os.cpus().length;
  const freeMemBytes = os.freemem();
  return {
    cores,
    totalMemBytes: os.totalmem(),
    freeMemBytes,
    perWorkerFootprintBytes: PER_WORKER_FOOTPRINT_BYTES,
    safeMaxWorkers: safeMaxWorkers(cores, freeMemBytes),
  };
}
