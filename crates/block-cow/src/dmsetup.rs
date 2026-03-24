use std::path::PathBuf;

use crate::command;
use crate::error::Result;

/// Path prefix for device mapper targets.
const DM_DEV_PREFIX: &str = "/dev/mapper/";

/// Create a dm-snapshot target on top of an origin device.
///
/// `chunk_size` is in 512-byte sectors (e.g. 8 = 4KB chunks).
/// `uid` and `gid` set device ownership atomically at creation time
/// (equivalent to `--uid` / `--gid` flags), avoiding a separate `chown`.
/// Returns the path to the created snapshot device.
pub fn create_snapshot(
    name: &str,
    origin: &str,
    cow_device: &str,
    sectors: u64,
    chunk_size: u32,
    uid: u32,
    gid: u32,
) -> Result<PathBuf> {
    let table = format!("0 {sectors} snapshot {origin} {cow_device} P {chunk_size}");
    let uid_str = uid.to_string();
    let gid_str = gid.to_string();
    command::run(
        "dmsetup",
        &[
            "create", name, "--table", &table, "--uid", &uid_str, "--gid", &gid_str,
        ],
    )?;
    Ok(PathBuf::from(format!("{DM_DEV_PREFIX}{name}")))
}

/// Remove a device mapper target.
pub fn remove(name: &str) -> Result<()> {
    command::run("dmsetup", &["remove", name])?;
    Ok(())
}
