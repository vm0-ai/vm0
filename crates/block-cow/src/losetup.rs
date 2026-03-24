use std::path::{Path, PathBuf};

use crate::command;
use crate::error::Result;

/// Attach a file to a free loop device. Returns the loop device path
/// (e.g. `/dev/loop0`).
pub fn attach(file_path: &Path, read_only: bool) -> Result<PathBuf> {
    let file_str = file_path.to_string_lossy();
    // --direct-io=on: bypass the loop device's page cache so reads/writes
    // go straight to the backing file's page cache.  Without this, data is
    // cached twice (loop block cache + file page cache), wasting memory and
    // hurting throughput — Chromium launch (heavy random reads) was 3x
    // slower without it.
    let mut args = vec!["--find", "--show", "--direct-io=on"];
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
