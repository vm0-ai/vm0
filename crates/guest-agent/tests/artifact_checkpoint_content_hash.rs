//! Artifact checkpoint telemetry lives in its own test binary because
//! guest-agent environment and runtime paths are captured in process-wide
//! `LazyLock`s on first access.

use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

const RUN_ID: &str = "artifact-checkpoint-content-hash";
const STORAGE_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn content_hash_for_single_file(storage_id: &str, path: &str, content: &str) -> String {
    let file_hash = sha256_hex(content.as_bytes());
    sha256_hex(format!("storage:{storage_id}\n{path}:{file_hash}"))
}

unsafe fn setup_env(temp_dir: &Path, server: &MockServer, mount_path: &Path, version_id: &str) {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("VM0_RUN_ID", RUN_ID);
        std::env::set_var("VM0_API_URL", server.base_url());
        std::env::set_var("VM0_API_TOKEN", "test-token");
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            temp_dir.join("runtime"),
        );
        std::env::set_var("HOME", temp_dir.join("home"));
        std::env::set_var(
            guest_contracts::env::ARTIFACTS_ENV,
            json!([
                {
                    "name": "workspace",
                    "mountPath": mount_path.to_string_lossy(),
                    "storageId": STORAGE_ID,
                    "versionId": version_id,
                }
            ])
            .to_string(),
        );
    }
}

#[tokio::test]
async fn unchanged_artifact_checkpoint_records_content_hash_timing()
-> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = tempfile::tempdir()?;
    let server = MockServer::start();
    let mount_path = temp_dir.path().join("workspace");
    std::fs::create_dir(&mount_path)?;
    std::fs::write(mount_path.join("a.txt"), "hello")?;
    let version_id = content_hash_for_single_file(STORAGE_ID, "a.txt", "hello");

    unsafe {
        setup_env(temp_dir.path(), &server, &mount_path, &version_id);
    }

    let history_path = temp_dir.path().join("history.jsonl");
    std::fs::write(&history_path, r#"{"type":"system"}"#)?;
    guest_agent::paths::write_private(guest_agent::paths::session_id_file(), "session-abc")?;
    guest_agent::paths::write_private(
        guest_agent::paths::session_history_path_file(),
        history_path.to_string_lossy().as_ref(),
    )?;

    let history_prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .body_includes(format!(r#""runId":"{RUN_ID}""#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let storage_prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare");
        then.status(200).json_body(json!({"unreachable": true}));
    });
    let storage_commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200).json_body(json!({"unreachable": true}));
    });
    let checkpoint = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .body_includes(r#""artifactSnapshots":[{"mountPath":"#)
            .body_includes(format!(r#""version":"{version_id}""#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-with-unchanged-artifact"}));
    });

    let http = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        Duration::ZERO,
    )?;

    guest_agent::checkpoint::create_checkpoint(&http).await?;

    history_prepare.assert_calls_async(1).await;
    storage_prepare.assert_calls_async(0).await;
    storage_commit.assert_calls_async(0).await;
    checkpoint.assert_calls_async(1).await;

    let sandbox_ops = std::fs::read_to_string(guest_common::telemetry::sandbox_ops_log())?;
    assert!(sandbox_ops.contains(r#""action_type":"artifact_content_hash_compute""#));
    assert!(sandbox_ops.contains(r#""action_type":"artifact_snapshot_skipped""#));

    Ok(())
}
