"""AWS SigV4 request re-signing for connector firewall auth."""

from __future__ import annotations

import hashlib
import hmac
import re
import urllib.parse
from dataclasses import dataclass
from enum import Enum

_AWS4_REQUEST = "aws4_request"
_HMAC_ALGORITHM = "AWS4-HMAC-SHA256"
_ASYMMETRIC_ALGORITHM = "AWS4-ECDSA-P256-SHA256"
_S3_SIGNING_NAMES = frozenset(("s3", "s3-outposts", "s3-object-lambda"))
_UNSUPPORTED_S3_EXPRESS_SIGNING_NAME = "s3express"
_STREAMING_PAYLOAD_PREFIX = "STREAMING-"
_CREDENTIAL_SCOPE_PARTS = 5
_AUTH_HEADER_PARAM_NAMES = frozenset(("Credential", "SignedHeaders", "Signature"))
_QUERY_SIGNING_PARAM_NAMES = frozenset(
    (
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Security-Token",
        "X-Amz-Signature",
    )
)
_SCOPE_DATE_RE = re.compile(r"^\d{8}$")
_SCOPE_REGION_RE = re.compile(r"^(?:[A-Za-z0-9._-]+|\*)$")
_SCOPE_SERVICE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_AMZ_DATE_RE = re.compile(r"^\d{8}T\d{6}Z$")
_PRESIGN_EXPIRES_RE = re.compile(r"^[1-9]\d*$")
_ACCESS_KEY_ID_RE = re.compile(r"^[A-Za-z0-9]+$")
_SIGNED_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_ASCII_CONTROL_MAX = 0x1F
_ASCII_DELETE = 0x7F
_DEFAULT_PORTS = {"http": 80, "https": 443}


class AwsSigV4SigningError(Exception):
    """Raised when a request cannot be safely re-signed."""


class _AuthLocation(Enum):
    HEADER = "header"
    QUERY = "query"


@dataclass(frozen=True)
class AwsSigV4Credentials:
    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


@dataclass(frozen=True)
class _CredentialScope:
    date: str
    region: str
    service: str


@dataclass(frozen=True)
class _SigningContext:
    location: _AuthLocation
    algorithm: str
    source_access_key_id: str
    scope: _CredentialScope
    signed_headers: frozenset[str]
    amz_date: str
    expires: str | None = None


def sign_request(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
) -> tuple[str, list[tuple[str, str]]]:
    """Return a URL/header pair re-signed with real AWS credentials."""
    _validate_credentials(credentials)
    context = _classify_request(url, headers)
    if context.algorithm == _ASYMMETRIC_ALGORITHM:
        raise AwsSigV4SigningError("SigV4A is not supported by this runner")
    if context.algorithm != _HMAC_ALGORITHM:
        raise AwsSigV4SigningError("Unsupported AWS signing algorithm")
    if context.source_access_key_id == credentials.access_key_id:
        raise AwsSigV4SigningError("AWS request must use a placeholder access key ID")
    if context.scope.region == "*":
        raise AwsSigV4SigningError("Wildcard AWS signing region requires SigV4A")
    if context.scope.service == _UNSUPPORTED_S3_EXPRESS_SIGNING_NAME:
        raise AwsSigV4SigningError("S3 Express signing is not supported by this runner")

    is_s3 = context.scope.service in _S3_SIGNING_NAMES
    if context.location is _AuthLocation.QUERY:
        return _sign_query_request(
            method=method,
            url=url,
            headers=headers,
            body=body,
            credentials=credentials,
            context=context,
            is_s3=is_s3,
        )
    return _sign_header_request(
        method=method,
        url=url,
        headers=headers,
        body=body,
        credentials=credentials,
        context=context,
        is_s3=is_s3,
    )


