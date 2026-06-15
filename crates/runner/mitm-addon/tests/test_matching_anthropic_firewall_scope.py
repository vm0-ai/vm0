"""Tests for Anthropic firewall scope matching regressions."""

import matching


class TestAnthropicFirewallScope:
    """Regression tests for #9560: Anthropic firewall scoped to /v1/messages."""

    BASE = "https://api.anthropic.com/v1/messages"

    def test_messages_endpoint_matches(self):
        assert matching.match_base_url(self.BASE, self.BASE) == ("/", {})

    def test_count_tokens_endpoint_matches(self):
        result = matching.match_base_url(f"{self.BASE}/count_tokens", self.BASE)
        assert result == ("/count_tokens", {})

    def test_batches_endpoint_matches(self):
        result = matching.match_base_url(f"{self.BASE}/batches/abc123", self.BASE)
        assert result == ("/batches/abc123", {})

    def test_organizations_endpoint_rejected(self):
        assert (
            matching.match_base_url("https://api.anthropic.com/v1/organizations/foo", self.BASE)
            is None
        )

    def test_usage_endpoint_rejected(self):
        assert (
            matching.match_base_url("https://api.anthropic.com/v1/usage_report", self.BASE) is None
        )

    def test_complete_endpoint_rejected(self):
        assert matching.match_base_url("https://api.anthropic.com/v1/complete", self.BASE) is None

    def test_models_endpoint_rejected(self):
        assert matching.match_base_url("https://api.anthropic.com/v1/models", self.BASE) is None

    def test_prefix_confusion_attack_rejected(self):
        """Paths like /v1/messages_fake must not match /v1/messages."""
        assert (
            matching.match_base_url("https://api.anthropic.com/v1/messages_fake", self.BASE) is None
        )

    def test_messages_with_query_string_matches(self):
        result = matching.match_base_url(f"{self.BASE}?beta=1", self.BASE)
        assert result == ("/", {})
