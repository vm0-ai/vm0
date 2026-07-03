"""Firewall AWS SigV4 auth re-signing tests."""

import urllib.parse

import pytest

import auth
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import matching
from aws_sigv4 import AwsSigV4Credentials
from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.auth_state_helpers import auth_cache_key, set_cached_headers
from url_utils import get_original_url


def _api_entry() -> dict:
    return {
        "base": "https://sts.amazonaws.com",
        "auth": {
            "headers": {},
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
            },
        },
    }


def _allow(api_entry: dict) -> matching.FirewallAllow:
    return matching.FirewallAllow(
        api_entry,
        "aws",
        "identity",
        {},
        "POST /",
        "/",
    )


def _vm_info(tmp_path, *, encrypted_secrets: str = "iv:tag:data") -> dict:
    return {
        "runId": "run-1",
        "sandboxToken": "sandbox-token",
        "encryptedSecrets": encrypted_secrets,
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "billableFirewalls": [],
        "vars": {"AWS_REGION": "us-east-1"},
    }


def _auth_response() -> dict[str, object]:
    return {
        "headers": {},
        "awsSigv4": {
            "accessKeyId": "AKIDEXAMPLE",
            "secretAccessKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "sessionToken": "real-session-token",
        },
        "expiresAt": 1_800_000_000,
        "resolvedSecrets": [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
        ],
        "refreshedConnectors": ["aws"],
        "refreshedSecrets": ["AWS_SESSION_TOKEN"],
    }


def _auth_response_without_session_token() -> dict[str, object]:
    return {
        "headers": {},
        "awsSigv4": {
            "accessKeyId": "AKIDEXAMPLE",
            "secretAccessKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
        "expiresAt": 1_800_000_000,
        "resolvedSecrets": [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
        ],
        "refreshedConnectors": [],
        "refreshedSecrets": [],
    }


def _prepare_firewall_request(flow, *, original_url: str | None = None) -> None:
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-1"
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        get_original_url(flow) if original_url is None else original_url
    )


async def _handle_firewall_request_with_auth_endpoint(
    flow,
    tmp_path,
    mitm_ctx,
    *,
    endpoint: FakeAuthEndpoint | None = None,
    auth_response: dict[str, object] | None = None,
    allow: matching.FirewallAllow | None = None,
    vm_info: dict | None = None,
) -> auth.FirewallAuthHandlingResult:
    resolved_endpoint = endpoint or FakeAuthEndpoint()
    resolved_endpoint.queue_json_response(
        _auth_response() if auth_response is None else auth_response
    )
    _prepare_firewall_request(flow)

    with resolved_endpoint.run(), mitm_ctx(api_url=resolved_endpoint.api_url):
        return await auth.handle_firewall_request(
            flow,
            _allow(_api_entry()) if allow is None else allow,
            _vm_info(tmp_path) if vm_info is None else vm_info,
        )


def _assert_sigv4_failed_closed(
    result: auth.FirewallAuthHandlingResult,
    flow,
    message_fragment: str,
) -> None:
    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    response = flow.response.json()
    assert response["error"] == "aws_sigv4_auth_failed"
    assert message_fragment in response["message"]


def _aws_auth_cache_key(tmp_path, api_entry: dict | None = None):
    resolved_api_entry = api_entry or _api_entry()
    vm_info = _vm_info(tmp_path)
    auth_config = resolved_api_entry["auth"]
    auth_request = auth_client.FirewallAuthRequest(
        encrypted_secrets=vm_info["encryptedSecrets"],
        auth_headers=auth_config["headers"],
        sandbox_token=vm_info["sandboxToken"],
        auth_aws_sigv4=auth_config["awsSigv4"],
        vars_map=vm_info["vars"],
    )
    return auth_cache_key(
        run_id=vm_info["runId"],
        api_id=resolved_api_entry["base"],
        auth_identity=auth._build_firewall_auth_identity(
            firewall_name="aws",
            firewall_base=resolved_api_entry["base"],
            auth_request=auth_request,
        ),
    )


