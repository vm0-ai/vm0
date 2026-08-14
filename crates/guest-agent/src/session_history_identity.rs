//! Final session-history identity helpers for checkpoint and runner reuse.

use crate::env;
use crate::error::AgentError;
use crate::session_history;
use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, FINAL_SESSION_HISTORY_IDENTITY_VERSION,
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryIdentityError,
    FinalSessionHistoryIdentityExpectation, FinalSessionHistoryRefKind,
    FinalSessionHistorySourceRef, LEGACY_FINAL_SESSION_HISTORY_IDENTITY_VERSION,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
    SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE, SessionHistorySidecarExportFailure,
    SessionHistorySidecarExportMetadata, SessionHistorySidecarIoErrorClass,
    SessionHistorySidecarRepresentation,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io;
use std::path::Path;

/// Build final session-history identity metadata for a successful checkpoint.
pub(crate) fn build_final_session_history_identity(
    framework: env::Framework,
    cli_agent_session_id: &str,
    history_hash: &str,
    history_size_bytes: u64,
    history_source: &FinalSessionHistorySourceRef,
) -> Result<FinalSessionHistoryIdentity, FinalSessionHistoryIdentityBuildError> {
    let session_id_hash = session_id_hash(framework, cli_agent_session_id)
        .ok_or(FinalSessionHistoryIdentityBuildError::InvalidSessionId)?;
    let framework = final_framework(framework);
    FinalSessionHistoryIdentity::new(
        framework,
        session_id_hash,
        FinalSessionHistoryRefKind::Blob,
        history_hash,
        history_size_bytes,
        history_source.clone(),
    )
    .map_err(FinalSessionHistoryIdentityBuildError::InvalidMetadata)
}

fn session_id_hash(framework: env::Framework, session_id: &str) -> Option<String> {
    let normalized = match framework {
        env::Framework::ClaudeCode => session_id.to_owned(),
        env::Framework::Codex => canonical_codex_thread_id(session_id)?,
        env::Framework::Pi => session_id.to_owned(),
    };
    Some(hex::encode(Sha256::digest(normalized.as_bytes())))
}

fn final_framework(framework: env::Framework) -> FinalSessionHistoryFramework {
    match framework {
        env::Framework::ClaudeCode => FinalSessionHistoryFramework::ClaudeCode,
        env::Framework::Codex => FinalSessionHistoryFramework::Codex,
        env::Framework::Pi => FinalSessionHistoryFramework::Pi,
    }
}

/// Verify the current guest session history matches final identity metadata.
pub fn verify_final_session_history_identity_file(
    metadata_path: impl AsRef<Path>,
    expected: Option<&FinalSessionHistoryIdentityExpectation>,
) -> Result<(), FinalSessionHistoryIdentityVerifyError> {
    let identity = read_final_session_history_identity(metadata_path)?;
    if let Some(expected) = expected
        && !expected.matches_identity(&identity)
    {
        return Err(FinalSessionHistoryIdentityVerifyError::ExpectedIdentityMismatch);
    }
    verify_final_session_history_identity(&identity)
}

