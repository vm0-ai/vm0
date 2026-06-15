//! Device pool for host-global NBD device claims.
//!
//! Allocation is demand-only: each acquire scans for a free `/dev/nbdN`,
//! acquires the per-index host `flock`, and re-checks sysfs before returning a
//! lease. Released devices keep their lock through a short cooldown period so
//! kernel teardown cannot race a different runner process.

mod actor;
mod lease;
mod scan;
mod state;

#[cfg(test)]
mod tests;

pub use actor::DevicePoolHandle;
pub use lease::DeviceLease;
pub use state::{DevicePool, DevicePoolConfig};

/// Maximum blocking NBD scans running concurrently.
const MAX_PENDING: usize = 4;

/// Default cooldown period (milliseconds) after disconnecting a device.
const DEFAULT_COOLDOWN_MS: u64 = 500;

type DeviceFreeCheck = fn(u32) -> bool;
