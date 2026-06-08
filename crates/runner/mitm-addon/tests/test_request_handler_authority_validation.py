"""Authority validation tests for the request hook."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.request_handler_helpers import _write_github_firewall_registry

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


@pytest.mark.parametrize(
    ("request_port", "expected_original_url"),
    [
        (443, "https://attacker.example.com/repos"),
        (8443, "https://attacker.example.com:8443/repos"),
    ],
)
async def test_rejects_spoofed_host_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="attacker.example.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "authority_mismatch"
    assert flow.metadata["original_url"] == expected_original_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": expected_original_url,
        "host": "attacker.example.com",
        "port": request_port,
    }
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_authority_validation_deny_response_logs_network_target(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    raw_url = "https://attacker.example.com:8443/repos?code=secret#frag"
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=8443,
        sni="attacker.example.com",
        path="/repos?code=secret#frag",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    auth_fetch.assert_not_called()
    assert flow.metadata["original_url"] == raw_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET]["url"] == raw_url

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = json.loads((tmp_path / "net.jsonl").read_text().strip())
    assert entry["type"] == "http"
    assert entry["action"] == "DENY"
    assert entry["host"] == "attacker.example.com"
    assert entry["port"] == 8443
    assert entry["url"] == "https://attacker.example.com:8443/repos"
    assert "code=secret" not in entry["url"]
    assert "#frag" not in entry["url"]
    assert entry["status"] == 403
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


async def test_browser_user_agent_marker_survives_authority_validation_block(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="attacker.example.com",
        path="/repos",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    auth_fetch.assert_not_called()

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = json.loads((tmp_path / "net.jsonl").read_text().strip())
    assert entry["action"] == "DENY"
    assert entry["browser_user_agent"] is True


async def test_matching_sni_and_host_allows_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    assert flow.metadata["firewall_name"] == "github"
    assert flow.metadata["firewall_permission"] == "full-access"
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata["original_url"] == "https://api.github.com/repos"
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": "https://api.github.com/repos",
        "host": "api.github.com",
        "port": 443,
    }


@pytest.mark.parametrize("http_version", ["HTTP/2.0", "HTTP/3"])
async def test_pseudo_authority_without_host_allows_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, http_version
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(),
    )
    flow.request.http_version = http_version
    flow.request.authority = "api.github.com"

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    assert flow.metadata["original_url"] == "https://api.github.com/repos"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize("http_version", ["HTTP/2.0", "HTTP/3"])
async def test_pseudo_authority_takes_precedence_over_host_header(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, http_version
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.request.http_version = http_version
    flow.request.authority = "attacker.example.com"

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == "attacker.example.com"
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "authority_mismatch"
    assert flow.metadata["original_url"] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_spoofed_host_before_vm0_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="attacker.example.com",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert flow.metadata["firewall_action"] == "DENY"


async def test_rejects_duplicate_host_authority_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Host", "attacker.example.com"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == "api.github.com, attacker.example.com"
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_authority"
    assert flow.metadata["original_url"] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_accepts_equivalent_host_authority_default_https_port(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com:443")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize(
    "host_header",
    [
        "0177.0.0.1",
        "127。0。0。1",
        "127.0.0.1。",
        "\uff11\uff12\uff17.\uff10.\uff10.\uff11",
    ],
)
async def test_rejects_noncanonical_ipv4_host_authority_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, host_header
):
    reg_path = _write_github_firewall_registry(tmp_path, base="https://127.0.0.1")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="127.0.0.1",
        path="/repos",
        request_headers=headers(("Host", host_header)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "127.0.0.1"
    assert body["host_header"] == host_header
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_authority"
    assert flow.metadata["original_url"] == "https://127.0.0.1/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize("host_header", ["api.github.com", "api.github.com:8443"])
async def test_accepts_matching_non_default_host_authority_port(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    host_header,
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="https://api.github.com:8443",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=8443,
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", host_header)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "https://api.github.com:8443"
    assert flow.metadata["original_url"] == "https://api.github.com:8443/repos"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize("host_header", ["[2001:db8::1]", "[2001:db8::1]:8443"])
async def test_accepts_matching_ipv6_host_authority(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, host_header
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="https://[2001:db8::1]:8443",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="2001:db8::1",
        port=8443,
        sni="2001:db8::1",
        path="/repos",
        request_headers=headers(("Host", host_header)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "https://[2001:db8::1]:8443"
    assert flow.metadata["original_url"] == "https://[2001:db8::1]:8443/repos"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_accepts_canonical_ipv6_host_authority(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="https://[2001:db8::1]:8443",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="2001:0db8::1",
        port=8443,
        sni="2001:0db8::1",
        path="/repos",
        request_headers=headers(("Host", "[2001:db8::1]:8443")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "https://[2001:db8::1]:8443"
    assert flow.metadata["original_url"] == "https://[2001:db8::1]:8443/repos"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_rejects_unbracketed_ipv6_host_authority(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="https://[2001:db8::1]:8443",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="2001:db8::1",
        port=8443,
        sni="2001:db8::1",
        path="/repos",
        request_headers=headers(("Host", "2001:db8::1")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "2001:db8::1"
    assert body["request_host"] == "2001:db8::1"
    assert body["host_header"] == "2001:db8::1"
    assert body["request_port"] == 8443
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_authority"
    assert flow.metadata["original_url"] == "https://[2001:db8::1]:8443/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    ("request_port", "host_header", "expected_original_url"),
    [
        (443, "api.github.com:444", "https://api.github.com/repos"),
        (8443, "api.github.com:443", "https://api.github.com:8443/repos"),
    ],
)
async def test_rejects_host_authority_port_mismatch(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    host_header,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", host_header)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_port_mismatch"
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "authority_port_mismatch"
    assert flow.metadata["original_url"] == expected_original_url
    auth_fetch.assert_not_called()


@pytest.mark.parametrize(
    ("base", "sni", "host_header", "expected_firewall_base", "expected_original_url"),
    [
        (
            "https://api.github.com",
            "api.github.com",
            "API.GITHUB.COM",
            "https://api.github.com",
            "https://api.github.com/repos",
        ),
        (
            "https://api.github.com",
            "API.GITHUB.COM.",
            "api.github.com.",
            "https://api.github.com",
            "https://api.github.com/repos",
        ),
        (
            "https://xn--bcher-kva.example",
            "bücher.example",
            "xn--bcher-kva.example",
            "https://xn--bcher-kva.example",
            "https://xn--bcher-kva.example/repos",
        ),
        (
            "https://xn--bcher-kva.example",
            "xn--bcher-kva.example",
            "bücher.example",
            "https://xn--bcher-kva.example",
            "https://xn--bcher-kva.example/repos",
        ),
        (
            "https://xn--fa-hia.de",
            "faß.de",
            "xn--fa-hia.de",
            "https://xn--fa-hia.de",
            "https://xn--fa-hia.de/repos",
        ),
        (
            "https://xn--3xa.example",
            "\u03c2.example",
            "xn--3xa.example",
            "https://xn--3xa.example",
            "https://xn--3xa.example/repos",
        ),
        (
            "https://xn--a-0mb.example",
            "a\u03a3.example",
            "xn--a-0mb.example",
            "https://xn--a-0mb.example",
            "https://xn--a-0mb.example/repos",
        ),
        (
            "https://xn--09d.example",
            "\u13be.example",
            "xn--09d.example",
            "https://xn--09d.example",
            "https://xn--09d.example/repos",
        ),
        (
            "https://xn--09d.example",
            "\uab8e.example",
            "xn--09d.example",
            "https://xn--09d.example",
            "https://xn--09d.example/repos",
        ),
        (
            "https://xn--mxaq.example",
            "\u1fb3.example",
            "xn--mxaq.example",
            "https://xn--mxaq.example",
            "https://xn--mxaq.example/repos",
        ),
        (
            "https://xn--uxa190l.example",
            "\u1f86.example",
            "xn--uxa190l.example",
            "https://xn--uxa190l.example",
            "https://xn--uxa190l.example/repos",
        ),
        (
            "https://xn--uxa.example",
            "\u0345.example",
            "xn--uxa.example",
            "https://xn--uxa.example",
            "https://xn--uxa.example/repos",
        ),
        (
            "https://xn--n1a.example",
            "\u1c82.example",
            "xn--n1a.example",
            "https://xn--n1a.example",
            "https://xn--n1a.example/repos",
        ),
        (
            "https://xn--r1a.example",
            "\u1c85.example",
            "xn--r1a.example",
            "https://xn--r1a.example",
            "https://xn--r1a.example/repos",
        ),
        (
            "https://xn--4xa.example",
            "\U0001d6d3.example",
            "xn--4xa.example",
            "https://xn--4xa.example",
            "https://xn--4xa.example/repos",
        ),
        (
            "https://xn--a-63c.example",
            "a\u0754.example",
            "xn--a-63c.example",
            "https://xn--a-63c.example",
            "https://xn--a-63c.example/repos",
        ),
        (
            "https://xn--z-cmbg264c9ov.example",
            "z\u1fc3\u08f2\u17b6.example",
            "xn--z-cmbg264c9ov.example",
            "https://xn--z-cmbg264c9ov.example",
            "https://xn--z-cmbg264c9ov.example/repos",
        ),
        (
            "https://xn--cib0c.example",
            "\u0663\u067a.example",
            "xn--cib0c.example",
            "https://xn--cib0c.example",
            "https://xn--cib0c.example/repos",
        ),
        (
            "https://xn--ciba2e.example",
            "\u0663\u067a\u0663.example",
            "xn--ciba2e.example",
            "https://xn--ciba2e.example",
            "https://xn--ciba2e.example/repos",
        ),
        (
            "https://xn--a1-iyd.example",
            "a1\u0663.example",
            "xn--a1-iyd.example",
            "https://xn--a1-iyd.example",
            "https://xn--a1-iyd.example/repos",
        ),
    ],
)
async def test_accepts_authority_host_normalization_equivalence(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    base,
    sni,
    host_header,
    expected_firewall_base,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path, base=base)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni=sni,
        path="/repos",
        request_headers=headers(("Host", host_header)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == expected_firewall_base
    assert flow.metadata["original_url"] == expected_original_url
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_rejects_idna_compatibility_sni_alias_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_github_firewall_registry(tmp_path, base="https://a.example")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="\uff21.example",
        path="/repos",
        request_headers=headers(("Host", "a.example")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_sni"
    assert body["sni"] == "\uff21.example"
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_sni"
    assert flow.metadata["original_url"] == "https://203.0.113.10/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_multiple_trailing_dot_sni_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_github_firewall_registry(tmp_path, base="https://api.github.com")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com..",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_sni"
    assert body["sni"] == "api.github.com.."
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_sni"
    assert flow.metadata["original_url"] == "https://203.0.113.10/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_idna_compatibility_host_alias_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_github_firewall_registry(tmp_path, base="https://a.example")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="a.example",
        path="/repos",
        request_headers=headers(("Host", "\uff21.example")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "a.example"
    assert body["host_header"] == "\uff21.example"
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_authority"
    assert flow.metadata["original_url"] == "https://a.example/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    ("request_port", "host_header", "expected_error", "expected_original_url"),
    [
        (443, None, "missing_authority", "https://api.github.com/repos"),
        (443, "", "missing_authority", "https://api.github.com/repos"),
        (8443, "", "missing_authority", "https://api.github.com:8443/repos"),
        (443, "api.github.com:bad", "invalid_authority", "https://api.github.com/repos"),
        (443, "api.github.com..", "invalid_authority", "https://api.github.com/repos"),
        (443, "{api}.github.com", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--.com", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--a.com", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--zzzz.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--ph7c.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u4f8b\uff1a\u5b50.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u4f8b\uff0c\u5b50.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u034f.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u0301.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\ufe0f.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--rld.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--f09a.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--hsg.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "xn--43f.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u00a8.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u10a0.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u04c0.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\ufe12.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\ufffc.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u0754\u3d20.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "a\u0754b.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u25a5\u33d5\u067a.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u28a8\u17b5.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u0663a.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u0663!.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "\u0663\u067aa.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "a\u0663b.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "a\u0663\u0664.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "1\u0663.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "!\u0663!.example", "invalid_authority", "https://api.github.com/repos"),
        (443, "[::1]junk", "invalid_authority", "https://api.github.com/repos"),
        (443, "[fe80::1%25eth0]", "invalid_authority", "https://api.github.com/repos"),
        (
            8443,
            "api.github.com:bad",
            "invalid_authority",
            "https://api.github.com:8443/repos",
        ),
    ],
)
async def test_rejects_invalid_host_authority_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    host_header,
    expected_error,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    request_headers = headers() if host_header is None else headers(("Host", host_header))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="api.github.com",
        path="/repos",
        request_headers=request_headers,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == expected_error
    assert body["sni"] == "api.github.com"
    assert body["request_host"] == "203.0.113.10"
    assert body["host_header"] == host_header
    assert body["request_port"] == request_port
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == expected_error
    assert flow.metadata["original_url"] == expected_original_url
    auth_fetch.assert_not_called()


@pytest.mark.parametrize(
    ("request_host", "request_port", "raw_sni", "expected_sni", "expected_original_url"),
    [
        ("203.0.113.10", 443, None, None, "https://203.0.113.10/repos"),
        ("203.0.113.10", 443, "   ", "", "https://203.0.113.10/repos"),
        ("203.0.113.10", 8443, None, None, "https://203.0.113.10:8443/repos"),
        ("2001:db8::1", 8443, None, None, "https://[2001:db8::1]:8443/repos"),
    ],
)
async def test_rejects_missing_https_sni_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_host,
    request_port,
    raw_sni,
    expected_sni,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=request_host,
        port=request_port,
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.client_conn.sni = raw_sni

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "missing_sni"
    assert body["sni"] == expected_sni
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "missing_sni"
    assert flow.metadata["original_url"] == expected_original_url
    auth_fetch.assert_not_called()


@pytest.mark.parametrize(
    ("request_host", "request_port", "raw_sni", "expected_sni", "expected_original_url"),
    [
        ("203.0.113.10", 443, "...", "...", "https://203.0.113.10/repos"),
        ("203.0.113.10", 8443, "...", "...", "https://203.0.113.10:8443/repos"),
        ("203.0.113.10", 443, "\ud800", "\ud800", "https://203.0.113.10/repos"),
        ("203.0.113.10", 443, "xn--.com", "xn--.com", "https://203.0.113.10/repos"),
        ("203.0.113.10", 443, "xn--a.com", "xn--a.com", "https://203.0.113.10/repos"),
        (
            "203.0.113.10",
            443,
            "xn--ph7c.example",
            "xn--ph7c.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "api.github.com:443",
            "api.github.com:443",
            "https://203.0.113.10/repos",
        ),
        ("203.0.113.10", 443, "0177.0.0.1", "0177.0.0.1", "https://203.0.113.10/repos"),
        ("203.0.113.10", 443, "127。0。0。1", "127。0。0。1", "https://203.0.113.10/repos"),
        ("203.0.113.10", 443, "127.0.0.1。", "127.0.0.1。", "https://203.0.113.10/repos"),
        (
            "203.0.113.10",
            443,
            "\uff11\uff12\uff17.\uff10.\uff10.\uff11",
            "\uff11\uff12\uff17.\uff10.\uff10.\uff11",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u4f8b\uff1a\u5b50.example",
            "\u4f8b\uff1a\u5b50.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u212a.example",
            "\u212a.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u1e9e.de",
            "\u1e9e.de",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u03f2.example",
            "\u03f2.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u034f.example",
            "\u034f.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u0301.example",
            "\u0301.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "xn--rld.example",
            "xn--rld.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "fe80::1%25eth0",
            "fe80::1%25eth0",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "xn--zzzz.example",
            "xn--zzzz.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u00a8.example",
            "\u00a8.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u10a0.example",
            "\u10a0.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\ufffc.example",
            "\ufffc.example",
            "https://203.0.113.10/repos",
        ),
        (
            "203.0.113.10",
            443,
            "\u0754\u3d20.example",
            "\u0754\u3d20.example",
            "https://203.0.113.10/repos",
        ),
        ("2001:db8::1", 8443, "...", "...", "https://[2001:db8::1]:8443/repos"),
    ],
)
async def test_rejects_invalid_https_sni_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_host,
    request_port,
    raw_sni,
    expected_sni,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=request_host,
        port=request_port,
        sni=raw_sni,
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_sni"
    assert body["sni"] == expected_sni
    assert body["request_host"] == request_host
    assert body["host_header"] == "api.github.com"
    assert body["request_port"] == request_port
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_error"] == "invalid_sni"
    assert flow.metadata["original_url"] == expected_original_url
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
    assert proxy_log_entry["type"] == "authority_validation"
    assert proxy_log_entry["reason"] == "invalid_sni"
    assert proxy_log_entry["sni"] == expected_sni
    assert proxy_log_entry["request_host"] == request_host
    assert proxy_log_entry["host_header"] == "api.github.com"
    assert proxy_log_entry["request_port"] == request_port
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_http_host_spoof_does_not_match_domain_firewall(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path, base="http://api.github.com")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        scheme="http",
        host="203.0.113.10",
        port=80,
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_action"] == "ALLOW"
    assert flow.metadata["original_url"] == "http://203.0.113.10/repos"
    assert "firewall_base" not in flow.metadata
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_http_host_spoof_does_not_trigger_vm0_api_auto_allow(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="http://203.0.113.10/api/runs",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        scheme="http",
        host="203.0.113.10",
        port=80,
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata["firewall_base"] == "http://203.0.113.10/api/runs"
    assert flow.metadata["original_url"] == "http://203.0.113.10/api/runs/heartbeat"
    assert flow.request.headers["Authorization"] == "Bearer x"
