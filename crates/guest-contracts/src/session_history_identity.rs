//! Shared final session-history identity metadata.
//!
//! The guest-agent writes this run-private metadata after a successful
//! checkpoint. Runner consumes it to decide whether a parked idle sandbox can
//! safely skip session-history restore on a later same-session run.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Maximum size of the serialized final identity metadata file.
pub const FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES: u64 = 16 * 1024;

/// Guest helper exit code for successful final identity verification.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS: i32 = 0;
/// Guest helper exit code for uncategorized final identity verification failure.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE: i32 = 1;
/// Guest helper exit code for invalid command arguments.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS: i32 = 2;
/// Guest helper exit code for metadata read failure.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ: i32 = 3;
/// Guest helper exit code for invalid metadata.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA: i32 = 4;
/// Guest helper exit code for framework/source mismatch.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH: i32 = 5;
/// Guest helper exit code for expected identity mismatch.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH: i32 = 6;
/// Guest helper exit code for local history read failure.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ: i32 = 7;
/// Guest helper exit code for local history size/hash mismatch.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH: i32 = 8;
/// Guest helper exit code for local history exceeding the guest verification budget.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE: i32 = 9;
/// Guest helper exit code for sidecar output create or write failure.
///
/// Exit code 10 previously represented sidecar export unavailability and
/// remains reserved for that historical meaning.
pub const SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE: i32 = 11;
/// Framework that owns a final session-history file.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinalSessionHistoryFramework {
    /// Claude Code session history.
    ClaudeCode,
    /// Codex session history.
    Codex,
    /// Pi official JSONL session history.
    Pi,
}

/// Storage ref kind for final session-history bytes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinalSessionHistoryRefKind {
    /// Hash-backed blob storage.
    Blob,
}

/// Canonical framework-owned source for final session-history bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FinalSessionHistorySourceRef {
    /// Claude Code history derived from its effective config directory and cwd.
    ClaudeCode {
        /// Effective Claude config directory from the finalized child environment.
        #[serde(rename = "configDir")]
        config_dir: String,
        /// Explicit working directory used to launch Claude Code.
        #[serde(rename = "workingDir")]
        working_dir: String,
        /// Validated Claude Code session identifier captured from the event stream.
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// Codex history discovered below its finalized sessions directory.
    Codex {
        /// Final guest-agent-controlled Codex sessions directory.
        #[serde(rename = "sessionsDir")]
        sessions_dir: String,
        /// Canonical Codex thread identifier captured from the event stream.
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    /// Pi official JSONL history reported for the captured session.
    Pi {
        /// Absolute path below the canonical Pi session directory.
        #[serde(rename = "sessionPath")]
        session_path: String,
        /// Session identifier bound to the reported filename.
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

impl FinalSessionHistorySourceRef {
    fn validate(&self) -> Result<(), FinalSessionHistoryIdentityError> {
        let valid = match self {
            Self::ClaudeCode {
                config_dir,
                working_dir,
                session_id,
            } => !config_dir.is_empty() && !working_dir.is_empty() && !session_id.is_empty(),
            Self::Codex {
                sessions_dir,
                thread_id,
            } => !sessions_dir.is_empty() && !thread_id.is_empty(),
            Self::Pi {
                session_path,
                session_id,
            } => !session_path.is_empty() && !session_id.is_empty(),
        };
        if valid {
            Ok(())
        } else {
            Err(FinalSessionHistoryIdentityError::InvalidHistorySource)
        }
    }
}

/// Native on-disk representation used for cached session-history sidecars.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionHistorySidecarRepresentation {
    /// Uncompressed session-history bytes.
    Raw,
    /// Codex zstd session-history bytes.
    CodexZstd,
}

/// Metadata printed by the guest sidecar export helper.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistorySidecarExportMetadata {
    /// Representation written to the exported sidecar file.
    pub representation: SessionHistorySidecarRepresentation,
    /// Exact byte length of the exported sidecar file.
    pub encoded_size: u64,
}

/// Safe low-cardinality I/O class emitted for a sidecar output failure.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionHistorySidecarIoErrorClass {
    /// A required filesystem object was not found.
    NotFound,
    /// Filesystem permissions rejected the operation.
    PermissionDenied,
    /// The filesystem had no storage space available.
    StorageFull,
    /// The filesystem quota was exhausted.
    QuotaExceeded,
    /// The I/O failure has no more specific safe class.
    Unknown,
}

