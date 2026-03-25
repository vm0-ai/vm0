use std::path::{Path, PathBuf};

use crate::command;
use crate::error::Result;

/// Attach a file to a free loop device. Returns the loop device path
/// (e.g. `/dev/loop0`).
///
/// Attach without `--direct-io` so all I/O goes through the host page
/// cache.  This is critical on EBS-backed storage where direct IOPS are
/// limited (~3000 baseline for gp3).  Without page cache buffering:
///
/// - **Reads**: every guest read through dm-snapshot hits EBS; chromium
///   startup (~100K random 4KB reads) would take ~30s vs <1s from cache.
/// - **Writes**: every dm-snapshot COW operation (read original chunk +
///   write new chunk) hits EBS synchronously; chromium startup writes
///   ~46K chunks ≈ ~93K IOPS ≈ 30s.
///
/// The old overlay approach used regular file I/O (no loop device), so
/// reads and writes naturally went through page cache.  Omitting
/// `--direct-io` gives the same buffering behavior through the loop
/// device's block cache + backing file's page cache.
pub fn attach(file_path: &Path, read_only: bool) -> Result<PathBuf> {
    let file_str = file_path.to_string_lossy();
    let mut args = vec!["--find", "--show"];
    if read_only {
        args.push("--read-only");
    }
    args.push(&file_str);

    let stdout = command::run("losetup", &args)?;
    Ok(PathBuf::from(stdout))
}

/// Detach a loop device.
pub fn detach(loop_device: &Path) -> Result<()> {
    let dev_str = loop_device.to_string_lossy();
    command::run("losetup", &["--detach", &dev_str])?;
    Ok(())
}
