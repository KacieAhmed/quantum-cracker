"""Educational Grover demo over toy seed-phrase keyspaces (Qiskit).

Not an attack tool: properly generated seed phrases are not threatened by
Grover's algorithm (research doc art_MRbA2s2H). This module demonstrates the
mechanics on toy keyspaces and makes the scaling gap visible.
"""

from .engine import (
    build_grover_circuit,
    count_oracle_calls,
    exact_success_probability,
    optimal_iterations,
    run,
    sweep,
    theoretical_success,
)
from .oracle import build_mix_circuit, build_toy_oracle, oracle_gate
from .toy import (
    DEFAULT_TARGET,
    apply_primitives,
    default_schedule,
    find_preimages,
    toy_address,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_TARGET",
    "apply_primitives",
    "build_grover_circuit",
    "build_mix_circuit",
    "build_toy_oracle",
    "count_oracle_calls",
    "default_schedule",
    "exact_success_probability",
    "find_preimages",
    "optimal_iterations",
    "oracle_gate",
    "run",
    "sweep",
    "theoretical_success",
    "toy_address",
    "__version__",
]
