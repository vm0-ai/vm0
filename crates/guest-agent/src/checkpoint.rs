//! Checkpoint creation — reads session history and calls checkpoint API.

use crate::artifact;
use crate::constants;
use crate::content_hash;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use crate::session_history;
use crate::session_history_identity::{
    FinalSessionHistoryIdentityBuildError, build_final_session_history_identity,
};
use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, SESSION_HISTORY_ENCODING_GZIP,
    SESSION_HISTORY_ENCODING_IDENTITY, SESSION_HISTORY_ENCODING_ZSTD,
    SESSION_HISTORY_GZIP_MIN_BYTES,
};
use api_contracts::generated::types::{
    runners::storage::ArtifactEntryMissingRootPolicy, webhooks::agent::checkpoints,
};
use bytes::Bytes;
use flate2::{Compression, write::GzEncoder};
use futures_util::stream::{self, FuturesUnordered, StreamExt};
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use guest_session_prune::{ClaudeHistorySelection, select_claude_compact_generation};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LOG_TAG: &str = "sandbox:guest-agent";
const ARTIFACT_CHECKPOINT_CONCURRENCY: usize = 2;
const SESSION_HISTORY_ZSTD_LEVEL: i32 = 3;
const SESSION_HISTORY_COMPRESSION_MIN_BYTES: usize = SESSION_HISTORY_GZIP_MIN_BYTES as usize;

#[derive(Clone, Copy)]
enum CheckpointMode {
    Success,
    Recovery,
}

enum SessionHistoryUploadBody {
    Identity(Vec<u8>),
    Gzip { raw: Vec<u8>, gzip: Vec<u8> },
    Zstd { raw: Option<Vec<u8>>, zstd: Vec<u8> },
}

struct SessionHistoryUpload {
    raw_size: u64,
    body: SessionHistoryUploadBody,
}

struct PreparedSessionHistory {
    hash: String,
    raw_size: u64,
    upload_source: PreparedSessionHistoryUploadSource,
    live_history: PreparedLiveHistory,
}

enum PreparedLiveHistory {
    MatchesCheckpoint,
    ClaudeCandidate(Option<PendingClaudeHistoryReplacement>),
}

struct PendingClaudeHistoryReplacement {
    staged: tempfile::NamedTempFile,
    target: PathBuf,
}

impl PendingClaudeHistoryReplacement {
    fn stage(target: &Path, candidate: &[u8]) -> std::io::Result<Self> {
        let parent = target.parent().ok_or_else(|| {
            std::io::Error::new(
                ErrorKind::InvalidInput,
                "Claude session history path has no parent",
            )
        })?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)?;
        staged.write_all(candidate)?;
        staged.flush()?;
        Ok(Self {
            staged,
            target: target.to_path_buf(),
        })
    }

    fn persist(self) -> std::io::Result<()> {
        self.staged
            .persist(self.target)
            .map(|_| ())
            .map_err(|error| error.error)
    }
}

enum PreparedSessionHistoryUploadSource {
    Raw(Vec<u8>),
    ReusedCodexZstd(Vec<u8>),
}

impl PreparedSessionHistoryUploadSource {
    fn into_upload(self, raw_size: u64) -> Result<SessionHistoryUpload, AgentError> {
        match self {
            Self::Raw(history_bytes) => build_session_history_upload(history_bytes),
            Self::ReusedCodexZstd(zstd_bytes) => Ok(SessionHistoryUpload {
                raw_size,
                body: SessionHistoryUploadBody::Zstd {
                    raw: None,
                    zstd: zstd_bytes,
                },
            }),
        }
    }
}

struct DecodedSessionHistoryAnalysis {
    raw_size: u64,
    sha256_hex: String,
    line_count: Option<usize>,
    invalid_utf8: Option<String>,
    is_empty: bool,
    recovery_validation_error: Option<String>,
}

impl SessionHistoryUpload {
    fn requested_encoding(&self) -> &'static str {
        match self.body {
            SessionHistoryUploadBody::Identity(_) => SESSION_HISTORY_ENCODING_IDENTITY,
            SessionHistoryUploadBody::Gzip { .. } => SESSION_HISTORY_ENCODING_GZIP,
            SessionHistoryUploadBody::Zstd { .. } => SESSION_HISTORY_ENCODING_ZSTD,
        }
    }

    fn encoded_size(&self) -> u64 {
        match &self.body {
            SessionHistoryUploadBody::Identity(raw) => raw.len() as u64,
            SessionHistoryUploadBody::Gzip { gzip, .. } => gzip.len() as u64,
            SessionHistoryUploadBody::Zstd { zstd, .. } => zstd.len() as u64,
        }
    }

    fn into_raw(self) -> Result<Vec<u8>, AgentError> {
        match self.body {
            SessionHistoryUploadBody::Identity(raw)
            | SessionHistoryUploadBody::Gzip { raw, .. }
            | SessionHistoryUploadBody::Zstd { raw: Some(raw), .. } => Ok(raw),
            SessionHistoryUploadBody::Zstd { raw: None, zstd } => {
                unzstd_session_history_upload_body(&zstd, self.raw_size)
            }
        }
    }

    fn into_server_accepted_bytes(
        self,
        accepted_encoding: Option<&str>,
    ) -> Result<SessionHistoryServerAcceptedBytes, AgentError> {
        match self.body {
            SessionHistoryUploadBody::Identity(raw) => {
                Ok(SessionHistoryServerAcceptedBytes::Accepted {
                    encoding: SESSION_HISTORY_ENCODING_IDENTITY,
                    bytes: Bytes::from(raw),
                })
            }
            SessionHistoryUploadBody::Gzip { raw: _, gzip }
                if accepted_encoding == Some(SESSION_HISTORY_ENCODING_GZIP) =>
            {
                Ok(SessionHistoryServerAcceptedBytes::Accepted {
                    encoding: SESSION_HISTORY_ENCODING_GZIP,
                    bytes: Bytes::from(gzip),
                })
            }
            SessionHistoryUploadBody::Gzip { .. } => Err(compressed_encoding_not_acknowledged(
                SESSION_HISTORY_ENCODING_GZIP,
            )),
            SessionHistoryUploadBody::Zstd { raw: _, zstd }
                if accepted_encoding == Some(SESSION_HISTORY_ENCODING_ZSTD) =>
            {
                Ok(SessionHistoryServerAcceptedBytes::Accepted {
                    encoding: SESSION_HISTORY_ENCODING_ZSTD,
                    bytes: Bytes::from(zstd),
                })
            }
            SessionHistoryUploadBody::Zstd { raw, zstd } => {
                let raw = match raw {
                    Some(raw) => raw,
                    None => unzstd_session_history_upload_body(&zstd, self.raw_size)?,
                };
                Ok(SessionHistoryServerAcceptedBytes::UnsupportedZstd { raw })
            }
        }
    }
}

