//! VAS artifact upload — SHA-256 hashing, tar.gz creation, S3 presigned upload.
//!
//! Flow (caller first walks the mount via [`walk_files_for_checkpoint`], then
//! invokes [`create_snapshot`] with the pre-walked file list):
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

use api::{
    CommitSnapshotRequest, PrepareSnapshotRequest, PreparedSnapshot, PreparedUploads,
    commit_snapshot, prepare_snapshot,
};
use archive::{collect_file_metadata, create_archive, validate_archive_inputs};
use std::path::PathBuf;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug)]
pub(crate) enum WalkFilesError {
    Execution(String),
    Checkpoint {
        message: String,
        root_not_found: bool,
        elapsed: std::time::Duration,
    },
}

impl WalkFilesError {
    pub(crate) fn is_root_not_found(&self) -> bool {
        matches!(
            self,
            Self::Checkpoint {
                root_not_found: true,
                ..
            }
        )
    }

    pub(crate) fn into_agent_error(self) -> AgentError {
        match self {
            Self::Execution(message) => AgentError::Execution(message),
            Self::Checkpoint {
                message, elapsed, ..
            } => {
                record_sandbox_op("artifact_hash_compute", elapsed, false, Some(&message));
                log_error!(LOG_TAG, "{message}");
                AgentError::Checkpoint(message)
            }
        }
    }
}

pub(crate) async fn walk_files_for_checkpoint(
    mount_path: &str,
) -> Result<Vec<FileEntry>, WalkFilesError> {
    log_info!(LOG_TAG, "Computing file hashes...");
    let hash_start = std::time::Instant::now();
    let mount = mount_path.to_string();
    let files_result =
        match tokio::task::spawn_blocking(move || collect_file_metadata(&mount)).await {
            Ok(result) => result,
            Err(e) => {
                let message = format!("hash task panicked: {e}");
                record_sandbox_op(
                    "artifact_hash_compute",
                    hash_start.elapsed(),
                    false,
                    Some(&message),
                );
                return Err(WalkFilesError::Execution(message));
            }
        };
    let files = match files_result {
        Ok(files) => files,
        Err(e) => {
            let root_not_found = e.is_root_not_found();
            let message = format!("Failed to walk artifact files: {e}");
            return Err(WalkFilesError::Checkpoint {
                message,
                root_not_found,
                elapsed: hash_start.elapsed(),
            });
        }
    };
    record_sandbox_op("artifact_hash_compute", hash_start.elapsed(), true, None);
    log_info!(LOG_TAG, "Found {} files", files.len());
    Ok(files)
}

/// Create a VAS snapshot using direct S3 upload. Caller provides the
/// pre-walked file list (see [`walk_files_for_checkpoint`]) — this lets the
/// checkpoint step share one walk between its skip-check fingerprint and the
/// snapshot upload.
pub(crate) async fn create_snapshot(
    http: &HttpClient,
    request: CreateSnapshotRequest<'_>,
) -> Result<SnapshotResult, AgentError> {
    log_info!(
        LOG_TAG,
        "Creating direct upload snapshot for '{}'",
        request.storage_name
    );

    let prep = prepare_snapshot_step(http, &request).await?;
    let version_id = prep.version_id;

    if prep.existing {
        log_info!(
            LOG_TAG,
            "Version already exists (deduplicated), updating HEAD"
        );
        validate_dedup_snapshot(request.mount_path, &request.files).await?;
        commit_existing_snapshot(http, &request, &version_id).await?;
        return Ok(SnapshotResult { version_id });
    }

    let uploads = extract_uploads(prep.uploads)?;
    let archive = create_archive_bundle(request.mount_path, &request.files).await?;
    upload_archive_bundle(http, &uploads, &archive).await?;
    commit_uploaded_snapshot(http, &request, &version_id).await?;

    let short_id = version_id.get(..8).unwrap_or(&version_id);
    log_info!(LOG_TAG, "Direct upload snapshot created: {short_id}");

    Ok(SnapshotResult { version_id })
}

struct ArchiveBundle {
    _temp_dir: tempfile::TempDir,
    archive_path: PathBuf,
    manifest_path: PathBuf,
}

async fn prepare_snapshot_step(
    http: &HttpClient,
    request: &CreateSnapshotRequest<'_>,
) -> Result<PreparedSnapshot, AgentError> {
    log_info!(LOG_TAG, "Calling prepare endpoint...");
    let prep_start = std::time::Instant::now();
    match prepare_snapshot(
        http,
        PrepareSnapshotRequest {
            run_id: request.run_id,
            storage_name: request.storage_name,
            storage_type: request.storage_type,
            files: &request.files,
            parent_version_id: request.parent_version_id,
        },
    )
    .await
    {
        Ok(prep) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), true, None);
            Ok(prep)
        }
        Err(error) => {
            let (error, telemetry_error) = error.into_parts();
            record_sandbox_op(
                "artifact_prepare_api",
                prep_start.elapsed(),
                false,
                telemetry_error.as_deref(),
            );
            Err(error)
        }
    }
}

