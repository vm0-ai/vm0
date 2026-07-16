//! Contract for preparing a completed guest for idle reuse.

use serde::{Deserialize, Serialize};

use crate::process_containment::ProcessContainmentEvidence;

/// Helper completed successfully and emitted a reuse-preparation report.
pub const REUSE_PREPARATION_EXIT_SUCCESS: i32 = 0;
/// The helper request was missing or invalid.
pub const REUSE_PREPARATION_EXIT_INVALID_REQUEST: i32 = 2;
/// Root filesystem capacity could not be inspected.
pub const REUSE_PREPARATION_EXIT_INSPECTION_FAILED: i32 = 3;
/// Stale runner-owned runtime state could not be safely removed.
pub const REUSE_PREPARATION_EXIT_CLEANUP_FAILED: i32 = 4;
/// Supervised process containment could not be proven healthy and empty.
pub const REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED: i32 = 5;

/// Runtime directories that must remain available after reuse preparation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReusePreparationRequest {
    /// Runtime directory created for the completed run.
    pub current_runtime_dir: String,
    /// Earlier runtime directory still referenced by a retained session identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_runtime_dir: Option<String>,
}

/// User-available capacity on the guest root filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFilesystemCapacity {
    /// Bytes available to an unprivileged guest process.
    pub available_bytes: u64,
    /// Inodes available to an unprivileged guest process.
    pub available_inodes: u64,
}

/// Result emitted after stale runner-owned runtime state is reclaimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReusePreparationReport {
    /// Rootfs capacity observed before cleanup.
    pub before: RootFilesystemCapacity,
    /// Rootfs capacity observed after cleanup.
    pub after: RootFilesystemCapacity,
    /// Number of unprotected entries removed directly below the runtime parent.
    pub removed_entries: u64,
    /// Proof that completed supervised work cannot survive into idle reuse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_containment: Option<ProcessContainmentEvidence>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_containment::ProcessContainmentEvidence;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyReusePreparationReport {
        before: RootFilesystemCapacity,
        after: RootFilesystemCapacity,
        removed_entries: u64,
    }

    fn report(process_containment: Option<ProcessContainmentEvidence>) -> ReusePreparationReport {
        ReusePreparationReport {
            before: RootFilesystemCapacity {
                available_bytes: 10,
                available_inodes: 20,
            },
            after: RootFilesystemCapacity {
                available_bytes: 30,
                available_inodes: 40,
            },
            removed_entries: 2,
            process_containment,
        }
    }

    #[test]
    fn old_report_decodes_without_containment_evidence() {
        let decoded: ReusePreparationReport = serde_json::from_value(serde_json::json!({
            "before": { "availableBytes": 10, "availableInodes": 20 },
            "after": { "availableBytes": 30, "availableInodes": 40 },
            "removedEntries": 2
        }))
        .unwrap();

        assert_eq!(decoded, report(None));
    }

    #[test]
    fn legacy_reader_ignores_new_containment_evidence() {
        let encoded =
            serde_json::to_value(report(Some(ProcessContainmentEvidence::CgroupV2))).unwrap();
        let decoded: LegacyReusePreparationReport = serde_json::from_value(encoded).unwrap();

        assert_eq!(decoded.before.available_bytes, 10);
        assert_eq!(decoded.after.available_inodes, 40);
        assert_eq!(decoded.removed_entries, 2);
    }

    #[test]
    fn containment_evidence_has_stable_json_spelling() {
        let encoded =
            serde_json::to_value(report(Some(ProcessContainmentEvidence::CgroupV2))).unwrap();

        assert_eq!(encoded["processContainment"], "cgroupV2");
    }
}
