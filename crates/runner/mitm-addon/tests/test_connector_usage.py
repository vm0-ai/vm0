"""Tests for X connector response parser routing."""

import pytest

import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT
from tests.flow_helpers import header_map, response_stream
from tests.x_flow_helpers import make_x_response_flow


class TestXStreamPathRouting:
    """Tests for stream path routing through responseheaders (issue #9534)."""

    def _make_x_response_flow(self, real_flow, path: str):
        return make_x_response_flow(real_flow, path=path)

    @pytest.mark.parametrize(
        "path",
        [
            "/2/tweets/search/stream",
            "/2/tweets/sample/stream",
            "/2/tweets/sample10/stream",
            "/2/tweets/compliance/stream",
            "/2/users/compliance/stream",
        ],
    )
    def test_stream_endpoints_register_ndjson_parser(self, real_flow, path):
        flow = self._make_x_response_flow(real_flow, path)

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_absolute_form_request_target_registers_ndjson_parser_from_original_url(
        self, real_flow
    ):
        flow = self._make_x_response_flow(
            real_flow,
            "/2/tweets/search/stream?tweet.fields=id",
        )
        flow.request.path = "https://api.x.com/2/tweets/search/stream?tweet.fields=id"

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_stream_parser_requires_original_url(self, real_flow):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.metadata.pop("original_url")

        with pytest.raises(ValueError, match="original_url"):
            mitm_addon.responseheaders(flow)

    @pytest.mark.parametrize(
        "path",
        [
            "/2/tweets/search/stream/rules",
            "/2/tweets/search/recent",
            "/2/users/by",
            "/2/tweets/1",
            "",
            "/",
        ],
    )
    def test_non_stream_paths_register_json_parser(self, real_flow, path):
        flow = self._make_x_response_flow(real_flow, path)

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_stream_error_response_uses_bounded_forensic_buffer_only(self, real_flow):
        flow = make_x_response_flow(
            real_flow,
            path="/2/tweets/search/stream",
            response_status=401,
        )

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        callback = response_stream(flow)
        callback(b'{"title":"Unauthorized","detail":"' + b"x" * (200 * 1024) + b'"}')
        assert len(flow.metadata["stream_buffer"]) == STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    @pytest.mark.parametrize("path", ["/2/tweets", "/2/tweets/search/stream"])
    @pytest.mark.parametrize("firewall_billable", [False, None])
    def test_non_billable_x_responses_do_not_register_connector_parser(
        self,
        real_flow,
        path,
        firewall_billable,
    ):
        flow = make_x_response_flow(real_flow, path=path, firewall_billable=firewall_billable)
        if firewall_billable is None:
            flow.metadata.pop("firewall_billable")

        mitm_addon.responseheaders(flow)

        assert "connector_response_finish" not in flow.metadata
        assert "x_ndjson_state" not in flow.metadata

    def test_brotli_stream_path_skips_response_body_parser(self, real_flow, mitm_ctx):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        assert flow.response is not None
        flow.response.headers = header_map(
            {"content-type": "application/json", "content-encoding": "br"}
        )

        with mitm_ctx() as log:
            mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        assert log.debug.call_count == 1
        assert "Streaming decompression skipped (br)" in log.debug.call_args[0][0]

    def test_unregistered_parser_factory_does_not_require_original_url(self, real_flow):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "github"
        flow.metadata.pop("original_url")

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
