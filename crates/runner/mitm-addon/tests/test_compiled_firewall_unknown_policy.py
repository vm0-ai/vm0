"""Compiled firewall unknown-policy and unsafe-path tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def test_compiled_matches_unknown_policy_when_api_has_no_permissions():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    url = "https://api.example.com/items"

    allow_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        allow_policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.permission is None

    ask_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "ask"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        ask_policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.reason == "unknown_endpoint"


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/items/../admin",
        "https://api.example.com/items/%2e%2e/admin",
        "https://api.example.com/items/%/admin",
        "https://api.example.com/items/%zz/admin",
        "https://api.example.com/items/%25zz/admin",
        "https://api.example.com/items/%00/admin",
        "https://api.example.com/items/%2500/admin",
        "https://api.example.com/items/%7f/admin",
        "https://api.example.com/items/%ef%bc%8e%ef%bc%8e/admin",
        "https://api.example.com/items/%ef%bc%8f../admin",
        "https://api.example.com/items/%ef%bc%bcadmin",
        "https://api.example.com/items/%ef%bc%852e/admin",
        "https://api.example.com/items/%ff/admin",
        "https://api.example.com/items/%25ff/admin",
        "https://api.example.com/items/%ed%a0%80/admin",
        "https://api.example.com/items\\admin",
        "https://api.example.com/items/%5cadmin",
        "https://api.example.com/items/%5Cadmin",
        "https://api.example.com/items/%5c..%5cadmin",
        "https://api.example.com/items/%5C..%5Cadmin",
    ],
)
def test_compiled_blocks_unsafe_path(url):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "full-access", "rules": ["ANY /{path+}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["full-access"], "deny": [], "unknownPolicy": "allow"}}

    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.reason == "unsafe_path"
    assert compiled.permissions == ()


def test_compiled_allows_encoded_backslash_in_query():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    compiled = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123?next=%5csecret",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.permission == "read"


def test_compiled_blocks_unsafe_path_consumed_by_parameterized_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/api/{tenant}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "admin", "rules": ["GET /admin"]},
                ],
            }
        ],
        name="example",
    )
    url = "https://api.example.com/api/%2e%2e/admin"
    policies = {"example": {"allow": ["admin"], "deny": [], "unknownPolicy": "allow"}}

    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.reason == "unsafe_path"
    assert compiled.path == "/admin"


def test_compiled_matches_unknown_policy_when_permissions_are_omitted():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {},
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission is None


@pytest.mark.parametrize(
    "network_policies",
    [
        None,
        {"example": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"}},
        {"example": {"allow": [], "deny": [], "ask": [], "unknownPolicy": None}},
    ],
)
def test_compiled_unknown_allow_preserves_base_params(network_policies):
    fws = wrap_firewalls(
        [
            {
                "base": "https://{workspace}.example.com/api/{tenant}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/api/customer-1/users",
        "GET",
        compiled_firewalls,
        network_policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission is None
    assert result.rule is None
    assert result.rel_path == "/users"
    assert result.params == {"workspace": "acme", "tenant": "customer-1"}


def test_compiled_unknown_allow_uses_first_matching_best_base_api_entry():
    first_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer first"}},
        "permissions": [],
    }
    second_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer second"}},
        "permissions": [],
    }
    fws = wrap_firewalls([first_api_entry, second_api_entry], name="example")
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is first_api_entry
    assert result.permission is None
    assert result.rule is None
