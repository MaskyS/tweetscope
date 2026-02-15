from __future__ import annotations

import shlex
from typing import Iterable


def truthy_flag(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def shell_join(parts: Iterable[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def falsy_flag(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in ("0", "false", "no", "off")
