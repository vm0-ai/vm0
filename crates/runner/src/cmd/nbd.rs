//! Shared NBD scan helpers used by `gc` and `doctor`.

pub(crate) use nbd_cow::orphan::NbdOrphanDisconnect;
use nbd_cow::orphan::{self, NbdOrphanCandidate, NbdOrphanPolicy, NbdOrphanProbe};

/// Read the maximum number of NBD devices from the kernel module parameter.
/// Delegates to `nbd_cow::netlink::nbds_max()` which reads sysfs and falls
/// back to 256 when the module is not loaded.
pub(crate) fn read_nbds_max() -> u32 {
    nbd_cow::netlink::nbds_max()
}

/// Recheck one previously observed dead-owner candidate with its claim held.
pub(crate) fn nbd_orphan_is_reportable(device_index: u32, owner_tid: u32) -> bool {
    nbd_orphan_candidate_is_reportable(NbdOrphanCandidate::from_dead_owner_observation(
        device_index,
        owner_tid,
    ))
}

fn nbd_orphan_candidate_is_reportable(candidate: NbdOrphanCandidate) -> bool {
    match orphan::probe(candidate) {
        NbdOrphanProbe::Orphan(_) => true,
        NbdOrphanProbe::Failed(error) => {
            tracing::warn!(
                device_index = candidate.device_index(),
                owner_tid = candidate.owner_tid(),
                error = %error,
                "skipping NBD orphan candidate because revalidation failed"
            );
            false
        }
        NbdOrphanProbe::Locked | NbdOrphanProbe::Changed | NbdOrphanProbe::Live => false,
    }
}

/// Scan all NBD devices for reportable orphans: lock-free devices whose
/// recorded owner task has exited.
///
/// Returns `(max_devs_scanned, orphans)` where each orphan is
/// `(device_index, owner_tid)`.
pub(crate) fn find_nbd_orphans() -> (u32, Vec<(u32, u32)>) {
    let max_devs = read_nbds_max();
    let mut orphans = Vec::new();
    for device_index in 0..max_devs {
        let candidate = match orphan::observe(device_index, NbdOrphanPolicy::DeadOwner) {
            Ok(Some(candidate)) => candidate,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    device_index,
                    error = %error,
                    "skipping NBD device because owner liveness check failed"
                );
                continue;
            }
        };
        if nbd_orphan_candidate_is_reportable(candidate) {
            orphans.push((candidate.device_index(), candidate.owner_tid()));
        }
    }
    (max_devs, orphans)
}

/// Disconnect a dead-owner candidate only after claim-protected revalidation.
pub(crate) fn disconnect_orphan_if_still_dead(
    device_index: u32,
    owner_tid: u32,
) -> NbdOrphanDisconnect {
    orphan::disconnect(NbdOrphanCandidate::from_dead_owner_observation(
        device_index,
        owner_tid,
    ))
}
