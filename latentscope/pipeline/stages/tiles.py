from __future__ import annotations

import numpy as np


def make_tiles(x, y, num_tiles: int = 64) -> np.ndarray:
    """
    Compute a stable tile index for each point in [-1, 1] x [-1, 1].

    Matches the previous nested implementation in `latentscope/scripts/scope.py`.
    """
    x_arr = np.asarray(x)
    y_arr = np.asarray(y)

    tile_size = 2.0 / num_tiles
    col_indices = np.floor((x_arr + 1) / tile_size).astype(int)
    row_indices = np.floor((y_arr + 1) / tile_size).astype(int)

    col_indices = np.clip(col_indices, 0, num_tiles - 1)
    row_indices = np.clip(row_indices, 0, num_tiles - 1)

    return row_indices * num_tiles + col_indices

