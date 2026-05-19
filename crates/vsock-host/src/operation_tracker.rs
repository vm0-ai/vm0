#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "normal operation tracker APIs are introduced before command/file/process callers migrate to them"
    )
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Debug)]
pub(crate) struct NormalOperationTracker {
    inner: Arc<Mutex<Inner>>,
}

impl NormalOperationTracker {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: TrackerState::Open,
                next_operation_id: 1,
                next_fence_id: 1,
                operations: BTreeMap::new(),
            })),
        }
    }

    pub(crate) fn readiness(&self) -> NormalOperationReadiness {
        self.inner().readiness()
    }

    pub(crate) fn reserve(&self) -> Result<NormalOperationToken, NormalOperationRejection> {
        let mut inner = self.inner();
        match inner.state {
            TrackerState::Open => {
                let id = NormalOperationId(inner.next_operation_id);
                inner.next_operation_id += 1;
                inner
                    .operations
                    .insert(id, OperationPhase::ReservedBeforeWrite);
                Ok(NormalOperationToken {
                    id,
                    inner: Arc::clone(&self.inner),
                    released: false,
                })
            }
            TrackerState::Fenced { .. } => Err(NormalOperationRejection::Fenced),
            TrackerState::NotParkable => Err(NormalOperationRejection::NotParkable),
            TrackerState::Closed => Err(NormalOperationRejection::Closed),
        }
    }

    pub(crate) fn try_fence(&self) -> Result<NormalOperationFence, NormalOperationFenceRejection> {
        let mut inner = self.inner();
        match inner.state {
            TrackerState::Open if inner.operations.is_empty() => {
                let id = NormalOperationFenceId(inner.next_fence_id);
                inner.next_fence_id += 1;
                inner.state = TrackerState::Fenced { id };
                Ok(NormalOperationFence {
                    id,
                    inner: Arc::clone(&self.inner),
                })
            }
            TrackerState::Open => Err(NormalOperationFenceRejection::Busy),
            TrackerState::Fenced { .. } => Err(NormalOperationFenceRejection::AlreadyFenced),
            TrackerState::NotParkable => Err(NormalOperationFenceRejection::NotParkable),
            TrackerState::Closed => Err(NormalOperationFenceRejection::Closed),
        }
    }

    pub(crate) fn mark_not_parkable(&self) {
        let mut inner = self.inner();
        inner.state = TrackerState::NotParkable;
        inner.operations.clear();
    }

    pub(crate) fn mark_closed(&self) {
        let mut inner = self.inner();
        if inner
            .operations
            .values()
            .any(|phase| *phase == OperationPhase::PossibleGuestWrite)
        {
            inner.state = TrackerState::NotParkable;
            inner.operations.clear();
            return;
        }
        if matches!(
            inner.state,
            TrackerState::Open | TrackerState::Fenced { .. }
        ) {
            inner.state = TrackerState::Closed;
            inner.operations.clear();
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        lock_inner(&self.inner)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationReadiness {
    Idle,
    Busy,
    Fenced,
    NotParkable,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationRejection {
    Fenced,
    NotParkable,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationFenceRejection {
    Busy,
    AlreadyFenced,
    NotParkable,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationTransitionError {
    UnknownOperation {
        operation_id: NormalOperationId,
    },
    InvalidTransition {
        operation_id: NormalOperationId,
        from: OperationPhase,
        to: OperationPhase,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct NormalOperationId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NormalOperationFenceId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OperationPhase {
    ReservedBeforeWrite,
    PossibleGuestWrite,
    GuestWriteCompleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrackerState {
    Open,
    Fenced { id: NormalOperationFenceId },
    NotParkable,
    Closed,
}

#[derive(Debug)]
struct Inner {
    state: TrackerState,
    next_operation_id: u64,
    next_fence_id: u64,
    operations: BTreeMap<NormalOperationId, OperationPhase>,
}

impl Inner {
    fn readiness(&self) -> NormalOperationReadiness {
        match self.state {
            TrackerState::Open if self.operations.is_empty() => NormalOperationReadiness::Idle,
            TrackerState::Open => NormalOperationReadiness::Busy,
            TrackerState::Fenced { .. } => NormalOperationReadiness::Fenced,
            TrackerState::NotParkable => NormalOperationReadiness::NotParkable,
            TrackerState::Closed => NormalOperationReadiness::Closed,
        }
    }
}

#[derive(Debug)]
pub(crate) struct NormalOperationToken {
    id: NormalOperationId,
    inner: Arc<Mutex<Inner>>,
    released: bool,
}

impl NormalOperationToken {
    pub(crate) fn transition_handle(&self) -> NormalOperationTransitionHandle {
        NormalOperationTransitionHandle {
            id: self.id,
            inner: Arc::clone(&self.inner),
        }
    }

    pub(crate) fn mark_possible_guest_write_started(
        &mut self,
    ) -> Result<(), NormalOperationTransitionError> {
        self.transition_handle().mark_possible_guest_write_started()
    }

    pub(crate) fn complete(mut self) -> Result<(), NormalOperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(_phase) = inner.operations.remove(&self.id) else {
            if matches!(inner.state, TrackerState::NotParkable) {
                // A possible guest write can fail closed and clear all tracked
                // operations before an independent terminal event completes an
                // older token. The connection is already not parkable, so late
                // completion only needs to release this token.
                self.released = true;
                return Ok(());
            }
            return Err(NormalOperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };
        self.released = true;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NormalOperationTransitionHandle {
    id: NormalOperationId,
    inner: Arc<Mutex<Inner>>,
}

impl NormalOperationTransitionHandle {
    pub(crate) fn mark_possible_guest_write_started(
        &self,
    ) -> Result<(), NormalOperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(phase) = inner.operations.get_mut(&self.id) else {
            return Err(NormalOperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };
        match *phase {
            OperationPhase::ReservedBeforeWrite | OperationPhase::GuestWriteCompleted => {
                *phase = OperationPhase::PossibleGuestWrite;
                Ok(())
            }
            OperationPhase::PossibleGuestWrite => {
                Err(NormalOperationTransitionError::InvalidTransition {
                    operation_id: self.id,
                    from: OperationPhase::PossibleGuestWrite,
                    to: OperationPhase::PossibleGuestWrite,
                })
            }
        }
    }

    pub(crate) fn mark_possible_guest_write_completed(
        &self,
    ) -> Result<(), NormalOperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(phase) = inner.operations.get_mut(&self.id) else {
            return Err(NormalOperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };
        match *phase {
            OperationPhase::PossibleGuestWrite => {
                *phase = OperationPhase::GuestWriteCompleted;
                Ok(())
            }
            OperationPhase::ReservedBeforeWrite | OperationPhase::GuestWriteCompleted => {
                Err(NormalOperationTransitionError::InvalidTransition {
                    operation_id: self.id,
                    from: *phase,
                    to: OperationPhase::GuestWriteCompleted,
                })
            }
        }
    }
}

impl Drop for NormalOperationToken {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let mut inner = lock_inner(&self.inner);
        match inner.operations.remove(&self.id) {
            Some(OperationPhase::ReservedBeforeWrite) | None => {}
            Some(OperationPhase::PossibleGuestWrite | OperationPhase::GuestWriteCompleted) => {
                if !matches!(inner.state, TrackerState::Closed) {
                    inner.state = TrackerState::NotParkable;
                    inner.operations.clear();
                }
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct NormalOperationFence {
    id: NormalOperationFenceId,
    inner: Arc<Mutex<Inner>>,
}

impl Drop for NormalOperationFence {
    fn drop(&mut self) {
        let mut inner = lock_inner(&self.inner);
        if matches!(inner.state, TrackerState::Fenced { id } if id == self.id) {
            inner.state = TrackerState::Open;
        }
    }
}

fn lock_inner(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve(tracker: &NormalOperationTracker) -> NormalOperationToken {
        tracker.reserve().expect("operation should reserve")
    }

    fn fence(tracker: &NormalOperationTracker) -> NormalOperationFence {
        tracker.try_fence().expect("tracker should fence")
    }

    #[test]
    fn new_tracker_starts_idle() {
        let tracker = NormalOperationTracker::new();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
    }

    #[test]
    fn reserve_makes_tracker_busy() {
        let tracker = NormalOperationTracker::new();
        let _token = reserve(&tracker);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Busy);
    }

    #[test]
    fn drop_before_possible_guest_write_returns_to_idle() {
        let tracker = NormalOperationTracker::new();
        let token = reserve(&tracker);

        drop(token);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
    }

    #[test]
    fn complete_after_possible_guest_write_returns_to_idle() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        token.complete().expect("operation should complete");

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
    }

    #[test]
    fn drop_after_possible_guest_write_is_not_parkable() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        drop(token);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
        assert!(matches!(
            tracker.reserve(),
            Err(NormalOperationRejection::NotParkable)
        ));
    }

    #[test]
    fn completed_guest_write_remains_busy_until_operation_complete() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        let handle = token.transition_handle();
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        handle
            .mark_possible_guest_write_completed()
            .expect("mark write completed");

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Busy);
        token.complete().expect("operation should complete");
        assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
    }

    #[test]
    fn completed_guest_write_can_start_another_guest_write() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        let handle = token.transition_handle();
        token
            .mark_possible_guest_write_started()
            .expect("mark first write started");
        handle
            .mark_possible_guest_write_completed()
            .expect("mark first write completed");

        token
            .mark_possible_guest_write_started()
            .expect("mark second write started");

        drop(token);
        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn close_after_guest_write_completed_is_closed_not_not_parkable() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        let handle = token.transition_handle();
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");
        handle
            .mark_possible_guest_write_completed()
            .expect("mark write completed");

        tracker.mark_closed();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
        drop(token);
        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    }

    #[test]
    fn drop_after_guest_write_completed_without_complete_is_not_parkable() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        let handle = token.transition_handle();
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");
        handle
            .mark_possible_guest_write_completed()
            .expect("mark write completed");

        drop(token);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn fence_succeeds_only_when_idle() {
        let tracker = NormalOperationTracker::new();
        let token = reserve(&tracker);

        assert!(matches!(
            tracker.try_fence(),
            Err(NormalOperationFenceRejection::Busy)
        ));

        drop(token);
        let _fence = fence(&tracker);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Fenced);
    }

    #[test]
    fn fence_rejects_normal_operation_reservation() {
        let tracker = NormalOperationTracker::new();
        let _fence = fence(&tracker);

        assert!(matches!(
            tracker.reserve(),
            Err(NormalOperationRejection::Fenced)
        ));
    }

    #[test]
    fn second_fence_is_rejected_while_fenced() {
        let tracker = NormalOperationTracker::new();
        let _fence = fence(&tracker);

        assert!(matches!(
            tracker.try_fence(),
            Err(NormalOperationFenceRejection::AlreadyFenced)
        ));
    }

    #[test]
    fn dropping_fence_reopens_tracker() {
        let tracker = NormalOperationTracker::new();
        let fence = fence(&tracker);

        drop(fence);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
        assert!(tracker.reserve().is_ok());
    }

    #[test]
    fn poison_while_fenced_does_not_reopen_on_fence_drop() {
        let tracker = NormalOperationTracker::new();
        let fence = fence(&tracker);

        tracker.mark_not_parkable();
        drop(fence);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
        assert!(matches!(
            tracker.try_fence(),
            Err(NormalOperationFenceRejection::NotParkable)
        ));
    }

    #[test]
    fn close_while_fenced_does_not_reopen_on_fence_drop() {
        let tracker = NormalOperationTracker::new();
        let fence = fence(&tracker);

        tracker.mark_closed();
        drop(fence);

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
        assert!(matches!(
            tracker.try_fence(),
            Err(NormalOperationFenceRejection::Closed)
        ));
    }

    #[test]
    fn close_rejects_future_reservation_and_fencing() {
        let tracker = NormalOperationTracker::new();

        tracker.mark_closed();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
        assert!(matches!(
            tracker.reserve(),
            Err(NormalOperationRejection::Closed)
        ));
        assert!(matches!(
            tracker.try_fence(),
            Err(NormalOperationFenceRejection::Closed)
        ));
    }

    #[test]
    fn close_with_reserved_operation_is_closed() {
        let tracker = NormalOperationTracker::new();
        let token = reserve(&tracker);

        tracker.mark_closed();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
        drop(token);
        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    }

    #[test]
    fn close_with_possible_guest_write_is_not_parkable() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        tracker.mark_closed();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn close_with_mixed_reserved_and_possible_guest_write_is_not_parkable() {
        let tracker = NormalOperationTracker::new();
        let _reserved_token = reserve(&tracker);
        let mut write_token = reserve(&tracker);
        write_token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        tracker.mark_closed();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn not_parkable_state_survives_later_close() {
        let tracker = NormalOperationTracker::new();

        tracker.mark_not_parkable();
        tracker.mark_closed();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn not_parkable_state_overrides_prior_close() {
        let tracker = NormalOperationTracker::new();

        tracker.mark_closed();
        tracker.mark_not_parkable();

        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn second_possible_guest_write_mark_is_invalid_transition() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        let err = token.mark_possible_guest_write_started().unwrap_err();

        assert!(matches!(
            err,
            NormalOperationTransitionError::InvalidTransition {
                from: OperationPhase::PossibleGuestWrite,
                to: OperationPhase::PossibleGuestWrite,
                ..
            }
        ));
        assert_eq!(tracker.readiness(), NormalOperationReadiness::Busy);
    }

    #[test]
    fn complete_after_not_parkable_is_idempotent_and_preserves_state() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);
        token
            .mark_possible_guest_write_started()
            .expect("mark write started");

        tracker.mark_not_parkable();

        token
            .complete()
            .expect("operation completion should release token");
        assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    }

    #[test]
    fn mark_possible_guest_write_after_close_returns_unknown_and_preserves_state() {
        let tracker = NormalOperationTracker::new();
        let mut token = reserve(&tracker);

        tracker.mark_closed();

        let err = token.mark_possible_guest_write_started().unwrap_err();
        assert!(matches!(
            err,
            NormalOperationTransitionError::UnknownOperation { .. }
        ));
        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    }

    #[test]
    fn complete_after_close_returns_unknown_and_preserves_state() {
        let tracker = NormalOperationTracker::new();
        let token = reserve(&tracker);

        tracker.mark_closed();

        let err = token.complete().unwrap_err();
        assert!(matches!(
            err,
            NormalOperationTransitionError::UnknownOperation { .. }
        ));
        assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    }
}
