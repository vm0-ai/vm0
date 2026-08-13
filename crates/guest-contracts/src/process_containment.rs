//! Shared guest process-containment and resource-policy contract.
//!
//! Each exec operation owns an empty parent cgroup with `control` and
//! `workload` leaves. A process-control-enabled Guest Agent runs in `control`;
//! every agent CLI and ordinary exec runs in `workload`. The parent remains
//! empty so it can distribute cgroup v2 controllers and act as the recursive
//! cleanup boundary.

/// Canonical cgroup v2 mount inside the guest.
pub const CGROUP_V2_MOUNT_PATH: &str = "/sys/fs/cgroup";

/// Cgroup containing all active exec-operation child cgroups.
pub const EXEC_CGROUP_BASE_PATH: &str = "/sys/fs/cgroup/vm0-exec";

/// Prefix for each per-operation cgroup directly below the exec cgroup base.
pub const EXEC_CGROUP_NAME_PREFIX: &str = "exec-";

/// Leaf reserved for the trusted Guest Agent control process.
pub const CONTROL_CGROUP_NAME: &str = "control";

/// Leaf containing agent CLIs, tools, and ordinary exec processes.
pub const WORKLOAD_CGROUP_NAME: &str = "workload";

/// Cgroup v2 controllers required for workload resource isolation.
pub const REQUIRED_CGROUP_CONTROLLERS: [&str; 3] = ["cpu", "memory", "pids"];

/// Value written to `cgroup.subtree_control` to enable required controllers.
pub const REQUIRED_CGROUP_SUBTREE_CONTROL: &str = "+cpu +memory +pids";

/// Runner-owned bootstrap variable containing the nonce-authenticated local
/// endpoint that transfers a workload `cgroup.procs` descriptor.
///
/// The root guest supervisor keeps the write-only descriptor out of the user
/// launch chain and sends it with `SCM_RIGHTS` only after Guest Agent connects
/// from the matching operation `control` cgroup. Guest Agent consumes this
/// variable and uses cloned descriptors only from CLI-child `pre_exec` hooks.
pub const WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV: &str = "VM0_WORKLOAD_CGROUP_PROCS_ENDPOINT";

/// Smallest Runner profile vCPU count validated for workload containment.
pub const MIN_PROFILE_VCPU: u32 = 1;

/// Smallest configured Runner profile memory size validated for workload
/// containment. Guest startup independently derives its policy from the
/// smaller capacity actually visible inside the VM.
pub const MIN_PROFILE_MEMORY_MB: u32 = 1024;

/// CPU bandwidth period used for workload cgroups.
pub const WORKLOAD_CPU_PERIOD_US: u64 = 100_000;

/// CPU time per period reserved outside each workload leaf for control work.
pub const CONTROL_CPU_RESERVE_US: u64 = 10_000;

/// Minimum accumulated CPU throttling reported as material pressure.
pub const MATERIAL_CPU_THROTTLED_USEC: u64 = 1_000_000;

/// Memory kept outside the workload hard limit for Guest control services.
///
/// Cgroup v2 limits effective `memory.min` protection by every ancestor. The
/// exec base, controlled operation, and control leaf must therefore all use
/// this value so concurrent operation siblings cannot reclaim the reservation.
pub const CONTROL_MEMORY_RESERVE_BYTES: u64 = 384 * 1024 * 1024;

/// Additional distance between workload `memory.high` and `memory.max`.
pub const WORKLOAD_MEMORY_HIGH_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;

/// Value written to workload `pids.max` while no production ceiling is calibrated.
///
/// The PID controller remains enabled for accounting and operation-local
/// enforcement tests, but normal workloads are not capped by an arbitrary
/// task count.
pub const WORKLOAD_PIDS_MAX: &str = "max";

/// Highest cgroup v2 CPU weight, assigned to a controlled operation and its
/// Guest Agent leaf so concurrent ordinary execs cannot dominate it.
pub const CONTROL_CPU_WEIGHT: u64 = 10_000;

/// Calibrated cgroup v2 resource policy for one workload leaf.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkloadResourcePolicy {
    /// Workload CPU quota in microseconds per [`Self::cpu_period_us`].
    pub cpu_quota_us: u64,
    /// Workload CPU bandwidth period in microseconds.
    pub cpu_period_us: u64,
    /// Workload memory throttling threshold in bytes.
    pub memory_high_bytes: u64,
    /// Workload hard memory limit in bytes.
    pub memory_max_bytes: u64,
    /// Protected Guest Agent memory in bytes.
    pub control_memory_min_bytes: u64,
    /// Value written to the workload `pids.max` cgroup file.
    pub pids_max: &'static str,
}

