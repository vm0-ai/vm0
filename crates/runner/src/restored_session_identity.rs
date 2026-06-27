use std::fmt;

use sha2::{Digest, Sha256};

use crate::types::ResumeSessionHistoryRefKind;

const CLAUDE_CODE_RESTORE_FORMAT_VERSION: u8 = 1;
const CODEX_RESTORE_FORMAT_VERSION: u8 = 1;

// Verification reads `expected_size + 1` bytes so a larger guest file cannot
// masquerade as the requested history by sharing the expected prefix.
pub(crate) const RESTORED_SESSION_IDENTITY_VERIFY_MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RestoredSessionFramework {
    ClaudeCode,
    Codex,
}

impl RestoredSessionFramework {
    pub(crate) const fn restore_format_version(self) -> u8 {
        match self {
            Self::ClaudeCode => CLAUDE_CODE_RESTORE_FORMAT_VERSION,
            Self::Codex => CODEX_RESTORE_FORMAT_VERSION,
        }
    }
}

#[derive(Clone, Eq)]
pub(crate) struct RestoredSessionIdentity {
    framework: RestoredSessionFramework,
    restore_format_version: u8,
    session_id_hash: String,
    history_ref_kind: ResumeSessionHistoryRefKind,
    history_hash: String,
    history_size_bytes: Option<u64>,
    guest_history_path: Option<String>,
}

pub(crate) struct RestoredSessionHistoryVerification<'a> {
    pub(crate) expected_size: u64,
    pub(crate) guest_history_path: &'a str,
    pub(crate) read_limit: u64,
}

impl RestoredSessionIdentity {
    pub(crate) fn new(
        framework: RestoredSessionFramework,
        cli_agent_session_id: &str,
        history_ref_kind: ResumeSessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: Option<u64>,
        guest_history_path: Option<String>,
    ) -> Self {
        Self {
            framework,
            restore_format_version: framework.restore_format_version(),
            session_id_hash: hex::encode(Sha256::digest(cli_agent_session_id.as_bytes())),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
            guest_history_path,
        }
    }

    #[cfg(test)]
    pub(crate) fn claude_code_for_test(history_hash: impl Into<String>) -> Self {
        Self::new(
            RestoredSessionFramework::ClaudeCode,
            "sess-restore-plan",
            ResumeSessionHistoryRefKind::Blob,
            history_hash,
            None,
            None,
        )
    }

    pub(crate) fn with_guest_history(
        mut self,
        history_size_bytes: u64,
        guest_history_path: impl Into<String>,
    ) -> Self {
        self.history_size_bytes = Some(history_size_bytes);
        self.guest_history_path = Some(guest_history_path.into());
        self
    }

    pub(crate) fn history_hash(&self) -> &str {
        &self.history_hash
    }

    #[cfg(test)]
    pub(crate) fn history_size_bytes(&self) -> Option<u64> {
        self.history_size_bytes
    }

    #[cfg(test)]
    pub(crate) fn guest_history_path(&self) -> Option<&str> {
        self.guest_history_path.as_deref()
    }

    pub(crate) fn guest_history_verification(
        &self,
    ) -> Option<RestoredSessionHistoryVerification<'_>> {
        let expected_size = self.history_size_bytes?;
        let guest_history_path = self.guest_history_path.as_deref()?;
        if !guest_history_path.starts_with('/') {
            return None;
        }
        let read_limit = expected_size.checked_add(1)?;
        if read_limit > RESTORED_SESSION_IDENTITY_VERIFY_MAX_BYTES {
            return None;
        }
        Some(RestoredSessionHistoryVerification {
            expected_size,
            guest_history_path,
            read_limit,
        })
    }

    pub(crate) fn has_guest_history_verification(&self) -> bool {
        self.guest_history_verification().is_some()
    }

    pub(crate) fn is_verified_match_for_request(&self, requested: &Self) -> bool {
        self == requested
            && self.has_guest_history_verification()
            && requested
                .history_size_bytes
                .is_none_or(|requested_size| self.history_size_bytes == Some(requested_size))
    }
}

impl PartialEq for RestoredSessionIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.framework == other.framework
            && self.restore_format_version == other.restore_format_version
            && self.session_id_hash == other.session_id_hash
            && self.history_ref_kind == other.history_ref_kind
            && self.history_hash == other.history_hash
    }
}

impl fmt::Debug for RestoredSessionIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RestoredSessionIdentity")
            .field("framework", &self.framework)
            .field("restore_format_version", &self.restore_format_version)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .field(
                "guest_history_path",
                &self.guest_history_path.as_ref().map(|_| "[redacted]"),
            )
            .finish()
    }
}
