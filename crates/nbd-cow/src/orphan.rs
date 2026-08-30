//! Lock-aware NBD orphan observation and cleanup.
//!
//! Linux records the task ID (TID) that connected an NBD device in
//! `/sys/block/nbdN/pid`. The helpers in this module observe that state, apply
//! an explicit cleanup policy, and then revalidate the exact observed TID while
//! holding the cooperative per-index claim. Destructive cleanup keeps the
//! claim held through the netlink disconnect call.
//!
//! The claim coordinates only processes that use the same claim mechanism.
//! Exact sysfs revalidation under that claim is therefore required before any
//! disconnect; non-cooperating device users are still outside its protection.

use std::path::Path;

use crate::error::NbdCowError;

/// Owner and size policy for one NBD orphan-cleanup caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdOrphanPolicy {
    /// Accept only an owner TID that no longer exists, without reading size.
    DeadOwner,
    /// Accept a dead or current-process owner TID only when size is non-zero.
    DeadOrCurrentProcessOwnerWithNonZeroSize,
}

impl NbdOrphanPolicy {
    const fn requires_non_zero_size(self) -> bool {
        matches!(self, Self::DeadOrCurrentProcessOwnerWithNonZeroSize)
    }
}

/// One policy-eligible NBD state observed before cooperative claim acquisition.
///
/// This value is evidence to revalidate, not proof of current ownership. Pass
/// it to [`probe`] or [`disconnect`] before reporting or mutating the device.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NbdOrphanCandidate {
    device_index: u32,
    owner_tid: u32,
    size_sectors: Option<u64>,
    policy: NbdOrphanPolicy,
}

impl NbdOrphanCandidate {
    /// Reconstruct a previously persisted dead-owner observation.
    ///
    /// [`probe`] and [`disconnect`] still acquire the cooperative claim and
    /// revalidate this exact TID before returning an eligible outcome.
    pub const fn from_dead_owner_observation(device_index: u32, owner_tid: u32) -> Self {
        Self {
            device_index,
            owner_tid,
            size_sectors: None,
            policy: NbdOrphanPolicy::DeadOwner,
        }
    }

    /// N in `/dev/nbdN`.
    pub const fn device_index(self) -> u32 {
        self.device_index
    }

    /// TID observed in `/sys/block/nbdN/pid`.
    pub const fn owner_tid(self) -> u32 {
        self.owner_tid
    }

    /// Observed `/sys/block/nbdN/size` in 512-byte sectors when required.
    pub const fn size_sectors(self) -> Option<u64> {
        self.size_sectors
    }
}

/// Failure while checking owner liveness, acquiring a claim, or disconnecting an orphan.
#[derive(Debug, thiserror::Error)]
pub enum NbdOrphanError {
    /// Owner liveness could not be established from procfs.
    #[error("failed to check owner TID {owner_tid} for /dev/nbd{device_index}: {source}")]
    OwnerLiveness {
        /// N in `/dev/nbdN`.
        device_index: u32,
        /// TID read from `/sys/block/nbdN/pid`.
        owner_tid: u32,
        /// Underlying procfs metadata error.
        #[source]
        source: std::io::Error,
    },
    /// The per-index cooperative claim could not be acquired.
    #[error("failed to acquire cooperative claim for /dev/nbd{device_index}: {source}")]
    Claim {
        /// N in `/dev/nbdN`.
        device_index: u32,
        /// Underlying lock-file error.
        #[source]
        source: std::io::Error,
    },
    /// Netlink failed while the revalidated cooperative claim was held.
    #[error("failed to disconnect /dev/nbd{device_index}: {source}")]
    Disconnect {
        /// N in `/dev/nbdN`.
        device_index: u32,
        /// Underlying NBD netlink error.
        #[source]
        source: NbdCowError,
    },
}

