"""Tests for mitm addon logging utilities."""

import json
from unittest.mock import MagicMock, patch

import flow_metadata_keys as metadata_keys
import logging_utils
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


def _read_jsonl_entries_without_flush(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


class TestLogNetworkEntry:
    def test_writes_jsonl(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"action": "ALLOW", "host": "example.com"}

        with patch.object(logging_utils.ctx, "log", MagicMock(), create=True):
            logging_utils.log_network_entry(log_path, entry)

        entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(entries) == 1
        parsed = entries[0]
        assert parsed["action"] == "ALLOW"
        assert parsed["host"] == "example.com"
        assert_utc_millisecond_timestamp(parsed["timestamp"])
        assert "timestamp" not in entry

    def test_timestamp_is_authoritative(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"timestamp": "caller-timestamp", "action": "ALLOW"}

        with patch.object(logging_utils.ctx, "log", MagicMock(), create=True):
            logging_utils.log_network_entry(log_path, entry)

        [parsed] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert_utc_millisecond_timestamp(parsed["timestamp"])
        assert parsed["timestamp"] != "caller-timestamp"
        assert entry["timestamp"] == "caller-timestamp"

    def test_appends_multiple(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")

        with patch.object(logging_utils.ctx, "log", MagicMock(), create=True):
            logging_utils.log_network_entry(log_path, {"n": 1})
            logging_utils.log_network_entry(log_path, {"n": 2})

        entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(entries) == 2

    def test_no_path_is_noop(self):
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_network_entry("", {"payload": b"binary"})

        log.warn.assert_not_called()

    def test_missing_parent_path_warns_and_does_not_raise(self, tmp_path):
        log_path = tmp_path / "missing" / "net.jsonl"
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
            logging_utils.flush_log_path(str(log_path))

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to write network log:" in warning
        assert "FileNotFoundError" in warning

    def test_non_serializable_entry_warns_without_creating_file(self, tmp_path):
        log_path = tmp_path / "net.jsonl"
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_network_entry(str(log_path), {"payload": b"binary"})

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to encode network log: TypeError:" in warning
        logging_utils.flush_log_path(str(log_path))
        assert not log_path.exists()

    def test_full_backlog_warns_without_creating_file(self, tmp_path):
        log_path = tmp_path / "net.jsonl"
        log = MagicMock()

        with (
            patch.object(logging_utils.jsonl_writer, "MAX_PENDING_JSONL_BYTES", 1),
            patch.object(logging_utils.ctx, "log", log, create=True),
        ):
            logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert warning == "Dropping network log because the JSONL writer backlog is full"
        logging_utils.flush_log_path(str(log_path))
        assert not log_path.exists()


class TestLogProxyEntry:
    def test_writes_jsonl(self, tmp_path):
        proxy_path = str(tmp_path / "proxy-test.jsonl")
        logging_utils.log_proxy_entry(proxy_path, "warn", "test message", extra_field="value")
        [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy-test.jsonl")
        assert entry["level"] == "warn"
        assert entry["message"] == "test message"
        assert entry["extra_field"] == "value"
        assert_utc_millisecond_timestamp(entry["timestamp"])

    def test_sanitizes_structured_url_field(self, tmp_path):
        proxy_path = tmp_path / "proxy-test.jsonl"
        raw_url = "https://user:pass@example.com/v1/search?token=secret#fragment"

        logging_utils.log_proxy_entry(
            str(proxy_path),
            "warn",
            "url diagnostic",
            url=raw_url,
            raw_url_copy=raw_url,
        )

        [entry] = read_jsonl_entries_after_flush(proxy_path)
        assert entry["message"] == "url diagnostic"
        assert entry["url"] == "https://example.com/v1/search"
        assert entry["raw_url_copy"] == raw_url

    def test_appends_multiple_entries(self, tmp_path):
        proxy_path = str(tmp_path / "proxy-test.jsonl")
        logging_utils.log_proxy_entry(proxy_path, "info", "first")
        logging_utils.log_proxy_entry(proxy_path, "warn", "second")
        entries = read_jsonl_entries_after_flush(tmp_path / "proxy-test.jsonl")
        assert len(entries) == 2
        assert entries[0]["message"] == "first"
        assert entries[1]["message"] == "second"

    def test_empty_path_no_op(self, tmp_path):
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_proxy_entry(
                "", "warn", "should not write", payload={"body": b"binary"}
            )

        log.warn.assert_not_called()
        assert not list(tmp_path.iterdir())

    def test_missing_parent_path_warns_and_does_not_raise(self, tmp_path):
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_proxy_entry(
                str(tmp_path / "missing" / "proxy.jsonl"), "warn", "message"
            )
            logging_utils.flush_log_path(str(tmp_path / "missing" / "proxy.jsonl"))

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to write proxy log:" in warning
        assert "FileNotFoundError" in warning

    def test_directory_path_warns_and_does_not_raise(self, tmp_path):
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_proxy_entry(str(tmp_path), "warn", "message")
            logging_utils.flush_log_path(str(tmp_path))

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to write proxy log:" in warning
        assert "IsADirectoryError" in warning

    def test_non_serializable_extra_warns_without_creating_file(self, tmp_path):
        proxy_path = tmp_path / "proxy-test.jsonl"
        log = MagicMock()

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_proxy_entry(
                str(proxy_path), "warn", "message", payload={"body": b"binary"}
            )

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to encode proxy log: TypeError:" in warning
        logging_utils.flush_log_path(str(proxy_path))
        assert not proxy_path.exists()

    def test_extra_cannot_override_reserved_fields(self, tmp_path):
        proxy_path = tmp_path / "proxy-test.jsonl"
        extra = {
            "proxy_log_path": "caller-proxy-log-path",
            "timestamp": "caller-timestamp",
            "level": "caller-level",
            "message": "caller-message",
            "log_level": "caller-log-level",
            "log_message": "caller-log-message",
            "extra_field": "value",
        }

        logging_utils.log_proxy_entry(str(proxy_path), "warn", "logger-message", **extra)

        [entry] = read_jsonl_entries_after_flush(proxy_path)
        assert_utc_millisecond_timestamp(entry["timestamp"])
        assert entry["timestamp"] != "caller-timestamp"
        assert entry["level"] == "warn"
        assert entry["message"] == "logger-message"
        assert entry["proxy_log_path"] == "caller-proxy-log-path"
        assert entry["log_level"] == "caller-log-level"
        assert entry["log_message"] == "caller-log-message"
        assert entry["extra_field"] == "value"


class TestJsonlWriterBehavior:
    def test_flush_all_logs_flushes_multiple_paths(self, tmp_path):
        network_path = tmp_path / "network.jsonl"
        proxy_path = tmp_path / "proxy.jsonl"

        logging_utils.log_network_entry(str(network_path), {"action": "ALLOW"})
        logging_utils.log_proxy_entry(str(proxy_path), "info", "proxy ready")
        logging_utils.flush_all_logs()

        [network_entry] = _read_jsonl_entries_without_flush(network_path)
        [proxy_entry] = _read_jsonl_entries_without_flush(proxy_path)
        assert network_entry["action"] == "ALLOW"
        assert proxy_entry["level"] == "info"
        assert proxy_entry["message"] == "proxy ready"

    def test_shutdown_log_writer_drains_accepted_writes(self, tmp_path):
        proxy_path = tmp_path / "proxy.jsonl"

        logging_utils.log_proxy_entry(str(proxy_path), "info", "before shutdown")
        logging_utils.shutdown_log_writer()

        [entry] = _read_jsonl_entries_without_flush(proxy_path)
        assert entry["level"] == "info"
        assert entry["message"] == "before shutdown"

    def test_write_after_shutdown_warns_without_appending(self, tmp_path):
        proxy_path = tmp_path / "proxy.jsonl"
        log = MagicMock()

        logging_utils.log_proxy_entry(str(proxy_path), "info", "before shutdown")
        logging_utils.shutdown_log_writer()
        before_entries = _read_jsonl_entries_without_flush(proxy_path)

        with patch.object(logging_utils.ctx, "log", log, create=True):
            logging_utils.log_proxy_entry(str(proxy_path), "warn", "after shutdown")

        log.warn.assert_called_once_with("Skipping proxy log write after JSONL writer shutdown")
        after_entries = _read_jsonl_entries_without_flush(proxy_path)
        assert after_entries == before_entries


class TestAddFirewallMetadata:
    def test_copies_valid_firewall_error_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update({metadata_keys.FIREWALL_ERROR: "TOKEN_REFRESH_FAILED"})
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
            "firewall_error": "TOKEN_REFRESH_FAILED",
        }

    def test_copies_valid_connector_diagnostic_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update(
            {
                metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE: "fal",
                metadata_keys.CONNECTOR_DIAGNOSTIC_REASON: "not_configured_for_run",
                metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES: ["FAL_TOKEN"],
                metadata_keys.CONNECTOR_DIAGNOSTIC_BASE: "https://fal.run",
            }
        )
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
            "connector_diagnostic_type": "fal",
            "connector_diagnostic_reason": "not_configured_for_run",
            "connector_diagnostic_env_names": ["FAL_TOKEN"],
            "connector_diagnostic_base": "https://fal.run",
        }

    def test_defaults_missing_required_firewall_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
        }

    def test_defaults_malformed_required_firewall_metadata(self, real_flow):
        for billable in (None, "true", 1):
            flow = real_flow(with_response=False)
            flow.metadata.update(
                {
                    metadata_keys.FIREWALL_BASE: None,
                    metadata_keys.FIREWALL_NAME: 42,
                    metadata_keys.FIREWALL_PERMISSION: False,
                    metadata_keys.FIREWALL_RULE_MATCH: ["GET /items"],
                    metadata_keys.FIREWALL_BILLABLE: billable,
                }
            )
            log_entry = {}

            logging_utils.add_firewall_metadata(flow, log_entry)

            assert log_entry == {
                "firewall_base": "",
                "firewall_name": "",
                "firewall_permission": "",
                "firewall_rule_match": "",
                "firewall_billable": False,
            }

    def test_omits_optional_none_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_PARAMS: None,
                metadata_keys.FIREWALL_ERROR: None,
                metadata_keys.AUTH_RESOLVED_SECRETS: None,
                metadata_keys.AUTH_REFRESHED_CONNECTORS: None,
                metadata_keys.AUTH_REFRESHED_SECRETS: None,
                metadata_keys.AUTH_CACHE_HIT: None,
                metadata_keys.AUTH_URL_REWRITE: None,
            }
        )
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
        }

    def test_omits_malformed_optional_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_PARAMS: {"owner": "vm0-ai", "branch": None},
                metadata_keys.FIREWALL_ERROR: 123,
                metadata_keys.AUTH_RESOLVED_SECRETS: ["GITHUB_TOKEN", None],
                metadata_keys.AUTH_REFRESHED_CONNECTORS: "github",
                metadata_keys.AUTH_REFRESHED_SECRETS: [1],
                metadata_keys.AUTH_CACHE_HIT: "false",
                metadata_keys.AUTH_URL_REWRITE: 1,
                metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE: 1,
                metadata_keys.CONNECTOR_DIAGNOSTIC_REASON: None,
                metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES: ["FAL_TOKEN", None],
                metadata_keys.CONNECTOR_DIAGNOSTIC_BASE: False,
            }
        )
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
        }
