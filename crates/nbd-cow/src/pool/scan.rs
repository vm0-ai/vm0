use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::device_lock::{self, NbdDeviceClaim};
use crate::error::{NbdCowError, Result};
use crate::netlink;

use super::DeviceFreeCheck;

pub(super) struct ScanRequest {
    pub(super) max_devices: u32,
    pub(super) exclude: HashSet<u32>,
    pub(super) lock_dir: PathBuf,
    pub(super) device_appears_free: DeviceFreeCheck,
}

impl ScanRequest {
    pub(super) fn run(self) -> Result<NbdDeviceClaim> {
        scan_and_claim_with(
            self.max_devices,
            &self.exclude,
            &self.lock_dir,
            self.device_appears_free,
        )
    }
}

/// Scan sysfs for a single free device and acquire its per-index lock.
///
/// Starts from a random offset to distribute usage across runners. The first
/// sysfs check is a cheap precheck; the post-lock sysfs check is the correctness
/// gate that prevents stale observations from becoming leases.
pub(super) fn scan_and_claim_with<F>(
    max_devices: u32,
    exclude: &HashSet<u32>,
    lock_dir: &Path,
    device_appears_free: F,
) -> Result<NbdDeviceClaim>
where
    F: Fn(u32) -> bool,
{
    if max_devices == 0 {
        return Err(NbdCowError::NoFreeDevice);
    }

    let start = netlink::random_offset(max_devices);

    for n in 0..max_devices {
        let i = (start + n) % max_devices;
        if exclude.contains(&i) {
            continue;
        }
        if !device_appears_free(i) {
            continue;
        }
        match device_lock::try_acquire_device_claim_in(i, lock_dir) {
            Ok(Some(claim)) => {
                if device_appears_free(i) {
                    return Ok(claim);
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(
                    device_index = i,
                    error = %e,
                    "cannot acquire NBD device lock, skipping index"
                );
            }
        }
    }

    Err(NbdCowError::NoFreeDevice)
}
