"""Tests for registry built-in base URL variable resolution."""

import json
from unittest.mock import MagicMock, patch

import registry
from tests.registry_helpers import write_builtin_firewall_registry


def install_test_builtin_firewall(
    monkeypatch,
    *,
    name: str,
    base: str,
    host_policy: dict | None = None,
) -> None:
    api = {
        "base": base,
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        "permissions": [],
    }
    if host_policy is not None:
        api["hostPolicy"] = host_policy
    monkeypatch.setattr(
        registry,
        "BUILTIN_FIREWALLS",
        {
            name: {
                "name": name,
                "apis": [api],
            }
        },
    )


class TestRegistryBuiltinBaseUrlVars:
    def test_builtin_firewall_entry_resolves_dynamic_base_url_vars(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "firewalls": [
                                {
                                    "kind": "builtin",
                                    "name": "zendesk",
                                    "baseUrlVars": {"ZENDESK_SUBDOMAIN": "acme"},
                                }
                            ],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme.zendesk.com"

    def test_builtin_fixed_provider_suffix_rejects_authority_escape(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-shopify",
            name="shopify",
            base_url_vars={"SHOPIFY_SHOP": "attacker.example:443/capture"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "SHOPIFY_SHOP"' in invalid_vm.message

    def test_builtin_fixed_provider_suffix_rejects_encoded_structure(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-shopify",
            name="shopify",
            base_url_vars={"SHOPIFY_SHOP": "attacker.example%3A443%2Fcapture"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "SHOPIFY_SHOP"' in invalid_vm.message

    def test_builtin_fixed_provider_suffix_accepts_multi_label_fragment(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-snowflake",
            name="snowflake",
            base_url_vars={"SNOWFLAKE_ACCOUNT": "xy12345.us-east-1.aws"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == (
            "https://xy12345.us-east-1.aws.snowflakecomputing.com/api"
        )

    def test_builtin_fixed_provider_suffix_rejects_path_injection(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-snowflake",
            name="snowflake",
            base_url_vars={"SNOWFLAKE_ACCOUNT": "xy12345.us-east-1.aws/capture"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "SNOWFLAKE_ACCOUNT"' in invalid_vm.message

    def test_builtin_provider_owned_whole_authority_accepts_allowed_host(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-jira",
            name="jira",
            base_url_vars={"JIRA_DOMAIN": "acme.atlassian.net"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme.atlassian.net"

    def test_builtin_provider_owned_accepts_idna_dot_equivalent_host(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-jira",
            name="jira",
            base_url_vars={"JIRA_DOMAIN": "acme。atlassian。net"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme。atlassian。net"

    def test_builtin_provider_owned_whole_authority_rejects_unowned_hosts(self, tmp_path):
        for value in [
            "attacker.example",
            "evil-atlassian.net",
            "atlassian.net.evil",
            "127.0.0.1",
        ]:
            path = tmp_path / f"registry-{value.replace('/', '-')}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-jira",
                name="jira",
                base_url_vars={"JIRA_DOMAIN": value},
            )

            with patch.object(registry.ctx, "log", MagicMock(), create=True):
                context = registry.get_vm_context("10.200.0.1", str(path))
                state = registry.load_registry_state(str(path))

            assert context is None
            assert not isinstance(state, registry.RegistryUnavailable)
            invalid_vm = state.invalid_vms["10.200.0.1"]
            assert invalid_vm.reason == "invalid_firewalls"
            assert "host policy does not allow resolved host" in invalid_vm.message

    def test_builtin_provider_owned_whole_authority_rejects_non_default_port(
        self, tmp_path, monkeypatch
    ):
        install_test_builtin_firewall(
            monkeypatch,
            name="provider-owned-port",
            base="https://${{ vars.API_HOST }}:444/v1",
            host_policy={"kind": "providerOwned", "suffixes": ["example.com"]},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-provider-owned-port",
            name="provider-owned-port",
            base_url_vars={"API_HOST": "api.example.com"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert "host policy does not allow non-default ports" in invalid_vm.message

    def test_builtin_whole_authority_rejects_path_injection(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-jira",
            name="jira",
            base_url_vars={"JIRA_DOMAIN": "attacker.example/capture"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "JIRA_DOMAIN"' in invalid_vm.message

    def test_builtin_base_url_var_rejects_firewall_parameter_syntax(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://{host}.example.test"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "STRAPI_BASE_URL"' in invalid_vm.message

    def test_builtin_base_url_var_rejects_unicode_whitespace(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://strapi.example.test/work\u00a0flows"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "STRAPI_BASE_URL"' in invalid_vm.message

    def test_builtin_public_destination_accepts_public_host_with_port(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://strapi.example.test:8443"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == ("https://strapi.example.test:8443")

    def test_builtin_public_destination_accepts_public_ip_literals(self, tmp_path):
        for value in [
            "https://8.8.8.8",
            "https://[2606:4700:4700::1111]",
            "https://[2001:1::1]",
            "https://[2001:1::2]",
            "https://[2001:3::1]",
            "https://[2001:4:112::1]",
            "https://[2001:20::1]",
            "https://[2001:30::1]",
            "https://[2003::1]",
            "https://100.128.0.1",
            "https://172.32.0.1",
            "https://192.0.1.1",
            "https://[3fff::1]",
        ]:
            path = tmp_path / f"registry-{abs(hash(value))}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-strapi",
                name="strapi",
                base_url_vars={"STRAPI_BASE_URL": value},
            )

            context = registry.get_vm_context("10.200.0.1", str(path))

            assert context is not None
            vm_info, compiled_firewalls, _ = context
            assert compiled_firewalls is not None
            assert vm_info["firewalls"][0]["apis"][0]["base"] == value

    def test_builtin_public_destination_rejects_non_public_ip_literals(self, tmp_path):
        for value in [
            "https://127.0.0.1",
            "https://10.0.0.5",
            "https://169.254.1.2",
            "https://192.168.1.10",
            "https://192.0.0.9",
            "https://192.0.0.10",
            "https://224.0.0.1",
            "https://[::1]",
            "https://[fc00::1]",
            "https://[64:ff9b::808:808]",
            "https://[2001::1]",
            "https://[2001:1::3]",
            "https://[2001:2::1]",
            "https://[2001:4::1]",
            "https://[2001:10::1]",
            "https://[2001:1ff::1]",
            "https://[2001:db8::1]",
            "https://[2002:808:808::1]",
            "https://[4000::1]",
            "https://[ff0e::1]",
        ]:
            path = tmp_path / f"registry-{abs(hash(value))}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-strapi",
                name="strapi",
                base_url_vars={"STRAPI_BASE_URL": value},
            )

            with patch.object(registry.ctx, "log", MagicMock(), create=True):
                context = registry.get_vm_context("10.200.0.1", str(path))
                state = registry.load_registry_state(str(path))

            assert context is None
            assert not isinstance(state, registry.RegistryUnavailable)
            invalid_vm = state.invalid_vms["10.200.0.1"]
            assert invalid_vm.reason == "invalid_firewalls"
            assert "host policy does not allow non-public IP literal" in invalid_vm.message

    def test_builtin_public_destination_rejects_scoped_ip_literal(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://[2606:4700:4700::1111%25lo]"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'builtin firewall "strapi" resolved base URL is invalid' in invalid_vm.message

    def test_builtin_base_url_prefix_preserves_fixed_path_suffix(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/workflows"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == (
            "https://n8n.example.test/workflows/api/v1"
        )

    def test_builtin_base_url_prefix_accepts_encoded_path_separator(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/work%2fflows"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == (
            "https://n8n.example.test/work%2fflows/api/v1"
        )

    def test_builtin_base_url_prefix_rejects_path_dot_segments(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/workflows/.."},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "N8N_BASE_URL"' in invalid_vm.message

    def test_builtin_base_url_prefix_rejects_encoded_path_dot_segments(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/workflows/%2e%2e"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "N8N_BASE_URL"' in invalid_vm.message

    def test_builtin_path_segment_var_accepts_fixed_suffix(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "acme:prod"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == (
            "https://api.example.test/accounts/acme:prod/v1"
        )

    def test_builtin_path_segment_var_rejects_path_injection(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "acme/../admin"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "TENANT"' in invalid_vm.message

    def test_builtin_path_segment_var_rejects_encoded_path_separator(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "acme%252fprod"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "TENANT"' in invalid_vm.message

    def test_builtin_path_segment_var_rejects_dot_segment(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "%2e%2e"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "TENANT"' in invalid_vm.message

    def test_builtin_path_segment_var_rejects_path_parameter_dot_segment(
        self, tmp_path, monkeypatch
    ):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "..;type=folder"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "TENANT"' in invalid_vm.message

    def test_builtin_path_segment_var_rejects_nested_encoded_dot_segment(
        self, tmp_path, monkeypatch
    ):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "%252e%252e"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "TENANT"' in invalid_vm.message

    def test_builtin_path_segment_var_rejects_compatibility_dot_segment(
        self, tmp_path, monkeypatch
    ):
        install_test_builtin_firewall(
            monkeypatch,
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "\uff0e\uff0e"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "TENANT"' in invalid_vm.message

    def test_builtin_path_var_allows_dot_outside_dot_segment(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="path-fragment",
            base="https://api.example.test/v${{ vars.VERSION }}",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-path-fragment",
            name="path-fragment",
            base_url_vars={"VERSION": "%2e1"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == ("https://api.example.test/v%2e1")

    def test_builtin_path_vars_reject_combined_dot_segment(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="multi-path-segment",
            base="https://api.example.test/accounts/${{ vars.A }}${{ vars.B }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-multi-path-segment",
            name="multi-path-segment",
            base_url_vars={"A": ".", "B": "."},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert "resolved base URL has unsafe path segments" in invalid_vm.message

    def test_builtin_path_vars_accept_combined_safe_segment(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="multi-path-segment",
            base="https://api.example.test/accounts/${{ vars.A }}${{ vars.B }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-multi-path-segment",
            name="multi-path-segment",
            base_url_vars={"A": "v", "B": "1"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == (
            "https://api.example.test/accounts/v1/v1"
        )

    def test_builtin_port_var_accepts_numeric_port(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="port-api",
            base="https://api.example.test:${{ vars.API_PORT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-port-api",
            name="port-api",
            base_url_vars={"API_PORT": "8443"},
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == ("https://api.example.test:8443/v1")

    def test_builtin_port_var_rejects_non_numeric_port(self, tmp_path, monkeypatch):
        install_test_builtin_firewall(
            monkeypatch,
            name="port-api",
            base="https://api.example.test:${{ vars.API_PORT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-port-api",
            name="port-api",
            base_url_vars={"API_PORT": "443/path"},
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert 'base URL variable "API_PORT"' in invalid_vm.message

    def test_credentialed_builtin_firewall_entry_rejects_http_dynamic_base(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-strapi",
                            "firewalls": [
                                {
                                    "kind": "builtin",
                                    "name": "strapi",
                                    "baseUrlVars": {
                                        "STRAPI_BASE_URL": "http://strapi.example.test"
                                    },
                                }
                            ],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        invalid_vm = state.invalid_vms["10.200.0.1"]
        assert invalid_vm.reason == "invalid_firewalls"
        assert "credentialed base URL must use https" in invalid_vm.message

    def test_credentialed_builtin_firewall_entry_accepts_https_dynamic_base(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-strapi",
                            "firewalls": [
                                {
                                    "kind": "builtin",
                                    "name": "strapi",
                                    "baseUrlVars": {
                                        "STRAPI_BASE_URL": "https://strapi.example.test"
                                    },
                                }
                            ],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == ("https://strapi.example.test")

    def test_builtin_firewall_entry_missing_dynamic_var_rejects_vm(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "firewalls": [{"kind": "builtin", "name": "zendesk"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert "ZENDESK_SUBDOMAIN" in state.invalid_vms["10.200.0.1"].message

    def test_builtin_firewall_entry_does_not_read_top_level_vars(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "vars": {"ZENDESK_SUBDOMAIN": "top-level"},
                            "firewalls": [{"kind": "builtin", "name": "zendesk"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert "ZENDESK_SUBDOMAIN" in state.invalid_vms["10.200.0.1"].message

    def test_unknown_builtin_firewall_entry_rejects_vm(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-missing",
                            "firewalls": [{"kind": "builtin", "name": "missing-firewall"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert "missing-firewall" in state.invalid_vms["10.200.0.1"].message