impl SessionHistorySidecarIoErrorClass {
    /// Return the stable telemetry label for this class.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::PermissionDenied => "permission-denied",
            Self::StorageFull => "storage-full",
            Self::QuotaExceeded => "quota-exceeded",
            Self::Unknown => "unknown",
        }
    }
}

/// Safe metadata printed when sidecar output creation or writing fails.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistorySidecarExportFailure {
    /// Low-cardinality class of the output I/O failure.
    pub io_error_class: SessionHistorySidecarIoErrorClass,
}

/// Run-private final session-history identity metadata.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalSessionHistoryIdentity {
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
    /// Canonical structured source used to read final framework history.
    pub history_source: FinalSessionHistorySourceRef,
}

impl FinalSessionHistoryIdentity {
    /// Build validated final identity metadata.
    pub fn new(
        framework: FinalSessionHistoryFramework,
        session_id_hash: impl Into<String>,
        history_ref_kind: FinalSessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: u64,
        history_source: FinalSessionHistorySourceRef,
    ) -> Result<Self, FinalSessionHistoryIdentityError> {
        let identity = Self {
            framework,
            session_id_hash: session_id_hash.into(),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
            history_source,
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
        if !is_sha256_hex(&self.session_id_hash) {
            return Err(FinalSessionHistoryIdentityError::InvalidSessionIdHash);
        }
        if !is_sha256_hex(&self.history_hash) {
            return Err(FinalSessionHistoryIdentityError::InvalidHistoryHash);
        }
        if self.history_size_bytes == 0 {
            return Err(FinalSessionHistoryIdentityError::InvalidHistorySize);
        }
        self.history_source.validate()?;
        if !matches!(
            (self.framework, &self.history_source),
            (
                FinalSessionHistoryFramework::ClaudeCode,
                FinalSessionHistorySourceRef::ClaudeCode { .. }
            ) | (
                FinalSessionHistoryFramework::Codex,
                FinalSessionHistorySourceRef::Codex { .. }
            ) | (
                FinalSessionHistoryFramework::Pi,
                FinalSessionHistorySourceRef::Pi { .. }
            )
        ) {
            return Err(FinalSessionHistoryIdentityError::InvalidHistorySource);
        }
        Ok(())
    }
}

impl FinalSessionHistoryFramework {
    /// Return the stable CLI argument spelling used by runner and guest-agent.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    /// Parse the stable CLI argument spelling used by runner and guest-agent.
    pub fn parse_cli_arg(value: &str) -> Result<Self, FinalSessionHistoryIdentityError> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "pi" => Ok(Self::Pi),
            _ => Err(FinalSessionHistoryIdentityError::InvalidFramework),
        }
    }
}

impl FinalSessionHistoryRefKind {
    /// Return the stable CLI argument spelling used by runner and guest-agent.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blob => "blob",
        }
    }

    /// Parse the stable CLI argument spelling used by runner and guest-agent.
    pub fn parse_cli_arg(value: &str) -> Result<Self, FinalSessionHistoryIdentityError> {
        match value {
            "blob" => Ok(Self::Blob),
            _ => Err(FinalSessionHistoryIdentityError::InvalidHistoryRefKind),
        }
    }
}

/// Expected final identity fields supplied by runner when verifying a parked
/// sandbox's checkpointed metadata.
#[derive(Clone, Eq, PartialEq)]
pub struct FinalSessionHistoryIdentityExpectation {
    /// CLI framework expected by runner.
    pub framework: FinalSessionHistoryFramework,
    /// SHA-256 hash of the framework-normalized CLI session id expected by runner.
    pub session_id_hash: String,
    /// Server resume history ref kind expected by runner.
    pub history_ref_kind: FinalSessionHistoryRefKind,
    /// SHA-256 hash of final session-history bytes expected by runner.
    pub history_hash: String,
    /// Exact final session-history byte length expected by runner.
    pub history_size_bytes: u64,
}

