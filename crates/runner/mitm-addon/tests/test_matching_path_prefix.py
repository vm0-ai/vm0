"""Tests for low-level firewall path-prefix matching."""

import pytest

import matching


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

    def test_compiled_full_match_rejects_extra_segments_that_prefix_consumes(self):
        pattern = matching.compile_path_pattern("/v1/{org}")
        assert pattern is not None

        assert matching.match_compiled_path("/v1/acme/projects", pattern) is None
        assert matching.match_path_prefix(["v1", "acme", "projects"], ["v1", "{org}"]) == (
            {"org": "acme"},
            2,
        )

    def test_mismatch(self):
        result = matching.match_path_prefix(["v2", "acme"], ["v1", "{org}"])
        assert result is None

    def test_empty_pattern(self):
        result = matching.match_path_prefix(["v1", "acme"], [])
        assert result == ({}, 0)

    def test_path_too_short(self):
        result = matching.match_path_prefix(["v1"], ["v1", "{org}"])
        assert result is None

    def test_plus_greedy_consumes_remaining_segments(self):
        result = matching.match_path_prefix(["v1", "acme", "projects"], ["v1", "{rest+}"])
        assert result == ({"rest": "acme/projects"}, 3)

    def test_plus_greedy_rejects_empty_remaining_segments(self):
        result = matching.match_path_prefix(["v1", ""], ["v1", "{rest+}"])
        assert result is None

    def test_star_greedy_consumes_zero_remaining_segments(self):
        result = matching.match_path_prefix(["v1"], ["v1", "{rest*}"])
        assert result == ({"rest": ""}, 1)

    @pytest.mark.parametrize("pattern", [["v1", "{rest+}", "tail"], ["v1", "{rest*}", "tail"]])
    def test_greedy_param_rejects_non_terminal_position(self, pattern):
        assert matching.match_path_prefix(["v1", "acme", "tail"], pattern) is None

    @pytest.mark.parametrize("pattern", [["v1", "file-{id+}"], ["v1", "file-{id*}"]])
    def test_greedy_param_rejects_mixed_segment(self, pattern):
        assert matching.match_path_prefix(["v1", "file-123"], pattern) is None


# =========================================================================
# match_base_url
# =========================================================================