async fn validate_dedup_snapshot(mount_path: &str, files: &[FileEntry]) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Validating deduplicated artifact inputs...");
    let validate_start = std::time::Instant::now();
    let validate_mount = mount_path.to_string();
    let validate_files = files.to_vec();
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
    Ok(())
}

async fn commit_existing_snapshot(
    http: &HttpClient,
    request: &CreateSnapshotRequest<'_>,
    version_id: &str,
) -> Result<(), AgentError> {
    let commit_success = commit_snapshot(
        http,
        CommitSnapshotRequest {
            run_id: request.run_id,
            storage_name: request.storage_name,
            storage_type: request.storage_type,
            version_id,
            parent_version_id: request.parent_version_id,
            files: &request.files,
            message: None,
        },
        "Failed to parse dedup commit response",
    )
    .await?;
    if !commit_success {
        return Err(AgentError::Checkpoint("Failed to update HEAD".into()));
    }
    Ok(())
}

fn extract_uploads(uploads: Option<PreparedUploads>) -> Result<PreparedUploads, AgentError> {
    uploads.ok_or_else(|| AgentError::Checkpoint("No upload URLs in prepare response".into()))
}

async fn create_archive_bundle(
    mount_path: &str,
    files: &[FileEntry],
) -> Result<ArchiveBundle, AgentError> {
    let temp_dir = tempfile::tempdir().map_err(AgentError::Io)?;
    let archive_path = temp_dir.path().join("archive.tar.gz");
    let manifest_path = temp_dir.path().join("manifest.json");

    log_info!(LOG_TAG, "Creating archive...");
    let arc_start = std::time::Instant::now();
    let archive_mount = mount_path.to_string();
    let archive_path_for_task = archive_path.clone();
    let archive_files = files.to_vec();
    let archive_result = tokio::task::spawn_blocking(move || {
        create_archive(&archive_mount, &archive_path_for_task, &archive_files)
    })
    .await
    .map_err(|e| AgentError::Execution(format!("archive task panicked: {e}")))?;
    if let Err(e) = archive_result {
        log_error!(LOG_TAG, "Failed to create archive: {e}");
        record_sandbox_op("artifact_archive_create", arc_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Failed to create archive".into()));
    }
    record_sandbox_op("artifact_archive_create", arc_start.elapsed(), true, None);

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

    Ok(ArchiveBundle {
        _temp_dir: temp_dir,
        archive_path,
        manifest_path,
    })
}

async fn upload_archive_bundle(
    http: &HttpClient,
    uploads: &PreparedUploads,
    archive: &ArchiveBundle,
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Uploading archive to S3...");
    let s3_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned_file(
            &uploads.archive_url,
            &archive.archive_path,
            "application/gzip",
        )
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }

    log_info!(LOG_TAG, "Uploading manifest to S3...");
    let manifest_data = tokio::fs::read(&archive.manifest_path).await?;
    if let Err(e) = http
        .put_presigned(
            &uploads.manifest_url,
            manifest_data.into(),
            "application/json",
        )
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }
    record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), true, None);
    Ok(())
}

