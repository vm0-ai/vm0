"""AWS SigV4 firewall-auth integration helpers for mitm-addon tests."""

from pathlib import Path
from typing import TypedDict

import auth
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import matching
from aws_sigv4 import AwsSigV4Credentials
from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.auth_state_helpers import auth_cache_key, set_cached_headers
from tests.aws_sigv4_helpers import (
    DEFAULT_AWS_REGION,
    DEFAULT_SIGV4_TIMESTAMP,
    REAL_AWS_ACCESS_KEY_ID,
    REAL_AWS_SECRET_ACCESS_KEY,
    REAL_AWS_SESSION_TOKEN,
    STS_FORM_BODY,
    STS_HOST,
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
    aws_sigv4_presigned_query_path,
    resolved_aws_sigv4_credentials,
)
from url_utils import get_original_url

DEFAULT_SANDBOX_TOKEN = "sandbox-token"


class AwsAuthConfigBase(TypedDict):
    headers: dict[str, str]
    awsSigv4: dict[str, str]


class AwsAuthConfig(AwsAuthConfigBase, total=False):
    query: dict[str, str]


class AwsApiEntry(TypedDict):
    base: str
    auth: AwsAuthConfig


class AwsVmInfo(TypedDict):
    runId: str
    sandboxToken: str
    encryptedSecrets: str
    networkLogPath: str
    billableFirewalls: list[object]
    vars: dict[str, str]


def aws_sigv4_auth_config(*, include_session_token: bool = True) -> dict[str, str]:
    config = {
        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
    }
    if include_session_token:
        config["sessionToken"] = "${{ secrets.AWS_SESSION_TOKEN }}"
    return config


def aws_api_entry(
    *,
    base: str = f"https://{STS_HOST}",
    auth_headers: dict[str, str] | None = None,
    auth_query: dict[str, str] | None = None,
    include_session_token: bool = True,
) -> AwsApiEntry:
    auth_config: AwsAuthConfig = {
        "headers": dict(auth_headers) if auth_headers is not None else {},
        "awsSigv4": aws_sigv4_auth_config(include_session_token=include_session_token),
    }
    if auth_query is not None:
        auth_config["query"] = dict(auth_query)
    return {
        "base": base,
        "auth": auth_config,
    }


def aws_allow(
    api_entry: AwsApiEntry | None = None,
    *,
    firewall_name: str = "aws",
    permission: str = "identity",
    params: dict[str, str] | None = None,
    rule: str = "POST /",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    return matching.FirewallAllow(
        dict(aws_api_entry() if api_entry is None else api_entry),
        firewall_name,
        permission,
        {} if params is None else params,
        rule,
        rel_path,
    )


def aws_vm_info(
    tmp_path: Path,
    *,
    run_id: str = "run-1",
    sandbox_token: str | None = None,
    encrypted_secrets: str = "iv:tag:data",
    region: str = DEFAULT_AWS_REGION,
) -> AwsVmInfo:
    return {
        "runId": run_id,
        "sandboxToken": DEFAULT_SANDBOX_TOKEN if sandbox_token is None else sandbox_token,
        "encryptedSecrets": encrypted_secrets,
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "billableFirewalls": [],
        "vars": {"AWS_REGION": region},
    }


def aws_auth_response(
    *,
    include_session_token: bool = True,
    access_key_id: str = REAL_AWS_ACCESS_KEY_ID,
    secret_access_key: str = REAL_AWS_SECRET_ACCESS_KEY,
    session_token: str = REAL_AWS_SESSION_TOKEN,
    headers: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
) -> dict[str, object]:
    aws_sigv4 = {
        "accessKeyId": access_key_id,
        "secretAccessKey": secret_access_key,
    }
    resolved_secrets = [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    ]
    refreshed_connectors: list[str] = []
    refreshed_secrets: list[str] = []
    if include_session_token:
        aws_sigv4["sessionToken"] = session_token
        resolved_secrets.append("AWS_SESSION_TOKEN")
        refreshed_connectors.append("aws")
        refreshed_secrets.append("AWS_SESSION_TOKEN")

    response: dict[str, object] = {
        "headers": dict(headers) if headers is not None else {},
        "awsSigv4": aws_sigv4,
        "expiresAt": 1_800_000_000,
        "resolvedSecrets": resolved_secrets,
        "refreshedConnectors": refreshed_connectors,
        "refreshedSecrets": refreshed_secrets,
    }
    if query is not None:
        response["query"] = dict(query)
    return response


def prepare_firewall_request(
    flow,
    *,
    original_url: str | None = None,
    run_id: str = "run-1",
) -> None:
    flow.metadata[metadata_keys.VM_RUN_ID] = run_id
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        get_original_url(flow) if original_url is None else original_url
    )


