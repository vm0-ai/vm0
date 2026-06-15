"""Tests for usage underbilling log contracts."""

from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from usage.underbilling import log_usage_underbilling


def test_underbilling_log_fields_cannot_be_overridden_by_context(tmp_path):
    proxy_log_path = tmp_path / "proxy.jsonl"

    log_usage_underbilling(
        str(proxy_log_path),
        "Usage underbilling signal",
        "expected_reason",
        "risk",
        type="usage_event",
        reason="wrong_reason",
        component="wrong_component",
        underbilling_class="confirmed",
        run_id="run-1",
    )

    [entry] = read_jsonl_entries_after_flush(proxy_log_path)
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "expected_reason"
    assert entry["underbilling_class"] == "risk"
    assert entry["component"] == "mitm_addon"
    assert entry["run_id"] == "run-1"
