"""Shared helpers for firewall auth handler tests."""

from mitmproxy import http

import auth
import matching


def _allow_ordinary_upstream_credentials() -> bool:
    return True


async def handle_firewall_request_without_upstream_admission(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> auth.FirewallAuthHandlingResult:
    """Exercise firewall auth independently of production upstream admission."""
    return await auth.handle_firewall_request(
        flow,
        allow,
        vm_info,
        revalidate_ordinary_upstream_credentials=_allow_ordinary_upstream_credentials,
    )


async def apply_requestheaders_auth_without_upstream_admission(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> auth.FirewallHeaderPhaseAuthResult:
    """Exercise early firewall auth independently of production admission."""
    return await auth.try_apply_stream_safe_firewall_auth_for_requestheaders(
        flow,
        allow,
        vm_info,
        revalidate_ordinary_upstream_credentials=_allow_ordinary_upstream_credentials,
    )


def make_allow(
    api_entry: dict,
    *,
    name: str = "test",
    permission: str | None = "send",
    params: dict[str, str] | None = None,
    rule: str | None = "POST /",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    return matching.FirewallAllow(api_entry, name, permission, params or {}, rule, rel_path)