/// Result of revalidating an observed orphan without disconnecting it.
#[must_use = "orphan probe outcomes must be checked before reporting the device"]
#[derive(Debug)]
pub enum NbdOrphanProbe {
    /// The exact observed owner still satisfies the selected policy.
    Orphan(NbdOrphanCandidate),
    /// Another cooperating process currently holds the per-index claim.
    Locked,
    /// The owner or policy-relevant device state changed after observation.
    Changed,
    /// The exact observed owner now exists and is ineligible under the policy.
    Live,
    /// Owner liveness or cooperative claim acquisition failed.
    Failed(NbdOrphanError),
}

/// Result of revalidating and attempting to disconnect an observed orphan.
#[must_use = "orphan disconnect outcomes must be checked for skipped or failed cleanup"]
#[derive(Debug)]
pub enum NbdOrphanDisconnect {
    /// Netlink disconnected the exact revalidated orphan.
    Disconnected(NbdOrphanCandidate),
    /// Another cooperating process currently holds the per-index claim.
    Locked,
    /// The owner or policy-relevant device state changed after observation.
    Changed,
    /// The exact observed owner now exists and is ineligible under the policy.
    Live,
    /// Owner liveness, cooperative claim acquisition, or netlink disconnect failed.
    Failed(NbdOrphanError),
}

#[derive(Clone, Copy)]
struct NbdDeviceState {
    owner_tid: u32,
    size_sectors: Option<u64>,
}

enum RevalidatedCandidate<Guard> {
    Ready(NbdOrphanCandidate, Guard),
    Locked,
    Changed,
    Live,
    Failed(NbdOrphanError),
}

/// Observe one policy-eligible NBD orphan candidate without acquiring its claim.
///
/// Missing, released, malformed, unreadable, or policy-ineligible sysfs state
/// returns `Ok(None)`. Uncertain owner liveness returns an error. A returned
/// candidate must be passed to [`probe`] or [`disconnect`] before it is treated
/// as current.
pub fn observe(
    device_index: u32,
    policy: NbdOrphanPolicy,
) -> Result<Option<NbdOrphanCandidate>, NbdOrphanError> {
    observe_with(
        device_index,
        policy,
        read_nbd_device_state,
        proc_tid_exists,
        crate::is_our_thread,
    )
}

/// Acquire the cooperative claim and revalidate an observed candidate.
///
/// The claim is released before this function returns, so the outcome records
/// the locked observation rather than reserving the device for a later action.
pub fn probe(candidate: NbdOrphanCandidate) -> NbdOrphanProbe {
    probe_with(
        candidate,
        crate::device_lock::try_acquire_device_claim,
        read_nbd_device_state,
        proc_tid_exists,
        crate::is_our_thread,
    )
}

/// Acquire the cooperative claim, revalidate an observed candidate, and
/// disconnect it while the claim remains held.
pub fn disconnect(candidate: NbdOrphanCandidate) -> NbdOrphanDisconnect {
    disconnect_with(
        candidate,
        crate::device_lock::try_acquire_device_claim,
        read_nbd_device_state,
        proc_tid_exists,
        crate::is_our_thread,
        crate::netlink::disconnect,
    )
}

