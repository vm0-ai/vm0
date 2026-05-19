//! Policy-only admission gate for guest operations.
//!
//! `sandbox-fc` decides whether an operation may attempt to start. The
//! authoritative normal-operation lifetime begins only when `vsock-host`
//! acquires its normal-operation token.

use std::sync::Arc;

use vsock_host::VsockHost;

use crate::park_coordinator::{CoordinatorState, OperationStartRejection, ParkCoordinator};
use crate::sandbox::SandboxState;

#[derive(Clone)]
pub(crate) struct GuestOperationStartGate {
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    coordinator: ParkCoordinator,
}

impl GuestOperationStartGate {
    pub(crate) fn new(
        guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
        coordinator: ParkCoordinator,
    ) -> Self {
        Self { guest, coordinator }
    }

    pub(crate) async fn begin_sandbox_operation(
        &self,
        current_state: impl Fn() -> SandboxState,
    ) -> Result<Arc<VsockHost>, GuestOperationStartError> {
        match current_state() {
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            SandboxState::Running => {}
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        self.ensure_policy_open()?;
        let guest = self.guest.lock().await.as_ref().cloned();

        match current_state() {
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            SandboxState::Running => {}
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        self.ensure_policy_open()?;
        guest.ok_or(GuestOperationStartError::NotRunning {
            state: SandboxState::Running,
        })
    }

    pub(crate) async fn begin_control_operation(
        &self,
    ) -> Result<Arc<VsockHost>, GuestOperationStartError> {
        self.ensure_policy_open()?;
        let guest = self.guest.lock().await.as_ref().cloned();
        self.ensure_policy_open()?;
        guest.ok_or(GuestOperationStartError::NoGuest)
    }

    fn ensure_policy_open(&self) -> Result<(), GuestOperationStartError> {
        self.coordinator
            .ensure_operation_start_allowed()
            .map_err(|error| match error {
                OperationStartRejection::GateClosed { state } => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU8, Ordering};

    fn gate_without_guest() -> (GuestOperationStartGate, ParkCoordinator) {
        let coordinator = ParkCoordinator::new();
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        (
            GuestOperationStartGate::new(guest, coordinator.clone()),
            coordinator,
        )
    }

    fn state_from_atomic(state: &AtomicU8) -> SandboxState {
        match state.load(Ordering::Acquire) {
            value if value == SandboxState::Running as u8 => SandboxState::Running,
            value if value == SandboxState::Crashed as u8 => SandboxState::Crashed,
            value if value == SandboxState::Stopping as u8 => SandboxState::Stopping,
            value if value == SandboxState::Stopped as u8 => SandboxState::Stopped,
            _ => SandboxState::Created,
        }
    }

    fn signaled_state_reader(
        state: Arc<AtomicU8>,
        first_read: tokio::sync::oneshot::Sender<()>,
    ) -> impl Fn() -> SandboxState + Send + 'static {
        let first_read = std::sync::Mutex::new(Some(first_read));
        move || {
            if let Some(first_read) = first_read.lock().unwrap().take() {
                let _ = first_read.send(());
            }
            state_from_atomic(&state)
        }
    }

    #[tokio::test]
    async fn sandbox_operation_requires_running_state() {
        for state in [
            SandboxState::Created,
            SandboxState::Stopping,
            SandboxState::Stopped,
        ] {
            let (gate, coordinator) = gate_without_guest();
            let result = gate.begin_sandbox_operation(|| state).await;

            assert_eq!(
                result.err(),
                Some(GuestOperationStartError::NotRunning { state })
            );
            assert_eq!(coordinator.state(), CoordinatorState::Open);
        }
    }

    #[tokio::test]
    async fn sandbox_operation_reports_backend_crash_before_guest_lookup() {
        let (gate, coordinator) = gate_without_guest();

        let result = gate.begin_sandbox_operation(|| SandboxState::Crashed).await;

        assert_eq!(result.err(), Some(GuestOperationStartError::BackendCrashed));
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[tokio::test]
    async fn sandbox_operation_without_guest_reports_running_not_available() {
        let (gate, coordinator) = gate_without_guest();

        let result = gate.begin_sandbox_operation(|| SandboxState::Running).await;

        assert_eq!(
            result.err(),
            Some(GuestOperationStartError::NotRunning {
                state: SandboxState::Running
            })
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[tokio::test]
    async fn sandbox_operation_rechecks_state_after_guest_lock_wait() {
        let coordinator = ParkCoordinator::new();
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let gate = GuestOperationStartGate::new(Arc::clone(&guest), coordinator.clone());
        let locked_guest = guest.lock().await;
        let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
        let (first_read_tx, first_read_rx) = tokio::sync::oneshot::channel();

        let operation = {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                gate.begin_sandbox_operation(signaled_state_reader(state, first_read_tx))
                    .await
            })
        };
        first_read_rx
            .await
            .expect("operation should pass the first state check");
        state.store(SandboxState::Crashed as u8, Ordering::Release);
        drop(locked_guest);

        let result = operation.await.expect("operation task should complete");
        assert_eq!(result.err(), Some(GuestOperationStartError::BackendCrashed));
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[tokio::test]
    async fn sandbox_operation_rechecks_policy_after_guest_lock_wait() {
        let coordinator = ParkCoordinator::new();
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let gate = GuestOperationStartGate::new(Arc::clone(&guest), coordinator.clone());
        let locked_guest = guest.lock().await;
        let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
        let (first_read_tx, first_read_rx) = tokio::sync::oneshot::channel();

        let operation = tokio::spawn(async move {
            gate.begin_sandbox_operation(signaled_state_reader(state, first_read_tx))
                .await
        });
        first_read_rx
            .await
            .expect("operation should pass the first policy check");
        let attempt = coordinator.begin_prepare_park().expect("begin prepare");
        drop(locked_guest);

        let result = operation.await.expect("operation task should complete");
        assert!(matches!(
            result,
            Err(GuestOperationStartError::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));
        coordinator.abort_prepare_park(&attempt).unwrap();
    }

    #[tokio::test]
    async fn control_operation_without_guest_reports_no_guest() {
        let (gate, coordinator) = gate_without_guest();

        let result = gate.begin_control_operation().await;

        assert_eq!(result.err(), Some(GuestOperationStartError::NoGuest));
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[tokio::test]
    async fn closed_policy_gate_rejects_sandbox_and_control_operations() {
        let (gate, coordinator) = gate_without_guest();
        let attempt = coordinator.begin_prepare_park().expect("begin prepare");

        let sandbox_result = gate.begin_sandbox_operation(|| SandboxState::Running).await;
        let control_result = gate.begin_control_operation().await;

        assert!(matches!(
            sandbox_result,
            Err(GuestOperationStartError::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));
        assert!(matches!(
            control_result,
            Err(GuestOperationStartError::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));
        coordinator.abort_prepare_park(&attempt).unwrap();
    }
}
