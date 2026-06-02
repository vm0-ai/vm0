//! Runner-owned I/O limiter policy.
//!
//! Host-local capacity is optional and belongs at the runner boundary. This
//! module converts that capacity into provider-neutral per-sandbox limits.

use std::collections::{BTreeMap, HashMap};

use sandbox::{BlockRateLimits, DeviceRateLimits, NetworkRateLimits};

use crate::config::ProfileConfig;
use crate::host_env::{self, HostEnvValue, RunnerHostEnv, RunnerIoEnvValues};
use crate::resource_budget::ResourceBudget;
use crate::types::ExecutionContext;

const MIB: f64 = 1024.0 * 1024.0;
pub(crate) const SANDBOX_IO_LIMITERS_FEATURE_FLAG: &str = "sandboxIoLimiters";
// Keep host-level headroom outside Firecracker token buckets for system daemons,
// filesystem metadata bursts, and other non-sandbox traffic.
const IO_CAPACITY_PERCENT: u128 = 100;
const IO_RESERVE_PERCENT: u128 = 20;
const MAX_DENOMINATOR_DP_CELLS: usize = 1_000_000;
const MAX_DENOMINATOR_DP_STEPS: usize = 5_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IoLimitResolution {
    Disabled,
    Misconfigured {
        reason: String,
    },
    Configured {
        limits: DeviceRateLimits,
        denominator: u64,
    },
}

impl IoLimitResolution {
    pub(crate) fn device_rate_limits(&self) -> Option<DeviceRateLimits> {
        match self {
            Self::Configured { limits, .. } => Some(limits.clone()),
            Self::Disabled | Self::Misconfigured { .. } => None,
        }
    }
}

pub(crate) fn device_rate_limits_for_context(
    configured_limits: Option<&DeviceRateLimits>,
    context: &ExecutionContext,
) -> Option<DeviceRateLimits> {
    if !io_limit_feature_enabled(context.feature_flags.as_ref()) {
        return None;
    }

    configured_limits.cloned()
}

fn io_limit_feature_enabled(feature_flags: Option<&HashMap<String, bool>>) -> bool {
    feature_flags
        .and_then(|flags| flags.get(SANDBOX_IO_LIMITERS_FEATURE_FLAG))
        .copied()
        .unwrap_or(false)
}

pub(crate) fn resolve_io_limits(
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
    host_env: &RunnerHostEnv,
) -> IoLimitResolution {
    let values = host_env.io_values();
    resolve_io_limits_from_values(&values, profiles, budget)
}

fn resolve_io_limits_from_values(
    values: &RunnerIoEnvValues,
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
) -> IoLimitResolution {
    let entries = [
        (
            host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
            values.disk_bandwidth_mib_per_sec.as_ref(),
        ),
        (host_env::RUNNER_DISK_IOPS_ENV, values.disk_iops.as_ref()),
        (
            host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV,
            values.net_rx_mib_per_sec.as_ref(),
        ),
        (
            host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV,
            values.net_tx_mib_per_sec.as_ref(),
        ),
    ];

    let present = entries.iter().filter(|(_, value)| value.is_some()).count();
    if present == 0 {
        return IoLimitResolution::Disabled;
    }
    if present != entries.len() {
        let missing = entries
            .iter()
            .filter_map(|(key, value)| value.is_none().then_some(*key))
            .collect::<Vec<_>>()
            .join(", ");
        return IoLimitResolution::Misconfigured {
            reason: format!("incomplete I/O limiter host env config; missing: {missing}"),
        };
    }

    let Some(disk_bandwidth_bytes_per_sec) =
        parse_mib_per_sec(values.disk_bandwidth_mib_per_sec.as_ref())
    else {
        return invalid_value_resolution(host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV);
    };
    let Some(disk_ops_per_sec) = parse_positive_u64(values.disk_iops.as_ref()) else {
        return IoLimitResolution::Misconfigured {
            reason: format!(
                "{} must be a positive integer",
                host_env::RUNNER_DISK_IOPS_ENV
            ),
        };
    };
    let Some(net_rx_bytes_per_sec) = parse_mib_per_sec(values.net_rx_mib_per_sec.as_ref()) else {
        return invalid_value_resolution(host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV);
    };
    let Some(net_tx_bytes_per_sec) = parse_mib_per_sec(values.net_tx_mib_per_sec.as_ref()) else {
        return invalid_value_resolution(host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV);
    };

    let denominator = admitted_sandbox_denominator(profiles, budget);
    let Some(block_bandwidth_bytes_per_sec) =
        per_sandbox_capacity(disk_bandwidth_bytes_per_sec, denominator)
    else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
            denominator,
        );
    };
    let Some(block_ops_per_sec) = per_sandbox_capacity(disk_ops_per_sec, denominator) else {
        return insufficient_capacity_resolution(host_env::RUNNER_DISK_IOPS_ENV, denominator);
    };
    let Some(net_rx_bytes_per_sec) = per_sandbox_capacity(net_rx_bytes_per_sec, denominator) else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV,
            denominator,
        );
    };
    let Some(net_tx_bytes_per_sec) = per_sandbox_capacity(net_tx_bytes_per_sec, denominator) else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV,
            denominator,
        );
    };

    IoLimitResolution::Configured {
        denominator,
        limits: DeviceRateLimits {
            block: BlockRateLimits {
                bandwidth_bytes_per_sec: block_bandwidth_bytes_per_sec,
                ops_per_sec: block_ops_per_sec,
            },
            network: NetworkRateLimits {
                rx_bytes_per_sec: net_rx_bytes_per_sec,
                tx_bytes_per_sec: net_tx_bytes_per_sec,
            },
        },
    }
}