async fn commit_uploaded_snapshot(
    http: &HttpClient,
    request: &CreateSnapshotRequest<'_>,
    version_id: &str,
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Calling commit endpoint...");
    let commit_start = std::time::Instant::now();
    let commit_success = match commit_snapshot(
        http,
        CommitSnapshotRequest {
            run_id: request.run_id,
            storage_name: request.storage_name,
            storage_type: request.storage_type,
            version_id,
            parent_version_id: request.parent_version_id,
            files: &request.files,
            message: Some(request.message),
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
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use httpmock::prelude::*;
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

    fn file_json_values(files: &[FileEntry]) -> Vec<serde_json::Value> {
        files
            .iter()
            .map(|file| {
                serde_json::json!({
                    "path": file.path,
                    "hash": file.hash,
                    "size": file.size,
                })
            })
            .collect()
    }

    fn http_status(status: u16) -> HttpMockResponse {
        HttpMockResponse::builder().status(status).build()
    }

    fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
        req.headers_vec()
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
    }

    fn manifest_upload_response(
        req: &HttpMockRequest,
        expected_files: &[serde_json::Value],
    ) -> HttpMockResponse {
        let Ok(body) = serde_json::from_slice::<serde_json::Value>(req.body_ref()) else {
            return http_status(400);
        };
        let expected_files = serde_json::Value::Array(expected_files.to_vec());
        if request_header_eq(req, "content-type", "application/json")
            && body.get("version") == Some(&serde_json::json!(1))
            && body.get("files") == Some(&expected_files)
            && body
                .get("createdAt")
                .and_then(serde_json::Value::as_str)
                .is_some()
        {
            http_status(200)
        } else {
            http_status(400)
        }
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
        let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let expected_files = file_json_values(&files);
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

    #[tokio::test]
    async fn snapshot_uploads_archive_manifest_and_commits_new_version() -> Result<(), AgentError> {
        disable_system_log();
        let server = MockServer::start();

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
        let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let expected_files = file_json_values(&files);
        let archive_url = format!("{}/test/artifact-archive-upload", server.base_url());
        let manifest_url = format!("{}/test/artifact-manifest-upload", server.base_url());

        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare")
                .json_body(serde_json::json!({
                    "runId": "run-upload",
                    "storageName": "storage-upload",
                    "storageType": "artifact",
                    "files": expected_files,
                    "parentVersionId": "parent-v1",
                }));
            then.status(200).json_body(serde_json::json!({
                "versionId": "v-uploaded",
                "existing": false,
                "uploads": {
                    "archive": {
                        "key": "archive-key",
                        "presignedUrl": archive_url,
                    },
                    "manifest": {
                        "key": "manifest-key",
                        "presignedUrl": manifest_url,
                    },
                },
            }));
        });
        let archive_upload = server.mock(|when, then| {
            when.method(PUT)
                .path("/test/artifact-archive-upload")
                .header("Content-Type", "application/gzip");
            then.status(200);
        });
        let manifest_files = expected_files.clone();
        let manifest_upload = server.mock(|when, then| {
            when.method(PUT).path("/test/artifact-manifest-upload");
            then.respond_with(move |req| manifest_upload_response(req, &manifest_files));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit")
                .json_body(serde_json::json!({
                    "runId": "run-upload",
                    "storageName": "storage-upload",
                    "storageType": "artifact",
                    "versionId": "v-uploaded",
                    "parentVersionId": "parent-v1",
                    "files": expected_files,
                    "message": "snapshot message",
                }));
            then.status(200).json_body(serde_json::json!({
                "success": true,
                "versionId": "v-uploaded",
                "storageName": "storage-upload",
                "size": 5,
                "fileCount": 1,
            }));
        });

        let http = test_http_client(&server)?;
        let result = create_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: root.to_str().unwrap(),
                files,
                storage_name: "storage-upload",
                storage_type: "artifact",
                run_id: "run-upload",
                message: "snapshot message",
                parent_version_id: "parent-v1",
            },
        )
        .await?;

        assert_eq!(result.version_id, "v-uploaded");
        prepare.assert_calls(1);
        archive_upload.assert_calls(1);
        manifest_upload.assert_calls(1);
        commit.assert_calls(1);
        prepare.delete_async().await;
        archive_upload.delete_async().await;
        manifest_upload.delete_async().await;
        commit.delete_async().await;
        Ok(())
    }

    #[tokio::test]
    async fn snapshot_requires_upload_urls_for_new_version() -> Result<(), AgentError> {
        disable_system_log();
        let server = MockServer::start();

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
        let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let expected_files = file_json_values(&files);

        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare")
                .json_body(serde_json::json!({
                    "runId": "run-missing-uploads",
                    "storageName": "storage-missing-uploads",
                    "storageType": "artifact",
                    "files": expected_files,
                    "parentVersionId": "parent-v1",
                }));
            then.status(200).json_body(serde_json::json!({
                "versionId": "v-missing-uploads",
                "existing": false,
            }));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200)
                .json_body(serde_json::json!({ "success": true }));
        });

        let http = test_http_client(&server)?;
        let result = create_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: root.to_str().unwrap(),
                files,
                storage_name: "storage-missing-uploads",
                storage_type: "artifact",
                run_id: "run-missing-uploads",
                message: "snapshot message",
                parent_version_id: "parent-v1",
            },
        )
        .await;

        let Err(err) = result else {
            panic!("create_snapshot unexpectedly succeeded");
        };
        assert!(
            err.to_string()
                .contains("No upload URLs in prepare response")
        );
        prepare.assert_calls(1);
        commit.assert_calls(0);
        prepare.delete_async().await;
        commit.delete_async().await;
        Ok(())
    }
}
