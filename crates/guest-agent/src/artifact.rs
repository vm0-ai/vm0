//! VAS artifact upload — SHA-256 hashing, tar.gz creation, S3 presigned upload.
//!
//! Flow:
//! 1. Walk directory, compute SHA-256 per file (skip `.git`, `.vm0`)
//! 2. POST `/storages/prepare` with file list → get presigned URLs
//! 3. If deduplicated, POST `/storages/commit` to update HEAD
//! 4. Create tar.gz archive
//! 5. Create manifest.json
//! 6. PUT archive + manifest to S3
//! 7. POST `/storages/commit`

use crate::constants;
use crate::error::AgentError;
use crate::http;
use crate::urls;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Serialize, Clone)]
struct FileEntry {
    path: String,
    hash: String,
    size: u64,
}

#[derive(Deserialize)]
struct PrepareResponse {
    #[serde(rename = "versionId")]
    version_id: Option<String>,
    existing: Option<bool>,
    uploads: Option<Uploads>,
}

#[derive(Deserialize)]
struct Uploads {
    archive: Option<UploadInfo>,
    manifest: Option<UploadInfo>,
}

#[derive(Deserialize)]
struct UploadInfo {
    #[serde(rename = "presignedUrl")]
    presigned_url: String,
}

#[derive(Deserialize)]
struct CommitResponse {
    success: Option<bool>,
}

pub struct SnapshotResult {
    pub version_id: String,
}

/// Create a VAS snapshot using direct S3 upload.
pub async fn create_snapshot(
    mount_path: &str,
    storage_name: &str,
    run_id: &str,
    message: &str,
) -> Result<SnapshotResult, AgentError> {
    log_info!(
        LOG_TAG,
        "Creating direct upload snapshot for '{storage_name}'"
    );

    // Step 1: Collect file metadata (blocking I/O)
    log_info!(LOG_TAG, "Computing file hashes...");
    let hash_start = std::time::Instant::now();
    let mount = mount_path.to_string();
    let files = tokio::task::spawn_blocking(move || collect_file_metadata(&mount))
        .await
        .map_err(|e| AgentError::Execution(format!("hash task panicked: {e}")))?;
    record_sandbox_op("artifact_hash_compute", hash_start.elapsed(), true, None);
    log_info!(LOG_TAG, "Found {} files", files.len());

    // Step 2: Prepare
    log_info!(LOG_TAG, "Calling prepare endpoint...");
    let prep_start = std::time::Instant::now();
    let prep_payload = json!({
        "storageName": storage_name,
        "storageType": "artifact",
        "files": files,
        "runId": run_id,
    });

    let prep_result = http::post_json(
        urls::storage_prepare_url(),
        &prep_payload,
        constants::HTTP_MAX_RETRIES,
    )
    .await;
    let prep_resp = match prep_result {
        Ok(Some(v)) => v,
        Ok(None) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint("Empty prepare response".into()));
        }
        Err(e) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(e);
        }
    };
    let prep: PrepareResponse =
        serde_json::from_value(prep_resp).map_err(|e| AgentError::Checkpoint(e.to_string()))?;

    let version_id = match prep.version_id {
        Some(id) => id,
        None => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint(
                "No versionId in prepare response".into(),
            ));
        }
    };
    record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), true, None);

    // Step 3: Deduplication check
    if prep.existing.unwrap_or(false) {
        log_info!(
            LOG_TAG,
            "Version already exists (deduplicated), updating HEAD"
        );
        let commit_payload = json!({
            "storageName": storage_name,
            "storageType": "artifact",
            "versionId": version_id,
            "files": files,
            "runId": run_id,
        });
        let resp = http::post_json(
            urls::storage_commit_url(),
            &commit_payload,
            constants::HTTP_MAX_RETRIES,
        )
        .await?;
        let commit: CommitResponse = resp
            .map(|v| {
                serde_json::from_value(v).unwrap_or_else(|e| {
                    log_warn!(LOG_TAG, "Failed to parse dedup commit response: {e}");
                    CommitResponse { success: None }
                })
            })
            .unwrap_or(CommitResponse { success: None });
        if commit.success != Some(true) {
            return Err(AgentError::Checkpoint("Failed to update HEAD".into()));
        }
        return Ok(SnapshotResult { version_id });
    }

    // Step 4: Get presigned URLs
    let uploads = prep
        .uploads
        .ok_or_else(|| AgentError::Checkpoint("No upload URLs in prepare response".into()))?;
    let archive_url = uploads
        .archive
        .ok_or_else(|| AgentError::Checkpoint("No archive upload info".into()))?
        .presigned_url;
    let manifest_url = uploads
        .manifest
        .ok_or_else(|| AgentError::Checkpoint("No manifest upload info".into()))?
        .presigned_url;

    // Step 5: Create archive + manifest in temp dir
    let temp_dir = tempfile::tempdir().map_err(AgentError::Io)?;
    let archive_path = temp_dir.path().join("archive.tar.gz");
    let manifest_path = temp_dir.path().join("manifest.json");

    // Create archive (blocking)
    log_info!(LOG_TAG, "Creating archive...");
    let arc_start = std::time::Instant::now();
    let mp = mount_path.to_string();
    let ap = archive_path.clone();
    let archive_ok = tokio::task::spawn_blocking(move || create_archive(&mp, &ap))
        .await
        .map_err(|e| AgentError::Execution(format!("archive task panicked: {e}")))?;
    if !archive_ok {
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

    // Step 6: Upload to S3
    log_info!(LOG_TAG, "Uploading archive to S3...");
    let s3_start = std::time::Instant::now();
    let archive_data = tokio::fs::read(&archive_path).await?;
    if let Err(e) = http::put_presigned(&archive_url, archive_data.into(), "application/gzip").await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }

    log_info!(LOG_TAG, "Uploading manifest to S3...");
    let manifest_data = tokio::fs::read(&manifest_path).await?;
    if let Err(e) =
        http::put_presigned(&manifest_url, manifest_data.into(), "application/json").await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }
    record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), true, None);

    // Step 7: Commit
    log_info!(LOG_TAG, "Calling commit endpoint...");
    let commit_start = std::time::Instant::now();
    let commit_payload = json!({
        "storageName": storage_name,
        "storageType": "artifact",
        "versionId": version_id,
        "files": files,
        "runId": run_id,
        "message": message,
    });
    let resp = match http::post_json(
        urls::storage_commit_url(),
        &commit_payload,
        constants::HTTP_MAX_RETRIES,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
            return Err(e);
        }
    };
    let commit: CommitResponse = resp
        .map(|v| {
            serde_json::from_value(v).unwrap_or_else(|e| {
                log_warn!(LOG_TAG, "Failed to parse commit response: {e}");
                CommitResponse { success: None }
            })
        })
        .unwrap_or(CommitResponse { success: None });

    if commit.success != Some(true) {
        record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Commit failed".into()));
    }

    record_sandbox_op("artifact_commit_api", commit_start.elapsed(), true, None);
    let short_id = version_id.get(..8).unwrap_or(&version_id);
    log_info!(LOG_TAG, "Direct upload snapshot created: {short_id}");

    Ok(SnapshotResult { version_id })
}

