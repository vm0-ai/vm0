//! Final session-history identity helpers for checkpoint and runner reuse.

use crate::env;
use crate::error::AgentError;
use crate::session_history;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, FinalSessionHistoryFramework,
    FinalSessionHistoryIdentity, FinalSessionHistoryIdentityError,
    FinalSessionHistoryIdentityExpectation, FinalSessionHistoryRefKind,
    SESSION_HISTORY_IDENTITY_GUEST_VERIFY_MAX_BYTES,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::Read;
use std::path::Path;

/// Build final session-history identity metadata for a successful checkpoint.
pub(crate) fn build_final_session_history_identity(
    framework: env::Framework,
    cli_agent_session_id: &str,
    history_hash: &str,
    history_size_bytes: u64,
    history_marker_payload: &str,
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
        history_marker_payload,
    )
    .map_err(FinalSessionHistoryIdentityBuildError::InvalidMetadata)
}

fn session_id_hash(framework: env::Framework, session_id: &str) -> Option<String> {
    let normalized = match framework {
        env::Framework::ClaudeCode => session_id.to_owned(),
        env::Framework::Codex => canonical_codex_thread_id(session_id)?,
    };
    Some(hex::encode(Sha256::digest(normalized.as_bytes())))
}

fn final_framework(framework: env::Framework) -> FinalSessionHistoryFramework {
    match framework {
        env::Framework::ClaudeCode => FinalSessionHistoryFramework::ClaudeCode,
        env::Framework::Codex => FinalSessionHistoryFramework::Codex,
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

fn read_final_session_history_identity(
    metadata_path: impl AsRef<Path>,
) -> Result<FinalSessionHistoryIdentity, FinalSessionHistoryIdentityVerifyError> {
    let mut file = std::fs::File::open(metadata_path)
        .map_err(|_| FinalSessionHistoryIdentityVerifyError::MetadataRead)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FinalSessionHistoryIdentityVerifyError::MetadataRead)?;
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
    match identity.framework {
        FinalSessionHistoryFramework::ClaudeCode => {
            if session_history::is_codex_marker(&identity.history_marker_payload) {
                return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch);
            }
        }
        FinalSessionHistoryFramework::Codex => {
            if !session_history::is_codex_marker(&identity.history_marker_payload) {
                return Err(FinalSessionHistoryIdentityVerifyError::FrameworkMismatch);
            }
        }
    }

    if identity.history_size_bytes > SESSION_HISTORY_IDENTITY_GUEST_VERIFY_MAX_BYTES {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryTooLarge);
    }
    let digest = match session_history::digest_session_history_from_payload_bounded(
        &identity.history_marker_payload,
        identity.history_size_bytes,
    ) {
        Ok(digest) => digest,
        Err(session_history::SessionHistoryDigestError::Read(error)) => {
            return Err(FinalSessionHistoryIdentityVerifyError::HistoryRead(error));
        }
        Err(session_history::SessionHistoryDigestError::ExceedsMaxBytes) => {
            return Err(FinalSessionHistoryIdentityVerifyError::HistoryMismatch);
        }
    };
    if digest.size_bytes != identity.history_size_bytes {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    if digest.sha256_hex != identity.history_hash {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    Ok(())
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
    /// Session history bytes could not be read.
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
    use std::io::Write;

    fn write_metadata(
        dir: &tempfile::TempDir,
        identity: &FinalSessionHistoryIdentity,
    ) -> std::path::PathBuf {
        let path = dir.path().join("identity.json");
        std::fs::write(&path, identity.to_json_vec().unwrap()).unwrap();
        path
    }

    #[test]
    fn verifies_claude_literal_history() {
        let dir = tempfile::tempdir().unwrap();
        let history = br#"{"type":"system"}"#;
        let history_path = dir.path().join("history.jsonl");
        std::fs::write(&history_path, history).unwrap();
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            history_path.to_string_lossy(),
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_codex_marker_history() {
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
        let marker = session_history::codex_marker_payload(&sessions_dir, thread_id);
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            marker,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_codex_zstd_marker_history() {
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
        let marker = session_history::codex_marker_payload(&sessions_dir, thread_id);
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            marker,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_history_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        std::fs::write(&history_path, b"changed").unwrap();
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            7,
            history_path.to_string_lossy(),
        )
        .unwrap();
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
        let mut file = std::fs::File::create(&metadata_path).unwrap();
        file.write_all(&vec![
            b'x';
            FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES as usize + 1
        ])
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
    fn build_allows_history_above_host_read_cap() {
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_HOST_READ_MAX_BYTES
                + 1,
            "/history.jsonl",
        )
        .unwrap();

        assert_eq!(
            identity.history_size_bytes,
            guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_HOST_READ_MAX_BYTES
                + 1
        );
    }

    #[test]
    fn verifies_large_claude_literal_history() {
        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        let history = vec![
            b'a';
            guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_HOST_READ_MAX_BYTES
                as usize
                + 1
        ];
        std::fs::write(&history_path, &history).unwrap();
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(&history)),
            history.len() as u64,
            history_path.to_string_lossy(),
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_current_history_larger_than_identity_size() {
        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        let expected_history = vec![
            b'a';
            guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_HOST_READ_MAX_BYTES
                as usize
        ];
        let oversized_history = vec![
            b'a';
            guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_HOST_READ_MAX_BYTES
                as usize
                + 1
        ];
        std::fs::write(&history_path, oversized_history).unwrap();
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(&expected_history)),
            expected_history.len() as u64,
            history_path.to_string_lossy(),
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::HistoryMismatch
        ));
    }

    #[test]
    fn rejects_history_above_guest_verify_cap() {
        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        std::fs::write(&history_path, b"small").unwrap();
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            SESSION_HISTORY_IDENTITY_GUEST_VERIFY_MAX_BYTES + 1,
            history_path.to_string_lossy(),
        )
        .unwrap();
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
        let history_path = dir.path().join("history.jsonl");
        std::fs::write(&history_path, history).unwrap();
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            history_path.to_string_lossy(),
        )
        .unwrap();
        let expected = FinalSessionHistoryIdentityExpectation::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
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