def _classify_request(
    url: str,
    headers: list[tuple[str, str]],
) -> _SigningContext:
    auth_header = _unique_header_value(
        headers,
        "authorization",
        "Malformed AWS authorization header",
    )
    query_pairs = _parse_query_pairs(urllib.parse.urlsplit(url).query)
    query_algorithm = _unique_query_value(query_pairs, "X-Amz-Algorithm")
    if auth_header and query_algorithm:
        raise AwsSigV4SigningError("Ambiguous AWS auth location")
    if query_algorithm:
        return _classify_query_request(query_pairs, query_algorithm)
    if auth_header:
        return _classify_header_request(auth_header, headers)
    raise AwsSigV4SigningError("Missing AWS SigV4 auth metadata")


def _classify_header_request(
    auth_header: str,
    headers: list[tuple[str, str]],
) -> _SigningContext:
    algorithm, params = _parse_authorization_header(auth_header)
    credential = params.get("Credential")
    signed_headers = params.get("SignedHeaders")
    signature = params.get("Signature")
    if not credential or not signed_headers or not signature:
        raise AwsSigV4SigningError("Malformed AWS authorization header")
    source_access_key_id, scope = _parse_credential(credential)
    amz_date = _unique_header_value(
        headers,
        "x-amz-date",
        "AWS SigV4 header auth requires a single x-amz-date",
    )
    if not amz_date:
        raise AwsSigV4SigningError("AWS SigV4 header auth requires x-amz-date")
    _validate_amz_date(amz_date, scope)
    return _SigningContext(
        location=_AuthLocation.HEADER,
        algorithm=algorithm,
        source_access_key_id=source_access_key_id,
        scope=scope,
        signed_headers=_parse_signed_headers(signed_headers),
        amz_date=amz_date,
    )


def _classify_query_request(
    query_pairs: list[tuple[str, str]],
    algorithm: str,
) -> _SigningContext:
    credential = _unique_query_value(query_pairs, "X-Amz-Credential")
    signed_headers = _unique_query_value(query_pairs, "X-Amz-SignedHeaders")
    amz_date = _unique_query_value(query_pairs, "X-Amz-Date")
    expires = _unique_query_value(query_pairs, "X-Amz-Expires")
    signature = _unique_query_value(query_pairs, "X-Amz-Signature")
    if not credential or not signed_headers or not amz_date or not expires or not signature:
        raise AwsSigV4SigningError("Malformed AWS presigned query")
    source_access_key_id, scope = _parse_credential(credential)
    _validate_amz_date(amz_date, scope)
    if not _PRESIGN_EXPIRES_RE.fullmatch(expires):
        raise AwsSigV4SigningError("Malformed AWS presigned query expiry")
    return _SigningContext(
        location=_AuthLocation.QUERY,
        algorithm=algorithm,
        source_access_key_id=source_access_key_id,
        scope=scope,
        signed_headers=_parse_signed_headers(signed_headers),
        amz_date=amz_date,
        expires=expires,
    )


def _parse_authorization_header(value: str) -> tuple[str, dict[str, str]]:
    algorithm, sep, remainder = value.partition(" ")
    if not sep or not algorithm or not remainder.strip():
        raise AwsSigV4SigningError("Malformed AWS authorization header")
    params: dict[str, str] = {}
    for raw_param in remainder.split(","):
        key, param_sep, raw_param_value = raw_param.strip().partition("=")
        param_value = raw_param_value.strip()
        if not param_sep or key not in _AUTH_HEADER_PARAM_NAMES or not param_value or key in params:
            raise AwsSigV4SigningError("Malformed AWS authorization header")
        params[key] = param_value
    return algorithm, params


def _parse_credential(credential: str) -> tuple[str, _CredentialScope]:
    parts = urllib.parse.unquote(credential).split("/")
    if len(parts) != _CREDENTIAL_SCOPE_PARTS or parts[-1] != _AWS4_REQUEST:
        raise AwsSigV4SigningError("Malformed AWS credential scope")
    access_key_id = parts[0]
    date = parts[1]
    region = parts[2]
    service = parts[3]
    if not access_key_id or not date or not region or not service:
        raise AwsSigV4SigningError("Incomplete AWS credential scope")
    if (
        not _ACCESS_KEY_ID_RE.fullmatch(access_key_id)
        or _has_ascii_control(access_key_id)
        or not _SCOPE_DATE_RE.fullmatch(date)
        or not _SCOPE_REGION_RE.fullmatch(region)
        or not _SCOPE_SERVICE_RE.fullmatch(service)
    ):
        raise AwsSigV4SigningError("Malformed AWS credential scope")
    return access_key_id, _CredentialScope(date=date, region=region, service=service)


