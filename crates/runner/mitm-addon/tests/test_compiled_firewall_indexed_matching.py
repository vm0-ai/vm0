"""Indexed compiled firewall matcher compatibility and scan guardrails."""

import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    network_policy,
    wrap_firewalls,
)


def _assert_indexed_matches_linear(url, method, firewalls, network_policies):
    compiled = compile_firewalls_or_fail(firewalls)

    indexed = matching.match_compiled_firewall_request(
        url,
        method,
        compiled,
        network_policies,
    )
    linear = matching._match_compiled_firewall_request_linear(
        url,
        method,
        compiled,
        network_policies,
    )

    assert indexed == linear
    return indexed


def _long_path(prefix, segment_count=1000):
    return prefix + "/" + "/".join(f"seg-{index}" for index in range(segment_count))


def test_indexed_matches_linear_for_unrelated_authority_candidates():
    firewalls = [
        firewall_entry(
            "unrelated",
            firewall_api(
                "https://api.unrelated.example.com",
                [firewall_permission("unrelated-read", "GET /items/{id}")],
            ),
        ),
        firewall_entry(
            "target",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        ),
    ]
    policies = {
        "unrelated": network_policy(allow=["unrelated-read"]),
        "target": network_policy(allow=["items-read"]),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "target"
    assert result.permission == "items-read"


def test_indexed_matches_linear_for_specific_malformed_auth_precedence():
    firewalls = [
        firewall_entry(
            "broad",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("broad", "ANY /{path+}")],
            ),
        ),
        firewall_entry(
            "admin",
            firewall_api(
                "https://api.example.com/admin",
                [firewall_permission("admin-read", "GET /delete")],
                auth={"headers": None},
            ),
        ),
    ]
    policies = {
        "broad": network_policy(allow=["broad"], unknown_policy="allow"),
        "admin": network_policy(allow=["admin-read"], unknown_policy="allow"),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com/admin/delete",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "admin"
    assert result.reason == "malformed_firewall_config"


def test_indexed_matches_linear_for_parameterized_base_fallback():
    firewalls = [
        firewall_entry(
            "zendesk",
            firewall_api(
                "https://{subdomain}.zendesk.com/api",
                [firewall_permission("tickets-read", "GET /v2/tickets/{id}")],
            ),
        )
    ]
    policies = {"zendesk": network_policy(allow=["tickets-read"])}

    result = _assert_indexed_matches_linear(
        "https://acme.zendesk.com/api/v2/tickets/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"subdomain": "acme", "id": "123"}


def test_indexed_matches_linear_for_malformed_network_policy_precedence():
    firewalls = [
        firewall_entry(
            "example",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        )
    ]
    policies = {"example": {"allow": "items-read", "deny": [], "unknownPolicy": "allow"}}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_network_policy"


def test_indexed_matches_linear_for_any_and_exact_method_order():
    api_entry = firewall_api(
        "https://api.example.com",
        [
            firewall_permission(
                "items-read",
                "ANY /items/{id}",
                "GET /items/{id}",
            )
        ],
    )
    firewalls = wrap_firewalls([api_entry], name="example")
    policies = {"example": network_policy(allow=["items-read"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.rule == "ANY /items/{id}"


def test_indexed_matches_linear_for_greedy_and_mixed_rule_specificity():
    api_entry = firewall_api(
        "https://api.example.com",
        [
            firewall_permission("files-greedy", "GET /files/{path+}"),
            firewall_permission("files-slug", "GET /files/file-{slug}"),
        ],
    )
    firewalls = wrap_firewalls([api_entry], name="example")
    policies = {"example": network_policy(allow=["files-greedy", "files-slug"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/files/file-readme",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "files-slug"
    assert result.params == {"slug": "readme"}


def test_indexed_matches_linear_for_denied_permission_aggregation_order():
    firewalls = [
        firewall_entry(
            "auditor",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("audit-read", "GET /items/{id}")],
            ),
        ),
        firewall_entry(
            "primary",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        ),
    ]
    policies = {
        "auditor": network_policy(deny=["audit-read"]),
        "primary": network_policy(deny=["items-read"]),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("audit-read", "items-read")


def test_indexed_matching_skips_unrelated_static_authority_base_checks(monkeypatch):
    firewalls = [
        firewall_entry(
            f"unrelated-{index}",
            firewall_api(
                f"https://api-{index}.example.com",
                [firewall_permission(f"items-read-{index}", "GET /items/{id}")],
            ),
        )
        for index in range(200)
    ]
    firewalls.append(
        firewall_entry(
            "target",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        )
    )
    policies = {
        firewall["name"]: network_policy(allow=[firewall["apis"][0]["permissions"][0]["name"]])
        for firewall in firewalls
    }
    compiled = compile_firewalls_or_fail(firewalls)
    base_match_count = 0
    original_match_base = matching._match_compiled_base_url_parts

    def counting_match_base(url_parts, base):
        nonlocal base_match_count
        base_match_count += 1
        return original_match_base(url_parts, base)

    monkeypatch.setattr(matching, "_match_compiled_base_url_parts", counting_match_base)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compiled,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "target"
    assert base_match_count == 1


def test_indexed_matching_skips_unrelated_literal_rule_path_checks(monkeypatch):
    permissions = [
        firewall_permission(f"unrelated-{index}", f"GET /items/unrelated-{index}")
        for index in range(500)
    ]
    permissions.append(firewall_permission("target", "GET /items/target"))
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                permissions,
            )
        ],
        name="large",
    )
    policies = {
        "large": network_policy(
            allow=[permission["name"] for permission in permissions],
            unknown_policy="deny",
        )
    }
    compiled = compile_firewalls_or_fail(firewalls)
    path_match_count = 0
    original_allowed_match = matching._match_compiled_path_segments
    original_blocked_match = matching._compiled_path_segments_match

    def counting_allowed_match(path_segs, pattern_segs):
        nonlocal path_match_count
        path_match_count += 1
        return original_allowed_match(path_segs, pattern_segs)

    def counting_blocked_match(path_segs, pattern_segs):
        nonlocal path_match_count
        path_match_count += 1
        return original_blocked_match(path_segs, pattern_segs)

    monkeypatch.setattr(matching, "_match_compiled_path_segments", counting_allowed_match)
    monkeypatch.setattr(
        matching,
        "_compiled_path_segments_match",
        counting_blocked_match,
    )

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/target",
        "GET",
        compiled,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "target"
    assert path_match_count == 1


def test_indexed_matches_linear_for_root_static_base_with_long_path():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}

    result = _assert_indexed_matches_linear(
        f"https://api.example.com{_long_path('/files')}",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "example"
    assert result.permission == "files-read"


def test_indexed_matches_linear_for_nested_static_base_with_long_suffix():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com/admin",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}

    result = _assert_indexed_matches_linear(
        f"https://api.example.com/admin{_long_path('/files')}",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.rel_path.startswith("/files/")
    assert result.permission == "files-read"


def test_indexed_matches_linear_for_repeated_slash_static_base():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com//v1",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com//v1/files//report",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"path": "/report"}


def test_indexed_matches_linear_for_encoded_slash_under_static_base():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com/v1",
                [firewall_permission("repo-read", "GET /repos/{owner}/{repo}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["repo-read"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/v1/repos/acme%2Fteam/project",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"owner": "acme%2Fteam", "repo": "project"}


def test_indexed_matching_long_path_does_not_use_prefix_key_helpers(monkeypatch):
    if hasattr(matching, "_request_api_index_keys"):
        monkeypatch.setattr(
            matching,
            "_request_api_index_keys",
            lambda _url_parts: (_ for _ in ()).throw(
                AssertionError("request prefix keys should not be materialized")
            ),
        )
    if hasattr(matching, "_path_prefix_index_keys"):
        monkeypatch.setattr(
            matching,
            "_path_prefix_index_keys",
            lambda _path_segs: (_ for _ in ()).throw(
                AssertionError("rule prefix keys should not be materialized")
            ),
        )

    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}
    compiled = compile_firewalls_or_fail(firewalls)

    result = matching.match_compiled_firewall_request(
        f"https://api.example.com{_long_path('/files')}",
        "GET",
        compiled,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "files-read"