/// Export a verified final session-history sidecar from one source snapshot.
///
/// The bounded metadata at `metadata_path` is validated before the declared
/// framework and decoded history size are checked against the source shape and
/// guest resume budget. The resolved history source is then consumed once: the
/// decoded size and SHA-256 identity are verified from the same snapshot that
/// supplies the exported bytes.
///
/// History is exported as [`SessionHistorySidecarRepresentation::Raw`] after
/// decoding unless it is native Codex zstd whose encoded form fits the export
/// budget. That native representation is preserved as
/// [`SessionHistorySidecarRepresentation::CodexZstd`]; an oversized encoded
/// form falls back to decoded raw history. Identity size and hash fields always
/// describe decoded history, while
/// [`SessionHistorySidecarExportMetadata::encoded_size`] is the exact length of
/// the selected output representation.
///
/// After verification, `export_path` is created or truncated through
/// [`crate::paths::write_private`] and inherits that helper's platform-specific
/// runtime-private permission and symlink handling. The write is not
/// transactional: callers must consume the sidecar only after this function
/// returns successfully, because an output error may leave a created,
/// truncated, or partial file.
///
/// The guest `export-session-history-sidecar` helper serializes the returned
/// metadata for runner, which uses the representation and exact encoded length
/// to validate and copy the exported file.
///
/// # Returns
///
/// On success, returns the representation and exact byte length written to
/// `export_path`.
///
/// # Errors
///
/// Returns:
///
/// Returns [`FinalSessionHistorySidecarExportError::Verification`] when identity
/// metadata or source history cannot be verified. Returns
/// [`FinalSessionHistorySidecarExportError::OutputWrite`] when the verified
/// sidecar bytes cannot be created or written at `export_path`.
pub fn export_final_session_history_sidecar_file(
    metadata_path: impl AsRef<Path>,
    export_path: impl AsRef<Path>,
) -> Result<SessionHistorySidecarExportMetadata, FinalSessionHistorySidecarExportError> {
    let identity = read_final_session_history_identity(metadata_path)?;
    let history_source = validated_history_source(&identity)?;
    verify_final_session_history_identity_constraints(&identity)?;
    let prepared = session_history::prepare_session_history_sidecar_from_source_bounded(
        &history_source,
        identity.history_size_bytes,
        RESUME_SESSION_HISTORY_MAX_BYTES,
    )
    .map_err(map_session_history_digest_error)?;
    verify_final_session_history_digest(&identity, &prepared.digest)?;
    let source = prepared.into_source();
    let (representation, bytes) = match source {
        session_history::SessionHistoryCheckpointSource::Decoded(bytes) => {
            (SessionHistorySidecarRepresentation::Raw, bytes)
        }
        session_history::SessionHistoryCheckpointSource::CodexZstd { encoded } => {
            (SessionHistorySidecarRepresentation::CodexZstd, encoded)
        }
    };
    crate::paths::write_private(export_path.as_ref(), &bytes)
        .map_err(FinalSessionHistorySidecarExportError::OutputWrite)?;
    Ok(SessionHistorySidecarExportMetadata {
        representation,
        encoded_size: bytes.len() as u64,
    })
}

fn read_final_session_history_identity(
    metadata_path: impl AsRef<Path>,
) -> Result<FinalSessionHistoryIdentity, FinalSessionHistoryIdentityVerifyError> {
    let metadata_path = metadata_path.as_ref();
    let read_limit =
        usize::try_from(FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1).map_err(|_| {
            FinalSessionHistoryIdentityVerifyError::InvalidMetadata(
                FinalSessionHistoryIdentityError::MetadataTooLarge,
            )
        })?;
    let bytes =
        match guest_contracts::runtime_paths::read_private_bounded(metadata_path, read_limit) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Err(FinalSessionHistoryIdentityVerifyError::MetadataRead),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                return Err(FinalSessionHistoryIdentityVerifyError::InvalidMetadata(
                    FinalSessionHistoryIdentityError::MetadataTooLarge,
                ));
            }
            Err(_) => return Err(FinalSessionHistoryIdentityVerifyError::MetadataRead),
        };
    if bytes.len() as u64 > FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES {
        return Err(FinalSessionHistoryIdentityVerifyError::InvalidMetadata(
            FinalSessionHistoryIdentityError::MetadataTooLarge,
        ));
    }
    FinalSessionHistoryIdentity::from_json_slice(&bytes)
        .map_err(FinalSessionHistoryIdentityVerifyError::InvalidMetadata)
}

fn verify_final_session_history_identity(
    identity: &FinalSessionHistoryIdentity,
) -> Result<(), FinalSessionHistoryIdentityVerifyError> {
    let history_source = validated_history_source(identity)?;
    verify_final_session_history_identity_constraints(identity)?;
    let digest = session_history::digest_session_history_from_source_bounded(
        &history_source,
        identity.history_size_bytes,
    )
    .map_err(map_session_history_digest_error)?;
    verify_final_session_history_digest(identity, &digest)
}

fn verify_final_session_history_identity_constraints(
    identity: &FinalSessionHistoryIdentity,
) -> Result<(), FinalSessionHistoryIdentityVerifyError> {
    if identity.history_size_bytes > RESUME_SESSION_HISTORY_MAX_BYTES {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryTooLarge);
    }
    Ok(())
}

