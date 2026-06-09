"""Tests for mixed firewall matcher parameter segments."""

import matching

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
