//! Checkpoint-specific session-history preparation and persistence.

use super::{CheckpointInputs, CheckpointMode, LOG_TAG, fail, record_failure};
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::session_history as history;
use crate::session_history_identity::{
    FinalSessionHistoryIdentityBuildError, build_final_session_history_identity,
};
use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, SESSION_HISTORY_ENCODING_GZIP,
    SESSION_HISTORY_ENCODING_IDENTITY, SESSION_HISTORY_ENCODING_ZSTD,
    SESSION_HISTORY_GZIP_MIN_BYTES,
};
use bytes::Bytes;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use guest_session_prune::{
    ClaudeHistorySelection, CodexHistorySelection, select_claude_compact_generation,
    select_codex_compact_generation,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SESSION_HISTORY_ZSTD_LEVEL: i32 = 3;
const SESSION_HISTORY_COMPRESSION_MIN_BYTES: usize = SESSION_HISTORY_GZIP_MIN_BYTES as usize;

enum SessionHistoryUploadBody {
    Identity(Vec<u8>),
    Zstd(Vec<u8>),
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

pub(super) enum PreparedLiveHistory {
    MatchesCheckpoint,
    NativeCandidate {
        kind: NativeHistoryKind,
        replacement: Option<PendingNativeHistoryReplacement>,
    },
}

#[derive(Clone, Copy)]
pub(super) enum NativeHistoryKind {
    ClaudeCode,
    Codex,
}

impl NativeHistoryKind {
    const fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude",
            Self::Codex => "Codex",
        }
    }
}

pub(super) struct PendingNativeHistoryReplacement {
    staged: tempfile::NamedTempFile,
    target: PathBuf,
}

impl PendingNativeHistoryReplacement {
    fn stage(target: &Path, candidate: &[u8]) -> std::io::Result<Self> {
        let parent = target.parent().ok_or_else(|| {
            std::io::Error::new(
                ErrorKind::InvalidInput,
                "session history path has no parent",
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
                body: SessionHistoryUploadBody::Zstd(zstd_bytes),
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
            SessionHistoryUploadBody::Zstd(_) => SESSION_HISTORY_ENCODING_ZSTD,
        }
    }

    fn encoded_size(&self) -> u64 {
        match &self.body {
            SessionHistoryUploadBody::Identity(raw) => raw.len() as u64,
            SessionHistoryUploadBody::Zstd(zstd) => zstd.len() as u64,
        }
    }

    fn into_bytes(self) -> Bytes {
        match self.body {
            SessionHistoryUploadBody::Identity(raw) => Bytes::from(raw),
            SessionHistoryUploadBody::Zstd(zstd) => Bytes::from(zstd),
        }
    }
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
        body: SessionHistoryUploadBody::Zstd(zstd_bytes),
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

fn fail_preserving_error(
    mode: CheckpointMode,
    op: &str,
    start: std::time::Instant,
    error: AgentError,
) -> AgentError {
    record_failure(mode, op, start, &error.to_string());
    error
}

pub(super) struct CheckpointSessionHistoryInputs {
    mode: CheckpointMode,
    framework: env::Framework,
    claude_session_pruning_enabled: bool,
    codex_session_pruning_enabled: bool,
    home_dir: String,
    session_id_file: String,
    session_history_path_file: String,
}

impl CheckpointSessionHistoryInputs {
    pub(super) fn from_checkpoint(mode: CheckpointMode, inputs: &CheckpointInputs<'_>) -> Self {
        Self {
            mode,
            framework: inputs.framework,
            claude_session_pruning_enabled: inputs.claude_session_pruning_enabled,
            codex_session_pruning_enabled: inputs.codex_session_pruning_enabled,
            home_dir: inputs.home_dir.to_string(),
            session_id_file: inputs.session_id_file.to_string(),
            session_history_path_file: inputs.session_history_path_file.to_string(),
        }
    }
}

pub(super) struct CheckpointSessionHistory {
    pub(super) cli_agent_session_id: String,
    pub(super) history_marker_payload: String,
    pub(super) history_hash: String,
    pub(super) history_size: u64,
    pub(super) live_history: PreparedLiveHistory,
}

struct PreparedCheckpointSessionHistory {
    checkpoint: CheckpointSessionHistory,
    upload: SessionHistoryUpload,
}

async fn run_session_history_blocking<T>(
    operation: impl FnOnce() -> Result<T, AgentError> + Send + 'static,
) -> Result<T, AgentError>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            AgentError::Execution(format!("session history blocking task failed: {error}"))
        })?
}

