"""Cross-stage contracts for malformed builtin host policies."""

import pytest

import builtin_host_policy

_AUTH_CONFIG: dict[str, object] = {
    "headers": {"Authorization": "Bearer x"},
}


@pytest.mark.parametrize(
    ("host_policy", "base", "trusted_host"),
    [
        pytest.param(
            {"kind": "providerOwned", "suffixes": ["com"]},
            "https://api.com",
            "api.com",
            id="one-label-suffix",
        ),
        pytest.param(
            {"kind": "providerOwned", "exactHosts": ["0177.0.0.1"]},
            "https://0177.0.0.1",
            "0177.0.0.1",
            id="ipv4-like-exact-host",
        ),
        pytest.param(
            {"kind": "providerOwned"},
            "https://api.example.com",
            "api.example.com",
            id="empty-provider-ownership",
        ),
        pytest.param(
            {
                "kind": "providerOwned",
                "suffixes": ["example.com"],
                "extra": True,
            },
            "https://api.example.com",
            "api.example.com",
            id="unsupported-key",
        ),
        pytest.param(
            {"kind": "providerOwned", "exactHosts": "api.example.com"},
            "https://api.example.com",
            "api.example.com",
            id="invalid-list-type",
        ),
        pytest.param(
            {
                "kind": "providerOwned",
                "exactHosts": None,
                "suffixes": ["example.com"],
            },
            "https://api.example.com",
            "api.example.com",
            id="null-exact-hosts",
        ),
        pytest.param(
            {
                "kind": "providerOwned",
                "exactHosts": ["api.example.com"],
                "suffixes": None,
            },
            "https://api.example.com",
            "api.example.com",
            id="null-suffixes",
        ),
        pytest.param(
            {
                "kind": "providerOwned",
                "suffixes": ["example.com"],
                "allowNonDefaultPort": "false",
            },
            "https://api.example.com",
            "api.example.com",
            id="invalid-boolean-type",
        ),
        pytest.param(
            {
                "kind": "providerOwned",
                "suffixes": ["example.com"],
                "allowNonDefaultPort": None,
            },
            "https://api.example.com",
            "api.example.com",
            id="null-allow-non-default-port",
        ),
        pytest.param(
            {"kind": "unsupported"},
            "https://api.example.com",
            "api.example.com",
            id="invalid-kind",
        ),
        pytest.param(
            ["providerOwned"],
            "https://api.example.com",
            "api.example.com",
            id="non-object-policy",
        ),
        *[
            pytest.param(
                {"kind": "providerOwned", field: [f"evil{character}host.example.com"]},
                "https://api.example.com",
                "api.example.com",
                id=f"forbidden-{field}-{ord(character):x}",
            )
            for field in ("exactHosts", "suffixes")
            for character in "<>^|"
        ],
    ],
)
def test_malformed_policy_is_rejected_by_every_validation_stage(
    host_policy: object,
    base: str,
    trusted_host: str,
) -> None:
    with pytest.raises(builtin_host_policy.BuiltinHostPolicyError):
        builtin_host_policy.validate_host_policy_shape_for_cache(
            firewall_name="contract-test",
            host_policy=host_policy,
        )

    with pytest.raises(builtin_host_policy.BuiltinHostPolicyError):
        builtin_host_policy.validate_credentialed_builtin_base(
            firewall_name="contract-test",
            base=base,
            auth_config=_AUTH_CONFIG,
            host_policy=host_policy,
        )

    with pytest.raises(builtin_host_policy.BuiltinRuntimeHostPolicyError) as error:
        builtin_host_policy.validate_credentialed_builtin_request_destination(
            firewall_name="contract-test",
            trusted_host=trusted_host,
            trusted_port=443,
            auth_config=_AUTH_CONFIG,
            host_policy=host_policy,
            upstream_endpoint=None,
        )

    assert error.value.reason == "invalid_host_policy"
