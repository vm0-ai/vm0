use super::FileEntry;
use crate::constants;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::urls;
use api_contracts::generated::types::webhooks::agent::storages::{
    commit as storage_commit, prepare as storage_prepare,
};
use guest_common::log_warn;

const LOG_TAG: &str = "sandbox:guest-agent";

pub(super) struct PrepareSnapshotRequest<'a> {
    pub(super) run_id: &'a str,
    pub(super) storage_name: &'a str,
    pub(super) storage_type: &'a str,
    pub(super) files: &'a [FileEntry],
    pub(super) parent_version_id: &'a str,
}

pub(super) struct PreparedSnapshot {
    pub(super) version_id: String,
    pub(super) existing: bool,
    pub(super) uploads: Option<PreparedUploads>,
}

pub(super) struct PreparedUploads {
    pub(super) archive_url: String,
    pub(super) manifest_url: String,
}

pub(super) struct PrepareSnapshotError {
    error: AgentError,
    telemetry_error: Option<String>,
}

impl PrepareSnapshotError {
    pub(super) fn into_parts(self) -> (AgentError, Option<String>) {
        (self.error, self.telemetry_error)
    }
}

pub(super) struct CommitSnapshotRequest<'a> {
    pub(super) run_id: &'a str,
    pub(super) storage_name: &'a str,
    pub(super) storage_type: &'a str,
    pub(super) version_id: &'a str,
    pub(super) parent_version_id: &'a str,
    pub(super) files: &'a [FileEntry],
    pub(super) message: Option<&'a str>,
}

pub(super) async fn prepare_snapshot(
    http: &HttpClient,
    request: PrepareSnapshotRequest<'_>,
) -> Result<PreparedSnapshot, PrepareSnapshotError> {
    let payload = storage_prepare::Request {
        run_id: request.run_id.to_string(),
        storage_name: request.storage_name.to_string(),
        storage_type: request.storage_type.to_string(),
        files: to_prepare_files(request.files),
        parent_version_id: non_empty_string(request.parent_version_id),
        force: None,
        base_version: None,
        changes: None,
    };

    let response = match http
        .post_json(
            urls::storage_prepare_url(),
            &payload,
            constants::HTTP_MAX_RETRIES,
        )
        .await
    {
        Ok(Some(value)) => value,
        Ok(None) => {
            return Err(PrepareSnapshotError {
                error: AgentError::Checkpoint("Empty prepare response".into()),
                telemetry_error: None,
            });
        }
        Err(error) => {
            return Err(PrepareSnapshotError {
                error,
                telemetry_error: None,
            });
        }
    };

    let response: storage_prepare::Response =
        serde_json::from_value(response).map_err(|error| {
            let message = error.to_string();
            PrepareSnapshotError {
                error: AgentError::Checkpoint(message.clone()),
                telemetry_error: Some(message),
            }
        })?;

    Ok(PreparedSnapshot {
        version_id: response.version_id,
        existing: response.existing,
        uploads: response.uploads.map(|uploads| PreparedUploads {
            archive_url: uploads.archive.presigned_url,
            manifest_url: uploads.manifest.presigned_url,
        }),
    })
}

pub(super) async fn commit_snapshot(
    http: &HttpClient,
    request: CommitSnapshotRequest<'_>,
    parse_error_log: &str,
) -> Result<bool, AgentError> {
    let payload = storage_commit::Request {
        run_id: request.run_id.to_string(),
        storage_name: request.storage_name.to_string(),
        storage_type: request.storage_type.to_string(),
        version_id: request.version_id.to_string(),
        parent_version_id: non_empty_string(request.parent_version_id),
        files: to_commit_files(request.files),
        message: request.message.map(str::to_string),
    };

    let response = http
        .post_json(
            urls::storage_commit_url(),
            &payload,
            constants::HTTP_MAX_RETRIES,
        )
        .await?;

    Ok(response
        .map(|value| {
            serde_json::from_value::<storage_commit::Response>(value)
                .map(|commit| commit.success)
                .unwrap_or_else(|error| {
                    log_warn!(LOG_TAG, "{parse_error_log}: {error}");
                    false
                })
        })
        .unwrap_or(false))
}

fn non_empty_string(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn to_prepare_files(files: &[FileEntry]) -> Vec<storage_prepare::RequestFile> {
    files
        .iter()
        .map(|file| storage_prepare::RequestFile {
            path: file.path.clone(),
            hash: file.hash.clone(),
            size: file.size,
        })
        .collect()
}

fn to_commit_files(files: &[FileEntry]) -> Vec<storage_commit::RequestFile> {
    files
        .iter()
        .map(|file| storage_commit::RequestFile {
            path: file.path.clone(),
            hash: file.hash.clone(),
            size: file.size,
        })
        .collect()
}
