//! Shared guest process-containment paths.

/// Canonical cgroup v2 mount inside the guest.
pub const CGROUP_V2_MOUNT_PATH: &str = "/sys/fs/cgroup";

/// Cgroup containing all active supervised-operation child cgroups.
pub const SUPERVISED_CGROUP_BASE_PATH: &str = "/sys/fs/cgroup/vm0-supervised";
