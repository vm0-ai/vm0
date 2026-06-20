"""Firewall auth flow orchestration and request mutation.

This module keeps mitmproxy HTTPFlow metadata, header/query injection,
auth.base forwarding, local failure responses, and AWS SigV4 signing together.
Cache state and platform API calls live in dedicated owner modules.
"""

import json
import urllib.parse
from dataclasses import dataclass
from enum import Enum

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import matching
from auth_base_forwarder import (
    MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    ForwardedRequestTooLargeError,
    InvalidResolvedAuthHeaderError,
    forward_request,
    forwarded_auth_base_client_header_pairs,
    header_pairs,
    resolved_auth_header_pairs,
)
from aws_sigv4 import AwsSigV4Credentials, AwsSigV4SigningError, sign_request
from firewall_auth_cache import InvalidBillableAuthExpiryError, get_firewall_headers
from firewall_auth_client import (
    ConnectorNotConfiguredError,
    FirewallAuthApiError,
    FirewallAuthRequest,
    InsufficientCreditsError,
)
from firewall_auth_config import auth_config_injects_credentials
from logging_utils import log_proxy_entry
from url_syntax import has_unsafe_runtime_url_syntax
from url_utils import build_rewrite_url


class FirewallAuthHandlingResult(Enum):
    """Request ownership outcome after firewall auth handling."""

    CONTINUE_UPSTREAM = "continue_upstream"
    INLINE_PROVIDER_RESPONSE = "inline_provider_response"
    LOCAL_RESPONSE = "local_response"


_HTTP_STATUS_CLIENT_ERROR_MIN = 400
_HTTP_STATUS_SERVER_ERROR_MIN = 500


@dataclass(frozen=True)
class _FirewallAuthContext:
    """Request-local firewall auth inputs for the hook orchestration path."""

    allow: matching.FirewallAllow
    firewall_base: str
    api_id: str
    run_id: str
    proxy_log_path: str
    auth_request: FirewallAuthRequest


def is_billable_firewall(firewall_name: str, vm_info: dict) -> bool:
    """Return whether this firewall should emit connector/model usage."""
    return firewall_name in (vm_info.get("billableFirewalls") or [])


