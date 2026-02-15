from latentscope.pipeline.stages.scope_ids import resolve_scope_id


def test_resolve_scope_id_returns_override() -> None:
    assert resolve_scope_id("/does/not/matter", "scopes-123") == "scopes-123"


def test_resolve_scope_id_allocates_next_number(tmp_path) -> None:
    scopes_dir = tmp_path
    (scopes_dir / "scopes-001.json").write_text("{}")
    (scopes_dir / "scopes-002.json").write_text("{}")
    assert resolve_scope_id(str(scopes_dir), None) == "scopes-003"

