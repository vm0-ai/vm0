"""Tests for usage underbilling log contracts."""

from typing import cast

from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from usage.underbilling import UnderbillingClass, log_usage_underbilling


def test_underbilling_log_fields_cannot_be_overridden_by_context(tmp_path):
    proxy_log_path = tmp_path / "proxy.jsonl"

    log_usage_underbilling(
        str(proxy_log_path),
        "Usage underbilling signal",
        "expected_reason",
        "risk",
        type="usage_event",
        reason="wrong_reason",
        component="wrong_component",
        underbilling_class="confirmed",
        run_id="run-1",
        level="debug",
        message="wrong_message",
        timestamp="wrong_timestamp",
    )

    [entry] = read_jsonl_entries_after_flush(proxy_log_path)
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "expected_reason"
    assert entry["underbilling_class"] == "risk"
    assert entry["component"] == "mitm_addon"
    assert entry["run_id"] == "run-1"
    assert entry["level"] == "error"
    assert entry["message"] == "Usage underbilling signal"
    assert entry["timestamp"] != "wrong_timestamp"


def test_underbilling_log_without_proxy_path_uses_stderr(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            type="usage_event",
            reason="wrong_reason",
            component="wrong_component",
            underbilling_class="confirmed",
        )

    log.error.assert_called_once()
    message = log.error.call_args.args[0]
    assert message.startswith(
        "type=usage_underbilling reason=expected_reason "
        "underbilling_class=risk component=mitm_addon "
    )
    assert message.endswith("Usage underbilling signal")


def test_underbilling_stderr_fallback_preserves_context(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Cannot report usage event",
            "missing_reporting_context",
            "confirmed",
            type="usage_event",
            reason="wrong_reason",
            component="wrong_component",
            underbilling_class="risk",
            run_id="run-1",
            firewall_name="model-provider:anthropic",
            permission="messages:create",
            missing_sandbox_token=True,
            missing_api_url=False,
            dropped_webhook_batch_count=2,
            level="debug",
            message="wrong_message",
            timestamp="wrong_timestamp",
        )

    log.error.assert_called_once()
    message = log.error.call_args.args[0]
    assert message.startswith(
        "type=usage_underbilling reason=missing_reporting_context "
        "underbilling_class=confirmed component=mitm_addon "
    )
    assert "run_id=run-1" in message
    assert "firewall_name=model-provider:anthropic" in message
    assert "permission=messages:create" in message
    assert "missing_sandbox_token=true" in message
    assert "missing_api_url=false" in message
    assert "dropped_webhook_batch_count=2" in message
    assert "type=usage_event" not in message
    assert "wrong_reason" not in message
    assert "wrong_component" not in message
    assert "level=debug" not in message
    assert "message=wrong_message" not in message
    assert "timestamp=wrong_timestamp" not in message
    assert message.endswith("Cannot report usage event")


def test_underbilling_stderr_fallback_sanitizes_url(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "X response unparseable",
            "unparseable_usage_response",
            "confirmed",
            url="https://user:pass@example.com/v1/search?token=secret#fragment",
        )

    message = log.error.call_args.args[0]
    assert "url=https://example.com/v1/search" in message
    assert "user:pass" not in message
    assert "token=secret" not in message
    assert "#fragment" not in message


def test_underbilling_stderr_fallback_redacts_secret_strings_not_boolean_flags(mitm_ctx):
    sensitive_context = {
        "sandbox_token": "secret-token",
        "missing_sandbox_token": True,
        "authorization_header": "Bearer secret-token",
        "retained_retry_count": 3,
    }

    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Cannot report usage event",
            "missing_reporting_context",
            "confirmed",
            **sensitive_context,
        )

    message = log.error.call_args.args[0]
    assert "sandbox_token=[redacted]" in message
    assert "authorization_header=[redacted]" in message
    assert "missing_sandbox_token=true" in message
    assert "retained_retry_count=3" in message
    assert "secret-token" not in message