def _prepare_firewall_metadata(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> None:
    """Store firewall match metadata once before auth resolution starts."""
    api_entry = allow.api_entry
    firewall_base = api_entry["base"]
    api_id = api_entry.get("id", firewall_base)
    # billableFirewalls is optional in the TS schema; runner may omit the
    # field entirely for non-vm0 / no-billable-connector runs.
    firewall_billable = is_billable_firewall(allow.name, vm_info)

    flow.metadata[metadata_keys.FIREWALL_BASE] = firewall_base
    flow.metadata[metadata_keys.FIREWALL_API_ID] = api_id
    flow.metadata[metadata_keys.FIREWALL_NAME] = allow.name
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = allow.permission or ""
    flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = allow.rule or ""
    flow.metadata[metadata_keys.FIREWALL_PARAMS] = allow.params
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = vm_info.get("modelUsageProvider")


def prepare_firewall_metadata(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> None:
    """Store matched-firewall metadata for callers outside this module."""
    _prepare_firewall_metadata(flow, allow, vm_info)


def _build_firewall_auth_context(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> _FirewallAuthContext:
    """Capture request-local auth inputs after matched-firewall metadata exists."""
    api_entry = allow.api_entry
    auth_config = api_entry.get("auth", {})
    return _FirewallAuthContext(
        allow=allow,
        firewall_base=flow.metadata[metadata_keys.FIREWALL_BASE],
        api_id=flow.metadata[metadata_keys.FIREWALL_API_ID],
        run_id=flow.metadata.get(metadata_keys.VM_RUN_ID, ""),
        proxy_log_path=flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, ""),
        auth_request=FirewallAuthRequest(
            sandbox_token=vm_info.get("sandboxToken", ""),
            encrypted_secrets=vm_info.get("encryptedSecrets") or "",
            auth_headers=auth_config.get("headers", {}),
            auth_base=auth_config.get("base"),
            auth_query=auth_config.get("query"),
            auth_aws_sigv4=auth_config.get("awsSigv4"),
            secret_connector_map=vm_info.get("secretConnectorMap"),
            secret_connector_metadata_map=vm_info.get("secretConnectorMetadataMap"),
            vars_map=vm_info.get("vars"),
            firewall_billable=bool(flow.metadata[metadata_keys.FIREWALL_BILLABLE]),
        ),
    )


def _firewall_auth_context_injects_credentials(context: _FirewallAuthContext) -> bool:
    return auth_config_injects_credentials(
        {
            "headers": context.auth_request.auth_headers,
            "query": context.auth_request.auth_query,
            "awsSigv4": context.auth_request.auth_aws_sigv4,
            "base": context.auth_request.auth_base,
        }
    )


def _set_matched_firewall_failure_response(
    flow: http.HTTPFlow,
    *,
    status: int,
    action: str,
    error_code: str,
    message: str,
    permission: str,
    connectors: list[str] | None = None,
    failure_reason: str | None = None,
) -> None:
    """Set the common matched-firewall auth/forward failure response."""
    # `firewall_action` records the firewall permission decision
    # (ALLOW/DENY/BLOCK); `firewall_error` records post-decision execution
    # failures. They are orthogonal: for example, action=ALLOW can pair with
    # an auth or forwarding error when the firewall granted the request but
    # the addon could not fulfill it. See #10493.
    firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
    _mark_matched_firewall_failure(flow, action=action, error_code=error_code)
    body: dict[str, object] = {
        "error": error_code,
        "message": message,
        "permission": permission,
        "base": firewall_base,
    }
    if connectors:
        body["connectors"] = connectors
    if failure_reason:
        body["failureReason"] = failure_reason
    flow.response = http.Response.make(
        status,
        json.dumps(body).encode(),
        {"Content-Type": "application/json"},
    )


def _mark_matched_firewall_failure(
    flow: http.HTTPFlow,
    *,
    action: str,
    error_code: str,
) -> None:
    flow.metadata[metadata_keys.FIREWALL_ACTION] = action
    flow.metadata[metadata_keys.FIREWALL_ERROR] = error_code


def _merge_auth_headers(
    headers,
    auth_headers: dict[str, str],
) -> list[tuple[str, str]]:
    """Append resolved auth headers after replacing same-name client pairs.

    Resolved auth headers are validated and filtered before merge. Any client
    header pair with the same lowercased name is removed so the resolved value
    wins in the auth.base rewrite path.
    """
    pairs = header_pairs(headers)
    auth_pairs = resolved_auth_header_pairs(auth_headers)
    override_names = {name.lower() for name, _value in auth_pairs}
    return [
        (name, value) for name, value in pairs if name.lower() not in override_names
    ] + auth_pairs


def _record_firewall_auth_success_metadata(flow: http.HTTPFlow, token_meta: dict) -> None:
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] = token_meta.get("resolved_secrets", [])
    flow.metadata[metadata_keys.AUTH_REFRESHED_CONNECTORS] = token_meta.get(
        "refreshed_connectors", []
    )
    flow.metadata[metadata_keys.AUTH_REFRESHED_SECRETS] = token_meta.get("refreshed_secrets", [])
    flow.metadata[metadata_keys.AUTH_CACHE_HIT] = token_meta.get("cache_hit", False)


def _apply_header_query_injection(
    flow: http.HTTPFlow,
    *,
    headers: dict[str, str],
    resolved_query: dict | None,
) -> None:
    for header_name, header_value in resolved_auth_header_pairs(headers):
        flow.request.headers[header_name] = header_value
    if resolved_query:
        for key, value in resolved_query.items():
            flow.request.query[key] = value


def _trusted_aws_sigv4_url(flow: http.HTTPFlow) -> str:
    url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
    if not isinstance(url, str):
        raise AwsSigV4SigningError("AWS request URL is unavailable")
    if has_unsafe_runtime_url_syntax(url, allow_backslash=True):
        raise AwsSigV4SigningError("AWS request URL is malformed")

    try:
        original = urllib.parse.urlsplit(url)
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e

    if has_unsafe_runtime_url_syntax(flow.request.path, allow_backslash=True):
        raise AwsSigV4SigningError("AWS request URL is malformed")
    try:
        current_query = urllib.parse.urlsplit(flow.request.path).query
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e
    if current_query == original.query:
        return url
    return urllib.parse.urlunsplit(
        (original.scheme, original.netloc, original.path, current_query, original.fragment)
    )


def _request_path_query(flow: http.HTTPFlow) -> str:
    if has_unsafe_runtime_url_syntax(flow.request.path, allow_backslash=True):
        raise ValueError("unsafe request target")
    return urllib.parse.urlparse(flow.request.path).query


def _sign_flow_request_with_aws_sigv4(
    flow: http.HTTPFlow,
    credentials: AwsSigV4Credentials,
) -> None:
    signed_url, signed_headers = sign_request(
        method=flow.request.method,
        url=_trusted_aws_sigv4_url(flow),
        headers=header_pairs(flow.request.headers),
        body=flow.request.raw_content,
        credentials=credentials,
    )
    flow.request.url = signed_url
    flow.request.headers = http.Headers(
        [(name.encode(), value.encode()) for name, value in signed_headers]
    )


def _sign_forwarded_request_with_aws_sigv4(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
) -> tuple[str, list[tuple[str, str]]]:
    return sign_request(
        method=method,
        url=url,
        headers=headers,
        body=body,
        credentials=credentials,
    )


def _set_url_rewrite_forward_failed(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
    error_type: str,
) -> None:
    log_proxy_entry(
        proxy_log_path,
        "error",
        "URL rewrite forward failed",
        type="firewall",
        firewall_base=firewall_base,
        error_type=error_type,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=502,
        action="ALLOW",
        error_code="url_rewrite_forward_failed",
        message="Failed to forward request to upstream",
        permission=allow.name,
    )


def _request_body_exceeds_auth_base_limit(flow: http.HTTPFlow) -> bool:
    body = flow.request.raw_content
    return body is not None and len(body) > MAX_AUTH_BASE_REQUEST_BODY_BYTES


def _log_auth_base_request_too_large(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int | None = None,
) -> None:
    if observed_size is None:
        body = flow.request.raw_content
        observed_size = len(body) if body is not None else 0
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base request body too large",
        type="firewall",
        firewall_base=firewall_base,
        request_body_size_bytes=observed_size,
        request_body_limit_bytes=MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    )


