//! The guest-agent entry point must turn the runner-owned execution deadline
//! into a recovery checkpoint before exiting with the shared timeout code.

mod common;

use guest_contracts::diagnostics::{
    AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationReason, FailureDiagnostic,
};
use httpmock::prelude::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "execution-timeout-recovery";
const THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c60";

#[tokio::test]
async fn execution_timeout_checkpoints_the_resumable_session_before_exit()
-> Result<(), Box<dyn std::error::Error>> {
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
    let mock_codex = write_stalled_codex(tmp.path(), &history)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "keep working until the execution deadline".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let _heartbeat = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/heartbeat")
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
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
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/execution-timeout-history"),
                "existing": false
            }));
    });
    let upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/execution-timeout-history")
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
            .json_body(json!({"checkpointId": "execution-timeout-recovery-checkpoint"}));
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
            .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
            .env(
                guest_contracts::env::SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV, "reused")
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
            .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
            .env(guest_contracts::env::MOCK_CODEX_PATH_ENV, &mock_codex)
            .env(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV, "1")
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
            .output(),
    )
    .await
    .expect("guest-agent did not finish within its finalization budget")?;

    assert_eq!(
        output.status.code(),
        Some(AGENT_EXECUTION_TIMEOUT_EXIT_CODE),
        "guest-agent output:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    prepare.assert_calls_async(1).await;
    upload.assert_calls_async(1).await;
    checkpoint.assert_calls_async(1).await;

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(paths.failure_diagnostic_file())?)?;
    assert_eq!(
        diagnostic
            .cli_termination
            .expect("timeout diagnostic should record CLI termination")
            .reason,
        CliTerminationReason::ExecutionTimeout
    );
    assert_eq!(
        std::fs::read_to_string(paths.session_id_file())?.trim(),
        THREAD_ID
    );
    let child_pid = std::fs::read_to_string(tmp.path().join("codex.pid"))?;
    assert!(
        !Path::new(&format!("/proc/{}", child_pid.trim())).exists(),
        "timed-out Codex process should be gone before guest-agent exits"
    );

    Ok(())
}

fn write_stalled_codex(
    root: &Path,
    history: &str,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let path = root.join("stalled-codex");
    let script = format!(
        "#!/bin/sh\n\
         set -eu\n\
         printf '%s\\n' \"$$\" > '{}'\n\
         history_dir=\"$HOME/.codex/sessions/2026/07/29\"\n\
         mkdir -p \"$history_dir\"\n\
         printf '%s' '{}' > \"$history_dir/{THREAD_ID}.jsonl\"\n\
         printf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"{THREAD_ID}\"}}'\n\
         printf '%s\\n' '{{\"type\":\"turn.started\"}}'\n\
         while :; do sleep 1; done\n",
        root.join("codex.pid").display(),
        history.replace('\'', "'\\''"),
    );
    std::fs::write(&path, script)?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}
