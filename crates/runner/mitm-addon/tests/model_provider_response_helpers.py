"""Shared fixtures for model-provider JSON response usage tests."""

import gzip
import json
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import brotli
import zstandard

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage


@dataclass(frozen=True)
class ModelProviderJsonCase:
    id: str
    host: str
    original_url: str
    firewall_name: str
    cli_agent_type: str | None
    message_id: str
    model: str
    uses_openai_responses: bool
    input_tokens: int = 50
    output_tokens: int = 200
    cached_tokens: int | None = None


@dataclass(frozen=True)
class JsonCompressionFailureCase:
    id: str
    make_body: Callable[[bytes], bytes]
    content_encoding: str
    expected_error: str


ANTHROPIC_JSON_CASE = ModelProviderJsonCase(
    id="anthropic",
    host="api.anthropic.com",
    original_url="https://api.anthropic.com/v1/messages",
    firewall_name="model-provider:anthropic-api-key",
    cli_agent_type=None,
    message_id="msg_1",
    model="claude-sonnet-4-6",
    uses_openai_responses=False,
)

OPENAI_RESPONSES_CASE = ModelProviderJsonCase(
    id="openai",
    host="api.openai.com",
    original_url="https://api.openai.com/v1/responses",
    firewall_name="model-provider:openai-api-key",
    cli_agent_type="codex",
    message_id="resp_1",
    model="gpt-5.5",
    uses_openai_responses=True,
    cached_tokens=10,
)

CODEX_OAUTH_RESPONSES_CASE = ModelProviderJsonCase(
    id="codex-oauth",
    host="chatgpt.com",
    original_url="https://chatgpt.com/backend-api/codex/responses",
    firewall_name="model-provider:codex-oauth-token",
    cli_agent_type="codex",
    message_id="resp_1",
    model="gpt-5.5",
    uses_openai_responses=True,
    cached_tokens=10,
)

MODEL_PROVIDER_JSON_CASES = (ANTHROPIC_JSON_CASE, OPENAI_RESPONSES_CASE)


def model_provider_json_case_id(provider_case: ModelProviderJsonCase) -> str:
    return provider_case.id


def json_compression_failure_case_id(encoding_case: JsonCompressionFailureCase) -> str:
    return encoding_case.id


def _identity_body(payload: bytes) -> bytes:
    return payload


def _raw_deflate_body(payload: bytes) -> bytes:
    compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    return compressor.compress(payload) + compressor.flush()


def _truncated_gzip_prefix(payload: bytes) -> bytes:
    return gzip.compress(payload)[:10]


def _truncated_gzip_trailer(payload: bytes) -> bytes:
    return gzip.compress(payload)[:-1]


def _truncated_deflate_trailer(payload: bytes) -> bytes:
    return zlib.compress(payload)[:-1]


def _empty_gzip_member_before_garbage(_payload: bytes) -> bytes:
    return gzip.compress(b"") + b"garbage"


def _empty_deflate_stream_before_garbage(_payload: bytes) -> bytes:
    return zlib.compress(b"") + b"garbage"


def _truncated_brotli_prefix(payload: bytes) -> bytes:
    return brotli.compress(payload)[:2]


def _truncated_brotli_trailer(payload: bytes) -> bytes:
    return brotli.compress(payload)[:-1]


def _truncated_zstd_prefix(payload: bytes) -> bytes:
    return zstandard.ZstdCompressor().compress(payload)[:5]


def _zstd_frame_before_garbage(payload: bytes) -> bytes:
    return zstandard.ZstdCompressor().compress(payload) + b"garbage"


def _zstd_frame_before_truncated_frame(payload: bytes) -> bytes:
    trailing_frame = zstandard.ZstdCompressor().compress(b"{}")
    return zstandard.ZstdCompressor().compress(payload) + trailing_frame[:5]


JSON_COMPRESSION_FAILURE_CASES = (
    JsonCompressionFailureCase(
        id="chained-gzip",
        make_body=gzip.compress,
        content_encoding="gzip, identity",
        expected_error="unsupported content encoding",
    ),
    JsonCompressionFailureCase(
        id="raw-json-with-unknown-header",
        make_body=_identity_body,
        content_encoding="x-custom",
        expected_error="unsupported content encoding",
    ),
    JsonCompressionFailureCase(
        id="raw-deflate",
        make_body=_raw_deflate_body,
        content_encoding="deflate",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="raw-json-with-gzip-header",
        make_body=_identity_body,
        content_encoding="gzip",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="raw-json-with-br-header",
        make_body=_identity_body,
        content_encoding="br",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="raw-json-with-zstd-header",
        make_body=_identity_body,
        content_encoding="zstd",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="truncated-gzip-prefix",
        make_body=_truncated_gzip_prefix,
        content_encoding="gzip",
        expected_error="incomplete compressed body",
    ),
    JsonCompressionFailureCase(
        id="truncated-gzip-trailer",
        make_body=_truncated_gzip_trailer,
        content_encoding="gzip",
        expected_error="incomplete compressed body",
    ),
    JsonCompressionFailureCase(
        id="truncated-deflate-trailer",
        make_body=_truncated_deflate_trailer,
        content_encoding="deflate",
        expected_error="incomplete compressed body",
    ),
    JsonCompressionFailureCase(
        id="empty-gzip-member-before-garbage",
        make_body=_empty_gzip_member_before_garbage,
        content_encoding="gzip",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="empty-deflate-stream-before-garbage",
        make_body=_empty_deflate_stream_before_garbage,
        content_encoding="deflate",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="truncated-brotli-prefix",
        make_body=_truncated_brotli_prefix,
        content_encoding="br",
        expected_error="incomplete compressed body",
    ),
    JsonCompressionFailureCase(
        id="truncated-brotli-trailer",
        make_body=_truncated_brotli_trailer,
        content_encoding="br",
        expected_error="incomplete compressed body",
    ),
    JsonCompressionFailureCase(
        id="truncated-zstd-prefix",
        make_body=_truncated_zstd_prefix,
        content_encoding="zstd",
        expected_error="incomplete compressed body",
    ),
    JsonCompressionFailureCase(
        id="zstd-frame-before-garbage",
        make_body=_zstd_frame_before_garbage,
        content_encoding="zstd",
        expected_error="invalid compressed body",
    ),
    JsonCompressionFailureCase(
        id="zstd-frame-before-truncated-frame",
        make_body=_zstd_frame_before_truncated_frame,
        content_encoding="zstd",
        expected_error="incomplete compressed body",
    ),
)


