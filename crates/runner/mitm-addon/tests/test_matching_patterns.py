"""Tests for low-level firewall URL and pattern matching."""

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

    @pytest.mark.parametrize("pattern", ["foo.{sub+}.example.com", "foo.{sub*}.example.com"])
    def test_greedy_param_rejects_non_leading_position(self, pattern):
        assert matching.match_host("foo.bar.example.com", pattern) is None

    @pytest.mark.parametrize("pattern", ["api-{region+}.example.com", "api-{region*}.example.com"])
    def test_greedy_param_rejects_mixed_segment(self, pattern):
        assert matching.match_host("api-us.example.com", pattern) is None

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

    def test_static_base_treats_single_terminal_slash_as_optional(self):
        result = matching.match_base_url(
            "https://api.example.com/v1/foo",
            "https://api.example.com/v1/",
        )
        assert result == ("/foo", {})

    def test_static_base_preserves_repeated_terminal_empty_segments(self):
        base = "https://api.example.com/v1//"

        result = matching.match_base_url("https://api.example.com/v1/foo", base)
        assert result is None

        result = matching.match_base_url("https://api.example.com/v1//foo", base)
        assert result == ("/foo", {})

    def test_static_base_preserves_repeated_root_terminal_empty_segments(self):
        base = "https://api.example.com//"

        result = matching.match_base_url("https://api.example.com/foo", base)
        assert result is None

        result = matching.match_base_url("https://api.example.com//foo", base)
        assert result == ("/foo", {})

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

    @pytest.mark.parametrize(
        "base",
        [
            "https://api.github.com/static{",
            "https://api.github.com/static}",
        ],
    )
    def test_static_base_with_single_brace_is_not_parameterized(self, base):
        result = matching.match_base_url(f"{base}/repos", base)
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

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://api.github.com/repos", "https://api.github.com:443"),
            ("https://api.github.com:443/repos", "https://api.github.com"),
            ("https://api.github.com/repos", "https://api.github.com:0443"),
            ("http://api.github.com/repos", "http://api.github.com:80"),
            ("http://api.github.com:80/repos", "http://api.github.com"),
            ("http://api.github.com/repos", "http://api.github.com:0080"),
            ("https://[2001:db8::1]/repos", "https://[2001:db8::1]:443"),
        ],
    )
    def test_static_base_default_ports_match_omitted_ports(self, url, base):
        result = matching.match_base_url(url, base)
        assert result == ("/repos", {})

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://api.github.com/repos", "https://api.github.com."),
            ("https://api.github.com./repos", "https://api.github.com"),
            ("https://api.github.com:8443/repos", "https://api.github.com.:08443"),
            ("https://api.github.com.:8443/repos", "https://api.github.com:8443"),
            ("https://[2001:0db8::1]/repos", "https://[2001:db8::1]"),
            ("https://[::ffff:127.0.0.1]/repos", "https://[::ffff:7f00:1]"),
        ],
    )
    def test_static_base_authority_normalization_matches_runtime_host(self, url, base):
        result = matching.match_base_url(url, base)
        assert result == ("/repos", {})

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://xn--fsqu00a.xn--0zwm56d/repos", "https://例子.测试"),
            ("https://例子.测试/repos", "https://xn--fsqu00a.xn--0zwm56d"),
            ("https://faß.de/repos", "https://xn--fa-hia.de"),
            ("https://xn--strae-oqa.de/repos", "https://straße.de"),
            ("https://xn--fa-hia.de/repos", "https://xn--fa-hia.de"),
            ("https://\u03c2.example/repos", "https://xn--3xa.example"),
            ("https://a\u03a3.example/repos", "https://xn--a-0mb.example"),
            ("https://a\u03f9.example/repos", "https://xn--a-0mb.example"),
            ("https://\u13be.example/repos", "https://xn--09d.example"),
            ("https://\uab8e.example/repos", "https://xn--09d.example"),
            ("https://\u1fb3.example/repos", "https://xn--mxaq.example"),
            ("https://\u1f86.example/repos", "https://xn--uxa190l.example"),
            ("https://\u0345.example/repos", "https://xn--uxa.example"),
            ("https://\u1c82.example/repos", "https://xn--n1a.example"),
            ("https://\u1c85.example/repos", "https://xn--r1a.example"),
            ("https://\U0001d6d3.example/repos", "https://xn--4xa.example"),
            ("https://a\u0754.example/repos", "https://xn--a-63c.example"),
            ("https://z\u1fc3\u08f2\u17b6.example/repos", "https://xn--z-cmbg264c9ov.example"),
            (
                "https://z\u03b7\u08f2\u0345\u17b6.example/repos",
                "https://xn--z-cmbg164cbpv.example",
            ),
            ("https://fa%C3%9F.de/repos", "https://xn--fa-hia.de"),
            ("https://\u0663\u067a.example/repos", "https://xn--cib0c.example"),
            ("https://\u0663\u067a\u0663.example/repos", "https://xn--ciba2e.example"),
            ("https://1\u067a1.example/repos", "https://xn--11-g0d.example"),
            ("https://a\u0663.example/repos", "https://xn--a-fqc.example"),
            ("https://a1\u0663.example/repos", "https://xn--a1-iyd.example"),
        ],
    )
    def test_static_base_idna_authority_matches_runtime_host(self, url, base):
        result = matching.match_base_url(url, base)
        assert result == ("/repos", {})

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://faß.de/repos", "https://fass.de"),
            ("https://fass.de/repos", "https://faß.de"),
            ("https://\uff21.example/repos", "https://a.example"),
            ("https://%EF%BC%A1.example/repos", "https://a.example"),
            ("https://a.example/repos", "https://\uff21.example"),
            ("https://\u212a.example/repos", "https://k.example"),
            ("https://%E2%84%AA.example/repos", "https://k.example"),
            ("https://k.example/repos", "https://\u212a.example"),
            ("https://\u1e9e.de/repos", "https://ß.de"),
            ("https://ß.de/repos", "https://\u1e9e.de"),
            ("https://\u03f2.example/repos", "https://\u03c2.example"),
            ("https://\u03c2.example/repos", "https://\u03f2.example"),
            ("https://a\u03a3.example/repos", "https://a\u03c2.example"),
            ("https://a\u03c2.example/repos", "https://a\u03a3.example"),
            ("https://\u200cexample.com/repos", "https://example.com"),
            ("https://example.com/repos", "https://\u200cexample.com"),
            ("https://\u10a0.example/repos", "https://\u2d00.example"),
            ("https://\u2d00.example/repos", "https://\u10a0.example"),
            ("https://\u04c0.example/repos", "https://\u04cf.example"),
            ("https://\u04cf.example/repos", "https://\u04c0.example"),
            ("https://\U0001d6d3.example/repos", "https://\u03c2.example"),
        ],
    )
    def test_static_base_rejects_idna_compatibility_aliases(self, url, base):
        result = matching.match_base_url(url, base)
        assert result is None

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://\u03c2.example/repos", "https://xn--4xa.example"),
            ("https://\u03c3.example/repos", "https://xn--3xa.example"),
        ],
    )
    def test_static_base_rejects_distinct_idna_labels(self, url, base):
        result = matching.match_base_url(url, base)
        assert result is None

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://xn--.com/repos", "https://xn--.com"),
            ("https://xn--a.com/repos", "https://xn--a.com"),
            ("https://xn--zzzz.example/repos", "https://xn--zzzz.example"),
            ("https://xn--ph7c.example/repos", "https://xn--ph7c.example"),
            ("https://xn--lm6c.example/repos", "https://xn--lm6c.example"),
            ("https://xn--72g.example/repos", "https://xn--72g.example"),
            ("https://\u4f8b\uff1a\u5b50.example/repos", "https://\u4f8b\uff1a\u5b50.example"),
            ("https://\u4f8b\uff0c\u5b50.example/repos", "https://\u4f8b\uff0c\u5b50.example"),
            ("https://\u034f.example/repos", "https://\u034f.example"),
            ("https://\u0301.example/repos", "https://\u0301.example"),
            ("https://\ufe0f.example/repos", "https://\ufe0f.example"),
            ("https://xn--rld.example/repos", "https://xn--rld.example"),
            ("https://xn--f09a.example/repos", "https://xn--f09a.example"),
            ("https://xn--hsg.example/repos", "https://xn--hsg.example"),
            ("https://xn--43f.example/repos", "https://xn--43f.example"),
            ("https://\u00a8.example/repos", "https://\u00a8.example"),
            ("https://xn-- -ccb.example/repos", "https://xn-- -ccb.example"),
            ("https://\ufe12.example/repos", "https://\ufe12.example"),
            ("https://\ufffc.example/repos", "https://\ufffc.example"),
            ("https://\u0754\u3d20.example/repos", "https://\u0754\u3d20.example"),
            ("https://a\u0754b.example/repos", "https://a\u0754b.example"),
            ("https://\u25a5\u33d5\u067a.example/repos", "https://\u25a5\u33d5\u067a.example"),
            ("https://1a\u067a.example/repos", "https://1a\u067a.example"),
            ("https://\u28a8\u17b5.example/repos", "https://\u28a8\u17b5.example"),
            ("https://\u0663a.example/repos", "https://\u0663a.example"),
            ("https://\u0663!.example/repos", "https://\u0663!.example"),
            ("https://a\u0663\u067a.example/repos", "https://a\u0663\u067a.example"),
            ("https://\u0663\u067aa.example/repos", "https://\u0663\u067aa.example"),
            ("https://a\u0663b.example/repos", "https://a\u0663b.example"),
            ("https://a\u0663\u0664.example/repos", "https://a\u0663\u0664.example"),
            ("https://!a\u0663.example/repos", "https://!a\u0663.example"),
            ("https://1\u0663.example/repos", "https://1\u0663.example"),
            ("https://!\u0663!.example/repos", "https://!\u0663!.example"),
            ("https://api.github.com../repos", "https://api.github.com"),
            ("https://api.github.com%2e%2e/repos", "https://api.github.com"),
            ("https://api.github.com/repos", "https://api.github.com.."),
            ("https://api.github.com/repos", "https://api.github.com%2e%2e"),
            (
                "https://\u4f8b\u5b50\u3002\u3002\u6d4b\u8bd5/repos",
                "https://\u4f8b\u5b50.\u6d4b\u8bd5",
            ),
        ],
    )
    def test_static_base_rejects_invalid_alabel_authorities(self, url, base):
        result = matching.match_base_url(url, base)
        assert result is None

    @pytest.mark.parametrize(
        "base",
        [
            "https://user@api.github.com",
            "https://user:pass@api.github.com",
            "https://.github.com",
            "https://api..github.com",
            "https://.",
            "https://api.github.com:bad",
            "https://api.github.com:99999",
            "https://api%2egithub.com",
            "https://api.github.com%3A443",
            "https://0177.0.0.1",
            "https://0x7f.0.0.1",
            "https://2130706433",
            "https://127.1",
            "https://127。0。0。1",
            "https://127.0.0.1。",
            "https://\uff11\uff12\uff17.\uff10.\uff10.\uff11",
        ],
    )
    def test_static_base_malformed_authority_returns_none(self, base):
        result = matching.match_base_url("https://api.github.com/repos", base)
        assert result is None

    @pytest.mark.parametrize(
        "url",
        [
            "https://.github.com/repos",
            "https://api..github.com/repos",
            "https://./repos",
            "https://[::1]junk/repos",
            "https://api%2egithub.com/repos",
            "https://api.github.com%3A443/repos",
            "https://api%2Fgithub.com/repos",
            "https://api%5Cgithub.com/repos",
            "https://api%40github.com/repos",
            "https://0177.0.0.1/repos",
            "https://0x7f.0.0.1/repos",
            "https://2130706433/repos",
            "https://127.1/repos",
            "https://127。0。0。1/repos",
            "https://127.0.0.1。/repos",
            "https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/repos",
        ],
    )
    def test_static_base_malformed_request_authority_returns_none(self, url):
        result = matching.match_base_url(url, "https://api.github.com")
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

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.github.com/re\x00pos",
            "https://api.github.com/re\tpos",
            "https://api.github.com/re\npos",
            "https://api.github.com/re\rpos",
            "https://api.github.com/re\x0cpos",
            "https://api.github.com/re pos",
            "https://api.github.com/re\\pos",
            "https://api.github.com/repos ",
            "https://api.github.com/re\x7fpos",
            "https://api.github.com/re\ud800pos",
            " https://api.github.com/repos",
            "\x00https://api.github.com/repos",
            "\x1fhttps://api.github.com/repos",
        ],
    )
    def test_request_url_raw_whitespace_controls_or_invalid_unicode_are_not_matched(self, url):
        result = matching.match_base_url(url, "https://api.github.com/repos")
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

    def test_parameterized_base_host_param_name_preserves_case(self):
        result = matching.match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{Subdomain}.zendesk.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/api/v2/tickets"
        assert params == {"Subdomain": "acme"}

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

    @pytest.mark.parametrize(
        "base",
        [
            "https://{subdomain}.%7Benv%7D.example.com",
            "https://{subdomain}%2eexample.com",
            "https://{subdomain}%E3%80%82example.com",
        ],
    )
    def test_parameterized_base_rejects_percent_encoded_host_syntax(self, base):
        result = matching.match_base_url(
            "https://acme.prod.example.com/api/v2/tickets",
            base,
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

    def test_parameterized_path_treats_encoded_slash_as_segment_content(self):
        result = matching.match_base_url(
            "https://api.example.com/v1/acme%2Fteam/projects/123",
            "https://api.example.com/v1/{org}",
        )
        assert result == ("/projects/123", {"org": "acme%2Fteam"})

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.example.com//v1//acme/projects",
            "https://api.example.com/v1//acme/projects",
        ],
    )
    def test_parameterized_path_does_not_collapse_empty_segments_inside_base(self, url):
        result = matching.match_base_url(url, "https://api.example.com/v1/{org}")
        assert result is None

    def test_parameterized_path_preserves_empty_segments_after_base(self):
        result = matching.match_base_url(
            "https://api.example.com/v1/acme//projects",
            "https://api.example.com/v1/{org}",
        )
        assert result == ("//projects", {"org": "acme"})

    def test_parameterized_base_path_can_require_empty_segments(self):
        base = "https://api.example.com/v1//{org}"

        result = matching.match_base_url("https://api.example.com/v1//acme/projects", base)
        assert result == ("/projects", {"org": "acme"})

        result = matching.match_base_url("https://api.example.com/v1/acme/projects", base)
        assert result is None

    def test_parameterized_base_preserves_repeated_terminal_empty_segments(self):
        base = "https://api.example.com/v1/{org}//"

        result = matching.match_base_url("https://api.example.com/v1/acme/projects", base)
        assert result is None

        result = matching.match_base_url("https://api.example.com/v1/acme//projects", base)
        assert result == ("/projects", {"org": "acme"})

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.example.com//v1//messages/foo",
            "https://api.example.com/v1//messages/foo",
        ],
    )
    def test_parameterized_host_literal_path_does_not_collapse_empty_segments_inside_base(
        self,
        url,
    ):
        result = matching.match_base_url(url, "https://{sub}.example.com/v1/messages")
        assert result is None

    def test_parameterized_host_literal_path_preserves_empty_segments_after_base(self):
        result = matching.match_base_url(
            "https://api.example.com/v1/messages//foo",
            "https://{sub}.example.com/v1/messages",
        )
        assert result == ("//foo", {"sub": "api"})

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

    def test_runtime_host_braces_do_not_match_parameterized_base(self):
        result = matching.match_base_url(
            "https://{acme}.zendesk.com/api",
            "https://{sub}.zendesk.com",
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

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://acme.zendesk.com/api", "https://{sub}.zendesk.com:443"),
            ("https://acme.zendesk.com:443/api", "https://{sub}.zendesk.com"),
            ("http://acme.zendesk.com/api", "http://{sub}.zendesk.com:80"),
            ("http://acme.zendesk.com:80/api", "http://{sub}.zendesk.com"),
        ],
    )
    def test_parameterized_base_default_ports_match_omitted_ports(self, url, base):
        result = matching.match_base_url(url, base)
        assert result == ("/api", {"sub": "acme"})

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://acme.zendesk.com/api", "https://{sub}.zendesk.com."),
            ("https://acme.zendesk.com./api", "https://{sub}.zendesk.com"),
            ("https://acme.zendesk.com:8443/api", "https://{sub}.zendesk.com.:08443"),
            ("https://acme.zendesk.com.:8443/api", "https://{sub}.zendesk.com:8443"),
        ],
    )
    def test_parameterized_base_authority_normalization_matches_runtime_host(
        self,
        url,
        base,
    ):
        result = matching.match_base_url(url, base)
        assert result == ("/api", {"sub": "acme"})

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://acme.xn--fsqu00a.xn--0zwm56d/api", "https://{sub}.例子.测试"),
            ("https://acme.例子.测试/api", "https://{sub}.xn--fsqu00a.xn--0zwm56d"),
            ("https://acme.faß.de/api", "https://{sub}.xn--fa-hia.de"),
            ("https://acme.fa%C3%9F.de/api", "https://{sub}.xn--fa-hia.de"),
            ("https://acme.\U0001d6d3.example/api", "https://{sub}.xn--4xa.example"),
        ],
    )
    def test_parameterized_base_idna_authority_matches_runtime_host(self, url, base):
        result = matching.match_base_url(url, base)
        assert result == ("/api", {"sub": "acme"})

    @pytest.mark.parametrize(
        ("url", "base"),
        [
            ("https://api.faß.de/api", "https://{sub}.fass.de"),
            ("https://api.fass.de/api", "https://{sub}.faß.de"),
            ("https://api.\uff21.example/api", "https://{sub}.a.example"),
            ("https://api.%EF%BC%A1.example/api", "https://{sub}.a.example"),
            ("https://api.a.example/api", "https://{sub}.\uff21.example"),
            ("https://api.%E2%84%AA.example/api", "https://{sub}.k.example"),
            ("https://api.\u10a0.example/api", "https://{sub}.\u2d00.example"),
            ("https://api.\U0001d6d3.example/api", "https://{sub}.\u03c2.example"),
        ],
    )
    def test_parameterized_base_rejects_idna_compatibility_aliases(self, url, base):
        result = matching.match_base_url(url, base)
        assert result is None

    @pytest.mark.parametrize(
        "base",
        [
            "https://user@{sub}.zendesk.com",
            "https://user:pass@{sub}.zendesk.com",
            "https://.{sub}.zendesk.com",
            "https://{sub}..zendesk.com",
            "https://{sub}.zendesk.com:bad",
            "https://{sub}.zendesk.com:99999",
        ],
    )
    def test_parameterized_base_malformed_authority_returns_none(self, base):
        result = matching.match_base_url("https://acme.zendesk.com/api", base)
        assert result is None

    @pytest.mark.parametrize(
        "url",
        [
            "https://.zendesk.com/api",
            "https://acme..zendesk.com/api",
            "https://./api",
        ],
    )
    def test_parameterized_base_malformed_request_authority_returns_none(self, url):
        result = matching.match_base_url(url, "https://{sub}.zendesk.com")
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
