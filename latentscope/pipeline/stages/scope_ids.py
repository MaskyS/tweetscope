from __future__ import annotations

import os
import re


_SCOPE_JSON_RE = re.compile(r"scopes-(\d+)\.json$")


def resolve_scope_id(scopes_dir: str, scope_id: str | None) -> str:
    if scope_id:
        return scope_id

    max_n = 0
    try:
        for filename in os.listdir(scopes_dir):
            m = _SCOPE_JSON_RE.match(filename)
            if not m:
                continue
            max_n = max(max_n, int(m.group(1)))
    except FileNotFoundError:
        max_n = 0

    next_n = max_n + 1
    return f"scopes-{next_n:03d}"

