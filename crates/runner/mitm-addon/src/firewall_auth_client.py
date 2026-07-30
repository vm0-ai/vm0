"""Client and response parsing for the runner firewall auth endpoint."""

import asyncio
import json
import math
import urllib.error
from dataclasses import dataclass, field
from typing import Protocol

import platform_api
from aws_sigv4 import AwsSigV4Credentials

MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES = 256 * 1024
_STRUCTURED_FIREWALL_AUTH_ERROR_CODES = frozenset(
    {
        "FORBIDDEN",
        "TOKEN_REFRESH_FAILED",
        "TOKEN_ACCESS_RESOLUTION_FAILED",
    }
)
_FIREWALL_AUTH_FAILURE_REASONS = frozenset({"upstream_provider", "reconnect_required"})
_opener = platform_api.build_api_opener()


class ConnectorNotConfiguredError(Exception):
    """Raised when the auth endpoint returns 424 — connector not linked or misconfigured."""


class InsufficientCreditsError(Exception):
    """Raised when the auth endpoint denies billable firewall auth for credits."""


class FirewallAuthResponseTooLargeError(Exception):
    """Raised when /firewall/auth returns a response body above the local cap."""


class FirewallAuthApiError(Exception):
    """Raised when /firewall/auth returns a structured error envelope."""

    def __init__(
        self,
        *,
        status: int,
        code: str,
        message: str,
        connectors: list[str] | None = None,
        failure_reason: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.connectors = connectors
        self.failure_reason = failure_reason


class _ResponseBodyReader(Protocol):
    def read(self, n: int = -1) -> bytes:
        raise NotImplementedError


@dataclass(frozen=True)
class FirewallAuthRequest:
    """Inputs sent to the runner firewall auth webhook."""

    encrypted_secrets: str = field(repr=False)
    auth_headers: dict
    sandbox_token: str = field(repr=False)
    auth_base: str | None = None
    auth_query: dict | None = None
    auth_aws_sigv4: dict | None = None
    secret_connector_map: dict | None = None
    secret_connector_metadata_map: dict | None = None
    vars_map: dict | None = None
    firewall_billable: bool = False

    def to_body(self, *, force_refresh: bool = False) -> dict:
        """Build the webhook JSON body while preserving omission semantics."""
        body: dict = {
            "encryptedSecrets": self.encrypted_secrets,
            "authHeaders": self.auth_headers,
        }
        if self.auth_base:
            body["authBase"] = self.auth_base
        if self.auth_query:
            body["authQuery"] = self.auth_query
        if self.auth_aws_sigv4:
            body["authAwsSigv4"] = self.auth_aws_sigv4
        if self.secret_connector_map:
            body["secretConnectorMap"] = self.secret_connector_map
        if self.secret_connector_metadata_map:
            body["secretConnectorMetadataMap"] = self.secret_connector_metadata_map
        if self.vars_map:
            body["vars"] = self.vars_map
        if self.firewall_billable:
            body["firewallBillable"] = True
        if force_refresh:
            body["forceRefresh"] = True
        return body


@dataclass(frozen=True)
class FirewallAuthPayload:
    """Cacheable /firewall/auth data applied to outbound requests."""

    headers: dict[str, str]
    resolved_secrets: list[str] = field(default_factory=list)
    base: str | None = None
    query: dict[str, str] | None = None
    aws_sigv4: AwsSigV4Credentials | None = None


@dataclass(frozen=True)
class FirewallAuthSuccess:
    """Validated /firewall/auth success response consumed by the auth cache."""

    payload: FirewallAuthPayload
    expires_at: int | float | None = None
    refreshed_connectors: list[str] = field(default_factory=list)
    refreshed_secrets: list[str] = field(default_factory=list)


def _read_firewall_auth_response_body(resp: _ResponseBodyReader) -> bytes:
    body = resp.read(MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES + 1)
    if len(body) > MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES:
        raise FirewallAuthResponseTooLargeError("Firewall auth response body too large")
    return body


def _firewall_auth_api_error_from_envelope(
    status: int,
    error_info: dict,
) -> FirewallAuthApiError | None:
    code = error_info.get("code")
    message = error_info.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    if code not in _STRUCTURED_FIREWALL_AUTH_ERROR_CODES:
        return None
    connectors = error_info.get("connectors")
    if isinstance(connectors, list) and all(isinstance(item, str) for item in connectors):
        parsed_connectors = connectors
    else:
        parsed_connectors = None
    failure_reason = error_info.get("failureReason")
    parsed_failure_reason = (
        failure_reason
        if isinstance(failure_reason, str) and failure_reason in _FIREWALL_AUTH_FAILURE_REASONS
        else None
    )
    return FirewallAuthApiError(
        status=status,
        code=code,
        message=message,
        connectors=parsed_connectors,
        failure_reason=parsed_failure_reason,
    )


_MALFORMED_FIREWALL_AUTH_SUCCESS = "Firewall auth endpoint returned malformed success response"


def _malformed_firewall_auth_success(message: str) -> ValueError:
    return ValueError(f"{_MALFORMED_FIREWALL_AUTH_SUCCESS}: {message}")


def _parse_string_map(value: object, field_name: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success(f"{field_name} must be an object")

    parsed: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise _malformed_firewall_auth_success(f"{field_name} keys must be strings")
        if not isinstance(item, str):
            raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
        parsed[key] = item
    return parsed


def _parse_optional_string_map(
    decoded: dict[object, object], field_name: str
) -> dict[str, str] | None:
    value = decoded.get(field_name)
    if value is None:
        return None
    return _parse_string_map(value, field_name)


def _parse_optional_string(decoded: dict[object, object], field_name: str) -> str | None:
    value = decoded.get(field_name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _malformed_firewall_auth_success(f"{field_name} must be a string")
    if value == "":
        raise _malformed_firewall_auth_success(f"{field_name} must not be empty")
    return value


def _parse_required_string_list(decoded: dict[object, object], field_name: str) -> list[str]:
    if field_name not in decoded:
        raise _malformed_firewall_auth_success(f"{field_name} is required")
    value = decoded[field_name]
    if not isinstance(value, list):
        raise _malformed_firewall_auth_success(f"{field_name} must be an array")
    if not all(isinstance(item, str) for item in value):
        raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
    return list(value)


def _parse_expires_at(decoded: dict[object, object]) -> int | float | None:
    if "expiresAt" not in decoded:
        raise _malformed_firewall_auth_success("expiresAt is required")
    value = decoded["expiresAt"]
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or (isinstance(value, float) and not math.isfinite(value))
    ):
        raise _malformed_firewall_auth_success("expiresAt must be a finite number or null")
    return value


def _parse_optional_aws_sigv4_credentials(
    decoded: dict[object, object],
) -> AwsSigV4Credentials | None:
    if "awsSigv4" not in decoded:
        return None
    value = decoded["awsSigv4"]
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success("awsSigv4 must be an object")
    access_key_id = value.get("accessKeyId")
    secret_access_key = value.get("secretAccessKey")
    if not isinstance(access_key_id, str) or not access_key_id:
        raise _malformed_firewall_auth_success("awsSigv4.accessKeyId is required")
    if not isinstance(secret_access_key, str) or not secret_access_key:
        raise _malformed_firewall_auth_success("awsSigv4.secretAccessKey is required")
    if "sessionToken" in value and value["sessionToken"] is None:
        raise _malformed_firewall_auth_success("sessionToken must be a string")
    return AwsSigV4Credentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=_parse_optional_string(value, "sessionToken"),
    )


def _parse_firewall_auth_success(
    decoded: object,
    request: FirewallAuthRequest,
) -> FirewallAuthSuccess:
    if not isinstance(decoded, dict):
        raise _malformed_firewall_auth_success("response must be an object")

    decoded_map: dict[object, object] = decoded
    if "headers" not in decoded_map:
        raise _malformed_firewall_auth_success("headers is required")

    headers = _parse_string_map(decoded_map["headers"], "headers")
    expires_at = _parse_expires_at(decoded_map)
    resolved_secrets = _parse_required_string_list(decoded_map, "resolvedSecrets")
    refreshed_connectors = _parse_required_string_list(decoded_map, "refreshedConnectors")
    refreshed_secrets = _parse_required_string_list(decoded_map, "refreshedSecrets")
    base = _parse_optional_string(decoded_map, "base")
    query = _parse_optional_string_map(decoded_map, "query")
    aws_sigv4 = _parse_optional_aws_sigv4_credentials(decoded_map)

    if set(headers) != set(request.auth_headers):
        raise _malformed_firewall_auth_success(
            "headers must match the configured auth header names"
        )
    if set(query or {}) != set(request.auth_query or {}):
        raise _malformed_firewall_auth_success("query must match the configured auth query names")
    if (base is not None) != (request.auth_base is not None):
        raise _malformed_firewall_auth_success("base presence must match the configured auth base")
    if (aws_sigv4 is not None) != (request.auth_aws_sigv4 is not None):
        raise _malformed_firewall_auth_success(
            "awsSigv4 presence must match the configured auth mode"
        )
    request_session_token_present = (
        request.auth_aws_sigv4 is not None
        and request.auth_aws_sigv4.get("sessionToken") is not None
    )
    response_session_token_present = aws_sigv4 is not None and aws_sigv4.session_token is not None
    if response_session_token_present != request_session_token_present:
        raise _malformed_firewall_auth_success(
            "awsSigv4.sessionToken presence must match the configured auth mode"
        )

    payload = FirewallAuthPayload(
        headers=headers,
        resolved_secrets=resolved_secrets,
        base=base,
        query=query,
        aws_sigv4=aws_sigv4,
    )
    return FirewallAuthSuccess(
        payload=payload,
        expires_at=expires_at,
        refreshed_connectors=refreshed_connectors,
        refreshed_secrets=refreshed_secrets,
    )


def _fetch_firewall_headers_sync(
    request: FirewallAuthRequest,
    api_url: str,
    *,
    force_refresh: bool = False,
) -> FirewallAuthSuccess:
    """Synchronous helper — runs in a thread to avoid blocking the event loop.

    api_url is resolved by the async caller (fetch_firewall_headers) while
    still on the event loop, so this function never touches ctx.options.
    """
    url = f"{api_url}/api/webhooks/agent/firewall/auth"
    data = json.dumps(request.to_body(force_refresh=force_refresh)).encode()
    req = platform_api.make_api_request(url, data, request.sandbox_token)
    try:
        # nosemgrep: dynamic-urllib-use-detected
        with _opener.open(req, timeout=10) as resp:
            decoded: object = json.loads(_read_firewall_auth_response_body(resp))
            return _parse_firewall_auth_success(decoded, request)
    except urllib.error.HTTPError as e:
        # HTTPError wraps an open socket; `with e` closes on every exit
        # path to avoid FD exhaustion under sustained cache-miss load (#10475).
        with e:
            try:
                error_body = json.loads(_read_firewall_auth_response_body(e))
            except (UnicodeDecodeError, json.JSONDecodeError, OSError):
                raise e from None
            if not isinstance(error_body, dict):
                raise e from None
            error_info = error_body.get("error")
            if not isinstance(error_info, dict):
                raise e from None
            error_message = error_info.get("message")
            if error_info.get("code") == "CONNECTOR_NOT_CONFIGURED":
                raise ConnectorNotConfiguredError(
                    error_message if isinstance(error_message, str) else "Connector not configured",
                ) from None
            if error_info.get("code") == "INSUFFICIENT_CREDITS":
                raise InsufficientCreditsError(
                    error_message if isinstance(error_message, str) else "Insufficient credits",
                ) from None
            api_error = _firewall_auth_api_error_from_envelope(e.code, error_info)
            if api_error is None:
                raise e from None
            raise api_error from None


async def fetch_firewall_headers(
    request: FirewallAuthRequest,
    *,
    force_refresh: bool = False,
) -> FirewallAuthSuccess:
    """Resolve auth headers via server-side decryption.

    request.encrypted_secrets is the encrypted runtime secret namespace. After API-side
    decryption, keys are the `NAME` in `${{ secrets.NAME }}` and values are the
    real secret values.

    request.secret_connector_map maps firewall auth secret env aliases (the
    `NAME` in `${{ secrets.NAME }}`) to the connector or provider owner that
    can refresh/resolve access. request.secret_connector_metadata_map uses the
    same keys to add source details when the owner alone is not enough to
    locate access storage.

    When request.secret_connector_map is provided, the auth endpoint can refresh
    expired access tokens and returns an expiresAt timestamp for TTL caching.
    For billable firewall auth, expiresAt is also bounded by the server-side
    credit authorization lease.

    When force_refresh is True, the endpoint refreshes access tokens regardless
    of DB tokenExpiresAt — used after the upstream returns 401 (#9860).

    Uses asyncio.to_thread to avoid blocking mitmproxy's event loop.
    """
    api_url = platform_api.get_api_url()
    return await asyncio.to_thread(
        _fetch_firewall_headers_sync,
        request,
        api_url,
        force_refresh=force_refresh,
    )
