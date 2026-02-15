import numpy as np

from latentscope.pipeline.stages.tiles import make_tiles


def test_make_tiles_boundaries_and_clamping() -> None:
    x = np.array([-1.0, 0.0, 1.0, -1.0001, 1.0001])
    y = np.array([-1.0, 0.0, 1.0, 1.0001, -1.0001])

    tiles = make_tiles(x, y, num_tiles=64)
    assert tiles[0] == 0
    assert tiles[2] == 63 * 64 + 63
    assert tiles[1] == 32 * 64 + 32

    assert tiles[3] == 63 * 64 + 0  # y clamps high, x clamps low
    assert tiles[4] == 0 * 64 + 63  # y clamps low, x clamps high

    assert tiles.min() >= 0
    assert tiles.max() <= 64 * 64 - 1

