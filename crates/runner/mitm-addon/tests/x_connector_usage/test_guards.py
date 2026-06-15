"""Direct X connector usage reporting tests."""

import json

from tests.jsonl_log_helpers import read_jsonl_entries_after_flush


def test_skips_on_server_error(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path, status=500)
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_on_rate_limit(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path, status=429)
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_on_empty_permission(x_usage, tmp_path, real_flow):
    """Unknown-endpoint-allow has no stable pricing key."""
    flow = x_usage.make_flow(real_flow, tmp_path, permission="")
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_on_empty_run_id(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path)
    assert x_usage.call_and_get_billing(flow, run_id="") == []


def test_skips_when_not_billable(x_usage, tmp_path, real_flow):
    """Firewalls with firewall_billable=False are not reported."""
    flow = x_usage.make_flow(real_flow, tmp_path)
    flow.metadata["firewall_billable"] = False
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_when_no_response(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path)
    flow.response = None
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_webhook_without_sandbox_token(x_usage, tmp_path, real_flow):
    """When sandbox token is empty, no webhook is enqueued and underbilling is logged."""
    body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
    flow = x_usage.make_flow(
        real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
    )
    flow.metadata["vm_sandbox_token"] = ""
    assert x_usage.call_and_get_billing(flow) == []

    proxy_log = tmp_path / "proxy.jsonl"
    [entry] = read_jsonl_entries_after_flush(proxy_log)
    assert entry["level"] == "error"
    assert entry["message"] == "Cannot report usage event: missing sandbox_token or api_url"
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "missing_reporting_context"
    assert entry["underbilling_class"] == "confirmed"
    assert entry["component"] == "mitm_addon"
    assert entry["run_id"] == "run-abc-123"
    assert entry["firewall_name"] == "x"
    assert entry["permission"] == "tweet.read"
    assert entry["missing_sandbox_token"] is True
    assert entry["missing_api_url"] is False
