use std::fmt;

use crate::types::ResumeSessionHistoryRefKind;

const CLAUDE_CODE_RESTORE_FORMAT_VERSION: u8 = 1;
const CODEX_RESTORE_FORMAT_VERSION: u8 = 1;

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

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RestoredSessionIdentity {
    framework: RestoredSessionFramework,
    restore_format_version: u8,
    history_ref_kind: ResumeSessionHistoryRefKind,
    history_hash: String,
}

impl RestoredSessionIdentity {
    pub(crate) fn new(
        framework: RestoredSessionFramework,
        history_ref_kind: ResumeSessionHistoryRefKind,
        history_hash: impl Into<String>,
    ) -> Self {
        Self {
            framework,
            restore_format_version: framework.restore_format_version(),
            history_ref_kind,
            history_hash: history_hash.into(),
        }
    }

    #[cfg(test)]
    pub(crate) fn claude_code_for_test(history_hash: impl Into<String>) -> Self {
        Self::new(
            RestoredSessionFramework::ClaudeCode,
            ResumeSessionHistoryRefKind::Blob,
            history_hash,
        )
    }
}

impl fmt::Debug for RestoredSessionIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RestoredSessionIdentity")
            .field("framework", &self.framework)
            .field("restore_format_version", &self.restore_format_version)
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .finish()
    }
}