def _parse_signed_headers(value: str) -> frozenset[str]:
    parts = [part.strip().lower() for part in value.split(";")]
    if (
        not parts
        or any(not part or not _SIGNED_HEADER_NAME_RE.fullmatch(part) for part in parts)
        or len(parts) != len(set(parts))
    ):
        raise AwsSigV4SigningError("Malformed AWS signed headers")
    headers = frozenset(parts)
    if "host" not in headers:
        raise AwsSigV4SigningError("AWS signed headers must include host")
    return headers


def _validate_amz_date(amz_date: str, scope: _CredentialScope) -> None:
    if not _AMZ_DATE_RE.fullmatch(amz_date):
        raise AwsSigV4SigningError("Malformed AWS signing date")
    if not amz_date.startswith(scope.date):
        raise AwsSigV4SigningError("AWS signing date does not match credential scope")


def _sign_header_request(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
    context: _SigningContext,
    is_s3: bool,
) -> tuple[str, list[tuple[str, str]]]:
    payload_hash = _payload_hash(headers, body)
    clean_headers = _without_headers(headers, {"authorization", "x-amz-security-token"})
    clean_headers = _upsert_header(clean_headers, "host", _host_header_value(url))
    clean_headers = _upsert_header(clean_headers, "x-amz-date", context.amz_date)
    if credentials.session_token:
        clean_headers = _upsert_header(
            clean_headers,
            "x-amz-security-token",
            credentials.session_token,
        )

    signed_headers = set(context.signed_headers)
    signed_headers.add("host")
    signed_headers.add("x-amz-date")
    if credentials.session_token:
        signed_headers.add("x-amz-security-token")
    for name, _value in clean_headers:
        lower_name = name.lower()
        if lower_name.startswith("x-amz-"):
            signed_headers.add(lower_name)

    canonical_request, signed_header_names = _canonical_request(
        method=method,
        url=url,
        headers=clean_headers,
        signed_headers=frozenset(signed_headers),
        payload_hash=payload_hash,
        is_s3=is_s3,
    )
    signature = _signature(
        canonical_request=canonical_request,
        credentials=credentials,
        scope=context.scope,
        amz_date=context.amz_date,
    )
    authorization = (
        f"{_HMAC_ALGORITHM} "
        f"Credential={credentials.access_key_id}/{_scope_string(context.scope)}, "
        f"SignedHeaders={signed_header_names}, "
        f"Signature={signature}"
    )
    return url, _upsert_header(clean_headers, "authorization", authorization)


def _sign_query_request(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
    context: _SigningContext,
    is_s3: bool,
) -> tuple[str, list[tuple[str, str]]]:
    clean_headers = _without_headers(headers, {"authorization", "x-amz-security-token"})
    clean_headers = _upsert_header(clean_headers, "host", _host_header_value(url))
    signed_headers = frozenset(set(context.signed_headers) | {"host"})
    payload_hash = _query_payload_hash(headers, body, is_s3)
    unsigned_url = _replace_query_signing_params(
        url,
        credentials=credentials,
        context=context,
        signed_headers=signed_headers,
        signature=None,
    )
    canonical_request, signed_header_names = _canonical_request(
        method=method,
        url=unsigned_url,
        headers=clean_headers,
        signed_headers=signed_headers,
        payload_hash=payload_hash,
        is_s3=is_s3,
    )
    signature = _signature(
        canonical_request=canonical_request,
        credentials=credentials,
        scope=context.scope,
        amz_date=context.amz_date,
    )
    signed_url = _replace_query_signing_params(
        url,
        credentials=credentials,
        context=context,
        signed_headers=frozenset(signed_header_names.split(";")),
        signature=signature,
    )
    return signed_url, clean_headers