/// Prepare + upload one session history to S3 via a presigned URL. If
/// the prepare endpoint reports `existing=true`, skip the upload
/// (content-addressed dedup). Telemetry is recorded under
/// `session_history_prepare` and `session_history_s3_upload` to match the
/// pre-parallelization op names.
async fn upload_session_history(
    http: &HttpClient,
    run_id: &str,
    history_hash: &str,
    history_upload: SessionHistoryUpload,
) -> Result<(), AgentError> {
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
            return Err(e);
        }
    };

    let existing = prep_resp
        .get("existing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let response_encoding = prep_resp.get("encoding").and_then(|v| v.as_str());
    // Existing content-addressed blobs retain their persisted encoding; no upload occurs.
    let zstd_response_encoding_is_compatible = response_encoding
        == Some(SESSION_HISTORY_ENCODING_ZSTD)
        || (existing
            && matches!(
                response_encoding,
                Some(SESSION_HISTORY_ENCODING_IDENTITY | SESSION_HISTORY_ENCODING_GZIP)
            ));
    if requested_encoding == SESSION_HISTORY_ENCODING_ZSTD && !zstd_response_encoding_is_compatible
    {
        return Err(AgentError::Checkpoint(
            "Prepare-history response did not acknowledge zstd session history".into(),
        ));
    }

    if existing {
        let accepted_encoding = response_encoding.unwrap_or(SESSION_HISTORY_ENCODING_IDENTITY);
        log_info!(
            LOG_TAG,
            "Session history already exists in S3 (deduplicated, encoding={accepted_encoding})"
        );
        return Ok(());
    }

    let presigned_url = prep_resp
        .get("presignedUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AgentError::Checkpoint("No presignedUrl in prepare-history response".into())
        })?;

    let upload_bytes = history_upload.into_bytes();

    log_info!(
        LOG_TAG,
        "Uploading session history to S3 (encoding={requested_encoding})..."
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
    Ok(())
}

