# cracker-factory

Worker-fleet orchestration over the [`cracker-cli`](../cracker-cli) engine:
many worker processes search the bundled pooled demo keyspace in **disjoint,
contiguous ranges**, with a machine-checkable **coverage proof**, live
aggregated progress, **cancel-on-match**, **resumability**, and **honest
scaling reporting** for huge spaces.

```
                 ┌────────────────────────────────────────────┐
                 │ Range planner (plan.rs)                    │
                 │  split [start, end) into N contiguous,     │
                 │  pairwise-disjoint, granularity-aligned    │
                 │  ranges (u256-safe)                        │
                 └───────────────┬────────────────────────────┘
                                 │ 1 range per worker
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  cracker-cli                cracker-cli             cracker-cli        ...
  --start 0        ...       --start k               --start (N-1)k
  --count k                  --count k               --count k
        │                        │                        │
        └──── JSON progress ─────┴───────────┬────────────┘
                                             ▼
                 ┌────────────────────────────────────────────┐
                 │ Aggregator (worker.rs + report.rs)         │
                 │  live rates/ETA, cancel-on-match,          │
                 │  coverage proof, run-report.json, resume   │
                 └────────────────────────────────────────────┘
```

The factory consumes the engine **as a subprocess** and does not depend on any
engine-internal API. One worker = one process pinned to one range via the
engine's existing `--start`/`--count` flags.

## Safety: demo-wallets-only is binding

**The factory refuses any target address outside the bundled demo corpus**
(`corpus.rs`). This is not a policy preference: the engine only ever searches
the bundled pooled demo spaces (2^24-2^25 candidate assemblies built around
two throwaway wallets — the default varied-slot space, where every word slot
draws from its own pool, and the legacy fixed-slot space), so a target from
anywhere else could **never** be found and a run would be a lie. Rejection
happens before any worker starts.

All demo wallets are self-generated throwaways. Never use them with real
funds. Real BIP-39 seed phrases are outside reach by construction — see
[Honest scaling](#honest-scaling) for why even unlimited classical or quantum
hardware does not change that.

## Worker-count guardrails (memory exhaustion, not ideology)

At startup the factory detects **logical cores** and **available RAM**
(`/proc/meminfo`), computes a safe-max worker count, and refuses (unless
`--force`) to oversubscribe the machine:

```
safe-max = min(logical_cores, floor(available_ram / per_worker_footprint))
```

Per-worker footprint used by the formula (recorded, with its source, in every
run report so an app UI can reuse it):

- **Base 4 MiB** — measured peak RSS (`VmHWM`) of a 1-thread `cracker-cli`
  worker was **1,164 kB** on the dev sandbox (8-core, 8 GB); the constant
  carries ~3.5x headroom for allocator arenas, deeper call stacks on longer
  walks, and page-table overhead.
- **+2 MiB per worker thread** — rayon's default stack reservation. Touched
  RSS is far smaller, but the reservation is the honest planning number for
  what the OS must be able to back.

Behavior:

- `N <= safe-max` — runs normally.
- `N > cores` — starts, but prints a **diminishing-returns warning**
  (oversubscription adds no throughput past the core count).
- `N > safe-max` — **refuses to start** (exit code 3) with the full formula
  and the binding constraint, unless `--force` is passed.

## Coverage proof

The planner aligns every range to the engine's enumeration granularity (16
raw assemblies per prefix ordinal in the pooled space) and the report carries
a machine-checkable proof: ranges sorted by start, explicit gap list, overlap
list, and the covered total. `exact_cover: true` asserts pairwise disjointness
and full-space union. Verified by unit tests for N = 1..1000, for N larger
than the space (empty ranges dropped), and for giant u256 spaces.

## Resume

Every progress event carries per-worker exact cursors. On graceful shutdown
(SIGINT/SIGTERM) or when workers die unexpectedly, the run report records a
`resume` section: exhausted/finished ranges are skipped, partial ranges resume
at the last trusted cursor (conservatively to range start when a cursor cannot
be trusted). `--resume <report.json>` replays only what was never scanned.

## Budget mode and the honest scale model

```
cracker-factory --target <demo-address> --workers 8 \
  --budget-seconds 60 --budget-space 2^256
```

For declared spaces beyond the huge-space threshold (default 2^40 raw
candidates), the factory runs a **bounded probe**: each worker searches its
window for the time budget, then the factory stops and reports the measured
rate and a full-space ETA computed with the honest math. The report always
states that the run searched the bundled demo space, **not** the declared
space. A 2^256 ETA looks like what it is — never a completion.

