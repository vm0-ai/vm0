use std::sync::Arc;

use vsock_host::VsockHost;

use crate::park_coordinator::{
    CoordinatorState, LeaseRejection, OperationLease, OperationTransitionError, ParkCoordinator,
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

    pub(crate) fn mark_writing(&mut self) -> Result<(), OperationTransitionError> {
        self.lease.mark_writing()
    }

    pub(crate) fn mark_in_guest(&mut self) -> Result<(), OperationTransitionError> {
        self.lease.mark_in_guest()
    }

    pub(crate) fn complete(self) -> Result<(), OperationTransitionError> {
        self.lease.complete()
    }

    pub(crate) fn into_lease(self) -> OperationLease {
        self.lease
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