impl fmt::Debug for FinalSessionHistoryIdentityExpectation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FinalSessionHistoryIdentityExpectation")
            .field("framework", &self.framework)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .finish()
    }
}

impl FinalSessionHistoryIdentityExpectation {
    /// Build validated expected final identity fields.
    pub fn new(
        framework: FinalSessionHistoryFramework,
        session_id_hash: impl Into<String>,
        history_ref_kind: FinalSessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: u64,
    ) -> Result<Self, FinalSessionHistoryIdentityError> {
        let expectation = Self {
            framework,
            session_id_hash: session_id_hash.into(),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
        };
        expectation.validate()?;
        Ok(expectation)
    }

    /// Parse expected final identity fields from helper CLI arguments.
    pub fn from_cli_args(args: [&str; 5]) -> Result<Self, FinalSessionHistoryIdentityError> {
        let history_size_bytes = args[4]
            .parse::<u64>()
            .map_err(|_| FinalSessionHistoryIdentityError::InvalidHistorySize)?;
        Self::new(
            FinalSessionHistoryFramework::parse_cli_arg(args[0])?,
            args[1],
            FinalSessionHistoryRefKind::parse_cli_arg(args[2])?,
            args[3],
            history_size_bytes,
        )
    }

    /// Validate expected final identity invariants.
    pub fn validate(&self) -> Result<(), FinalSessionHistoryIdentityError> {
        if !is_sha256_hex(&self.session_id_hash) {
            return Err(FinalSessionHistoryIdentityError::InvalidSessionIdHash);
        }
        if !is_sha256_hex(&self.history_hash) {
            return Err(FinalSessionHistoryIdentityError::InvalidHistoryHash);
        }
        if self.history_size_bytes == 0 {
            return Err(FinalSessionHistoryIdentityError::InvalidHistorySize);
        }
        Ok(())
    }

    /// Return whether metadata read from the guest still matches runner's expected identity.
    pub fn matches_identity(&self, identity: &FinalSessionHistoryIdentity) -> bool {
        self.framework == identity.framework
            && self.session_id_hash == identity.session_id_hash
            && self.history_ref_kind == identity.history_ref_kind
            && self.history_hash == identity.history_hash
            && self.history_size_bytes == identity.history_size_bytes
    }
}

impl fmt::Debug for FinalSessionHistoryIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FinalSessionHistoryIdentity")
            .field("framework", &self.framework)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .field("history_source", &"[redacted]")
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
    /// Framework value is not recognized.
    InvalidFramework,
    /// History ref kind value is not recognized.
    InvalidHistoryRefKind,
    /// Session id hash is not a SHA-256 hex digest.
    InvalidSessionIdHash,
    /// History hash is not a SHA-256 hex digest.
    InvalidHistoryHash,
    /// History size is zero.
    InvalidHistorySize,
    /// Metadata contains an invalid structured history source.
    InvalidHistorySource,
}

