from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


# Canonical columns for the serving parquet (-input.parquet).
# Columns not present in input.parquet are silently skipped.
SERVING_COLUMNS: list[str] = [
    # Identity
    "id",
    "ls_index",
    # Plot
    "x",
    "y",
    "cluster",
    "raw_cluster",
    "label",
    "deleted",
    "tile_index_64",
    "tile_index_128",
    # Core row
    "text",
    "created_at",
    "username",
    "display_name",
    "tweet_type",
    # Engagement / filter
    "favorites",
    "retweets",
    "replies",
    "is_reply",
    "is_retweet",
    "is_like",
    # Media / link support
    "urls_json",
    "media_urls_json",
    # Provenance
    "archive_source",
]


_DEFAULT_CONTRACT_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "scope_input.schema.json"
)


def load_contract(contract_path: str | None = None) -> dict[str, Any]:
    path = Path(contract_path) if contract_path else _DEFAULT_CONTRACT_PATH
    with path.open() as f:
        return json.load(f)


def _coerce_bool(series: pd.Series) -> pd.Series:
    return series.map(
        lambda v: (
            v
            if isinstance(v, (bool, np.bool_))
            else (
                str(v).strip().lower() in {"1", "true", "t", "yes", "y"}
                if isinstance(v, str)
                else bool(v)
            )
        )
    )


# Type casters that do NOT fill nulls — fillna is handled by normalize_serving_types
# based on nullable/default semantics from the contract.
_TYPE_CASTERS: dict[str, Any] = {
    "string": lambda s: s.where(s.isna(), s.astype(str)),  # cast non-null to str, preserve NaN
    "int": lambda s: pd.to_numeric(s, errors="coerce"),
    "float": lambda s: pd.to_numeric(s, errors="coerce").astype(np.float32),
    "bool": _coerce_bool,
    "json_string": lambda s: s.where(s.isna(), s.astype(str)),  # cast non-null to str, preserve NaN
}


_NON_NULLABLE_DEFAULTS: dict[str, Any] = {
    "string": "",
    "int": 0,
    "float": 0.0,
    "bool": False,
    "json_string": "[]",
}


def normalize_serving_types(df: pd.DataFrame, contract: dict[str, Any]) -> pd.DataFrame:
    """Cast each column in *df* to its contract-declared type (in-place).

    Respects nullable/default semantics from the contract:
    - nullable=false: fillna with type default (empty string, 0, False, "[]")
    - nullable=true + default specified: fillna with contract default
    - nullable=true + no default: preserve nulls
    """
    all_columns = {
        **contract["required_columns"],
        **contract.get("optional_columns", {}),
    }
    for col, spec in all_columns.items():
        if col not in df.columns:
            continue
        col_type = spec["type"]
        nullable = spec.get("nullable", False)
        default = spec.get("default")

        caster = _TYPE_CASTERS.get(col_type)
        if caster:
            df[col] = caster(df[col])

        if not nullable:
            fill_value = _NON_NULLABLE_DEFAULTS.get(col_type, "")
            df[col] = df[col].fillna(fill_value)
        elif default is not None:
            df[col] = df[col].fillna(default)

        if not nullable:
            if col_type == "int":
                df[col] = df[col].astype(np.int64)
            elif col_type == "bool":
                df[col] = df[col].astype(bool)
            elif col_type in ("string", "json_string"):
                df[col] = df[col].astype(str)
    return df


def validate_scope_input_df(df: pd.DataFrame, contract: dict[str, Any]) -> None:
    """Raise ValueError if *df* violates the scope-input contract."""
    version = contract.get("version", "unknown")
    required = contract.get("required_columns", {})
    errors: list[str] = []

    missing = [c for c in required if c not in df.columns]
    if missing:
        errors.append(f"Missing required columns: {missing}")

    if "id" in df.columns and not pd.api.types.is_string_dtype(df["id"]):
        errors.append(f"Column 'id' must be string, got {df['id'].dtype}")

    dupes = df.columns[df.columns.duplicated()].tolist()
    if dupes:
        errors.append(f"Duplicate column names: {dupes}")

    all_columns = {**required, **contract.get("optional_columns", {})}
    for col, spec in all_columns.items():
        if col not in df.columns:
            continue
        t = spec["type"]
        nullable = spec.get("nullable", False)

        if t == "string" and not pd.api.types.is_string_dtype(df[col]):
            errors.append(f"Column '{col}' expected string, got {df[col].dtype}")
        elif t == "int" and not pd.api.types.is_integer_dtype(df[col]):
            if not (nullable and pd.api.types.is_float_dtype(df[col])):
                errors.append(f"Column '{col}' expected int, got {df[col].dtype}")
        elif t == "float" and not pd.api.types.is_float_dtype(df[col]):
            errors.append(f"Column '{col}' expected float, got {df[col].dtype}")
        elif t == "bool" and not pd.api.types.is_bool_dtype(df[col]):
            if not (nullable and df[col].dtype == object):
                errors.append(f"Column '{col}' expected bool, got {df[col].dtype}")

        if not nullable and df[col].isna().any():
            null_count = int(df[col].isna().sum())
            errors.append(
                f"Column '{col}' is non-nullable but has {null_count} null values"
            )

    if errors:
        raise ValueError(
            f"Scope-input contract violation (version: {version}):\n"
            + "\n".join(f"  - {e}" for e in errors)
        )

