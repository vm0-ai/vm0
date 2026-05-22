"""Tests for low-level firewall URL and pattern matching."""

import matching


class TestMatchPath:
    def test_exact_path(self):
        assert matching.match_path("/repos", "/repos") == {}

    def test_exact_multi_segment(self):
        assert matching.match_path("/api/v1/users", "/api/v1/users") == {}

    def test_single_param(self):
        result = matching.match_path("/repos/octocat", "/repos/{owner}")
        assert result == {"owner": "octocat"}

    def test_multiple_params(self):
        result = matching.match_path("/repos/octocat/hello-world", "/repos/{owner}/{repo}")
        assert result == {"owner": "octocat", "repo": "hello-world"}

    def test_mixed_literal_and_param(self):
        result = matching.match_path(
            "/repos/octocat/hello-world/issues", "/repos/{owner}/{repo}/issues"
        )
        assert result == {"owner": "octocat", "repo": "hello-world"}

    def test_greedy_param_matches_rest(self):
        result = matching.match_path("/repos/octocat/hello-world", "/{path+}")
        assert result == {"path": "repos/octocat/hello-world"}

    def test_greedy_param_matches_single_segment(self):
        result = matching.match_path("/foo", "/{path+}")
        assert result == {"path": "foo"}

    def test_greedy_param_rejects_empty(self):
        result = matching.match_path("/", "/{path+}")
        assert result is None

    def test_greedy_after_literal(self):
        result = matching.match_path("/api/v1/anything/here", "/api/v1/{rest+}")
        assert result == {"rest": "anything/here"}

    def test_star_param_matches_rest(self):
        result = matching.match_path("/repos/octocat/hello-world", "/{path*}")
        assert result == {"path": "repos/octocat/hello-world"}

    def test_star_param_matches_single_segment(self):
        result = matching.match_path("/foo", "/{path*}")
        assert result == {"path": "foo"}

    def test_star_param_matches_empty(self):
        result = matching.match_path("/", "/{path*}")
        assert result == {"path": ""}

    def test_star_after_literal(self):
        result = matching.match_path("/api/v1/anything/here", "/api/v1/{rest*}")
        assert result == {"rest": "anything/here"}

    def test_star_after_literal_empty(self):
        result = matching.match_path("/api/v1", "/api/v1/{rest*}")
        assert result == {"rest": ""}

    def test_path_too_short(self):
        assert matching.match_path("/repos", "/repos/{owner}/{repo}") is None

    def test_path_too_long(self):
        assert matching.match_path("/repos/owner/repo/extra", "/repos/{owner}/{repo}") is None

    def test_literal_mismatch(self):
        assert matching.match_path("/users/octocat", "/repos/{owner}") is None

    def test_root_matches_root(self):
        assert matching.match_path("/", "/") == {}

    def test_empty_path_matches_empty_pattern(self):
        assert matching.match_path("", "") == {}


class TestMatchHost:
    def test_exact_host(self):
        assert matching.match_host("api.github.com", "api.github.com") == {}

    def test_single_param(self):
        result = matching.match_host("acme.zendesk.com", "{subdomain}.zendesk.com")
        assert result == {"subdomain": "acme"}

    def test_single_param_no_match_multi_level(self):
        """Single {param} must not match multiple host segments."""
        result = matching.match_host("a.b.zendesk.com", "{subdomain}.zendesk.com")
        assert result is None

    def test_greedy_plus_matches_multi(self):
        result = matching.match_host("a.b.c.example.com", "{sub+}.example.com")
        assert result == {"sub": "a.b.c"}

    def test_greedy_plus_matches_single(self):
        result = matching.match_host("x.example.com", "{sub+}.example.com")
        assert result == {"sub": "x"}

    def test_greedy_plus_rejects_zero(self):
        result = matching.match_host("example.com", "{sub+}.example.com")
        assert result is None

    def test_greedy_star_matches_multi(self):
        result = matching.match_host("a.b.example.com", "{sub*}.example.com")
        assert result == {"sub": "a.b"}

    def test_greedy_star_matches_zero(self):
        result = matching.match_host("example.com", "{sub*}.example.com")
        assert result == {"sub": ""}

    def test_literal_mismatch(self):
        assert matching.match_host("api.gitlab.com", "api.github.com") is None

    def test_case_insensitive(self):
        assert matching.match_host("API.GitHub.COM", "api.github.com") == {}

    def test_host_too_few_segments(self):
        assert matching.match_host("github.com", "api.github.com") is None

    def test_param_name_preserves_case(self):
        """Param names should preserve original case from the pattern."""
        result = matching.match_host("acme.zendesk.com", "{Subdomain}.zendesk.com")
        assert result is not None
        assert "Subdomain" in result
        assert result["Subdomain"] == "acme"


# =========================================================================
# match_path_prefix
# =========================================================================