fn validated_history_source(
    identity: &FinalSessionHistoryIdentity,
) -> Result<FinalSessionHistorySourceRef, FinalSessionHistoryIdentityVerifyError> {
    let source = match identity.version {
        FINAL_SESSION_HISTORY_IDENTITY_VERSION => identity
            .history_source
            .clone()
            .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?,
        LEGACY_FINAL_SESSION_HISTORY_IDENTITY_VERSION => legacy_history_source(identity)?,
        _ => return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch),
    };

    let source_session_id = match (&identity.framework, &source) {
        (
            FinalSessionHistoryFramework::ClaudeCode,
            FinalSessionHistorySourceRef::ClaudeCode { session_id, .. },
        ) => Some(session_id.as_str()),
        (
            FinalSessionHistoryFramework::Codex,
            FinalSessionHistorySourceRef::Codex { thread_id, .. },
        ) => Some(thread_id.as_str()),
        (FinalSessionHistoryFramework::Pi, FinalSessionHistorySourceRef::Pi { session_id, .. }) => {
            session_id.as_deref()
        }
        _ => return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch),
    };
    if let Some(session_id) = source_session_id {
        let framework = match identity.framework {
            FinalSessionHistoryFramework::ClaudeCode => env::Framework::ClaudeCode,
            FinalSessionHistoryFramework::Codex => env::Framework::Codex,
            FinalSessionHistoryFramework::Pi => env::Framework::Pi,
        };
        if session_id_hash(framework, session_id).as_deref() != Some(&identity.session_id_hash) {
            return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch);
        }
    }
    Ok(source)
}

fn legacy_history_source(
    identity: &FinalSessionHistoryIdentity,
) -> Result<FinalSessionHistorySourceRef, FinalSessionHistoryIdentityVerifyError> {
    let marker = identity
        .history_marker_payload
        .as_deref()
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    match identity.framework {
        FinalSessionHistoryFramework::ClaudeCode => legacy_claude_history_source(marker),
        FinalSessionHistoryFramework::Codex => legacy_codex_history_source(marker),
        FinalSessionHistoryFramework::Pi => {
            crate::session_metadata::is_pi_session_history_path(marker)
                .then(|| FinalSessionHistorySourceRef::Pi {
                    session_path: marker.to_string(),
                    session_id: None,
                })
                .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)
        }
    }
}

fn legacy_claude_history_source(
    marker: &str,
) -> Result<FinalSessionHistorySourceRef, FinalSessionHistoryIdentityVerifyError> {
    let path = Path::new(marker);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch);
    }
    let session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id(value))
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    let project_dir = path
        .parent()
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    let expected_project_dir = format!(
        "-{}",
        crate::paths::CANONICAL_WORKING_DIR
            .trim_start_matches('/')
            .replace('/', "-")
    );
    if project_dir.file_name().and_then(|value| value.to_str())
        != Some(expected_project_dir.as_str())
    {
        return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch);
    }
    let projects_dir = project_dir
        .parent()
        .filter(|path| path.file_name().and_then(|value| value.to_str()) == Some("projects"))
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    let config_dir = projects_dir
        .parent()
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    Ok(FinalSessionHistorySourceRef::ClaudeCode {
        config_dir: config_dir.to_string_lossy().into_owned(),
        working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
        session_id: session_id.to_string(),
    })
}

fn legacy_codex_history_source(
    marker: &str,
) -> Result<FinalSessionHistorySourceRef, FinalSessionHistoryIdentityVerifyError> {
    let (sessions_dir, thread_id) = session_history::decode_legacy_codex_marker_payload(marker)
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    if !sessions_dir.is_absolute()
        || sessions_dir.file_name().and_then(|value| value.to_str()) != Some("sessions")
        || sessions_dir
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            != Some(".codex")
    {
        return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch);
    }
    let thread_id = canonical_codex_thread_id(&thread_id)
        .ok_or(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch)?;
    Ok(FinalSessionHistorySourceRef::Codex {
        sessions_dir: sessions_dir.to_string_lossy().into_owned(),
        thread_id,
    })
}