The report embeds `honest_scaling` notes, verifiable from the engine's own
measurements:

- **Parallel classical workers scale linearly**: N workers over disjoint
  contiguous ranges cover the space in ~1/N wall-clock until cores saturate
  (see the [benchmark](#benchmark)).
- **Parallel Grover runs over disjoint partitions do not**: a single-target
  Grover search over N items costs ~sqrt(N) oracle queries. Sharding N across
  M machines holding disjoint partitions costs M·sqrt(N/M) = sqrt(M)·sqrt(N)
  total queries — a **sqrt(M) parallel penalty**, because amplitude
  interference cannot be shared across oracles. Parallel quantum hardware
  helps per-machine wall-clock, not total query cost.
- **T marked targets** reduce the cost to ~sqrt(N/T) (Boyer et al., 1998), so
  a fleet over disjoint partitions recovers only the sqrt(N/T)
  single-partition cost — multi-target amplitude amplification, not naive
  sharding, is where quantum parallelism pays.
- **2^256 is out of reach even with unlimited funds.** A classical walk at the
  engine's measured 5,479 full derivations/s per 8-core worker needs
  **6.7e65 such workers busy for a year** (1.158e77 / (5,479 · 3.156e7 s)).
  At the Landauer limit (kT·ln2 ≈ 2.87e-21 J per irreversible bit erasure at
  300 K), the Sun's total output (3.83e26 W) yields ~4.2e54 irreversible
  computations/year — a 2^256 walk needs **~2.7e22 years of the Sun's entire
  output** (about 1e30 years if only the solar flux Earth intercepts is
  usable).

## Benchmark

`benches/benchmark.sh` measures aggregate throughput for N = 1, 2, 4, 8, 16,
32 workers (budget-probe mode, 1 thread per worker, `--force` past the core
count so the plateau is measured rather than hidden):

```sh
cargo build --release -p cracker-cli -p cracker-factory
crates/cracker-factory/benches/benchmark.sh 60
```

Measured on the 8-core / 8 GB dev sandbox (legacy fixed-slot space — 2^24
raw assemblies, ETH target):

| workers | total derived | derivations/s | speedup vs N=1 | efficiency |
|---|---|---|---|---|
| 1 | 59,776 | 991 | 1.00x | 100% |
| 2 | 115,533 | 1,914 | 1.93x | 97% |
| 4 | 227,591 | 3,770 | 3.80x | 95% |
| 8 | 451,386 | 7,477 | 7.54x | 94% |
| 16 | 449,525 | 7,446 | 7.51x | 47% |
| 32 | 427,460 | 7,230 | 7.30x | 23% |

Near-linear to the core count (94% efficiency at N=8); flat beyond it — more
workers buy nothing once cores are saturated, which is why the guardrails
refuse oversubscription by default. Note the efficiency column: at N=32 each
worker gets less than a quarter of a core, so per-worker yield collapses even
as the aggregate stays flat.

The default varied-slot space (2^25 raw assemblies / 2^21 checksum-valid
candidates) sustains ~5,600 derivations/s at 8 workers on the same sandbox.
A full sweep is therefore ~6.3 minutes locally, ~25 minutes at the deployed
reference rate (~1,400 derivations/s). A verified end-to-end run recovered
the target in 67.6 s — the shuffled walk placed it 18% into the space.

## Usage

```sh
# Full pooled-space search, 8 workers (sweep ~6 min on 8 cores; a match
# lands sooner if the shuffled walk reaches the target early)
cracker-factory --target 0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5 --workers 8

# Same, 1 MiB of quiet: only factory-start / factory-done on stdout
cracker-factory --target <demo> --workers 8 --quiet

# Bounded probe of a huge declared space (measures rate, reports honest ETA)
cracker-factory --target <demo> --workers 8 --budget-seconds 60 --budget-space 2^256

# Resume an interrupted run from its report
cracker-factory --resume run-report.json --workers 8
```

Exit codes: `0` found / probe done · `1` exhausted · `2` usage · `3` refused
by guardrail · `4` interrupted (resume point written) · `5` incomplete.

The engine binary is resolved from `--cracker-cli`, `$CRACKER_CLI`, the
factory's own directory, the workspace `target/{release,debug}` dirs, or
`$PATH`, in that order.

Machine-readable run reports (`run-report.json`) contain the machine profile,
the guardrail formula, the coverage proof, per-worker states, matches (with
the winning mnemonic), resume cursors, and the honest-scaling notes.
