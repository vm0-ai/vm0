/// Try to disconnect stale NBD devices that still have a non-zero size.
///
/// The sysfs `pid` field is the connecting thread TID, not necessarily the
/// process PID. In multi-runner hosts, only disconnect after acquiring the
/// host-global NBD claim so an active cooperating runner cannot be interrupted.
pub(crate) fn cleanup_stale_nbd_devices() {
    let max = nbd_cow::netlink::nbds_max();
    for i in 0..max {
        let Some(candidate) = read_nbd_device_state(i) else {
            continue;
        };
        if !nbd_cleanup_candidate(candidate) {
            continue;
        }

        let claim = match nbd_cow::device_lock::try_acquire_device_claim(i) {
            Ok(Some(claim)) => claim,
            Ok(None) => continue,
            Err(e) => {
                eprintln!("  Skipping stale /dev/nbd{i} cleanup; lock failed: {e}");
                continue;
            }
        };

        let Some(current) = read_nbd_device_state(i) else {
            continue;
        };
        if !nbd_cleanup_candidate(current) {
            continue;
        }

        eprintln!(
            "  Cleaning up stale /dev/nbd{i} (size={}, pid={})...",
            current.size, current.pid
        );
        let _ = nbd_cow::netlink::disconnect(i);
        drop(claim);
    }
}

#[derive(Clone, Copy)]
struct NbdDeviceState {
    size: u64,
    pid: u32,
}

fn read_nbd_device_state(index: u32) -> Option<NbdDeviceState> {
    let size_path = format!("/sys/block/nbd{index}/size");
    let pid_path = format!("/sys/block/nbd{index}/pid");
    let size = std::fs::read_to_string(&size_path)
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let pid = std::fs::read_to_string(&pid_path)
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(NbdDeviceState { size, pid })
}

fn nbd_cleanup_candidate(state: NbdDeviceState) -> bool {
    state.size != 0 && nbd_cleanup_candidate_owner(state.pid)
}

fn nbd_cleanup_candidate_owner(pid: u32) -> bool {
    pid != 0
        && (nbd_cow::is_our_thread(pid) || !std::path::Path::new(&format!("/proc/{pid}")).exists())
}

pub(crate) fn nbd_module_loaded() -> bool {
    std::fs::read_to_string("/proc/modules")
        .map(|s| s.lines().any(|l| l.starts_with("nbd ")))
        .unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nbd_cleanup_candidate_owner_requires_known_dead_or_current_owner() {
        assert!(!nbd_cleanup_candidate_owner(0));
        assert!(nbd_cleanup_candidate_owner(std::process::id()));
        assert!(nbd_cleanup_candidate_owner(u32::MAX));
    }

    #[test]
    fn nbd_cleanup_candidate_requires_nonzero_size_and_cleanup_owner() {
        assert!(!nbd_cleanup_candidate(NbdDeviceState {
            size: 0,
            pid: std::process::id()
        }));
        assert!(!nbd_cleanup_candidate(NbdDeviceState { size: 1, pid: 0 }));
        assert!(nbd_cleanup_candidate(NbdDeviceState {
            size: 1,
            pid: std::process::id()
        }));
    }
}
