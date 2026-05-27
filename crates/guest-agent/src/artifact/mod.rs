//! VAS artifact upload — SHA-256 hashing, tar.gz creation, S3 presigned upload.
//!
//! Flow (caller first walks the mount via [`walk_files`], then invokes
//! [`create_snapshot`] with the pre-walked file list):
//! 1. POST `/storages/prepare` with file list → get presigned URLs
//! 2. If deduplicated, POST `/storages/commit` to update HEAD
//! 3. Create tar.gz archive
//! 4. Create manifest.json
//! 5. PUT archive + manifest to S3
//! 6. POST `/storages/commit`

use crate::error::AgentError;
use crate::http::HttpClient;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info};
use serde::Serialize;
use serde_json::json;

mod api;
mod archive;

use api::{CommitSnapshotRequest, PrepareSnapshotRequest, commit_snapshot, prepare_snapshot};
use archive::{collect_file_metadata, create_archive, validate_archive_inputs};

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Serialize, Clone)]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    pub(crate) hash: String,
    pub(crate) size: u64,
}

pub(crate) struct SnapshotResult {
    pub(crate) version_id: String,
}

pub(crate) struct CreateSnapshotRequest<'a> {
    pub(crate) mount_path: &'a str,
    pub(crate) files: Vec<FileEntry>,
    pub(crate) storage_name: &'a str,
    pub(crate) storage_type: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) message: &'a str,
    pub(crate) parent_version_id: &'a str,
}

/// Walk `mount_path` in a blocking task and collect `FileEntry` records,
/// recording the hash-compute op and emitting a "Found N files" log. Exposed
/// so the checkpoint step can pre-walk once, decide whether to skip, and reuse
/// the result for `create_snapshot` without a second walk.
pub(crate) async fn walk_files(mount_path: &str) -> Result<Vec<FileEntry>, AgentError> {
    log_info!(LOG_TAG, "Computing file hashes...");
    let hash_start = std::time::Instant::now();
    let mount = mount_path.to_string();
    let files = tokio::task::spawn_blocking(move || collect_file_metadata(&mount))
        .await
        .map_err(|e| AgentError::Execution(format!("hash task panicked: {e}")))?;
    record_sandbox_op("artifact_hash_compute", hash_start.elapsed(), true, None);
    log_info!(LOG_TAG, "Found {} files", files.len());
    Ok(files)
}

