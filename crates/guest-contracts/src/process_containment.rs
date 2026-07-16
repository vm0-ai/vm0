//! Shared guest process-containment paths and evidence.

use serde::{Deserialize, Serialize};

/// Canonical cgroup v2 mount inside the guest.
pub const CGROUP_V2_MOUNT_PATH: &str = "/sys/fs/cgroup";

/// Cgroup containing all active supervised-operation child cgroups.
pub const SUPERVISED_CGROUP_BASE_PATH: &str = "/sys/fs/cgroup/vm0-supervised";

/// Proof emitted only after the supervised cgroup hierarchy is verified empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessContainmentEvidence {
    /// Cgroup v2 is available and the supervised subtree is empty.
    CgroupV2,
}
