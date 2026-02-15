from latentscope.server.jobs_runner import PROCESSES, kill_process


class _FakeProc:
    def __init__(self) -> None:
        self.killed = False

    def kill(self) -> None:
        self.killed = True


def test_kill_process_uses_shared_processes_dict() -> None:
    fake = _FakeProc()
    PROCESSES["job-1"] = fake  # type: ignore[assignment]
    try:
        assert kill_process("job-1") is True
        assert fake.killed is True
    finally:
        PROCESSES.pop("job-1", None)


def test_kill_process_returns_false_when_missing() -> None:
    assert kill_process("does-not-exist") is False

