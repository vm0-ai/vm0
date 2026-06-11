"""Raw firewall request rel_path tests through the compiled matcher."""

import matching
from tests.firewall_helpers import grant_all, match_request_with_raw_firewalls, wrap_firewalls


class TestFirewallRequestRelPath:
    """Tests for rel_path values returned by raw firewall request matching."""

    def test_mixed_base_and_rule_round_trip(self):
        """End-to-end: base URL with mixed {repo}.git segment,
        followed by a permission rule that matches the remainder."""
        apis = [
            {
                "base": "https://github.com/{owner}/{repo}.git",
                "auth": {"headers": {}},
                "permissions": [
                    {"name": "git|fetch", "rules": ["GET /info/refs"]},
                ],
            }
        ]
        firewalls = wrap_firewalls(apis)
        result = match_request_with_raw_firewalls(
            "https://github.com/octocat/hello.git/info/refs",
            "GET",
            firewalls,
            grant_all(firewalls),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"owner": "octocat", "repo": "hello"}
        assert result.rel_path == "/info/refs"
        assert result.permission == "git|fetch"

    def test_rel_path_included_in_allow_result(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
                    "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
                    "permissions": [{"name": "send-message", "rules": ["POST /"]}],
                }
            ],
            name="discord-webhook",
        )
        result = match_request_with_raw_firewalls(
            "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.rel_path == "/"

    def test_rel_path_with_remaining_segments(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "crm", "rules": ["ANY /{method}"]}],
                }
            ],
            name="bitrix",
        )
        result = match_request_with_raw_firewalls(
            "https://firewall-placeholder.vm3.ai/bitrix/rest/0/placeholder/crm.deal.list",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.rel_path == "/crm.deal.list"
