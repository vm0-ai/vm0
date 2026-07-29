//! Checkpoint-specific artifact snapshot planning and scheduling.

use super::LOG_TAG;
use crate::artifact as vas;
use crate::content_hash;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use api_contracts::generated::types::{
    runners::storage::ArtifactEntryMissingRootPolicy, webhooks::agent::checkpoints,
};
use futures_util::stream::{self, FuturesUnordered, StreamExt};
use guest_common::log_info;
use guest_common::telemetry::record_sandbox_op;

const ARTIFACT_CHECKPOINT_CONCURRENCY: usize = 2;

/// Build an artifact snapshot using the type generated from the canonical
/// checkpoint webhook contract.
fn build_artifact_snapshot_entry(
    name: &str,
    version: &str,
    mount_path: &str,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
) -> checkpoints::RequestArtifactSnapshot {
    checkpoints::RequestArtifactSnapshot {
        name: name.to_string(),
        version: version.to_string(),
        mount_path: mount_path.to_string(),
        missing_root_policy,
    }
}

enum ArtifactSnapshotPlan<'a> {
    Snapshot {
        entry: &'a env::ArtifactEnv,
        files: Vec<vas::FileEntry>,
    },
    PreserveParentVersion {
        entry: &'a env::ArtifactEnv,
    },
}

async fn build_artifact_snapshot_plan(
    entry: &env::ArtifactEnv,
) -> Result<ArtifactSnapshotPlan<'_>, vas::WalkFilesError> {
    log_info!(
        LOG_TAG,
        "Processing artifact '{}' at {}",
        entry.name,
        entry.mount_path
    );
    match vas::walk_files_for_checkpoint(&entry.mount_path).await {
        Ok(files) => Ok(ArtifactSnapshotPlan::Snapshot { entry, files }),
        Err(error)
            if error.is_missing_root()
                && matches!(
                    entry.missing_root_policy,
                    Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion)
                ) =>
        {
            error.record_preserved_missing_root(&entry.name, &entry.mount_path);
            Ok(ArtifactSnapshotPlan::PreserveParentVersion { entry })
        }
        Err(error) => Err(error),
    }
}

async fn snapshot_artifact_plan(
    http: &HttpClient,
    run_id: &str,
    plan: ArtifactSnapshotPlan<'_>,
) -> Result<checkpoints::RequestArtifactSnapshot, AgentError> {
    let (entry, files) = match plan {
        ArtifactSnapshotPlan::Snapshot { entry, files } => (entry, files),
        ArtifactSnapshotPlan::PreserveParentVersion { entry } => {
            log_info!(
                LOG_TAG,
                "VAS artifact snapshot preserved parent version for missing root: {}@{}",
                entry.name,
                entry.version_id
            );
            return Ok(build_artifact_snapshot_entry(
                &entry.name,
                &entry.version_id,
                &entry.mount_path,
                entry.missing_root_policy,
            ));
        }
    };
    // Skip the VAS round-trips when the mount is byte-identical to what
    // was originally mounted. `version_id` in VAS *is* the content hash
    // (same SHA-256 the web producer emits), so an equality check on the
    // locally-recomputed hash is sufficient — no extra metadata needed.
    // See #10967 for the ~3.9s-per-checkpoint motivation.
    let skip_check_start = std::time::Instant::now();
    let content_hash_start = std::time::Instant::now();
    let local_hash = content_hash::compute_content_hash(
        &entry.storage_id,
        files.iter().map(|f| (f.path.as_str(), f.hash.as_str())),
    );
    record_sandbox_op(
        "artifact_content_hash_compute",
        content_hash_start.elapsed(),
        true,
        None,
    );
    if local_hash == entry.version_id {
        log_info!(
            LOG_TAG,
            "VAS artifact snapshot skipped (unchanged since mount): {}@{}",
            entry.name,
            entry.version_id
        );
        record_sandbox_op(
            "artifact_snapshot_skipped",
            skip_check_start.elapsed(),
            true,
            None,
        );
        return Ok(build_artifact_snapshot_entry(
            &entry.name,
            &entry.version_id,
            &entry.mount_path,
            entry.missing_root_policy,
        ));
    }

    log_info!(
        LOG_TAG,
        "Creating VAS snapshot for artifact '{}'",
        entry.name
    );
    let message = format!("Checkpoint from run {run_id}");
    let snapshot = vas::create_snapshot(
        http,
        vas::CreateSnapshotRequest {
            mount_path: &entry.mount_path,
            files,
            storage_id: &entry.storage_id,
            run_id,
            message: &message,
            parent_version_id: &entry.version_id,
        },
    )
    .await?;
    log_info!(
        LOG_TAG,
        "VAS artifact snapshot created: {}@{}",
        entry.name,
        snapshot.version_id
    );
    Ok(build_artifact_snapshot_entry(
        &entry.name,
        &snapshot.version_id,
        &entry.mount_path,
        entry.missing_root_policy,
    ))
}

