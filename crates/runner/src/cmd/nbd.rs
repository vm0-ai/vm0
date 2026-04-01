//! Shared NBD sysfs helpers used by `gc` and `doctor`.

/// Default upper bound for NBD device indices when `/sys/module/nbd/parameters/nbds_max`
/// is unreadable (e.g. module not loaded). The actual limit is set by ansible
/// (`modprobe nbd nbds_max=4096`); this fallback only applies when the sysfs
/// parameter cannot be read, which implies no devices exist anyway.
const NBD_DEFAULT_MAX: u32 = 256;

/// Read the maximum number of NBD devices from the kernel module parameter.
pub(crate) fn read_nbds_max() -> u32 {
    std::fs::read_to_string("/sys/module/nbd/parameters/nbds_max")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(NBD_DEFAULT_MAX)
}

/// Parse the PID from `/sys/block/nbd{i}/pid`. Returns `None` if the file
/// doesn't exist, is empty, or contains a non-positive value (-1, 0).
pub(crate) fn read_nbd_pid(device_index: u32) -> Option<u32> {
    let content = std::fs::read_to_string(format!("/sys/block/nbd{device_index}/pid")).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed == "-1" || trimmed == "0" {
        return None;
    }
    trimmed.parse::<u32>().ok()
}
