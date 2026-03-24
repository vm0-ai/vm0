use std::path::Path;

use crate::command;
use crate::error::Result;

/// Get the size of a block device in 512-byte sectors.
pub fn get_size_sectors(device: &Path) -> Result<u64> {
    let dev_str = device.to_string_lossy();
    let stdout = command::run("blockdev", &["--getsz", &dev_str])?;
    stdout.parse::<u64>().map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("failed to parse sector count from `{stdout}`: {e}"),
        )
        .into()
    })
}
