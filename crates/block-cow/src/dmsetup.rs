use std::path::PathBuf;

use crate::command;
use crate::error::Result;

/// Path prefix for device mapper targets.
const DM_DEV_PREFIX: &str = "/dev/mapper/";

/// Create a dm-linear target that maps an entire block device.
///
/// Returns the path to the created device (e.g. `/dev/mapper/{name}`).
pub fn create_linear(name: &str, origin_device: &str, sectors: u64) -> Result<PathBuf> {
    let table = format!("0 {sectors} linear {origin_device} 0");
    command::run("dmsetup", &["create", name, "--table", &table])?;
    Ok(PathBuf::from(format!("{DM_DEV_PREFIX}{name}")))
}

/// Create a dm-snapshot target on top of an origin device.
///
/// `chunk_size` is in 512-byte sectors (e.g. 8 = 4KB chunks).
/// Returns the path to the created snapshot device.
pub fn create_snapshot(
    name: &str,
    origin: &str,
    cow_device: &str,
    sectors: u64,
    chunk_size: u32,
) -> Result<PathBuf> {
    let table = format!("0 {sectors} snapshot {origin} {cow_device} P {chunk_size}");
    command::run("dmsetup", &["create", name, "--table", &table])?;
    Ok(PathBuf::from(format!("{DM_DEV_PREFIX}{name}")))
}

/// Remove a device mapper target.
pub fn remove(name: &str) -> Result<()> {
    command::run("dmsetup", &["remove", name])?;
    Ok(())
}