def _set_auth_base_request_too_large(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int | None = None,
) -> None:
    _log_auth_base_request_too_large(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
        observed_size=observed_size,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=413,
        action="ALLOW",
        error_code="auth_base_request_body_too_large",
        message="auth.base request body too large",
        permission=allow.name,
    )


def mark_auth_base_request_too_large(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int,
) -> None:
    """Record an auth.base oversized-body failure before killing the flow."""
    _log_auth_base_request_too_large(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
        observed_size=observed_size,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code="auth_base_request_body_too_large",
    )


def mark_auth_base_request_length_required(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    reason: str,
) -> None:
    """Record unbounded auth.base body framing before killing the flow."""
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base request body requires a valid Content-Length",
        type="firewall",
        firewall_base=firewall_base,
        framing_error=reason,
        request_body_limit_bytes=MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code="auth_base_request_body_length_required",
    )


def _preflight_firewall_auth(
    flow: http.HTTPFlow,
    context: _FirewallAuthContext,
) -> FirewallAuthHandlingResult | None:
    """Handle local firewall auth failures that must happen before auth resolution."""
    if context.auth_request.auth_base and _request_body_exceeds_auth_base_limit(flow):
        _set_auth_base_request_too_large(
            flow,
            allow=context.allow,
            proxy_log_path=context.proxy_log_path,
            firewall_base=context.firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    request_scheme = flow.request.scheme.lower()
    if request_scheme != "https" and _firewall_auth_context_injects_credentials(context):
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            "Refusing to inject firewall credentials over non-HTTPS transport",
            type="firewall",
            firewall_base=context.firewall_base,
            request_scheme=request_scheme,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=403,
            action="BLOCK",
            error_code="insecure_transport",
            message="Firewall credentials cannot be injected over non-HTTPS transport",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if not context.auth_request.encrypted_secrets:
        log_proxy_entry(
            context.proxy_log_path,
            "error",
            f"No encryptedSecrets for firewall rule {context.firewall_base}",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="auth_unavailable",
            message="Auth secrets not configured",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    return None


def _set_firewall_auth_resolution_failure(
    flow: http.HTTPFlow,
    context: _FirewallAuthContext,
    exc: Exception,
) -> FirewallAuthHandlingResult:
    """Map auth-resolution exceptions to local responses and metadata."""
    if isinstance(exc, ConnectorNotConfiguredError):
        log_proxy_entry(
            context.proxy_log_path,
            "info",
            f"Connector not configured for {context.firewall_base}: {exc}",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=424,
            action="BLOCK",
            error_code="connector_not_configured",
            message=str(exc),
            permission=context.allow.name,
            connectors=[context.allow.name] if context.allow.name else None,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, InsufficientCreditsError):
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            f"Billable firewall auth denied for {context.firewall_base}: {exc}",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=402,
            action="BLOCK",
            error_code="insufficient_credits",
            message=str(exc),
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, InvalidBillableAuthExpiryError):
        log_message = (
            "Billable firewall auth response returned invalid expiresAt "
            f"for {context.firewall_base}: {exc}"
        )
        log_proxy_entry(
            context.proxy_log_path,
            "error",
            log_message,
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="invalid_auth_expiry",
            message=str(exc),
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, FirewallAuthApiError):
        log_proxy_entry(
            context.proxy_log_path,
            "error",
            f"Firewall auth API failed for {context.firewall_base}: {exc.code}",
            type="firewall",
            firewall_base=context.firewall_base,
            error_code=exc.code,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=exc.status,
            action=(
                "BLOCK"
                if _HTTP_STATUS_CLIENT_ERROR_MIN <= exc.status < _HTTP_STATUS_SERVER_ERROR_MIN
                else "ALLOW"
            ),
            error_code=exc.code,
            message=str(exc),
            permission=context.allow.name,
            connectors=exc.connectors,
            failure_reason=exc.failure_reason,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    log_proxy_entry(
        context.proxy_log_path,
        "error",
        f"Firewall header fetch failed: {exc}",
        type="firewall",
        firewall_base=context.firewall_base,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=502,
        action="ALLOW",
        error_code="auth_failed",
        message=f"Failed to resolve auth headers: {exc}",
        permission=context.allow.name,
    )
    return FirewallAuthHandlingResult.LOCAL_RESPONSE


def _set_invalid_resolved_auth_header_response(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
    error: InvalidResolvedAuthHeaderError,
) -> None:
    log_proxy_entry(
        proxy_log_path,
        "error",
        "Invalid resolved auth header",
        type="firewall",
        firewall_base=firewall_base,
        error_type=type(error).__name__,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=502,
        action="ALLOW",
        error_code="invalid_resolved_auth_header",
        message=str(error),
        permission=allow.name,
    )


async def _apply_url_rewrite(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    resolved_base: str,
    headers: dict[str, str],
    resolved_query: dict | None,
    aws_sigv4: AwsSigV4Credentials | None,
    firewall_base: str,
    proxy_log_path: str,
) -> FirewallAuthHandlingResult:
    # The addon forwards the request itself because mitmproxy's eager
    # connection already connected to the placeholder IP. Setting
    # flow.response bypasses the upstream connection entirely.
    try:
        orig_query = _request_path_query(flow)
        new_url = build_rewrite_url(resolved_base, allow.rel_path, orig_query, resolved_query)
    except ValueError as e:
        _set_url_rewrite_forward_failed(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
            error_type=type(e).__name__,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    # Filter untrusted client headers before adding trusted auth headers, so
    # placeholder-scoped credentials cannot cross the auth.base rewrite.
    # Repeated request headers are preserved; resolved auth headers
    # intentionally replace any client-supplied value with the same name.
    client_headers = forwarded_auth_base_client_header_pairs(
        flow.request.headers,
        preserve_aws_sigv4_authorization=aws_sigv4 is not None,
    )
    req_headers = _merge_auth_headers(client_headers, headers)
    req_body = flow.request.raw_content if flow.request.raw_content is not None else None
    if aws_sigv4 is not None:
        try:
            new_url, req_headers = _sign_forwarded_request_with_aws_sigv4(
                method=flow.request.method,
                url=new_url,
                headers=req_headers,
                body=req_body,
                credentials=aws_sigv4,
            )
        except AwsSigV4SigningError as e:
            _set_matched_firewall_failure_response(
                flow,
                status=502,
                action="ALLOW",
                error_code="aws_sigv4_auth_failed",
                message=str(e),
                permission=allow.name,
            )
            return FirewallAuthHandlingResult.LOCAL_RESPONSE

    try:
        status, resp_body, resp_headers = await forward_request(
            new_url,
            flow.request.method,
            req_headers,
            req_body,
        )
        flow.response = http.Response.make(status, resp_body, resp_headers)
    except ForwardedRequestTooLargeError:
        _set_auth_base_request_too_large(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE
    except Exception as e:
        _set_url_rewrite_forward_failed(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
            error_type=type(e).__name__,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    flow.metadata[metadata_keys.AUTH_URL_REWRITE] = True
    log_proxy_entry(
        proxy_log_path,
        "info",
        f"Firewall URL rewrite: {firewall_base} -> [redacted]",
        type="firewall",
        firewall_base=firewall_base,
    )
    return FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE


async def _apply_resolved_firewall_auth(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    token_meta: dict,
    firewall_base: str,
    proxy_log_path: str,
) -> FirewallAuthHandlingResult:
    """Apply resolved firewall auth and return request ownership outcome."""
    headers = token_meta["headers"]
    resolved_query = token_meta.get("query")
    resolved_base = token_meta.get("base")
    aws_sigv4 = token_meta.get("aws_sigv4")

    try:
        if resolved_base:
            return await _apply_url_rewrite(
                flow,
                allow=allow,
                resolved_base=resolved_base,
                headers=headers,
                resolved_query=resolved_query,
                aws_sigv4=aws_sigv4,
                firewall_base=firewall_base,
                proxy_log_path=proxy_log_path,
            )

        _apply_header_query_injection(
            flow,
            headers=headers,
            resolved_query=resolved_query,
        )
    except InvalidResolvedAuthHeaderError as e:
        _set_invalid_resolved_auth_header_response(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
            error=e,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if aws_sigv4 is not None:
        try:
            _sign_flow_request_with_aws_sigv4(flow, aws_sigv4)
        except AwsSigV4SigningError as e:
            _set_matched_firewall_failure_response(
                flow,
                status=502,
                action="ALLOW",
                error_code="aws_sigv4_auth_failed",
                message=str(e),
                permission=allow.name,
            )
            return FirewallAuthHandlingResult.LOCAL_RESPONSE
    return FirewallAuthHandlingResult.CONTINUE_UPSTREAM


def _finalize_firewall_auth_success(
    flow: http.HTTPFlow,
    context: _FirewallAuthContext,
    token_meta: dict,
) -> None:
    """Record successful auth metadata and proxy log after auth application."""
    _record_firewall_auth_success_metadata(flow, token_meta)

    trusted_host = (
        flow.metadata.get(metadata_keys.TRUSTED_AUTHORITY_HOST) or flow.request.pretty_host
    )
    log_proxy_entry(
        context.proxy_log_path,
        "info",
        f"Firewall {context.firewall_base}: {trusted_host}",
        type="firewall",
        firewall_base=context.firewall_base,
        host=trusted_host,
        request_host_header=flow.request.host_header,
    )


async def handle_firewall_request(
    flow: http.HTTPFlow, allow: matching.FirewallAllow, vm_info: dict
) -> FirewallAuthHandlingResult:
    """Handle firewall auth and return who owns the next response lifecycle."""
    _prepare_firewall_metadata(flow, allow, vm_info)
    context = _build_firewall_auth_context(flow, allow, vm_info)

    preflight_result = _preflight_firewall_auth(flow, context)
    if preflight_result is not None:
        return preflight_result

    try:
        token_meta = await get_firewall_headers(
            context.run_id,
            context.api_id,
            context.auth_request,
        )
    except Exception as exc:
        return _set_firewall_auth_resolution_failure(flow, context, exc)

    auth_result = await _apply_resolved_firewall_auth(
        flow,
        allow=context.allow,
        token_meta=token_meta,
        firewall_base=context.firewall_base,
        proxy_log_path=context.proxy_log_path,
    )
    if auth_result is FirewallAuthHandlingResult.LOCAL_RESPONSE:
        return auth_result

    _finalize_firewall_auth_success(flow, context, token_meta)
    return auth_result
