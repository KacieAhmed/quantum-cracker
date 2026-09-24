"""Charts: all three figures render headlessly."""

from qcracker_grover.charts import make_all


def test_make_all_figures(tmp_path):
    paths = make_all(tmp_path, n_bits=3)  # smallest sweep keeps it fast
    assert len(paths) == 3
    for path in paths:
        assert path.exists()
        assert path.stat().st_size > 1_000
