"""CLI: JSON round-trip for the integration layer."""

import json

from qcracker_grover.cli import main


def test_cli_run_writes_json(tmp_path):
    out = tmp_path / "result.json"
    rc = main(["run", "--n-bits", "3", "--shots", "256", "--output", str(out)])
    assert rc == 0
    payload = json.loads(out.read_text())
    assert payload["keyspace_size"] == 8
    assert payload["success"] is True
    assert payload["oracle_calls_instrumented"] == payload["oracle_calls_by_construction"]


def test_cli_sweep_writes_json(tmp_path):
    out = tmp_path / "sweep.json"
    rc = main(["sweep", "--n-bits", "3", "--max-factor", "2", "--output", str(out)])
    assert rc == 0
    payload = json.loads(out.read_text())
    assert payload["mode"] == "sweep"
    assert len(payload["points"]) == payload["t_max"] + 1
