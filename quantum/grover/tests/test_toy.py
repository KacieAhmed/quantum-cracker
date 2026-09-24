"""Classical twin: bijectivity, address widths, ground-truth scan."""

import pytest

from qcracker_grover.toy import (
    DEFAULT_TARGET,
    apply_primitives,
    default_schedule,
    find_preimages,
    toy_address,
)


@pytest.mark.parametrize("b", [3, 4, 8, 12])
def test_mix_is_bijection(b):
    sched = default_schedule(b)
    values = {apply_primitives(x, b, sched) for x in range(1 << b)}
    assert len(values) == 1 << b


def test_default_target_masks_into_every_width():
    for b in range(2, 17):
        target = DEFAULT_TARGET & ((1 << b) - 1)
        assert 0 <= target < (1 << b)


def test_full_width_address_has_single_preimage():
    b = 8
    sched = default_schedule(b)
    preimages = find_preimages(DEFAULT_TARGET, b, b, sched)
    assert len(preimages) == 1
    assert toy_address(preimages[0], b, b, sched) == DEFAULT_TARGET


def test_truncated_address_has_exact_multiplicity():
    # A bijection on b bits truncated to a bits yields exactly 2**(b-a)
    # preimages per address value - this is the classical ground truth for M.
    b, a = 8, 6
    sched = default_schedule(b)
    target = DEFAULT_TARGET & ((1 << a) - 1)
    preimages = find_preimages(target, b, a, sched)
    assert len(preimages) == 1 << (b - a)
    assert all(toy_address(x, b, a, sched) == target for x in preimages)


def test_schedule_rejects_tiny_widths():
    with pytest.raises(ValueError):
        default_schedule(1)