fn verify_final_session_history_digest(
    identity: &FinalSessionHistoryIdentity,
    digest: &session_history::SessionHistoryDigest,
) -> Result<(), FinalSessionHistoryIdentityVerifyError> {
    if digest.size_bytes != identity.history_size_bytes {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    if digest.sha256_hex != identity.history_hash {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    Ok(())
}

fn map_session_history_digest_error(
    error: session_history::SessionHistoryDigestError,
) -> FinalSessionHistoryIdentityVerifyError {
    match error {
        session_history::SessionHistoryDigestError::Read(error) => {
            FinalSessionHistoryIdentityVerifyError::HistoryRead(error)
        }
        session_history::SessionHistoryDigestError::ExceedsMaxBytes => {
            FinalSessionHistoryIdentityVerifyError::HistoryMismatch
        }
    }
}

/// Error returned while building final identity metadata.
#[derive(Debug)]
pub(crate) enum FinalSessionHistoryIdentityBuildError {
    /// Session id cannot be normalized for the current framework.
    InvalidSessionId,
    /// Metadata violates the shared final identity contract.
    InvalidMetadata(FinalSessionHistoryIdentityError),
}

impl fmt::Display for FinalSessionHistoryIdentityBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSessionId => {
                f.write_str("final session history identity session id is invalid")
            }
            Self::InvalidMetadata(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for FinalSessionHistoryIdentityBuildError {}

/// Error returned while exporting a verified final session-history sidecar.
#[derive(Debug)]
pub enum FinalSessionHistorySidecarExportError {
    /// Identity metadata or source history verification failed.
    Verification(FinalSessionHistoryIdentityVerifyError),
    /// The verified sidecar output could not be created or written.
    OutputWrite(io::Error),
}

impl FinalSessionHistorySidecarExportError {
    /// Return the stable helper exit code for this export failure.
    pub fn helper_exit_code(&self) -> i32 {
        match self {
            Self::Verification(error) => error.helper_exit_code(),
            Self::OutputWrite(_) => SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE,
        }
    }

    /// Return safe output-failure metadata when the export write failed.
    pub fn output_failure(&self) -> Option<SessionHistorySidecarExportFailure> {
        let Self::OutputWrite(error) = self else {
            return None;
        };
        Some(SessionHistorySidecarExportFailure {
            io_error_class: sidecar_io_error_class(error),
        })
    }
}

impl From<FinalSessionHistoryIdentityVerifyError> for FinalSessionHistorySidecarExportError {
    fn from(error: FinalSessionHistoryIdentityVerifyError) -> Self {
        Self::Verification(error)
    }
}

impl fmt::Display for FinalSessionHistorySidecarExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Verification(error) => write!(f, "{error}"),
            Self::OutputWrite(_) => f.write_str("session history sidecar could not be written"),
        }
    }
}

impl std::error::Error for FinalSessionHistorySidecarExportError {}

fn sidecar_io_error_class(error: &io::Error) -> SessionHistorySidecarIoErrorClass {
    match error.kind() {
        io::ErrorKind::NotFound => SessionHistorySidecarIoErrorClass::NotFound,
        io::ErrorKind::PermissionDenied => SessionHistorySidecarIoErrorClass::PermissionDenied,
        io::ErrorKind::StorageFull => SessionHistorySidecarIoErrorClass::StorageFull,
        io::ErrorKind::QuotaExceeded => SessionHistorySidecarIoErrorClass::QuotaExceeded,
        _ => SessionHistorySidecarIoErrorClass::Unknown,
    }
}

/// Error returned while verifying final identity metadata.
#[derive(Debug)]
pub enum FinalSessionHistoryIdentityVerifyError {
    /// Metadata file could not be read.
    MetadataRead,
    /// Metadata failed shared contract validation.
    InvalidMetadata(FinalSessionHistoryIdentityError),
    /// Metadata framework does not match the marker shape.
    FrameworkMismatch,
    /// Metadata does not match the identity runner expected to verify.
    ExpectedIdentityMismatch,
    /// Session history could not be resolved, read, or decoded.
    HistoryRead(AgentError),
    /// Session history size or hash does not match metadata.
    HistoryMismatch,
    /// Session history exceeds the guest helper verification budget.
    HistoryTooLarge,
}

impl FinalSessionHistoryIdentityVerifyError {
    /// Return the stable helper exit code for this verification failure.
    pub fn helper_exit_code(&self) -> i32 {
        match self {
            Self::MetadataRead => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
            Self::InvalidMetadata(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
            Self::FrameworkMismatch => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
            Self::ExpectedIdentityMismatch => {
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH
            }
            Self::HistoryRead(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
            Self::HistoryMismatch => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
            Self::HistoryTooLarge => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
        }
    }
}

impl fmt::Display for FinalSessionHistoryIdentityVerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MetadataRead => f.write_str("final session history identity could not be read"),
            Self::InvalidMetadata(error) => write!(f, "{error}"),
            Self::FrameworkMismatch => {
                f.write_str("final session history identity framework mismatch")
            }
            Self::ExpectedIdentityMismatch => {
                f.write_str("final session history identity did not match expected identity")
            }
            Self::HistoryRead(_) => f.write_str("final session history could not be read"),
            Self::HistoryMismatch => f.write_str("final session history did not match identity"),
            Self::HistoryTooLarge => {
                f.write_str("final session history exceeds verification budget")
            }
        }
    }
}

