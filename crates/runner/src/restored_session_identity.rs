use std::fmt;

use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, FinalSessionHistoryFramework,
    FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
    SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES,
};
use sha2::{Digest, Sha256};

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

#[derive(Clone, Eq)]
pub(crate) struct RestoredSessionIdentity {
    framework: RestoredSessionFramework,
    restore_format_version: u8,
    session_id_hash: String,
    history_ref_kind: ResumeSessionHistoryRefKind,
    history_hash: String,
    history_size_bytes: Option<u64>,
    verifier: Option<RestoredSessionIdentityVerifier>,
}

#[derive(Clone, Eq, PartialEq)]
enum RestoredSessionIdentityVerifier {
    GuestHistoryPath {
        guest_history_path: String,
    },
    FinalIdentityMetadata {
        metadata_path: String,
        runtime_dir: String,
    },
}

pub(crate) enum RestoredSessionHistoryVerification<'a> {
    GuestHistoryPath {
        expected_size: u64,
        guest_history_path: &'a str,
        read_limit: u64,
    },
    FinalIdentityMetadata {
        metadata_path: &'a str,
        runtime_dir: &'a str,
    },
}

impl RestoredSessionIdentity {
    pub(crate) fn new(
        framework: RestoredSessionFramework,
        identity_session_id: &str,
        history_ref_kind: ResumeSessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: Option<u64>,
        guest_history_path: Option<String>,
    ) -> Self {
        // Callers pass the framework-normalized identity id. Claude Code uses
        // the raw session id; Codex uses the canonical thread id.
        Self {
            framework,
            restore_format_version: framework.restore_format_version(),
            session_id_hash: hex::encode(Sha256::digest(identity_session_id.as_bytes())),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
            verifier: guest_history_path.map(|guest_history_path| {
                RestoredSessionIdentityVerifier::GuestHistoryPath { guest_history_path }
            }),
        }
    }

    pub(crate) fn from_final_metadata(
        metadata: FinalSessionHistoryIdentity,
        metadata_path: impl Into<String>,
        runtime_dir: impl Into<String>,
    ) -> Option<Self> {
        metadata.validate().ok()?;
        let framework = restored_session_framework_from_final(metadata.framework);
        let history_ref_kind = resume_history_ref_kind_from_final(metadata.history_ref_kind);
        let identity = Self {
            framework,
            restore_format_version: framework.restore_format_version(),
            session_id_hash: metadata.session_id_hash,
            history_ref_kind,
            history_hash: metadata.history_hash,
            history_size_bytes: Some(metadata.history_size_bytes),
            verifier: Some(RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path: metadata_path.into(),
                runtime_dir: runtime_dir.into(),
            }),
        };
        identity
            .has_guest_history_verification()
            .then_some(identity)
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
        self.verifier = Some(RestoredSessionIdentityVerifier::GuestHistoryPath {
            guest_history_path: guest_history_path.into(),
        });
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
        match &self.verifier {
            Some(RestoredSessionIdentityVerifier::GuestHistoryPath { guest_history_path }) => {
                Some(guest_history_path)
            }
            _ => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn final_metadata_path(&self) -> Option<&str> {
        match &self.verifier {
            Some(RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path, ..
            }) => Some(metadata_path),
            _ => None,
        }
    }

    pub(crate) fn guest_history_verification(
        &self,
    ) -> Option<RestoredSessionHistoryVerification<'_>> {
        let expected_size = self.history_size_bytes?;
        if expected_size > SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES {
            return None;
        }
        match self.verifier.as_ref()? {
            RestoredSessionIdentityVerifier::GuestHistoryPath { guest_history_path } => {
                if !guest_history_path.starts_with('/') {
                    return None;
                }
                let read_limit = expected_size.checked_add(1)?;
                if read_limit > SESSION_HISTORY_IDENTITY_VERIFY_MAX_BYTES {
                    return None;
                }
                Some(RestoredSessionHistoryVerification::GuestHistoryPath {
                    expected_size,
                    guest_history_path,
                    read_limit,
                })
            }
            RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path,
                runtime_dir,
            } => {
                if !metadata_path.starts_with('/') || !runtime_dir.starts_with('/') {
                    return None;
                }
                Some(RestoredSessionHistoryVerification::FinalIdentityMetadata {
                    metadata_path,
                    runtime_dir,
                })
            }
        }
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
                "verifier",
                &self.verifier.as_ref().map(|verifier| match verifier {
                    RestoredSessionIdentityVerifier::GuestHistoryPath { .. } => {
                        "[redacted-guest-history-path]"
                    }
                    RestoredSessionIdentityVerifier::FinalIdentityMetadata { .. } => {
                        "[redacted-final-identity-metadata]"
                    }
                }),
            )
            .finish()
    }
}

pub(crate) const FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT: u64 =
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1;

fn restored_session_framework_from_final(
    framework: FinalSessionHistoryFramework,
) -> RestoredSessionFramework {
    match framework {
        FinalSessionHistoryFramework::ClaudeCode => RestoredSessionFramework::ClaudeCode,
        FinalSessionHistoryFramework::Codex => RestoredSessionFramework::Codex,
    }
}

fn resume_history_ref_kind_from_final(
    kind: FinalSessionHistoryRefKind,
) -> ResumeSessionHistoryRefKind {
    match kind {
        FinalSessionHistoryRefKind::Blob => ResumeSessionHistoryRefKind::Blob,
    }
}
