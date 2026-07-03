"""Tests for low-level static firewall base URL matching."""

import pytest

import matching


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
