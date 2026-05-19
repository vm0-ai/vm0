use std::io;
use std::sync::{Arc, Mutex};

use vsock_host::{FrameWriteObserver, VsockHost};

use crate::park_coordinator::{
    CoordinatorState, LeaseRejection, OperationId, OperationLease, OperationLiveness,
    OperationTransitionError, ParkCoordinator,
};
use crate::sandbox::SandboxState;

pub(crate) fn guest_error_is_terminal(error: &std::io::Error, backend_crashed: bool) -> bool {
    if backend_crashed {
        return false;
    }

    !matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::InvalidData
    )
}

#[derive(Clone)]
pub(crate) struct GuestOperationGate {
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    coordinator: ParkCoordinator,
}

impl GuestOperationGate {
    pub(crate) fn new(
        guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
        coordinator: ParkCoordinator,
    ) -> Self {
        Self { guest, coordinator }
    }

    pub(crate) async fn begin_sandbox_operation(
        &self,
        current_state: impl Fn() -> SandboxState,
    ) -> Result<GuestOperation, GuestOperationStartError> {
        if current_state() == SandboxState::Crashed {
            return Err(GuestOperationStartError::BackendCrashed);
        }

        let lease = self.reserve_lease()?;
        let guest = self.guest.lock().await.as_ref().cloned();
        let state = current_state();
        if state == SandboxState::Crashed {
            return Err(GuestOperationStartError::BackendCrashed);
        }

        let Some(guest) = guest else {
            return Err(GuestOperationStartError::NotRunning { state });
        };

        Ok(GuestOperation { guest, lease })
    }

    pub(crate) async fn begin_control_operation(
        &self,
    ) -> Result<GuestOperation, GuestOperationStartError> {
        let lease = self.reserve_lease()?;
        let guest = self.guest.lock().await.as_ref().cloned();
        let Some(guest) = guest else {
            return Err(GuestOperationStartError::NoGuest);
        };

        Ok(GuestOperation { guest, lease })
    }

