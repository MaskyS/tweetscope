import pandas as pd
import pytest

from latentscope.pipeline.contracts.scope_input import (
    load_contract,
    normalize_serving_types,
    validate_scope_input_df,
)


def test_load_contract_default_path() -> None:
    contract = load_contract()
    assert contract["version"] == "scope-input-v1"
    assert "required_columns" in contract
    assert "optional_columns" in contract


def test_normalize_then_validate_passes_for_coercible_types() -> None:
    contract = load_contract()

    df = pd.DataFrame(
        {
            "id": [123, None],
            "ls_index": [0.0, 1.0],
            "x": [0, "0.1"],
            "y": [0.2, None],
            "cluster": [7, 8],
            "label": ["hello", None],
            "deleted": ["true", None],
            "text": [None, "hi"],
            "urls_json": [None, None],
        }
    )

    normalize_serving_types(df, contract)
    validate_scope_input_df(df, contract)

    assert df["id"].dtype == object
    assert df["id"].iloc[0] in {"123", "123.0"}
    assert df["label"].iloc[1] == ""
    assert df["text"].iloc[0] == ""
    assert df["deleted"].dtype == bool
    assert df["urls_json"].iloc[0] == "[]"


def test_validate_raises_on_missing_required_columns() -> None:
    contract = load_contract()
    df = pd.DataFrame({"id": ["1"]})
    with pytest.raises(ValueError, match="Missing required columns"):
        validate_scope_input_df(df, contract)
