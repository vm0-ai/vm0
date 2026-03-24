use std::path::{Path, PathBuf};

use crate::command;
use crate::error::Result;

/// Attach a file to a free loop device. Returns the loop device path
/// (e.g. `/dev/loop0`).
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
