//! Shared final session-history identity metadata.
//!
//! The guest-agent writes this run-private metadata after a successful
//! checkpoint. Runner consumes it to decide whether a parked idle sandbox can
//! safely skip session-history restore on a later same-session run.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Current final session-history identity metadata format version.
pub const FINAL_SESSION_HISTORY_IDENTITY_VERSION: u8 = 1;

/// Maximum size of the serialized final identity metadata file.
pub const FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES: u64 = 16 * 1024;

/// Maximum session-history bytes verified for idle restore skip.
pub const SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES: u64 = 1024 * 1024;

/// Framework that owns a final session-history file.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinalSessionHistoryFramework {
    /// Claude Code session history.
    ClaudeCode,
    /// Codex session history.
    Codex,
}

/// Storage ref kind for final session-history bytes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinalSessionHistoryRefKind {
    /// Hash-backed blob storage.
    Blob,
}

/// Run-private final session-history identity metadata.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalSessionHistoryIdentity {
    /// Metadata schema version.
    pub version: u8,
    /// CLI framework.
    pub framework: FinalSessionHistoryFramework,
    /// SHA-256 hash of the framework-normalized CLI session id.
    pub session_id_hash: String,
    /// Server resume history ref kind.
    pub history_ref_kind: FinalSessionHistoryRefKind,
    /// SHA-256 hash of final session-history bytes.
    pub history_hash: String,
    /// Exact final session-history byte length.
    pub history_size_bytes: u64,
    /// Private guest marker used to read final framework history.
    pub history_marker_payload: String,
}

impl FinalSessionHistoryIdentity {
    /// Build validated final identity metadata.
    pub fn new(
        framework: FinalSessionHistoryFramework,
        session_id_hash: impl Into<String>,
        history_ref_kind: FinalSessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: u64,
        history_marker_payload: impl Into<String>,
    ) -> Result<Self, FinalSessionHistoryIdentityError> {
        let identity = Self {
            version: FINAL_SESSION_HISTORY_IDENTITY_VERSION,
            framework,
            session_id_hash: session_id_hash.into(),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
            history_marker_payload: history_marker_payload.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

    /// Parse and validate final identity metadata from JSON bytes.
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, FinalSessionHistoryIdentityError> {
        if bytes.len() as u64 > FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES {
            return Err(FinalSessionHistoryIdentityError::MetadataTooLarge);
        }
        let identity: Self = serde_json::from_slice(bytes)
            .map_err(|_| FinalSessionHistoryIdentityError::InvalidJson)?;
        identity.validate()?;
        Ok(identity)
    }

    /// Serialize validated final identity metadata to JSON bytes.
    pub fn to_json_vec(&self) -> Result<Vec<u8>, FinalSessionHistoryIdentityError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| FinalSessionHistoryIdentityError::InvalidJson)?;
        if bytes.len() as u64 > FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES {
            return Err(FinalSessionHistoryIdentityError::MetadataTooLarge);
        }
        Ok(bytes)
    }

    /// Validate final identity metadata invariants.
    pub fn validate(&self) -> Result<(), FinalSessionHistoryIdentityError> {
        if self.version != FINAL_SESSION_HISTORY_IDENTITY_VERSION {
            return Err(FinalSessionHistoryIdentityError::UnsupportedVersion);
        }
        if !is_sha256_hex(&self.session_id_hash) {
            return Err(FinalSessionHistoryIdentityError::InvalidSessionIdHash);
        }
        if !is_sha256_hex(&self.history_hash) {
            return Err(FinalSessionHistoryIdentityError::InvalidHistoryHash);
        }
        if self.history_size_bytes == 0 {
            return Err(FinalSessionHistoryIdentityError::InvalidHistorySize);
        }
        if self.history_size_bytes > SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES {
            return Err(FinalSessionHistoryIdentityError::HistoryTooLarge);
        }
        if self.history_marker_payload.trim().is_empty() {
            return Err(FinalSessionHistoryIdentityError::MissingHistoryMarker);
        }
        Ok(())
    }
}

impl fmt::Debug for FinalSessionHistoryIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FinalSessionHistoryIdentity")
            .field("version", &self.version)
            .field("framework", &self.framework)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .field("history_marker_payload", &"[redacted]")
            .finish()
    }
}

/// Final identity metadata validation error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalSessionHistoryIdentityError {
    /// Metadata file exceeds the metadata read cap.
    MetadataTooLarge,
    /// Metadata is not valid JSON.
    InvalidJson,
    /// Metadata version is unsupported.
    UnsupportedVersion,
    /// Session id hash is not a SHA-256 hex digest.
    InvalidSessionIdHash,
    /// History hash is not a SHA-256 hex digest.
    InvalidHistoryHash,
    /// History size is zero.
    InvalidHistorySize,
    /// History size exceeds the verification cap.
    HistoryTooLarge,
    /// History marker payload is missing.
    MissingHistoryMarker,
}

impl fmt::Display for FinalSessionHistoryIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MetadataTooLarge => f.write_str("final session history identity is too large"),
            Self::InvalidJson => f.write_str("final session history identity is invalid JSON"),
            Self::UnsupportedVersion => {
                f.write_str("final session history identity version is unsupported")
            }
            Self::InvalidSessionIdHash => {
                f.write_str("final session history identity session id hash is invalid")
            }
            Self::InvalidHistoryHash => {
                f.write_str("final session history identity history hash is invalid")
            }
            Self::InvalidHistorySize => {
                f.write_str("final session history identity history size is invalid")
            }
            Self::HistoryTooLarge => {
                f.write_str("final session history identity history is too large")
            }
            Self::MissingHistoryMarker => {
                f.write_str("final session history identity marker is missing")
            }
        }
    }
}

impl std::error::Error for FinalSessionHistoryIdentityError {}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_identity() -> FinalSessionHistoryIdentity {
        FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap()
    }

    #[test]
    fn final_identity_round_trips_json() {
        let identity = valid_identity();
        let bytes = identity.to_json_vec().unwrap();

        assert_eq!(
            FinalSessionHistoryIdentity::from_json_slice(&bytes).unwrap(),
            identity
        );
    }

    #[test]
    fn final_identity_rejects_invalid_hashes() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "not-a-hash",
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            "/history.jsonl",
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidSessionIdHash);

        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "not-a-hash",
            12,
            "/history.jsonl",
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidHistoryHash);
    }

    #[test]
    fn final_identity_rejects_zero_and_oversized_history() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            0,
            "/history.jsonl",
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidHistorySize);

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
    fn final_identity_rejects_missing_marker() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            " ",
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::MissingHistoryMarker);
    }

    #[test]
    fn final_identity_debug_redacts_sensitive_fields() {
        let identity = valid_identity();
        let debug = format!("{identity:?}");

        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&identity.session_id_hash));
        assert!(!debug.contains(&identity.history_hash));
        assert!(!debug.contains(&identity.history_marker_payload));
    }
}