enum SessionHistoryServerAcceptedBytes {
    Accepted {
        encoding: &'static str,
        bytes: Bytes,
    },
    UnsupportedZstd {
        raw: Vec<u8>,
    },
}

enum SessionHistoryUploadAttempt {
    Complete,
    RetryLegacy(Vec<u8>),
}

fn gzip_session_history(history_bytes: &[u8]) -> Result<Vec<u8>, AgentError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(history_bytes)
        .map_err(|error| AgentError::Checkpoint(format!("gzip session history: {error}")))?;
    encoder
        .finish()
        .map_err(|error| AgentError::Checkpoint(format!("finish gzip session history: {error}")))
}

fn build_session_history_upload(
    history_bytes: Vec<u8>,
) -> Result<SessionHistoryUpload, AgentError> {
    let raw_size = history_bytes.len() as u64;
    if history_bytes.len() < SESSION_HISTORY_COMPRESSION_MIN_BYTES {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    let zstd_bytes = zstd_session_history(&history_bytes)?;
    if zstd_bytes.len() >= history_bytes.len() {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    Ok(SessionHistoryUpload {
        raw_size,
        body: SessionHistoryUploadBody::Zstd {
            raw: Some(history_bytes),
            zstd: zstd_bytes,
        },
    })
}

fn build_legacy_session_history_upload(
    history_bytes: Vec<u8>,
) -> Result<SessionHistoryUpload, AgentError> {
    let raw_size = history_bytes.len() as u64;
    if history_bytes.len() < SESSION_HISTORY_COMPRESSION_MIN_BYTES {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    let gzip_bytes = gzip_session_history(&history_bytes)?;
    if gzip_bytes.len() >= history_bytes.len() {
        return Err(AgentError::Checkpoint(
            "legacy gzip session history was not smaller than identity".into(),
        ));
    }

    Ok(SessionHistoryUpload {
        raw_size,
        body: SessionHistoryUploadBody::Gzip {
            raw: history_bytes,
            gzip: gzip_bytes,
        },
    })
}

fn zstd_session_history(history_bytes: &[u8]) -> Result<Vec<u8>, AgentError> {
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), SESSION_HISTORY_ZSTD_LEVEL)
        .map_err(|error| AgentError::Checkpoint(format!("zstd session history: {error}")))?;
    encoder
        .write_all(history_bytes)
        .map_err(|error| AgentError::Checkpoint(format!("zstd session history: {error}")))?;
    encoder
        .finish()
        .map_err(|error| AgentError::Checkpoint(format!("finish zstd session history: {error}")))
}

fn compressed_encoding_not_acknowledged(requested_encoding: &'static str) -> AgentError {
    AgentError::Checkpoint(format!(
        "Prepare-history response did not acknowledge {requested_encoding} session history"
    ))
}

fn unzstd_session_history_upload_body(
    zstd_bytes: &[u8],
    raw_size: u64,
) -> Result<Vec<u8>, AgentError> {
    let decoder = zstd::stream::read::Decoder::new(zstd_bytes)
        .map_err(|error| AgentError::Checkpoint(format!("zstd session history: {error}")))?;
    let mut reader = decoder.take(raw_size.saturating_add(1));
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| AgentError::Checkpoint(format!("zstd session history: {error}")))?;
    if bytes.len() as u64 != raw_size {
        return Err(AgentError::Checkpoint(format!(
            "Decoded zstd session history size mismatch: expected {raw_size}, got {}",
            bytes.len()
        )));
    }
    Ok(bytes)
}

impl CheckpointMode {
    fn total_op(self) -> &'static str {
        match self {
            Self::Success => "checkpoint_total",
            Self::Recovery => "recovery_checkpoint_total",
        }
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Success => "checkpoint",
            Self::Recovery => "recovery checkpoint",
        }
    }

    fn validate_history(self) -> bool {
        matches!(self, Self::Recovery)
    }

    fn can_prune_claude_history(self) -> bool {
        matches!(self, Self::Success)
    }
}

/// Log the message, record a failed `sandbox_op`, and build a matching
/// `Checkpoint` error. Success-path checkpoint failures are run-fatal and
/// logged as errors; recovery checkpoint skips are best-effort and stay warn.
fn fail(
    mode: CheckpointMode,
    op: &str,
    start: std::time::Instant,
    msg: impl Into<String>,
) -> AgentError {
    let msg = msg.into();
    record_failure(mode, op, start, &msg);
    AgentError::Checkpoint(msg)
}

fn fail_preserving_error(
    mode: CheckpointMode,
    op: &str,
    start: std::time::Instant,
    error: AgentError,
) -> AgentError {
    record_failure(mode, op, start, &error.to_string());
    error
}

fn record_failure(mode: CheckpointMode, op: &str, start: std::time::Instant, msg: &str) {
    match mode {
        CheckpointMode::Success => log_error!(LOG_TAG, "{msg}"),
        CheckpointMode::Recovery => log_warn!(LOG_TAG, "{msg}"),
    }
    record_sandbox_op(op, start.elapsed(), false, Some(msg));
}

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
        files: Vec<artifact::FileEntry>,
    },
    PreserveParentVersion {
        entry: &'a env::ArtifactEnv,
    },
}

