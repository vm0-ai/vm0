"""Request-header field-name admission integration tests."""

import connector_intent
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.requestheaders_helpers import _assert_no_request_stream

_MAX_REQUEST_HEADER_NAME_BYTES = 4096
_BROWSER_USER_AGENT = (
    b"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    b"(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


class _LowerGuardHeaderName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("over-budget request header name must not be lowercased")


async def test_requestheaders_rejects_over_budget_names_before_header_processing(real_flow):
    retained_fields = (
        (b"Host", b"example.com"),
        (b"Expect", b"100-continue"),
        (b"X-Trace", b"first"),
        (b"x-trace", b"second"),
        (b"x-VM0-Connector-Intent", b"primary"),
        (b"x-VM0-Codex-Model-Catalog-Prefetch", b"1"),
    )
    flow = real_flow(
        with_response=False,
        request_headers=mitm_addon.http.Headers(
            [
                *retained_fields,
                (
                    _LowerGuardHeaderName(b"X" * (_MAX_REQUEST_HEADER_NAME_BYTES + 1)),
                    b"rejected",
                ),
                (b"Y" * (_MAX_REQUEST_HEADER_NAME_BYTES + 2), b"also-rejected"),
            ]
        ),
    )

    assert mitm_addon.requestheaders(flow) is None

    assert flow.response is not None
    assert flow.response.status_code == 431
    assert flow.response.content == b""
    assert flow.request.headers.fields == retained_fields
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    _assert_no_request_stream(flow)

    await mitm_addon.request(flow)

    assert flow.request.headers.fields == retained_fields
    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


async def test_requestheaders_accepts_name_budget_and_preserves_existing_header_behavior(
    registry_file,
    real_flow,
    mitm_ctx,
):
    boundary_name = b"X" * _MAX_REQUEST_HEADER_NAME_BYTES
    repeated_fields = (
        (b"X-Trace", b"first"),
        (b"x-trace", b"second"),
    )
    flow = real_flow(
        with_response=False,
        request_headers=mitm_addon.http.Headers(
            [
                (b"hOsT", b"example.com"),
                (b"uSeR-aGeNt", _BROWSER_USER_AGENT),
                *repeated_fields,
                (boundary_name, b"accepted"),
                (b"x-VM0-Connector-Intent", b"primary"),
                (b"x-VM0-Codex-Model-Catalog-Prefetch", b"1"),
            ]
        ),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

    assert flow.response is None
    assert (boundary_name, b"accepted") in flow.request.headers.fields
    assert all(field in flow.request.headers.fields for field in repeated_fields)
    assert (b"hOsT", b"example.com") in flow.request.headers.fields
    assert (b"uSeR-aGeNt", _BROWSER_USER_AGENT) in flow.request.headers.fields
    assert all(
        name
        not in (
            b"x-VM0-Connector-Intent",
            b"x-VM0-Codex-Model-Catalog-Prefetch",
        )
        for name, _value in flow.request.headers.fields
    )
    assert connector_intent.from_flow(flow) == connector_intent.ConnectorIntent(
        "present", "primary"
    )
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert flow.metadata["_codex_model_catalog_prefetch_request"] is True
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
