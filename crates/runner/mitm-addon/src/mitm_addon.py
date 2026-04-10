#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
"""

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import zlib
from concurrent.futures import ThreadPoolExecutor

import brotli  # type: ignore[import-untyped]
import zstandard
from mitmproxy import ctx, http, tcp, tls
from mitmproxy.addonmanager import Loader

# --- Sub-module imports (only symbols used in this file's own code) ---
from auth import (
    _firewall_header_cache,
    _opener,
    evict_stale_cache_keys,
    handle_firewall_request,
    make_api_request,
)
from logging_utils import add_firewall_metadata, log_network_entry
from matching import FirewallAllow, FirewallBlock, match_firewall_request
from url_utils import get_original_url

# ============================================================================
# Addon Configuration
# ============================================================================


def load(loader: Loader) -> None:
    """Register custom options for the addon."""
    loader.add_option(
        name="vm0_api_url",
        typespec=str,
        default="https://www.vm0.ai",
        help="VM0 API URL for proxy endpoint",
    )
    loader.add_option(
        name="vm0_proxy_registry_path",
        typespec=str,
        default="/tmp/proxy-registry.json",
        help="Path to proxy registry file",
    )


def get_api_url() -> str:
    """Get API URL from options."""
    return ctx.options.vm0_api_url


def get_registry_path() -> str:
    """Get registry path from options."""
    return ctx.options.vm0_proxy_registry_path


# ============================================================================
# Registry & VM Lookup
# ============================================================================

# Cache for proxy registry (invalidated by file stat change)
_registry_cache: dict = {}
_registry_cache_key: tuple[int, int] = (0, 0)

# Track request start times for latency calculation
_request_start_times: dict = {}


def load_registry() -> dict:
    """Load the proxy registry from file, with stat-based cache invalidation."""
    global _registry_cache, _registry_cache_key

    try:
        registry_path = get_registry_path()
        st = os.stat(registry_path)
        key = (st.st_mtime_ns, st.st_size)
        if key == _registry_cache_key:
            return _registry_cache
        with open(registry_path, "r") as f:
            new_registry = json.load(f).get("vms", {})

        # Evict cache entries for runs no longer in the registry
        active_run_ids = {vm.get("runId") for vm in new_registry.values()}
        evict_stale_cache_keys(active_run_ids)

        _registry_cache = new_registry
        _registry_cache_key = key
    except Exception as e:
        ctx.log.warn(f"Failed to load proxy registry: {e}")

    return _registry_cache


def get_vm_info(client_ip: str) -> dict | None:
    """Look up VM info by client IP address."""
    registry = load_registry()
    return registry.get(client_ip)


# ============================================================================
# TLS ClientHello Handler
# ============================================================================


def tls_clienthello(data: tls.ClientHelloData) -> None:
    """
    Handle TLS ClientHello — decide whether to MITM intercept.
    All registered VMs use MITM mode for HTTP-level filtering and logging.
    Unregistered IPs are passed through without interception.
    """
    client_ip = data.context.client.peername[0] if data.context.client.peername else None
    if not client_ip:
        return

    vm_info = get_vm_info(client_ip)
    if not vm_info:
        # Not a registered VM - pass through without MITM interception
        # This is critical for CIDR-based rules where all VM traffic is redirected
        data.ignore_connection = True
        return

    # Registered VM: let mitmproxy perform MITM interception


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================


async def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request: inject firewall auth headers for configured firewall rules.

    Order:
    1. VM0 API auto-allow (agent must always reach the platform)
    2. Firewall match (inject auth headers for allowed requests)
    """
    # Get client IP (source VM)
    client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else None

    if not client_ip:
        ctx.log.warn("No client IP available, passing through")
        return

    # Look up VM info from registry
    vm_info = get_vm_info(client_ip)

    if not vm_info:
        # Not a registered VM, pass through without proxying
        return

    run_id = vm_info.get("runId", "")

    # Track request start time (after early returns to avoid leaking entries)
    _request_start_times[flow.id] = time.time()

    original_url = get_original_url(flow)

    # Store info for response handler
    flow.metadata["original_url"] = original_url
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")
    flow.metadata["capture_body"] = vm_info.get("captureNetworkBodies", False)
    flow.metadata["vm_sandbox_token"] = vm_info.get("sandboxToken", "")

    # Get target hostname
    hostname = flow.request.pretty_host.lower()

    # --- Step 1: Auto-allow VM0 API requests ---
    # The agent MUST be able to communicate with the platform.
    api_url = get_api_url()
    if api_url:
        parsed_api = urllib.parse.urlparse(api_url)
        api_hostname = parsed_api.hostname.lower() if parsed_api.hostname else ""
        if api_hostname and (hostname == api_hostname or hostname.endswith(f".{api_hostname}")):
            flow.metadata["firewall_action"] = "ALLOW"
            return

    # --- Step 2: Firewall match with permission check ---
    # Match base URL, then check permission rules before injecting auth headers.
    vm_firewalls = vm_info.get("firewalls")
    if vm_firewalls:
        network_policies = vm_info.get("networkPolicies") or {}
        result = match_firewall_request(
            original_url,
            flow.request.method,
            vm_firewalls,
            network_policies,
            body=flow.request.content,
        )
        if isinstance(result, FirewallBlock):
            ctx.log.warn(
                f"[{run_id}] Firewall {result.ref}: "
                f"no matching permission for {result.method} {result.path}"
            )
            flow.metadata["firewall_action"] = "DENY"
            flow.metadata["firewall_base"] = result.base
            flow.metadata["firewall_name"] = result.name
            flow.metadata["firewall_ref"] = result.ref
            error_body = json.dumps(
                {
                    "error": "permission_denied",
                    "message": "Request blocked: no matching permission rule",
                    "method": result.method,
                    "path": result.path,
                    "ref": result.ref,
                    "permissions": list(result.permissions),
                    "base": result.base,
                }
            )
            flow.response = http.Response.make(
                403,
                error_body.encode(),
                {"Content-Type": "application/json"},
            )
            return
        if isinstance(result, FirewallAllow):
            await handle_firewall_request(flow, result.api_entry, vm_info, result.match_info)
            return

    # No firewall match — pass through directly
    flow.metadata["firewall_action"] = "ALLOW"


