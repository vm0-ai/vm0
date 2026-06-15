"""Tests for low-level firewall path matching."""

import pytest

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

    @pytest.mark.parametrize("path", ["/api/v1/", "/api/v1//"])
    def test_greedy_param_rejects_only_empty_remaining_segments(self, path):
        assert matching.match_path(path, "/api/v1/{rest+}") is None

    def test_greedy_param_preserves_empty_segments_before_non_empty_rest(self):
        assert matching.match_path("/api/v1//report", "/api/v1/{rest+}") == {"rest": "/report"}

    def test_greedy_after_literal(self):
        result = matching.match_path("/api/v1/anything/here", "/api/v1/{rest+}")
        assert result == {"rest": "anything/here"}

    @pytest.mark.parametrize("pattern", ["/api/{rest+}/tail", "/api/{rest*}/tail"])
    def test_greedy_param_rejects_non_terminal_position(self, pattern):
        assert matching.match_path("/api/a/b/tail", pattern) is None

    @pytest.mark.parametrize("pattern", ["/api/file-{id+}", "/api/file-{id*}"])
    def test_greedy_param_rejects_mixed_segment(self, pattern):
        assert matching.match_path("/api/file-123", pattern) is None

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

    @pytest.mark.parametrize("path", ["/repos//octocat", "//repos/octocat", "/repos/octocat/"])
    def test_single_param_rejects_empty_path_segments(self, path):
        assert matching.match_path(path, "/repos/{owner}") is None

    def test_rule_path_can_require_empty_segments(self):
        assert matching.match_path("/repos//octocat", "/repos//{owner}") == {"owner": "octocat"}

    @pytest.mark.parametrize("path", ["/repos//octocat", "//repos/octocat", "/repos/octocat/"])
    def test_compiled_single_param_rejects_empty_path_segments(self, path):
        pattern = matching.compile_path_pattern("/repos/{owner}")
        assert pattern is not None

        assert matching.match_compiled_path(path, pattern) is None

    def test_compiled_rule_path_can_require_empty_segments(self):
        pattern = matching.compile_path_pattern("/repos//{owner}")
        assert pattern is not None

        assert matching.match_compiled_path("/repos//octocat", pattern) == {"owner": "octocat"}

    @pytest.mark.parametrize("path", ["/api/v1/", "/api/v1//"])
    def test_compiled_greedy_param_rejects_only_empty_remaining_segments(self, path):
        pattern = matching.compile_path_pattern("/api/v1/{rest+}")
        assert pattern is not None

        assert matching.match_compiled_path(path, pattern) is None

    def test_compiled_greedy_param_preserves_empty_segments_before_non_empty_rest(self):
        pattern = matching.compile_path_pattern("/api/v1/{rest+}")
        assert pattern is not None

        assert matching.match_compiled_path("/api/v1//report", pattern) == {"rest": "/report"}

    @pytest.mark.parametrize("pattern", ["/api/{rest+}/tail", "/api/{rest*}/tail"])
    def test_compiled_greedy_param_rejects_non_terminal_position(self, pattern):
        compiled = matching.compile_path_pattern(pattern)
        assert compiled is not None

        assert matching.match_compiled_path("/api/a/b/tail", compiled) is None

    @pytest.mark.parametrize("pattern", ["/api/file-{id+}", "/api/file-{id*}"])
    def test_compiled_greedy_param_rejects_mixed_segment(self, pattern):
        compiled = matching.compile_path_pattern(pattern)
        assert compiled is not None

        assert matching.match_compiled_path("/api/file-123", compiled) is None
