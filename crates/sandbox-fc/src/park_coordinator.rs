//! Host-side park gate for same-session idle park.
//!
//! #13274 lands the state machine before #13275 routes production guest
//! operations through it. Keep this module internal until those call sites
//! consume the coordinator directly.
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
            inner.state = CoordinatorState::Dirty {
                reason: reason.clone(),
            };
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
        let evidence = hook(attempt).await;
        self.complete_prepare_park(&attempt, evidence)
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
        self.inner().state = CoordinatorState::Dirty { reason };
    }

    pub(crate) fn poison_unresolved_operations(&self, reason: DirtyReason) -> bool {
        let mut inner = self.inner();
        if inner.operations.is_empty() {
            return false;
        }

        for entry in inner.operations.values_mut() {
            if entry.liveness != OperationLiveness::Terminal {
                entry.liveness = OperationLiveness::Poisoned;
            }
        }
        inner.state = CoordinatorState::Dirty { reason };
        true
    }

    pub(crate) fn active_operation_count(&self) -> usize {
        self.inner()
            .operations
            .values()
            .filter(|entry| entry.liveness.blocks_park())
            .count()
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        inner.state = CoordinatorState::Dirty { reason };
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
                inner.state = CoordinatorState::Dirty {
                    reason: DirtyReason::new(format!(
                        "operation {} dropped after possible guest write",
                        self.id.0
                    )),
                };
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

impl Inner {
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
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

    #[test]
    fn initial_state_is_open() {
        let coordinator = ParkCoordinator::new();

        assert_eq!(coordinator.state(), CoordinatorState::Open);
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
}
