"""Compiled firewall base and rule path matching tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def test_compiled_mixed_base_path_rejects_empty_capture():
    fws = wrap_firewalls(
        [
            {
                "base": "https://github.com/{owner}/{repo}.git",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "git-read", "rules": ["GET /{path*}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["git-read"], "deny": [], "unknownPolicy": "deny"}}

    matched = matching.match_compiled_firewall_request(
        "https://github.com/octocat/hello.git/info/refs",
        "GET",
        compiled_firewalls,
        policies,
    )
    empty_capture = matching.match_compiled_firewall_request(
        "https://github.com/octocat/.git/info/refs",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert isinstance(matched, matching.FirewallAllow)
    assert matched.params == {
        "owner": "octocat",
        "repo": "hello",
        "path": "info/refs",
    }
    assert empty_capture is None


def test_compiled_rule_accepts_hyphenated_param_name():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.axiom.co",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "ingest", "rules": ["POST /v1/ingest/{dataset-id}"]},
                ],
            }
        ],
        name="axiom",
    )
    policies = {"axiom": {"allow": ["ingest"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.axiom.co/v1/ingest/events",
        "POST",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "ingest"
    assert result.params == {"dataset-id": "events"}


def test_compiled_parameterized_base_treats_encoded_slash_as_segment_content():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme%2Fteam/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"org": "acme%2Fteam", "id": "123"}


def test_compiled_rule_treats_encoded_slash_as_segment_content():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/repos/acme%2Fteam/project",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"owner": "acme%2Fteam", "repo": "project"}


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/files/",
        "https://api.example.com/files//",
    ],
)
def test_compiled_plus_greedy_rule_rejects_only_empty_remaining_segments(url):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /files/{path+}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"


def test_compiled_plus_greedy_rule_preserves_empty_segments_before_non_empty_rest():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /files/{path+}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/files//report",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"path": "/report"}


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com//v1//acme/projects",
        "https://api.example.com/v1//acme/projects",
    ],
)
def test_compiled_parameterized_base_does_not_collapse_empty_segments_inside_base(
    url,
):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


def test_compiled_parameterized_base_rule_does_not_collapse_empty_segments_after_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme//projects",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.path == "//projects"
    assert result.reason == "unknown_endpoint"


def test_compiled_rule_path_can_require_empty_segments_after_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET //projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme//projects",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.rel_path == "//projects"
    assert result.params == {"org": "acme"}


def test_compiled_parameterized_base_path_can_require_empty_segments():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1//{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1//acme/projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"org": "acme"}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme/projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert result is None


def test_compiled_parameterized_base_preserves_repeated_terminal_empty_segments():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}//",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme/projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert result is None

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme//projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"org": "acme"}


def test_compiled_matches_static_base_boundary_and_query():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.anthropic.com/v1/messages",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "messages", "rules": ["ANY /{path*}"]},
                ],
            }
        ],
        name="anthropic",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"anthropic": {"allow": ["messages"], "deny": [], "unknownPolicy": "deny"}}

    url = "https://api.anthropic.com/v1/messages?beta=1"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.rel_path == "/"

    url = "https://api.anthropic.com/v1/messages_fake"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert compiled is None


def test_compiled_static_base_preserves_repeated_terminal_empty_segments():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1//",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /foo"]},
                ],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/foo",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert result is None

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1//foo",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.rel_path == "/foo"


@pytest.mark.parametrize(
    "base",
    [
        "https://api.example.com/static{",
        "https://api.example.com/static}",
    ],
)
def test_compiled_static_base_with_single_brace_is_not_parameterized(base):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        f"{base}/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"id": "123"}
