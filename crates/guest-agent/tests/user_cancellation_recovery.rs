//! Explicit user cancellation must stop the inner CLI while leaving
//! guest-agent alive long enough to finish recovery and report completion.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use guest_contracts::diagnostics::{CliTerminationReason, FailureDiagnostic};
use httpmock::prelude::*;
use process_control_ipc::{
    ControlRequest, ControlResponseStatus, accept_with_timeout, bind_abstract_listener,
    endpoint_name, read_hello, read_response, write_request,
};
use serde_json::json;
use tokio::process::Command;

const SUCCESS_RUN_ID: &str = "user-cancellation-recovery-success";
const SUCCESS_THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c61";
const FAILURE_RUN_ID: &str = "user-cancellation-recovery-failure";
const FAILURE_THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c62";

struct Scenario {
    run_id: &'static str,
    thread_id: &'static str,
    endpoint_nonce: &'static [u8; 16],
    checkpoint_status: u16,
    recovery_log: &'static str,
}

#[tokio::test]
async fn user_cancellation_checkpoints_before_reporting_completion()
-> Result<(), Box<dyn std::error::Error>> {
    run_scenario(Scenario {
        run_id: SUCCESS_RUN_ID,
        thread_id: SUCCESS_THREAD_ID,
        endpoint_nonce: b"cancel-success01",
        checkpoint_status: 200,
        recovery_log: "Recovery checkpoint created",
    })
    .await
}

#[tokio::test]
async fn user_cancellation_reports_completion_after_recovery_failure()
-> Result<(), Box<dyn std::error::Error>> {
    run_scenario(Scenario {
        run_id: FAILURE_RUN_ID,
        thread_id: FAILURE_THREAD_ID,
        endpoint_nonce: b"cancel-failure01",
        checkpoint_status: 400,
        recovery_log: "Recovery checkpoint skipped:",
    })
    .await
}

async fn run_scenario(scenario: Scenario) -> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&home)?;
    let history = format!(
        "{{\"type\":\"thread.started\",\"thread_id\":\"{}\"}}\n\
         {{\"type\":\"turn.started\"}}\n",
        scenario.thread_id
    );
    let child_pid_file = tmp.path().join("codex.pid");
    let mock_codex =
        write_stalled_codex(tmp.path(), scenario.thread_id, &history, &child_pid_file)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "keep working until the user cancels".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let _heartbeat = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/heartbeat")
            .json_body_includes(format!(r#"{{"runId":"{}"}}"#, scenario.run_id));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let _events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
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
            .json_body_includes(format!(r#"{{"runId":"{}"}}"#, scenario.run_id));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/user-cancellation-history"),
                "existing": false
            }));
    });
    let upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/user-cancellation-history")
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(
                r#"{{"cliAgentSessionId":"{}"}}"#,
                scenario.thread_id
            ));
        then.status(scenario.checkpoint_status)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "user-cancellation-recovery-checkpoint"}));
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .header("Authorization", "Bearer test-token")
            .json_body_includes(format!(r#"{{"runId":"{}","exitCode":1}}"#, scenario.run_id));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let endpoint = endpoint_name(std::process::id(), scenario.endpoint_nonce);
    let listener = bind_abstract_listener(&endpoint)?;
    let control_paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir.clone());
    let session_id_file = PathBuf::from(control_paths.session_id_file());
    let control_pid_file = child_pid_file.clone();
    let control = tokio::task::spawn_blocking(move || {
        let mut stream = accept_with_timeout(&listener, Duration::from_secs(5))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        read_hello(&mut stream)?;
        wait_for_file(&control_pid_file, Duration::from_secs(5))?;
        wait_for_file(&session_id_file, Duration::from_secs(5))?;
        write_request(
            &mut stream,
            &ControlRequest {
                message_id: "cancel-running-cli".to_string(),
                payload: br#"{"type":"user-cancellation"}"#.to_vec(),
            },
        )?;
        read_response(&mut stream)
    });

    let output = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .env_clear()
            .env(
                "PATH",
                std::env::var("PATH")
                    .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
            )
            .env("SHELL", "/bin/sh")
            .env("HOME", &home)
            .env(guest_contracts::env::API_URL_ENV, server.base_url())
            .env(guest_contracts::env::API_TOKEN_ENV, "test-token")
            .env(guest_contracts::env::RUN_ID_ENV, scenario.run_id)
            .env(
                guest_contracts::env::SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV, "reused")
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
            .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
            .env(guest_contracts::env::MOCK_CODEX_PATH_ENV, &mock_codex)
            .env(
                guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                "1",
            )
            .env(
                guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                "1",
            )
            .env(
                guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
                &run_payload_file,
            )
            .env(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            )
            .env(process_control_ipc::BOOTSTRAP_ENV, &endpoint)
            .output(),
    )
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "guest-agent did not finish within its finalization budget",
        )
    })??;
    let response = control.await??;

    assert_eq!(response.message_id, "cancel-running-cli");
    assert_eq!(response.status, ControlResponseStatus::Accepted);
    assert_eq!(
        output.status.code(),
        Some(1),
        "guest-agent output:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    prepare.assert_calls_async(1).await;
    upload.assert_calls_async(1).await;
    checkpoint.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let recovery_index = stderr
        .find(scenario.recovery_log)
        .ok_or_else(|| std::io::Error::other(format!("missing recovery log:\n{stderr}")))?;
    let complete_index = stderr
        .find("Complete webhook acknowledged")
        .ok_or_else(|| std::io::Error::other(format!("missing completion log:\n{stderr}")))?;
    assert!(
        recovery_index < complete_index,
        "recovery must finish before /complete:\n{stderr}"
    );

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(paths.failure_diagnostic_file())?)?;
    let cli_termination = diagnostic
        .cli_termination
        .ok_or_else(|| std::io::Error::other("cancellation diagnostic omitted CLI termination"))?;
    assert_eq!(
        cli_termination.reason,
        CliTerminationReason::UserCancellation
    );
    assert_eq!(
        std::fs::read_to_string(paths.session_id_file())?.trim(),
        scenario.thread_id
    );
    let child_pid = std::fs::read_to_string(child_pid_file)?;
    assert!(
        !Path::new(&format!("/proc/{}", child_pid.trim())).exists(),
        "cancelled Codex process should be gone before guest-agent exits"
    );

    Ok(())
}

fn wait_for_file(path: &Path, timeout: Duration) -> std::io::Result<()> {
    let deadline = Instant::now() + timeout;
    while !path.exists() {
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("timed out waiting for {}", path.display()),
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn write_stalled_codex(
    root: &Path,
    thread_id: &str,
    history: &str,
    child_pid_file: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = root.join("stalled-codex");
    let script = format!(
        "#!/bin/sh\n\
         set -eu\n\
         history_dir=\"$HOME/.codex/sessions/2026/07/30\"\n\
         mkdir -p \"$history_dir\"\n\
         printf '%s' '{}' > \"$history_dir/{thread_id}.jsonl\"\n\
         printf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"{thread_id}\"}}'\n\
         printf '%s\\n' '{{\"type\":\"turn.started\"}}'\n\
         printf '%s\\n' \"$$\" > '{}'\n\
         while :; do sleep 1; done\n",
        history.replace('\'', "'\\''"),
        child_pid_file.display(),
    );
    std::fs::write(&path, script)?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}
