//! Final session-history identity helpers for checkpoint and runner reuse.

use crate::env;
use crate::error::AgentError;
use crate::session_history;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, FinalSessionHistoryFramework,
    FinalSessionHistoryIdentity, FinalSessionHistoryIdentityError, FinalSessionHistoryRefKind,
    SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES,
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
) -> Result<(), FinalSessionHistoryIdentityVerifyError> {
    let identity = read_final_session_history_identity(metadata_path)?;
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

    let history_bytes = session_history::read_session_history_from_payload_bounded(
        &identity.history_marker_payload,
        SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES,
    )
    .map_err(FinalSessionHistoryIdentityVerifyError::HistoryRead)?;
    if history_bytes.len() as u64 != identity.history_size_bytes {
        return Err(FinalSessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    let actual_hash = hex::encode(Sha256::digest(&history_bytes));
    if actual_hash != identity.history_hash {
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
    /// Session history bytes could not be read.
    HistoryRead(AgentError),
    /// Session history size or hash does not match metadata.
    HistoryMismatch,
}

impl fmt::Display for FinalSessionHistoryIdentityVerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MetadataRead => f.write_str("final session history identity could not be read"),
            Self::InvalidMetadata(error) => write!(f, "{error}"),
            Self::FrameworkMismatch => {
                f.write_str("final session history identity framework mismatch")
            }
            Self::HistoryRead(_) => f.write_str("final session history could not be read"),
            Self::HistoryMismatch => f.write_str("final session history did not match identity"),
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

        verify_final_session_history_identity_file(metadata_path).unwrap();
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

        verify_final_session_history_identity_file(metadata_path).unwrap();
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

        let err = verify_final_session_history_identity_file(metadata_path).unwrap_err();
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

        let err = verify_final_session_history_identity_file(metadata_path).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::InvalidMetadata(
                FinalSessionHistoryIdentityError::MetadataTooLarge
            )
        ));
    }

    #[test]
    fn build_rejects_history_above_verify_cap() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES + 1,
            "/history.jsonl",
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::HistoryTooLarge);
    }

    #[test]
    fn rejects_current_history_above_verify_cap() {
        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        let expected_history = vec![b'a'; SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES as usize];
        let oversized_history = vec![b'a'; SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES as usize + 1];
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

        let err = verify_final_session_history_identity_file(metadata_path).unwrap_err();
        assert!(matches!(
            err,
            FinalSessionHistoryIdentityVerifyError::HistoryMismatch
        ));
    }
}
