"""Shared AWS SigV4 fixture builders for mitm-addon tests."""

import urllib.parse

from aws_sigv4 import AwsSigV4Credentials

AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256"
DEFAULT_SIGV4_DATE = "20260101"
DEFAULT_SIGV4_TIMESTAMP = "20260101T000000Z"
DEFAULT_AWS_REGION = "us-east-1"
DEFAULT_AWS_SERVICE = "sts"
PLACEHOLDER_ACCESS_KEY_ID = "PLACEHOLDER"
PLACEHOLDER_SIGNATURE = "placeholder"
REAL_AWS_ACCESS_KEY_ID = "AKIDEXAMPLE"
REAL_AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
REAL_AWS_SESSION_TOKEN = "real-session-token"
SIGNER_TEST_SECRET_ACCESS_KEY = "secret"
STS_HOST = "sts.amazonaws.com"
STS_FORM_BODY = b"Action=GetCallerIdentity&Version=2011-06-15"
STS_QUERY = "Action=GetCallerIdentity&Version=2011-06-15"


def aws_credential_scope(
    *,
    access_key_id: str = PLACEHOLDER_ACCESS_KEY_ID,
    date: str = DEFAULT_SIGV4_DATE,
    region: str = DEFAULT_AWS_REGION,
    service: str = DEFAULT_AWS_SERVICE,
) -> str:
    return f"{access_key_id}/{date}/{region}/{service}/aws4_request"


def quote_sigv4_value(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def aws_sigv4_authorization(
    *,
    access_key_id: str = PLACEHOLDER_ACCESS_KEY_ID,
    date: str = DEFAULT_SIGV4_DATE,
    region: str = DEFAULT_AWS_REGION,
    service: str = DEFAULT_AWS_SERVICE,
    credential_scope: str | None = None,
    signed_headers: str = "host;x-amz-date",
    signature: str = PLACEHOLDER_SIGNATURE,
    algorithm: str = AWS_SIGV4_ALGORITHM,
) -> str:
    scope = (
        aws_credential_scope(
            access_key_id=access_key_id,
            date=date,
            region=region,
            service=service,
        )
        if credential_scope is None
        else credential_scope
    )
    return f"{algorithm} Credential={scope}, SignedHeaders={signed_headers}, Signature={signature}"


def aws_sigv4_header_auth_headers(
    *,
    host: str = STS_HOST,
    authorization: str | None = None,
    content_type: str | None = None,
    amz_date: str | None = DEFAULT_SIGV4_TIMESTAMP,
    extra_headers: tuple[tuple[str, str], ...] = (),
) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = [("Host", host)]
    if content_type is not None:
        pairs.append(("Content-Type", content_type))
    if amz_date is not None:
        pairs.append(("X-Amz-Date", amz_date))
    pairs.extend(extra_headers)
    pairs.append(
        (
            "Authorization",
            aws_sigv4_authorization() if authorization is None else authorization,
        )
    )
    return pairs


def aws_sigv4_presigned_query_path(
    *,
    credential_scope: str | None = None,
    access_key_id: str = PLACEHOLDER_ACCESS_KEY_ID,
    date: str = DEFAULT_SIGV4_DATE,
    region: str = DEFAULT_AWS_REGION,
    service: str = DEFAULT_AWS_SERVICE,
    timestamp: str = DEFAULT_SIGV4_TIMESTAMP,
    expires: str = "60",
    signed_headers: str = "host",
    signature: str | None = PLACEHOLDER_SIGNATURE,
    leading_query: str = STS_QUERY,
) -> str:
    scope = (
        aws_credential_scope(
            access_key_id=access_key_id,
            date=date,
            region=region,
            service=service,
        )
        if credential_scope is None
        else credential_scope
    )
    query = (
        f"{leading_query}"
        f"&X-Amz-Algorithm={AWS_SIGV4_ALGORITHM}"
        f"&X-Amz-Credential={quote_sigv4_value(scope)}"
        f"&X-Amz-Date={timestamp}"
        f"&X-Amz-Expires={expires}"
        f"&X-Amz-SignedHeaders={quote_sigv4_value(signed_headers)}"
    )
    if signature is not None:
        query = f"{query}&X-Amz-Signature={signature}"
    return f"/?{query}"


def aws_sigv4_presigned_url(
    host: str,
    *,
    credential_scope: str | None = None,
    access_key_id: str = PLACEHOLDER_ACCESS_KEY_ID,
    date: str = DEFAULT_SIGV4_DATE,
    region: str = DEFAULT_AWS_REGION,
    service: str = DEFAULT_AWS_SERVICE,
    timestamp: str = DEFAULT_SIGV4_TIMESTAMP,
    expires: str = "60",
    signed_headers: str = "host",
    signature: str | None = PLACEHOLDER_SIGNATURE,
    leading_query: str = STS_QUERY,
) -> str:
    path = aws_sigv4_presigned_query_path(
        credential_scope=credential_scope,
        access_key_id=access_key_id,
        date=date,
        region=region,
        service=service,
        timestamp=timestamp,
        expires=expires,
        signed_headers=signed_headers,
        signature=signature,
        leading_query=leading_query,
    )
    return f"https://{host}{path}"


def signer_test_credentials(
    *,
    access_key_id: str = REAL_AWS_ACCESS_KEY_ID,
    secret_access_key: str = SIGNER_TEST_SECRET_ACCESS_KEY,
    session_token: str | None = None,
) -> AwsSigV4Credentials:
    return AwsSigV4Credentials(access_key_id, secret_access_key, session_token)


def resolved_aws_sigv4_credentials(
    *,
    access_key_id: str = REAL_AWS_ACCESS_KEY_ID,
    secret_access_key: str = REAL_AWS_SECRET_ACCESS_KEY,
    session_token: str | None = REAL_AWS_SESSION_TOKEN,
) -> AwsSigV4Credentials:
    return AwsSigV4Credentials(access_key_id, secret_access_key, session_token)
