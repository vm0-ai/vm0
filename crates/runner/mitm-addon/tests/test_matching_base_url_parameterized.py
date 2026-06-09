"""Tests for low-level parameterized firewall base URL matching."""

import pytest

import matching


class TestMatchBaseUrl:
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