/// Walk directory and compute SHA-256 for each file, skipping `.git` and `.vm0`.
fn collect_file_metadata(dir_path: &str) -> Vec<FileEntry> {
    let mut files = Vec::new();
    walk_dir(dir_path, "", &mut files);
    files
}

fn walk_dir(current: &str, relative: &str, out: &mut Vec<FileEntry>) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == ".vm0" {
            continue;
        }
        let full = entry.path();
        let rel = if relative.is_empty() {
            name_str.to_string()
        } else {
            format!("{relative}/{name_str}")
        };

        if full.is_dir() {
            if let Some(s) = full.to_str() {
                walk_dir(s, &rel, out);
            }
        } else if full.is_file() {
            match compute_file_hash(&full) {
                Ok((hash, size)) => out.push(FileEntry {
                    path: rel,
                    hash,
                    size,
                }),
                Err(e) => {
                    log_warn!(LOG_TAG, "Could not process file {rel}: {e}");
                }
            }
        }
    }
}

fn compute_file_hash(path: &Path) -> Result<(String, u64), std::io::Error> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let Some(chunk) = buf.get(..n) else { break };
        hasher.update(chunk);
        total += n as u64;
    }
    let hash = format!("{:x}", hasher.finalize());
    Ok((hash, total))
}

/// Create a tar.gz archive of the directory, excluding `.git` and `.vm0`.
fn create_archive(dir_path: &str, tar_path: &Path) -> bool {
    let output = std::process::Command::new("tar")
        .args([
            "-czf",
            &tar_path.to_string_lossy(),
            "--exclude=.git",
            "--exclude=.vm0",
            "-C",
            dir_path,
            ".",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .status();
    match output {
        Ok(status) if status.success() => true,
        Ok(status) => {
            log_error!(
                LOG_TAG,
                "tar failed with exit code {}",
                status.code().unwrap_or(-1)
            );
            false
        }
        Err(e) => {
            log_error!(LOG_TAG, "Failed to create archive: {e}");
            false
        }
    }
}
