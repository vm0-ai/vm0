"""Tests for registry loading and caching."""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

import registry
import state_file
from tests.registry_helpers import (
    pin_mtime,
    write_simple_registry,
)


class TestLoadRegistry:
    def test_loads_valid_registry(self, registry_file):
        result = registry.load_registry(str(registry_file))

        assert "10.200.0.1" in result
        assert result["10.200.0.1"]["runId"] == "run-abc-123"

    def test_classifies_invalid_registered_sandbox_entries(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "run-active",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                        "10.200.0.2": "broken",
                        "10.200.0.3": {"billableFirewalls": []},
                        "10.200.0.4": {"runId": "", "billableFirewalls": []},
                        "10.200.0.5": {"runId": 123, "billableFirewalls": []},
                        "10.200.0.6": {"runId": "  \t", "billableFirewalls": []},
                        "10.200.0.7": {
                            "runId": " run-active ",
                            "billableFirewalls": [],
                        },
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.sandboxes) == {"10.200.0.1"}
        assert set(state.invalid_sandboxes) == {
            "10.200.0.2",
            "10.200.0.3",
            "10.200.0.4",
            "10.200.0.5",
            "10.200.0.6",
            "10.200.0.7",
        }
        assert state.invalid_sandboxes["10.200.0.2"].reason == "invalid_sandbox_entry"
        assert state.invalid_sandboxes["10.200.0.3"].reason == "missing_run_id"
        assert state.invalid_sandboxes["10.200.0.4"].reason == "empty_run_id"
        assert state.invalid_sandboxes["10.200.0.5"].reason == "invalid_run_id"
        assert state.invalid_sandboxes["10.200.0.6"].reason == "empty_run_id"
        assert state.invalid_sandboxes["10.200.0.7"].reason == "invalid_run_id"

    @pytest.mark.parametrize(
        ("sandbox_fields", "expected_reason", "expected_message"),
        [
            pytest.param(
                {"omittedBuiltinFirewalls": "github"},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedBuiltinFirewalls must be a string list",
                id="builtin-omissions-not-list",
            ),
            pytest.param(
                {"omittedBuiltinFirewalls": [""]},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedBuiltinFirewalls must be a string list",
                id="builtin-omissions-empty-member",
            ),
            pytest.param(
                {"omittedBuiltinFirewalls": [1]},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedBuiltinFirewalls must be a string list",
                id="builtin-omissions-non-string-member",
            ),
            pytest.param(
                {"omittedBuiltinFirewalls": ["github", "github"]},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedBuiltinFirewalls must be unique",
                id="builtin-omissions-duplicate",
            ),
            pytest.param(
                {"omittedCustomConnectorIds": "connector-1"},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedCustomConnectorIds must be a string list",
                id="custom-omissions-not-list",
            ),
            pytest.param(
                {"omittedCustomConnectorIds": [""]},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedCustomConnectorIds must be a string list",
                id="custom-omissions-empty-member",
            ),
            pytest.param(
                {"omittedCustomConnectorIds": [1]},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedCustomConnectorIds must be a string list",
                id="custom-omissions-non-string-member",
            ),
            pytest.param(
                {"omittedCustomConnectorIds": ["connector-1", "connector-1"]},
                "invalid_omitted_intents",
                "proxy registry sandbox entry omittedCustomConnectorIds must be unique",
                id="custom-omissions-duplicate",
            ),
            pytest.param(
                {"connectorRoutingVariables": []},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables must be an object",
                id="routing-variables-not-object",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"github": {}}},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables keys must "
                "identify a connector",
                id="routing-identity-unsupported",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"builtin:": {}}},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables keys must "
                "identify a connector",
                id="builtin-routing-identity-empty",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"custom:": {}}},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables keys must "
                "identify a connector",
                id="custom-routing-identity-empty",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"builtin:github": []}},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables values must be string maps",
                id="routing-variable-map-not-object",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"builtin:github": {"HOST": 1}}},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables values must be string maps",
                id="routing-variable-value-not-string",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"builtin:github": {"": "example.test"}}},
                "invalid_connector_routing_variables",
                "proxy registry sandbox entry connectorRoutingVariables values must be string maps",
                id="routing-variable-key-empty",
            ),
        ],
    )
    def test_rejects_invalid_routing_metadata(
        self,
        tmp_path,
        sandbox_fields,
        expected_reason,
        expected_message,
    ):
        path = tmp_path / "registry.json"
        sandbox = {
            "runId": "run-active",
            "billableFirewalls": [],
            "cliAgentType": "claude-code",
            **sandbox_fields,
        }
        path.write_text(json.dumps({"sandboxes": {"10.200.0.1": sandbox}, "updatedAt": 0}))

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.sandboxes == {}
        assert set(state.invalid_sandboxes) == {"10.200.0.1"}
        invalid_sandbox = state.invalid_sandboxes["10.200.0.1"]
        assert invalid_sandbox.reason == expected_reason
        assert invalid_sandbox.message == expected_message

    @pytest.mark.parametrize(
        "sandbox_fields",
        [
            pytest.param({}, id="metadata-absent"),
            pytest.param(
                {
                    "omittedBuiltinFirewalls": [],
                    "omittedCustomConnectorIds": [],
                    "connectorRoutingVariables": {},
                },
                id="metadata-empty",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"builtin:github": {"HOST": "example.test"}}},
                id="builtin-routing-identity",
            ),
            pytest.param(
                {"connectorRoutingVariables": {"custom:connector-1": {"HOST": "example.test"}}},
                id="custom-routing-identity",
            ),
        ],
    )
    def test_accepts_valid_routing_metadata(self, tmp_path, sandbox_fields):
        path = tmp_path / "registry.json"
        sandbox = {
            "runId": "run-active",
            "billableFirewalls": [],
            "cliAgentType": "claude-code",
            **sandbox_fields,
        }
        path.write_text(json.dumps({"sandboxes": {"10.200.0.1": sandbox}, "updatedAt": 0}))

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.sandboxes) == {"10.200.0.1"}
        assert state.invalid_sandboxes == {}

    def test_missing_file_returns_empty(self, tmp_path):
        missing = str(tmp_path / "nonexistent.json")
        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            result = registry.load_registry(missing)
            state = registry.load_registry_state(missing)

        assert result == {}
        assert isinstance(state, registry.RegistryUnavailable)

    def test_cache_returns_same_on_unchanged(self, registry_file):
        result1 = registry.load_registry(str(registry_file))
        result2 = registry.load_registry(str(registry_file))

        assert result1 is result2

    def test_cache_invalidated_on_change(self, registry_file):
        result1 = registry.load_registry(str(registry_file))
        assert "10.200.0.1" in result1

        # Modify the file
        new_data = {
            "sandboxes": {
                "10.200.0.99": {
                    "runId": "new-run",
                    "billableFirewalls": [],
                    "cliAgentType": "claude-code",
                }
            },
            "updatedAt": 0,
        }
        registry_file.write_text(json.dumps(new_data))

        result2 = registry.load_registry(str(registry_file))
        assert "10.200.0.99" in result2
        assert "10.200.0.1" not in result2

    def test_cache_is_scoped_to_registry_path(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        write_simple_registry(path_a, run_id="run-one")
        write_simple_registry(path_b, run_id="run-two")
        pin_mtime(path_a)
        pin_mtime(path_b)
        assert path_a.stat().st_size == path_b.stat().st_size

        first = registry.load_registry(str(path_a))
        second = registry.load_registry(str(path_b))

        assert first["10.200.0.1"]["runId"] == "run-one"
        assert second["10.200.0.1"]["runId"] == "run-two"
        assert second is not first

    def test_missing_different_path_does_not_return_previous_cache(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        missing_b = tmp_path / "registry-b.json"
        write_simple_registry(path_a)
        registry.load_registry(str(path_a))

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            result = registry.load_registry(str(missing_b))

        assert result == {}
        assert log.warn.call_count == 1
        assert "registry-b.json" in log.warn.call_args_list[0].args[0]

    def test_atomic_replacement_reloads_same_size_same_mtime_registry(self, tmp_path):
        path = tmp_path / "registry.json"
        replacement = tmp_path / "registry.json.tmp"
        write_simple_registry(path, run_id="run-one")
        pin_mtime(path)
        first = registry.load_registry(str(path))

        write_simple_registry(replacement, run_id="run-two")
        assert replacement.stat().st_size == path.stat().st_size
        pin_mtime(replacement)
        replacement.replace(path)

        second = registry.load_registry(str(path))

        assert first["10.200.0.1"]["runId"] == "run-one"
        assert second["10.200.0.1"]["runId"] == "run-two"
        assert second is not first

    def test_invalid_sandbox_entries_do_not_block_valid_sandboxes(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "good-run",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                        "10.200.0.2": None,
                        "10.200.0.3": "broken",
                        "10.200.0.4": ["broken"],
                        "10.200.0.5": 42,
                    },
                    "updatedAt": 0,
                }
            )
        )

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            result = registry.load_registry(str(path))
            cached = registry.load_registry(str(path))

        assert result == {
            "10.200.0.1": {
                "runId": "good-run",
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
            }
        }
        assert cached is result
        assert log.warn.call_count == 1
        warning = log.warn.call_args_list[0].args[0]
        assert "Rejected 4 invalid proxy registry sandbox entries" in warning
        assert "10.200.0.2" not in warning
        assert "good-run" not in warning

    def test_missing_file_logs_once_across_calls(self, tmp_path):
        """Stat-path failures repeated across requests emit at most one warn."""
        missing = str(tmp_path / "nonexistent.json")
        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            for _ in range(5):
                assert registry.load_registry(missing) == {}

        assert log.warn.call_count == 1
        assert "Failed to stat" in log.warn.call_args_list[0].args[0]

    def test_missing_file_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.unlink()

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "stat_failed"
        assert log.warn.call_count == 1
        assert "Failed to stat" in log.warn.call_args_list[0].args[0]

    def test_symlink_after_success_does_not_return_previous_snapshot(
        self,
        registry_file,
        tmp_path,
    ):
        loaded = registry.load_registry(str(registry_file))
        assert loaded["10.200.0.1"]["runId"] == "run-abc-123"
        target = tmp_path / "outside-registry.json"
        write_simple_registry(target, run_id="outside-run")
        registry_file.unlink()
        registry_file.symlink_to(target)

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            result = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "stat_failed"

    def test_oversized_registry_is_unavailable_before_parsing(self, tmp_path):
        path = tmp_path / "registry.json"
        max_registry_bytes = 5
        path.write_bytes(b" " * (max_registry_bytes + 1))
        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry, "MAX_REGISTRY_BYTES", max_registry_bytes),
            patch.object(registry.json, "loads", wraps=registry.json.loads) as spy,
        ):
            state = registry.load_registry_state(str(path))

        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "read_failed"
        assert spy.call_count == 0
        assert log.warn.call_count == 1
        assert "exceeds" in log.warn.call_args_list[0].args[0]

    def test_parse_failure_logs_once_and_does_not_reparse(self, tmp_path):
        """Parse failure on a fixed file: key match short-circuits re-parse."""
        bad = tmp_path / "bad.json"
        bad.write_text("{ not valid json")
        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "loads", wraps=registry.json.loads) as spy,
        ):
            for _ in range(5):
                assert registry.load_registry(str(bad)) == {}

        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_parse_failure_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.write_text("{ not valid json after success")

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "loads", wraps=registry.json.loads) as spy,
        ):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    @pytest.mark.parametrize(
        "registry_payload",
        [
            pytest.param(
                b'{"sandboxes":' + b"[" * 10000 + b"0" + b"]" * 10000 + b"}",
                id="decoder-recursion",
            ),
            pytest.param(
                b'{"sandboxes":' + b"1" * 10000 + b"}",
                id="integer-digit-limit",
            ),
        ],
    )
    def test_json_parser_failure_after_success_marks_registry_unavailable(
        self,
        registry_file,
        registry_payload,
    ):
        loaded = registry.load_registry(str(registry_file))
        assert loaded["10.200.0.1"]["runId"] == "run-abc-123"

        registry_file.write_bytes(registry_payload)

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "loads", wraps=registry.json.loads) as spy,
        ):
            state1 = registry.load_registry_state(str(registry_file))
            state2 = registry.load_registry_state(str(registry_file))
            sandbox_info = registry.get_sandbox_info("10.200.0.1", str(registry_file))

        assert isinstance(state1, registry.RegistryUnavailable)
        assert isinstance(state2, registry.RegistryUnavailable)
        assert state1.reason == "parse_failed"
        assert state2.reason == "parse_failed"
        assert sandbox_info is None
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_non_object_sandboxes_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.write_text(json.dumps({"sandboxes": ["broken"], "updatedAt": 0}))

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "loads", wraps=registry.json.loads) as spy,
        ):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_non_object_registry_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.write_text(json.dumps(["broken"]))

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "loads", wraps=registry.json.loads) as spy,
        ):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_new_bad_registry_key_rewarns_without_success_between_failures(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text("{ broken")

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            registry.load_registry(str(path))
            assert log.warn.call_count == 1

            path.write_text("{ broken again, different size")
            registry.load_registry(str(path))

        assert log.warn.call_count == 2
        assert all("Failed to parse" in call.args[0] for call in log.warn.call_args_list)

    def test_read_failure_after_open_does_not_poison_file_key(self, registry_file):
        registry.load_registry(str(registry_file))
        new_registry = {
            "sandboxes": {
                "10.200.0.99": {
                    "runId": "new-run",
                    "billableFirewalls": [],
                    "cliAgentType": "claude-code",
                }
            },
            "updatedAt": 0,
        }
        registry_file.write_text(json.dumps(new_registry))
        read_results = iter(
            [
                OSError("read failed"),
                json.dumps(new_registry).encode(),
                b"",
            ]
        )

        def read_with_one_failure(_fd, _count):
            result = next(read_results)
            if isinstance(result, OSError):
                raise result
            return result

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(state_file.os, "read", side_effect=read_with_one_failure) as spy,
        ):
            failed = registry.load_registry(str(registry_file))
            recovered = registry.load_registry(str(registry_file))

        assert failed == {}
        assert recovered == {
            "10.200.0.99": {
                "runId": "new-run",
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
            }
        }
        assert spy.call_count == 3
        assert log.warn.call_count == 1
        assert "Failed to read" in log.warn.call_args_list[0].args[0]

    def test_read_failure_clears_previous_failed_key(self, tmp_path):
        path = tmp_path / "registry.json"
        valid_registry = {
            "sandboxes": {
                "10.0.0.1": {
                    "runId": "r1",
                    "billableFirewalls": [],
                    "cliAgentType": "claude-code",
                }
            }
        }
        valid_bytes = json.dumps(valid_registry, separators=(",", ":")).encode()
        path.write_bytes(b"{" + b" " * (len(valid_bytes) - 1))
        first_stat = path.stat()

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            assert registry.load_registry(str(path)) == {}

            path.write_bytes(b"x" * (len(valid_bytes) + 1))
            with patch.object(state_file.os, "read", side_effect=OSError("read failed")):
                assert registry.load_registry(str(path)) == {}

            path.write_bytes(valid_bytes)
            os.utime(path, ns=(first_stat.st_atime_ns, first_stat.st_mtime_ns))
            recovered_stat = path.stat()
            assert (
                recovered_stat.st_dev,
                recovered_stat.st_ino,
                recovered_stat.st_mtime_ns,
                recovered_stat.st_size,
            ) == (
                first_stat.st_dev,
                first_stat.st_ino,
                first_stat.st_mtime_ns,
                first_stat.st_size,
            )
            recovered = registry.load_registry(str(path))

        assert recovered == {
            "10.0.0.1": {
                "runId": "r1",
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
            }
        }
        assert log.warn.call_count == 2
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]
        assert "Failed to read" in log.warn.call_args_list[1].args[0]

    def test_recovery_after_parse_failure_rewarns_on_next_failure(self, tmp_path):
        """Successful load clears the flag so a later failure re-warns once."""
        path = tmp_path / "registry.json"
        path.write_text("{ broken")
        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            registry.load_registry(str(path))  # parse fails → warn #1
            assert log.warn.call_count == 1

            # File becomes valid → successful load clears the flag.
            path.write_text(
                json.dumps(
                    {
                        "sandboxes": {
                            "10.0.0.1": {
                                "runId": "r1",
                                "billableFirewalls": [],
                                "cliAgentType": "claude-code",
                            }
                        }
                    }
                )
            )
            result = registry.load_registry(str(path))
            assert "10.0.0.1" in result
            assert log.warn.call_count == 1  # no new warn on success

            # File breaks again. Different size than the good content above
            # busts the cache key so the parse re-runs; the successful load
            # reset the flag, so this failure warns again.
            path.write_text("{ broken again, different size")
            registry.load_registry(str(path))
            assert log.warn.call_count == 2