_STREAM_BUFFER_LIMIT = 64 * 1024  # 64 KB


# ---------------------------------------------------------------------------
# Proxy-side usage extraction (for billing verification)
# ---------------------------------------------------------------------------

# Only extract known billing fields to avoid capturing unrelated numerics.
_BILLING_FIELDS = frozenset(
    (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    )
)


def _extract_billing_usage(raw_usage, target: dict) -> None:
    """Extract known billing fields from an Anthropic usage object into *target*.

    Handles both flat fields (input_tokens, etc.) and the nested
    ``server_tool_use.web_search_requests`` field.

    Only positive values overwrite existing entries — ``message_delta`` may
    send ``0`` for fields already set correctly by ``message_start``.
    """
    if not raw_usage or not isinstance(raw_usage, dict):
        return
    for k, v in raw_usage.items():
        if k in _BILLING_FIELDS and isinstance(v, (int, float)):
            if v > 0 or k not in target:
                target[k] = v
    stu = raw_usage.get("server_tool_use")
    if isinstance(stu, dict):
        wsr = stu.get("web_search_requests")
        if isinstance(wsr, (int, float)):
            if wsr > 0 or "web_search_requests" not in target:
                target["web_search_requests"] = wsr


def _create_sse_usage_extractor():
    """Create an incremental SSE parser that extracts usage from Anthropic API streams.

    All model providers in this system use the Anthropic Messages API streaming
    format.  Usage data appears in two SSE events:

    - ``message_start`` — ``message.usage`` contains input token counts and
      ``message.model`` identifies the model.
    - ``message_delta`` — ``usage`` contains the final ``output_tokens`` count.

    Returns ``(parse_chunk, usage)`` where *parse_chunk* processes raw bytes
    incrementally and *usage* is a dict that accumulates extracted fields.
    """
    usage: dict = {}
    line_buf = bytearray()
    event_type = {"current": None}
    # Events we need to parse — all others are skipped to avoid buffering
    # large content_block_delta payloads.
    _usage_events = frozenset(("message_start", "message_delta"))
    # When True, discard incoming bytes until the next empty line (event
    # boundary) to avoid buffering irrelevant data lines.
    skipping = {"active": False}

    def parse_chunk(chunk: bytes) -> None:
        # In skip mode, scan for event boundary (empty line) without
        # buffering the (potentially large) chunk.
        if skipping["active"]:
            # Look for \n\n or \r\n\r\n in existing buf + new chunk.
            combined = line_buf + chunk
            for sep in (b"\r\n\r\n", b"\n\n"):
                idx = combined.find(sep)
                if idx != -1:
                    # Found event boundary — line_buf gets the remainder.
                    # Do NOT extend again below; data is already in line_buf.
                    after = idx + len(sep)
                    line_buf[:] = combined[after:]
                    skipping["active"] = False
                    event_type["current"] = None
                    break
            else:
                # No boundary found — discard everything except the
                # last few bytes (could be a partial \r\n\r\n).
                line_buf[:] = combined[-3:] if len(combined) > 3 else combined
                return
            # Boundary found — fall through to process line_buf contents.
            # line_buf already has the data, so skip the extend.
        else:
            line_buf.extend(chunk)
        while b"\n" in line_buf:
            raw_line, _, remaining = line_buf.partition(b"\n")
            line_buf[:] = remaining
            line = raw_line.rstrip(b"\r").decode("utf-8", errors="replace")

            # Blank line = event boundary.
            if line == "":
                event_type["current"] = None
                skipping["active"] = False
                continue

            if skipping["active"]:
                continue

            if line.startswith("event: "):
                evt_name = line[7:]
                event_type["current"] = evt_name
                if evt_name not in _usage_events:
                    # Skip data lines of this event within line_buf.
                    # Cross-chunk large data lines are handled by the
                    # skip mode at the top of parse_chunk.
                    skipping["active"] = True
                    continue
            elif line.startswith("data: "):
                evt = event_type["current"]
                if evt == "message_start":
                    try:
                        data = json.loads(line[6:])
                        msg = data.get("message") or {}
                        model = msg.get("model")
                        if model:
                            usage["model"] = model
                        _extract_billing_usage(msg.get("usage"), usage)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass  # SSE data lines may be partial/malformed; best-effort extraction
                elif evt == "message_delta":
                    try:
                        data = json.loads(line[6:])
                        _extract_billing_usage(data.get("usage"), usage)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass  # SSE data lines may be partial/malformed; best-effort extraction

    return parse_chunk, usage