async fn build_artifact_snapshot_plan(
    entry: &env::ArtifactEnv,
) -> Result<ArtifactSnapshotPlan<'_>, artifact::WalkFilesError> {
    log_info!(
        LOG_TAG,
        "Processing artifact '{}' at {}",
        entry.name,
        entry.mount_path
    );
    match artifact::walk_files_for_checkpoint(&entry.mount_path).await {
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
    let snapshot = artifact::create_snapshot(
        http,
        artifact::CreateSnapshotRequest {
            mount_path: &entry.mount_path,
            files,
            storage_id: &entry.storage_id,
            storage_name: &entry.name,
            storage_type: "artifact",
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

struct CheckpointInputs<'a> {
    run_id: &'a str,
    framework: env::Framework,
    home_dir: &'a str,
    artifact_entries: &'a [env::ArtifactEnv],
    session_id_file: Cow<'a, str>,
    session_history_path_file: Cow<'a, str>,
    final_session_history_identity_file: Cow<'a, str>,
}

impl<'a> CheckpointInputs<'a> {
    fn from_runtime(runtime: &'a GuestRuntime) -> Self {
        Self {
            run_id: &runtime.config.run_id,
            framework: runtime.config.framework,
            home_dir: &runtime.config.home_dir,
            artifact_entries: &runtime.config.artifacts,
            session_id_file: Cow::Borrowed(runtime.paths.session_id_file()),
            session_history_path_file: Cow::Borrowed(runtime.paths.session_history_path_file()),
            final_session_history_identity_file: Cow::Borrowed(
                runtime.paths.final_session_history_identity_file(),
            ),
        }
    }
}

fn is_zstd_prepare_compatibility_rejection(error: &AgentError) -> bool {
    matches!(error, AgentError::HttpStatus { status: 400, .. })
}

/// Prepare + upload one session history candidate to S3 via a presigned URL. If
/// the prepare endpoint reports `existing=true`, skip the upload
/// (content-addressed dedup). Telemetry is recorded under
/// `session_history_prepare` and `session_history_s3_upload` to match the
/// pre-parallelization op names.
async fn upload_session_history_candidate(
    http: &HttpClient,
    run_id: &str,
    history_hash: &str,
    history_upload: SessionHistoryUpload,
) -> Result<SessionHistoryUploadAttempt, AgentError> {
    let prep_start = std::time::Instant::now();
    let url = http.checkpoint_prepare_history_url()?;
    let requested_encoding = history_upload.requested_encoding();
    let encoded_size = history_upload.encoded_size();
    let prep_resp = match http
        .post_json(
            url,
            &json!({
                "runId": run_id,
                "hash": history_hash,
                "rawSize": history_upload.raw_size,
                "encodedSize": encoded_size,
                "encoding": requested_encoding,
            }),
            constants::HTTP_MAX_ATTEMPTS,
        )
        .await
    {
        Ok(Some(v)) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), true, None);
            v
        }
        Ok(None) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint(
                "Empty prepare-history response".into(),
            ));
        }
        Err(e) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), false, None);
            if requested_encoding == SESSION_HISTORY_ENCODING_ZSTD
                && is_zstd_prepare_compatibility_rejection(&e)
            {
                log_info!(
                    LOG_TAG,
                    "Prepare-history rejected zstd session history; retrying legacy encoding"
                );
                return Ok(SessionHistoryUploadAttempt::RetryLegacy(
                    history_upload.into_raw()?,
                ));
            }
            return Err(e);
        }
    };

    let existing = prep_resp
        .get("existing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let response_encoding = prep_resp.get("encoding").and_then(|v| v.as_str());
    if requested_encoding == SESSION_HISTORY_ENCODING_ZSTD
        && response_encoding != Some(SESSION_HISTORY_ENCODING_ZSTD)
    {
        log_info!(
            LOG_TAG,
            "Prepare-history response did not acknowledge zstd; retrying legacy encoding"
        );
        return Ok(SessionHistoryUploadAttempt::RetryLegacy(
            history_upload.into_raw()?,
        ));
    }
    if requested_encoding == SESSION_HISTORY_ENCODING_GZIP
        && response_encoding != Some(SESSION_HISTORY_ENCODING_GZIP)
    {
        return Err(compressed_encoding_not_acknowledged(
            SESSION_HISTORY_ENCODING_GZIP,
        ));
    }

    if existing {
        let accepted_encoding = response_encoding.unwrap_or(SESSION_HISTORY_ENCODING_IDENTITY);
        log_info!(
            LOG_TAG,
            "Session history already exists in S3 (deduplicated, encoding={accepted_encoding})"
        );
        return Ok(SessionHistoryUploadAttempt::Complete);
    }

    let presigned_url = prep_resp
        .get("presignedUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AgentError::Checkpoint("No presignedUrl in prepare-history response".into())
        })?;

    let (upload_encoding, upload_bytes) =
        match history_upload.into_server_accepted_bytes(response_encoding)? {
            SessionHistoryServerAcceptedBytes::Accepted { encoding, bytes } => (encoding, bytes),
            SessionHistoryServerAcceptedBytes::UnsupportedZstd { raw } => {
                return Ok(SessionHistoryUploadAttempt::RetryLegacy(raw));
            }
        };

    log_info!(
        LOG_TAG,
        "Uploading session history to S3 (encoding={upload_encoding})..."
    );
    let upload_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned(presigned_url, upload_bytes, "application/octet-stream")
        .await
    {
        record_sandbox_op(
            "session_history_s3_upload",
            upload_start.elapsed(),
            false,
            None,
        );
        return Err(e);
    }
    record_sandbox_op(
        "session_history_s3_upload",
        upload_start.elapsed(),
        true,
        None,
    );
    log_info!(LOG_TAG, "Session history uploaded to S3");
    Ok(SessionHistoryUploadAttempt::Complete)
}

