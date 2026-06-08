"""Compiled firewall precedence, specificity, and permission ordering tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls

DEFAULT_AUTH = object()
BROAD_BASE = "https://api.example.com"
ADMIN_BASE = "https://api.example.com/admin"
ADMIN_DELETE_URL = "https://api.example.com/admin/delete"


def permission(name, rule):
    return {"name": name, "rules": [rule]}


def api_entry(base, permissions, *, auth_label="fixture", auth=DEFAULT_AUTH):
    api_auth = (
        {"headers": {"Authorization": f"Bearer {auth_label}"}} if auth is DEFAULT_AUTH else auth
    )
    return {
        "base": base,
        "auth": api_auth,
        "permissions": list(permissions),
    }


def firewall_entry(name, *apis):
    return {"name": name, "apis": list(apis)}


def policy(*, allow=(), deny=(), ask=(), unknown_policy="deny"):
    network_policy = {
        "allow": list(allow),
        "deny": list(deny),
        "unknownPolicy": unknown_policy,
    }
    if ask:
        network_policy["ask"] = list(ask)
    return network_policy


def match_firewalls(url, firewalls, policies, *, method="GET"):
    return matching.match_compiled_firewall_request(
        url,
        method,
        compile_firewalls_or_fail(firewalls),
        policies,
    )


def broad_firewall(*, base=BROAD_BASE):
    return firewall_entry(
        "broad",
        api_entry(
            base,
            [permission("broad", "ANY /{path+}")],
            auth_label="broad",
        ),
    )


# Permission and cross-firewall ordering precedence


def test_compiled_matches_ask_permission_block():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": [],
            "ask": ["repo-read"],
            "deny": [],
            "unknownPolicy": "allow",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.permissions == ("repo-read",)
    assert compiled.reason == "permission_denied"


@pytest.mark.parametrize("broad_unknown_policy", ["deny", "allow", "broken"])
def test_later_allowed_firewall_wins_after_earlier_unknown_match(
    broad_unknown_policy,
):
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {"allow": [], "deny": [], "unknownPolicy": broad_unknown_policy},
        "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }
    url = "https://api.example.com/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.name == "specific"
    assert compiled.permission == "items-read"


def test_later_denied_firewall_wins_after_earlier_unknown_allow():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {"allow": [], "deny": [], "unknownPolicy": "allow"},
        "specific": {"allow": [], "deny": ["items-read"], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "specific"
    assert result.permissions == ("items-read",)
    assert result.reason == "permission_denied"


def test_later_allowed_firewall_wins_after_earlier_denied_permission_match():
    fws = [
        {
            "name": "auditor",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer auditor"}},
                    "permissions": [
                        {"name": "audit-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "primary",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer primary"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "auditor": {"allow": [], "deny": ["audit-read"], "unknownPolicy": "deny"},
        "primary": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_earlier_allowed_firewall_still_wins_after_later_denied_permission_match():
    fws = [
        {
            "name": "primary",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer primary"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "auditor",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer auditor"}},
                    "permissions": [
                        {"name": "audit-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "primary": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
        "auditor": {"allow": [], "deny": ["audit-read"], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_denied_permission_names_collect_across_firewalls():
    fws = [
        {
            "name": "auditor",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer auditor"}},
                    "permissions": [
                        {"name": "audit-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "primary",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer primary"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "auditor": {"allow": [], "deny": ["audit-read"], "unknownPolicy": "deny"},
        "primary": {"allow": [], "deny": ["items-read"], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "auditor"
    assert result.permissions == ("audit-read", "items-read")
    assert result.reason == "permission_denied"


# Base specificity precedence


def test_more_specific_base_deny_blocks_earlier_broad_allow():
    fws = wrap_firewalls(
        [
            api_entry(BROAD_BASE, [permission("broad", "ANY /{path+}")], auth_label="broad"),
            api_entry(ADMIN_BASE, [permission("admin", "GET /delete")], auth_label="admin"),
        ],
        name="example",
    )
    policies = {"example": policy(allow=["broad"], deny=["admin"])}

    result = match_firewalls(ADMIN_DELETE_URL, fws, policies)

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == ADMIN_BASE
    assert result.path == "/delete"
    assert result.permissions == ("admin",)
    assert result.reason == "permission_denied"


@pytest.mark.parametrize(
    ("fws", "network_policies", "expected"),
    [
        pytest.param(
            [
                broad_firewall(),
                firewall_entry("admin", api_entry(ADMIN_BASE, [], auth_label="admin")),
            ],
            {
                "broad": policy(allow=["broad"], unknown_policy="allow"),
                "admin": policy(unknown_policy="deny"),
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "unknown_endpoint",
            },
            id="specific-unknown-deny-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry("admin", api_entry(ADMIN_BASE, [], auth_label="admin")),
            ],
            matching.compile_network_policies(
                {
                    "broad": policy(allow=["broad"], unknown_policy="allow"),
                    "admin": policy(unknown_policy="broken"),
                }
            ),
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_network_policy",
            },
            id="specific-invalid-unknown-policy-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    api_entry(
                        ADMIN_BASE,
                        [permission("admin", "GET /{a}literal{b}")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": policy(allow=["broad"], unknown_policy="allow"),
                "admin": policy(allow=["admin"], unknown_policy="allow"),
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-rule-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    api_entry(
                        ADMIN_BASE,
                        [permission("admin", "GET /delete")],
                        auth={"headers": None},
                    ),
                ),
            ],
            {
                "broad": policy(allow=["broad"], unknown_policy="allow"),
                "admin": policy(allow=["admin"], unknown_policy="allow"),
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-auth-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "",
                    api_entry(
                        ADMIN_BASE,
                        [permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {"broad": policy(allow=["broad"], unknown_policy="allow")},
            {
                "base": ADMIN_BASE,
                "name": "",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-firewall-name-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    api_entry(
                        f"{ADMIN_BASE}?token=1",
                        [permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": policy(allow=["broad"], unknown_policy="allow"),
                "admin": policy(allow=["admin"], unknown_policy="allow"),
            },
            {
                "base": f"{ADMIN_BASE}?token=1",
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-base-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    api_entry(
                        ADMIN_BASE,
                        [permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": policy(allow=["broad"], unknown_policy="allow"),
                "admin": {
                    "allow": "admin",
                    "deny": [],
                    "unknownPolicy": "allow",
                },
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_network_policy",
            },
            id="specific-malformed-policy-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    api_entry(
                        ADMIN_BASE,
                        [permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            matching.compile_network_policies("broken"),
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_network_policy",
            },
            id="top-level-malformed-policy-blocks-broad-allow",
        ),
    ],
)
def test_more_specific_base_block_precedence_matrix(fws, network_policies, expected):
    result = match_firewalls(ADMIN_DELETE_URL, fws, network_policies)

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == expected["base"]
    assert result.name == expected["name"]
    assert result.path == expected["path"]
    assert result.permissions == expected["permissions"]
    assert result.reason == expected["reason"]


@pytest.mark.parametrize(
    ("fws", "network_policies", "expected"),
    [
        pytest.param(
            [
                broad_firewall(base="https://{workspace}.example.com"),
                firewall_entry("admin", api_entry(ADMIN_BASE, [], auth_label="admin")),
            ],
            {
                "broad": policy(deny=["broad"]),
                "admin": policy(unknown_policy="allow"),
            },
            {
                "authorization": "Bearer admin",
                "name": "admin",
                "permission": None,
                "rule": None,
                "rel_path": "/delete",
            },
            id="specific-unknown-allow-wins-after-broad-deny",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    api_entry(
                        ADMIN_BASE,
                        [permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": policy(deny=["broad"]),
                "admin": policy(allow=["admin"]),
            },
            {
                "authorization": "Bearer admin",
                "name": "admin",
                "permission": "admin",
                "rule": "GET /delete",
                "rel_path": "/delete",
            },
            id="specific-allow-wins-after-broad-deny",
        ),
    ],
)
def test_more_specific_base_allow_precedence_matrix(fws, network_policies, expected):
    result = match_firewalls(ADMIN_DELETE_URL, fws, network_policies)

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == expected["authorization"]
    assert result.name == expected["name"]
    assert result.permission == expected["permission"]
    assert result.rule == expected["rule"]
    assert result.rel_path == expected["rel_path"]


def test_more_specific_parameterized_base_unknown_allow_preserves_params():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "broad", "rules": ["ANY /{path+}"]},
                    ],
                }
            ],
        },
        {
            "name": "tenant",
            "apis": [
                {
                    "base": "https://{workspace}.example.com/api/{tenant}",
                    "auth": {"headers": {"Authorization": "Bearer tenant"}},
                    "permissions": [],
                }
            ],
        },
    ]
    policies = {
        "broad": {
            "allow": [],
            "deny": ["broad"],
            "unknownPolicy": "deny",
        },
        "tenant": {
            "allow": [],
            "deny": [],
            "unknownPolicy": "allow",
        },
    }

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/api/customer-1/users",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer tenant"
    assert result.name == "tenant"
    assert result.permission is None
    assert result.rule is None
    assert result.rel_path == "/users"
    assert result.params == {"workspace": "acme", "tenant": "customer-1"}


def test_more_specific_parameterized_base_allow_preserves_params_after_broad_deny():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://{workspace}.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "broad", "rules": ["ANY /{path+}"]},
                    ],
                }
            ],
        },
        {
            "name": "tenant",
            "apis": [
                {
                    "base": "https://{workspace}.example.com/api/{tenant}",
                    "auth": {"headers": {"Authorization": "Bearer tenant"}},
                    "permissions": [
                        {"name": "user-read", "rules": ["GET /users/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {
            "allow": [],
            "deny": ["broad"],
            "unknownPolicy": "deny",
        },
        "tenant": {
            "allow": ["user-read"],
            "deny": [],
            "unknownPolicy": "deny",
        },
    }

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/api/customer-1/users/42",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer tenant"
    assert result.name == "tenant"
    assert result.permission == "user-read"
    assert result.rule == "GET /users/{id}"
    assert result.rel_path == "/users/42"
    assert result.params == {
        "workspace": "acme",
        "tenant": "customer-1",
        "id": "42",
    }


def test_parameterized_path_base_deny_blocks_earlier_root_allow():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer root"}},
                "permissions": [
                    {"name": "root", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer org"}},
                "permissions": [
                    {"name": "project", "rules": ["GET /projects/{id}"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["root"],
            "deny": ["project"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com/v1/{org}"
    assert result.path == "/projects/123"
    assert result.permissions == ("project",)
    assert result.reason == "permission_denied"


def test_base_specificity_wins_before_rule_specificity():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer root"}},
                "permissions": [
                    {"name": "root-admin", "rules": ["GET /admin/delete"]},
                ],
            },
            {
                "base": "https://api.example.com/admin",
                "auth": {"headers": {"Authorization": "Bearer admin"}},
                "permissions": [
                    {"name": "admin-catchall", "rules": ["ANY /{path+}"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["root-admin"],
            "deny": ["admin-catchall"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com/admin"
    assert result.path == "/delete"
    assert result.permissions == ("admin-catchall",)
    assert result.reason == "permission_denied"


def test_static_host_base_deny_blocks_earlier_wildcard_host_allow():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{network}.g.alchemy.com",
                "auth": {"headers": {"Authorization": "Bearer wildcard"}},
                "permissions": [
                    {"name": "wildcard", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.g.alchemy.com",
                "auth": {"headers": {"Authorization": "Bearer static"}},
                "permissions": [
                    {"name": "static", "rules": ["GET /v2/demo"]},
                ],
            },
        ],
        name="alchemy",
    )
    policies = {
        "alchemy": {
            "allow": ["wildcard"],
            "deny": ["static"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.g.alchemy.com/v2/demo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.g.alchemy.com"
    assert result.path == "/v2/demo"
    assert result.permissions == ("static",)
    assert result.reason == "permission_denied"


def test_same_base_specific_deny_blocks_earlier_broad_allow():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer broad"}},
                "permissions": [
                    {"name": "broad", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer admin"}},
                "permissions": [
                    {"name": "admin", "rules": ["GET /admin/delete"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["broad"],
            "deny": ["admin"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com"
    assert result.path == "/admin/delete"
    assert result.permissions == ("admin",)
    assert result.reason == "permission_denied"


def test_same_base_specific_deny_discards_earlier_broad_deny_permissions():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer broad"}},
                "permissions": [
                    {"name": "broad", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer admin"}},
                "permissions": [
                    {"name": "admin", "rules": ["GET /admin/delete"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": [],
            "deny": ["broad", "admin"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com"
    assert result.path == "/admin/delete"
    assert result.permissions == ("admin",)
    assert result.reason == "permission_denied"


# Malformed policy precedence


def test_later_malformed_policy_wins_after_earlier_unknown_allow():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {"allow": [], "deny": [], "unknownPolicy": "allow"},
        "specific": {"deny": "items-read", "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "specific"
    assert result.permissions == ()
    assert result.reason == "malformed_network_policy"


def test_later_allowed_firewall_wins_after_earlier_malformed_policy_match():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "broad-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": "denied",
        "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }
    url = "https://api.example.com/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.name == "specific"
    assert compiled.permission == "items-read"


# Rule specificity and rule ordering precedence


def test_preserves_config_rule_order_for_any_before_exact_method():
    api_entry = {
        "base": "https://api.github.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {
                "name": "repo-read",
                "rules": [
                    "ANY /repos/{owner}/{repo}",
                    "GET /repos/{owner}/{repo}",
                ],
            }
        ],
    }
    fws = wrap_firewalls([api_entry], name="github")
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is api_entry
    assert result.rule == "ANY /repos/{owner}/{repo}"


def test_runtime_method_is_normalized_before_rule_matching():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "get",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"
    assert result.rule == "GET /repos/{owner}/{repo}"


def test_literal_rule_wins_over_earlier_parameter_rule():
    api_entry = {
        "base": "https://api.x.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
            {"name": "community-search", "rules": ["GET /2/communities/search"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="x")
    policies = {"x": {"allow": [], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.x.com/2/communities/search",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "community-search"
    assert result.rule == "GET /2/communities/search"
    assert result.params == {}


def test_denied_parameter_rule_does_not_block_more_specific_literal_allow():
    api_entry = {
        "base": "https://api.x.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
            {"name": "community-search", "rules": ["GET /2/communities/search"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="x")
    policies = {"x": {"allow": [], "deny": ["community-by-id"], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.x.com/2/communities/search",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "community-search"
    assert result.rule == "GET /2/communities/search"


@pytest.mark.parametrize(
    ("earlier_rule", "later_rule", "url", "expected_rule", "expected_params"),
    [
        (
            "GET /files/{id}",
            "GET /files/file-{slug}",
            "https://api.example.com/files/file-readme",
            "GET /files/file-{slug}",
            {"slug": "readme"},
        ),
        (
            "GET /files/{path+}",
            "GET /files/{id}",
            "https://api.example.com/files/readme",
            "GET /files/{id}",
            {"id": "readme"},
        ),
    ],
)
def test_more_specific_parameter_shape_wins(
    earlier_rule,
    later_rule,
    url,
    expected_rule,
    expected_params,
):
    api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "earlier", "rules": [earlier_rule]},
            {"name": "later", "rules": [later_rule]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="example")
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "later"
    assert result.rule == expected_rule
    assert result.params == expected_params


def test_allowed_parameter_rule_does_not_bypass_more_specific_literal_deny():
    api_entry = {
        "base": "https://api.x.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
            {"name": "community-search", "rules": ["GET /2/communities/search"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="x")
    policies = {"x": {"allow": [], "deny": ["community-search"], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.x.com/2/communities/search",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("community-search",)
    assert result.reason == "permission_denied"


# Permission aggregation and deduplication precedence


def test_later_allowed_permission_still_wins_after_earlier_denied_match():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    {"name": "repo-admin", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": ["repo-admin"],
            "deny": ["repo-read"],
            "unknownPolicy": "deny",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.permission == "repo-admin"


def test_denied_permission_names_keep_encounter_order_and_deduplicate():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {
                        "name": "repo-read",
                        "rules": [
                            "GET /repos/{owner}/{repo}",
                            "ANY /repos/{owner}/{repo}",
                        ],
                    },
                    {"name": "repo-admin", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": [],
            "deny": ["repo-read", "repo-admin"],
            "unknownPolicy": "deny",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.permissions == ("repo-read", "repo-admin")
    assert compiled.reason == "permission_denied"


def test_denied_permission_names_deduplicate_many_same_specificity_candidates():
    matching_rule = "GET /repos/{owner}/{repo}"
    repeated_rule = "ANY /repos/{owner}/{repo}"
    generated_permissions = [
        {"name": f"generated-{index}", "rules": [matching_rule, repeated_rule]}
        for index in range(12)
    ]
    fws = wrap_firewalls(
        [
            api_entry(
                "https://api.github.com",
                [
                    {"name": "repo-read", "rules": [matching_rule, repeated_rule]},
                    *generated_permissions,
                ],
            ),
            api_entry(
                "https://api.github.com",
                [
                    {"name": "repo-write", "rules": [matching_rule]},
                    {"name": "generated-3", "rules": [repeated_rule]},
                    {"name": "repo-read", "rules": [repeated_rule]},
                ],
            ),
        ],
        name="github",
    )
    expected_permissions = (
        "repo-read",
        *(f"generated-{index}" for index in range(12)),
        "repo-write",
    )
    policies = {
        "github": {
            "allow": [],
            "deny": list(expected_permissions),
            "unknownPolicy": "deny",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.permissions == expected_permissions
    assert compiled.reason == "permission_denied"