fn invalid_value_resolution(key: &'static str) -> IoLimitResolution {
    IoLimitResolution::Misconfigured {
        reason: format!("{key} must be a positive finite number"),
    }
}

fn insufficient_capacity_resolution(key: &'static str, denominator: u64) -> IoLimitResolution {
    IoLimitResolution::Misconfigured {
        reason: format!(
            "{key} is too small to allocate at least 1 unit per admitted sandbox after reserve (denominator: {denominator})"
        ),
    }
}

fn parse_mib_per_sec(value: Option<&HostEnvValue>) -> Option<u64> {
    parse_positive_f64(value).and_then(|mib_per_sec| {
        let bytes_per_sec = mib_per_sec * MIB;
        if !bytes_per_sec.is_finite() || bytes_per_sec < 1.0 || bytes_per_sec > u64::MAX as f64 {
            return None;
        }
        let bytes_per_sec = bytes_per_sec.floor() as u64;
        if bytes_per_sec > 0 {
            Some(bytes_per_sec)
        } else {
            None
        }
    })
}

fn parse_positive_u64(value: Option<&HostEnvValue>) -> Option<u64> {
    let value = value?;
    let parsed = value.value.parse::<u64>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn parse_positive_f64(value: Option<&HostEnvValue>) -> Option<f64> {
    let value = value?;
    let parsed = value.value.parse::<f64>().ok()?;
    if !parsed.is_finite() || parsed <= 0.0 || parsed > u64::MAX as f64 {
        return None;
    }
    Some(parsed)
}

fn admitted_sandbox_denominator(
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
) -> u64 {
    let mut profile_shapes = profiles
        .values()
        .map(|profile| {
            (
                profile.vcpu.max(1) as usize,
                profile.memory_mb.max(1) as u64,
            )
        })
        .collect::<Vec<_>>();
    profile_shapes.sort_unstable();
    profile_shapes.dedup();
    let Some(min_vcpu) = profile_shapes.iter().map(|(vcpu, _)| *vcpu).min() else {
        return 1;
    };
    let Some(min_memory_mb) = profile_shapes.iter().map(|(_, memory_mb)| *memory_mb).min() else {
        return 1;
    };

    let cpu_capacity = budget.effective_vcpu().max(1) as usize;
    let memory_capacity = budget.effective_memory_mb().max(1) as u64;
    let cpu_upper_bound = cpu_capacity / min_vcpu;
    let memory_upper_bound = (memory_capacity / min_memory_mb) as usize;
    let mut count_upper_bound = cpu_upper_bound.min(memory_upper_bound);
    if budget.max_concurrent() > 0 {
        count_upper_bound = count_upper_bound.min(budget.max_concurrent());
    }
    let count_upper_bound = count_upper_bound.max(1);

    let width = cpu_capacity + 1;
    let Some(cells) = (count_upper_bound + 1).checked_mul(width) else {
        return count_upper_bound as u64;
    };
    if cells > MAX_DENOMINATOR_DP_CELLS {
        return count_upper_bound as u64;
    }
    if cells
        .checked_mul(profile_shapes.len().max(1))
        .is_none_or(|steps| steps > MAX_DENOMINATOR_DP_STEPS)
    {
        return count_upper_bound as u64;
    }

    // Exact admission count for heterogeneous profiles. The table stores the
    // minimum memory needed to run `count` sandboxes using exactly `cpu` vCPUs.
    let mut min_memory_by_count_and_cpu = vec![u64::MAX; cells];
    if let Some(origin) = min_memory_by_count_and_cpu.get_mut(0) {
        *origin = 0;
    }
    let mut best = 0usize;
    for count in 1..=count_upper_bound {
        for cpu in 1..=cpu_capacity {
            let mut min_memory = u64::MAX;
            for (profile_vcpu, profile_memory_mb) in &profile_shapes {
                if *profile_vcpu > cpu {
                    continue;
                }
                let Some(previous_index) =
                    denominator_table_index(count - 1, cpu - *profile_vcpu, width)
                else {
                    continue;
                };
                let Some(previous) = min_memory_by_count_and_cpu.get(previous_index).copied()
                else {
                    continue;
                };
                let Some(candidate) = previous.checked_add(*profile_memory_mb) else {
                    continue;
                };
                if candidate <= memory_capacity {
                    min_memory = min_memory.min(candidate);
                }
            }
            if let Some(index) = denominator_table_index(count, cpu, width)
                && let Some(cell) = min_memory_by_count_and_cpu.get_mut(index)
            {
                *cell = min_memory;
            }
            if min_memory <= memory_capacity {
                best = best.max(count);
            }
        }
    }

    best.max(1) as u64
}

fn denominator_table_index(count: usize, cpu: usize, width: usize) -> Option<usize> {
    count.checked_mul(width)?.checked_add(cpu)
}

fn per_sandbox_capacity(host_capacity: u64, denominator: u64) -> Option<u64> {
    let usable = ((host_capacity as u128) * (IO_CAPACITY_PERCENT - IO_RESERVE_PERCENT))
        / IO_CAPACITY_PERCENT;
    let usable = u64::try_from(usable).ok()?;
    let capacity = usable / denominator.max(1);
    (capacity > 0).then_some(capacity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(raw: &str) -> HostEnvValue {
        HostEnvValue {
            value: raw.to_string(),
        }
    }

    fn profiles(items: &[(&str, u32, u32)]) -> BTreeMap<String, ProfileConfig> {
        items
            .iter()
            .map(|(name, vcpu, memory_mb)| {
                (
                    (*name).to_string(),
                    ProfileConfig {
                        rootfs_hash: format!("{name}-rootfs"),
                        snapshot_hash: format!("{name}-snapshot"),
                        vcpu: *vcpu,
                        memory_mb: *memory_mb,
                        rootfs_disk_mb: 8192,
                        workspace_disk_mb: 16_384,
                    },
                )
            })
            .collect()
    }

    fn full_values() -> RunnerIoEnvValues {
        RunnerIoEnvValues {
            disk_bandwidth_mib_per_sec: Some(value("2000")),
            disk_iops: Some(value("200000")),
            net_rx_mib_per_sec: Some(value("1250")),
            net_tx_mib_per_sec: Some(value("1000")),
        }
    }

    #[test]
    fn io_limit_feature_enabled_requires_explicit_true_flag() {
        let enabled = HashMap::from([(SANDBOX_IO_LIMITERS_FEATURE_FLAG.to_string(), true)]);
        let disabled = HashMap::from([(SANDBOX_IO_LIMITERS_FEATURE_FLAG.to_string(), false)]);
        let unrelated = HashMap::from([("otherFlag".to_string(), true)]);

        assert!(io_limit_feature_enabled(Some(&enabled)));
        assert!(!io_limit_feature_enabled(Some(&disabled)));
        assert!(!io_limit_feature_enabled(Some(&unrelated)));
        assert!(!io_limit_feature_enabled(None));
    }

    #[test]
    fn absent_env_disables_limits() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(8, 16_384, 1.0, 4);

        let resolution =
            resolve_io_limits_from_values(&RunnerIoEnvValues::default(), &profiles, &budget);

        assert_eq!(resolution, IoLimitResolution::Disabled);
        assert_eq!(resolution.device_rate_limits(), None);
    }

    #[test]
    fn partial_env_disables_limits_as_misconfigured() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
        let values = RunnerIoEnvValues {
            disk_bandwidth_mib_per_sec: Some(value("2000")),
            ..RunnerIoEnvValues::default()
        };

        let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

        let IoLimitResolution::Misconfigured { reason } = resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains("missing"));
        assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
        assert!(reason.contains(host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV));
        assert!(reason.contains(host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV));
    }

    #[test]
    fn invalid_env_disables_limits_as_misconfigured() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
        let mut values = full_values();
        values.disk_iops = Some(value("NaN"));

        let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

        let IoLimitResolution::Misconfigured { reason } = resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
    }

    #[test]
    fn fractional_iops_disables_limits_as_misconfigured() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
        let mut values = full_values();
        values.disk_iops = Some(value("100.5"));

        let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

        let IoLimitResolution::Misconfigured { reason } = resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
        assert!(reason.contains("positive integer"));
    }

    #[test]
    fn sub_byte_bandwidth_disables_limits_as_misconfigured() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
        let mut values = full_values();
        values.net_rx_mib_per_sec = Some(value("0.0000001"));

        let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

        let IoLimitResolution::Misconfigured { reason } = resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains(host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV));
        assert!(reason.contains("positive finite number"));
    }

    #[test]
    fn capacity_too_small_for_denominator_disables_limits_as_misconfigured() {
        let profiles = profiles(&[("vm0/default", 1, 1024)]);
        let budget = ResourceBudget::new(64, 65_536, 1.0, 64);
        let mut values = full_values();
        values.disk_iops = Some(value("1"));

        let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

        let IoLimitResolution::Misconfigured { reason } = resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
        assert!(reason.contains("too small"));
        assert!(reason.contains("denominator: 64"));
    }

    #[test]
    fn complete_env_computes_reserved_per_sandbox_limits() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(8, 16_384, 1.0, 4);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured {
            limits,
            denominator,
        } = resolution
        else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 4);
        assert_eq!(limits.block.bandwidth_bytes_per_sec, 400 * 1024 * 1024);
        assert_eq!(limits.block.ops_per_sec, 40_000);
        assert_eq!(limits.network.rx_bytes_per_sec, 250 * 1024 * 1024);
        assert_eq!(limits.network.tx_bytes_per_sec, 200 * 1024 * 1024);
    }

    #[test]
    fn denominator_falls_back_to_resource_slots_without_max_concurrent() {
        let profiles = profiles(&[("vm0/default", 2, 4096)]);
        let budget = ResourceBudget::new(12, 32_768, 1.0, 0);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured { denominator, .. } = resolution else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 6);
    }

    #[test]
    fn denominator_uses_smallest_profile_shape_for_heterogeneous_profiles() {
        let profiles = profiles(&[("vm0/default", 2, 4096), ("vm0/large", 8, 16_384)]);
        let budget = ResourceBudget::new(16, 32_768, 1.0, 0);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured { denominator, .. } = resolution else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 8);
    }

    #[test]
    fn denominator_does_not_combine_minimum_resources_from_different_profiles() {
        let profiles = profiles(&[("vm0/cpu-heavy", 5, 1024), ("vm0/mem-heavy", 1, 5120)]);
        let budget = ResourceBudget::new(8, 8192, 1.0, 0);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured { denominator, .. } = resolution else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 2);
    }

    #[test]
    fn denominator_uses_safe_upper_bound_when_exact_calculation_would_be_too_large() {
        let profiles = profiles(&[("vm0/default", 1, 1)]);
        let budget = ResourceBudget::new(10_000, 10_000, 1.0, 0);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured { denominator, .. } = resolution else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 10_000);
    }

    #[test]
    fn denominator_uses_safe_upper_bound_when_exact_calculation_has_too_many_profile_steps() {
        let mut profile_items = Vec::new();
        for index in 0..100 {
            profile_items.push((format!("vm0/profile-{index}"), 1, index + 1));
        }
        let profile_refs = profile_items
            .iter()
            .map(|(name, vcpu, memory_mb)| (name.as_str(), *vcpu, *memory_mb))
            .collect::<Vec<_>>();
        let profiles = profiles(&profile_refs);
        let budget = ResourceBudget::new(500, 500, 1.0, 0);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured { denominator, .. } = resolution else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 500);
    }

    #[test]
    fn denominator_clamps_to_one() {
        let profiles = profiles(&[("vm0/default", 8, 16_384)]);
        let budget = ResourceBudget::new(1, 1024, 1.0, 0);

        let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

        let IoLimitResolution::Configured { denominator, .. } = resolution else {
            panic!("expected configured resolution");
        };
        assert_eq!(denominator, 1);
    }
}
