"""Raw firewall request matching tests through the production compiled matcher."""

import matching
from tests.firewall_helpers import grant_all, match_request_with_raw_firewalls, wrap_firewalls


class TestFirewallRequestMatching:
    """Tests for raw firewall configs matched through the compiled request matcher."""

    def test_no_permissions_blocks(self):
        """Missing permissions field → block (fail-closed)."""
        fw_configs = wrap_firewalls(
            [
                {"base": "https://api.github.com", "auth": {"headers": {}}},
            ],
            name="github",
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"
        assert result.base == "https://api.github.com"
        assert result.name == "github"
        assert result.method == "GET"
        assert result.path == "/repos"
        assert result.permissions == ()

    def test_permission_match_allows(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ],
            name="github",
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/octocat/hello",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "github"
        assert result.permission == "repo-read"
        assert result.params == {"owner": "octocat", "repo": "hello"}
        assert result.rule == "GET /repos/{owner}/{repo}"

    def test_aws_sigv4_auth_config_allows_matching(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://sts.amazonaws.com",
                    "auth": {
                        "headers": {},
                        "awsSigv4": {
                            "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                            "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                            "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                        },
                    },
                    "permissions": [{"name": "identity", "rules": ["POST /"]}],
                }
            ],
            name="aws",
        )
        result = match_request_with_raw_firewalls(
            "https://sts.amazonaws.com/",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "aws"
        assert result.permission == "identity"

    def test_malformed_aws_sigv4_auth_config_does_not_match(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://sts.amazonaws.com",
                    "auth": {
                        "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                        "awsSigv4": {
                            "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                            "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        },
                    },
                    "permissions": [{"name": "identity", "rules": ["POST /"]}],
                }
            ],
            name="aws",
        )
        result = match_request_with_raw_firewalls(
            "https://sts.amazonaws.com/",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_firewall_config"

    def test_aws_sigv4_auth_config_rejects_unsupported_defaults(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://sts.amazonaws.com",
                    "auth": {
                        "awsSigv4": {
                            "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                            "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                            "defaultRegion": "${{ vars.AWS_REGION }}",
                        },
                    },
                    "permissions": [{"name": "identity", "rules": ["POST /"]}],
                }
            ],
            name="aws",
        )
        result = match_request_with_raw_firewalls(
            "https://sts.amazonaws.com/",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_firewall_config"

    def test_any_method_matches(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/anything",
            "DELETE",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "full-access"

    def test_unsafe_path_blocks_before_greedy_permission_allow(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                }
            ],
            name="github",
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/../admin",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs, unknown_policy="allow"),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unsafe_path"
        assert result.path == "/repos/../admin"
        assert result.permissions == ()

    def test_encoded_unsafe_path_blocks_before_unknown_policy_allow(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}"]}],
                }
            ],
            name="github",
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/%2e%2e/admin",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs, unknown_policy="allow"),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unsafe_path"
        assert result.path == "/users/%2e%2e/admin"
        assert result.permissions == ()

    def test_unsafe_path_consumed_by_parameterized_base_blocks(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com/api/{tenant}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "admin", "rules": ["GET /admin"]}],
                }
            ],
            name="example",
        )
        result = match_request_with_raw_firewalls(
            "https://api.example.com/api/%2e%2e/admin",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs, unknown_policy="allow"),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unsafe_path"
        assert result.path == "/admin"

    def test_dot_like_regular_segments_can_still_allow(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                }
            ],
            name="github",
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/..hidden/a..b",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "full-access"

    def test_lowercase_rule_method_fails_closed(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["post /repos"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_firewall_config"

    def test_wrong_method_blocks(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "read-only", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/a/b",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_wrong_path_blocks(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/users/octocat",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_no_base_match_returns_none(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /{path+}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.gitlab.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_no_firewall_returns_none(self):
        assert (
            match_request_with_raw_firewalls(
                "https://api.github.com", "GET", None, network_policies=grant_all(None)
            )
            is None
        )

    def test_empty_firewall_returns_none(self):
        assert (
            match_request_with_raw_firewalls(
                "https://api.github.com", "GET", [], network_policies=grant_all([])
            )
            is None
        )

    def test_multiple_permissions_first_match_wins(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {}},
                    "permissions": [
                        {"name": "messages-read", "rules": ["POST /conversations.history"]},
                        {"name": "messages-send", "rules": ["POST /chat.postMessage"]},
                    ],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "messages-send"

    def test_malformed_rules_fail_closed_without_blocking_valid_match(self):
        """Malformed rules fail closed unless a valid allowed rule matches."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [
                        {"name": "bad", "rules": ["GET", "", "INVALID", "  ", "GET /repos"]}
                    ],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        # Non-matching paths fail closed because this request matched malformed
        # firewall config without a valid allowed permission match.
        result2 = match_request_with_raw_firewalls(
            "https://api.github.com/users",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result2, matching.FirewallBlock)
        assert result2.reason == "malformed_firewall_config"

    def test_path_case_sensitive(self):
        """URL paths are case-sensitive — /REPOS must not match /repos."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos/{owner}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/REPOS/octocat",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_multiple_services_match_across(self):
        fw_configs = [
            {
                "name": "github",
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
            {
                "name": "slack",
                "apis": [
                    {
                        "base": "https://slack.com/api",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
        ]
        gh = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(gh, matching.FirewallAllow)
        assert gh.name == "github"

        sl = match_request_with_raw_firewalls(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(sl, matching.FirewallAllow)
        assert sl.name == "slack"

    def test_query_string_stripped_for_matching(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos?page=1",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_fragment_stripped_for_matching(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos#section",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_empty_permissions_list_blocks(self):
        """If permissions is present but empty, no rules can match → block."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_different_bases_same_permission_name(self):
        """Same permission name across different api_entries — each matches its own base."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {"Authorization": "Bearer api-token"}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                },
                {
                    "base": "https://files.slack.com",
                    "auth": {"headers": {"Authorization": "Bearer files-token"}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                },
            ]
        )
        # Request to first base
        result = match_request_with_raw_firewalls(
            "https://slack.com/api/conversations.history",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer api-token"
        assert result.permission == "full-access"

        # Request to second base
        result = match_request_with_raw_firewalls(
            "https://files.slack.com/files-pri/T1/download",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer files-token"
        assert result.permission == "full-access"

    def test_same_base_different_permissions(self):
        """Same base URL with different permissions/auth — second api_entry can match."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {"Authorization": "Bearer bot"}},
                    "permissions": [{"name": "read", "rules": ["POST /conversations.history"]}],
                },
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {"Authorization": "Bearer user"}},
                    "permissions": [{"name": "send", "rules": ["POST /chat.postMessage"]}],
                },
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer user"
        assert result.permission == "send"
