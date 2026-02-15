from .configuration import get_data_dir, update_data_dir, get_key, get_supported_api_keys, set_openai_key, set_voyage_key


def calculate_point_size(num_points, min_size=10, max_size=30, base_num_points=100):
    import numpy as np
    """
    Calculate the size of points for a scatter plot based on the number of points.
    """
    # TODO fix this to actually calculate a log scale between min and max size
    if num_points <= base_num_points:
        return max_size
    else:
        return min(min_size + min_size * np.log(num_points / base_num_points), max_size)