def standard_success_payload(
    provider_case: ModelProviderJsonCase,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_tokens: int | None = None,
) -> bytes:
    resolved_input_tokens = provider_case.input_tokens if input_tokens is None else input_tokens
    resolved_output_tokens = provider_case.output_tokens if output_tokens is None else output_tokens
    resolved_cached_tokens = provider_case.cached_tokens if cached_tokens is None else cached_tokens
    usage_payload: dict[str, object] = {
        "input_tokens": resolved_input_tokens,
        "output_tokens": resolved_output_tokens,
    }
    if provider_case.uses_openai_responses and resolved_cached_tokens is not None:
        usage_payload["input_tokens_details"] = {
            "cached_tokens": resolved_cached_tokens,
        }
    payload: dict[str, object] = {
        "id": provider_case.message_id,
        "model": provider_case.model,
        "usage": usage_payload,
    }
    if not provider_case.uses_openai_responses:
        payload["content"] = [{"type": "text", "text": "Hello"}]
    return json.dumps(payload).encode()


def expected_model_usage(
    provider_case: ModelProviderJsonCase,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_tokens: int | None = None,
) -> dict[str, object]:
    resolved_input_tokens = provider_case.input_tokens if input_tokens is None else input_tokens
    resolved_output_tokens = provider_case.output_tokens if output_tokens is None else output_tokens
    resolved_cached_tokens = provider_case.cached_tokens if cached_tokens is None else cached_tokens
    expected = {
        "message_id": provider_case.message_id,
        "model": provider_case.model,
        "tokens.input": resolved_input_tokens,
        "tokens.output": resolved_output_tokens,
    }
    if provider_case.uses_openai_responses and resolved_cached_tokens is not None:
        assert resolved_cached_tokens <= resolved_input_tokens
        expected["tokens.input"] = resolved_input_tokens - resolved_cached_tokens
        expected["tokens.cache_read"] = resolved_cached_tokens
    return expected


def expected_event_quantities(provider_case: ModelProviderJsonCase) -> dict[str, int]:
    return {
        category: quantity
        for category, quantity in expected_model_usage(provider_case).items()
        if category.startswith("tokens.")
        and isinstance(quantity, int)
        and not isinstance(quantity, bool)
        and quantity > 0
    }


def run_response(flow, usage_webhook_api):
    with usage_webhook_api() as webhook:
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")
    return webhook


def set_common_model_metadata(
    flow,
    tmp_path: Path,
    *,
    billable: bool = True,
    proxy_log_path: Path | None = None,
    run_id: str = "run-abc-123",
) -> None:
    flow.metadata[metadata_keys.VM_RUN_ID] = run_id
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    if proxy_log_path is not None:
        flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(proxy_log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = billable
    flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = "tok-xyz"


def set_model_provider_metadata(
    flow,
    tmp_path: Path,
    provider_case: ModelProviderJsonCase,
    *,
    billable: bool = True,
    observable: bool = True,
    proxy_log_path: Path | None = None,
    run_id: str = "run-abc-123",
) -> None:
    set_common_model_metadata(
        flow,
        tmp_path,
        billable=billable,
        proxy_log_path=proxy_log_path,
        run_id=run_id,
    )
    flow.metadata[metadata_keys.ORIGINAL_URL] = provider_case.original_url
    flow.metadata[metadata_keys.FIREWALL_NAME] = provider_case.firewall_name
    if observable:
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = provider_case.model
    if provider_case.cli_agent_type is not None:
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = provider_case.cli_agent_type


def model_provider_flow(
    real_flow,
    tmp_path: Path,
    provider_case: ModelProviderJsonCase,
    *,
    billable: bool = True,
    observable: bool = True,
    proxy_log_path: Path | None = None,
    run_id: str = "run-abc-123",
):
    flow = real_flow(with_response=False, host=provider_case.host)
    set_model_provider_metadata(
        flow,
        tmp_path,
        provider_case,
        billable=billable,
        observable=observable,
        proxy_log_path=proxy_log_path,
        run_id=run_id,
    )
    return flow