impl std::error::Error for FinalSessionHistoryIdentityVerifyError {}

#[cfg(test)]
mod tests {
    use super::*;

    const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;
    const PREVIOUS_GUEST_VERIFY_CAP_BYTES: u64 = 32 * 1024 * 1024;
    const CLAUDE_SESSION_ID: &str = "session-identity-test";

    fn write_metadata(
        dir: &tempfile::TempDir,
        identity: &FinalSessionHistoryIdentity,
    ) -> std::path::PathBuf {
        let path = dir.path().join("identity.json");
        crate::paths::write_private(&path, identity.to_json_vec().unwrap()).unwrap();
        path
    }

    fn repeated_byte_sha256(byte: u8, len: u64) -> String {
        let mut hasher = Sha256::new();
        let buffer = [byte; 8192];
        let mut remaining = len;
        while remaining > 0 {
            let chunk_len = remaining.min(buffer.len() as u64) as usize;
            hasher.update(&buffer[..chunk_len]);
            remaining -= chunk_len as u64;
        }
        hex::encode(hasher.finalize())
    }

    fn session_hash(session_id: &str) -> String {
        hex::encode(Sha256::digest(session_id.as_bytes()))
    }

    fn claude_history_source(
        dir: &tempfile::TempDir,
    ) -> (std::path::PathBuf, FinalSessionHistorySourceRef) {
        let config_dir = dir.path().join("claude-config");
        let history_path = config_dir
            .join("projects")
            .join("-home-user-workspace")
            .join(format!("{CLAUDE_SESSION_ID}.jsonl"));
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        (
            history_path,
            FinalSessionHistorySourceRef::ClaudeCode {
                config_dir: config_dir.to_string_lossy().into_owned(),
                working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: CLAUDE_SESSION_ID.to_string(),
            },
        )
    }

