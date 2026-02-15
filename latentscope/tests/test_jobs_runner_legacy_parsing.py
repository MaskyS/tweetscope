from latentscope.server.jobs_runner import _job_spec_from_legacy_command, _parse_legacy_delete_globs


def test_parse_legacy_delete_globs_splits_segments():
    globs = _parse_legacy_delete_globs(
        "rm -rf /data/ds/umaps/umap-001*; rm -rf /data/ds/clusters/cluster-001*"
    )
    assert globs == ["/data/ds/umaps/umap-001*", "/data/ds/clusters/cluster-001*"]


def test_parse_legacy_delete_globs_rejects_non_rm():
    assert _parse_legacy_delete_globs("ls -la /tmp") is None


def test_job_spec_from_legacy_command_subprocess_uses_shlex():
    spec = _job_spec_from_legacy_command("ls-embed dataset text model --prefix '' --batch_size 50")
    assert spec is not None
    assert spec["kind"] == "subprocess"
    assert spec["argv"] == [
        "ls-embed",
        "dataset",
        "text",
        "model",
        "--prefix",
        "",
        "--batch_size",
        "50",
    ]

