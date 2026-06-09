"""Firewall AWS SigV4 auth re-signing tests."""

import urllib.parse

import auth
import matching
from tests.auth_endpoint_helpers import FakeAuthEndpoint


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


async def test_re_signs_header_sigv4_request(real_flow, headers, tmp_path, mitm_ctx):
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_auth_response())
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.response is None
    authorization = flow.request.headers["authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "PLACEHOLDER" not in authorization
    assert "Signature=placeholder" not in authorization
    assert flow.request.headers["x-amz-security-token"] == "real-session-token"
    assert flow.metadata["auth_resolved_secrets"] == [
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
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        {
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
    )
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(
            flow,
            matching.FirewallAllow(api_entry, "aws", "list-users", {}, "GET /", "/"),
            _vm_info(tmp_path),
        )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
    )
    assert "x-amz-security-token" not in flow.request.headers


async def test_re_signs_query_sigv4_request(real_flow, tmp_path, mitm_ctx):
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_auth_response())
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert "authorization" not in flow.request.headers
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(flow.request.url).query))
    assert query["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    assert query["X-Amz-Credential"] == "AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request"
    assert query["X-Amz-Security-Token"] == "real-session-token"
    assert query["X-Amz-Signature"] != "placeholder"
    assert "PLACEHOLDER" not in flow.request.url


async def test_sigv4a_request_fails_closed(real_flow, headers, tmp_path, mitm_ctx):
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_auth_response())
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
    assert "SigV4A is not supported" in flow.response.json()["message"]


async def test_header_sigv4_without_signature_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_auth_response())
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
    assert "Malformed AWS authorization header" in flow.response.json()["message"]


async def test_header_sigv4_without_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_auth_response())
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
    assert "requires x-amz-date" in flow.response.json()["message"]


async def test_query_sigv4_without_signature_fails_closed(real_flow, tmp_path, mitm_ctx):
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_auth_response())
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
    flow.metadata["vm_run_id"] = "run-1"

    with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
        result = await auth.handle_firewall_request(flow, _allow(_api_entry()), _vm_info(tmp_path))

    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
    assert "Malformed AWS presigned query" in flow.response.json()["message"]