def make_sts_header_sigv4_flow(
    real_flow,
    headers,
    *,
    host: str = STS_HOST,
    path: str = "/",
    method: str = "POST",
    request_body: bytes | None = None,
    authorization: str | None = None,
    signed_headers: str = "host;x-amz-date",
    amz_date: str | None = DEFAULT_SIGV4_TIMESTAMP,
    extra_headers: tuple[tuple[str, str], ...] = (),
):
    return real_flow(
        with_response=False,
        host=host,
        path=path,
        method=method,
        request_body=STS_FORM_BODY if request_body is None else request_body,
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                host=host,
                amz_date=amz_date,
                extra_headers=extra_headers,
                authorization=(
                    aws_sigv4_authorization(signed_headers=signed_headers)
                    if authorization is None
                    else authorization
                ),
            )
        ),
    )


def make_sts_query_sigv4_flow(real_flow, *, path: str | None = None):
    return real_flow(
        with_response=False,
        host=STS_HOST,
        path=aws_sigv4_presigned_query_path() if path is None else path,
        method="GET",
    )


async def handle_firewall_request_with_auth_endpoint(
    flow,
    tmp_path: Path,
    mitm_ctx,
    *,
    endpoint: FakeAuthEndpoint | None = None,
    auth_response: dict[str, object] | None = None,
    allow: matching.FirewallAllow | None = None,
    vm_info: AwsVmInfo | None = None,
) -> auth.FirewallAuthHandlingResult:
    resolved_endpoint = FakeAuthEndpoint() if endpoint is None else endpoint
    resolved_endpoint.queue_json_response(
        aws_auth_response() if auth_response is None else auth_response
    )
    resolved_vm_info = aws_vm_info(tmp_path) if vm_info is None else vm_info
    prepare_firewall_request(flow, run_id=resolved_vm_info["runId"])

    with resolved_endpoint.run(), mitm_ctx(api_url=resolved_endpoint.api_url):
        return await auth.handle_firewall_request(
            flow,
            aws_allow() if allow is None else allow,
            dict(resolved_vm_info),
        )


def assert_sigv4_failed_closed(
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


def aws_auth_cache_key(
    tmp_path: Path,
    api_entry: AwsApiEntry | None = None,
    vm_info: AwsVmInfo | None = None,
):
    resolved_api_entry = aws_api_entry() if api_entry is None else api_entry
    resolved_vm_info = aws_vm_info(tmp_path) if vm_info is None else vm_info
    auth_config = resolved_api_entry["auth"]
    auth_request = auth_client.FirewallAuthRequest(
        encrypted_secrets=resolved_vm_info["encryptedSecrets"],
        auth_headers=auth_config["headers"],
        sandbox_token=resolved_vm_info["sandboxToken"],
        auth_query=auth_config.get("query"),
        auth_aws_sigv4=auth_config["awsSigv4"],
        vars_map=resolved_vm_info["vars"],
    )
    return auth_cache_key(
        run_id=resolved_vm_info["runId"],
        api_id=resolved_api_entry["base"],
        auth_identity=auth._build_firewall_auth_identity(
            firewall_name="aws",
            firewall_base=resolved_api_entry["base"],
            auth_request=auth_request,
        ),
    )


def cache_aws_sigv4_credentials(
    tmp_path: Path,
    *,
    api_entry: AwsApiEntry | None = None,
    vm_info: AwsVmInfo | None = None,
    credentials: AwsSigV4Credentials | None = None,
    headers: dict[str, str] | None = None,
) -> None:
    set_cached_headers(
        aws_auth_cache_key(tmp_path, api_entry=api_entry, vm_info=vm_info),
        headers=dict(headers) if headers is not None else {},
        aws_sigv4=(resolved_aws_sigv4_credentials() if credentials is None else credentials),
    )
