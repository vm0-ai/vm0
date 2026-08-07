"""Tests for custom OpenAI Responses firewall scope matching."""

import matching


class TestOpenAIResponsesFirewallScope:
    """Keep custom gateway credentials inside the Responses API path."""

    BASE = "https://gateway.example.com/openai/v1/responses"

    def test_responses_endpoint_matches(self):
        assert matching.match_base_url(self.BASE, self.BASE) == ("/", {})

    def test_response_subresource_matches(self):
        result = matching.match_base_url(f"{self.BASE}/resp_123", self.BASE)
        assert result == ("/resp_123", {})

    def test_compact_endpoint_matches(self):
        result = matching.match_base_url(f"{self.BASE}/compact", self.BASE)
        assert result == ("/compact", {})

    def test_sibling_endpoint_rejected(self):
        assert (
            matching.match_base_url(
                "https://gateway.example.com/openai/v1/models",
                self.BASE,
            )
            is None
        )

    def test_prefix_confusion_attack_rejected(self):
        assert (
            matching.match_base_url(
                "https://gateway.example.com/openai/v1/responses_admin",
                self.BASE,
            )
            is None
        )
