use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::io::Cursor;
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RUN_ID: &str = "artifact-checkpoint-content-hash";
const STORAGE_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
const ARTIFACT_FILE_IDENTITY_V2_DOMAIN: &[u8] = b"vm0-artifact-file-identity-v2\0";

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn artifact_file_identity(mode: u32, content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(ARTIFACT_FILE_IDENTITY_V2_DOMAIN);
    hasher.update(mode.to_be_bytes());
    hasher.update(content);
    hex::encode(hasher.finalize())
}

fn version_id_for_single_file(storage_id: &str, path: &str, mode: u32, content: &[u8]) -> String {
    let file_identity = artifact_file_identity(mode, content);
    sha256_hex(format!("storage:{storage_id}\n{path}:{file_identity}"))
}

fn checkpoint_request_has_artifact_snapshot(
    req: &HttpMockRequest,
    expected_version: &str,
    expected_mount_path: &str,
) -> bool {
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(req.body_ref()) else {
        return false;
    };
    let Some(snapshots) = body
        .get("artifactSnapshots")
        .and_then(|value| value.as_array())
    else {
        return false;
    };

    snapshots.iter().any(|snapshot| {
        snapshot.get("name").and_then(|value| value.as_str()) == Some("workspace")
            && snapshot.get("version").and_then(|value| value.as_str()) == Some(expected_version)
            && snapshot.get("mountPath").and_then(|value| value.as_str())
                == Some(expected_mount_path)
    })
}

struct SandboxOpsOverrideGuard;

impl SandboxOpsOverrideGuard {
    fn set(path: &str) -> Self {
        guest_common::telemetry::set_sandbox_ops_log_file(path);
        Self
    }
}

impl Drop for SandboxOpsOverrideGuard {
    fn drop(&mut self) {
        guest_common::telemetry::clear_sandbox_ops_log_file();
    }
}

fn write_run_payload(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::write(&path, serde_json::to_vec(payload)?)?;
    Ok(path)
}