def _extract_usage_from_json(body: bytes, headers) -> dict | None:
    """Extract usage from a non-streaming Anthropic API JSON response.

    Falls back to decompressing the body if *headers* indicate compression.
    Returns ``None`` when the body is not valid JSON or contains no usage.
    """
    if headers:
        body = _decompress_body(body, headers)
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    usage: dict = {}
    model = data.get("model")
    if model:
        usage["model"] = model
    _extract_billing_usage(data.get("usage"), usage)
    return usage if usage else None


def _do_report_usage(api_url: str, sandbox_token: str, run_id: str, usage: dict) -> None:
    """POST extracted usage to the platform webhook.  Raises on failure."""
    url = f"{api_url}/api/webhooks/agent/usage"
    payload = json.dumps({"runId": run_id, "usage": usage}).encode()
    req = make_api_request(url, payload, sandbox_token)
    try:
        resp = _opener.open(req, timeout=10)
        resp.close()
    except urllib.error.HTTPError as exc:
        exc.close()  # HTTPError holds an open socket
        raise


def _report_usage_with_retry(
    api_url: str,
    sandbox_token: str,
    run_id: str,
    usage: dict,
    max_retries: int = 1,
) -> None:
    """Report usage with retry.  Swallows all exceptions after final attempt."""
    for attempt in range(max_retries + 1):
        try:
            _do_report_usage(api_url, sandbox_token, run_id, usage)
            return
        except Exception as exc:
            if attempt < max_retries:
                time.sleep(0.5)
            else:
                ctx.log.warn(f"[{run_id}] Usage report failed after {attempt + 1} attempts: {exc}")


# ---------------------------------------------------------------------------
# Usage reporting thread pool — replaces fire-and-forget daemon threads.
# ThreadPoolExecutor processes reports in parallel; done() flushes pending
# items before mitmproxy exits (SIGKILL at 3 s is the hard stop).
# ---------------------------------------------------------------------------