fn prepare_session_history(
    mode: CheckpointMode,
    framework: env::Framework,
    claude_session_pruning_enabled: bool,
    codex_session_pruning_enabled: bool,
    cli_agent_session_id: &str,
    history_marker_payload: &str,
    history_read_start: std::time::Instant,
) -> Result<PreparedSessionHistory, AgentError> {
    if claude_session_pruning_enabled
        && mode.can_prune_history()
        && framework == env::Framework::ClaudeCode
        && !history::is_codex_marker(history_marker_payload)
    {
        let prune_start = std::time::Instant::now();
        match select_claude_compact_generation(history_marker_payload, cli_agent_session_id) {
            Ok(ClaudeHistorySelection::Candidate(candidate)) => {
                let source_size = candidate.source_size();
                let candidate_size = candidate.candidate_size();
                let candidate = candidate.into_bytes();
                let replacement = PendingNativeHistoryReplacement::stage(
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
                prepared.live_history = PreparedLiveHistory::NativeCandidate {
                    kind: NativeHistoryKind::ClaudeCode,
                    replacement,
                };
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

    let mut resolved_codex_history = None;
    if codex_session_pruning_enabled
        && mode.can_prune_history()
        && framework == env::Framework::Codex
        && history::is_codex_marker(history_marker_payload)
    {
        let prune_start = std::time::Instant::now();
        match history::resolve_codex_session_history_from_payload(history_marker_payload) {
            Ok(mut source) => {
                if let Some(file) = source.plain_file_mut() {
                    match select_codex_compact_generation(file, cli_agent_session_id) {
                        Ok(CodexHistorySelection::Candidate(candidate)) => {
                            let source_size = candidate.source_size();
                            let candidate_size = candidate.candidate_size();
                            let candidate = candidate.into_bytes();
                            let replacement =
                                PendingNativeHistoryReplacement::stage(source.path(), &candidate)
                                    .ok();
                            log_info!(
                                LOG_TAG,
                                "Selected Codex compact generation for checkpoint \
                             (source_size={source_size}, candidate_size={candidate_size})"
                            );
                            record_sandbox_op(
                                "session_history_prune",
                                prune_start.elapsed(),
                                true,
                                None,
                            );
                            let mut prepared =
                                prepare_raw_session_history(mode, history_read_start, candidate)?;
                            prepared.live_history = PreparedLiveHistory::NativeCandidate {
                                kind: NativeHistoryKind::Codex,
                                replacement,
                            };
                            return Ok(prepared);
                        }
                        Ok(CodexHistorySelection::Ineligible(reason)) => {
                            log_info!(
                                LOG_TAG,
                                "Codex session history not eligible for pruning: {}",
                                reason.as_str()
                            );
                            record_sandbox_op(
                                "session_history_prune",
                                prune_start.elapsed(),
                                true,
                                None,
                            );
                        }
                        Err(error) => {
                            log_warn!(
                                LOG_TAG,
                                "Codex session history selector failed; using ordinary checkpoint \
                             path: {error}"
                            );
                            record_sandbox_op(
                                "session_history_prune",
                                prune_start.elapsed(),
                                false,
                                Some("selector_io"),
                            );
                        }
                    }
                } else {
                    log_info!(
                        LOG_TAG,
                        "Codex session history not eligible for pruning: compressed_source"
                    );
                    record_sandbox_op("session_history_prune", prune_start.elapsed(), true, None);
                }
                resolved_codex_history = Some(source);
            }
            Err(error) => {
                log_warn!(
                    LOG_TAG,
                    "Codex session history selector failed; using ordinary checkpoint path: \
                     {error}"
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

    let source_result = resolved_codex_history.map_or_else(
        || {
            history::read_session_history_checkpoint_source_from_payload_bounded(
                history_marker_payload,
                RESUME_SESSION_HISTORY_MAX_BYTES,
            )
        },
        |source| source.into_checkpoint_source_bounded(RESUME_SESSION_HISTORY_MAX_BYTES),
    );
    let source = match source_result {
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
        history::SessionHistoryCheckpointSource::Decoded(history_bytes) => {
            prepare_raw_session_history(mode, history_read_start, history_bytes)
        }
        history::SessionHistoryCheckpointSource::CodexZstd { encoded } => {
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

        raw_size = raw_size
            .checked_add(bytes_read as u64)
            .ok_or(history::session_history_exceeds_max_error(max_bytes))?;
        if raw_size > max_bytes {
            return Err(history::session_history_exceeds_max_error(max_bytes));
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

fn prepare_checkpoint_session_history(
    inputs: CheckpointSessionHistoryInputs,
) -> Result<PreparedCheckpointSessionHistory, AgentError> {
    let CheckpointSessionHistoryInputs {
        mode,
        framework,
        claude_session_pruning_enabled,
        codex_session_pruning_enabled,
        home_dir,
        session_id_file,
        session_history_path_file,
    } = inputs;

    // Read the CLI agent session id. Let `read_to_string` surface `NotFound`
    // directly — an explicit `exists()` check would be a redundant stat plus a
    // TOCTOU race between check and read.
    let session_id_start = std::time::Instant::now();
    let cli_agent_session_id = match std::fs::read_to_string(&session_id_file) {
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
        framework,
        &home_dir,
        &session_history_path_file,
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
        framework,
        claude_session_pruning_enabled,
        codex_session_pruning_enabled,
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
    let upload = upload_source.into_upload(history_size)?;

    Ok(PreparedCheckpointSessionHistory {
        checkpoint: CheckpointSessionHistory {
            cli_agent_session_id,
            history_marker_payload,
            history_hash,
            history_size,
            live_history,
        },
        upload,
    })
}

pub(super) async fn prepare_and_upload_session_history(
    http: &HttpClient,
    run_id: &str,
    inputs: CheckpointSessionHistoryInputs,
) -> Result<CheckpointSessionHistory, AgentError> {
    let prepared =
        run_session_history_blocking(move || prepare_checkpoint_session_history(inputs)).await?;
    let PreparedCheckpointSessionHistory { checkpoint, upload } = prepared;
    upload_session_history(http, run_id, &checkpoint.history_hash, upload).await?;
    Ok(checkpoint)
}

pub(super) fn reconcile_live_history_after_checkpoint(live_history: PreparedLiveHistory) -> bool {
    let started_at = std::time::Instant::now();
    match live_history {
        PreparedLiveHistory::MatchesCheckpoint => true,
        PreparedLiveHistory::NativeCandidate {
            kind,
            replacement: Some(replacement),
        } => {
            if replacement.persist().is_ok() {
                record_sandbox_op(
                    "session_history_prune_reconcile",
                    started_at.elapsed(),
                    true,
                    None,
                );
                log_info!(
                    LOG_TAG,
                    "Replaced live {} session history with committed compact generation",
                    kind.label()
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
                    "Failed to reconcile committed {} compact generation into live session \
                     history; next resume will restore checkpoint history",
                    kind.label()
                );
                false
            }
        }
        PreparedLiveHistory::NativeCandidate {
            kind,
            replacement: None,
        } => {
            record_sandbox_op(
                "session_history_prune_reconcile",
                started_at.elapsed(),
                false,
                Some("stage_failed"),
            );
            log_warn!(
                LOG_TAG,
                "Failed to reconcile committed {} compact generation into live session \
                 history; next resume will restore checkpoint history",
                kind.label()
            );
            false
        }
    }
}

pub(super) fn write_final_session_history_identity(
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
    use super::super::CheckpointMode;
    use super::*;
    use crate::error::AgentError;

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
