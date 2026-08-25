"""Compiled firewall malformed auth config tests."""

import pytest

import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
)

GITHUB_BASE = "https://api.github.com"
REPO_RULE = "GET /repos/{owner}/{repo}"
REPO_URL = "https://api.github.com/repos/org/repo"


def _github_firewalls_with_auth(auth_config):
    return [
        firewall_entry(
            "github",
            firewall_api(
                GITHUB_BASE,
                [firewall_permission("repo-read", REPO_RULE)],
                auth=auth_config,
            ),
        )
    ]


def _github_policies(*, unknown_policy="allow"):
    return {"github": network_policy(allow=["repo-read"], unknown_policy=unknown_policy)}


@pytest.mark.parametrize(
    "auth_config",
    [
        None,
        "Bearer token",
        {"headers": None},
        {"headers": "Authorization"},
        {"headers": {"Authorization": 123}},
        {"headers": {123: "Bearer token"}},
        {"base": None},
        {"base": 123},
        {"base": ""},
        {"base": "ftp://example.com/hook"},
        {"base": "http://example.com/hook"},
        {"base": "http://${{ vars.WEBHOOK_HOST }}/hook"},
        {"base": "https:/example.com/hook"},
        {"base": "https:///hook"},
        {"base": "https://example.com/hook#fragment"},
        {"base": "https://user:pass@example.com/hook"},
        {"base": "https://0177.0.0.1?token=static"},
        {"base": "https://127。0。0。1?token=static"},
        {"base": "https://example.com\\hook"},
        {"base": "https://example.com/hook/%2e%2e/admin"},
        {"base": "https://example.com/hook/%5csecret"},
        {"base": "https://example.com/hook/%5Csecret"},
        {"base": "https://example.com/\x00hook"},
        {"base": "https:/example.com/hook/${{ secrets.WEBHOOK_TOKEN }}"},
        {"base": "https://example.com/hook/${{ env.WEBHOOK_TOKEN }}"},
        {"base": "${{\u0085secrets.WEBHOOK_URL\u0085}}"},
        {"base": "${{ secrets.WEBHOOK_URL }} /v1"},
        {"base": "${{ secrets.WEBHOOK_URL }}\\v1"},
        {"base": "${{ secrets.WEBHOOK_URL }}/%2e%2e/admin"},
        {"base": "${{ secrets.WEBHOOK_URL }}/%5csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}/%5Csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}//%2e%2e/admin"},
        {"base": "${{ secrets.WEBHOOK_URL }}//%5csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}//%5Csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}/\x00v1"},
        {"base": "${{ secrets.WEBHOOK_URL }}#fragment"},
        {"base": "${{ secrets.WEBHOOK_URL }}/${{ env.WEBHOOK_TOKEN }}"},
        {"base": "${{ secrets.WEBHOOK_URL }}@evil.com"},
        {"base": "${{ secrets.WEBHOOK_URL }}:443"},
        {"base": "${{ secrets.WEBHOOK_URL }}&token=static"},
        {"query": None},
        {"query": "api_key"},
        {"query": {"api_key": 123}},
        {"query": {123: "token"}},
        {
            "headers": {"Authorization": "token"},
            "awsSigv4": {"accessKeyId": "key", "secretAccessKey": "secret"},
        },
        {
            "query": {"api_key": "token"},
            "awsSigv4": {"accessKeyId": "key", "secretAccessKey": "secret"},
        },
        {
            "base": "https://hooks.example.com/secret",
            "awsSigv4": {"accessKeyId": "key", "secretAccessKey": "secret"},
        },
    ],
)
def test_malformed_auth_config_fails_closed_after_base_match(auth_config):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls_with_auth(auth_config))
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    result = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "aws_sigv4",
    [
        pytest.param([], id="non-object"),
        pytest.param(
            {
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "unknown": "value",
            },
            id="unknown-field",
        ),
        pytest.param({"secretAccessKey": "secret"}, id="access-key-missing"),
        pytest.param(
            {"accessKeyId": 123, "secretAccessKey": "secret"},
            id="access-key-non-string",
        ),
        pytest.param(
            {"accessKeyId": "", "secretAccessKey": "secret"},
            id="access-key-empty",
        ),
        pytest.param({"accessKeyId": "key"}, id="secret-key-missing"),
        pytest.param(
            {"accessKeyId": "key", "secretAccessKey": 123},
            id="secret-key-non-string",
        ),
        pytest.param(
            {"accessKeyId": "key", "secretAccessKey": ""},
            id="secret-key-empty",
        ),
        pytest.param(
            {
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "sessionToken": None,
            },
            id="session-token-null",
        ),
        pytest.param(
            {
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "sessionToken": 123,
            },
            id="session-token-non-string",
        ),
        pytest.param(
            {
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "sessionToken": "",
            },
            id="session-token-empty",
        ),
    ],
)
def test_malformed_aws_sigv4_config_fails_closed_and_skips_credential_authority(
    aws_sigv4,
):
    compiled_firewalls = compile_firewalls_or_fail(
        _github_firewalls_with_auth({"awsSigv4": aws_sigv4})
    )
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    result = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"
    assert not compiled_firewalls.matches_ordinary_credential_authority(
        "api.github.com",
        443,
    )