_usage_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")


def _enqueue_usage(api_url: str, sandbox_token: str, run_id: str, usage: dict) -> None:
    """Submit usage report to the thread pool.  Copies the dict to avoid mutation."""
    _usage_executor.submit(_report_usage_with_retry, api_url, sandbox_token, run_id, dict(usage))


def _maybe_report_proxy_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Enqueue proxy-extracted usage for model provider responses if available."""
    firewall_name = flow.metadata.get("firewall_name", "")
    if not (firewall_name.startswith("model-provider:") and run_id):
        return
    proxy_usage = flow.metadata.get("proxy_usage")
    if not proxy_usage:
        return
    sandbox_token = flow.metadata.get("vm_sandbox_token", "")
    api_url = get_api_url()
    if not sandbox_token or not api_url:
        ctx.log.warn(f"[{run_id}] Cannot report usage: missing sandbox_token or api_url")
        return
    _enqueue_usage(api_url, sandbox_token, run_id, proxy_usage)


def responseheaders(flow: http.HTTPFlow) -> None:
    """
    Enable response streaming with body buffering.

    Uses a callback to stream response data to the client immediately
    while accumulating a copy in memory (up to ``_STREAM_BUFFER_LIMIT``).
    Once the limit is exceeded, buffering stops but streaming continues
    uninterrupted.  The buffered body is available in the ``response()``
    hook via ``flow.metadata["stream_buffer"]``.
    """
    if not flow.response:
        return

    buf = bytearray()
    state = {"truncated": False}

    # Set up SSE usage extraction for model provider streaming responses.
    # For non-SSE model provider responses, disable buffer truncation so the
    # full JSON body is available for usage extraction in response().
    sse_parser = None
    sse_decompressor = None
    is_model_provider = flow.metadata.get("firewall_name", "").startswith("model-provider:")
    if is_model_provider:
        content_type = flow.response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            parser_fn, usage_dict = _create_sse_usage_extractor()
            sse_parser = parser_fn
            flow.metadata["proxy_usage"] = usage_dict
            sse_decompressor = _create_stream_decompressor(flow.response.headers)

    # Model provider responses are never truncated so usage extraction
    # always has the complete body.  Other responses use the 64 KB limit.
    buf_limit = None if is_model_provider else _STREAM_BUFFER_LIMIT

    def stream_and_buffer(chunk: bytes) -> bytes:
        if not state["truncated"]:
            if buf_limit is None:
                buf.extend(chunk)
            else:
                remaining = buf_limit - len(buf)
                if len(chunk) <= remaining:
                    buf.extend(chunk)
                else:
                    buf.extend(chunk[:remaining])
                    state["truncated"] = True
        if sse_parser is not None:
            plaintext = sse_decompressor(chunk) if sse_decompressor else chunk
            sse_parser(plaintext)
        return chunk

    flow.response.stream = stream_and_buffer
    flow.metadata["stream_buffer"] = buf
    flow.metadata["stream_buffer_state"] = state


# ---------------------------------------------------------------------------
# Body capture helpers (opt-in per run via captureNetworkBodies registry flag)
# ---------------------------------------------------------------------------


_TEXT_CONTENT_TYPES = (
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "application/graphql",
)

# Header names containing any of these keywords (case-insensitive) are redacted.
_SENSITIVE_HEADER_KEYWORDS = (
    "auth",
    "token",
    "secret",
    "api-key",
    "apikey",
    "credential",
    "password",
    "cookie",
)


def _create_stream_decompressor(headers: http.Headers):
    """Create an incremental decompressor for streaming chunks.

    Returns a callable that decompresses each chunk, maintaining state
    across calls.  Returns None if the response is not compressed.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return None
    if encoding in ("gzip", "deflate"):
        wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
        obj = zlib.decompressobj(wbits)

        def decompress_zlib(chunk: bytes) -> bytes:
            try:
                return obj.decompress(chunk)
            except zlib.error:
                return b""

        return decompress_zlib
    if encoding == "br":
        dec = brotli.Decompressor()

        def decompress_br(chunk: bytes) -> bytes:
            try:
                return dec.process(chunk)
            except brotli.error:
                return b""

        return decompress_br
    if encoding == "zstd":
        obj = zstandard.ZstdDecompressor().decompressobj()

        def decompress_zstd(chunk: bytes) -> bytes:
            try:
                return obj.decompress(chunk)
            except zstandard.ZstdError:
                return b""

        return decompress_zstd
    return None


