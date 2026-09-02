//! Fixed reused-Codex session cleanup contract.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::codex_session_path::is_canonical_codex_rollout_relative_path;
use crate::codex_thread_id::CodexThreadId;

/// Stable diagnostic label for the fixed reused-Codex cleanup operation.
pub const CODEX_SESSION_CLEANUP_DIAGNOSTIC_LABEL: &str = "codex-session-cleanup";
/// Maximum captured bytes for each cleanup output stream.
pub const CODEX_SESSION_CLEANUP_OUTPUT_LIMIT_BYTES: u32 = 64 * 1024;
/// Maximum number of session-tree entries inspected by the fixed helper.
pub const CODEX_SESSION_CLEANUP_SCAN_BUDGET: u32 = 16_384;
/// Maximum encoded length accepted for the fallback relative rollout path.
pub const CODEX_SESSION_CLEANUP_MAX_PATH_BYTES: usize = 4_096;

/// Structured request carried by the fixed reused-Codex cleanup role.
///
/// Runner and the bundled guest are deployed atomically. This shape prevents
/// cleanup from accepting an executable, arbitrary environment, Codex home,
/// scan budget, sudo choice, or containment policy from the caller.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexSessionCleanupRequest {
    /// Canonical lowercase hyphenated Codex thread identifier.
    pub session_id: String,
    /// Canonical logical rollout path relative to the fixed Codex home.
    pub fallback_relative_path: String,
}

impl CodexSessionCleanupRequest {
    /// Validate the fixed helper inputs before selecting process containment.
    pub fn validate(&self) -> Result<(), CodexSessionCleanupRequestError> {
        let thread_id = CodexThreadId::parse(&self.session_id)
            .filter(|thread_id| thread_id.as_str() == self.session_id)
            .ok_or(CodexSessionCleanupRequestError::InvalidSessionId)?;
        if self.fallback_relative_path.len() > CODEX_SESSION_CLEANUP_MAX_PATH_BYTES
            || !is_canonical_codex_rollout_relative_path(&self.fallback_relative_path, &thread_id)
        {
            return Err(CodexSessionCleanupRequestError::InvalidFallbackPath);
        }
        Ok(())
    }

    /// Return the filename key derived from the validated canonical thread id.
    pub fn filename_key(&self) -> Result<String, CodexSessionCleanupRequestError> {
        let thread_id = CodexThreadId::parse(&self.session_id)
            .filter(|thread_id| thread_id.as_str() == self.session_id)
            .ok_or(CodexSessionCleanupRequestError::InvalidSessionId)?;
        Ok(thread_id.filename_key())
    }
}

/// Validation failure for the fixed reused-Codex cleanup request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodexSessionCleanupRequestError {
    /// The session id is not canonical lowercase hyphenated UUID text.
    InvalidSessionId,
    /// The fallback path is not the matching canonical logical rollout path.
    InvalidFallbackPath,
}

impl fmt::Display for CodexSessionCleanupRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSessionId => f.write_str("Codex cleanup session id is invalid"),
            Self::InvalidFallbackPath => f.write_str("Codex cleanup fallback path is invalid"),
        }
    }
}

impl std::error::Error for CodexSessionCleanupRequestError {}