async def test_re_signs_header_sigv4_request(real_flow, headers, tmp_path, mitm_ctx):
    endpoint = FakeAuthEndpoint()
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_body=b"Action=GetCallerIdentity&Version=2011-06-15",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=content-type;host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        endpoint=endpoint,
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.response is None
    authorization = flow.request.headers["authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "PLACEHOLDER" not in authorization
    assert "Signature=placeholder" not in authorization
    assert flow.request.headers["x-amz-security-token"] == "real-session-token"
    assert flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] == [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    ]

    body = endpoint.requests[0].json_body()
    assert body["authAwsSigv4"] == _api_entry()["auth"]["awsSigv4"]


async def test_re_signs_header_sigv4_request_to_reference_signature(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = _auth_response_without_session_token()
    api_entry = {
        "base": "https://iam.amazonaws.com",
        "auth": {
            "headers": {},
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
        },
    }
    flow = real_flow(
        with_response=False,
        host="iam.amazonaws.com",
        path="/?Action=ListUsers&Version=2010-05-08",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("Content-Type", "application/x-www-form-urlencoded; charset=utf-8"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20150830/us-east-1/iam/aws4_request, "
                "SignedHeaders=content-type;host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=matching.FirewallAllow(api_entry, "aws", "list-users", {}, "GET /", "/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
    )
    assert "x-amz-security-token" not in flow.request.headers


async def test_re_signs_header_sigv4_request_with_encoded_path(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = _auth_response_without_session_token()
    api_entry = {
        "base": "https://iam.amazonaws.com",
        "auth": {
            "headers": {},
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
        },
    }
    flow = real_flow(
        with_response=False,
        host="iam.amazonaws.com",
        path="/a/../long/path%20name/",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20150830/us-east-1/iam/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=matching.FirewallAllow(
            api_entry,
            "aws",
            "encoded-path",
            {},
            "GET /{path+}",
            "/a/../long/path%20name/",
        ),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.url == "https://iam.amazonaws.com/a/../long/path%20name/"
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=f1e30e1649dd37a25de158bbc35c722f3c513f7b1051cb50ec2d351a468824ff"
    )


async def test_re_signs_header_sigv4_request_with_normalized_host(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = _auth_response_without_session_token()
    api_entry = {
        "base": "https://iam.amazonaws.com",
        "auth": {
            "headers": {},
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
        },
    }
    flow = real_flow(
        with_response=False,
        host="IAM.AMAZONAWS.COM",
        path="/",
        method="GET",
        request_headers=headers(
            ("Host", "IAM.AMAZONAWS.COM:443"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20150830/us-east-1/iam/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=matching.FirewallAllow(api_entry, "aws", "normalized-host", {}, "GET /", "/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.headers["host"] == "iam.amazonaws.com"
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=91fb24346d00546d6da247c85eb79148080a6e3ae1ac9aa8eae9ccdabfd70b33"
    )


async def test_re_signs_header_sigv4_request_with_trusted_original_url(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = _auth_response_without_session_token()
    api_entry = {
        "base": "https://iam.amazonaws.com",
        "auth": {
            "headers": {},
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
        },
    }
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="iam.amazonaws.com",
        path="/",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20150830/us-east-1/iam/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = "iam.amazonaws.com"

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=matching.FirewallAllow(api_entry, "aws", "trusted-url", {}, "GET /", "/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.url == "https://iam.amazonaws.com/"
    assert flow.request.headers["host"] == "iam.amazonaws.com"
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=91fb24346d00546d6da247c85eb79148080a6e3ae1ac9aa8eae9ccdabfd70b33"
    )


async def test_re_signs_header_sigv4_request_keeps_resolved_query_with_trusted_url(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = _auth_response_without_session_token()
    auth_response["query"] = {"Trace": "secret-value"}
    api_entry = {
        "base": "https://iam.amazonaws.com",
        "auth": {
            "headers": {},
            "query": {"Trace": "${{ secrets.TRACE }}"},
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
        },
    }
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="iam.amazonaws.com",
        path="/?Action=ListUsers&Version=2010-05-08",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("Content-Type", "application/x-www-form-urlencoded; charset=utf-8"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20150830/us-east-1/iam/aws4_request, "
                "SignedHeaders=content-type;host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = "iam.amazonaws.com"

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=matching.FirewallAllow(api_entry, "aws", "trusted-query", {}, "GET /", "/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    signed_parts = urllib.parse.urlsplit(flow.request.url)
    assert signed_parts.scheme == "https"
    assert signed_parts.netloc == "iam.amazonaws.com"
    assert dict(urllib.parse.parse_qsl(signed_parts.query)) == {
        "Action": "ListUsers",
        "Version": "2010-05-08",
        "Trace": "secret-value",
    }
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=22a3e4709cec49fad0f5cb8eac18cb63ab08f1f90b46be84ed239a4687fdcd97"
    )


async def test_re_signs_query_sigv4_request(real_flow, tmp_path, mitm_ctx):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            "&X-Amz-SignedHeaders=host"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert "authorization" not in flow.request.headers
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(flow.request.url).query))
    assert query["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    assert query["X-Amz-Credential"] == "AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request"
    assert query["X-Amz-Security-Token"] == "real-session-token"
    assert query["X-Amz-Signature"] != "placeholder"
    assert "PLACEHOLDER" not in flow.request.url


async def test_re_signs_query_sigv4_request_strips_session_token_header(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            "&X-Amz-SignedHeaders=host"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Security-Token", "placeholder-session-token"),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert "x-amz-security-token" not in flow.request.headers
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(flow.request.url).query))
    assert query["X-Amz-Security-Token"] == "real-session-token"


async def test_re_signs_query_sigv4_request_preserves_literal_plus(
    real_flow,
    tmp_path,
    mitm_ctx,
):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&LiteralPlus=a+b&EncodedPlus=c%2Bd"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            "&X-Amz-SignedHeaders=host"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    raw_query = urllib.parse.urlsplit(flow.request.url).query
    assert "LiteralPlus=a%2Bb" in raw_query
    query = dict(urllib.parse.parse_qsl(raw_query))
    assert query["LiteralPlus"] == "a+b"
    assert query["EncodedPlus"] == "c+d"


async def test_sigv4a_request_fails_closed(real_flow, headers, tmp_path, mitm_ctx):
    flow = real_flow(
        with_response=False,
        host="s3.amazonaws.com",
        path="/bucket/key",
        request_headers=headers(
            ("Host", "s3.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-ECDSA-P256-SHA256 "
                "Credential=PLACEHOLDER/20260101/*/s3/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "SigV4A is not supported")


async def test_hmac_sigv4_wildcard_region_fails_closed(real_flow, headers, tmp_path, mitm_ctx):
    flow = real_flow(
        with_response=False,
        host="s3.amazonaws.com",
        path="/bucket/key",
        request_headers=headers(
            ("Host", "s3.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/*/s3/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Wildcard AWS signing region requires SigV4A")


async def test_header_sigv4_with_malformed_scope_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1%0d%0aX-Bad:x/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS credential scope")


async def test_header_sigv4_with_control_character_header_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            ("X-Test", "a\n b"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date;x-test, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "AWS request header contains invalid text")


async def test_header_sigv4_with_invalid_resolved_access_key_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    response = _auth_response()
    response["awsSigv4"] = {
        "accessKeyId": "AKID/EXAMPLE",
        "secretAccessKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    }
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=response,
    )

    _assert_sigv4_failed_closed(result, flow, "Invalid AWS access key ID")


async def test_header_sigv4_with_empty_resolved_secret_key_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )
    _prepare_firewall_request(flow)
    set_cached_headers(
        _aws_auth_cache_key(tmp_path),
        headers={},
        aws_sigv4=AwsSigV4Credentials("AKIDEXAMPLE", ""),
    )

    with mitm_ctx():
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    _assert_sigv4_failed_closed(result, flow, "Invalid AWS secret access key")


async def test_header_sigv4_without_trusted_original_url_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-1"
    set_cached_headers(
        _aws_auth_cache_key(tmp_path),
        headers={},
        aws_sigv4=AwsSigV4Credentials(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        ),
    )

    with mitm_ctx():
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    _assert_sigv4_failed_closed(result, flow, "AWS request URL is unavailable")


@pytest.mark.parametrize(
    "request_path",
    [
        "//[foo]?Trace=secret-value",
        "/?Trace=secret\nvalue",
    ],
)
async def test_header_sigv4_with_malformed_current_request_target_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
    request_path,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )
    _prepare_firewall_request(flow)
    flow.request.path = request_path
    set_cached_headers(
        _aws_auth_cache_key(tmp_path),
        headers={},
        aws_sigv4=AwsSigV4Credentials(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        ),
    )

    with mitm_ctx():
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    _assert_sigv4_failed_closed(result, flow, "AWS request URL is malformed")


async def test_header_sigv4_with_empty_resolved_session_token_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )
    _prepare_firewall_request(flow)
    set_cached_headers(
        _aws_auth_cache_key(tmp_path),
        headers={},
        aws_sigv4=AwsSigV4Credentials(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "",
        ),
    )

    with mitm_ctx():
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    _assert_sigv4_failed_closed(result, flow, "Invalid AWS session token")


async def test_header_sigv4_with_real_source_access_key_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "placeholder access key ID")


async def test_header_sigv4_with_duplicate_credential_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request, "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS authorization header")


async def test_header_sigv4_with_duplicate_authorization_headers_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    authorization = (
        "AWS4-HMAC-SHA256 "
        "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=placeholder"
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            ("Authorization", authorization),
            ("Authorization", authorization),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS authorization header")


async def test_header_sigv4_without_signature_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS authorization header")


async def test_header_sigv4_with_duplicate_signed_header_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS signed headers")


async def test_header_sigv4_with_empty_signed_header_segment_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS signed headers")


async def test_header_sigv4_without_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "requires x-amz-date")


async def test_header_sigv4_with_malformed_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "not-a-date"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS signing date")


async def test_header_sigv4_with_scope_date_mismatch_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260102T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(
        result,
        flow,
        "AWS signing date does not match credential scope",
    )


async def test_header_sigv4_with_duplicate_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            ("X-Amz-Date", "20260101T000001Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "requires a single x-amz-date")


async def test_header_sigv4_with_duplicate_content_hash_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_body=b"Action=GetCallerIdentity&Version=2011-06-15",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            ("X-Amz-Content-Sha256", "placeholder-hash-1"),
            ("X-Amz-Content-Sha256", "placeholder-hash-2"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "AWS content hash header is ambiguous")


async def test_header_sigv4_with_empty_content_hash_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_body=b"Action=GetCallerIdentity&Version=2011-06-15",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            ("X-Amz-Content-Sha256", ""),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
                "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "AWS content hash header is empty")


async def test_query_sigv4_without_signature_fails_closed(real_flow, tmp_path, mitm_ctx):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            "&X-Amz-SignedHeaders=host"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS presigned query")


async def test_query_sigv4_with_real_source_access_key_fails_closed(real_flow, tmp_path, mitm_ctx):
    source_credential = urllib.parse.quote(
        "AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={source_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            "&X-Amz-SignedHeaders=host"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "placeholder access key ID")


async def test_query_sigv4_with_duplicate_credential_fails_closed(real_flow, tmp_path, mitm_ctx):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    real_credential = urllib.parse.quote(
        "AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            f"&X-Amz-Credential={real_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            "&X-Amz-SignedHeaders=host"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS presigned query")


async def test_query_sigv4_with_duplicate_signed_header_fails_closed(
    real_flow,
    tmp_path,
    mitm_ctx,
):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    signed_headers = urllib.parse.quote("host;host", safe="")
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=60"
            f"&X-Amz-SignedHeaders={signed_headers}"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS signed headers")


async def test_query_sigv4_with_malformed_expiry_fails_closed(real_flow, tmp_path, mitm_ctx):
    placeholder_credential = urllib.parse.quote(
        "PLACEHOLDER/20260101/us-east-1/sts/aws4_request",
        safe="",
    )
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path=(
            "/?Action=GetCallerIdentity&Version=2011-06-15"
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
            f"&X-Amz-Credential={placeholder_credential}"
            "&X-Amz-Date=20260101T000000Z"
            "&X-Amz-Expires=sixty"
            "&X-Amz-SignedHeaders=host"
            "&X-Amz-Signature=placeholder"
        ),
        method="GET",
    )

    result = await _handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    _assert_sigv4_failed_closed(result, flow, "Malformed AWS presigned query expiry")