def _decompress_body(
    data: bytes, headers: http.Headers, max_output: int = _STREAM_BUFFER_LIMIT
) -> bytes:
    """Decompress response body based on Content-Encoding header.

    The stream callback receives raw wire bytes.  When the server uses
    gzip/deflate/br/zstd encoding, we must decompress before capturing.
    Uses incremental decompression so truncated compressed data still
    yields whatever decompressed bytes are available.

    Output is capped at *max_output* bytes to guard against decompression
    bombs (small compressed payload expanding to huge output).

    Returns the original data unchanged if not compressed or on error.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return data
    try:
        if encoding in ("gzip", "deflate"):
            # wbits: gzip=16+MAX_WBITS, deflate=MAX_WBITS
            wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
            obj = zlib.decompressobj(wbits)
            result = obj.decompress(data, max_length=max_output)
            return result if result else data
        if encoding == "br":
            dec = brotli.Decompressor()
            result = dec.process(data)
            return result[:max_output] if result else data
        if encoding == "zstd":
            obj = zstandard.ZstdDecompressor().decompressobj()
            result = obj.decompress(data)
            return result[:max_output] if result else data
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        try:
            ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
        except AttributeError:
            pass  # ctx.log unavailable outside mitmproxy runtime
    return data


def _is_text_content(content_type: str) -> bool:
    """Check if content-type indicates text-like content worth capturing."""
    if not content_type:
        return True  # assume text when unspecified
    ct = content_type.lower().split(";")[0].strip()
    return any(ct.startswith(prefix) for prefix in _TEXT_CONTENT_TYPES)


def _truncate_bytes_utf8_safe(data: bytes, max_size: int) -> bytes:
    """Truncate bytes at a UTF-8 character boundary.

    After slicing at *max_size*, checks whether the last character is
    complete.  If not, removes the incomplete trailing bytes (at most 4).
    """
    if len(data) <= max_size:
        return data
    t = data[:max_size]
    # Find the start of the last character by scanning backwards
    # past continuation bytes (10xxxxxx = 0x80..0xBF).
    i = len(t)
    while i > 0 and (t[i - 1] & 0xC0) == 0x80:
        i -= 1
    if i == 0:
        return t  # all continuation bytes — shouldn't happen in valid UTF-8
    lead = t[i - 1]
    # Determine the expected sequence length from the lead byte.
    if lead < 0x80:
        expected = 1
    elif lead < 0xE0:
        expected = 2
    elif lead < 0xF0:
        expected = 3
    else:
        expected = 4
    # If the sequence starting at (i-1) has fewer bytes than expected,
    # it was cut — remove the incomplete sequence.
    actual = len(t) - (i - 1)
    if actual < expected:
        return t[: i - 1]
    return t


def _encode_body(content: bytes, content_type: str) -> tuple:
    """Encode body content. Returns (encoded_string, encoding_type) or (None, None) for binary."""
    if not _is_text_content(content_type):
        return None, None  # skip binary bodies
    try:
        return content.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return base64.b64encode(content).decode("ascii"), "base64"


def _is_sensitive_header(name: str) -> bool:
    """Check if a header name likely carries sensitive data."""
    lower = name.lower()
    return any(kw in lower for kw in _SENSITIVE_HEADER_KEYWORDS)


def _redact_headers(headers) -> dict:
    """Build a dict of headers with sensitive values replaced by ***."""
    result = {}
    for name, value in headers.items(multi=True):
        if name in result:
            continue  # keep first occurrence only (headers.items gives all)
        result[name] = "***" if _is_sensitive_header(name) else value
    return result


def _add_capture_fields(flow: http.HTTPFlow, log_entry: dict) -> None:
    """Add request/response headers and bodies to a log entry.

    # [NETWORK_LOG_FIELDS] — capture-only fields, not part of the core schema.
    # Fields: request_headers, request_body, request_body_encoding,
    #         request_body_truncated, response_headers, response_body,
    #         response_body_encoding, response_body_truncated
    """
    # Request headers (always available)
    log_entry["request_headers"] = _redact_headers(flow.request.headers)

    # Request body
    if flow.request.content:
        req_ct = flow.request.headers.get("content-type", "")
        body = flow.request.content
        truncated = len(body) > _STREAM_BUFFER_LIMIT
        if truncated:
            body = _truncate_bytes_utf8_safe(body, _STREAM_BUFFER_LIMIT)
        encoded, encoding = _encode_body(body, req_ct)
        if encoded is not None:
            log_entry["request_body"] = encoded
            log_entry["request_body_encoding"] = encoding
            if truncated:
                log_entry["request_body_truncated"] = True
        else:
            log_entry["request_body_encoding"] = "binary"

    # Response headers
    if flow.response:
        log_entry["response_headers"] = _redact_headers(flow.response.headers)

    # Response body — read from stream_buffer (available for all responses).
    # The buffer contains raw wire bytes (possibly gzip/br/zstd compressed).
    if flow.response:
        stream_buf = flow.metadata.get("stream_buffer")
        if stream_buf is not None:
            body = _decompress_body(bytes(stream_buf), flow.response.headers)
        else:
            try:
                body = flow.response.content
            except (zlib.error, ValueError):
                # ZlibError (decompression failure) or ValueError from mitmproxy
                log_entry["response_body_encoding"] = "binary"
                return
        if not body:
            return
        stream_state = flow.metadata.get("stream_buffer_state")
        res_ct = flow.response.headers.get("content-type", "")
        # stream_buffer may already be truncated at _STREAM_BUFFER_LIMIT.
        # Also check decompressed size in case it expanded beyond the limit.
        truncated = (stream_state and stream_state["truncated"]) or len(body) > _STREAM_BUFFER_LIMIT
        if truncated:
            body = _truncate_bytes_utf8_safe(body, _STREAM_BUFFER_LIMIT)
        encoded, encoding = _encode_body(body, res_ct)
        if encoded is not None:
            log_entry["response_body"] = encoded
            log_entry["response_body_encoding"] = encoding
            if truncated:
                log_entry["response_body_truncated"] = True
        else:
            log_entry["response_body_encoding"] = "binary"


def response(flow: http.HTTPFlow) -> None:
    """
    Handle response and log network activity.
    """
    # Calculate latency
    start_time = _request_start_times.pop(flow.id, None)
    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0

    # Get stored info
    run_id = flow.metadata.get("vm_run_id", "")
    original_url = flow.metadata.get("original_url", flow.request.pretty_url)
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")

    # Calculate sizes
    request_size = len(flow.request.content) if flow.request.content else 0
    # Use buffered body length when complete; fall back to Content-Length header.
    stream_buf = flow.metadata.get("stream_buffer")
    stream_state = flow.metadata.get("stream_buffer_state")
    if stream_buf is not None and stream_state and not stream_state["truncated"]:
        response_size = len(stream_buf)
    elif flow.response:
        response_size = int(flow.response.headers.get("content-length", 0))
    else:
        response_size = 0
    status_code = flow.response.status_code if flow.response else 0

    # Parse URL for host
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port

    # Log network entry for this run (always MITM mode with full HTTP details)
    # [NETWORK_LOG_FIELDS] — source of truth for network log fields
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    if run_id and network_log_path:
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "type": "http",
            "action": firewall_action,
            "host": host,
            "port": port,
            "method": flow.request.method,
            "url": original_url,
            "status": status_code,
            "latency_ms": latency_ms,
            "request_size": request_size,
            "response_size": response_size,
        }

        # Add firewall match info if this was a firewall request
        firewall_base = flow.metadata.get("firewall_base")
        if firewall_base:
            add_firewall_metadata(flow, log_entry)

        # Add request headers, request body, and response body when capture is enabled
        if flow.metadata.get("capture_body"):
            _add_capture_fields(flow, log_entry)

        log_network_entry(network_log_path, log_entry)

    # Report proxy-extracted usage for model provider responses.
    # For non-streaming responses, fall back to extracting usage from the
    # buffered JSON body (buffer is never truncated for model providers).
    if not flow.metadata.get("proxy_usage") and stream_buf and run_id:
        firewall_name = flow.metadata.get("firewall_name", "")
        if firewall_name.startswith("model-provider:"):
            json_usage = _extract_usage_from_json(
                bytes(stream_buf),
                flow.response.headers if flow.response else None,
            )
            if json_usage:
                flow.metadata["proxy_usage"] = json_usage
    _maybe_report_proxy_usage(flow, run_id)

    # Invalidate firewall header cache on 401 so next request gets fresh headers
    if flow.response and flow.response.status_code == 401 and flow.metadata.get("firewall_base"):
        api_id = flow.metadata.get("firewall_api_id", "")
        if api_id:
            cache_key = (run_id, api_id)
            _firewall_header_cache.pop(cache_key, None)

    # Log errors to mitmproxy console
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(f"[{run_id}] Response {flow.response.status_code}: {original_url}")


def error(flow: http.HTTPFlow) -> None:
    """
    Log connection-level errors (timeout, RST, TLS failure) to the
    per-run JSONL network log and clean up request tracking state.
    """
    start_time = _request_start_times.pop(flow.id, None)

    run_id = flow.metadata.get("vm_run_id", "")
    network_log_path = flow.metadata.get("vm_network_log_path", "")

    if not run_id or not network_log_path:
        return

    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0
    original_url = flow.metadata.get("original_url", flow.request.pretty_url)
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")

    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port

    request_size = len(flow.request.content) if flow.request.content else 0
    error_msg = flow.error.msg if flow.error else "unknown error"

    # [NETWORK_LOG_FIELDS] — keep in sync with response() and runs.ts schema
    log_entry: dict = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "type": "http",
        "action": firewall_action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "url": original_url,
        "status": 0,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": 0,
        "error": error_msg,
    }

    # Add firewall context if available
    firewall_base = flow.metadata.get("firewall_base")
    if firewall_base:
        add_firewall_metadata(flow, log_entry)

    log_network_entry(network_log_path, log_entry)

    # Report proxy-extracted usage for model provider responses.
    # The SSE parser may have partially populated proxy_usage before the
    # connection error occurred.  Partial data is better than none.
    _maybe_report_proxy_usage(flow, run_id)

    ctx.log.warn(f"[{run_id}] Error: {error_msg}: {original_url}")


# ============================================================================
# Graceful Shutdown
# ============================================================================


def done():
    """Flush pending usage reports before mitmproxy exits.

    The runner sends SIGTERM then waits 3 seconds before SIGKILL.
    ``shutdown(wait=True)`` blocks until all submitted futures complete;
    SIGKILL is the hard stop if any report takes too long.
    """
    _usage_executor.shutdown(wait=True)


# ============================================================================
# TCP Connection Handlers
# ============================================================================


def tcp_start(flow: tcp.TCPFlow) -> None:
    """Track TCP connection start time and look up VM info."""
    client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else None
    if not client_ip:
        return

    vm_info = get_vm_info(client_ip)
    if not vm_info:
        return

    flow.metadata["vm_run_id"] = vm_info.get("runId", "")
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")
    flow.metadata["tcp_start_time"] = time.time()


def tcp_end(flow: tcp.TCPFlow) -> None:
    """Log TCP connection details when it closes."""
    _log_tcp(flow)


def tcp_error(flow: tcp.TCPFlow) -> None:
    """Log TCP connection errors."""
    _log_tcp(flow)


def _log_tcp(flow: tcp.TCPFlow) -> None:
    run_id = flow.metadata.get("vm_run_id", "")
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    if not run_id or not network_log_path:
        return

    start_time = flow.metadata.get("tcp_start_time")
    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0

    request_size = sum(len(m.content) for m in flow.messages if m.from_client)
    response_size = sum(len(m.content) for m in flow.messages if not m.from_client)

    server_addr = flow.server_conn.address if flow.server_conn else None
    host = server_addr[0] if server_addr else "unknown"
    port = server_addr[1] if server_addr else 0

    # [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "type": "tcp",
        "host": host,
        "port": port,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }

    if flow.error:
        log_entry["error"] = flow.error.msg

    log_network_entry(network_log_path, log_entry)


# mitmproxy addon registration
addons = [
    tls_clienthello,
    request,
    responseheaders,
    response,
    error,
    tcp_start,
    tcp_end,
    tcp_error,
]