impl fmt::Display for FinalSessionHistoryIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MetadataTooLarge => f.write_str("final session history identity is too large"),
            Self::InvalidJson => f.write_str("final session history identity is invalid JSON"),
            Self::InvalidFramework => {
                f.write_str("final session history identity framework is invalid")
            }
            Self::InvalidHistoryRefKind => {
                f.write_str("final session history identity ref kind is invalid")
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
            Self::InvalidHistorySource => {
                f.write_str("final session history identity source is invalid")
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

    fn valid_source() -> FinalSessionHistorySourceRef {
        FinalSessionHistorySourceRef::ClaudeCode {
            config_dir: "/home/user/.claude".to_string(),
            working_dir: "/home/user/workspace".to_string(),
            session_id: "session".to_string(),
        }
    }

    #[test]
    fn session_history_identity_verify_exit_codes_are_stable() {
        assert_eq!(
            [
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
                SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE,
            ],
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11]
        );
    }

    #[test]
    fn sidecar_export_failure_round_trips_json() {
        let failure = SessionHistorySidecarExportFailure {
            io_error_class: SessionHistorySidecarIoErrorClass::StorageFull,
        };

        let json = serde_json::to_vec(&failure).unwrap();

        assert_eq!(
            serde_json::from_slice::<SessionHistorySidecarExportFailure>(&json).unwrap(),
            failure
        );
        assert_eq!(failure.io_error_class.as_str(), "storage-full");
    }

    fn valid_identity() -> FinalSessionHistoryIdentity {
        FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            valid_source(),
        )
        .unwrap()
    }

    #[test]
    fn final_identity_round_trips_json() {
        let identity = valid_identity();
        let bytes = identity.to_json_vec().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(
            FinalSessionHistoryIdentity::from_json_slice(&bytes).unwrap(),
            identity
        );
        assert!(value.get("version").is_none());
        assert!(value.get("historySource").is_some());
        assert!(value.get("historyMarkerPayload").is_none());
    }

    #[test]
    fn final_identity_rejects_invalid_hashes() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "not-a-hash",
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            valid_source(),
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidSessionIdHash);

        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "not-a-hash",
            12,
            valid_source(),
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidHistoryHash);
    }

    #[test]
    fn final_identity_rejects_zero_history() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            0,
            valid_source(),
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidHistorySize);
    }

    #[test]
    fn final_identity_accepts_large_history_size() {
        let identity = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            u64::MAX,
            valid_source(),
        )
        .unwrap();

        assert_eq!(identity.history_size_bytes, u64::MAX);
        assert_eq!(
            FinalSessionHistoryIdentity::from_json_slice(&identity.to_json_vec().unwrap()).unwrap(),
            identity
        );
    }

    #[test]
    fn final_identity_rejects_invalid_history_source() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            FinalSessionHistorySourceRef::ClaudeCode {
                config_dir: String::new(),
                working_dir: "/home/user/workspace".to_string(),
                session_id: "session".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidHistorySource);
    }

    #[test]
    fn final_identity_rejects_history_source_from_another_framework() {
        let err = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            valid_source(),
        )
        .unwrap_err();

        assert_eq!(err, FinalSessionHistoryIdentityError::InvalidHistorySource);
    }

    #[test]
    fn final_identity_debug_redacts_sensitive_fields() {
        let identity = valid_identity();
        let debug = format!("{identity:?}");

        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&identity.session_id_hash));
        assert!(!debug.contains(&identity.history_hash));
        assert!(!debug.contains("/home/user/.claude"));
        assert!(!debug.contains("/home/user/workspace"));
    }

    #[test]
    fn final_identity_expectation_parses_cli_args_and_matches_identity() {
        let identity = valid_identity();
        let expectation = FinalSessionHistoryIdentityExpectation::from_cli_args([
            identity.framework.as_str(),
            &identity.session_id_hash,
            identity.history_ref_kind.as_str(),
            &identity.history_hash,
            &identity.history_size_bytes.to_string(),
        ])
        .unwrap();

        assert!(expectation.matches_identity(&identity));
    }

    #[test]
    fn final_identity_expectation_accepts_large_history_size() {
        let expectation = FinalSessionHistoryIdentityExpectation::new(
            FinalSessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            FinalSessionHistoryRefKind::Blob,
            "b".repeat(64),
            u64::MAX,
        )
        .unwrap();

        assert_eq!(expectation.history_size_bytes, u64::MAX);
    }

    #[test]
    fn final_identity_expectation_detects_mismatch() {
        let identity = valid_identity();
        let expectation = FinalSessionHistoryIdentityExpectation::new(
            identity.framework,
            identity.session_id_hash.clone(),
            identity.history_ref_kind,
            "c".repeat(64),
            identity.history_size_bytes,
        )
        .unwrap();

        assert!(!expectation.matches_identity(&identity));
    }

    #[test]
    fn final_identity_expectation_debug_redacts_sensitive_fields() {
        let identity = valid_identity();
        let expectation = FinalSessionHistoryIdentityExpectation::new(
            identity.framework,
            identity.session_id_hash.clone(),
            identity.history_ref_kind,
            identity.history_hash.clone(),
            identity.history_size_bytes,
        )
        .unwrap();
        let debug = format!("{expectation:?}");

        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&identity.session_id_hash));
        assert!(!debug.contains(&identity.history_hash));
    }
}
