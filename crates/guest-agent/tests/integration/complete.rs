use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

const TEST_RUN_ID: &str = "test-run-001";
const TEST_SANDBOX_ID: &str = "00000000-0000-4000-8000-000000000abc";
const TEST_SANDBOX_REUSE_RESULT: &str = "reused";

// =========================================================================
// Complete webhook
//
// The guest calls /complete right after the checkpoint row lands — the host
// transitions the run to `completed` seconds earlier than waiting for the
// runner's fallback after VM teardown. The runner's POST still fires on VM
// exit and is absorbed by the route's idempotency check.
// =========================================================================

#[tokio::test]
async fn complete_report_success_posts_full_payload_when_metadata_present() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .header("Authorization", "Bearer test-token-abc123")
            .json_body(json!({
                "runId": TEST_RUN_ID,
                "exitCode": 0,
                "lastEventSequence": 7,
                "sandboxId": TEST_SANDBOX_ID,
                "sandboxReuseResult": TEST_SANDBOX_REUSE_RESULT,
            }));
        then.status(200).json_body(json!({
            "success": true,
            "status": "completed",
        }));
    });

    guest_agent::complete::report_success_for_run(
        &http_client!(),
        TEST_RUN_ID,
        TEST_SANDBOX_ID,
        TEST_SANDBOX_REUSE_RESULT,
        Some(7),
    )
    .await;

    mock.assert_calls_async(1).await;
}

/// Unset runner metadata (guest launched without `VM0_SANDBOX_ID` /
/// `VM0_SANDBOX_REUSE_RESULT`, e.g. a pre-#10787 runner): empty strings
/// must serialize as absent so the payload carries only `runId` +
/// `exitCode`. Matches the `skip_serializing_if = "Option::is_none"`
/// contract end-to-end.
#[tokio::test]
async fn complete_report_success_omits_metadata_when_env_absent() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body(json!({
                "runId": TEST_RUN_ID,
                "exitCode": 0,
            }));
        then.status(200).json_body(json!({"success": true}));
    });

    guest_agent::complete::report_success_for_run(&http_client!(), TEST_RUN_ID, "", "", None).await;

    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn complete_report_success_swallows_server_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(500);
    });

    // 1 attempt — no retry, no panic. Fire-and-forget semantics mean the
    // runner fallback is the correctness guarantee.
    guest_agent::complete::report_success_for_run(
        &http_client!(),
        TEST_RUN_ID,
        TEST_SANDBOX_ID,
        TEST_SANDBOX_REUSE_RESULT,
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
}

/// 4xx takes a different branch in `post_json` than 5xx: it returns Err
/// immediately without retrying. Production is most likely to hit 401 when
/// the sandbox token has expired by the time /complete fires. Verify the
/// error still swallows cleanly and the runner fallback will be the only
/// call that actually transitions the run.
#[tokio::test]
async fn complete_report_success_swallows_4xx_auth_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(401).json_body(json!({
            "error": { "message": "Run expired", "code": "UNAUTHORIZED" }
        }));
    });

    guest_agent::complete::report_success_for_run(
        &http_client!(),
        TEST_RUN_ID,
        TEST_SANDBOX_ID,
        TEST_SANDBOX_REUSE_RESULT,
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
}
