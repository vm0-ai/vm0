"""Raw firewall request network policy decision tests."""

import pytest

import matching
from tests.firewall_helpers import match_request_with_raw_firewalls, wrap_firewalls


class TestFirewallNetworkPolicyDecisions:
    """Tests for request-layer allow, deny, ask, and unknown-policy decisions."""

    def _firewalls(self):
        return wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        {"name": "repo-write", "rules": ["PUT /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )

    def test_allowed_permission_passes(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "deny"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_denied_permission_blocked(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "deny"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_denied_permission_blocked_with_case_mixed_static_host(self):
        policies = {
            "github": {"allow": [], "deny": ["repo-read"], "ask": [], "unknownPolicy": "deny"}
        }
        result = match_request_with_raw_firewalls(
            "https://API.GitHub.COM/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read",)
        assert result.reason == "permission_denied"

    def test_uncategorized_permission_allowed(self):
        """Permission not in allow/deny/ask defaults to allowed."""
        policies = {"github": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "deny"}}
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_ask_permission_blocked(self):
        """Permission in ask list is treated as denied at proxy level."""
        policies = {
            "github": {"allow": [], "deny": [], "ask": ["repo-read"], "unknownPolicy": "allow"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_deny_and_ask_union(self):
        """Permissions in deny and ask are both blocked."""
        policies = {
            "github": {
                "allow": [],
                "deny": ["repo-read"],
                "ask": ["repo-write"],
                "unknownPolicy": "allow",
            }
        }
        # repo-read in deny → blocked
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"
        # repo-write in ask → blocked
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_unknown_policy_key_missing_defaults_to_allow(self):
        """Ref present but unknownPolicy key absent → defaults to allow."""
        policies = {"github": {"allow": ["repo-read"], "deny": ["repo-write"]}}
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None

    def test_permission_in_both_allow_and_deny_is_blocked(self):
        """deny takes precedence when permission appears in both allow and deny."""
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-read"], "unknownPolicy": "allow"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_unknown_endpoint_allowed_when_unknown_policy_allow(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "allow"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None
        assert result.rule is None

    def test_unknown_endpoint_blocked_when_unknown_policy_deny(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "deny"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

    def test_unknown_endpoint_blocked_when_unknown_policy_ask(self):
        """unknownPolicy 'ask' is treated as deny at the proxy level."""
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "ask"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

    def test_name_absent_allows(self):
        """Name not in networkPolicies → fully permissive."""
        policies = {}  # github not in map
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_no_base_match_returns_none(self):
        policies = {}
        result = match_request_with_raw_firewalls(
            "https://api.example.com/foo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert result is None

    def test_none_network_policies_allows_all(self):
        """None networkPolicies → empty map → absent names are fully permissive."""
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, matching.FirewallAllow)

        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, matching.FirewallAllow)

    @pytest.mark.parametrize(
        "policies",
        [
            {"github": {"deny": None, "ask": [], "unknownPolicy": "deny"}},
            {"github": {"deny": [], "ask": None, "unknownPolicy": "deny"}},
        ],
    )
    def test_null_permission_lists_behave_as_empty(self, policies):
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    @pytest.mark.parametrize(
        "policies",
        [
            {"github": None},
            {"github": "denied"},
            {"github": {"deny": "repo-read", "ask": [], "unknownPolicy": "allow"}},
            {"github": {"deny": [], "ask": [None], "unknownPolicy": "allow"}},
        ],
    )
    def test_malformed_permission_policy_fails_closed_after_base_match(self, policies):
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_top_level_malformed_network_policy_fails_closed_after_base_match(self):
        unrelated = match_request_with_raw_firewalls(
            "https://api.example.com/foo",
            "GET",
            self._firewalls(),
            network_policies="denied",
        )
        matched = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies="denied",
        )

        assert unrelated is None
        assert isinstance(matched, matching.FirewallBlock)
        assert matched.permissions == ()
        assert matched.reason == "malformed_network_policy"

    def test_invalid_unknown_policy_only_blocks_unknown_endpoint_branch(self):
        policies = {"github": {"deny": [], "ask": [], "unknownPolicy": "broken"}}

        allowed = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        blocked = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )

        assert isinstance(allowed, matching.FirewallAllow)
        assert allowed.permission == "repo-read"
        assert isinstance(blocked, matching.FirewallBlock)
        assert blocked.reason == "malformed_network_policy"

    def test_empty_permissions_with_unknown_policy_allow(self):
        """Firewall with no permission rules + unknownPolicy=allow allows all."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.hubspot.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [],
                }
            ],
            name="hubspot",
        )
        policies = {"hubspot": {"allow": [], "unknownPolicy": "allow"}}
        result = match_request_with_raw_firewalls(
            "https://api.hubspot.com/crm/v3/objects",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None

    def test_overlapping_permissions_allows_if_any_not_blocked(self):
        """Same endpoint in two permissions — one denied, one allowed → ALLOW."""
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
            "github": {"allow": ["repo-admin"], "deny": ["repo-read"], "unknownPolicy": "deny"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-admin"

    def test_overlapping_permissions_denies_if_all_blocked(self):
        """Same endpoint in two permissions — both denied → DENY."""
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
                "allow": ["issues-read"],
                "deny": ["repo-read", "repo-admin"],
                "unknownPolicy": "deny",
            }
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read", "repo-admin")
        assert result.reason == "permission_denied"

    def test_multi_firewall_different_names(self):
        """Two firewalls with different names, each with own policies."""
        fws = [
            {
                "name": "github",
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {"headers": {"Authorization": "Bearer gh"}},
                        "permissions": [
                            {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        ],
                    }
                ],
            },
            {
                "name": "slack",
                "apis": [
                    {
                        "base": "https://slack.com/api",
                        "auth": {"headers": {"Authorization": "Bearer sl"}},
                        "permissions": [
                            {"name": "channels:read", "rules": ["GET /conversations.list"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"},
            "slack": {"allow": [], "deny": ["channels:read"], "unknownPolicy": "allow"},
        }
        # GitHub: not in deny → ALLOW
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "github"

        # Slack: channels:read explicitly denied → DENY
        result = match_request_with_raw_firewalls(
            "https://slack.com/api/conversations.list",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

        # Slack: unknown endpoint → ALLOW (unknownPolicy: allow)
        result = match_request_with_raw_firewalls(
            "https://slack.com/api/users.info",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "slack"
        assert result.permission is None

    def test_different_unknown_policy_per_name(self):
        """unknownPolicy differs per firewall name — github strict, slack permissive."""
        fws = [
            {
                "name": "github",
                "apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}],
            },
            {
                "name": "slack",
                "apis": [{"base": "https://slack.com/api", "auth": {"headers": {}}}],
            },
        ]
        policies = {
            "github": {"allow": [], "deny": [], "unknownPolicy": "deny"},
            "slack": {"allow": [], "deny": [], "unknownPolicy": "allow"},
        }
        # GitHub unknown → DENY (unknownPolicy: deny)
        result = match_request_with_raw_firewalls(
            "https://api.github.com/anything",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

        # Slack unknown → ALLOW (unknownPolicy: allow)
        result = match_request_with_raw_firewalls(
            "https://slack.com/api/anything",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_denied_known_not_overridden_by_unknown_policy(self):
        """A known permission that is denied must stay denied even with unknownPolicy=allow."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-write", "rules": ["PUT /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )
        policies = {"github": {"allow": [], "deny": ["repo-write"], "unknownPolicy": "allow"}}
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "PUT",
            fws,
            network_policies=policies,
        )
        # repo-write explicitly denied → DENY, not overridden by unknownPolicy
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-write",)
        assert result.reason == "permission_denied"

    def test_denied_permission_deduped_across_rules(self):
        """Same permission with multiple matching rules appears once in permissions."""
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
                    ],
                }
            ],
            name="github",
        )
        policies = {"github": {"allow": [], "deny": ["repo-read"], "unknownPolicy": "deny"}}
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read",)
        assert result.reason == "permission_denied"

    def test_empty_permissions_list_denies_all_known(self):
        """All permissions in deny list — all known endpoints denied."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        {"name": "repo-write", "rules": ["PUT /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )
        policies = {
            "github": {"allow": [], "deny": ["repo-read", "repo-write"], "unknownPolicy": "deny"}
        }
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_name_absent_from_policies_allows(self):
        """Firewall name not in networkPolicies → fully permissive."""
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
        # networkPolicies exists but has no entry for "github" → fully permissive
        policies = {"slack": {"allow": [], "unknownPolicy": "allow"}}
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

        # Unknown endpoint also allowed (name absent → fully permissive)
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_multi_api_mixed_permissions(self):
        """One API has permissions, another doesn't — mixed within same firewall."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                },
                {
                    "base": "https://uploads.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    # No permissions on this API
                },
            ],
            name="github",
        )
        policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

        # First API: known permission not in deny → ALLOW
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

        # Second API: no permissions defined, base matches → unknown
        # → ALLOW (unknownPolicy: allow)
        result = match_request_with_raw_firewalls(
            "https://uploads.github.com/anything",
            "POST",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None