def _canonical_request(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    signed_headers: frozenset[str],
    payload_hash: str,
    is_s3: bool,
) -> tuple[str, str]:
    parts = urllib.parse.urlsplit(url)
    canonical_uri = _canonical_uri(parts.path, is_s3=is_s3)
    canonical_query = _canonical_query_string(parts.query)
    canonical_headers, signed_header_names = _canonical_headers(headers, signed_headers)
    request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_header_names,
            payload_hash,
        ]
    )
    return request, signed_header_names


def _canonical_uri(path: str, *, is_s3: bool) -> str:
    raw_path = path or "/"
    if is_s3:
        return raw_path
    normalized = _remove_dot_segments(raw_path)
    return urllib.parse.quote(normalized, safe="/~")


def _remove_dot_segments(path: str) -> str:
    if not path:
        return "/"

    output: list[str] = []
    for segment in path.split("/"):
        if not segment or segment == ".":
            continue
        if segment == "..":
            if output:
                output.pop()
            continue
        output.append(segment)

    leading_slash = "/" if path.startswith("/") else ""
    trailing_slash = "/" if path.endswith("/") and output else ""
    return f"{leading_slash}{'/'.join(output)}{trailing_slash}"


def _canonical_query_string(query: str) -> str:
    pairs = _parse_query_pairs(query)
    encoded = [(_aws_quote(key), _aws_quote(value)) for key, value in pairs]
    encoded.sort()
    return "&".join(f"{key}={value}" for key, value in encoded)


def _canonical_headers(
    headers: list[tuple[str, str]],
    signed_headers: frozenset[str],
) -> tuple[str, str]:
    values: dict[str, list[str]] = {}
    for name, value in headers:
        lower_name = name.lower()
        if lower_name in signed_headers:
            values.setdefault(lower_name, []).append(_normalize_header_value(value))

    missing = signed_headers.difference(values)
    if missing:
        raise AwsSigV4SigningError("AWS signed header is missing")

    signed_header_names = ";".join(sorted(signed_headers))
    canonical = "".join(f"{name}:{','.join(values[name])}\n" for name in sorted(signed_headers))
    return canonical, signed_header_names


def _normalize_header_value(value: str) -> str:
    return " ".join(value.strip().split())


def _payload_hash(headers: list[tuple[str, str]], body: bytes | None) -> str:
    header_value = _unique_header_value(
        headers,
        "x-amz-content-sha256",
        "AWS content hash header is ambiguous",
    )
    if header_value:
        if header_value.startswith(_STREAMING_PAYLOAD_PREFIX):
            raise AwsSigV4SigningError("AWS streaming payload signing is not supported")
        return header_value
    return hashlib.sha256(body or b"").hexdigest()


def _query_payload_hash(headers: list[tuple[str, str]], body: bytes | None, is_s3: bool) -> str:
    header_value = _unique_header_value(
        headers,
        "x-amz-content-sha256",
        "AWS content hash header is ambiguous",
    )
    if header_value:
        if header_value.startswith(_STREAMING_PAYLOAD_PREFIX):
            raise AwsSigV4SigningError("AWS streaming payload signing is not supported")
        return header_value
    if is_s3:
        return "UNSIGNED-PAYLOAD"
    return hashlib.sha256(body or b"").hexdigest()


