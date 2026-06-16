"""Compiled firewall base specificity precedence tests."""

import pytest

import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
    wrap_firewalls,
)

BROAD_BASE = "https://api.example.com"
ADMIN_BASE = "https://api.example.com/admin"
ADMIN_DELETE_URL = "https://api.example.com/admin/delete"


def broad_firewall(*, base=BROAD_BASE):
    return firewall_entry(
        "broad",
        firewall_api(
            base,
            [firewall_permission("broad", "ANY /{path+}")],
            auth_label="broad",
        ),
    )


def test_more_specific_base_deny_blocks_earlier_broad_allow():
    fws = wrap_firewalls(
        [
            firewall_api(
                BROAD_BASE, [firewall_permission("broad", "ANY /{path+}")], auth_label="broad"
            ),
            firewall_api(
                ADMIN_BASE, [firewall_permission("admin", "GET /delete")], auth_label="admin"
            ),
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["broad"], deny=["admin"])}

    result = match_compiled_firewalls(ADMIN_DELETE_URL, fws, policies)

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
                firewall_entry("admin", firewall_api(ADMIN_BASE, [], auth_label="admin")),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(unknown_policy="deny"),
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
                firewall_entry("admin", firewall_api(ADMIN_BASE, [], auth_label="admin")),
            ],
            matching.compile_network_policies(
                {
                    "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                    "admin": network_policy(unknown_policy="broken"),
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
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /{a}literal{b}")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(allow=["admin"], unknown_policy="allow"),
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
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth={"headers": None},
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(allow=["admin"], unknown_policy="allow"),
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
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {"broad": network_policy(allow=["broad"], unknown_policy="allow")},
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
                    firewall_api(
                        f"{ADMIN_BASE}?token=1",
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(allow=["admin"], unknown_policy="allow"),
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
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
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
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
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
    result = match_compiled_firewalls(ADMIN_DELETE_URL, fws, network_policies)

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
                firewall_entry("admin", firewall_api(ADMIN_BASE, [], auth_label="admin")),
            ],
            {
                "broad": network_policy(deny=["broad"]),
                "admin": network_policy(unknown_policy="allow"),
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
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(deny=["broad"]),
                "admin": network_policy(allow=["admin"]),
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
    result = match_compiled_firewalls(ADMIN_DELETE_URL, fws, network_policies)

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