impl WorkloadResourcePolicy {
    /// Derive the policy from capacity visible to the current Guest.
    pub fn for_current_guest_capacity() -> Result<Self, &'static str> {
        // SAFETY: these sysconf selectors return scalar capacity values.
        let vcpu = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
        // SAFETY: these sysconf selectors return scalar capacity values.
        let physical_pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
        // SAFETY: these sysconf selectors return scalar capacity values.
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if vcpu <= 0 || physical_pages <= 0 || page_size <= 0 {
            return Err("guest capacity query returned a non-positive value");
        }
        let vcpu = u32::try_from(vcpu).map_err(|_| "guest vCPU count is out of range")?;
        let memory_bytes = u64::try_from(physical_pages)
            .ok()
            .and_then(|pages| {
                u64::try_from(page_size)
                    .ok()
                    .and_then(|size| pages.checked_mul(size))
            })
            .ok_or("guest physical memory size is out of range")?;
        Self::for_guest_capacity(vcpu, memory_bytes)
    }

    /// Derive the fixed platform policy from Guest-visible capacity.
    ///
    /// `vcpu` is the number of online processors and `memory_bytes` is physical
    /// memory visible to the Guest. The calculation fails when the Guest cannot
    /// preserve the fixed control reserve and workload high-limit headroom.
    pub fn for_guest_capacity(vcpu: u32, memory_bytes: u64) -> Result<Self, &'static str> {
        let total_cpu_us = u64::from(vcpu)
            .checked_mul(WORKLOAD_CPU_PERIOD_US)
            .ok_or("guest vCPU capacity overflows workload policy")?;
        let cpu_quota_us = total_cpu_us
            .checked_sub(CONTROL_CPU_RESERVE_US)
            .filter(|quota| *quota > 0)
            .ok_or("guest CPU capacity cannot preserve control headroom")?;

        let memory_max_bytes = memory_bytes
            .checked_sub(CONTROL_MEMORY_RESERVE_BYTES)
            .filter(|limit| *limit > 0)
            .ok_or("guest memory capacity cannot preserve control headroom")?;
        let memory_high_bytes = memory_max_bytes
            .checked_sub(WORKLOAD_MEMORY_HIGH_HEADROOM_BYTES)
            .filter(|limit| *limit > 0)
            .ok_or("guest memory capacity cannot provide a workload high threshold")?;

        Ok(Self {
            cpu_quota_us,
            cpu_period_us: WORKLOAD_CPU_PERIOD_US,
            memory_high_bytes,
            memory_max_bytes,
            control_memory_min_bytes: CONTROL_MEMORY_RESERVE_BYTES,
            pids_max: WORKLOAD_PIDS_MAX,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_default_profile_policy() {
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, u64::from(4096_u32) * 1024 * 1024)
                .unwrap();

        assert_eq!(policy.cpu_quota_us, 190_000);
        assert_eq!(policy.cpu_period_us, 100_000);
        assert_eq!(policy.memory_max_bytes, 3712 * 1024 * 1024);
        assert_eq!(policy.memory_high_bytes, 3456 * 1024 * 1024);
        assert_eq!(policy.control_memory_min_bytes, 384 * 1024 * 1024);
        assert_eq!(policy.pids_max, "max");
    }

    #[test]
    fn rejects_capacity_without_control_memory_headroom() {
        let error = WorkloadResourcePolicy::for_guest_capacity(1, CONTROL_MEMORY_RESERVE_BYTES)
            .unwrap_err();

        assert_eq!(
            error,
            "guest memory capacity cannot preserve control headroom"
        );
    }

    #[test]
    fn derives_small_profile_policy_from_fixed_reserves() {
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(1, u64::from(1024_u32) * 1024 * 1024)
                .unwrap();

        assert_eq!(policy.cpu_quota_us, 90_000);
        assert_eq!(policy.memory_max_bytes, 640 * 1024 * 1024);
        assert_eq!(policy.memory_high_bytes, 384 * 1024 * 1024);
    }

    #[test]
    fn derives_policy_from_calibrated_minimum_guest_capacity() {
        // A 1-vCPU/1024-MiB Firecracker Guest exposes this physical capacity
        // after kernel reservations on the production-equivalent test host.
        let policy = WorkloadResourcePolicy::for_guest_capacity(1, 1_033_928_704).unwrap();

        assert_eq!(policy.cpu_quota_us, 90_000);
        assert_eq!(policy.memory_max_bytes, 631_275_520);
        assert_eq!(policy.memory_high_bytes, 362_840_064);
    }
}
