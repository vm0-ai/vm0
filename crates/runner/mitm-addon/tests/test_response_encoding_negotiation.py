"""Safe response encoding negotiation for usage-inspected requests."""

from collections.abc import Callable
from pathlib import Path

import pytest
from mitmproxy import http

import mitm_addon
import response_encoding_negotiation
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_MODEL_PROVIDER_FIREWALL_NAME = "model-provider:anthropic-api-key"
_MODEL_PROVIDER_HOST = "api.anthropic.com"
_MODEL_PROVIDER_PATH = "/v1/messages"
_X_FIREWALL_NAME = "x"
_X_HOST = "api.x.com"
_X_PATH = "/2/users/by"
_ACCEPT_ENCODING = "Accept-Encoding"
_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


@pytest.mark.parametrize(
    ("header_pairs", "changed", "values"),
    [
        pytest.param([], True, ["identity"], id="absent"),
        pytest.param(
            [("Accept-Encoding", "gzip, zstd, br")],
            True,
            ["gzip"],
            id="drops-unsafe-keeps-gzip",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0, deflate;q=0.5, identity;q=1")],
            True,
            ["deflate;q=0.5, identity;q=1"],
            id="drops-safe-q-zero",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, identity;q=0, zstd")],
            True,
            ["gzip, identity;q=0"],
            id="preserves-explicit-identity-rejection-with-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, *;q=0, zstd")],
            True,
            ["gzip, identity;q=0"],
            id="preserves-wildcard-identity-rejection-with-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "zstd, br, *")],
            True,
            ["identity"],
            id="unsafe-only-falls-back-to-identity",
        ),
        pytest.param(
            [("Accept-Encoding", "identity;q=0, zstd")],
            False,
            ["identity;q=0, zstd"],
            id="respects-explicit-identity-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "*;q=0, zstd")],
            False,
            ["*;q=0, zstd"],
            id="wildcard-zero-rejects-implicit-identity",
        ),
        pytest.param(
            [("Accept-Encoding", "zstd, br, *;q=0.5, identity;q=0")],
            True,
            ["gzip;q=0.5, deflate;q=0.5, identity;q=0"],
            id="wildcard-allows-safe-compression-when-identity-rejected",
        ),
        pytest.param(
            [("Accept-Encoding", "zstd, br, *, identity;q=0")],
            True,
            ["gzip, deflate, identity;q=0"],
            id="wildcard-default-q-allows-safe-compression-when-identity-rejected",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0, zstd, *;q=0.5, identity;q=0")],
            True,
            ["deflate;q=0.5, identity;q=0"],
            id="wildcard-safe-compression-respects-explicit-safe-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.2, zstd, *;q=0.8, identity;q=0")],
            True,
            ["gzip;q=0.2, deflate;q=0.8, identity;q=0"],
            id="wildcard-adds-missing-safe-compression-after-explicit-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "deflate, br"), ("Accept-Encoding", "*;q=0.5, identity;q=0")],
            True,
            ["deflate, gzip;q=0.5, identity;q=0"],
            id="wildcard-adds-missing-safe-compression-across-header-fields",
        ),
        pytest.param(
            [
                (
                    "Accept-Encoding",
                    "gzip;q=0, deflate;q=0, zstd, *;q=0.5, identity;q=0",
                )
            ],
            False,
            ["gzip;q=0, deflate;q=0, zstd, *;q=0.5, identity;q=0"],
            id="wildcard-keeps-original-when-all-safe-codings-rejected",
        ),
        pytest.param(
            [("Accept-Encoding", "*;q=0.5, *;q=0, identity;q=0, zstd")],
            False,
            ["*;q=0.5, *;q=0, identity;q=0, zstd"],
            id="duplicate-wildcard-rejection-wins",
        ),
        pytest.param(
            [("Accept-Encoding", "GZip;q=1, zstd"), ("Accept-Encoding", "deflate;q=0.5, br")],
            True,
            ["gzip;q=1, deflate;q=0.5"],
            id="case-insensitive-and-multiple-fields",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, gzip;q=0.5, deflate")],
            True,
            ["gzip, deflate"],
            id="collapses-duplicate-safe-codings",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1, gzip;q=0, zstd")],
            True,
            ["identity"],
            id="duplicate-safe-coding-rejection-wins-after-acceptance",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0, gzip;q=1, zstd")],
            True,
            ["identity"],
            id="duplicate-safe-coding-rejection-wins-before-acceptance",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1;q=0, zstd")],
            True,
            ["identity"],
            id="duplicate-q-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;foo=bar, zstd")],
            True,
            ["identity"],
            id="non-q-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.5;foo=bar, zstd")],
            True,
            ["identity"],
            id="q-with-extra-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;, zstd")],
            True,
            ["identity"],
            id="empty-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip\u2028, zstd")],
            True,
            ["identity"],
            id="unicode-whitespace-suffix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "\u2028gzip, zstd")],
            True,
            ["identity"],
            id="unicode-whitespace-prefix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip\v, zstd")],
            True,
            ["identity"],
            id="vertical-tab-suffix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip\n, zstd")],
            True,
            ["identity"],
            id="newline-suffix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.5\u2028, zstd")],
            True,
            ["identity"],
            id="unicode-whitespace-q-value-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, identity;q=1, identity;q=0, zstd")],
            True,
            ["gzip, identity;q=0"],
            id="duplicate-identity-rejection-is-preserved-with-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=2, zstd")],
            True,
            ["identity"],
            id="invalid-q-value-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1.0000, zstd")],
            True,
            ["identity"],
            id="q-value-with-too-many-digits-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=.5, zstd")],
            True,
            ["identity"],
            id="q-value-without-leading-zero-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1e-1, zstd")],
            True,
            ["identity"],
            id="exponent-q-value-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "identity;q=bogus, zstd")],
            True,
            ["identity"],
            id="malformed-identity-q-is-not-explicit-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "identity;q=0.0000, zstd")],
            True,
            ["identity"],
            id="malformed-identity-zero-is-not-explicit-rejection",
        ),
    ],
)
def test_normalize_accept_encoding_for_body_inspection(
    headers,
    header_pairs: list[tuple[str, str]],
    changed: bool,
    values: list[str],
) -> None:
    request_headers = headers(*header_pairs)

    assert (
        response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(request_headers)
        is changed
    )
    assert request_headers.get_all(_ACCEPT_ENCODING) == values