/// Snapshot artifact entries. Memory rides in `VM0_ARTIFACTS` post-#10602, so
/// there is no longer a separate memory arm. The generated checkpoint
/// contract preserves the optional missing-root policy for every snapshot
/// path.
pub(super) async fn snapshot_artifact_entries(
    http: &HttpClient,
    run_id: &str,
    entries: &[env::ArtifactEnv],
) -> Result<Option<Vec<checkpoints::RequestArtifactSnapshot>>, AgentError> {
    if entries.is_empty() {
        log_info!(
            LOG_TAG,
            "No artifact configured, creating checkpoint without artifact snapshot"
        );
        return Ok(None);
    }

    let mut indexed_plans = stream::iter(entries.iter().enumerate())
        .map(|(index, entry)| async move { (index, build_artifact_snapshot_plan(entry).await) })
        .buffer_unordered(ARTIFACT_CHECKPOINT_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    indexed_plans.sort_unstable_by_key(|(index, _)| *index);
    let plans = indexed_plans
        .into_iter()
        .map(|(_, result)| result.map_err(vas::WalkFilesError::into_agent_error))
        .collect::<Result<Vec<_>, _>>()?;

    let mut pending = plans.into_iter().enumerate();
    let snapshot =
        |(index, plan)| async move { (index, snapshot_artifact_plan(http, run_id, plan).await) };
    let mut in_flight = FuturesUnordered::new();
    for _ in 0..ARTIFACT_CHECKPOINT_CONCURRENCY {
        if let Some(plan) = pending.next() {
            in_flight.push(snapshot(plan));
        }
    }

    let mut indexed_results = Vec::with_capacity(entries.len());
    let mut first_error: Option<(usize, AgentError)> = None;
    while let Some((index, result)) = in_flight.next().await {
        match result {
            Ok(snapshot_result) => {
                indexed_results.push((index, snapshot_result));
                if first_error.is_none()
                    && let Some(plan) = pending.next()
                {
                    in_flight.push(snapshot(plan));
                }
            }
            Err(error) => {
                if first_error
                    .as_ref()
                    .is_none_or(|(error_index, _)| index < *error_index)
                {
                    first_error = Some((index, error));
                }
            }
        }
    }
    if let Some((_, error)) = first_error {
        return Err(error);
    }

    indexed_results.sort_unstable_by_key(|(index, _)| *index);
    Ok(Some(
        indexed_results
            .into_iter()
            .map(|(_, result)| result)
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const REQUEST_OVERLAP_TIMEOUT: Duration = Duration::from_secs(5);

    async fn start_artifact_checkpoint_test_server(
        artifact_count: usize,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut prepare_requests = Vec::with_capacity(artifact_count);
            for _ in 0..artifact_count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (path, payload) = read_test_json_request(&mut socket).await;
                assert_eq!(path, "/api/webhooks/agent/storages/prepare");
                let storage_id = payload["storageId"].as_str().unwrap().to_string();
                prepare_requests.push((socket, storage_id));
            }
            let prepare_storage_ids = prepare_requests
                .iter()
                .map(|(_, storage_id)| storage_id.clone())
                .collect();
            for (mut socket, storage_id) in prepare_requests {
                let logical_name = storage_id
                    .strip_suffix("-storage-id")
                    .unwrap_or(&storage_id);
                write_test_json_response(
                    &mut socket,
                    &json!({
                        "versionId": format!("snapshot-{logical_name}"),
                        "existing": true,
                    }),
                )
                .await;
            }
            for _ in 0..artifact_count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (path, _) = read_test_json_request(&mut socket).await;
                assert_eq!(path, "/api/webhooks/agent/storages/commit");
                write_test_json_response(
                    &mut socket,
                    &json!({
                        "success": true,
                        "versionId": "ignored",
                        "storageName": "ignored",
                        "size": 0,
                        "fileCount": 0,
                    }),
                )
                .await;
            }
            prepare_storage_ids
        });
        (format!("http://{address}"), handle)
    }

    async fn read_test_json_request(socket: &mut TcpStream) -> (String, serde_json::Value) {
        let mut request = Vec::new();
        let header_end = loop {
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break index;
            }
            let mut chunk = [0_u8; 1024];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "connection closed before request headers");
            request.extend_from_slice(&chunk[..read]);
        };
        let headers = std::str::from_utf8(&request[..header_end]).unwrap();
        let path = headers
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_string();
        let content_length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
            .unwrap_or_default();
        let body_start = header_end + 4;
        while request.len() < body_start + content_length {
            let mut chunk = [0_u8; 1024];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "connection closed before request body");
            request.extend_from_slice(&chunk[..read]);
        }
        let payload =
            serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
        (path, payload)
    }

    async fn write_test_json_response(socket: &mut TcpStream, body: &serde_json::Value) {
        let body = serde_json::to_vec(body).unwrap();
        let headers = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
        socket.shutdown().await.unwrap();
    }

    #[test]
    fn artifact_snapshot_entry_shape_matches_receiver_schema() {
        let entry = build_artifact_snapshot_entry("workspace", "v-abc-123", "/workspace", None);
        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(
            value,
            json!({
                "name": "workspace",
                "version": "v-abc-123",
                "mountPath": "/workspace",
            })
        );
    }

    #[test]
    fn artifact_snapshot_entry_uses_camel_case_keys() {
        let entry = build_artifact_snapshot_entry(
            "n",
            "v",
            "/m",
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        );
        let value = serde_json::to_value(entry).unwrap();
        let obj = value.as_object().expect("entry must be a JSON object");
        // Contract-boundary invariant: the web Zod receiver requires camelCase
        // `mountPath` and `missingRootPolicy`; a snake_case slip would
        // silently cause a 400 on the webhook side.
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("version"));
        assert!(obj.contains_key("mountPath"));
        assert!(obj.contains_key("missingRootPolicy"));
        assert!(!obj.contains_key("mount_path"));
        assert!(!obj.contains_key("missing_root_policy"));
    }

    #[tokio::test]
    async fn artifact_snapshot_missing_mount_fails_before_storage_api_calls() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_explicit_fail_policy_missing_mount_fails() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::Fail),
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_later_missing_mount_fails_before_any_storage_api_calls() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let valid_mount = dir.path().join("valid");
        std::fs::create_dir(&valid_mount).unwrap();
        std::fs::write(valid_mount.join("changed.txt"), "changed").unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![
            env::ArtifactEnv {
                name: "workspace".to_string(),
                mount_path: valid_mount.to_string_lossy().into_owned(),
                storage_id: "workspace-storage-id".to_string(),
                version_id: "old-workspace-version".to_string(),
                missing_root_policy: None,
            },
            env::ArtifactEnv {
                name: "memory".to_string(),
                mount_path: missing_mount.to_string_lossy().into_owned(),
                storage_id: "memory-storage-id".to_string(),
                version_id: "old-memory-version".to_string(),
                missing_root_policy: None,
            },
        ];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_pipelines_overlap_and_preserve_result_order() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_mount = dir.path().join("workspace");
        let memory_mount = dir.path().join("memory");
        std::fs::create_dir(&workspace_mount).unwrap();
        std::fs::create_dir(&memory_mount).unwrap();
        std::fs::write(workspace_mount.join("workspace.txt"), "workspace").unwrap();
        std::fs::write(memory_mount.join("memory.txt"), "memory").unwrap();
        let entries = vec![
            env::ArtifactEnv {
                name: "workspace".to_string(),
                mount_path: workspace_mount.to_string_lossy().into_owned(),
                storage_id: "workspace-storage-id".to_string(),
                version_id: "old-workspace-version".to_string(),
                missing_root_policy: None,
            },
            env::ArtifactEnv {
                name: "memory".to_string(),
                mount_path: memory_mount.to_string_lossy().into_owned(),
                storage_id: "memory-storage-id".to_string(),
                version_id: "old-memory-version".to_string(),
                missing_root_policy: None,
            },
        ];
        let (base_url, server) = start_artifact_checkpoint_test_server(entries.len()).await;
        let http =
            HttpClient::with_api_config(base_url, "test-token", "", "test-run-001", Duration::ZERO)
                .unwrap();

        let snapshots = tokio::time::timeout(
            REQUEST_OVERLAP_TIMEOUT,
            snapshot_artifact_entries(&http, "test-run", &entries),
        )
        .await
        .expect("both artifact pipelines must reach prepare concurrently")
        .unwrap()
        .unwrap();
        let mut prepare_storage_ids = server.await.unwrap();
        prepare_storage_ids.sort_unstable();
        assert_eq!(
            prepare_storage_ids,
            ["memory-storage-id", "workspace-storage-id"]
        );
        assert_eq!(
            serde_json::to_value(snapshots).unwrap(),
            json!([
                {
                    "name": "workspace",
                    "version": "snapshot-workspace",
                    "mountPath": workspace_mount.to_string_lossy(),
                },
                {
                    "name": "memory",
                    "version": "snapshot-memory",
                    "mountPath": memory_mount.to_string_lossy(),
                },
            ])
        );
    }

    #[tokio::test]
    async fn artifact_snapshot_preserve_policy_missing_mount_preserves_parent_version() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("memory");
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        }];

        let snapshots = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            serde_json::to_value(snapshots).unwrap(),
            json!([
                {
                    "name": "memory",
                    "version": "old-memory-version",
                    "mountPath": missing_mount.to_string_lossy(),
                    "missingRootPolicy": "preserveParentVersion",
                }
            ])
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_policy_still_fails_on_non_not_found_root_error() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file_mount = dir.path().join("memory");
        std::fs::write(&file_mount, "not a directory").unwrap();
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: file_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }
}