class TestMatchPathPrefix:
    def test_exact_match(self):
        result = matching.match_path_prefix(["v1", "projects"], ["v1", "projects"])
        assert result == ({}, 2)

    def test_single_param(self):
        result = matching.match_path_prefix(["v1", "acme", "projects"], ["v1", "{org}"])
        assert result == ({"org": "acme"}, 2)

    def test_remaining_segments(self):
        result = matching.match_path_prefix(["v1", "acme", "projects", "123"], ["v1", "{org}"])
        assert result == ({"org": "acme"}, 2)

    def test_mismatch(self):
        result = matching.match_path_prefix(["v2", "acme"], ["v1", "{org}"])
        assert result is None

    def test_empty_pattern(self):
        result = matching.match_path_prefix(["v1", "acme"], [])
        assert result == ({}, 0)

    def test_path_too_short(self):
        result = matching.match_path_prefix(["v1"], ["v1", "{org}"])
        assert result is None


# =========================================================================
# match_base_url
# =========================================================================


class TestMatchBaseUrl:
    def test_static_base(self):
        result = matching.match_base_url("https://api.github.com/repos", "https://api.github.com")
        assert result == ("/repos", {})

    def test_static_base_case_insensitive_authority(self):
        result = matching.match_base_url("https://API.GitHub.com/repos", "https://api.github.com")
        assert result == ("/repos", {})

    def test_static_base_case_insensitive_scheme(self):
        result = matching.match_base_url("HTTPS://API.GitHub.com/repos", "https://api.github.com")
        assert result == ("/repos", {})

    def test_static_base_preserves_path_case(self):
        result = matching.match_base_url("https://API.GitHub.com/REPOS", "https://api.github.com")
        assert result == ("/REPOS", {})

    def test_static_base_path_is_case_sensitive(self):
        result = matching.match_base_url(
            "https://api.github.com/V1/repos", "https://api.github.com/v1"
        )
        assert result is None

    def test_static_base_exact(self):
        result = matching.match_base_url("https://api.github.com", "https://api.github.com")
        assert result == ("/", {})

    def test_static_base_query_only_case_insensitive_authority(self):
        result = matching.match_base_url(
            "https://API.GitHub.com?tab=repos", "https://api.github.com"
        )
        assert result == ("/", {})

    def test_static_base_strips_query_and_fragment_from_rel_path(self):
        result = matching.match_base_url(
            "https://API.GitHub.com/repos?tab=code#readme",
            "https://api.github.com",
        )
        assert result == ("/repos", {})

    def test_static_base_evil_domain(self):
        result = matching.match_base_url(
            "https://api.github.com.evil.com/steal", "https://api.github.com"
        )
        assert result is None

    def test_static_base_case_mixed_evil_domain(self):
        result = matching.match_base_url(
            "https://API.GitHub.com.evil.com/steal", "https://api.github.com"
        )
        assert result is None

    def test_static_base_rejects_nonstandard_port(self):
        result = matching.match_base_url(
            "https://API.GitHub.com:8443/repos", "https://api.github.com"
        )
        assert result is None

    def test_static_base_with_query_is_rejected(self):
        result = matching.match_base_url(
            "https://api.github.com/repos", "https://api.github.com?token=1"
        )
        assert result is None

    def test_static_base_with_fragment_is_rejected(self):
        result = matching.match_base_url(
            "https://api.github.com/repos", "https://api.github.com#token"
        )
        assert result is None

    def test_malformed_request_url_returns_none(self):
        result = matching.match_base_url("https://[::1", "https://api.github.com")
        assert result is None

    def test_malformed_base_url_returns_none(self):
        result = matching.match_base_url("https://api.github.com/repos", "https://[::1")
        assert result is None

    def test_parameterized_host(self):
        result = matching.match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{subdomain}.zendesk.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/api/v2/tickets"
        assert params == {"subdomain": "acme"}

    def test_parameterized_base_with_query_is_rejected(self):
        result = matching.match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{subdomain}.zendesk.com?token=1",
        )
        assert result is None

    def test_parameterized_base_with_fragment_is_rejected(self):
        result = matching.match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{subdomain}.zendesk.com#token",
        )
        assert result is None

    def test_parameterized_path(self):
        result = matching.match_base_url(
            "https://api.example.com/v1/acme/projects/123",
            "https://api.example.com/v1/{org}",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/projects/123"
        assert params == {"org": "acme"}

    def test_parameterized_host_and_path(self):
        result = matching.match_base_url(
            "https://us.api.example.com/v1/acme/data",
            "https://{region}.api.example.com/v1/{org}",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/data"
        assert params == {"region": "us", "org": "acme"}

    def test_host_mismatch_returns_none(self):
        result = matching.match_base_url(
            "https://api.github.com/repos", "https://{sub}.zendesk.com"
        )
        assert result is None

    def test_scheme_mismatch_returns_none(self):
        result = matching.match_base_url("http://acme.zendesk.com/api", "https://{sub}.zendesk.com")
        assert result is None

    def test_query_stripped(self):
        result = matching.match_base_url(
            "https://acme.zendesk.com/api?key=val",
            "https://{sub}.zendesk.com",
        )
        assert result is not None
        rel_path, _ = result
        assert rel_path == "/api"

    def test_no_path_after_parameterized_base(self):
        result = matching.match_base_url(
            "https://acme.zendesk.com",
            "https://{sub}.zendesk.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/"
        assert params == {"sub": "acme"}

    def test_nonstandard_port_rejected(self):
        """Non-standard port in URL must not match base without port."""
        result = matching.match_base_url(
            "https://acme.zendesk.com:8443/api",
            "https://{sub}.zendesk.com",
        )
        assert result is None

    def test_base_with_port_matches_url_with_same_port(self):
        """Base with explicit port matches URL with same port."""
        result = matching.match_base_url(
            "https://internal.example.com:8443/api",
            "https://{sub}.example.com:8443",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/api"
        assert params == {"sub": "internal"}


# =========================================================================
# Mixed {param}{literal} segments — #10078
# Mirrored against turbo/packages/connectors/src/__tests__/
#   firewall-mixed-segments.test.ts. Any change must land in both.
# =========================================================================


class TestMatchPathMixedSegments:
    def test_param_suffix_extracts_middle(self):
        assert matching.match_path("/api/42.json", "/api/{id}.json") == {"id": "42"}

    def test_param_suffix_mismatch_when_middle_empty(self):
        # {repo}.git must NOT match a segment named exactly ".git"
        assert matching.match_path("/repos/octocat/.git", "/repos/{owner}/{repo}.git") is None

    def test_mixed_owner_and_repo(self):
        assert matching.match_path("/repos/octocat/hello.git", "/repos/{owner}/{repo}.git") == {
            "owner": "octocat",
            "repo": "hello",
        }

    def test_literal_prefix_with_param(self):
        assert matching.match_path("/v1/x", "/v{version}/x") == {"version": "1"}

    def test_prefix_and_suffix_both(self):
        assert matching.match_path("/pre-abc.ext", "/pre-{name}.ext") == {"name": "abc"}

    def test_prefix_mismatch(self):
        assert matching.match_path("/foo-abc.ext", "/pre-{name}.ext") is None

    def test_suffix_mismatch(self):
        assert matching.match_path("/pre-abc.txt", "/pre-{name}.ext") is None

    def test_mixed_path_case_sensitive(self):
        # Paths are case-sensitive — uppercase runtime prefix must not
        # match lowercase pattern prefix.
        assert matching.match_path("/PRE-abc.ext", "/pre-{name}.ext") is None

    def test_prefix_longer_than_runtime(self):
        # Defensive: runtime segment shorter than literal prefix.
        # startswith returns False before any slice operation.
        assert matching.match_path("/ab", "/prefix-{name}.ext") is None

    def test_invalid_pattern_returns_none(self):
        # At match time, invalid patterns (rejected upstream by validateRule)
        # must degrade gracefully to None instead of raising.
        assert matching.match_path("/foo/XabcY", "/foo/{a}abc{b}") is None


class TestMatchHostMixedSegments:
    def test_literal_prefix_with_param(self):
        assert matching.match_host("api-us.example.com", "api-{region}.example.com") == {
            "region": "us"
        }

    def test_prefix_mismatch(self):
        assert matching.match_host("foo-us.example.com", "api-{region}.example.com") is None

    def test_mixed_segment_case_insensitive(self):
        # Host comparison is case-insensitive; captured value lowercased.
        assert matching.match_host("API-US.example.com", "api-{region}.example.com") == {
            "region": "us"
        }

    def test_non_empty_middle_required(self):
        assert matching.match_host("api-.example.com", "api-{region}.example.com") is None


class TestMatchPathPrefixMixedSegments:
    def test_extract_from_mixed_prefix_and_suffix(self):
        result = matching.match_path_prefix(
            ["v1", "octocat", "hello.git"],
            ["v1", "{owner}", "{repo}.git"],
        )
        assert result == ({"owner": "octocat", "repo": "hello"}, 3)

    def test_mixed_segment_non_empty_guard(self):
        result = matching.match_path_prefix(
            ["v1", "octocat", ".git"],
            ["v1", "{owner}", "{repo}.git"],
        )
        assert result is None


class TestMatchBaseUrlMixedSegments:
    def test_git_base_with_mixed_segment(self):
        result = matching.match_base_url(
            "https://github.com/octocat/hello.git/info/refs",
            "https://github.com/{owner}/{repo}.git",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/info/refs"
        assert params == {"owner": "octocat", "repo": "hello"}

    def test_git_base_adversarial_dotgit(self):
        # Adversarial: URL /repos/octocat/.git against {owner}/{repo}.git
        # should NOT match — {repo} would be empty.
        result = matching.match_base_url(
            "https://github.com/octocat/.git",
            "https://github.com/{owner}/{repo}.git",
        )
        assert result is None

    def test_mixed_host_segment(self):
        result = matching.match_base_url(
            "https://api-us.example.com/data",
            "https://api-{region}.example.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/data"
        assert params == {"region": "us"}


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