def _model_provider_registry(
    tmp_path: Path,
    *,
    model_usage_provider: object = "claude-sonnet-4-6",
    capture_network_bodies: bool = False,
    rule_method: str = "POST",
) -> Path:
    vm_fields: dict[str, object] = {}
    if model_usage_provider is not None:
        vm_fields["modelUsageProvider"] = model_usage_provider
    if capture_network_bodies:
        vm_fields["captureNetworkBodies"] = True

    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name=_MODEL_PROVIDER_FIREWALL_NAME,
            api_entry={
                "base": f"https://{_MODEL_PROVIDER_HOST}",
                "auth": {"headers": {"x-api-key": "test-key"}},
                "permissions": [
                    {"name": "messages", "rules": [f"{rule_method} {_MODEL_PROVIDER_PATH}"]}
                ],
            },
            network_policy={
                "allow": ["messages"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields=vm_fields,
        ),
    )


def _connector_registry(
    tmp_path: Path,
    *,
    firewall_name: str,
    host: str,
    path: str,
    billable: bool,
    capture_network_bodies: bool = False,
) -> Path:
    vm_fields: dict[str, object] = {}
    if capture_network_bodies:
        vm_fields["captureNetworkBodies"] = True

    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name=firewall_name,
            api_entry={
                "base": f"https://{host}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read", "rules": [f"GET {path}"]}],
            },
            network_policy={
                "allow": ["read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name] if billable else None,
            vm_fields=vm_fields,
        ),
    )


def _request_flow(
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    *,
    host: str,
    path: str,
    method: str,
    accept_encoding: str | None,
    extra_headers: tuple[tuple[str, str], ...] = (),
) -> http.HTTPFlow:
    header_pairs = [("Host", host)]
    if accept_encoding is not None:
        header_pairs.append((_ACCEPT_ENCODING, accept_encoding))
    header_pairs.extend(extra_headers)
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=host,
        path=path,
        method=method,
        request_headers=headers(*header_pairs),
    )


async def test_observable_model_provider_request_normalizes_accept_encoding_before_auth(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_observable_model_provider_without_accept_encoding_sets_identity(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding=None,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "identity"


async def test_billable_connector_with_response_parser_normalizes_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="deflate, zstd",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "deflate"


async def test_billable_connector_without_response_parser_keeps_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name="stripe",
        host="api.stripe.com",
        path="/v1/charges",
        billable=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host="api.stripe.com",
        path="/v1/charges",
        method="GET",
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"


async def test_non_observable_model_provider_keeps_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path, model_usage_provider=None)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"


async def test_header_phase_stream_safe_auth_normalizes_accept_encoding_before_auth(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
        capture_network_bodies=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        assert flow.request.headers[_ACCEPT_ENCODING] == "gzip"
        assert flow.request.headers["Authorization"] == "Bearer x"
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip"


async def test_model_provider_websocket_upgrade_keeps_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
        extra_headers=(("Connection", "keep-alive, Upgrade"), ("Upgrade", "websocket")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"


@pytest.mark.parametrize(
    ("method", "rule_method"),
    [
        pytest.param("HEAD", "HEAD", id="head"),
        pytest.param("CONNECT", "ANY", id="connect"),
    ],
)
async def test_response_bodyless_usage_inspected_methods_keep_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    method: str,
    rule_method: str,
) -> None:
    reg_path = _model_provider_registry(tmp_path, rule_method=rule_method)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method=method,
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize(
    "extra_headers",
    [
        pytest.param(
            (("Connection", "keep-alive, Upgrade"), ("Upgrade", "websocket\u2028")),
            id="invalid-upgrade-value-whitespace",
        ),
        pytest.param(
            (("Connection", "keep-alive, \u2028Upgrade"), ("Upgrade", "websocket")),
            id="invalid-connection-token-whitespace",
        ),
        pytest.param(
            (("Upgrade", "websocket"),),
            id="missing-connection-upgrade-token",
        ),
    ],
)
async def test_invalid_websocket_upgrade_whitespace_normalizes_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    extra_headers: tuple[tuple[str, str], ...],
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
        extra_headers=extra_headers,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip"


async def test_browser_passthrough_keeps_accept_encoding_for_parser_connector(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(("User-Agent", _BROWSER_USER_AGENT),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
