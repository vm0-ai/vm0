use std::fmt;

use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, FinalSessionHistoryFramework,
    FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RestoredSessionIdentityMismatchReason {
    Framework,
    RestoreFormatVersion,
    SessionIdentity,
    HistoryRefKind,
    HistoryHash,
    HistorySize,
    MissingRequestedIdentity,
}

impl RestoredSessionIdentityMismatchReason {
    pub(crate) const fn action_type(self) -> &'static str {
        match self {
            Self::Framework => "session_history_identity_mismatch_framework",
            Self::RestoreFormatVersion => {
                "session_history_identity_mismatch_restore_format_version"
            }
            Self::SessionIdentity => "session_history_identity_mismatch_session_identity",
            Self::HistoryRefKind => "session_history_identity_mismatch_history_ref_kind",
            Self::HistoryHash => "session_history_identity_mismatch_history_hash",
            Self::HistorySize => "session_history_identity_mismatch_history_size",
            Self::MissingRequestedIdentity => {
                "session_history_identity_mismatch_missing_requested_identity"
            }
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
    FinalIdentityMetadata {
        metadata_path: String,
        runtime_dir: String,
    },
}

pub(crate) struct RestoredSessionFinalMetadataVerification<'a> {
    pub(crate) metadata_path: &'a str,
    pub(crate) runtime_dir: &'a str,
    pub(crate) framework: FinalSessionHistoryFramework,
    pub(crate) session_id_hash: &'a str,
    pub(crate) history_ref_kind: FinalSessionHistoryRefKind,
    pub(crate) history_hash: &'a str,
    pub(crate) history_size_bytes: u64,
}

impl RestoredSessionIdentity {
    pub(crate) fn new(
        framework: RestoredSessionFramework,
        identity_session_id: &str,
        history_ref_kind: ResumeSessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: Option<u64>,
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
            verifier: None,
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
            .has_final_metadata_verification()
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
        )
    }

    #[cfg(test)]
    pub(crate) fn history_hash(&self) -> &str {
        &self.history_hash
    }

    #[cfg(test)]
    pub(crate) fn history_size_bytes(&self) -> Option<u64> {
        self.history_size_bytes
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

    pub(crate) fn final_metadata_verification(
        &self,
    ) -> Option<RestoredSessionFinalMetadataVerification<'_>> {
        let expected_size = self.history_size_bytes?;
        match self.verifier.as_ref()? {
            RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path,
                runtime_dir,
            } => {
                if !metadata_path.starts_with('/') || !runtime_dir.starts_with('/') {
                    return None;
                }
                Some(RestoredSessionFinalMetadataVerification {
                    metadata_path,
                    runtime_dir,
                    framework: final_session_history_framework(self.framework),
                    session_id_hash: &self.session_id_hash,
                    history_ref_kind: final_session_history_ref_kind(self.history_ref_kind),
                    history_hash: &self.history_hash,
                    history_size_bytes: expected_size,
                })
            }
        }
    }

    pub(crate) fn has_final_metadata_verification(&self) -> bool {
        self.final_metadata_verification().is_some()
    }

    pub(crate) fn is_verified_match_for_request(&self, requested: &Self) -> bool {
        self == requested
            && self.has_final_metadata_verification()
            && requested
                .history_size_bytes
                .is_none_or(|requested_size| self.history_size_bytes == Some(requested_size))
    }

    pub(crate) fn mismatch_reason_for_request(
        &self,
        requested: &Self,
    ) -> Option<RestoredSessionIdentityMismatchReason> {
        if self.framework != requested.framework {
            return Some(RestoredSessionIdentityMismatchReason::Framework);
        }
        if self.restore_format_version != requested.restore_format_version {
            return Some(RestoredSessionIdentityMismatchReason::RestoreFormatVersion);
        }
        if self.session_id_hash != requested.session_id_hash {
            return Some(RestoredSessionIdentityMismatchReason::SessionIdentity);
        }
        if self.history_ref_kind != requested.history_ref_kind {
            return Some(RestoredSessionIdentityMismatchReason::HistoryRefKind);
        }
        if self.history_hash != requested.history_hash {
            return Some(RestoredSessionIdentityMismatchReason::HistoryHash);
        }
        if let Some(requested_size) = requested.history_size_bytes
            && self.history_size_bytes != Some(requested_size)
        {
            return Some(RestoredSessionIdentityMismatchReason::HistorySize);
        }
        None
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

fn final_session_history_framework(
    framework: RestoredSessionFramework,
) -> FinalSessionHistoryFramework {
    match framework {
        RestoredSessionFramework::ClaudeCode => FinalSessionHistoryFramework::ClaudeCode,
        RestoredSessionFramework::Codex => FinalSessionHistoryFramework::Codex,
    }
}

fn resume_history_ref_kind_from_final(
    kind: FinalSessionHistoryRefKind,
) -> ResumeSessionHistoryRefKind {
    match kind {
        FinalSessionHistoryRefKind::Blob => ResumeSessionHistoryRefKind::Blob,
    }
}

fn final_session_history_ref_kind(kind: ResumeSessionHistoryRefKind) -> FinalSessionHistoryRefKind {
    match kind {
        ResumeSessionHistoryRefKind::Blob => FinalSessionHistoryRefKind::Blob,
    }
}