fn test_runtime(
    temp_dir: &Path,
    mount_path: &Path,
    version_id: &str,
    api_url: &str,
) -> Result<GuestRuntime, Box<dyn std::error::Error>> {
    let runtime_dir = temp_dir.join("runtime");
    let paths = GuestPaths::from_runtime_dir(&runtime_dir);
    let run_payload_file = write_run_payload(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            artifacts: json!([
                {
                    "name": "workspace",
                    "mountPath": mount_path.to_string_lossy(),
                    "storageId": STORAGE_ID,
                    "versionId": version_id,
                }
            ])
            .to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: RUN_ID.to_string(),
        api_url: api_url.to_string(),
        api_token: "test-token".to_string(),
        cli_agent_type: "claude-code".to_string(),
        home: Some(temp_dir.join("home").to_string_lossy().into_owned()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..GuestConfigRaw::default()
    })?;
    let http =
        HttpClient::with_api_config(api_url, "test-token", "", "test-run-001", Duration::ZERO)?;
    Ok(GuestRuntime {
        config,
        paths,
        http,
    })
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn unchanged_artifact_checkpoint_records_content_hash_timing()
-> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = tempfile::tempdir()?;
    let mount_path = temp_dir.path().join("workspace");
    std::fs::create_dir(&mount_path)?;
    let file_path = mount_path.join("a.txt");
    std::fs::write(&file_path, "hello")?;
    std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o644))?;
    let version_id = version_id_for_single_file(STORAGE_ID, "a.txt", 0o644, b"hello");

    let server = MockServer::start();
    let runtime = test_runtime(
        temp_dir.path(),
        &mount_path,
        &version_id,
        &server.base_url(),
    )?;
    let _sandbox_ops_guard = SandboxOpsOverrideGuard::set(runtime.paths.sandbox_ops_file());

    let history_path = temp_dir.path().join("history.jsonl");
    std::fs::write(&history_path, r#"{"type":"system"}"#)?;
    guest_agent::paths::write_private(runtime.paths.session_id_file(), "session-abc")?;
    guest_agent::paths::write_private(
        runtime.paths.session_history_path_file(),
        history_path.to_string_lossy().as_ref(),
    )?;

    let history_prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
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
    let expected_version = version_id.clone();
    let expected_mount_path = mount_path.to_string_lossy().into_owned();
    let checkpoint = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .is_true(move |req| {
                checkpoint_request_has_artifact_snapshot(
                    req,
                    &expected_version,
                    &expected_mount_path,
                )
            });
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-with-unchanged-artifact"}));
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await?;

    history_prepare.assert_calls_async(1).await;
    storage_prepare.assert_calls_async(0).await;
    storage_commit.assert_calls_async(0).await;
    checkpoint.assert_calls_async(1).await;

    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file())?;
    assert!(sandbox_ops.contains(r#""action_type":"artifact_content_hash_compute""#));
    assert!(sandbox_ops.contains(r#""action_type":"artifact_snapshot_skipped""#));

    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn permission_only_change_creates_restorable_artifact_version()
-> Result<(), Box<dyn std::error::Error>> {
    const SCRIPT: &[u8] = b"#!/bin/sh\necho ok\n";

    let temp_dir = tempfile::tempdir()?;
    let mount_path = temp_dir.path().join("workspace");
    std::fs::create_dir(&mount_path)?;
    let script_path = mount_path.join("script.sh");
    std::fs::write(&script_path, SCRIPT)?;
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o644))?;

    let mounted_version = version_id_for_single_file(STORAGE_ID, "script.sh", 0o644, SCRIPT);
    let checkpoint_version = version_id_for_single_file(STORAGE_ID, "script.sh", 0o755, SCRIPT);
    let checkpoint_file_identity = artifact_file_identity(0o755, SCRIPT);
    assert_ne!(mounted_version, checkpoint_version);

    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))?;

    let server = MockServer::start();
    let runtime = test_runtime(
        temp_dir.path(),
        &mount_path,
        &mounted_version,
        &server.base_url(),
    )?;
    let history_path = temp_dir.path().join("history.jsonl");
    std::fs::write(&history_path, r#"{"type":"system"}"#)?;
    guest_agent::paths::write_private(runtime.paths.session_id_file(), "session-mode-change")?;
    guest_agent::paths::write_private(
        runtime.paths.session_history_path_file(),
        history_path.to_string_lossy().as_ref(),
    )?;

    let history_prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });

    let archive_url = server.url("/uploads/artifact.tar.gz");
    let manifest_url = server.url("/uploads/manifest.json");
    let prepare_files = json!([{
        "path": "script.sh",
        "hash": checkpoint_file_identity,
        "size": SCRIPT.len() as u64,
    }]);
    let prepare_version = checkpoint_version.clone();
    let prepare_parent = mounted_version.clone();
    let storage_prepare = server.mock(move |when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(json!({
                "runId": RUN_ID,
                "storageId": STORAGE_ID,
                "files": prepare_files,
                "parentVersionId": prepare_parent,
            }));
        then.status(200).json_body(json!({
            "versionId": prepare_version,
            "existing": false,
            "uploads": {
                "archive": {
                    "key": "artifact-key",
                    "presignedUrl": archive_url,
                },
                "manifest": {
                    "key": "manifest-key",
                    "presignedUrl": manifest_url,
                },
            },
        }));
    });

    let uploaded_archive = Arc::new(Mutex::new(None::<Vec<u8>>));
    let uploaded_archive_for_mock = Arc::clone(&uploaded_archive);
    let archive_upload = server.mock(move |when, then| {
        when.method(PUT)
            .path("/uploads/artifact.tar.gz")
            .header("Content-Type", "application/gzip");
        then.respond_with(move |req| {
            *uploaded_archive_for_mock
                .lock()
                .expect("uploaded archive lock should not be poisoned") =
                Some(req.body_ref().to_vec());
            HttpMockResponse::builder().status(200).build()
        });
    });
    let manifest_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/uploads/manifest.json")
            .header("Content-Type", "application/json");
        then.status(200);
    });

    let commit_files = json!([{
        "path": "script.sh",
        "hash": artifact_file_identity(0o755, SCRIPT),
        "size": SCRIPT.len() as u64,
    }]);
    let commit_version = checkpoint_version.clone();
    let commit_parent = mounted_version.clone();
    let commit_response_version = checkpoint_version.clone();
    let storage_commit = server.mock(move |when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body(json!({
                "runId": RUN_ID,
                "storageId": STORAGE_ID,
                "versionId": commit_version,
                "parentVersionId": commit_parent,
                "files": commit_files,
                "message": format!("Checkpoint from run {RUN_ID}"),
            }));
        then.status(200).json_body(json!({
            "success": true,
            "versionId": commit_response_version,
            "storageName": "workspace",
            "size": SCRIPT.len() as u64,
            "fileCount": 1,
        }));
    });

    let expected_version = checkpoint_version.clone();
    let expected_mount_path = mount_path.to_string_lossy().into_owned();
    let checkpoint = server.mock(move |when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .is_true(move |req| {
                checkpoint_request_has_artifact_snapshot(
                    req,
                    &expected_version,
                    &expected_mount_path,
                )
            });
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-with-mode-change"}));
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await?;

    history_prepare.assert_calls_async(1).await;
    storage_prepare.assert_calls_async(1).await;
    archive_upload.assert_calls_async(1).await;
    manifest_upload.assert_calls_async(1).await;
    storage_commit.assert_calls_async(1).await;
    checkpoint.assert_calls_async(1).await;

    let archive_bytes = uploaded_archive
        .lock()
        .map_err(|_| std::io::Error::other("uploaded archive lock was poisoned"))?
        .clone()
        .ok_or_else(|| std::io::Error::other("artifact archive was not uploaded"))?;
    let restore_path = temp_dir.path().join("restored");
    std::fs::create_dir(&restore_path)?;
    let decoder = flate2::read::GzDecoder::new(Cursor::new(archive_bytes));
    tar::Archive::new(decoder).unpack(&restore_path)?;

    let restored_script = restore_path.join("script.sh");
    assert_eq!(std::fs::read(&restored_script)?, SCRIPT);
    assert_eq!(
        std::fs::metadata(&restored_script)?.permissions().mode() & 0o7777,
        0o755
    );

    Ok(())
}
