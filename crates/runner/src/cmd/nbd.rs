//! Shared NBD sysfs helpers used by `gc` and `doctor`.

use std::path::Path;

#[derive(Debug, Eq, PartialEq)]
enum NbdOrphanProbe {
    Orphan,
    Locked,
    Changed,
    Live,
    LockFailed(String),
}

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

/// Parse the PID/TID from `/sys/block/nbd{i}/pid`. Returns `None` if the file
/// doesn't exist, is empty, or contains a non-positive value (-1, 0).
pub(crate) fn read_nbd_pid(device_index: u32) -> Option<u32> {
    let content = std::fs::read_to_string(format!("/sys/block/nbd{device_index}/pid")).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed == "-1" || trimmed == "0" {
        return None;
    }
    trimmed.parse::<u32>().ok()
}

fn proc_pid_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Recheck one NBD candidate with the per-index lock held.
pub(crate) fn nbd_orphan_is_reportable(device_index: u32, pid: u32) -> bool {
    let mut try_lock = nbd_cow::device_lock::try_acquire_device_claim;
    let mut read_pid = read_nbd_pid;
    let mut pid_exists = proc_pid_exists;
    nbd_orphan_is_reportable_with(
        device_index,
        pid,
        &mut try_lock,
        &mut read_pid,
        &mut pid_exists,
    )
}

fn nbd_orphan_is_reportable_with<Guard>(
    device_index: u32,
    pid: u32,
    try_lock: &mut impl FnMut(u32) -> std::io::Result<Option<Guard>>,
    read_pid: &mut impl FnMut(u32) -> Option<u32>,
    pid_exists: &mut impl FnMut(u32) -> bool,
) -> bool {
    match classify_nbd_orphan_candidate_with(device_index, pid, try_lock, read_pid, pid_exists) {
        NbdOrphanProbe::Orphan => true,
        NbdOrphanProbe::LockFailed(message) => {
            tracing::warn!(
                device_index,
                pid,
                error = %message,
                "skipping NBD orphan candidate because device lock probe failed"
            );
            false
        }
        NbdOrphanProbe::Locked | NbdOrphanProbe::Changed | NbdOrphanProbe::Live => false,
    }
}

fn classify_nbd_orphan_candidate_with<Guard>(
    device_index: u32,
    pid: u32,
    try_lock: &mut impl FnMut(u32) -> std::io::Result<Option<Guard>>,
    read_pid: &mut impl FnMut(u32) -> Option<u32>,
    pid_exists: &mut impl FnMut(u32) -> bool,
) -> NbdOrphanProbe {
    let _guard = match try_lock(device_index) {
        Ok(Some(guard)) => guard,
        Ok(None) => return NbdOrphanProbe::Locked,
        Err(e) => return NbdOrphanProbe::LockFailed(e.to_string()),
    };

    match read_pid(device_index) {
        Some(current_pid) if current_pid == pid && !pid_exists(current_pid) => {
            NbdOrphanProbe::Orphan
        }
        Some(current_pid) if current_pid == pid => NbdOrphanProbe::Live,
        _ => NbdOrphanProbe::Changed,
    }
}

/// Scan all NBD devices for reportable orphans: lock-free devices whose
/// recorded owner task has exited.
///
/// Returns `(max_devs_scanned, orphans)` where each orphan is `(device_index, pid)`.
pub(crate) fn find_nbd_orphans() -> (u32, Vec<(u32, u32)>) {
    let max_devs = read_nbds_max();
    let orphans = find_nbd_orphans_with(
        max_devs,
        nbd_cow::device_lock::try_acquire_device_claim,
        read_nbd_pid,
        proc_pid_exists,
    );
    (max_devs, orphans)
}

fn find_nbd_orphans_with<Guard>(
    max_devs: u32,
    mut try_lock: impl FnMut(u32) -> std::io::Result<Option<Guard>>,
    mut read_pid: impl FnMut(u32) -> Option<u32>,
    mut pid_exists: impl FnMut(u32) -> bool,
) -> Vec<(u32, u32)> {
    let mut orphans: Vec<(u32, u32)> = Vec::new();
    for i in 0..max_devs {
        if let Some(pid) = read_pid(i)
            && !pid_exists(pid)
            && nbd_orphan_is_reportable_with(i, pid, &mut try_lock, &mut read_pid, &mut pid_exists)
        {
            orphans.push((i, pid));
        }
    }
    orphans
}

