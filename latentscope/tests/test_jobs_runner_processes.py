class _FakeProc:
    def __init__(self) -> None:
        self.killed = False

    def kill(self) -> None:
        self.killed = True


def test_kill_process_uses_shared_processes_dict() -> None:
    import latentscope.server.jobs_runner as jobs_runner

    fake = _FakeProc()
    jobs_runner.PROCESSES["job-1"] = fake  # type: ignore[assignment]
    try:
        assert jobs_runner.kill_process("job-1") is True
        assert fake.killed is True
    finally:
        jobs_runner.PROCESSES.pop("job-1", None)


def test_kill_process_returns_false_when_missing() -> None:
    import latentscope.server.jobs_runner as jobs_runner

    assert jobs_runner.kill_process("does-not-exist") is False
