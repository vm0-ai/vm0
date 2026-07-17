//! Shared guest process-containment paths.

/// Canonical cgroup v2 mount inside the guest.
pub const CGROUP_V2_MOUNT_PATH: &str = "/sys/fs/cgroup";

/// Cgroup containing all active exec-operation child cgroups.
pub const EXEC_CGROUP_BASE_PATH: &str = "/sys/fs/cgroup/vm0-exec";

/// Prefix for each per-operation cgroup directly below the exec cgroup base.
pub const EXEC_CGROUP_NAME_PREFIX: &str = "exec-";
