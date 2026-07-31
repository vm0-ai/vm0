//! Terminal event delivery must select recovery without replacing a primary
//! CLI result.

mod common;

use guest_contracts::diagnostics::{
    EventDeliveryAcceptanceOutcome, FailureClass, FailureDiagnostic,
};
use httpmock::prelude::*;
use serde_json::json;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

const THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c70";

struct EventFailureRun {
    process_exit_code: Option<i32>,
    stderr: String,
    diagnostic: FailureDiagnostic,
}

#[tokio::test]
async fn successful_cli_with_exhausted_event_delivery_uses_recovery_checkpoint()
-> Result<(), Box<dyn std::error::Error>> {
    let run = run_event_failure_case("event-delivery-failure-recovery", 0).await?;

    assert_eq!(
        run.process_exit_code,
        Some(1),
        "guest-agent stderr:\n{}",
        run.stderr
    );
    assert!(
        run.stderr
            .contains("Attempting best-effort recovery checkpoint")
    );
    assert!(run.stderr.contains("Recovery checkpoint created"));
    assert!(!run.stderr.contains("▷ Checkpoint"));
    assert_eq!(
        run.diagnostic.failure_class,
        FailureClass::EventUploadFailed
    );
    assert_eq!(run.diagnostic.cli_exit_code, Some(0));
    assert_confirmed_event_delivery(&run.diagnostic)?;

    Ok(())
}

#[tokio::test]
async fn nonzero_cli_remains_primary_when_event_delivery_also_fails()
-> Result<(), Box<dyn std::error::Error>> {
    let run = run_event_failure_case("event-delivery-secondary-failure", 7).await?;

    assert_eq!(
        run.process_exit_code,
        Some(7),
        "guest-agent stderr:\n{}",
        run.stderr
    );
    assert!(run.stderr.contains("mock codex primary failure"));
    assert_eq!(run.diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(run.diagnostic.cli_exit_code, Some(7));
    assert_confirmed_event_delivery(&run.diagnostic)?;

    Ok(())
}

async fn run_event_failure_case(
    run_id: &str,
    cli_exit_code: i32,
) -> Result<EventFailureRun, Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&home)?;
    let history = format!(
        "{{\"type\":\"thread.started\",\"thread_id\":\"{THREAD_ID}\"}}\n\
         {{\"type\":\"turn.started\"}}\n"
    );
    let mock_codex = write_codex(tmp.path(), &history, cli_exit_code)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "finish CLI execution while event delivery fails".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let _heartbeat = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(500);
    });
    let _telemetry = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"runId":"{run_id}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/event-delivery-recovery-history"),
                "existing": false
            }));
    });
    let upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/event-delivery-recovery-history")
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{THREAD_ID}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "event-delivery-recovery-checkpoint"}));
    });

    let output = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .env_clear()
            .env("VM0_TEST_DISABLE_HTTP_RETRY_DELAY", "1")
            .env(
                "PATH",
                std::env::var("PATH")
                    .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
            )
            .env("SHELL", "/bin/sh")
            .env("HOME", &home)
            .env(guest_contracts::env::API_URL_ENV, server.base_url())
            .env(guest_contracts::env::API_TOKEN_ENV, "test-token")
            .env(guest_contracts::env::RUN_ID_ENV, run_id)
            .env(
                guest_contracts::env::SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV, "reused")
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
            .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
            .env(guest_contracts::env::MOCK_CODEX_PATH_ENV, &mock_codex)
            .env(
                guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
                &run_payload_file,
            )
            .env(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            )
            .output(),
    )
    .await
    .map_err(|_| io::Error::other("guest-agent exceeded its finalization budget"))??;

    assert!(events.calls_async().await >= 3);
    prepare.assert_calls_async(1).await;
    upload.assert_calls_async(1).await;
    checkpoint.assert_calls_async(1).await;

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir.clone());
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(paths.failure_diagnostic_file())?)?;
    assert!(
        !runtime_dir.join("event-error").exists(),
        "structured failure propagation must not recreate the boolean event flag"
    );

    Ok(EventFailureRun {
        process_exit_code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        diagnostic,
    })
}

fn assert_confirmed_event_delivery(
    diagnostic: &FailureDiagnostic,
) -> Result<(), Box<dyn std::error::Error>> {
    let event_delivery = diagnostic
        .event_delivery
        .as_ref()
        .ok_or_else(|| io::Error::other("failure omitted event delivery details"))?;
    assert!(event_delivery.failed_batches > 0);
    assert_eq!(
        event_delivery.failed_batches, event_delivery.total_batches,
        "the mock rejects every event delivery batch"
    );
    assert_eq!(
        event_delivery
            .first_failed_batch
            .as_ref()
            .ok_or_else(|| io::Error::other("failure omitted first failed batch"))?
            .outcome,
        EventDeliveryAcceptanceOutcome::ConfirmedRejection
    );
    Ok(())
}

fn write_codex(
    root: &Path,
    history: &str,
    cli_exit_code: i32,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let path = root.join("mock-codex");
    let exit_script = if cli_exit_code == 0 {
        String::new()
    } else {
        format!("printf '%s\\n' 'mock codex primary failure' >&2\nexit {cli_exit_code}\n")
    };
    let script = format!(
        "#!/bin/sh\n\
         set -eu\n\
         history_dir=\"$HOME/.codex/sessions/2026/07/30\"\n\
         mkdir -p \"$history_dir\"\n\
         printf '%s' '{}' > \"$history_dir/{THREAD_ID}.jsonl\"\n\
         printf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"{THREAD_ID}\"}}'\n\
         printf '%s\\n' '{{\"type\":\"turn.completed\"}}'\n\
         {exit_script}",
        history.replace('\'', "'\\''"),
    );
    std::fs::write(&path, script)?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}
