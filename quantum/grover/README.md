# quantum/grover — Grover simulation over toy seed-phrase keyspaces

Educational demo of Grover's algorithm searching a **toy** candidate-to-address
keyspace with Qiskit. Not an attack tool: the companion research note
(*Grover's Algorithm — Mechanics, Oracle Cost, and Honest Scaling*, `art_MRbA2s2H`)
shows that at the real 12-word BIP-39 keyspace (2^132 candidates) the ~2^66
required oracle calls each need a reversible PBKDF2-chain circuit that cannot be
executed coherently even once at scale. This module demonstrates the *mechanics*
on toy spaces (N = 2^8–2^20 by default; the oracle is a genuine circuit, not a
hardcoded marked item) and makes the scaling gap visible.

## Design (per the research doc)

- **One derivation, two engines.** `toy.py` defines an ordered list of reversible
  primitives (`x ^= x>>r`, `x ^= (x<<s)`, `x ^= c`, `rotl`, one Toffoli layer).
  `apply_primitives` runs it classically (the ground truth); `oracle.py` compiles
  the *same list, same order* to CNOT/SWAP/Toffoli/X gates. Circuit-vs-classical
  agreement is verified on every input for small widths (`tests/test_oracle.py`).
- **Genuine oracle.** Compute (mix the candidate) → compare (X-conjugated
  multi-controlled Z against the target address) → uncompute (inverse mix). No
  hardcoded marked state.
- **Assembly.** `qiskit.circuit.library.grover_operator` builds
  `Q = A·S₀·A†·S_f`; the oracle is passed as a labeled gate so
  `count_ops()["oracle"]` instruments oracle calls per run (doc §4.3). Note: the
  doc's `mcx_mode` scratch-qubit option does not exist in Qiskit 2.5.2's
  `grover_operator` (verified this session); the labeled-gate counting approach
  replaces that instrumentation.
- **Iteration count.** `t_opt = floor(π / (4·asin(√(M/N))))` (doc §1.4); the
  test suite reproduces the doc's reference table (t_opt = 2, 12, 25, 50, 201,
  804 for n = 3, 8, 10, 12, 16, 20).
- **Backends.** `sampler` (exact statevector sampling) and Aer for runs;
  `statevector` for shot-noise-free sweep curves. Address-width truncation gives
  exact control of the marked count M.

## Install

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e "quantum/grover[dev]"
```

Python ≥ 3.10; pins: qiskit 2.5.2, qiskit-aer 0.17.2, matplotlib 3.11.2.

## Run

```bash
# One Grover run (JSON to stdout; --output also writes a file)
qcracker-grover run --n-bits 8 --shots 1024

# Success-probability sweep over iterations (exact curve; shot backends optional)
qcracker-grover sweep --n-bits 8 --max-factor 2

# The three comparison figures
qcracker-grover charts --figures-dir figures

# Same things as modules:
python -m qcracker_grover run --n-bits 10
```

JSON schema (run): `n_bits`, `keyspace_size`, `address_bits`, `target_address`,
`iterations`, `oracle_calls_by_construction`, `oracle_calls_instrumented`,
`marked_count`, `classical_preimages` (ground truth), `measured_outcome`,
`success`, `success_probability`, `exact_success_probability`,
`theoretical_success_probability`, `gate_counts`, `circuit_depth`.

## Tests & lint

```bash
pytest quantum/grover/tests
ruff check quantum/grover/src quantum/grover/tests
```

## Notebooks

`../notebooks/grover_demo.ipynb` renders the charts inline and prints summary
results; the same figures are regenerated headlessly by `qcracker-grover charts`.

## Scope & ethics

This module demonstrates amplitude amplification over a **toy bit-mixer**. It
does not implement BIP-39/PBKDF2 wallet derivation, cannot search real wallet
keyspaces, and exists to teach why properly generated seed phrases are not
threatened by Grover's algorithm (and why weak entropy, a classical problem, is).
