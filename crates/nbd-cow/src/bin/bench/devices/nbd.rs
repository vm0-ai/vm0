/// Try to disconnect stale NBD devices that still have a non-zero size.
///
/// The sysfs `pid` field is the connecting thread TID, not necessarily the
/// process PID. In multi-runner hosts, only disconnect after acquiring the
/// cooperative NBD claim so an active cooperating runner cannot be interrupted.
pub(crate) fn cleanup_stale_nbd_devices() {
    let max = nbd_cow::netlink::nbds_max();
    for i in 0..max {
        let candidate = match nbd_cow::orphan::observe(
            i,
            nbd_cow::orphan::NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize,
        ) {
            Ok(Some(candidate)) => candidate,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("  Skipped stale /dev/nbd{i} cleanup: {error}");
                continue;
            }
        };
        match nbd_cow::orphan::disconnect(candidate) {
            nbd_cow::orphan::NbdOrphanDisconnect::Disconnected(current) => {
                match current.size_sectors() {
                    Some(size) => eprintln!(
                        "  Cleaned up stale /dev/nbd{i} (size={size}, pid={})",
                        current.owner_tid()
                    ),
                    None => eprintln!(
                        "  Cleaned up stale /dev/nbd{i} (pid={})",
                        current.owner_tid()
                    ),
                }
            }
            nbd_cow::orphan::NbdOrphanDisconnect::Failed(error) => {
                eprintln!("  Stale /dev/nbd{i} cleanup failed: {error}");
            }
            nbd_cow::orphan::NbdOrphanDisconnect::Locked
            | nbd_cow::orphan::NbdOrphanDisconnect::Changed
            | nbd_cow::orphan::NbdOrphanDisconnect::Live => {}
        }
    }
}

pub(crate) fn nbd_module_loaded() -> bool {
    std::fs::read_to_string("/proc/modules")
        .map(|s| s.lines().any(|l| l.starts_with("nbd ")))
        .unwrap_or(false)
}
