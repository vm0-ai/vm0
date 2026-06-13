"""AWS SigV4 signer boundary tests."""

import urllib.parse

import pytest

from aws_sigv4 import AwsSigV4Credentials, AwsSigV4SigningError, sign_request


def _credentials() -> AwsSigV4Credentials:
    return AwsSigV4Credentials("AKIDEXAMPLE", "secret")


def _header_auth_headers() -> list[tuple[str, str]]:
    return [
        (
            "Authorization",
            "AWS4-HMAC-SHA256 "
            "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
            "SignedHeaders=host;x-amz-date, "
            "Signature=placeholder",
        ),
        ("X-Amz-Date", "20260101T000000Z"),
        ("Host", "sts.amazonaws.com"),
    ]


def _presigned_url(host: str) -> str:
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    return (
        f"https://{host}/?Action=GetCallerIdentity&Version=2011-06-15"
        "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
        f"&X-Amz-Credential={placeholder_credential}"
        "&X-Amz-Date=20260101T000000Z"
        "&X-Amz-Expires=60"
        "&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=placeholder"
    )


def test_header_auth_malformed_url_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url="https://[::1",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_malformed_url_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=_presigned_url("[::1"),
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_invalid_port_keeps_specific_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL has an invalid port"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com:bad/",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )
