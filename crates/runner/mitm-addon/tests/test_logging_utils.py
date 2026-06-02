"""Tests for mitm addon logging utilities."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import flow_metadata_keys as metadata_keys
import logging_utils
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class TestLogNetworkEntry:
    def test_writes_jsonl(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"action": "ALLOW", "host": "example.com"}

        with patch.object(logging_utils.ctx, "log", MagicMock(), create=True):
            logging_utils.log_network_entry(log_path, entry)

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["action"] == "ALLOW"
        assert parsed["host"] == "example.com"
        assert_utc_millisecond_timestamp(parsed["timestamp"])
        assert "timestamp" not in entry

    def test_timestamp_is_authoritative(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"timestamp": "caller-timestamp", "action": "ALLOW"}

        with patch.object(logging_utils.ctx, "log", MagicMock(), create=True):
            logging_utils.log_network_entry(log_path, entry)

        parsed = json.loads(Path(log_path).read_text().strip())
        assert_utc_millisecond_timestamp(parsed["timestamp"])
        assert parsed["timestamp"] != "caller-timestamp"
        assert entry["timestamp"] == "caller-timestamp"

    def test_appends_multiple(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")

        with patch.object(logging_utils.ctx, "log", MagicMock(), create=True):
            logging_utils.log_network_entry(log_path, {"n": 1})
            logging_utils.log_network_entry(log_path, {"n": 2})

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 2

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
        assert not log_path.exists()


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
