from latentscope.server.jobs_commands import falsy_flag, truthy_flag


def test_truthy_flag_matches_legacy_values() -> None:
    assert truthy_flag("1") is True
    assert truthy_flag("true") is True
    assert truthy_flag("yes") is True
    assert truthy_flag("on") is True
    assert truthy_flag("t") is False
    assert truthy_flag("y") is False


def test_falsy_flag_matches_incremental_links_contract() -> None:
    assert falsy_flag("0") is True
    assert falsy_flag("false") is True
    assert falsy_flag("no") is True
    assert falsy_flag("off") is True
    assert falsy_flag("") is False
    assert falsy_flag("banana") is False

