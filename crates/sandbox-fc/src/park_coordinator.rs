//! Host-side park gate for same-session idle park.
//!
//! #13274 lands the state machine before #13275 routes production guest
//! operations through it. Keep this module internal until those call sites
//! consume the coordinator directly.
//!
//! Invariants:
//! - A `Poisoned` operation keeps the coordinator `Dirty`; dirty sandboxes are
//!   destroy-only and cannot re-enter the park lifecycle.
//! - `ReadyForPark` means the host gate is closed and no operation that could
//!   write to the guest is unresolved.
//! - Coordinator locks are never held across `.await`.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Debug)]
pub(crate) struct ParkCoordinator {
    inner: Arc<Mutex<Inner>>,
}

impl ParkCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: CoordinatorState::Open,
                next_operation_id: 1,
                next_attempt_id: 1,
                operations: BTreeMap::new(),
            })),
        }
    }

    pub(crate) fn state(&self) -> CoordinatorState {
        self.inner().state.clone()
    }

    pub(crate) fn reserve_operation(&self) -> Result<OperationLease, LeaseRejection> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::Open => {
                let id = OperationId(inner.next_operation_id);
                inner.next_operation_id += 1;
                inner.operations.insert(
                    id,
                    OperationEntry {
                        liveness: OperationLiveness::Reserved,
                    },
                );
                Ok(OperationLease {
                    id,
                    inner: Arc::clone(&self.inner),
                    released: false,
                })
            }
            state => Err(LeaseRejection::GateClosed { state }),
        }
    }

    pub(crate) fn begin_prepare_park(&self) -> Result<ParkAttempt, PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::Open => {}
            CoordinatorState::Dirty { reason } => {
                return Err(PrepareParkError::Dirty { reason });
            }
            state => {
                return Err(PrepareParkError::InvalidState { state });
            }
        }

        let attempt_id = ParkAttemptId(inner.next_attempt_id);
        inner.next_attempt_id += 1;
        inner.state = CoordinatorState::ClosingForPark { attempt_id };

        if let Some(reason) = inner.poisoned_reason() {
            inner.mark_dirty(reason.clone());
            return Err(PrepareParkError::Dirty { reason });
        }

        if inner.has_active_operations() {
            inner.state = CoordinatorState::Open;
            return Err(PrepareParkError::Busy);
        }

        Ok(ParkAttempt { id: attempt_id })
    }

    pub(crate) fn complete_prepare_park(
        &self,
        attempt: &ParkAttempt,
        evidence: PrepareParkEvidence,
    ) -> Result<(), PrepareParkError> {
        let PrepareParkEvidence::AgentQuiesced = evidence;

        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == attempt.id => {
                inner.state = CoordinatorState::ReadyForPark { attempt_id };
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::StaleAttempt {
                attempt_id: attempt.id,
                state,
            }),
        }
    }

    pub(crate) fn abort_prepare_park(&self, attempt: &ParkAttempt) -> Result<(), PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == attempt.id => {
                inner.state = CoordinatorState::Open;
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::StaleAttempt {
                attempt_id: attempt.id,
                state,
            }),
        }
    }

    pub(crate) async fn prepare_park_with<F, Fut>(&self, hook: F) -> Result<(), PrepareParkError>
    where
        F: FnOnce(ParkAttempt) -> Fut,
        Fut: Future<Output = PrepareParkEvidence>,
    {
        let attempt = self.begin_prepare_park()?;
        let abort_on_drop = ParkAttemptDropGuard::new(Arc::clone(&self.inner), attempt);
        let evidence = hook(attempt).await;
        let result = self.complete_prepare_park(&attempt, evidence);
        abort_on_drop.disarm();
        result
    }

    pub(crate) fn mark_parked(&self, attempt: &ParkAttempt) -> Result<(), PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::ReadyForPark { attempt_id } if attempt_id == attempt.id => {
                inner.state = CoordinatorState::Parked;
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::InvalidState { state }),
        }
    }

    pub(crate) fn reopen_after_unpark(&self) -> Result<(), PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::Parked => {
                inner.state = CoordinatorState::Open;
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::InvalidState { state }),
        }
    }

    pub(crate) fn mark_dirty(&self, reason: DirtyReason) {
        self.inner().mark_dirty(reason);
    }

    pub(crate) fn poison_unresolved_operations(&self, reason: DirtyReason) -> bool {
        let mut inner = self.inner();
        let mut poisoned = false;

        for entry in inner.operations.values_mut() {
            if entry.liveness.blocks_park() {
                entry.liveness = OperationLiveness::Poisoned;
                poisoned = true;
            }
        }
        if poisoned {
            inner.mark_dirty(reason);
        }
        poisoned
    }

    pub(crate) fn active_operation_count(&self) -> usize {
        self.inner()
            .operations
            .values()
            .filter(|entry| entry.liveness.blocks_park())
            .count()
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        lock_inner(&self.inner)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CoordinatorState {
    Open,
    ClosingForPark { attempt_id: ParkAttemptId },
    ReadyForPark { attempt_id: ParkAttemptId },
    Parked,
    Dirty { reason: DirtyReason },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirtyReason {
    message: String,
}

impl DirtyReason {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DirtyReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct OperationId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OperationLiveness {
    Reserved,
    Writing,
    InGuest,
    Cancelling,
    Terminal,
    Poisoned,
}

impl OperationLiveness {
    fn blocks_park(self) -> bool {
        matches!(
            self,
            Self::Reserved | Self::Writing | Self::InGuest | Self::Cancelling
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParkAttemptId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParkAttempt {
    id: ParkAttemptId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrepareParkEvidence {
    AgentQuiesced,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LeaseRejection {
    GateClosed { state: CoordinatorState },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PrepareParkError {
    Busy,
    Dirty {
        reason: DirtyReason,
    },
    InvalidState {
        state: CoordinatorState,
    },
    StaleAttempt {
        attempt_id: ParkAttemptId,
        state: CoordinatorState,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OperationTransitionError {
    UnknownOperation {
        operation_id: OperationId,
    },
    InvalidTransition {
        operation_id: OperationId,
        from: OperationLiveness,
        to: OperationLiveness,
    },
}

#[derive(Debug)]
pub(crate) struct OperationLease {
    id: OperationId,
    inner: Arc<Mutex<Inner>>,
    released: bool,
}

impl OperationLease {
    pub(crate) fn id(&self) -> OperationId {
        self.id
    }

    pub(crate) fn mark_writing(&mut self) -> Result<(), OperationTransitionError> {
        self.transition(OperationLiveness::Writing)
    }

    pub(crate) fn mark_in_guest(&mut self) -> Result<(), OperationTransitionError> {
        self.transition(OperationLiveness::InGuest)
    }

    pub(crate) fn mark_cancelling(&mut self) -> Result<(), OperationTransitionError> {
        self.transition(OperationLiveness::Cancelling)
    }

    pub(crate) fn complete(mut self) -> Result<(), OperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(entry) = inner.operations.get_mut(&self.id) else {
            return Err(OperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };

        if !can_transition(entry.liveness, OperationLiveness::Terminal) {
            return Err(OperationTransitionError::InvalidTransition {
                operation_id: self.id,
                from: entry.liveness,
                to: OperationLiveness::Terminal,
            });
        }

        entry.liveness = OperationLiveness::Terminal;
        inner.operations.remove(&self.id);
        self.released = true;
        Ok(())
    }

    pub(crate) fn poison(mut self, reason: DirtyReason) -> Result<(), OperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(entry) = inner.operations.get_mut(&self.id) else {
            return Err(OperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };

        if !can_transition(entry.liveness, OperationLiveness::Poisoned) {
            return Err(OperationTransitionError::InvalidTransition {
                operation_id: self.id,
                from: entry.liveness,
                to: OperationLiveness::Poisoned,
            });
        }

        entry.liveness = OperationLiveness::Poisoned;
        inner.mark_dirty(reason);
        self.released = true;
        Ok(())
    }

    fn transition(&mut self, to: OperationLiveness) -> Result<(), OperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(entry) = inner.operations.get_mut(&self.id) else {
            return Err(OperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };

        if !can_transition(entry.liveness, to) {
            return Err(OperationTransitionError::InvalidTransition {
                operation_id: self.id,
                from: entry.liveness,
                to,
            });
        }

        entry.liveness = to;
        Ok(())
    }
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        let mut inner = lock_inner(&self.inner);
        let Some(liveness) = inner.operations.get(&self.id).map(|entry| entry.liveness) else {
            return;
        };

        match liveness {
            OperationLiveness::Reserved => {
                inner.operations.remove(&self.id);
            }
            OperationLiveness::Writing
            | OperationLiveness::InGuest
            | OperationLiveness::Cancelling => {
                if let Some(entry) = inner.operations.get_mut(&self.id) {
                    entry.liveness = OperationLiveness::Poisoned;
                }
                inner.mark_dirty(DirtyReason::new(format!(
                    "operation {} dropped after possible guest write",
                    self.id.0
                )));
            }
            OperationLiveness::Terminal | OperationLiveness::Poisoned => {}
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct OperationEntry {
    liveness: OperationLiveness,
}

#[derive(Debug)]
struct Inner {
    state: CoordinatorState,
    next_operation_id: u64,
    next_attempt_id: u64,
    operations: BTreeMap<OperationId, OperationEntry>,
}

struct ParkAttemptDropGuard {
    inner: Arc<Mutex<Inner>>,
    attempt: ParkAttempt,
    armed: bool,
}

impl ParkAttemptDropGuard {
    fn new(inner: Arc<Mutex<Inner>>, attempt: ParkAttempt) -> Self {
        Self {
            inner,
            attempt,
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for ParkAttemptDropGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        let mut inner = lock_inner(&self.inner);
        if matches!(
            inner.state,
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == self.attempt.id
        ) {
            inner.state = CoordinatorState::Open;
        }
    }
}

impl Inner {
    fn mark_dirty(&mut self, reason: DirtyReason) {
        if matches!(self.state, CoordinatorState::Dirty { .. }) {
            return;
        }

        self.state = CoordinatorState::Dirty { reason };
    }

    fn has_active_operations(&self) -> bool {
        self.operations
            .values()
            .any(|entry| entry.liveness.blocks_park())
    }

    fn poisoned_reason(&self) -> Option<DirtyReason> {
        self.operations
            .iter()
            .find(|(_, entry)| entry.liveness == OperationLiveness::Poisoned)
            .map(|(id, _)| DirtyReason::new(format!("operation {} poisoned", id.0)))
    }
}

fn can_transition(from: OperationLiveness, to: OperationLiveness) -> bool {
    matches!(
        (from, to),
        (OperationLiveness::Reserved, OperationLiveness::Writing)
            | (OperationLiveness::Reserved, OperationLiveness::Poisoned)
            | (OperationLiveness::Writing, OperationLiveness::InGuest)
            | (OperationLiveness::Writing, OperationLiveness::Cancelling)
            | (OperationLiveness::Writing, OperationLiveness::Terminal)
            | (OperationLiveness::Writing, OperationLiveness::Poisoned)
            | (OperationLiveness::InGuest, OperationLiveness::Cancelling)
            | (OperationLiveness::InGuest, OperationLiveness::Terminal)
            | (OperationLiveness::InGuest, OperationLiveness::Poisoned)
            | (OperationLiveness::Cancelling, OperationLiveness::Terminal)
            | (OperationLiveness::Cancelling, OperationLiveness::Poisoned)
    )
}

fn lock_inner(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    match inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.mark_dirty(DirtyReason::new("park coordinator mutex poisoned"));
            guard
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin_attempt(coordinator: &ParkCoordinator) -> ParkAttempt {
        match coordinator.begin_prepare_park() {
            Ok(attempt) => attempt,
            Err(error) => panic!("begin prepare failed: {error:?}"),
        }
    }

    fn complete_attempt(coordinator: &ParkCoordinator, attempt: &ParkAttempt) {
        if let Err(error) =
            coordinator.complete_prepare_park(attempt, PrepareParkEvidence::AgentQuiesced)
        {
            panic!("complete prepare failed: {error:?}");
        }
    }

    fn assert_dirty_state(coordinator: &ParkCoordinator) {
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::Dirty { .. }
        ));
    }

    fn dirty_reason(coordinator: &ParkCoordinator) -> DirtyReason {
        match coordinator.state() {
            CoordinatorState::Dirty { reason } => reason,
            state => panic!("expected dirty state, got {state:?}"),
        }
    }

    fn operation_registry_len(coordinator: &ParkCoordinator) -> usize {
        coordinator.inner().operations.len()
    }

    #[test]
    fn initial_state_is_open() {
        let coordinator = ParkCoordinator::new();

        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn poisoned_mutex_marks_coordinator_dirty() {
        let coordinator = ParkCoordinator::new();
        let poisoned_coordinator = coordinator.clone();

        let join_result = std::thread::spawn(move || {
            let _guard = poisoned_coordinator.inner();
            panic!("poison coordinator lock");
        })
        .join();

        assert!(join_result.is_err());
        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("park coordinator mutex poisoned")
        );
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::Dirty { .. }
            })
        ));
    }

    #[test]
    fn reservations_succeed_only_when_open() {
        let coordinator = ParkCoordinator::new();
        let lease = coordinator.reserve_operation();
        assert!(lease.is_ok());
        drop(lease);

        let attempt = begin_attempt(&coordinator);
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));

        complete_attempt(&coordinator, &attempt);
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::ReadyForPark { .. }
            })
        ));

        assert!(coordinator.mark_parked(&attempt).is_ok());
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::Parked
            })
        ));

        coordinator.mark_dirty(DirtyReason::new("test dirty"));
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::Dirty { .. }
            })
        ));
    }

    #[test]
    fn dropping_reserved_lease_releases_without_dirtying() {
        let coordinator = ParkCoordinator::new();
        let lease = coordinator.reserve_operation();
        assert!(lease.is_ok());
        assert_eq!(coordinator.active_operation_count(), 1);

        drop(lease);

        assert_eq!(coordinator.active_operation_count(), 0);
        assert_eq!(operation_registry_len(&coordinator), 0);
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn completed_operations_are_removed_from_registry() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert_eq!(operation_registry_len(&coordinator), 1);

        assert!(lease.mark_writing().is_ok());
        assert!(lease.mark_in_guest().is_ok());
        assert!(lease.complete().is_ok());

        assert_eq!(coordinator.active_operation_count(), 0);
        assert_eq!(operation_registry_len(&coordinator), 0);
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn failed_reserved_complete_releases_without_dirtying() {
        let coordinator = ParkCoordinator::new();
        let lease = coordinator.reserve_operation().expect("reserve operation");
        assert_eq!(operation_registry_len(&coordinator), 1);

        assert!(matches!(
            lease.complete(),
            Err(OperationTransitionError::InvalidTransition {
                from: OperationLiveness::Reserved,
                to: OperationLiveness::Terminal,
                ..
            })
        ));

        assert_eq!(coordinator.active_operation_count(), 0);
        assert_eq!(operation_registry_len(&coordinator), 0);
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn dropping_after_possible_write_marks_dirty() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator
            .reserve_operation()
            .expect("reserve operation before possible write");
        assert!(lease.mark_writing().is_ok());

        drop(lease);

        assert_dirty_state(&coordinator);
        assert!(matches!(
            coordinator.begin_prepare_park(),
            Err(PrepareParkError::Dirty { .. })
        ));
    }

    #[test]
    fn dropping_in_guest_or_cancelling_operation_marks_dirty() {
        for enter_cancelling in [false, true] {
            let coordinator = ParkCoordinator::new();
            let mut lease = coordinator
                .reserve_operation()
                .expect("reserve operation before possible write");

            assert!(lease.mark_writing().is_ok());
            assert!(lease.mark_in_guest().is_ok());
            if enter_cancelling {
                assert!(lease.mark_cancelling().is_ok());
            }

            drop(lease);

            assert_dirty_state(&coordinator);
            assert_eq!(operation_registry_len(&coordinator), 1);
        }
    }

    #[test]
    fn active_operation_returns_busy_and_reopens_gate() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert!(lease.mark_writing().is_ok());

        assert_eq!(
            coordinator.begin_prepare_park(),
            Err(PrepareParkError::Busy)
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert!(coordinator.reserve_operation().is_ok());

        assert!(lease.complete().is_ok());
    }

    #[test]
    fn reserved_operation_returns_busy() {
        let coordinator = ParkCoordinator::new();
        let lease = coordinator.reserve_operation().expect("reserve operation");

        assert_eq!(
            coordinator.begin_prepare_park(),
            Err(PrepareParkError::Busy)
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);

        drop(lease);
    }

    #[test]
    fn cancelling_operation_returns_busy_without_dirtying() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert!(lease.mark_writing().is_ok());
        assert!(lease.mark_in_guest().is_ok());
        assert!(lease.mark_cancelling().is_ok());

        assert_eq!(
            coordinator.begin_prepare_park(),
            Err(PrepareParkError::Busy)
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);

        assert!(lease.complete().is_ok());
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn poison_marks_dirty_permanently() {
        let coordinator = ParkCoordinator::new();
        let lease = coordinator.reserve_operation().expect("reserve operation");

        assert!(
            lease
                .poison(DirtyReason::new("transport uncertain"))
                .is_ok()
        );
        assert_dirty_state(&coordinator);
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::Dirty { .. }
            })
        ));
        assert!(matches!(
            coordinator.begin_prepare_park(),
            Err(PrepareParkError::Dirty { .. })
        ));
    }

    #[test]
    fn driver_shutdown_poisons_unresolved_operations() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert!(lease.mark_writing().is_ok());

        assert!(coordinator.poison_unresolved_operations(DirtyReason::new("driver shutdown")));

        assert_dirty_state(&coordinator);
        drop(lease);
        assert_dirty_state(&coordinator);
    }

    #[test]
    fn driver_shutdown_poison_is_idempotent() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert!(lease.mark_writing().is_ok());

        assert!(coordinator.poison_unresolved_operations(DirtyReason::new("driver shutdown")));
        assert!(!coordinator.poison_unresolved_operations(DirtyReason::new("second shutdown")));

        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("driver shutdown")
        );
        drop(lease);
        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("driver shutdown")
        );
    }

    #[test]
    fn driver_shutdown_without_unresolved_operations_does_not_dirty() {
        let coordinator = ParkCoordinator::new();

        assert!(!coordinator.poison_unresolved_operations(DirtyReason::new("driver shutdown")));
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn first_dirty_reason_is_preserved() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert!(lease.mark_writing().is_ok());

        coordinator.mark_dirty(DirtyReason::new("first cause"));
        drop(lease);

        assert_eq!(dirty_reason(&coordinator), DirtyReason::new("first cause"));
    }

    #[test]
    fn successful_prepare_moves_to_ready_for_park() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);

        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { .. }
        ));

        complete_attempt(&coordinator, &attempt);

        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { .. }
        ));
    }

    #[test]
    fn ready_can_mark_parked_and_reopen() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);

        assert!(coordinator.mark_parked(&attempt).is_ok());
        assert_eq!(coordinator.state(), CoordinatorState::Parked);

        assert!(coordinator.reopen_after_unpark().is_ok());
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn dirty_ready_or_parked_sandbox_cannot_continue_park_lifecycle() {
        let ready_coordinator = ParkCoordinator::new();
        let ready_attempt = begin_attempt(&ready_coordinator);
        complete_attempt(&ready_coordinator, &ready_attempt);

        ready_coordinator.mark_dirty(DirtyReason::new("post-prepare failure"));
        assert_eq!(
            ready_coordinator.mark_parked(&ready_attempt),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("post-prepare failure")
            })
        );

        let parked_coordinator = ParkCoordinator::new();
        let parked_attempt = begin_attempt(&parked_coordinator);
        complete_attempt(&parked_coordinator, &parked_attempt);
        assert!(parked_coordinator.mark_parked(&parked_attempt).is_ok());

        parked_coordinator.mark_dirty(DirtyReason::new("unpark unsafe"));
        assert_eq!(
            parked_coordinator.reopen_after_unpark(),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("unpark unsafe")
            })
        );
    }

    #[test]
    fn invalid_ready_and_parked_transitions_fail() {
        let coordinator = ParkCoordinator::new();
        let attempt = ParkAttempt {
            id: ParkAttemptId(999),
        };

        assert!(matches!(
            coordinator.mark_parked(&attempt),
            Err(PrepareParkError::InvalidState {
                state: CoordinatorState::Open
            })
        ));
        assert!(matches!(
            coordinator.reopen_after_unpark(),
            Err(PrepareParkError::InvalidState {
                state: CoordinatorState::Open
            })
        ));
    }

    #[test]
    fn stale_attempt_cannot_enter_ready() {
        let coordinator = ParkCoordinator::new();
        let stale = begin_attempt(&coordinator);
        assert!(coordinator.abort_prepare_park(&stale).is_ok());

        let current = begin_attempt(&coordinator);
        assert!(matches!(
            coordinator.complete_prepare_park(&stale, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::StaleAttempt { .. })
        ));
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == current.id
        ));
    }

    #[test]
    fn dirty_during_prepare_blocks_completion_and_abort() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);

        coordinator.mark_dirty(DirtyReason::new("driver shutdown"));

        assert_eq!(
            coordinator.complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("driver shutdown")
            })
        );
        assert_eq!(
            coordinator.abort_prepare_park(&attempt),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("driver shutdown")
            })
        );
        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("driver shutdown")
        );
    }

    #[test]
    fn operation_transitions_are_validated() {
        let coordinator = ParkCoordinator::new();
        let mut lease = coordinator.reserve_operation().expect("reserve operation");
        assert_eq!(lease.id(), OperationId(1));

        assert!(matches!(
            lease.mark_in_guest(),
            Err(OperationTransitionError::InvalidTransition {
                from: OperationLiveness::Reserved,
                to: OperationLiveness::InGuest,
                ..
            })
        ));
        assert!(lease.mark_writing().is_ok());
        assert!(lease.mark_in_guest().is_ok());
        assert!(lease.complete().is_ok());
    }

    #[tokio::test]
    async fn async_prepare_hook_runs_without_holding_coordinator_lock() {
        let coordinator = ParkCoordinator::new();
        let observed = coordinator.clone();

        let result = coordinator
            .prepare_park_with(|_| async move {
                assert!(matches!(
                    observed.reserve_operation(),
                    Err(LeaseRejection::GateClosed {
                        state: CoordinatorState::ClosingForPark { .. }
                    })
                ));
                PrepareParkEvidence::AgentQuiesced
            })
            .await;

        assert!(result.is_ok());
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { .. }
        ));
    }

    #[tokio::test]
    async fn successful_prepare_releases_attempt_guard_reference() {
        let coordinator = ParkCoordinator::new();
        assert_eq!(std::sync::Arc::strong_count(&coordinator.inner), 1);

        let result = coordinator
            .prepare_park_with(|_| async { PrepareParkEvidence::AgentQuiesced })
            .await;

        assert!(result.is_ok());
        assert_eq!(std::sync::Arc::strong_count(&coordinator.inner), 1);
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { .. }
        ));
    }

    #[tokio::test]
    async fn dropped_prepare_future_reopens_gate_and_stales_attempt() {
        let coordinator = ParkCoordinator::new();
        let worker_coordinator = coordinator.clone();
        let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();

        let task = tokio::spawn(async move {
            worker_coordinator
                .prepare_park_with(|attempt| async move {
                    let _ = attempt_tx.send(attempt);
                    std::future::pending::<PrepareParkEvidence>().await
                })
                .await
        });

        let stale_attempt = attempt_rx
            .await
            .expect("prepare hook should receive an attempt");
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { .. }
        ));

        task.abort();
        let join_error = task.await.expect_err("prepare task should be aborted");
        assert!(join_error.is_cancelled());

        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert!(coordinator.reserve_operation().is_ok());
        assert_eq!(std::sync::Arc::strong_count(&coordinator.inner), 1);
        assert!(matches!(
            coordinator.complete_prepare_park(&stale_attempt, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::StaleAttempt {
                state: CoordinatorState::Open,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn dropped_prepare_future_does_not_reopen_dirty_gate() {
        let coordinator = ParkCoordinator::new();
        let worker_coordinator = coordinator.clone();
        let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();

        let task = tokio::spawn(async move {
            worker_coordinator
                .prepare_park_with(|attempt| async move {
                    let _ = attempt_tx.send(attempt);
                    std::future::pending::<PrepareParkEvidence>().await
                })
                .await
        });

        let _attempt = attempt_rx
            .await
            .expect("prepare hook should receive an attempt");
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { .. }
        ));

        coordinator.mark_dirty(DirtyReason::new("driver shutdown"));
        task.abort();
        let join_error = task.await.expect_err("prepare task should be aborted");
        assert!(join_error.is_cancelled());

        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("driver shutdown")
        );
        assert_eq!(std::sync::Arc::strong_count(&coordinator.inner), 1);
        assert!(matches!(
            coordinator.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::Dirty { .. }
            })
        ));
    }

    #[test]
    fn concurrent_prepare_and_reserve_are_linearized() {
        for _ in 0..64 {
            let coordinator = ParkCoordinator::new();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

            let prepare_coordinator = coordinator.clone();
            let prepare_barrier = std::sync::Arc::clone(&barrier);
            let prepare_thread = std::thread::spawn(move || {
                prepare_barrier.wait();
                prepare_coordinator.begin_prepare_park()
            });

            let reserve_coordinator = coordinator.clone();
            let reserve_barrier = std::sync::Arc::clone(&barrier);
            let reserve_thread = std::thread::spawn(move || {
                reserve_barrier.wait();
                reserve_coordinator.reserve_operation()
            });

            let prepare_result = prepare_thread
                .join()
                .expect("prepare thread should not panic");
            let reserve_result = reserve_thread
                .join()
                .expect("reserve thread should not panic");

            match (prepare_result, reserve_result) {
                (
                    Ok(attempt),
                    Err(LeaseRejection::GateClosed {
                        state: CoordinatorState::ClosingForPark { .. },
                    }),
                ) => {
                    assert!(coordinator.abort_prepare_park(&attempt).is_ok());
                }
                (Err(PrepareParkError::Busy), Ok(lease)) => {
                    drop(lease);
                }
                other => panic!("unexpected concurrent prepare/reserve result: {other:?}"),
            }

            assert_eq!(coordinator.state(), CoordinatorState::Open);
        }
    }

    #[test]
    fn concurrent_prepare_and_reserved_drop_are_linearized() {
        for _ in 0..64 {
            let coordinator = ParkCoordinator::new();
            let lease = coordinator.reserve_operation().expect("reserve operation");
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

            let prepare_coordinator = coordinator.clone();
            let prepare_barrier = std::sync::Arc::clone(&barrier);
            let prepare_thread = std::thread::spawn(move || {
                prepare_barrier.wait();
                prepare_coordinator.begin_prepare_park()
            });

            let drop_barrier = std::sync::Arc::clone(&barrier);
            let drop_thread = std::thread::spawn(move || {
                drop_barrier.wait();
                drop(lease);
            });

            let prepare_result = prepare_thread
                .join()
                .expect("prepare thread should not panic");
            drop_thread.join().expect("drop thread should not panic");

            match prepare_result {
                Ok(attempt) => {
                    assert!(coordinator.abort_prepare_park(&attempt).is_ok());
                }
                Err(PrepareParkError::Busy) => {}
                other => panic!("unexpected concurrent prepare/drop result: {other:?}"),
            }

            assert_eq!(coordinator.state(), CoordinatorState::Open);
            assert_eq!(coordinator.active_operation_count(), 0);
            assert_eq!(operation_registry_len(&coordinator), 0);
        }
    }

    #[test]
    fn concurrent_prepare_and_possible_guest_write_drop_mark_dirty() {
        for _ in 0..64 {
            let coordinator = ParkCoordinator::new();
            let mut lease = coordinator.reserve_operation().expect("reserve operation");
            assert!(lease.mark_writing().is_ok());
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

            let prepare_coordinator = coordinator.clone();
            let prepare_barrier = std::sync::Arc::clone(&barrier);
            let prepare_thread = std::thread::spawn(move || {
                prepare_barrier.wait();
                prepare_coordinator.begin_prepare_park()
            });

            let drop_barrier = std::sync::Arc::clone(&barrier);
            let drop_thread = std::thread::spawn(move || {
                drop_barrier.wait();
                drop(lease);
            });

            let prepare_result = prepare_thread
                .join()
                .expect("prepare thread should not panic");
            drop_thread.join().expect("drop thread should not panic");

            assert!(matches!(
                prepare_result,
                Err(PrepareParkError::Busy | PrepareParkError::Dirty { .. })
            ));
            assert_dirty_state(&coordinator);
            assert_eq!(coordinator.active_operation_count(), 0);
            assert_eq!(operation_registry_len(&coordinator), 1);
        }
    }

    #[test]
    fn independent_coordinators_do_not_share_state() {
        let first = ParkCoordinator::new();
        let second = ParkCoordinator::new();
        let first_attempt = begin_attempt(&first);

        assert!(matches!(
            first.reserve_operation(),
            Err(LeaseRejection::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));

        let second_lease = second
            .reserve_operation()
            .expect("second coordinator should stay open");
        assert_eq!(second.state(), CoordinatorState::Open);
        drop(second_lease);

        assert!(first.abort_prepare_park(&first_attempt).is_ok());
        assert_eq!(first.state(), CoordinatorState::Open);
    }
}
