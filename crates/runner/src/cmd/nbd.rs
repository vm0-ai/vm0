//! Shared NBD sysfs helpers used by `gc` and `doctor`.

use std::path::Path;

#[derive(Debug)]
pub(crate) enum NbdOrphanDisconnect {
    Disconnected,
    Locked,
    Changed,
    Failed(String),
}

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

/// Disconnect an orphan-looking NBD device only while holding its per-index
/// host lock and after confirming the PID is still the same dead process.
pub(crate) fn disconnect_orphan_if_still_dead(device_index: u32, pid: u32) -> NbdOrphanDisconnect {
    disconnect_orphan_if_still_dead_with(
        device_index,
        pid,
        nbd_cow::device_lock::try_acquire_device_claim,
        read_nbd_pid,
        |pid| Path::new(&format!("/proc/{pid}")).exists(),
        nbd_cow::netlink::disconnect,
    )
}

fn disconnect_orphan_if_still_dead_with<Guard>(
    device_index: u32,
    pid: u32,
    try_lock: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_pid: impl FnOnce(u32) -> Option<u32>,
    pid_exists: impl FnOnce(u32) -> bool,
    disconnect: impl FnOnce(u32) -> nbd_cow::error::Result<()>,
) -> NbdOrphanDisconnect {
    let guard = match try_lock(device_index) {
        Ok(Some(guard)) => guard,
        Ok(None) => return NbdOrphanDisconnect::Locked,
        Err(e) => return NbdOrphanDisconnect::Failed(format!("lock failed: {e}")),
    };

    let result = match read_pid(device_index) {
        Some(current_pid) if current_pid == pid && !pid_exists(pid) => {
            match disconnect(device_index) {
                Ok(()) => NbdOrphanDisconnect::Disconnected,
                Err(e) => NbdOrphanDisconnect::Failed(e.to_string()),
            }
        }
        _ => NbdOrphanDisconnect::Changed,
    };

    drop(guard);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    struct DropGuard(Rc<Cell<bool>>);

    impl Drop for DropGuard {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }

    #[test]
    fn orphan_disconnect_skips_when_lock_is_held() {
        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Ok::<Option<()>, std::io::Error>(None),
            |_| Some(123),
            |_| false,
            |_| panic!("disconnect should not run without lock"),
        );

        assert!(matches!(result, NbdOrphanDisconnect::Locked));
    }

    #[test]
    fn orphan_disconnect_reports_lock_error() {
        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Err::<Option<()>, std::io::Error>(std::io::Error::other("boom")),
            |_| Some(123),
            |_| false,
            |_| panic!("disconnect should not run without lock"),
        );

        match result {
            NbdOrphanDisconnect::Failed(message) => {
                assert!(message.contains("lock failed"));
                assert!(message.contains("boom"));
            }
            other => panic!("expected lock failure, got {other:?}"),
        }
    }

    #[test]
    fn orphan_disconnect_rechecks_pid_after_lock() {
        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Ok(Some(())),
            |_| Some(456),
            |_| false,
            |_| panic!("disconnect should not run after pid change"),
        );

        assert!(matches!(result, NbdOrphanDisconnect::Changed));
    }

    #[test]
    fn orphan_disconnect_holds_lock_through_disconnect() {
        let dropped = Rc::new(Cell::new(false));
        let dropped_for_lock = dropped.clone();
        let dropped_for_disconnect = dropped.clone();

        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Ok(Some(DropGuard(dropped_for_lock))),
            |_| Some(123),
            |_| false,
            |_| {
                assert!(
                    !dropped_for_disconnect.get(),
                    "lock must be held while disconnect runs"
                );
                Ok(())
            },
        );

        assert!(matches!(result, NbdOrphanDisconnect::Disconnected));
        assert!(dropped.get(), "lock should drop after disconnect decision");
    }
}
