//! Device pool for cooperatively claimed NBD devices.
//!
//! A successful acquire can come from either a demand scan or a cooled claim
//! retained from a clean release. A demand scan looks for a free `/dev/nbdN`,
//! acquires the per-index lock-file `flock`, and re-checks sysfs before returning a
//! lease. A clean release keeps the existing claim and lock through a short
//! cooldown period so kernel teardown cannot race another cooperating runner
//! using the same lock directory. When the cooldown expires, a queued waiter
//! can receive that still-locked claim after a sysfs free check, without a new
//! scan or lock acquisition. If no waiter is queued or the free check fails,
//! the expired claim is dropped and its lock is released; remaining waiters
//! continue through the pool's normal progress path.

mod actor;
mod lease;
mod scan;
mod state;

#[cfg(test)]
mod tests;

pub use actor::DevicePoolHandle;
pub use lease::DeviceLease;
pub use state::{DevicePool, DevicePoolConfig};

pub(crate) use lease::DeviceAcquireSource;

/// Maximum blocking workers sharing one active demand scan.
const MAX_PENDING: usize = 4;

/// Default cooldown period (milliseconds) after disconnecting a device.
const DEFAULT_COOLDOWN_MS: u64 = 500;

type DeviceFreeCheck = fn(u32) -> bool;
