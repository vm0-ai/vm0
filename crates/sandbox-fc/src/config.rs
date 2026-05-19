//! Configuration types for the Firecracker sandbox backend.

use std::num::NonZeroU64;
use std::path::PathBuf;

pub(crate) const RATE_LIMITER_REFILL_TIME_MS: u64 = 100;
const MILLIS_PER_SECOND: u64 = 1000;
const RATE_LIMITER_REFILLS_PER_SECOND: u64 = MILLIS_PER_SECOND / RATE_LIMITER_REFILL_TIME_MS;

/// Configuration used to create Firecracker sandbox factories.
#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    /// Path to the Firecracker executable.
    pub binary_path: PathBuf,
    /// Path to the kernel image used to boot the microVM.
    pub kernel_path: PathBuf,
    /// Path to the rootfs image used as the microVM drive.
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, COW devices, etc.).
    pub base_dir: PathBuf,
    /// Profile name (e.g., "vm0/default") used for per-profile isolation.
    pub profile: String,
    /// Port of the HTTP/HTTPS proxy. When set, iptables rules redirect traffic through it.
    pub proxy_port: Option<u16>,
    /// Port of the DNS proxy. When set, iptables rules redirect DNS queries through it.
    pub dns_port: Option<u16>,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore instead of fresh boot.
    pub snapshot: Option<SnapshotConfig>,
}

/// Snapshot restore artifacts and bind-path metadata for Firecracker.
#[derive(Debug, Clone)]
pub struct SnapshotConfig {
    /// Path to the snapshot state file.
    pub snapshot_path: PathBuf,
    /// Path to the memory dump file.
    pub memory_path: PathBuf,
    /// Path to the golden COW file shipped with the snapshot.
    pub cow_path: PathBuf,
    /// Drive path recorded in the snapshot's Firecracker config (bind mount target).
    pub drive_bind_path: PathBuf,
    /// Vsock directory recorded in the snapshot's Firecracker config (bind mount target).
    pub vsock_bind_dir: PathBuf,
}

/// Firecracker token bucket configuration.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct TokenBucketConfig {
    pub size: u64,
    pub refill_time: u64,
}

/// Firecracker rate limiter configuration.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct RateLimiterConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth: Option<TokenBucketConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<TokenBucketConfig>,
}

/// Firecracker device rate limiters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirecrackerDeviceRateLimits {
    pub drive: RateLimiterConfig,
    pub net_rx: RateLimiterConfig,
    pub net_tx: RateLimiterConfig,
}

impl TryFrom<&sandbox::DeviceRateLimits> for FirecrackerDeviceRateLimits {
    type Error = String;

    fn try_from(limits: &sandbox::DeviceRateLimits) -> Result<Self, Self::Error> {
        Ok(Self {
            drive: RateLimiterConfig {
                bandwidth: Some(positive_token_bucket(
                    "block bandwidth_bytes_per_sec",
                    limits.block.bandwidth_bytes_per_sec,
                )?),
                ops: Some(positive_token_bucket(
                    "block ops_per_sec",
                    limits.block.ops_per_sec,
                )?),
            },
            net_rx: RateLimiterConfig {
                bandwidth: Some(positive_token_bucket(
                    "network rx_bytes_per_sec",
                    limits.network.rx_bytes_per_sec,
                )?),
                ops: None,
            },
            net_tx: RateLimiterConfig {
                bandwidth: Some(positive_token_bucket(
                    "network tx_bytes_per_sec",
                    limits.network.tx_bytes_per_sec,
                )?),
                ops: None,
            },
        })
    }
}

fn positive_token_bucket(
    name: &'static str,
    rate_per_sec: u64,
) -> Result<TokenBucketConfig, String> {
    let rate_per_sec =
        NonZeroU64::new(rate_per_sec).ok_or_else(|| format!("{name} must be positive"))?;
    Ok(token_bucket(rate_per_sec))
}

fn token_bucket(rate_per_sec: NonZeroU64) -> TokenBucketConfig {
    let rate_per_sec = rate_per_sec.get();
    let size = rate_per_sec / RATE_LIMITER_REFILLS_PER_SECOND;
    if size > 0 {
        return TokenBucketConfig {
            size,
            refill_time: RATE_LIMITER_REFILL_TIME_MS,
        };
    }

    TokenBucketConfig {
        size: 1,
        refill_time: MILLIS_PER_SECOND.div_ceil(rate_per_sec),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonzero(value: u64) -> NonZeroU64 {
        NonZeroU64::new(value).expect("test rate must be non-zero")
    }

    #[test]
    fn token_bucket_uses_100ms_refill_window() {
        let bucket = token_bucket(nonzero(100 * 1024 * 1024));

        assert_eq!(bucket.size, 10 * 1024 * 1024);
        assert_eq!(bucket.refill_time, RATE_LIMITER_REFILL_TIME_MS);
    }

    #[test]
    fn token_bucket_uses_longer_refill_window_for_low_rates() {
        let bucket = token_bucket(nonzero(3));

        assert_eq!(bucket.size, 1);
        assert_eq!(bucket.refill_time, 334);
    }

    #[test]
    fn device_limits_convert_to_firecracker_limiters() {
        let limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 100 * 1024 * 1024,
                ops_per_sec: 10_000,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 50 * 1024 * 1024,
                tx_bytes_per_sec: 25 * 1024 * 1024,
            },
        };

        let fc = FirecrackerDeviceRateLimits::try_from(&limits).unwrap();

        assert_eq!(fc.drive.bandwidth.unwrap().size, 10 * 1024 * 1024);
        assert_eq!(fc.drive.ops.unwrap().size, 1_000);
        assert_eq!(fc.net_rx.bandwidth.unwrap().size, 5 * 1024 * 1024);
        assert_eq!(fc.net_tx.bandwidth.unwrap().size, 2_621_440);
        assert_eq!(fc.net_rx.ops, None);
        assert_eq!(fc.net_tx.ops, None);
    }

    #[test]
    fn device_limits_reject_zero_rates() {
        let limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 0,
                ops_per_sec: 10_000,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 50 * 1024 * 1024,
                tx_bytes_per_sec: 25 * 1024 * 1024,
            },
        };

        let err = FirecrackerDeviceRateLimits::try_from(&limits).unwrap_err();

        assert!(err.contains("block bandwidth_bytes_per_sec"));
        assert!(err.contains("positive"));
    }
}
