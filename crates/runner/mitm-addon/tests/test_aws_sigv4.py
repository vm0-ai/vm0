"""AWS SigV4 signer boundary tests."""

import urllib.parse

import pytest

from aws_sigv4 import AwsSigV4Credentials, AwsSigV4SigningError, sign_request

_INVALID_UNICODE = "\ud800"


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


def test_header_auth_invalid_bracketed_host_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url="https://[foo]/",
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


def test_presigned_query_double_encoded_credential_raises_signing_error() -> None:
    double_encoded_credential = urllib.parse.quote(
        urllib.parse.quote(
            "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
            safe="",
        ),
        safe="",
    )
    url = (
        "https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15"
        "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
        f"&X-Amz-Credential={double_encoded_credential}"
        "&X-Amz-Date=20260101T000000Z"
        "&X-Amz-Expires=60"
        "&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=placeholder"
    )

    with pytest.raises(AwsSigV4SigningError, match="Malformed AWS credential scope"):
        sign_request(
            method="GET",
            url=url,
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_invalid_bracketed_host_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=_presigned_url("[foo]"),
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_percent_encoded_credential_raises_signing_error() -> None:
    headers = [
        (
            "Authorization",
            "AWS4-HMAC-SHA256 "
            "Credential=PLACEHOLDER%2F20260101%2Fus-east-1%2Fsts%2Faws4_request, "
            "SignedHeaders=host;x-amz-date, "
            "Signature=placeholder",
        ),
        ("X-Amz-Date", "20260101T000000Z"),
        ("Host", "sts.amazonaws.com"),
    ]

    with pytest.raises(AwsSigV4SigningError, match="Malformed AWS credential scope"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=headers,
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_invalid_unicode_path_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"https://sts.amazonaws.com/{_INVALID_UNICODE}",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("path", ["/%ZZ", "/%"])
def test_header_auth_malformed_percent_encoded_path_raises_signing_error(
    path: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"https://sts.amazonaws.com{path}",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://sts.amazonaws.com/pa\nth",
        " https://sts.amazonaws.com/path",
    ],
)
def test_header_auth_raw_whitespace_url_raises_signing_error(url: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=url,
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_invalid_unicode_query_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"{_presigned_url('sts.amazonaws.com')}&Extra={_INVALID_UNICODE}",
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("query", ["Bad=%ED%A0%80", "Bad=%ZZ"])
def test_presigned_query_malformed_percent_encoding_raises_signing_error(
    query: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"{_presigned_url('sts.amazonaws.com')}&{query}",
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_invalid_unicode_fragment_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"https://sts.amazonaws.com/#fragment{_INVALID_UNICODE}",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_signed_header_invalid_unicode_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=[*_header_auth_headers(), ("x-amz-meta-test", _INVALID_UNICODE)],
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    "header",
    [
        (f"x-other-{_INVALID_UNICODE}", "value"),
        ("x-other", f"value{_INVALID_UNICODE}"),
    ],
)
def test_unsigned_header_invalid_unicode_raises_signing_error(
    header: tuple[str, str],
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=[*_header_auth_headers(), header],
            body=None,
            credentials=_credentials(),
        )


def test_invalid_unicode_secret_key_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="Invalid AWS secret access key"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers(),
            body=None,
            credentials=AwsSigV4Credentials("AKIDEXAMPLE", f"secret{_INVALID_UNICODE}"),
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