async fn build_and_upload_session_history(
    http: &HttpClient,
    run_id: &str,
    history_hash: &str,
    history_size: u64,
    upload_source: PreparedSessionHistoryUploadSource,
) -> Result<(), AgentError> {
    let history_upload = upload_source.into_upload(history_size)?;
    match upload_session_history_candidate(http, run_id, history_hash, history_upload).await? {
        SessionHistoryUploadAttempt::Complete => Ok(()),
        SessionHistoryUploadAttempt::RetryLegacy(history_bytes) => {
            let legacy_upload = build_legacy_session_history_upload(history_bytes)?;
            match upload_session_history_candidate(http, run_id, history_hash, legacy_upload)
                .await?
            {
                SessionHistoryUploadAttempt::Complete => Ok(()),
                SessionHistoryUploadAttempt::RetryLegacy(_) => Err(AgentError::Checkpoint(
                    "Legacy session history upload unexpectedly requested zstd fallback".into(),
                )),
            }
        }
    }
}

/// Snapshot artifact entries. Memory rides in `VM0_ARTIFACTS` post-#10602, so
/// there is no longer a separate memory arm. The generated checkpoint
/// contract preserves the optional missing-root policy for every snapshot
/// path.
async fn snapshot_artifact_entries(
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
        .map(|(_, result)| result.map_err(artifact::WalkFilesError::into_agent_error))
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

/// Create a checkpoint after a successful run using the explicit runtime snapshot.
pub async fn create_checkpoint_for_runtime(runtime: &GuestRuntime) -> Result<(), AgentError> {
    let inputs = CheckpointInputs::from_runtime(runtime);
    create_checkpoint_with_inputs(&runtime.http, &inputs).await
}

/// Create a best-effort recovery checkpoint using the explicit runtime snapshot.
pub async fn create_recovery_checkpoint_for_runtime(
    runtime: &GuestRuntime,
) -> Result<(), AgentError> {
    let inputs = CheckpointInputs::from_runtime(runtime);
    create_recovery_checkpoint_with_inputs(&runtime.http, &inputs).await
}

async fn create_checkpoint_with_inputs(
    http: &HttpClient,
    inputs: &CheckpointInputs<'_>,
) -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(http, CheckpointMode::Success, inputs).await;
    record_sandbox_op(
        CheckpointMode::Success.total_op(),
        start.elapsed(),
        result.is_ok(),
        None,
    );
    result
}

async fn create_recovery_checkpoint_with_inputs(
    http: &HttpClient,
    inputs: &CheckpointInputs<'_>,
) -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(http, CheckpointMode::Recovery, inputs).await;
    record_sandbox_op(
        CheckpointMode::Recovery.total_op(),
        start.elapsed(),
        result.is_ok(),
        None,
    );
    result
}

fn prepare_session_history(
    mode: CheckpointMode,
    framework: env::Framework,
    cli_agent_session_id: &str,
    history_marker_payload: &str,
    history_read_start: std::time::Instant,
) -> Result<PreparedSessionHistory, AgentError> {
    if mode.can_prune_claude_history()
        && framework == env::Framework::ClaudeCode
        && !session_history::is_codex_marker(history_marker_payload)
    {
        let prune_start = std::time::Instant::now();
        match select_claude_compact_generation(history_marker_payload, cli_agent_session_id) {
            Ok(ClaudeHistorySelection::Candidate(candidate)) => {
                let source_size = candidate.source_size();
                let candidate_size = candidate.candidate_size();
                let candidate = candidate.into_bytes();
                let replacement = PendingClaudeHistoryReplacement::stage(
                    Path::new(history_marker_payload),
                    &candidate,
                )
                .ok();
                log_info!(
                    LOG_TAG,
                    "Selected Claude compact generation for checkpoint \
                     (source_size={source_size}, candidate_size={candidate_size})"
                );
                record_sandbox_op("session_history_prune", prune_start.elapsed(), true, None);
                let mut prepared =
                    prepare_raw_session_history(mode, history_read_start, candidate)?;
                prepared.live_history = PreparedLiveHistory::ClaudeCandidate(replacement);
                return Ok(prepared);
            }
            Ok(ClaudeHistorySelection::Ineligible(reason)) => {
                log_info!(
                    LOG_TAG,
                    "Claude session history not eligible for pruning: {}",
                    reason.as_str()
                );
                record_sandbox_op("session_history_prune", prune_start.elapsed(), true, None);
            }
            Err(error) => {
                log_warn!(
                    LOG_TAG,
                    "Claude session history selector failed; using ordinary checkpoint path: {error}"
                );
                record_sandbox_op(
                    "session_history_prune",
                    prune_start.elapsed(),
                    false,
                    Some("selector_io"),
                );
            }
        }
    }

    let source = match session_history::read_session_history_checkpoint_source_from_payload_bounded(
        history_marker_payload,
        RESUME_SESSION_HISTORY_MAX_BYTES,
    ) {
        Ok(source) => source,
        Err(e) => {
            return Err(fail_preserving_error(
                mode,
                "session_history_read",
                history_read_start,
                e,
            ));
        }
    };
    match source {
        session_history::SessionHistoryCheckpointSource::Decoded(history_bytes) => {
            prepare_raw_session_history(mode, history_read_start, history_bytes)
        }
        session_history::SessionHistoryCheckpointSource::CodexZstd { encoded } => {
            prepare_reused_zstd_session_history(mode, history_read_start, encoded)
        }
    }
}

