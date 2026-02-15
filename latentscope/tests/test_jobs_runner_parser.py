from latentscope.server.jobs_runner import update_job_from_output_line


def test_update_job_from_output_line_sets_run_id() -> None:
    job: dict[str, object] = {}
    update_job_from_output_line(job, "RUNNING: abc123\n")
    assert job["run_id"] == "abc123"


def test_update_job_from_output_line_sets_scope_id() -> None:
    job: dict[str, object] = {}
    update_job_from_output_line(job, "FINAL_SCOPE: scopes-001\n")
    assert job["scope_id"] == "scopes-001"


def test_update_job_from_output_line_sets_imported_rows_int() -> None:
    job: dict[str, object] = {}
    update_job_from_output_line(job, "IMPORTED_ROWS: 42\n")
    assert job["imported_rows"] == 42


def test_update_job_from_output_line_sets_imported_rows_str_on_parse_error() -> None:
    job: dict[str, object] = {}
    update_job_from_output_line(job, "IMPORTED_ROWS: not_a_number\n")
    assert job["imported_rows"] == "not_a_number"

