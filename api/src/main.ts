import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./server.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Prefer an explicit CRACKER_CLI_PATH; else release, then debug binary. */
function resolveCliPath(): string {
  const explicit = process.env.CRACKER_CLI_PATH;
  if (explicit) return explicit;
  const candidates = [
    path.join(repoRoot, "target", "release", "cracker-cli"),
    path.join(repoRoot, "target", "debug", "cracker-cli"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] as string;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const app = await buildApp({
  cliPath: resolveCliPath(),
  runsDir: path.join(repoRoot, "api", "runs"),
  groverSrcDir: path.join(repoRoot, "quantum", "grover", "src"),
});

try {
  await app.listen({ port, host });
  console.log(`quantum-cracker api listening on http://${host}:${port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