fn prepare_raw_session_history(
    mode: CheckpointMode,
    history_read_start: std::time::Instant,
    history_bytes: Vec<u8>,
) -> Result<PreparedSessionHistory, AgentError> {
    let history_size = history_bytes.len() as u64;

    let session_history_text = match std::str::from_utf8(&history_bytes) {
        Ok(s) => Some(s),
        Err(e) => {
            let msg = format!("Session history is not valid UTF-8: {e}");
            if mode.validate_history() {
                return Err(fail(mode, "session_history_read", history_read_start, msg));
            }
            log_warn!(LOG_TAG, "{msg}; preserving raw bytes for checkpoint");
            None
        }
    };

    let history_is_empty = session_history_text.map_or_else(
        || history_bytes.iter().all(|byte| byte.is_ascii_whitespace()),
        |session_history| session_history.trim().is_empty(),
    );
    if history_is_empty {
        return Err(fail(
            mode,
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    if let Some(session_history) = session_history_text {
        if mode.validate_history() {
            validate_recoverable_session_history(session_history)
                .map_err(|msg| fail(mode, "session_history_validate", history_read_start, msg))?;
        }

        let line_count = session_history.lines().count();
        log_info!(LOG_TAG, "Session history loaded ({line_count} lines)");
    } else {
        log_info!(
            LOG_TAG,
            "Session history loaded ({} raw bytes, invalid UTF-8)",
            history_bytes.len()
        );
    }
    record_sandbox_op(
        "session_history_read",
        history_read_start.elapsed(),
        true,
        None,
    );

    let history_hash = hex::encode(Sha256::digest(&history_bytes));
    log_info!(
        LOG_TAG,
        "Session history hash={}, size={history_size}",
        &history_hash[..8]
    );
    Ok(PreparedSessionHistory {
        hash: history_hash,
        raw_size: history_size,
        upload_source: PreparedSessionHistoryUploadSource::Raw(history_bytes),
        live_history: PreparedLiveHistory::MatchesCheckpoint,
    })
}

fn prepare_reused_zstd_session_history(
    mode: CheckpointMode,
    history_read_start: std::time::Instant,
    zstd_bytes: Vec<u8>,
) -> Result<PreparedSessionHistory, AgentError> {
    let analysis = analyze_zstd_session_history(
        &zstd_bytes,
        RESUME_SESSION_HISTORY_MAX_BYTES,
        mode.validate_history(),
    )
    .map_err(|e| fail_preserving_error(mode, "session_history_read", history_read_start, e))?;

    if let Some(msg) = &analysis.invalid_utf8 {
        if mode.validate_history() {
            return Err(fail(mode, "session_history_read", history_read_start, msg));
        }
        log_warn!(LOG_TAG, "{msg}; preserving session history for checkpoint");
    }

    if analysis.is_empty {
        return Err(fail(
            mode,
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    if mode.validate_history()
        && let Some(msg) = analysis.recovery_validation_error
    {
        return Err(fail(
            mode,
            "session_history_validate",
            history_read_start,
            msg,
        ));
    }

    if let Some(line_count) = analysis.line_count {
        log_info!(LOG_TAG, "Session history loaded ({line_count} lines)");
    } else {
        log_info!(
            LOG_TAG,
            "Session history loaded ({} raw bytes, invalid UTF-8)",
            analysis.raw_size
        );
    }
    record_sandbox_op(
        "session_history_read",
        history_read_start.elapsed(),
        true,
        None,
    );

    log_info!(
        LOG_TAG,
        "Session history hash={}, size={}",
        &analysis.sha256_hex[..8],
        analysis.raw_size
    );
    Ok(PreparedSessionHistory {
        hash: analysis.sha256_hex,
        raw_size: analysis.raw_size,
        upload_source: PreparedSessionHistoryUploadSource::ReusedCodexZstd(zstd_bytes),
        live_history: PreparedLiveHistory::MatchesCheckpoint,
    })
}

fn analyze_zstd_session_history(
    zstd_bytes: &[u8],
    max_bytes: u64,
    validate_history: bool,
) -> Result<DecodedSessionHistoryAnalysis, AgentError> {
    let decoder = zstd::stream::read::Decoder::new(zstd_bytes).map_err(|error| {
        AgentError::Checkpoint(format!(
            "Failed to decompress zstd session history: {error}"
        ))
    })?;
    analyze_decoded_session_history_reader(
        BufReader::new(decoder.take(max_bytes.saturating_add(1))),
        max_bytes,
        validate_history,
    )
}

fn analyze_decoded_session_history_reader(
    mut reader: impl BufRead,
    max_bytes: u64,
    validate_history: bool,
) -> Result<DecodedSessionHistoryAnalysis, AgentError> {
    let mut hasher = Sha256::new();
    let mut raw_size = 0u64;
    let mut line_count = 0usize;
    let mut all_bytes_ascii_whitespace = true;
    let mut all_utf8_lines_trim_empty = true;
    let mut invalid_utf8 = None;
    let mut recovery_validation_error = None;
    let mut line = Vec::new();

    loop {
        line.clear();
        let bytes_read = reader.read_until(b'\n', &mut line).map_err(|error| {
            AgentError::Checkpoint(format!(
                "Failed to decompress zstd session history: {error}"
            ))
        })?;
        if bytes_read == 0 {
            break;
        }

        raw_size = raw_size.checked_add(bytes_read as u64).ok_or(
            session_history::session_history_exceeds_max_error(max_bytes),
        )?;
        if raw_size > max_bytes {
            return Err(session_history::session_history_exceeds_max_error(
                max_bytes,
            ));
        }
        hasher.update(&line);
        if line.iter().any(|byte| !byte.is_ascii_whitespace()) {
            all_bytes_ascii_whitespace = false;
        }

        let logical_line = strip_jsonl_line_ending(&line);
        match std::str::from_utf8(logical_line) {
            Ok(text) => {
                line_count += 1;
                if !text.trim().is_empty() {
                    all_utf8_lines_trim_empty = false;
                }
                if validate_history
                    && recovery_validation_error.is_none()
                    && let Err(error) = validate_recoverable_session_history_line(line_count, text)
                {
                    recovery_validation_error = Some(error);
                }
            }
            Err(error) => {
                invalid_utf8
                    .get_or_insert_with(|| format!("Session history is not valid UTF-8: {error}"));
            }
        }
    }

    let is_empty = if invalid_utf8.is_some() {
        all_bytes_ascii_whitespace
    } else {
        all_utf8_lines_trim_empty
    };
    Ok(DecodedSessionHistoryAnalysis {
        raw_size,
        sha256_hex: hex::encode(hasher.finalize()),
        line_count: invalid_utf8.is_none().then_some(line_count),
        invalid_utf8,
        is_empty,
        recovery_validation_error,
    })
}

fn strip_jsonl_line_ending(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

async fn create_checkpoint_impl(
    http: &HttpClient,
    mode: CheckpointMode,
    inputs: &CheckpointInputs<'_>,
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Creating {}...", mode.log_label());

    // Read the CLI agent session id. Let `read_to_string` surface `NotFound`
    // directly — an explicit `exists()` check would be a redundant stat plus a
    // TOCTOU race between check and read.
    let session_id_start = std::time::Instant::now();
    let cli_agent_session_id = match std::fs::read_to_string(inputs.session_id_file.as_ref()) {
        Ok(s) => s.trim().to_string(),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(fail(
                mode,
                "session_id_read",
                session_id_start,
                "No session ID found",
            ));
        }
        Err(e) => {
            return Err(fail(
                mode,
                "session_id_read",
                session_id_start,
                format!("Failed to read session ID: {e}"),
            ));
        }
    };
    if cli_agent_session_id.is_empty() {
        return Err(fail(
            mode,
            "session_id_read",
            session_id_start,
            "Session ID is empty",
        ));
    }
    record_sandbox_op("session_id_read", session_id_start.elapsed(), true, None);

    // Read session history. The persisted or derived marker payload is either
    // a literal jsonl path (Claude) or a codex marker. `session_history`
    // resolves Codex session files and preserves already-compressed zstd
    // sources when possible.
    let history_read_start = std::time::Instant::now();
    let history_marker_payload = match crate::session_metadata::resolve_history_marker_payload_from(
        inputs.framework,
        inputs.home_dir,
        inputs.session_history_path_file.as_ref(),
        &cli_agent_session_id,
    ) {
        Ok(payload) => payload,
        Err(e) => {
            return Err(fail(
                mode,
                "session_history_read",
                history_read_start,
                e.to_string(),
            ));
        }
    };
    let prepared_history = prepare_session_history(
        mode,
        inputs.framework,
        &cli_agent_session_id,
        &history_marker_payload,
        history_read_start,
    )?;
    let PreparedSessionHistory {
        hash: history_hash,
        raw_size: history_size,
        upload_source,
        live_history,
    } = prepared_history;

    // History upload and artifact snapshots are independent pre-requisites
    // of the final checkpoint API call, so run them concurrently. The history
    // path is web-API bound (prepare + S3 PUT); the artifact path is VAS-bound
    // (prepare + HEAD update). Serial, wall time was dominated by whichever
    // was longer plus the other; concurrent, it's just the longer one.
    let (artifact_snapshots, _) = tokio::try_join!(
        snapshot_artifact_entries(http, inputs.run_id, inputs.artifact_entries),
        build_and_upload_session_history(
            http,
            inputs.run_id,
            &history_hash,
            history_size,
            upload_source,
        ),
    )?;

    // Build and send checkpoint payload (session history hash only, content uploaded to S3)
    let cli_agent_type = inputs.framework.agent_type();
    let payload = checkpoints::Request {
        run_id: inputs.run_id.to_string(),
        cli_agent_type: cli_agent_type.to_string(),
        cli_agent_session_id,
        cli_agent_session_history_hash: history_hash,
        artifact_snapshots,
        volume_versions_snapshot: None,
    };

    log_info!(LOG_TAG, "Calling checkpoint API...");
    let api_start = std::time::Instant::now();
    let url = http.checkpoint_url()?;
    let result = match http
        .post_json(url, &payload, constants::HTTP_MAX_ATTEMPTS)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            record_sandbox_op("checkpoint_api_call", api_start.elapsed(), false, None);
            return Err(e);
        }
    };

    // Validate response
    let checkpoint_id = result
        .as_ref()
        .and_then(|v| v.get("checkpointId"))
        .and_then(|v| v.as_str());

    if let Some(id) = checkpoint_id {
        if reconcile_live_history_after_checkpoint(live_history) {
            write_final_session_history_identity(
                mode,
                &payload.cli_agent_session_id,
                &payload.cli_agent_session_history_hash,
                history_size,
                &history_marker_payload,
                inputs.framework,
                inputs.final_session_history_identity_file.as_ref(),
            );
        }
        log_info!(LOG_TAG, "{} created successfully: {id}", mode.log_label());
        record_sandbox_op("checkpoint_api_call", api_start.elapsed(), true, None);
        Ok(())
    } else {
        Err(fail(
            mode,
            "checkpoint_api_call",
            api_start,
            "Invalid checkpoint API response",
        ))
    }
}

fn reconcile_live_history_after_checkpoint(live_history: PreparedLiveHistory) -> bool {
    let started_at = std::time::Instant::now();
    match live_history {
        PreparedLiveHistory::MatchesCheckpoint => true,
        PreparedLiveHistory::ClaudeCandidate(Some(replacement)) => {
            if replacement.persist().is_ok() {
                record_sandbox_op(
                    "session_history_prune_reconcile",
                    started_at.elapsed(),
                    true,
                    None,
                );
                log_info!(
                    LOG_TAG,
                    "Replaced live Claude session history with committed compact generation"
                );
                true
            } else {
                record_sandbox_op(
                    "session_history_prune_reconcile",
                    started_at.elapsed(),
                    false,
                    Some("replace_failed"),
                );
                log_warn!(
                    LOG_TAG,
                    "Failed to reconcile committed Claude compact generation into live session \
                     history; next resume will restore checkpoint history"
                );
                false
            }
        }
        PreparedLiveHistory::ClaudeCandidate(None) => {
            record_sandbox_op(
                "session_history_prune_reconcile",
                started_at.elapsed(),
                false,
                Some("stage_failed"),
            );
            log_warn!(
                LOG_TAG,
                "Failed to reconcile committed Claude compact generation into live session \
                 history; next resume will restore checkpoint history"
            );
            false
        }
    }
}

fn write_final_session_history_identity(
    mode: CheckpointMode,
    cli_agent_session_id: &str,
    history_hash: &str,
    history_size: u64,
    history_marker_payload: &str,
    framework: env::Framework,
    final_session_history_identity_file: &str,
) {
    if !matches!(mode, CheckpointMode::Success) {
        return;
    }
    let identity = match build_final_session_history_identity(
        framework,
        cli_agent_session_id,
        history_hash,
        history_size,
        history_marker_payload,
    ) {
        Ok(identity) => identity,
        Err(error) => {
            match error {
                FinalSessionHistoryIdentityBuildError::InvalidSessionId => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_session_id",
                    Duration::ZERO,
                    true,
                    None,
                ),
                FinalSessionHistoryIdentityBuildError::InvalidMetadata(_) => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_metadata",
                    Duration::ZERO,
                    true,
                    None,
                ),
            }
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    let bytes = match identity.to_json_vec() {
        Ok(bytes) => bytes,
        Err(error) => {
            record_sandbox_op(
                "session_history_identity_write_skipped_invalid_metadata",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    match crate::paths::write_private(final_session_history_identity_file, bytes) {
        Ok(()) => {
            record_sandbox_op(
                "session_history_identity_written",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity written");
        }
        Err(_) => {
            record_sandbox_op(
                "session_history_identity_write_failed",
                Duration::ZERO,
                false,
                None,
            );
            log_warn!(LOG_TAG, "Failed to write final session history identity");
        }
    }
}

fn validate_recoverable_session_history(session_history: &str) -> Result<(), String> {
    let mut line_count = 0usize;
    for (index, line) in session_history.lines().enumerate() {
        validate_recoverable_session_history_line(index + 1, line)?;
        line_count += 1;
    }

    if line_count == 0 {
        return Err("Session history has no JSONL entries; recovery checkpoint skipped".into());
    }

    Ok(())
}

fn validate_recoverable_session_history_line(index: usize, line: &str) -> Result<(), String> {
    if line.trim().is_empty() {
        return Err(format!(
            "Session history line {index} is empty; recovery checkpoint skipped"
        ));
    }
    serde_json::from_str::<serde_json::Value>(line).map_err(|e| {
        format!("Session history line {index} is not valid JSON; recovery checkpoint skipped: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
    use httpmock::prelude::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const REQUEST_OVERLAP_TIMEOUT: Duration = Duration::from_secs(5);

    #[test]
    fn checkpoint_failure_recording_preserves_typed_history_limit_error() {
        let error = fail_preserving_error(
            CheckpointMode::Success,
            "session_history_read",
            std::time::Instant::now(),
            AgentError::CheckpointHistoryTooLarge { max_bytes: 1 },
        );
        assert!(matches!(
            error,
            AgentError::CheckpointHistoryTooLarge { max_bytes: 1 }
        ));
    }

    #[test]
    fn zstd_checkpoint_analysis_returns_typed_history_limit_error() {
        let encoded = zstd_session_history(b"{}\n").unwrap();
        let error = match analyze_zstd_session_history(&encoded, 1, false) {
            Ok(_) => panic!("expected zstd history to exceed the decoded limit"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            AgentError::CheckpointHistoryTooLarge { max_bytes: 1 }
        ));
    }

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
                let storage_name = payload["storageName"].as_str().unwrap().to_string();
                prepare_requests.push((socket, storage_name));
            }
            let prepare_names = prepare_requests
                .iter()
                .map(|(_, storage_name)| storage_name.clone())
                .collect();
            for (mut socket, storage_name) in prepare_requests {
                write_test_json_response(
                    &mut socket,
                    &json!({
                        "versionId": format!("snapshot-{storage_name}"),
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
            prepare_names
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

    struct CheckpointFilesGuard {
        guest_paths: crate::paths::GuestPaths,
    }

    impl CheckpointFilesGuard {
        fn new(guest_paths: &crate::paths::GuestPaths) -> Self {
            cleanup_checkpoint_files(guest_paths);
            Self {
                guest_paths: guest_paths.clone(),
            }
        }
    }

    impl Drop for CheckpointFilesGuard {
        fn drop(&mut self) {
            cleanup_checkpoint_files(&self.guest_paths);
        }
    }

    fn cleanup_checkpoint_files(guest_paths: &crate::paths::GuestPaths) {
        let _ = std::fs::remove_file(guest_paths.session_id_file());
        let _ = std::fs::remove_file(guest_paths.session_history_path_file());
    }

    fn http_status(status: u16) -> HttpMockResponse {
        HttpMockResponse::builder().status(status).build()
    }

    fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
        req.headers_vec()
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
    }

    fn session_history_upload_response(
        req: &HttpMockRequest,
        expected_body: &[u8],
    ) -> HttpMockResponse {
        if request_header_eq(req, "content-type", "application/octet-stream")
            && req.body_ref() == expected_body
        {
            http_status(200)
        } else {
            http_status(400)
        }
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
        let mut prepare_names = server.await.unwrap();
        prepare_names.sort_unstable();
        assert_eq!(prepare_names, ["memory", "workspace"]);
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

    #[tokio::test]
    async fn checkpoint_missing_mount_fails_before_final_checkpoint_api_call() {
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let history_path = dir.path().join("history.jsonl");
        let home_dir = dir.path().join("home").to_string_lossy().into_owned();
        std::fs::write(&history_path, r#"{"type":"system"}"#).unwrap();
        crate::paths::write_private(
            guest_paths.session_id_file(),
            "session-with-missing-artifact",
        )
        .unwrap();
        crate::paths::write_private(
            guest_paths.session_history_path_file(),
            history_path.to_string_lossy().as_ref(),
        )
        .unwrap();

        let _history_prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history");
            then.status(200).json_body(json!({"existing": true}));
        });
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
        let checkpoint = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/checkpoints");
            then.status(200)
                .json_body(json!({"checkpointId": "unreachable"}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let inputs = CheckpointInputs {
            run_id: "checkpoint-missing-mount",
            framework: env::Framework::ClaudeCode,
            home_dir: &home_dir,
            artifact_entries: &entries,
            session_id_file: guest_paths.session_id_file().into(),
            session_history_path_file: guest_paths.session_history_path_file().into(),
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        let err = create_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
        checkpoint.assert_calls(0);
    }

    #[tokio::test]
    async fn checkpoint_reuses_codex_zstd_session_history_upload_body() {
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let history =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let history_hash = hex::encode(Sha256::digest(history));
        let home_dir = dir.path().join("home");
        let codex_day_dir = home_dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("02");
        std::fs::create_dir_all(&codex_day_dir).unwrap();
        std::fs::write(
            codex_day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst"),
            &compressed,
        )
        .unwrap();
        crate::paths::write_private(guest_paths.session_id_file(), thread_id).unwrap();

        let upload_url = server.url("/test/session-history-upload");
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-reuse",
                    "hash": history_hash,
                    "rawSize": history.len() as u64,
                    "encodedSize": compressed.len() as u64,
                    "encoding": SESSION_HISTORY_ENCODING_ZSTD,
                }));
            then.status(200).json_body(json!({
                "presignedUrl": upload_url,
                "encoding": SESSION_HISTORY_ENCODING_ZSTD,
            }));
        });
        let expected_upload = compressed.clone();
        let upload = server.mock(|when, then| {
            when.method(PUT).path("/test/session-history-upload");
            then.respond_with(move |req| session_history_upload_response(req, &expected_upload));
        });
        let checkpoint = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-reuse",
                    "cliAgentType": "codex",
                    "cliAgentSessionId": thread_id,
                    "cliAgentSessionHistoryHash": history_hash,
                }));
            then.status(200)
                .json_body(json!({"checkpointId": "checkpoint-codex-zstd"}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let home_dir = home_dir.to_string_lossy().into_owned();
        let inputs = CheckpointInputs {
            run_id: "checkpoint-codex-zstd-reuse",
            framework: env::Framework::Codex,
            home_dir: &home_dir,
            artifact_entries: &[],
            session_id_file: guest_paths.session_id_file().into(),
            session_history_path_file: guest_paths.session_history_path_file().into(),
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        create_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .unwrap();

        prepare.assert_calls(1);
        upload.assert_calls(1);
        checkpoint.assert_calls(1);
    }

    #[tokio::test]
    async fn checkpoint_falls_back_to_legacy_upload_when_prepare_rejects_reused_zstd() {
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let history =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let history_hash = hex::encode(Sha256::digest(history));
        let home_dir = dir.path().join("home");
        let codex_day_dir = home_dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("02");
        std::fs::create_dir_all(&codex_day_dir).unwrap();
        std::fs::write(
            codex_day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst"),
            &compressed,
        )
        .unwrap();
        crate::paths::write_private(guest_paths.session_id_file(), thread_id).unwrap();

        let zstd_prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-legacy-fallback",
                    "hash": history_hash,
                    "rawSize": history.len() as u64,
                    "encodedSize": compressed.len() as u64,
                    "encoding": SESSION_HISTORY_ENCODING_ZSTD,
                }));
            then.status(400).json_body(json!({
                "error": "unsupported encoding",
            }));
        });
        let upload_url = server.url("/test/session-history-legacy-upload");
        let legacy_prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-legacy-fallback",
                    "hash": history_hash,
                    "rawSize": history.len() as u64,
                    "encodedSize": history.len() as u64,
                    "encoding": SESSION_HISTORY_ENCODING_IDENTITY,
                }));
            then.status(200).json_body(json!({
                "presignedUrl": upload_url,
                "encoding": SESSION_HISTORY_ENCODING_IDENTITY,
            }));
        });
        let upload = server.mock(|when, then| {
            when.method(PUT).path("/test/session-history-legacy-upload");
            then.respond_with(move |req| session_history_upload_response(req, history));
        });
        let checkpoint = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-legacy-fallback",
                    "cliAgentType": "codex",
                    "cliAgentSessionId": thread_id,
                    "cliAgentSessionHistoryHash": history_hash,
                }));
            then.status(200)
                .json_body(json!({"checkpointId": "checkpoint-codex-zstd-legacy"}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let home_dir = home_dir.to_string_lossy().into_owned();
        let inputs = CheckpointInputs {
            run_id: "checkpoint-codex-zstd-legacy-fallback",
            framework: env::Framework::Codex,
            home_dir: &home_dir,
            artifact_entries: &[],
            session_id_file: guest_paths.session_id_file().into(),
            session_history_path_file: guest_paths.session_history_path_file().into(),
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        create_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .unwrap();

        zstd_prepare.assert_calls(1);
        legacy_prepare.assert_calls(1);
        upload.assert_calls(1);
        checkpoint.assert_calls(1);
    }

    #[test]
    fn recoverable_session_history_accepts_valid_jsonl() {
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"#;

        assert!(validate_recoverable_session_history(&history).is_ok());
    }

    #[test]
    fn recoverable_session_history_rejects_partial_trailing_json() {
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#;

        let err = validate_recoverable_session_history(&history).unwrap_err();

        assert!(err.contains("line 2"));
    }

    #[test]
    fn recoverable_session_history_rejects_blank_lines() {
        let history = r#"{"type":"system"}"#.to_string() + "\n\n" + r#"{"type":"assistant"}"#;

        let err = validate_recoverable_session_history(&history).unwrap_err();

        assert!(err.contains("line 2"));
    }
}
