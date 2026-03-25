use std::path::{Path, PathBuf};

use crate::command;
use crate::error::Result;

/// Attach a file to a free loop device. Returns the loop device path
/// (e.g. `/dev/loop0`).
///
/// Read-only base loops use buffered I/O (no `--direct-io`) so the host
/// page cache absorbs random reads from the guest — critical for EBS
/// where uncached 4KB IOPS are limited to ~3000.  The COW loop uses
/// `--direct-io=on` to avoid double-caching writes (loop block cache +
/// file page cache).
pub fn attach(file_path: &Path, read_only: bool) -> Result<PathBuf> {
    let file_str = file_path.to_string_lossy();
    let mut args = vec!["--find", "--show"];
    if read_only {
        // Read-only base: rely on file page cache for reads.
        // Caller should prefetch the file to warm the cache.
        args.push("--read-only");
    } else {
        // Writable COW: direct-io avoids double-caching writes.
        args.push("--direct-io=on");
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