    fn claude_identity(
        source: FinalSessionHistorySourceRef,
        history_hash: impl Into<String>,
        history_size: u64,
    ) -> FinalSessionHistoryIdentity {
        FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            session_hash(CLAUDE_SESSION_ID),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            history_size,
            source,
        )
        .unwrap()
    }

    fn legacy_identity(
        framework: FinalSessionHistoryFramework,
        session_id: &str,
        history: &[u8],
        marker: impl Into<String>,
    ) -> FinalSessionHistoryIdentity {
        FinalSessionHistoryIdentity::new_legacy(
            framework,
            session_hash(session_id),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            marker,
        )
        .unwrap()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classifies_sidecar_storage_exhaustion_without_error_text() {
        let storage_full = io::Error::from_raw_os_error(libc::ENOSPC);
        let unknown = io::Error::other("sensitive path");

        assert_eq!(
            sidecar_io_error_class(&storage_full),
            SessionHistorySidecarIoErrorClass::StorageFull
        );
        assert_eq!(
            sidecar_io_error_class(&unknown),
            SessionHistorySidecarIoErrorClass::Unknown
        );
    }

    #[test]
    fn verifies_claude_literal_history() {
        let dir = tempfile::tempdir().unwrap();
        let history = br#"{"type":"system"}"#;
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
        );
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_canonical_legacy_claude_history() {
        let dir = tempfile::tempdir().unwrap();
        let history = br#"{"type":"system"}"#;
        let (history_path, _) = claude_history_source(&dir);
        std::fs::write(&history_path, history).unwrap();
        let identity = legacy_identity(
            FinalSessionHistoryFramework::ClaudeCode,
            CLAUDE_SESSION_ID,
            history,
            history_path.to_string_lossy(),
        );
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_untrusted_legacy_claude_marker_shapes() {
        let dir = tempfile::tempdir().unwrap();
        for (name, marker) in [
            ("proc", "/proc/self/environ"),
            ("relative", "history.jsonl"),
            ("wrong-project", "/tmp/projects/unrelated/session.jsonl"),
        ] {
            let identity = legacy_identity(
                FinalSessionHistoryFramework::ClaudeCode,
                CLAUDE_SESSION_ID,
                b"x",
                marker,
            );
            let metadata_path = dir.path().join(format!("{name}-identity.json"));
            crate::paths::write_private(&metadata_path, identity.to_json_vec().unwrap()).unwrap();

            let error = verify_final_session_history_identity_file(metadata_path, None)
                .expect_err("untrusted legacy marker must be rejected");
            assert!(matches!(
                error,
                FinalSessionHistoryIdentityVerifyError::FrameworkMismatch
            ));
        }
    }

    #[test]
    fn rejects_legacy_claude_session_hash_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let history = b"x";
        let (history_path, _) = claude_history_source(&dir);
        std::fs::write(&history_path, history).unwrap();
        let identity = FinalSessionHistoryIdentity::new_legacy(
            FinalSessionHistoryFramework::ClaudeCode,
            session_hash("different-session"),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            history_path.to_string_lossy(),
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        let error = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            error,
            FinalSessionHistoryIdentityVerifyError::FrameworkMismatch
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_legacy_claude_intermediate_and_final_symlinks() {
        use std::os::unix::fs::symlink;

        let history = b"parent-only sentinel";

        let intermediate_dir = tempfile::tempdir().unwrap();
        let config_dir = intermediate_dir.path().join("claude-config");
        let outside_projects = intermediate_dir.path().join("outside-projects");
        let history_path = outside_projects
            .join("-home-user-workspace")
            .join(format!("{CLAUDE_SESSION_ID}.jsonl"));
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        std::fs::write(&history_path, history).unwrap();
        std::fs::create_dir(&config_dir).unwrap();
        symlink(&outside_projects, config_dir.join("projects")).unwrap();
        let marker = config_dir
            .join("projects/-home-user-workspace")
            .join(format!("{CLAUDE_SESSION_ID}.jsonl"));
        let identity = legacy_identity(
            FinalSessionHistoryFramework::ClaudeCode,
            CLAUDE_SESSION_ID,
            history,
            marker.to_string_lossy(),
        );
        let metadata_path = write_metadata(&intermediate_dir, &identity);
        let error = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            error,
            FinalSessionHistoryIdentityVerifyError::HistoryRead(_)
        ));

        let final_dir = tempfile::tempdir().unwrap();
        let (marker, _) = claude_history_source(&final_dir);
        let outside = final_dir.path().join("outside-history.jsonl");
        std::fs::write(&outside, history).unwrap();
        symlink(&outside, &marker).unwrap();
        let identity = legacy_identity(
            FinalSessionHistoryFramework::ClaudeCode,
            CLAUDE_SESSION_ID,
            history,
            marker.to_string_lossy(),
        );
        let metadata_path = write_metadata(&final_dir, &identity);
        let error = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            error,
            FinalSessionHistoryIdentityVerifyError::HistoryRead(_)
        ));
    }

    #[test]
    fn verifies_canonical_legacy_codex_history() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("home/.codex/sessions");
        let history_dir = sessions_dir.join("2026/06/29");
        std::fs::create_dir_all(&history_dir).unwrap();
        let thread_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session_meta"}"#;
        std::fs::write(
            history_dir.join("rollout-00000000000040008000000000000001.jsonl"),
            history,
        )
        .unwrap();
        let sessions_dir = sessions_dir.to_string_lossy();
        let marker = format!(
            "CODEX_SEARCH:{}:{sessions_dir}:{thread_id}",
            sessions_dir.len()
        );
        let identity = legacy_identity(
            FinalSessionHistoryFramework::Codex,
            thread_id,
            history,
            marker,
        );
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn builds_pi_jsonl_history_identity() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session","id":"00000000-0000-4000-8000-000000000001"}"#;
        let history_path = format!(
            "{}/restored-{session_id}.jsonl",
            api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
        );
        let history_source = FinalSessionHistorySourceRef::Pi {
            session_path: history_path,
            session_id: Some(session_id.to_string()),
        };
        let identity = build_final_session_history_identity(
            env::Framework::Pi,
            session_id,
            &hex::encode(Sha256::digest(history)),
            history.len() as u64,
            &history_source,
        )
        .unwrap();

        assert_eq!(identity.framework, FinalSessionHistoryFramework::Pi);
        assert_eq!(identity.history_source, Some(history_source));
        assert_eq!(identity.history_marker_payload, None);
        assert_eq!(
            identity.session_id_hash,
            hex::encode(Sha256::digest(session_id.as_bytes()))
        );
    }

    #[test]
    fn verifies_codex_history_source() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let history_dir = sessions_dir.join("2026").join("06").join("29");
        std::fs::create_dir_all(&history_dir).unwrap();
        let thread_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session_meta","timestamp":"2026-06-29T10:00:00Z"}"#;
        std::fs::write(
            history_dir.join("rollout-2026-06-29T10-00-00-00000000000040008000000000000001.jsonl"),
            history,
        )
        .unwrap();
        let source = FinalSessionHistorySourceRef::Codex {
            sessions_dir: sessions_dir.to_string_lossy().into_owned(),
            thread_id: thread_id.to_string(),
        };
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            session_hash(thread_id),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            source,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_codex_zstd_history_source() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let history_dir = sessions_dir.join("2026").join("06").join("29");
        std::fs::create_dir_all(&history_dir).unwrap();
        let thread_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session_meta","timestamp":"2026-06-29T10:00:00Z"}"#;
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        std::fs::write(
            history_dir
                .join("rollout-2026-06-29T10-00-00-00000000000040008000000000000001.jsonl.zst"),
            compressed,
        )
        .unwrap();
        let source = FinalSessionHistorySourceRef::Codex {
            sessions_dir: sessions_dir.to_string_lossy().into_owned(),
            thread_id: thread_id.to_string(),
        };
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            session_hash(thread_id),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            source,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_history_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, b"changed").unwrap();
        let identity = claude_identity(source, "b".repeat(64), 7);
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::HistoryMismatch
        ));
    }

    #[test]
    fn rejects_oversized_metadata_file() {
        let dir = tempfile::tempdir().unwrap();
        let metadata_path = dir.path().join("identity.json");
        crate::paths::write_private(
            &metadata_path,
            vec![b'x'; FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES as usize + 1],
        )
        .unwrap();

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::InvalidMetadata(
                FinalSessionHistoryIdentityError::MetadataTooLarge
            )
        ));
    }

    #[test]
    fn build_allows_large_history_metadata() {
        let identity = claude_identity(
            FinalSessionHistorySourceRef::ClaudeCode {
                config_dir: "/claude-config".to_string(),
                working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: CLAUDE_SESSION_ID.to_string(),
            },
            "b".repeat(64),
            LARGE_SESSION_HISTORY_SIZE_BYTES as u64,
        );

        assert_eq!(
            identity.history_size_bytes,
            LARGE_SESSION_HISTORY_SIZE_BYTES as u64
        );
    }

    #[test]
    fn verifies_large_claude_literal_history() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
        std::fs::write(&history_path, &history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(&history)),
            history.len() as u64,
        );
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_history_above_previous_guest_verify_cap() {
        let history_size = PREVIOUS_GUEST_VERIFY_CAP_BYTES + 1;
        assert!(history_size < RESUME_SESSION_HISTORY_MAX_BYTES);

        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        std::fs::File::create(&history_path)
            .unwrap()
            .set_len(history_size)
            .unwrap();
        let identity = claude_identity(source, repeated_byte_sha256(0, history_size), history_size);
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_current_history_larger_than_identity_size() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        let expected_history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES - 1];
        let oversized_history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
        std::fs::write(&history_path, oversized_history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(&expected_history)),
            expected_history.len() as u64,
        );
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::HistoryMismatch
        ));
    }

    #[test]
    fn rejects_history_above_resume_cap() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, b"small").unwrap();
        let identity =
            claude_identity(source, "b".repeat(64), RESUME_SESSION_HISTORY_MAX_BYTES + 1);
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::HistoryTooLarge
        ));
    }

    #[test]
    fn rejects_expected_identity_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let history = br#"{"type":"system"}"#;
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
        );
        let expected = FinalSessionHistoryIdentityExpectation::new(
            FinalSessionHistoryFramework::ClaudeCode,
            session_hash(CLAUDE_SESSION_ID),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            history.len() as u64,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        let err =
            verify_final_session_history_identity_file(metadata_path, Some(&expected)).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::ExpectedIdentityMismatch
        ));
    }
}
