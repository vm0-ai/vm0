use std::path::PathBuf;

use crate::command;
use crate::error::Result;

/// Path prefix for device mapper targets.
const DM_DEV_PREFIX: &str = "/dev/mapper/";

/// Create a dm-snapshot target on top of an origin device.
///
/// `chunk_size` is in 512-byte sectors (e.g. 8 = 4KB chunks).
/// Returns the path to the created snapshot device.
///
/// The device is created with default ownership (root:disk 0660).
/// Callers must `chown` after creation if non-root access is needed.
pub fn create_snapshot(
    name: &str,
    origin: &str,
    cow_device: &str,
    sectors: u64,
    chunk_size: u32,
) -> Result<PathBuf> {
    let table = format!("0 {sectors} snapshot {origin} {cow_device} P {chunk_size}");
    command::sudo("dmsetup", &["create", name, "--table", &table])?;
    Ok(PathBuf::from(format!("{DM_DEV_PREFIX}{name}")))
}

/// Query dm-snapshot status. Returns the raw status string.
///
/// Format: `<used_sectors>/<total_sectors> <metadata_sectors>`
/// Useful for debugging COW usage after sandbox execution.
pub fn status(name: &str) -> Result<String> {
    command::sudo("dmsetup", &["status", name])
}

/// Remove a device mapper target.
pub fn remove(name: &str) -> Result<()> {
    command::sudo("dmsetup", &["remove", name])?;
    Ok(())
}
