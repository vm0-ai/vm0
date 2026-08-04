"""Tests for built-in registry catalog payload and trust validation."""

from unittest.mock import patch

import pytest

import builtin_connector_diagnostics
import builtin_firewall_cache
import registry
import state_file
from tests.registry_builtin_helpers import (
    cache_firewall,
    write_catalog_cache,
    write_registry_with_cache,
)
from tests.registry_helpers import (
    assert_invalid_builtin_vm,
    builtin_vm,
    write_multi_vm_registry,
    write_trusted_catalog_cache_text,
)


def _assert_invalid_builtin_vm_with_cache(
    *,
    registry_path,
    cache_path,
    mitm_ctx,
    expected_message: str,
) -> None:
    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
    ):
        invalid_vm = assert_invalid_builtin_vm(registry_path)

    assert expected_message in invalid_vm.message


def _assert_cache_firewall_is_invalid(
    tmp_path,
    mitm_ctx,
    firewall: dict,
    *,
    expected_message: str = "catalog cache unavailable: cache_invalid",
    cache_mode: int | None = None,
) -> None:
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls={"fallback": firewall},
    )
    if cache_mode is not None:
        cache_path.chmod(cache_mode)
    write_multi_vm_registry(
        registry_path,
        {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
    )

    _assert_invalid_builtin_vm_with_cache(
        registry_path=registry_path,
        cache_path=cache_path,
        mitm_ctx=mitm_ctx,
        expected_message=expected_message,
    )


class TestRegistryBuiltinCatalogValidation:
    def test_runner_catalog_cache_fstat_failure_reports_unavailable(self, tmp_path):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        cache_path.write_text("{}")
        error = OSError("fstat failed")

        with patch.object(state_file.os, "fstat", side_effect=error):
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is None
        assert snapshot.catalog is None
        assert snapshot.cache_path == str(cache_path.absolute())
        assert snapshot.unavailable_reason == "cache_unavailable"

    def test_runner_catalog_cache_directory_reports_not_regular(self, tmp_path):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        cache_path.mkdir()

        snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is None
        assert snapshot.catalog is None
        assert snapshot.cache_path == str(cache_path.absolute())
        assert snapshot.unavailable_reason == "cache_not_regular"

    def test_runner_catalog_cache_rejects_initial_oversize_before_parsing(self, tmp_path, mitm_ctx):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": cache_firewall("fallback", "https://cache.example.com")},
        )
        actual_size = cache_path.stat().st_size

        with (
            mitm_ctx(),
            patch.object(
                builtin_firewall_cache,
                "MAX_BUILTIN_FIREWALL_CATALOG_BYTES",
                actual_size - 1,
            ),
            patch.object(
                builtin_firewall_cache.json,
                "loads",
                wraps=builtin_firewall_cache.json.loads,
            ) as spy,
        ):
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is not None
        assert snapshot.dependency_file_key.st_size == actual_size
        assert snapshot.catalog is None
        assert snapshot.unavailable_reason == "cache_invalid"
        assert spy.call_count == 0

    @pytest.mark.parametrize(
        "template_whitespace",
        [" ", "\ufeff"],
        ids=["space", "byte-order-mark"],
    )
    def test_runner_catalog_cache_accepts_valid_template_base(
        self, tmp_path, mitm_ctx, template_whitespace
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {
                "10.200.0.1": builtin_vm(
                    "run-template",
                    "templated",
                    {"TENANT": "acme"},
                )
            },
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": (
                                "https://${{"
                                + template_whitespace
                                + "vars.TENANT"
                                + template_whitespace
                                + "}}.example.com"
                            ),
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme.example.com"

    def test_malformed_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_trusted_catalog_cache_text(cache_path, '{"schemaVersion":1}')
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        _assert_invalid_builtin_vm_with_cache(
            registry_path=registry_path,
            cache_path=cache_path,
            mitm_ctx=mitm_ctx,
            expected_message="catalog cache unavailable: cache_invalid",
        )

    def test_empty_api_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": {"name": "fallback", "apis": []}},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        _assert_invalid_builtin_vm_with_cache(
            registry_path=registry_path,
            cache_path=cache_path,
            mitm_ctx=mitm_ctx,
            expected_message="catalog cache unavailable: cache_invalid",
        )

    def test_malformed_static_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "not-a-url"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    @pytest.mark.parametrize(
        "base",
        [
            "https://api.example.com/a/../admin",
            "https://api.example.com/%252e%252e/admin",
            "https://api.example.com/..;version=1/admin",
            "https://api.example.com/%255cadmin",
            "https://api.example.com/v1/../{org}",
            "https://${{ vars.TENANT }}.example.com/v1/../items",
            "${{ vars.API_BASE_URL }}/v1/%2e%2e/items",
        ],
    )
    def test_unsafe_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx, base):
        firewall = cache_firewall("fallback", base)
        firewall["apis"][0].pop("hostPolicy")

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_parameterized_base_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://api.{tenant+}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_template_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ secrets.TENANT }}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_python_only_template_whitespace_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{\u0085vars.TENANT\u0085}}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_template_parameter_base_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ vars.TENANT }}.{tenant+}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_non_ascii_template_variable_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ vars.\u00e9 }}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_auth_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["auth"] = {"base": "http://auth.example.com"}

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_world_writable_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")

        _assert_cache_firewall_is_invalid(
            tmp_path,
            mitm_ctx,
            firewall,
            expected_message="catalog cache unavailable: cache_untrusted",
            cache_mode=0o666,
        )

    def test_world_writable_runner_catalog_cache_reports_untrusted(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": cache_firewall("fallback", "https://cache.example.com")},
        )
        cache_path.chmod(0o666)
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        _assert_invalid_builtin_vm_with_cache(
            registry_path=registry_path,
            cache_path=cache_path,
            mitm_ctx=mitm_ctx,
            expected_message="catalog cache unavailable: cache_untrusted",
        )

    def test_malformed_aws_sigv4_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        del firewall["apis"][0]["auth"]["awsSigv4"]["secretAccessKey"]

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_host_policy_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["hostPolicy"] = {
            "kind": "providerOwned",
            "exactHosts": ["127.0.0.1"],
        }

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_permission_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["rules"] = []

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    @pytest.mark.parametrize("permission_name", ["all", "__unknown__"])
    def test_reserved_permission_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx, permission_name
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["name"] = permission_name
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
            firewalls={"fallback": firewall},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            cache_snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            assert cache_snapshot.dependency_file_key is not None
            assert cache_snapshot.catalog is None
            assert cache_snapshot.unavailable_reason == "cache_invalid"

            diagnostic_snapshot = builtin_connector_diagnostics.load_diagnostic_snapshot(
                cache_snapshot
            )
            assert diagnostic_snapshot.catalog_identity is None
            assert diagnostic_snapshot.catalog is None
            assert diagnostic_snapshot.unavailable_reason == "cache_invalid"

            diagnostic_candidate = builtin_connector_diagnostics.find_candidate(
                diagnostic_snapshot,
                "https://cache.example.com/items",
                "GET",
                active_firewall_names=set(),
            )
            assert diagnostic_candidate is None

            invalid_vm = assert_invalid_builtin_vm(registry_path)
            assert "catalog cache unavailable: cache_invalid" in invalid_vm.message

    def test_malformed_rule_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["rules"] = ["GET /items/{path+}/tail"]

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)
