"""Client and response parsing for the runner firewall auth endpoint."""

import asyncio
import json
import urllib.error
import urllib.request
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
    expires_at: object = None
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


def _parse_optional_string_list(decoded: dict[object, object], field_name: str) -> list[str]:
    value = decoded.get(field_name)
    if value is None:
        return []
    if not isinstance(value, list):
        raise _malformed_firewall_auth_success(f"{field_name} must be an array")
    if not all(isinstance(item, str) for item in value):
        raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
    return list(value)


def _parse_optional_aws_sigv4_credentials(
    decoded: dict[object, object],
) -> AwsSigV4Credentials | None:
    value = decoded.get("awsSigv4")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success("awsSigv4 must be an object")
    access_key_id = value.get("accessKeyId")
    secret_access_key = value.get("secretAccessKey")
    if not isinstance(access_key_id, str) or not access_key_id:
        raise _malformed_firewall_auth_success("awsSigv4.accessKeyId is required")
    if not isinstance(secret_access_key, str) or not secret_access_key:
        raise _malformed_firewall_auth_success("awsSigv4.secretAccessKey is required")
    return AwsSigV4Credentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=_parse_optional_string(value, "sessionToken"),
    )


def _parse_firewall_auth_success(decoded: object) -> FirewallAuthSuccess:
    if not isinstance(decoded, dict):
        raise _malformed_firewall_auth_success("response must be an object")

    decoded_map: dict[object, object] = decoded
    if "headers" not in decoded_map:
        raise _malformed_firewall_auth_success("headers is required")

    base = decoded_map.get("base")
    if base is not None and not isinstance(base, str):
        raise _malformed_firewall_auth_success("base must be a string")

    headers = _parse_string_map(decoded_map["headers"], "headers")
    resolved_secrets = _parse_optional_string_list(decoded_map, "resolvedSecrets")
    refreshed_connectors = _parse_optional_string_list(decoded_map, "refreshedConnectors")
    refreshed_secrets = _parse_optional_string_list(decoded_map, "refreshedSecrets")
    query = _parse_optional_string_map(decoded_map, "query")
    aws_sigv4 = _parse_optional_aws_sigv4_credentials(decoded_map)
    payload = FirewallAuthPayload(
        headers=headers,
        resolved_secrets=resolved_secrets,
        base=base,
        query=query,
        aws_sigv4=aws_sigv4,
    )
    return FirewallAuthSuccess(
        payload=payload,
        expires_at=decoded_map.get("expiresAt"),
        refreshed_connectors=refreshed_connectors,
        refreshed_secrets=refreshed_secrets,
    )


def _fetch_firewall_headers_sync(
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    api_url: str,
    *,
    secret_connector_map: dict | None = None,
    secret_connector_metadata_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    auth_aws_sigv4: dict | None = None,
    firewall_billable: bool = False,
    force_refresh: bool = False,
) -> FirewallAuthSuccess:
    """Synchronous helper — runs in a thread to avoid blocking the event loop.

    api_url is resolved by the async caller (fetch_firewall_headers) while
    still on the event loop, so this function never touches ctx.options.
    """
    url = f"{api_url}/api/webhooks/agent/firewall/auth"
    body: dict = {"encryptedSecrets": encrypted_secrets, "authHeaders": auth_headers}
    if auth_base:
        body["authBase"] = auth_base
    if auth_query:
        body["authQuery"] = auth_query
    if auth_aws_sigv4:
        body["authAwsSigv4"] = auth_aws_sigv4
    if secret_connector_map:
        body["secretConnectorMap"] = secret_connector_map
    if secret_connector_metadata_map:
        body["secretConnectorMetadataMap"] = secret_connector_metadata_map
    if vars_map:
        body["vars"] = vars_map
    if firewall_billable:
        body["firewallBillable"] = True
    if force_refresh:
        body["forceRefresh"] = True
    data = json.dumps(body).encode()
    req = platform_api.make_api_request(url, data, sandbox_token)
    try:
        # nosemgrep: dynamic-urllib-use-detected
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            decoded: object = json.loads(_read_firewall_auth_response_body(resp))
            return _parse_firewall_auth_success(decoded)
    except urllib.error.HTTPError as e:
        # HTTPError wraps an open socket; `with e` closes on every exit
        # path to avoid FD exhaustion under sustained cache-miss load (#10475).
        with e:
            try:
                error_body = json.loads(_read_firewall_auth_response_body(e))
            except (json.JSONDecodeError, OSError):
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
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    *,
    secret_connector_map: dict | None = None,
    secret_connector_metadata_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    auth_aws_sigv4: dict | None = None,
    firewall_billable: bool = False,
    force_refresh: bool = False,
) -> FirewallAuthSuccess:
    """Resolve auth headers via server-side decryption.

    encrypted_secrets is the encrypted runtime secret namespace. After API-side
    decryption, keys are the `NAME` in `${{ secrets.NAME }}` and values are the
    real secret values.

    secret_connector_map maps firewall auth secret env aliases (the `NAME` in
    `${{ secrets.NAME }}`) to the connector or provider owner that can
    refresh/resolve access. secret_connector_metadata_map uses the same keys to
    add source details when the owner alone is not enough to locate access
    storage.

    When secret_connector_map is provided, the auth endpoint can refresh
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
        encrypted_secrets,
        auth_headers,
        sandbox_token,
        api_url,
        secret_connector_map=secret_connector_map,
        secret_connector_metadata_map=secret_connector_metadata_map,
        vars_map=vars_map,
        auth_base=auth_base,
        auth_query=auth_query,
        auth_aws_sigv4=auth_aws_sigv4,
        firewall_billable=firewall_billable,
        force_refresh=force_refresh,
    )