fn observe_with(
    device_index: u32,
    policy: NbdOrphanPolicy,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> Result<Option<NbdOrphanCandidate>, NbdOrphanError> {
    let Some(state) = read_state(device_index, policy) else {
        return Ok(None);
    };
    if !size_is_eligible(state, policy) {
        return Ok(None);
    }
    let owner_is_eligible =
        owner_is_eligible(state.owner_tid, policy, owner_exists, current_process_owns).map_err(
            |source| NbdOrphanError::OwnerLiveness {
                device_index,
                owner_tid: state.owner_tid,
                source,
            },
        )?;
    if !owner_is_eligible {
        return Ok(None);
    }

    Ok(Some(candidate_from_state(device_index, state, policy)))
}

fn probe_with<Guard>(
    candidate: NbdOrphanCandidate,
    try_claim: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> NbdOrphanProbe {
    match revalidate_with(
        candidate,
        try_claim,
        read_state,
        owner_exists,
        current_process_owns,
    ) {
        RevalidatedCandidate::Ready(current, claim) => {
            drop(claim);
            NbdOrphanProbe::Orphan(current)
        }
        RevalidatedCandidate::Locked => NbdOrphanProbe::Locked,
        RevalidatedCandidate::Changed => NbdOrphanProbe::Changed,
        RevalidatedCandidate::Live => NbdOrphanProbe::Live,
        RevalidatedCandidate::Failed(error) => NbdOrphanProbe::Failed(error),
    }
}

fn disconnect_with<Guard>(
    candidate: NbdOrphanCandidate,
    try_claim: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
    disconnect_device: impl FnOnce(u32) -> crate::error::Result<()>,
) -> NbdOrphanDisconnect {
    match revalidate_with(
        candidate,
        try_claim,
        read_state,
        owner_exists,
        current_process_owns,
    ) {
        RevalidatedCandidate::Ready(current, claim) => {
            let result = match disconnect_device(candidate.device_index) {
                Ok(()) => NbdOrphanDisconnect::Disconnected(current),
                Err(source) => NbdOrphanDisconnect::Failed(NbdOrphanError::Disconnect {
                    device_index: candidate.device_index,
                    source,
                }),
            };
            drop(claim);
            result
        }
        RevalidatedCandidate::Locked => NbdOrphanDisconnect::Locked,
        RevalidatedCandidate::Changed => NbdOrphanDisconnect::Changed,
        RevalidatedCandidate::Live => NbdOrphanDisconnect::Live,
        RevalidatedCandidate::Failed(error) => NbdOrphanDisconnect::Failed(error),
    }
}

fn revalidate_with<Guard>(
    candidate: NbdOrphanCandidate,
    try_claim: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> RevalidatedCandidate<Guard> {
    let claim = match try_claim(candidate.device_index) {
        Ok(Some(claim)) => claim,
        Ok(None) => return RevalidatedCandidate::Locked,
        Err(source) => {
            return RevalidatedCandidate::Failed(NbdOrphanError::Claim {
                device_index: candidate.device_index,
                source,
            });
        }
    };

    let Some(current) = read_state(candidate.device_index, candidate.policy) else {
        return RevalidatedCandidate::Changed;
    };
    if current.owner_tid != candidate.owner_tid || !size_is_eligible(current, candidate.policy) {
        return RevalidatedCandidate::Changed;
    }
    let owner_is_eligible = match owner_is_eligible(
        current.owner_tid,
        candidate.policy,
        owner_exists,
        current_process_owns,
    ) {
        Ok(owner_is_eligible) => owner_is_eligible,
        Err(source) => {
            return RevalidatedCandidate::Failed(NbdOrphanError::OwnerLiveness {
                device_index: candidate.device_index,
                owner_tid: current.owner_tid,
                source,
            });
        }
    };
    if !owner_is_eligible {
        return RevalidatedCandidate::Live;
    }

    RevalidatedCandidate::Ready(
        candidate_from_state(candidate.device_index, current, candidate.policy),
        claim,
    )
}

fn read_nbd_device_state(device_index: u32, policy: NbdOrphanPolicy) -> Option<NbdDeviceState> {
    read_nbd_device_state_with(device_index, policy, |path| std::fs::read_to_string(path))
}

fn read_nbd_device_state_with(
    device_index: u32,
    policy: NbdOrphanPolicy,
    mut read: impl FnMut(&Path) -> std::io::Result<String>,
) -> Option<NbdDeviceState> {
    let size_sectors = if policy.requires_non_zero_size() {
        let size_path = format!("/sys/block/nbd{device_index}/size");
        Some(read(Path::new(&size_path)).ok()?.trim().parse().ok()?)
    } else {
        None
    };

    let owner_path = format!("/sys/block/nbd{device_index}/pid");
    let owner_tid = parse_owner_tid(&read(Path::new(&owner_path)).ok()?)?;
    Some(NbdDeviceState {
        owner_tid,
        size_sectors,
    })
}

fn parse_owner_tid(contents: &str) -> Option<u32> {
    let owner = contents.trim();
    if owner.is_empty() || owner == "-1" || owner == "0" {
        return None;
    }
    owner.parse().ok()
}

fn proc_tid_exists(owner_tid: u32) -> std::io::Result<bool> {
    Path::new(&format!("/proc/{owner_tid}")).try_exists()
}

fn size_is_eligible(state: NbdDeviceState, policy: NbdOrphanPolicy) -> bool {
    !policy.requires_non_zero_size() || state.size_sectors.is_some_and(|size| size != 0)
}

fn owner_is_eligible(
    owner_tid: u32,
    policy: NbdOrphanPolicy,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> std::io::Result<bool> {
    match policy {
        NbdOrphanPolicy::DeadOwner => owner_exists(owner_tid).map(|exists| !exists),
        NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize => {
            if current_process_owns(owner_tid) {
                Ok(true)
            } else {
                owner_exists(owner_tid).map(|exists| !exists)
            }
        }
    }
}

const fn candidate_from_state(
    device_index: u32,
    state: NbdDeviceState,
    policy: NbdOrphanPolicy,
) -> NbdOrphanCandidate {
    NbdOrphanCandidate {
        device_index,
        owner_tid: state.owner_tid,
        size_sectors: state.size_sectors,
        policy,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::process::{Command, Stdio};
    use std::rc::Rc;

    use super::*;

    struct DropGuard(Rc<Cell<bool>>);

    impl Drop for DropGuard {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    const fn state(owner_tid: u32, size_sectors: Option<u64>) -> NbdDeviceState {
        NbdDeviceState {
            owner_tid,
            size_sectors,
        }
    }

    const fn local_or_dead_candidate(
        device_index: u32,
        owner_tid: u32,
        size_sectors: u64,
    ) -> NbdOrphanCandidate {
        NbdOrphanCandidate {
            device_index,
            owner_tid,
            size_sectors: Some(size_sectors),
            policy: NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize,
        }
    }

    #[test]
    fn state_reader_reads_only_policy_required_fields() {
        let dead = read_nbd_device_state_with(7, NbdOrphanPolicy::DeadOwner, |path| {
            assert_eq!(path, Path::new("/sys/block/nbd7/pid"));
            Ok("42\n".to_string())
        });
        assert!(
            matches!(dead, Some(state) if state.owner_tid == 42 && state.size_sectors.is_none())
        );

        let reads = Cell::new(0);
        let local = read_nbd_device_state_with(
            7,
            NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize,
            |path| {
                reads.set(reads.get() + 1);
                match path.file_name().and_then(|name| name.to_str()) {
                    Some("size") => Ok("8\n".to_string()),
                    Some("pid") => Ok("42\n".to_string()),
                    other => panic!("unexpected sysfs file {other:?}"),
                }
            },
        );
        assert!(
            matches!(local, Some(state) if state.owner_tid == 42 && state.size_sectors == Some(8))
        );
        assert_eq!(reads.get(), 2);
    }

    #[test]
    fn state_reader_rejects_released_and_malformed_owners() {
        for policy in [
            NbdOrphanPolicy::DeadOwner,
            NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize,
        ] {
            for owner in ["", "0\n", "-1\n", "not-a-tid\n"] {
                let state = read_nbd_device_state_with(7, policy, |path| {
                    match path.file_name().and_then(|name| name.to_str()) {
                        Some("size") => Ok("8\n".to_string()),
                        Some("pid") => Ok(owner.to_string()),
                        other => panic!("unexpected sysfs file {other:?}"),
                    }
                });
                assert!(
                    state.is_none(),
                    "owner contents {owner:?} must be rejected for {policy:?}"
                );
            }
        }
    }

    #[test]
    fn dead_owner_policy_ignores_size_and_rejects_live_owner() {
        let dead = observe_with(
            3,
            NbdOrphanPolicy::DeadOwner,
            |_, _| Some(state(123, None)),
            |_| Ok(false),
            |_| panic!("dead-owner policy must not inspect current-process membership"),
        );
        assert!(
            matches!(dead, Ok(Some(candidate)) if candidate.owner_tid() == 123 && candidate.size_sectors().is_none())
        );

        let live = observe_with(
            3,
            NbdOrphanPolicy::DeadOwner,
            |_, _| Some(state(123, None)),
            |_| Ok(true),
            |_| panic!("dead-owner policy must not inspect current-process membership"),
        );
        assert!(matches!(live, Ok(None)));
    }

    #[test]
    fn local_or_dead_policy_requires_non_zero_size() {
        let policy = NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize;
        let zero_size = observe_with(
            3,
            policy,
            |_, _| Some(state(123, Some(0))),
            |_| panic!("zero size must be rejected before owner liveness"),
            |_| panic!("zero size must be rejected before owner membership"),
        );
        assert!(matches!(zero_size, Ok(None)));

        let dead = observe_with(
            3,
            policy,
            |_, _| Some(state(123, Some(8))),
            |_| Ok(false),
            |_| false,
        );
        assert!(matches!(dead, Ok(Some(candidate)) if candidate.size_sectors() == Some(8)));
    }

    #[test]
    fn local_or_dead_policy_accepts_current_process_and_rejects_live_foreign_owner() {
        let policy = NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize;
        let local = observe_with(
            3,
            policy,
            |_, _| Some(state(123, Some(8))),
            |_| panic!("current-process owner must short-circuit liveness"),
            |_| true,
        );
        assert!(matches!(local, Ok(Some(_))));

        let foreign = observe_with(
            3,
            policy,
            |_, _| Some(state(123, Some(8))),
            |_| Ok(true),
            |_| false,
        );
        assert!(matches!(foreign, Ok(None)));
    }

    #[test]
    fn observation_reports_owner_liveness_failures_for_both_policies() {
        for (policy, size_sectors) in [
            (NbdOrphanPolicy::DeadOwner, None),
            (
                NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize,
                Some(8),
            ),
        ] {
            let outcome = observe_with(
                3,
                policy,
                |_, _| Some(state(123, size_sectors)),
                |_| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "procfs permission denied",
                    ))
                },
                |_| false,
            );

            match outcome {
                Err(NbdOrphanError::OwnerLiveness {
                    device_index,
                    owner_tid,
                    source,
                }) => {
                    assert_eq!(device_index, 3);
                    assert_eq!(owner_tid, 123);
                    assert_eq!(source.kind(), std::io::ErrorKind::PermissionDenied);
                    assert_eq!(source.to_string(), "procfs permission denied");
                }
                other => panic!("expected owner liveness failure for {policy:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn owner_policies_classify_real_processes() {
        let mut child = ChildGuard(
            Command::new("cat")
                .stdin(Stdio::piped())
                .spawn()
                .expect("spawn live foreign owner"),
        );
        let foreign_tid = child.0.id();
        assert_ne!(foreign_tid, std::process::id());
        assert!(
            child
                .0
                .try_wait()
                .expect("check live foreign owner")
                .is_none()
        );

        let broad_policy = NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize;
        assert!(
            observe_with(
                3,
                broad_policy,
                |_, _| Some(state(std::process::id(), Some(8))),
                proc_tid_exists,
                crate::is_our_thread,
            )
            .is_ok_and(|candidate| candidate.is_some())
        );
        assert!(
            observe_with(
                3,
                broad_policy,
                |_, _| Some(state(foreign_tid, Some(8))),
                proc_tid_exists,
                crate::is_our_thread,
            )
            .is_ok_and(|candidate| candidate.is_none())
        );
        assert!(
            observe_with(
                3,
                broad_policy,
                |_, _| Some(state(u32::MAX, Some(8))),
                proc_tid_exists,
                crate::is_our_thread,
            )
            .is_ok_and(|candidate| candidate.is_some())
        );
        assert!(
            observe_with(
                3,
                NbdOrphanPolicy::DeadOwner,
                |_, _| Some(state(foreign_tid, None)),
                proc_tid_exists,
                crate::is_our_thread,
            )
            .is_ok_and(|candidate| candidate.is_none())
        );
        assert!(
            child
                .0
                .try_wait()
                .expect("recheck live foreign owner")
                .is_none()
        );
    }

    #[test]
    fn probe_reports_locked_and_claim_failure() {
        let candidate = NbdOrphanCandidate::from_dead_owner_observation(3, 123);
        let locked = probe_with(
            candidate,
            |_| Ok::<Option<()>, std::io::Error>(None),
            |_, _| panic!("locked candidate must not be re-read"),
            |_| panic!("locked candidate must not check liveness"),
            |_| panic!("locked candidate must not check membership"),
        );
        assert!(matches!(locked, NbdOrphanProbe::Locked));

        let failed = probe_with(
            candidate,
            |_| Err::<Option<()>, std::io::Error>(std::io::Error::other("boom")),
            |_, _| panic!("failed claim must not be re-read"),
            |_| panic!("failed claim must not check liveness"),
            |_| panic!("failed claim must not check membership"),
        );
        match failed {
            NbdOrphanProbe::Failed(NbdOrphanError::Claim {
                device_index,
                source,
            }) => {
                assert_eq!(device_index, 3);
                assert_eq!(source.to_string(), "boom");
            }
            other => panic!("expected claim failure, got {other:?}"),
        }
    }

    #[test]
    fn probe_reports_changed_when_owner_changes_or_clears() {
        let candidate = NbdOrphanCandidate::from_dead_owner_observation(3, 123);
        let changed = probe_with(
            candidate,
            |_| Ok(Some(())),
            |_, _| Some(state(456, None)),
            |_| panic!("changed owner must not check liveness"),
            |_| panic!("changed owner must not check membership"),
        );
        assert!(matches!(changed, NbdOrphanProbe::Changed));

        let cleared = probe_with(
            candidate,
            |_| Ok(Some(())),
            |_, _| None,
            |_| panic!("cleared owner must not check liveness"),
            |_| panic!("cleared owner must not check membership"),
        );
        assert!(matches!(cleared, NbdOrphanProbe::Changed));
    }

    #[test]
    fn probe_reports_live_when_same_dead_policy_owner_revives() {
        let outcome = probe_with(
            NbdOrphanCandidate::from_dead_owner_observation(3, 123),
            |_| Ok(Some(())),
            |_, _| Some(state(123, None)),
            |_| Ok(true),
            |_| panic!("dead-owner policy must not inspect current-process membership"),
        );
        assert!(matches!(outcome, NbdOrphanProbe::Live));
    }

    #[test]
    fn probe_reports_owner_liveness_failure() {
        let outcome = probe_with(
            NbdOrphanCandidate::from_dead_owner_observation(3, 123),
            |_| Ok(Some(())),
            |_, _| Some(state(123, None)),
            |_| Err(std::io::Error::other("procfs unavailable")),
            |_| panic!("dead-owner policy must not inspect current-process membership"),
        );

        match outcome {
            NbdOrphanProbe::Failed(NbdOrphanError::OwnerLiveness {
                device_index,
                owner_tid,
                source,
            }) => {
                assert_eq!(device_index, 3);
                assert_eq!(owner_tid, 123);
                assert_eq!(source.to_string(), "procfs unavailable");
            }
            other => panic!("expected owner liveness failure, got {other:?}"),
        }
    }

    #[test]
    fn probe_reapplies_current_process_and_size_policy() {
        let candidate = local_or_dead_candidate(3, 123, 8);
        let local = probe_with(
            candidate,
            |_| Ok(Some(())),
            |_, _| Some(state(123, Some(16))),
            |_| panic!("current-process owner must short-circuit liveness"),
            |_| true,
        );
        assert!(
            matches!(local, NbdOrphanProbe::Orphan(current) if current.size_sectors() == Some(16))
        );

        let zero_size = probe_with(
            candidate,
            |_| Ok(Some(())),
            |_, _| Some(state(123, Some(0))),
            |_| panic!("zero size must be rejected before liveness"),
            |_| panic!("zero size must be rejected before membership"),
        );
        assert!(matches!(zero_size, NbdOrphanProbe::Changed));
    }

    #[test]
    fn probe_holds_claim_through_revalidation() {
        let dropped = Rc::new(Cell::new(false));
        let dropped_for_claim = dropped.clone();
        let dropped_for_read = dropped.clone();
        let dropped_for_owner = dropped.clone();
        let outcome = probe_with(
            NbdOrphanCandidate::from_dead_owner_observation(3, 123),
            |_| Ok(Some(DropGuard(dropped_for_claim))),
            |_, _| {
                assert!(!dropped_for_read.get());
                Some(state(123, None))
            },
            |_| {
                assert!(!dropped_for_owner.get());
                Ok(false)
            },
            |_| panic!("dead-owner policy must not inspect current-process membership"),
        );
        assert!(matches!(outcome, NbdOrphanProbe::Orphan(_)));
        assert!(dropped.get());
    }

    #[test]
    fn disconnect_reports_locked_and_claim_failure_without_netlink() {
        let candidate = NbdOrphanCandidate::from_dead_owner_observation(3, 123);
        let locked = disconnect_with(
            candidate,
            |_| Ok::<Option<()>, std::io::Error>(None),
            |_, _| panic!("locked candidate must not be re-read"),
            |_| panic!("locked candidate must not check liveness"),
            |_| panic!("locked candidate must not check membership"),
            |_| panic!("locked candidate must not be disconnected"),
        );
        assert!(matches!(locked, NbdOrphanDisconnect::Locked));

        let failed = disconnect_with(
            candidate,
            |_| Err::<Option<()>, std::io::Error>(std::io::Error::other("boom")),
            |_, _| panic!("failed claim must not be re-read"),
            |_| panic!("failed claim must not check liveness"),
            |_| panic!("failed claim must not check membership"),
            |_| panic!("failed claim must not disconnect"),
        );
        match failed {
            NbdOrphanDisconnect::Failed(NbdOrphanError::Claim {
                device_index,
                source,
            }) => {
                assert_eq!(device_index, 3);
                assert_eq!(source.to_string(), "boom");
            }
            other => panic!("expected claim failure, got {other:?}"),
        }
    }

    #[test]
    fn disconnect_reports_changed_without_netlink_when_state_changes_or_clears() {
        let candidate = NbdOrphanCandidate::from_dead_owner_observation(3, 123);
        let changed = disconnect_with(
            candidate,
            |_| Ok(Some(())),
            |_, _| Some(state(456, None)),
            |_| panic!("changed owner must not check liveness"),
            |_| panic!("changed owner must not check membership"),
            |_| panic!("changed owner must not be disconnected"),
        );
        assert!(matches!(changed, NbdOrphanDisconnect::Changed));

        let cleared = disconnect_with(
            candidate,
            |_| Ok(Some(())),
            |_, _| None,
            |_| panic!("cleared owner must not check liveness"),
            |_| panic!("cleared owner must not check membership"),
            |_| panic!("cleared owner must not be disconnected"),
        );
        assert!(matches!(cleared, NbdOrphanDisconnect::Changed));
    }

    #[test]
    fn disconnect_reports_changed_without_netlink_when_size_becomes_zero() {
        let outcome = disconnect_with(
            local_or_dead_candidate(3, 123, 8),
            |_| Ok(Some(())),
            |_, _| Some(state(123, Some(0))),
            |_| panic!("zero size must be rejected before liveness"),
            |_| panic!("zero size must be rejected before membership"),
            |_| panic!("zero-size candidate must not be disconnected"),
        );
        assert!(matches!(outcome, NbdOrphanDisconnect::Changed));
    }

    #[test]
    fn disconnect_reports_live_without_netlink_when_dead_owner_revives() {
        let outcome = disconnect_with(
            NbdOrphanCandidate::from_dead_owner_observation(3, 123),
            |_| Ok(Some(())),
            |_, _| Some(state(123, None)),
            |_| Ok(true),
            |_| panic!("dead-owner policy must not inspect current-process membership"),
            |_| panic!("live owner must not be disconnected"),
        );
        assert!(matches!(outcome, NbdOrphanDisconnect::Live));
    }

    #[test]
    fn disconnect_reports_owner_liveness_failures_without_netlink() {
        for candidate in [
            NbdOrphanCandidate::from_dead_owner_observation(3, 123),
            local_or_dead_candidate(3, 123, 8),
        ] {
            let outcome = disconnect_with(
                candidate,
                |_| Ok(Some(())),
                |_, policy| match policy {
                    NbdOrphanPolicy::DeadOwner => Some(state(123, None)),
                    NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize => {
                        Some(state(123, Some(8)))
                    }
                },
                |_| Err(std::io::Error::other("procfs unavailable")),
                |_| false,
                |_| panic!("uncertain owner must not be disconnected"),
            );

            match outcome {
                NbdOrphanDisconnect::Failed(NbdOrphanError::OwnerLiveness {
                    device_index,
                    owner_tid,
                    source,
                }) => {
                    assert_eq!(device_index, 3);
                    assert_eq!(owner_tid, 123);
                    assert_eq!(source.to_string(), "procfs unavailable");
                }
                other => panic!(
                    "expected owner liveness failure for {:?}, got {other:?}",
                    candidate.policy
                ),
            }
        }
    }

    #[test]
    fn disconnect_holds_claim_through_netlink_and_returns_revalidated_state() {
        let dropped = Rc::new(Cell::new(false));
        let dropped_for_claim = dropped.clone();
        let dropped_for_disconnect = dropped.clone();
        let outcome = disconnect_with(
            local_or_dead_candidate(3, 123, 8),
            |_| Ok(Some(DropGuard(dropped_for_claim))),
            |_, _| Some(state(123, Some(16))),
            |_| Ok(false),
            |_| false,
            |_| {
                assert!(!dropped_for_disconnect.get());
                Ok(())
            },
        );
        assert!(
            matches!(outcome, NbdOrphanDisconnect::Disconnected(current) if current.size_sectors() == Some(16))
        );
        assert!(dropped.get());
    }

    #[test]
    fn disconnect_returns_sourced_netlink_failure() {
        let outcome = disconnect_with(
            NbdOrphanCandidate::from_dead_owner_observation(3, 123),
            |_| Ok(Some(())),
            |_, _| Some(state(123, None)),
            |_| Ok(false),
            |_| panic!("dead-owner policy must not inspect current-process membership"),
            |_| Err(NbdCowError::Io(std::io::Error::other("netlink failed"))),
        );
        match outcome {
            NbdOrphanDisconnect::Failed(NbdOrphanError::Disconnect {
                device_index,
                source,
            }) => {
                assert_eq!(device_index, 3);
                assert!(source.to_string().contains("netlink failed"));
            }
            other => panic!("expected disconnect failure, got {other:?}"),
        }
    }
}
