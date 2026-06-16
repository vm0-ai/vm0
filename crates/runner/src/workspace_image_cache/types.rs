use serde::{Deserialize, Serialize};

use crate::ids::RunId;
use crate::storage_fingerprints::StorageFingerprints;

use super::{MAX_ENTRY_BYTES_CAP, MIN_FREE_BYTES_FLOOR};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceCacheCheckoutResult {
    Hit,
    Miss,
    NoSession,
    InvalidWorkingDir,
    LockBusy,
    InvalidMetadata,
    DiskPressure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceCacheTerminalStatus {
    Success,
    NonzeroExit,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImagePrepareRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: &'a str,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) working_dir: &'a str,
    pub(crate) image_size_bytes: u64,
    pub(crate) workspace_drive_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImageActiveLeaseRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: &'a str,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) working_dir: &'a str,
    pub(crate) image_size_bytes: u64,
    pub(crate) workspace_drive_available: bool,
}

pub(crate) struct WorkspaceImagePromotionRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) session_id_override: Option<&'a str>,
    pub(crate) terminal_status: WorkspaceCacheTerminalStatus,
    pub(crate) completed_at: String,
    pub(crate) storage_fingerprints: StorageFingerprints,
    pub(crate) promotable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsStats {
    pub(crate) total_bytes: u64,
    pub(crate) available_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheBudget {
    pub(crate) max_cache_bytes: u64,
    pub(crate) target_after_gc_bytes: u64,
    pub(crate) min_free_bytes: u64,
    pub(crate) max_entry_bytes: u64,
}

impl CacheBudget {
    pub(crate) fn from_fs_stats(stats: FsStats) -> Self {
        let max_cache_bytes = stats.total_bytes.saturating_mul(50) / 100;
        let target_after_gc_bytes = max_cache_bytes.saturating_mul(75) / 100;
        let min_free_bytes = (stats.total_bytes.saturating_mul(10) / 100).max(MIN_FREE_BYTES_FLOOR);
        let max_entry_bytes = (stats.total_bytes.saturating_mul(5) / 100).min(MAX_ENTRY_BYTES_CAP);
        Self {
            max_cache_bytes,
            target_after_gc_bytes,
            min_free_bytes,
            max_entry_bytes,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspection {
    pub(crate) cache_dir: String,
    pub(crate) lock_dir: String,
    pub(crate) fs_stats: FsStats,
    pub(crate) budget: CacheBudget,
    pub(crate) summary: WorkspaceImageCacheInspectionSummary,
    pub(crate) entries: Vec<WorkspaceImageCacheInspectionEntry>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspectionSummary {
    pub(crate) total_entries: usize,
    pub(crate) reusable_entries: usize,
    pub(crate) invalid_entries: usize,
    pub(crate) stale_entries: usize,
    pub(crate) temporary_entries: usize,
    pub(crate) locked_entries: usize,
    pub(crate) temporary_paths: usize,
    pub(crate) total_allocated_bytes: u64,
    pub(crate) total_logical_image_bytes: u64,
    pub(crate) temporary_allocated_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspectionEntry {
    pub(crate) cache_key: String,
    pub(crate) status: WorkspaceImageCacheInspectionStatus,
    pub(crate) reason: Option<String>,
    pub(crate) cache_scope: Option<String>,
    pub(crate) profile_name: Option<String>,
    pub(crate) working_dir: Option<String>,
    pub(crate) last_completed_at: Option<String>,
    pub(crate) last_used_at: Option<String>,
    pub(crate) last_terminal_status: Option<WorkspaceCacheTerminalStatus>,
    pub(crate) allocated_bytes: u64,
    pub(crate) logical_image_size_bytes: u64,
    pub(crate) temporary_path_count: usize,
    pub(crate) temporary_allocated_bytes: u64,
    pub(crate) storage_count: usize,
    pub(crate) artifact_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceImageCacheInspectionStatus {
    Reusable,
    Invalid,
    Stale,
    TemporaryOnly,
    Locked,
}

impl WorkspaceCacheTerminalStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::NonzeroExit => "nonzeroExit",
            Self::Cancelled => "cancelled",
        }
    }
}

impl WorkspaceImageCacheInspectionStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reusable => "reusable",
            Self::Invalid => "invalid",
            Self::Stale => "stale",
            Self::TemporaryOnly => "temporaryOnly",
            Self::Locked => "locked",
        }
    }
}