/// Disconnect an orphan-looking NBD device only while holding its per-index
/// host lock and after confirming the PID is still the same dead process.
pub(crate) fn disconnect_orphan_if_still_dead(device_index: u32, pid: u32) -> NbdOrphanDisconnect {
    disconnect_orphan_if_still_dead_with(
        device_index,
        pid,
        nbd_cow::device_lock::try_acquire_device_claim,
        read_nbd_pid,
        proc_pid_exists,
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
    fn find_nbd_orphans_skips_locked_dead_pid() {
        let orphans = find_nbd_orphans_with(
            1,
            |_| Ok::<Option<()>, std::io::Error>(None),
            |_| Some(123),
            |_| false,
        );

        assert!(orphans.is_empty());
    }

    #[test]
    fn find_nbd_orphans_reports_lock_free_dead_pid() {
        let orphans = find_nbd_orphans_with(
            1,
            |_| Ok::<Option<()>, std::io::Error>(Some(())),
            |_| Some(123),
            |_| false,
        );

        assert_eq!(orphans, vec![(0, 123)]);
    }

    #[test]
    fn find_nbd_orphans_does_not_lock_live_pid_candidates() {
        let lock_attempts = Cell::new(0);
        let orphans = find_nbd_orphans_with(
            1,
            |_| {
                lock_attempts.set(lock_attempts.get() + 1);
                Ok::<Option<()>, std::io::Error>(Some(()))
            },
            |_| Some(123),
            |_| true,
        );

        assert!(orphans.is_empty());
        assert_eq!(lock_attempts.get(), 0);
    }

    #[test]
    fn orphan_probe_clears_when_pid_changes_after_lock() {
        let mut try_lock = |_| Ok::<Option<()>, std::io::Error>(Some(()));
        let mut read_pid = |_| Some(456);
        let mut pid_exists = |_| false;

        let status = classify_nbd_orphan_candidate_with(
            3,
            123,
            &mut try_lock,
            &mut read_pid,
            &mut pid_exists,
        );

        assert_eq!(status, NbdOrphanProbe::Changed);
    }

    #[test]
    fn orphan_probe_clears_when_pid_clears_after_lock() {
        let mut try_lock = |_| Ok::<Option<()>, std::io::Error>(Some(()));
        let mut read_pid = |_| None;
        let mut pid_exists = |_| panic!("pid_exists should not run after pid is cleared");

        let status = classify_nbd_orphan_candidate_with(
            3,
            123,
            &mut try_lock,
            &mut read_pid,
            &mut pid_exists,
        );

        assert_eq!(status, NbdOrphanProbe::Changed);
    }

    #[test]
    fn orphan_probe_clears_when_same_pid_is_live_after_lock() {
        let mut try_lock = |_| Ok::<Option<()>, std::io::Error>(Some(()));
        let mut read_pid = |_| Some(123);
        let mut pid_exists = |_| true;

        let status = classify_nbd_orphan_candidate_with(
            3,
            123,
            &mut try_lock,
            &mut read_pid,
            &mut pid_exists,
        );

        assert_eq!(status, NbdOrphanProbe::Live);
    }

    #[test]
    fn orphan_probe_reports_lock_error_as_not_reportable() {
        let mut try_lock = |_| Err::<Option<()>, std::io::Error>(std::io::Error::other("boom"));
        let mut read_pid = |_| panic!("read_pid should not run after lock failure");
        let mut pid_exists = |_| panic!("pid_exists should not run after lock failure");

        assert!(!nbd_orphan_is_reportable_with(
            3,
            123,
            &mut try_lock,
            &mut read_pid,
            &mut pid_exists,
        ));
    }

    #[test]
    fn orphan_probe_holds_lock_through_recheck() {
        let dropped = Rc::new(Cell::new(false));
        let dropped_for_lock = dropped.clone();
        let dropped_for_read = dropped.clone();
        let dropped_for_pid = dropped.clone();
        let mut try_lock = move |_| {
            Ok::<Option<DropGuard>, std::io::Error>(Some(DropGuard(dropped_for_lock.clone())))
        };
        let mut read_pid = |_| {
            assert!(
                !dropped_for_read.get(),
                "lock must be held while sysfs pid is re-read"
            );
            Some(123)
        };
        let mut pid_exists = |_| {
            assert!(
                !dropped_for_pid.get(),
                "lock must be held while pid liveness is rechecked"
            );
            false
        };

        let status = classify_nbd_orphan_candidate_with(
            3,
            123,
            &mut try_lock,
            &mut read_pid,
            &mut pid_exists,
        );

        assert_eq!(status, NbdOrphanProbe::Orphan);
        assert!(dropped.get(), "lock should drop after orphan probe");
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
    fn orphan_disconnect_reports_disconnect_error() {
        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Ok(Some(())),
            |_| Some(123),
            |_| false,
            |_| {
                Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
                    "netlink failed",
                )))
            },
        );

        match result {
            NbdOrphanDisconnect::Failed(message) => {
                assert!(message.contains("netlink failed"));
            }
            other => panic!("expected disconnect failure, got {other:?}"),
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
    fn orphan_disconnect_skips_when_pid_cleared_after_lock() {
        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Ok(Some(())),
            |_| None,
            |_| panic!("pid_exists should not run after pid is cleared"),
            |_| panic!("disconnect should not run after pid is cleared"),
        );

        assert!(matches!(result, NbdOrphanDisconnect::Changed));
    }

    #[test]
    fn orphan_disconnect_skips_when_same_pid_is_live_after_lock() {
        let result = disconnect_orphan_if_still_dead_with(
            3,
            123,
            |_| Ok(Some(())),
            |_| Some(123),
            |_| true,
            |_| panic!("disconnect should not run for a live pid"),
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