def _signature(
    *,
    canonical_request: str,
    credentials: AwsSigV4Credentials,
    scope: _CredentialScope,
    amz_date: str,
) -> str:
    string_to_sign = "\n".join(
        [
            _HMAC_ALGORITHM,
            amz_date,
            _scope_string(scope),
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signing_key = _signing_key(credentials.secret_access_key, scope)
    return hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()


def _signing_key(secret_access_key: str, scope: _CredentialScope) -> bytes:
    date_key = _hmac_digest(f"AWS4{secret_access_key}".encode(), scope.date)
    region_key = _hmac_digest(date_key, scope.region)
    service_key = _hmac_digest(region_key, scope.service)
    return _hmac_digest(service_key, _AWS4_REQUEST)


def _hmac_digest(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


def _scope_string(scope: _CredentialScope) -> str:
    return f"{scope.date}/{scope.region}/{scope.service}/{_AWS4_REQUEST}"


def _replace_query_signing_params(
    url: str,
    *,
    credentials: AwsSigV4Credentials,
    context: _SigningContext,
    signed_headers: frozenset[str],
    signature: str | None,
) -> str:
    parts = urllib.parse.urlsplit(url)
    filtered = [
        (key, value)
        for key, value in _parse_query_pairs(parts.query)
        if key not in _QUERY_SIGNING_PARAM_NAMES
    ]
    filtered.extend(
        [
            ("X-Amz-Algorithm", _HMAC_ALGORITHM),
            (
                "X-Amz-Credential",
                f"{credentials.access_key_id}/{_scope_string(context.scope)}",
            ),
            ("X-Amz-Date", context.amz_date),
            ("X-Amz-Expires", context.expires or "3600"),
            ("X-Amz-SignedHeaders", ";".join(sorted(signed_headers))),
        ]
    )
    if credentials.session_token:
        filtered.append(("X-Amz-Security-Token", credentials.session_token))
    if signature:
        filtered.append(("X-Amz-Signature", signature))
    query = _encode_query_pairs(filtered)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def _encode_query_pairs(pairs: list[tuple[str, str]]) -> str:
    return "&".join(f"{_aws_quote(key)}={_aws_quote(value)}" for key, value in pairs)


def _aws_quote(value: str) -> str:
    return urllib.parse.quote(value, safe="-_.~")


def _parse_query_pairs(query: str) -> list[tuple[str, str]]:
    if not query:
        return []

    pairs: list[tuple[str, str]] = []
    for raw_pair in query.split("&"):
        if not raw_pair:
            continue
        raw_key, _separator, raw_value = raw_pair.partition("=")
        pairs.append((urllib.parse.unquote(raw_key), urllib.parse.unquote(raw_value)))
    return pairs


def _validate_credentials(credentials: AwsSigV4Credentials) -> None:
    if not _ACCESS_KEY_ID_RE.fullmatch(credentials.access_key_id):
        raise AwsSigV4SigningError("Invalid AWS access key ID")
    if not credentials.secret_access_key or _has_ascii_control(credentials.secret_access_key):
        raise AwsSigV4SigningError("Invalid AWS secret access key")
    if credentials.session_token is not None and (
        not credentials.session_token or _has_ascii_control(credentials.session_token)
    ):
        raise AwsSigV4SigningError("Invalid AWS session token")


def _has_ascii_control(value: str) -> bool:
    return any(ord(char) <= _ASCII_CONTROL_MAX or ord(char) == _ASCII_DELETE for char in value)


def _unique_header_value(
    headers: list[tuple[str, str]],
    name: str,
    duplicate_message: str,
) -> str | None:
    lower_name = name.lower()
    result: str | None = None
    found = False
    for header_name, value in headers:
        if header_name.lower() == lower_name:
            if found:
                raise AwsSigV4SigningError(duplicate_message)
            found = True
            result = value
    return result


def _unique_query_value(pairs: list[tuple[str, str]], name: str) -> str | None:
    result: str | None = None
    found = False
    for key, value in pairs:
        if key == name:
            if found:
                raise AwsSigV4SigningError("Malformed AWS presigned query")
            found = True
            result = value
    return result


def _without_headers(
    headers: list[tuple[str, str]],
    names: set[str],
) -> list[tuple[str, str]]:
    return [(name, value) for name, value in headers if name.lower() not in names]


def _upsert_header(
    headers: list[tuple[str, str]],
    name: str,
    value: str,
) -> list[tuple[str, str]]:
    lower_name = name.lower()
    filtered = [
        (header_name, item) for header_name, item in headers if header_name.lower() != lower_name
    ]
    filtered.append((name, value))
    return filtered


def _host_header_value(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if not parts.netloc or not parts.hostname:
        raise AwsSigV4SigningError("AWS request URL must include a host")
    host = parts.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL has an invalid port") from e
    if port is not None and port != _DEFAULT_PORTS.get(parts.scheme.lower()):
        host = f"{host}:{port}"
    return host