@pytest.mark.parametrize(
    "aws_sigv4",
    [
        pytest.param(
            {"accessKeyId": "key", "secretAccessKey": "secret"},
            id="session-token-omitted",
        ),
        pytest.param(
            {
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "sessionToken": "token",
            },
            id="session-token-present",
        ),
    ],
)
def test_valid_aws_sigv4_config_can_match_and_admit_credential_authority(aws_sigv4):
    compiled_firewalls = compile_firewalls_or_fail(
        _github_firewalls_with_auth({"awsSigv4": aws_sigv4})
    )

    result = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        _github_policies(unknown_policy="deny"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"
    assert compiled_firewalls.matches_ordinary_credential_authority(
        "api.github.com",
        443,
    )


@pytest.mark.parametrize(
    "auth_config",
    [
        {"base": "https://example.com/hook?token=static"},
        {"base": "https://example.com?token=a@b"},
        {"base": "${{ secrets.WEBHOOK_URL }}"},
        {"base": "${{\ufeffsecrets.WEBHOOK_URL\ufeff}}"},
        {"base": "${{ secrets.WEBHOOK_BASE_URL }}/v1"},
        {"base": "https://example.com/hook/${{ secrets.WEBHOOK_TOKEN }}"},
        {"base": "https://${{ vars.WEBHOOK_HOST }}/hook/${{ secrets.WEBHOOK_TOKEN }}"},
        {"base": "${{ secrets.WEBHOOK_BASE_URL }}/${{ vars.WEBHOOK_PATH }}"},
        {"base": "${{ secrets.WEBHOOK_BASE_URL }}?token=static"},
    ],
)
def test_valid_auth_base_config_can_match(auth_config):
    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls_with_auth(auth_config),
        _github_policies(unknown_policy="deny"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "token"}},
        {"query": {"api_key": "token"}},
        {
            "headers": {"Authorization": "token"},
            "query": {"api_key": "token"},
        },
        {
            "base": "https://hooks.example.com/secret",
            "headers": {"Authorization": "token"},
        },
        {
            "base": "https://hooks.example.com/secret",
            "query": {"api_key": "token"},
        },
        {
            "base": "https://hooks.example.com/secret",
            "headers": {"Authorization": "token"},
            "query": {"api_key": "token"},
        },
        {
            "base": "https://hooks.example.com/secret",
            "headers": {},
            "query": {},
        },
        {
            "headers": {},
            "query": {},
            "awsSigv4": {"accessKeyId": "key", "secretAccessKey": "secret"},
        },
    ],
)
def test_valid_auth_strategy_config_can_match(auth_config):
    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls_with_auth(auth_config),
        _github_policies(unknown_policy="deny"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


def test_missing_auth_config_fails_closed_after_base_match():
    fws = [
        firewall_entry(
            "github",
            {
                "base": GITHUB_BASE,
                "permissions": [
                    {"name": "repo-read", "rules": [REPO_RULE]},
                ],
            },
        )
    ]

    result = match_compiled_firewalls(
        REPO_URL,
        fws,
        _github_policies(),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"
