//! Shared NBD sysfs helpers used by `gc` and `doctor`.

/// Read the maximum number of NBD devices from the kernel module parameter.
/// Delegates to `nbd_cow::netlink::nbds_max()` which reads sysfs and falls
/// back to 256 when the module is not loaded.
pub(crate) fn read_nbds_max() -> u32 {
    nbd_cow::netlink::nbds_max()
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

/// Scan all NBD devices for orphans: devices whose owning PID has exited.
///
/// Returns `(max_devs_scanned, orphans)` where each orphan is `(device_index, pid)`.
pub(crate) fn find_nbd_orphans() -> (u32, Vec<(u32, u32)>) {
    let max_devs = read_nbds_max();
    let mut orphans: Vec<(u32, u32)> = Vec::new();
    for i in 0..max_devs {
        if let Some(pid) = read_nbd_pid(i)
            && !std::path::Path::new(&format!("/proc/{pid}")).exists()
        {
            orphans.push((i, pid));
        }
    }
    (max_devs, orphans)
}
