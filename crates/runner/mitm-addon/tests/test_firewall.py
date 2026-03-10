"""Tests for firewall rule matching functions."""
from mitm_addon import match_domain, match_ip, evaluate_rules


# =========================================================================
# match_domain
# =========================================================================


class TestMatchDomain:
    def test_exact_match(self):
        assert match_domain("example.com", "example.com")

    def test_exact_no_match(self):
        assert not match_domain("example.com", "other.com")

    def test_wildcard_subdomain(self):
        assert match_domain("*.example.com", "sub.example.com")

    def test_wildcard_deep_subdomain(self):
        assert match_domain("*.example.com", "a.b.example.com")

    def test_wildcard_matches_base(self):
        """*.example.com also matches example.com itself."""
        assert match_domain("*.example.com", "example.com")

    def test_wildcard_no_match(self):
        assert not match_domain("*.example.com", "other.com")

    def test_case_insensitive(self):
        assert match_domain("Example.COM", "example.com")
        assert match_domain("*.Example.COM", "SUB.example.com")

    def test_empty_inputs(self):
        assert not match_domain("", "example.com")
        assert not match_domain("example.com", "")
        assert not match_domain("", "")


# =========================================================================
# match_ip
# =========================================================================


class TestMatchIp:
    def test_exact_ip(self):
        assert match_ip("10.0.0.1", "10.0.0.1")

    def test_exact_ip_no_match(self):
        assert not match_ip("10.0.0.1", "10.0.0.2")

    def test_cidr_range(self):
        assert match_ip("10.0.0.0/8", "10.1.2.3")

    def test_cidr_no_match(self):
        assert not match_ip("10.0.0.0/8", "192.168.1.1")

    def test_cidr_24(self):
        assert match_ip("192.168.1.0/24", "192.168.1.100")
        assert not match_ip("192.168.1.0/24", "192.168.2.1")

    def test_invalid_cidr(self):
        assert not match_ip("not-a-cidr", "10.0.0.1")

    def test_invalid_ip(self):
        assert not match_ip("10.0.0.0/8", "not-an-ip")

    def test_empty_inputs(self):
        assert not match_ip("", "10.0.0.1")
        assert not match_ip("10.0.0.0/8", "")


# =========================================================================
# evaluate_rules
# =========================================================================


class TestEvaluateRules:
    def test_no_rules_allows(self):
        """Empty rules = allow all."""
        action, rule = evaluate_rules([], "example.com")
        assert action == "ALLOW"
        assert rule is None

    def test_first_match_wins(self):
        rules = [
            {"domain": "*.allowed.com", "action": "ALLOW"},
            {"domain": "*.allowed.com", "action": "DENY"},
        ]
        action, _ = evaluate_rules(rules, "api.allowed.com")
        assert action == "ALLOW"

    def test_domain_allow(self):
        rules = [
            {"domain": "*.example.com", "action": "ALLOW"},
            {"final": "DENY"},
        ]
        action, rule = evaluate_rules(rules, "api.example.com")
        assert action == "ALLOW"
        assert rule == "domain:*.example.com"

    def test_final_deny(self):
        rules = [
            {"domain": "*.example.com", "action": "ALLOW"},
            {"final": "DENY"},
        ]
        action, rule = evaluate_rules(rules, "unknown.com")
        assert action == "DENY"
        assert rule == "final"

    def test_default_deny_when_no_match(self):
        """Rules exist but none match → default deny."""
        rules = [{"domain": "specific.com", "action": "ALLOW"}]
        action, rule = evaluate_rules(rules, "other.com")
        assert action == "DENY"
        assert rule == "default"

    def test_ip_rule(self):
        rules = [
            {"ip": "10.0.0.0/8", "action": "ALLOW"},
            {"final": "DENY"},
        ]
        action, rule = evaluate_rules(rules, "internal.host", ip_str="10.1.2.3")
        assert action == "ALLOW"
        assert rule == "ip:10.0.0.0/8"

    def test_ip_rule_no_match(self):
        rules = [
            {"ip": "10.0.0.0/8", "action": "ALLOW"},
            {"final": "DENY"},
        ]
        action, _ = evaluate_rules(rules, "external.host", ip_str="192.168.1.1")
        assert action == "DENY"

    def test_domain_checked_before_ip(self):
        rules = [
            {"domain": "*.example.com", "action": "ALLOW"},
            {"ip": "10.0.0.0/8", "action": "DENY"},
        ]
        action, rule = evaluate_rules(rules, "api.example.com", ip_str="10.1.2.3")
        assert action == "ALLOW"
        assert rule == "domain:*.example.com"