    fn reserve_lease(&self) -> Result<OperationLease, GuestOperationStartError> {
        self.coordinator
            .reserve_operation()
            .map_err(|error| match error {
                LeaseRejection::GateClosed { state } => {
                    GuestOperationStartError::GateClosed { state }
                }
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GuestOperationStartError {
    BackendCrashed,
    NotRunning { state: SandboxState },
    NoGuest,
    GateClosed { state: CoordinatorState },
}

pub(crate) struct GuestOperation {
    guest: Arc<VsockHost>,
    lease: OperationLease,
}

impl GuestOperation {
    pub(crate) fn guest(&self) -> Arc<VsockHost> {
        Arc::clone(&self.guest)
    }

    pub(crate) fn into_write_boundary(self) -> GuestOperationWriteBoundary {
        GuestOperationWriteBoundary::new(self.lease)
    }
}

pub(crate) struct GuestOperationWriteBoundary {
    state: Arc<Mutex<GuestOperationWriteBoundaryState>>,
}

struct GuestOperationWriteBoundaryState {
    operation_id: OperationId,
    lease: Option<OperationLease>,
    write_started: bool,
}

impl GuestOperationWriteBoundary {
    pub(crate) fn new(lease: OperationLease) -> Self {
        Self {
            state: Arc::new(Mutex::new(GuestOperationWriteBoundaryState {
                operation_id: lease.id(),
                lease: Some(lease),
                write_started: false,
            })),
        }
    }

    pub(crate) fn write_observer(&self) -> FrameWriteObserver {
        let state = Arc::clone(&self.state);
        FrameWriteObserver::new(move || {
            let mut state = lock_write_boundary_state(&state);
            state.record_write_start().map_err(|error| {
                io::Error::other(format!("operation gate write-start transition: {error:?}"))
            })
        })
    }

    pub(crate) fn has_write_started(&self) -> bool {
        lock_write_boundary_state(&self.state).write_started
    }

    pub(crate) fn complete(self) -> Result<(), OperationTransitionError> {
        let mut state = lock_write_boundary_state(&self.state);
        state.complete()
    }

    pub(crate) fn complete_if_write_started(self) -> Result<(), OperationTransitionError> {
        if self.has_write_started() {
            self.complete()
        } else {
            Ok(())
        }
    }

    pub(crate) fn into_in_guest_lease(self) -> Result<OperationLease, OperationTransitionError> {
        let mut state = lock_write_boundary_state(&self.state);
        state.take_in_guest_lease()
    }
}

impl GuestOperationWriteBoundaryState {
    fn record_write_start(&mut self) -> Result<(), OperationTransitionError> {
        if self.write_started {
            return Ok(());
        }

        let Some(lease) = self.lease.as_mut() else {
            return Err(OperationTransitionError::UnknownOperation {
                operation_id: self.operation_id,
            });
        };

        lease.mark_writing()?;
        self.write_started = true;
        Ok(())
    }

    fn take_lease(&mut self) -> Result<OperationLease, OperationTransitionError> {
        self.lease
            .take()
            .ok_or(OperationTransitionError::UnknownOperation {
                operation_id: self.operation_id,
            })
    }

    fn complete(&mut self) -> Result<(), OperationTransitionError> {
        let lease = self.take_lease()?;
        if !self.write_started {
            return Err(OperationTransitionError::InvalidTransition {
                operation_id: self.operation_id,
                from: OperationLiveness::Reserved,
                to: OperationLiveness::Terminal,
            });
        }
        lease.complete()
    }

    fn take_in_guest_lease(&mut self) -> Result<OperationLease, OperationTransitionError> {
        let mut lease = self.take_lease()?;
        if !self.write_started {
            return Err(OperationTransitionError::InvalidTransition {
                operation_id: self.operation_id,
                from: OperationLiveness::Reserved,
                to: OperationLiveness::InGuest,
            });
        }
        lease.mark_in_guest()?;
        Ok(lease)
    }
}

fn lock_write_boundary_state(
    state: &Mutex<GuestOperationWriteBoundaryState>,
) -> std::sync::MutexGuard<'_, GuestOperationWriteBoundaryState> {
    state.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn gate_without_guest() -> (GuestOperationGate, ParkCoordinator) {
        let coordinator = ParkCoordinator::new();
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        (
            GuestOperationGate::new(guest, coordinator.clone()),
            coordinator,
        )
    }

    fn assert_prepare_can_start(coordinator: &ParkCoordinator) {
        let attempt = coordinator
            .begin_prepare_park()
            .expect("operation start failure should not leave an active lease");
        coordinator.abort_prepare_park(&attempt).unwrap();
    }

    fn write_boundary_state(coordinator: &ParkCoordinator) -> GuestOperationWriteBoundaryState {
        let lease = coordinator.reserve_operation().expect("reserve operation");
        GuestOperationWriteBoundaryState {
            operation_id: lease.id(),
            lease: Some(lease),
            write_started: false,
        }
    }

    #[test]
    fn write_boundary_drop_before_write_start_is_clean() {
        let coordinator = ParkCoordinator::new();
        let state = write_boundary_state(&coordinator);

        drop(state);

        assert_eq!(coordinator.active_operation_count(), 0);
        assert_prepare_can_start(&coordinator);
    }

    #[test]
    fn write_boundary_first_write_blocks_park_until_complete() {
        let coordinator = ParkCoordinator::new();
        let mut state = write_boundary_state(&coordinator);

        state.record_write_start().expect("record write start");

        assert!(state.write_started);
        assert_eq!(coordinator.active_operation_count(), 1);
        assert!(matches!(
            coordinator.begin_prepare_park(),
            Err(crate::park_coordinator::PrepareParkError::Busy)
        ));

        state.complete().expect("complete operation");
        assert_prepare_can_start(&coordinator);
    }

    #[test]
    fn write_boundary_repeated_write_start_is_idempotent() {
        let coordinator = ParkCoordinator::new();
        let mut state = write_boundary_state(&coordinator);

        state.record_write_start().expect("first write start");
        state.record_write_start().expect("second write start");

        state.complete().expect("complete operation");
        assert_prepare_can_start(&coordinator);
    }

    #[test]
    fn write_boundary_completion_before_write_start_is_rejected_cleanly() {
        let coordinator = ParkCoordinator::new();
        let mut state = write_boundary_state(&coordinator);

        assert!(matches!(
            state.complete(),
            Err(OperationTransitionError::InvalidTransition {
                from: OperationLiveness::Reserved,
                to: OperationLiveness::Terminal,
                ..
            })
        ));

        assert_eq!(coordinator.active_operation_count(), 0);
        assert_prepare_can_start(&coordinator);
    }

    #[test]
    fn write_boundary_in_guest_requires_write_start() {
        let coordinator = ParkCoordinator::new();
        let mut state = write_boundary_state(&coordinator);

        assert!(matches!(
            state.take_in_guest_lease(),
            Err(OperationTransitionError::InvalidTransition {
                from: OperationLiveness::Reserved,
                to: OperationLiveness::InGuest,
                ..
            })
        ));

        assert_eq!(coordinator.active_operation_count(), 0);
        assert_prepare_can_start(&coordinator);
    }

    #[test]
    fn timeout_and_transport_errors_are_not_terminal_guest_evidence() {
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::UnexpectedEof,
            std::io::ErrorKind::InvalidData,
        ] {
            let error = std::io::Error::new(kind, "uncertain operation state");
            assert!(!guest_error_is_terminal(&error, false));
        }
    }

    #[test]
    fn explicit_guest_errors_are_terminal_without_backend_crash() {
        let error = std::io::Error::other("guest rejected request");

        assert!(guest_error_is_terminal(&error, false));
        assert!(!guest_error_is_terminal(&error, true));
    }

    #[tokio::test]
    async fn control_operation_without_guest_releases_reserved_lease() {
        let (gate, coordinator) = gate_without_guest();

        let error = match gate.begin_control_operation().await {
            Ok(_) => panic!("expected no-guest error"),
            Err(error) => error,
        };

        assert_eq!(error, GuestOperationStartError::NoGuest);
        assert_eq!(coordinator.active_operation_count(), 0);
        assert_prepare_can_start(&coordinator);
    }

    #[tokio::test]
    async fn sandbox_operation_without_guest_releases_reserved_lease() {
        let (gate, coordinator) = gate_without_guest();

        let error = match gate.begin_sandbox_operation(|| SandboxState::Running).await {
            Ok(_) => panic!("expected not-running error"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            GuestOperationStartError::NotRunning {
                state: SandboxState::Running
            }
        );
        assert_eq!(coordinator.active_operation_count(), 0);
        assert_prepare_can_start(&coordinator);
    }

    #[tokio::test]
    async fn sandbox_crash_after_reserve_releases_reserved_lease() {
        let (gate, coordinator) = gate_without_guest();
        let calls = AtomicUsize::new(0);

        let error = match gate
            .begin_sandbox_operation(|| {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    SandboxState::Running
                } else {
                    SandboxState::Crashed
                }
            })
            .await
        {
            Ok(_) => panic!("expected backend-crashed error"),
            Err(error) => error,
        };

        assert_eq!(error, GuestOperationStartError::BackendCrashed);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(coordinator.active_operation_count(), 0);
        assert_prepare_can_start(&coordinator);
    }

    #[tokio::test]
    async fn closed_gate_rejects_without_active_lease() {
        let (gate, coordinator) = gate_without_guest();
        let attempt = coordinator
            .begin_prepare_park()
            .expect("gate should enter closing state");

        let error = match gate.begin_control_operation().await {
            Ok(_) => panic!("expected gate-closed error"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            GuestOperationStartError::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            }
        ));
        assert_eq!(coordinator.active_operation_count(), 0);
        coordinator.abort_prepare_park(&attempt).unwrap();
    }
}
