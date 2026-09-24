#!/usr/bin/env bash
# cracker-factory benchmark: aggregate throughput vs worker count.
#
# Runs the factory in budget-probe mode (fixed wall time per worker count,
# always over the bundled pooled 2^24 demo space) and prints a markdown
# speedup table from each run's report. Workers beyond the core count are
# oversubscription on purpose: the table shows the honest plateau.
#
# Usage:  benches/benchmark.sh [budget_seconds]
#   BENCH_SECONDS (default 60)   wall time per worker count
#   WORKER_COUNTS (default "1 2 4 8 16 32")
set -euo pipefail

SECONDS_PER_RUN="${1:-${BENCH_SECONDS:-60}}"
WORKER_COUNTS="${WORKER_COUNTS:-1 2 4 8 16 32}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FACTORY="$REPO_ROOT/target/release/cracker-factory"
ENGINE="$REPO_ROOT/target/release/cracker-cli"
OUT_DIR="$(mktemp -d /tmp/factory-bench.XXXXXX)"

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
[ -x "$FACTORY" ] || { echo "missing $FACTORY (cargo build --release -p cracker-factory)" >&2; exit 1; }
[ -x "$ENGINE" ] || { echo "missing $ENGINE (cargo build --release -p cracker-cli)" >&2; exit 1; }

TARGET="0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5" # pooled demo wallet (ETH)

for n in $WORKER_COUNTS; do
  report="$OUT_DIR/report-n$n.json"
  # --force is required past the safe-max guardrail; the table reports the
  # measured plateau rather than hiding it.
  "$FACTORY" --target "$TARGET" --workers "$n" --threads-per-worker 1 --force \
    --budget-seconds "$SECONDS_PER_RUN" --budget-space 2^24 --quiet \
    --report "$report" --cracker-cli "$ENGINE" >/dev/null 2>&1
  echo "measured N=$n" >&2
done

python3 - "$OUT_DIR" $WORKER_COUNTS <<'PY'
import json, sys
out_dir, counts = sys.argv[1], [int(x) for x in sys.argv[2:]]
rows = []
for n in counts:
    with open(f"{out_dir}/report-n{n}.json") as f:
        r = json.load(f)
    rows.append((n, r["aggregate"]["derived_total"],
                 r["scale_estimates"]["measured_aggregate_derived_per_sec"]))
base = rows[0][2]
print(f"| workers | total derived in run | derivations/s | speedup vs N=1 | efficiency |")
print(f"|---|---|---|---|---|")
for n, total, rate in rows:
    print(f"| {n} | {total:,} | {rate:,.0f} | {rate/base:.2f}x | {rate/base/n:.0%} |")
PY