/// Create a VAS snapshot using direct S3 upload. Caller provides the
/// pre-walked file list (see [`walk_files`]) — this lets the checkpoint step
/// share one walk between its skip-check fingerprint and the snapshot upload.
pub(crate) async fn create_snapshot(
    http: &HttpClient,
    request: CreateSnapshotRequest<'_>,
) -> Result<SnapshotResult, AgentError> {
    let CreateSnapshotRequest {
        mount_path,
        files,
        storage_name,
        storage_type,
        run_id,
        message,
        parent_version_id,
    } = request;

    log_info!(
        LOG_TAG,
        "Creating direct upload snapshot for '{storage_name}'"
    );

    // Step 1: Prepare
    log_info!(LOG_TAG, "Calling prepare endpoint...");
    let prep_start = std::time::Instant::now();
    let prep = match prepare_snapshot(
        http,
        PrepareSnapshotRequest {
            run_id,
            storage_name,
            storage_type,
            files: &files,
            parent_version_id,
        },
    )
    .await
    {
        Ok(prep) => prep,
        Err(error) => {
            let (error, telemetry_error) = error.into_parts();
            record_sandbox_op(
                "artifact_prepare_api",
                prep_start.elapsed(),
                false,
                telemetry_error.as_deref(),
            );
            return Err(error);
        }
    };

    let version_id = prep.version_id;
    record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), true, None);

    // Step 2: Deduplication check
    if prep.existing {
        log_info!(
            LOG_TAG,
            "Version already exists (deduplicated), updating HEAD"
        );
        log_info!(LOG_TAG, "Validating deduplicated artifact inputs...");
        let validate_start = std::time::Instant::now();
        let validate_mount = mount_path.to_string();
        let validate_files = files.clone();
        let validate_result = match tokio::task::spawn_blocking(move || {
            validate_archive_inputs(&validate_mount, &validate_files)
        })
        .await
        {
            Ok(result) => result,
            Err(e) => {
                record_sandbox_op(
                    "artifact_archive_validate",
                    validate_start.elapsed(),
                    false,
                    None,
                );
                return Err(AgentError::Execution(format!(
                    "archive validation task panicked: {e}"
                )));
            }
        };
        if let Err(e) = validate_result {
            log_error!(LOG_TAG, "Failed to validate deduplicated archive: {e}");
            record_sandbox_op(
                "artifact_archive_validate",
                validate_start.elapsed(),
                false,
                None,
            );
            return Err(AgentError::Checkpoint(
                "Failed to validate archive inputs".into(),
            ));
        }
        record_sandbox_op(
            "artifact_archive_validate",
            validate_start.elapsed(),
            true,
            None,
        );

        let commit_success = commit_snapshot(
            http,
            CommitSnapshotRequest {
                run_id,
                storage_name,
                storage_type,
                version_id: &version_id,
                parent_version_id,
                files: &files,
                message: None,
            },
            "Failed to parse dedup commit response",
        )
        .await?;
        if !commit_success {
            return Err(AgentError::Checkpoint("Failed to update HEAD".into()));
        }
        return Ok(SnapshotResult { version_id });
    }

    // Step 3: Get presigned URLs
    let uploads = prep
        .uploads
        .ok_or_else(|| AgentError::Checkpoint("No upload URLs in prepare response".into()))?;
    let archive_url = uploads.archive_url;
    let manifest_url = uploads.manifest_url;

    // Step 4: Create archive + manifest in temp dir
    let temp_dir = tempfile::tempdir().map_err(AgentError::Io)?;
    let archive_path = temp_dir.path().join("archive.tar.gz");
    let manifest_path = temp_dir.path().join("manifest.json");

    // Create archive (blocking)
    log_info!(LOG_TAG, "Creating archive...");
    let arc_start = std::time::Instant::now();
    let mp = mount_path.to_string();
    let ap = archive_path.clone();
    let archive_files = files.clone();
    let archive_result =
        tokio::task::spawn_blocking(move || create_archive(&mp, &ap, &archive_files))
            .await
            .map_err(|e| AgentError::Execution(format!("archive task panicked: {e}")))?;
    if let Err(e) = archive_result {
        log_error!(LOG_TAG, "Failed to create archive: {e}");
        record_sandbox_op("artifact_archive_create", arc_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Failed to create archive".into()));
    }
    record_sandbox_op("artifact_archive_create", arc_start.elapsed(), true, None);

    // Create manifest
    let manifest = json!({
        "version": 1,
        "files": files,
        "createdAt": guest_common::log::timestamp(),
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| AgentError::Checkpoint(e.to_string()))?,
    )
    .map_err(|e| AgentError::Checkpoint(format!("Failed to write manifest: {e}")))?;

    // Step 5: Upload to S3
    log_info!(LOG_TAG, "Uploading archive to S3...");
    let s3_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned_file(&archive_url, &archive_path, "application/gzip")
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }

    log_info!(LOG_TAG, "Uploading manifest to S3...");
    let manifest_data = tokio::fs::read(&manifest_path).await?;
    if let Err(e) = http
        .put_presigned(&manifest_url, manifest_data.into(), "application/json")
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }
    record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), true, None);

    // Step 6: Commit
    log_info!(LOG_TAG, "Calling commit endpoint...");
    let commit_start = std::time::Instant::now();
    let commit_success = match commit_snapshot(
        http,
        CommitSnapshotRequest {
            run_id,
            storage_name,
            storage_type,
            version_id: &version_id,
            parent_version_id,
            files: &files,
            message: Some(message),
        },
        "Failed to parse commit response",
    )
    .await
    {
        Ok(success) => success,
        Err(e) => {
            record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
            return Err(e);
        }
    };

    if !commit_success {
        record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Commit failed".into()));
    }

    record_sandbox_op("artifact_commit_api", commit_start.elapsed(), true, None);
    let short_id = version_id.get(..8).unwrap_or(&version_id);
    log_info!(LOG_TAG, "Direct upload snapshot created: {short_id}");

    Ok(SnapshotResult { version_id })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::LazyLock;
    use std::time::Duration;

    static SNAPSHOT_MOCK_SERVER: LazyLock<httpmock::MockServer> =
        LazyLock::new(httpmock::MockServer::start);

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    fn test_http_client(server: &httpmock::MockServer) -> Result<HttpClient, AgentError> {
        HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
    }

    #[tokio::test]
    async fn dedup_snapshot_posts_file_payloads_before_validation_failure_blocks_commit()
    -> Result<(), AgentError> {
        disable_system_log();
        let server = &*SNAPSHOT_MOCK_SERVER;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
        std::fs::write(root.join("target.txt"), "content").unwrap();
        let mut files = archive::collect_file_metadata(root.to_str().unwrap());
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let expected_files: Vec<serde_json::Value> = files
            .iter()
            .map(|file| {
                serde_json::json!({
                    "path": file.path,
                    "hash": file.hash,
                    "size": file.size,
                })
            })
            .collect();
        let total_size: u64 = files.iter().map(|file| file.size).sum();

        let prepare = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/storages/prepare")
                .json_body(serde_json::json!({
                    "runId": "run-id",
                    "storageName": "storage",
                    "storageType": "artifact",
                    "files": expected_files,
                    "parentVersionId": "parent-v1",
                }));
            then.status(200).json_body(serde_json::json!({
                "versionId": "v-existing",
                "existing": true
            }));
        });
        let commit = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/storages/commit")
                .json_body(serde_json::json!({
                    "runId": "run-id",
                    "storageName": "storage",
                    "storageType": "artifact",
                    "versionId": "v-existing",
                    "parentVersionId": "parent-v1",
                    "files": expected_files,
                }));
            then.status(200).json_body(serde_json::json!({
                "success": true,
                "versionId": "v-existing",
                "storageName": "storage",
                "size": total_size,
                "fileCount": expected_files.len(),
            }));
        });

        let http = test_http_client(server)?;
        let result = create_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: root.to_str().unwrap(),
                files: files.clone(),
                storage_name: "storage",
                storage_type: "artifact",
                run_id: "run-id",
                message: "message",
                parent_version_id: "parent-v1",
            },
        )
        .await
        .unwrap();

        assert_eq!(result.version_id, "v-existing");
        prepare.assert_calls(1);
        commit.assert_calls(1);
        prepare.delete_async().await;
        commit.delete_async().await;

        std::fs::write(root.join("target.txt"), "changed").unwrap();
        let prepare = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/storages/prepare")
                .json_body(serde_json::json!({
                    "runId": "run-id",
                    "storageName": "storage",
                    "storageType": "artifact",
                    "files": expected_files,
                }));
            then.status(200).json_body(serde_json::json!({
                "versionId": "v-existing",
                "existing": true
            }));
        });
        let commit = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200)
                .json_body(serde_json::json!({ "success": true }));
        });

        let http = test_http_client(server)?;
        let result = create_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: root.to_str().unwrap(),
                files,
                storage_name: "storage",
                storage_type: "artifact",
                run_id: "run-id",
                message: "message",
                parent_version_id: "",
            },
        )
        .await;

        let Err(err) = result else {
            panic!("create_snapshot unexpectedly succeeded");
        };
        assert!(
            err.to_string()
                .contains("Failed to validate archive inputs")
        );
        prepare.assert_calls(1);
        commit.assert_calls(0);
        prepare.delete_async().await;
        commit.delete_async().await;
        Ok(())
    }
}