def test_underbilling_stderr_fallback_redacts_common_key_fields(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Cannot report usage event",
            "missing_reporting_context",
            "confirmed",
            api_key="api-key-value",
            access_key_id="access-key-value",
            private_key="private-key-value",
            credential_value="credential-value",
            bearer="bearer-value",
            jwt="jwt-value",
            sandbox_token_bytes=b"bytes-token-value",
            auth_header="short-auth-header-value",
            authentication_header="authentication-header-value",
            idempotency_key="diagnostic-key",
            input_tokens="42",
            tokenizer_name="usage-tokenizer",
            **{
                "api-key": "hyphen-api-key-value",
                "api key number": 123456,
                "spaced api key": "spaced-api-key-value",
                "access key number": 456789,
                "accessKeyId": "camel-access-key-value",
                "oauth_token": "oauth-token-value",
                "passwd": "passwd-value",
                "pwd": "pwd-value",
                "APIToken": "upper-api-token-value",
                "XApiKey": "prefixed-api-key-value",
                "AWSACCESSKEYID": "upper-compact-access-key-value",
                "github_accesstoken": "compact-access-token-value",
                "openai_apikey": "compact-api-key-value",
                "sessioncookie": "compact-cookie-value",
                "signedjwt": "compact-jwt-value",
                "dbpasswd": "compact-passwd-value",
                "bearerCredential": "compact-bearer-value",
                "private.key": "dotted-private-key-value",
                "privateKey": "camel-private-key-value",
                "ssh_privatekey": "compact-private-key-value",
            },
        )

    message = log.error.call_args.args[0]
    assert "api_key=[redacted]" in message
    assert "access_key_id=[redacted]" in message
    assert "private_key=[redacted]" in message
    assert "credential_value=[redacted]" in message
    assert "bearer=[redacted]" in message
    assert "jwt=[redacted]" in message
    assert "passwd=[redacted]" in message
    assert "pwd=[redacted]" in message
    assert "auth_header=[redacted]" in message
    assert "authentication_header=[redacted]" in message
    assert "oauth_token=[redacted]" in message
    assert "sandbox_token_bytes=[redacted]" in message
    assert "api-key=[redacted]" in message
    assert "api_key_number=[redacted]" in message
    assert "spaced_api_key=[redacted]" in message
    assert "access_key_number=[redacted]" in message
    assert "accessKeyId=[redacted]" in message
    assert "private.key=[redacted]" in message
    assert "privateKey=[redacted]" in message
    assert "APIToken=[redacted]" in message
    assert "XApiKey=[redacted]" in message
    assert "AWSACCESSKEYID=[redacted]" in message
    assert "github_accesstoken=[redacted]" in message
    assert "openai_apikey=[redacted]" in message
    assert "sessioncookie=[redacted]" in message
    assert "signedjwt=[redacted]" in message
    assert "dbpasswd=[redacted]" in message
    assert "bearerCredential=[redacted]" in message
    assert "ssh_privatekey=[redacted]" in message
    assert "idempotency_key=diagnostic-key" in message
    assert "input_tokens=42" in message
    assert "tokenizer_name=usage-tokenizer" in message
    assert "api-key-value" not in message
    assert "123456" not in message
    assert "access-key-value" not in message
    assert "456789" not in message
    assert "private-key-value" not in message
    assert "credential-value" not in message
    assert "bearer-value" not in message
    assert "jwt-value" not in message
    assert "passwd-value" not in message
    assert "pwd-value" not in message
    assert "short-auth-header-value" not in message
    assert "authentication-header-value" not in message
    assert "oauth-token-value" not in message
    assert "upper-api-token-value" not in message
    assert "prefixed-api-key-value" not in message
    assert "upper-compact-access-key-value" not in message
    assert "compact-access-token-value" not in message
    assert "compact-api-key-value" not in message
    assert "compact-cookie-value" not in message
    assert "compact-jwt-value" not in message
    assert "compact-passwd-value" not in message
    assert "compact-bearer-value" not in message
    assert "bytes-token-value" not in message
    assert "hyphen-api-key-value" not in message
    assert "spaced-api-key-value" not in message
    assert "camel-access-key-value" not in message
    assert "dotted-private-key-value" not in message
    assert "camel-private-key-value" not in message
    assert "compact-private-key-value" not in message


def test_underbilling_stderr_fallback_bounds_multiline_values(mitm_ctx):
    long_value = f"first line\n{'x' * 400}\nlast line"

    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            parse_error=long_value,
        )

    message = log.error.call_args.args[0]
    assert log.error.call_count == 1
    assert "\n" not in message
    assert "parse_error=first\\sline\\n" in message
    assert "last line" not in message
    assert len(message) < 420


def test_underbilling_stderr_fallback_truncates_on_escape_boundaries(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            parse_error="\t" * 129,
        )

    message = log.error.call_args.args[0]
    assert "parse_error=" in message
    assert "\\..." not in message
    assert "\\t... Usage underbilling signal" in message
    assert len(message) < 420


def test_underbilling_stderr_fallback_bounds_non_scalar_values(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            debug_payload={"items": ["x" * 400] * 20},
        )

    message = log.error.call_args.args[0]
    assert "debug_payload=" in message
    assert "x" * 300 not in message
    assert len(message) < 420


def test_underbilling_stderr_fallback_sanitizes_field_keys(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            **{"bad key\nname": "value with spaces"},
        )

    message = log.error.call_args.args[0]
    assert "bad_key_name=value\\swith\\sspaces" in message
    assert "bad key" not in message


def test_underbilling_stderr_fallback_escapes_nonstandard_whitespace_and_controls(
    mitm_ctx,
):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            parse_error="left\u00a0middle\f\x1b[31mright",
        )

    message = log.error.call_args.args[0]
    assert "parse_error=left\\smiddle\\s\\u001b[31mright" in message
    assert "\u00a0" not in message
    assert "\f" not in message
    assert "\x1b" not in message


def test_underbilling_stderr_fallback_escapes_reason_and_message_controls(
    mitm_ctx,
):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling\nsignal\twith\x1bcontrols",
            "expected reason\nwith\tcontrols",
            "risk",
            run_id="run-1",
        )

    message = log.error.call_args.args[0]
    assert "reason=expected\\sreason\\nwith\\tcontrols" in message
    assert "run_id=run-1" in message
    assert message.endswith("Usage underbilling\\nsignal\\twith\\u001bcontrols")
    assert "\n" not in message
    assert "\t" not in message
    assert "\x1b" not in message


def test_underbilling_stderr_fallback_stringifies_prefix_values(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            cast(str, 123),
            cast(str, None),
            cast(UnderbillingClass, True),
            run_id="run-1",
        )

    message = log.error.call_args.args[0]
    assert "reason=None" in message
    assert "underbilling_class=True" in message
    assert "run_id=run-1" in message
    assert message.endswith("123")
