use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::containment::ContainmentManager;
use crate::writer::GuestShutdown;

#[derive(Clone)]
pub(crate) struct OperationState {
    inner: Arc<OperationStateInner>,
}

struct OperationStateInner {
    state: Mutex<Inner>,
    containment: ContainmentManager,
    transports: Mutex<Vec<GuestShutdown>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Open,
    Quiescing,
}

struct Inner {
    mode: Mode,
    pending: usize,
    fatal_reason: Option<String>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            mode: Mode::Open,
            pending: 0,
            fatal_reason: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcquireOperationError {
    Quiescing,
    Fatal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuiesceResult {
    Quiesced,
    Busy { pending: usize },
    Fatal,
}

#[derive(Clone)]
pub(crate) struct OperationGuard {
    inner: Arc<OperationGuardInner>,
}

struct OperationGuardInner {
    state: OperationState,
    released: AtomicBool,
}

impl OperationState {
    fn new(containment: ContainmentManager) -> Self {
        Self {
            inner: Arc::new(OperationStateInner {
                state: Mutex::new(Inner::default()),
                containment,
                transports: Mutex::new(Vec::new()),
            }),
        }
    }

    #[cfg(any(debug_assertions, feature = "test-support"))]
    pub(crate) fn with_cgroup_fixture(root: std::path::PathBuf) -> Self {
        Self::new(ContainmentManager::fixture(root))
    }

    pub(crate) fn acquire(&self) -> Result<OperationGuard, AcquireOperationError> {
        let mut inner = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if inner.fatal_reason.is_some() {
            return Err(AcquireOperationError::Fatal);
        }
        if inner.mode == Mode::Quiescing {
            return Err(AcquireOperationError::Quiescing);
        }
        inner.pending += 1;
        Ok(OperationGuard {
            inner: Arc::new(OperationGuardInner {
                state: self.clone(),
                released: AtomicBool::new(false),
            }),
        })
    }

    pub(crate) fn enter_quiescing(&self) -> QuiesceResult {
        {
            let mut inner = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if inner.fatal_reason.is_some() {
                return QuiesceResult::Fatal;
            }
            inner.mode = Mode::Quiescing;
            if inner.pending > 0 {
                return QuiesceResult::Busy {
                    pending: inner.pending,
                };
            }
        }

        if let Err(error) = self.inner.containment.audit() {
            self.poison(format!("exec containment audit failed: {error}"));
            return QuiesceResult::Fatal;
        }
        QuiesceResult::Quiesced
    }

    pub(crate) fn resume(&self) -> Result<(), AcquireOperationError> {
        let mut inner = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if inner.fatal_reason.is_some() {
            return Err(AcquireOperationError::Fatal);
        }
        inner.mode = Mode::Open;
        Ok(())
    }

    pub(crate) fn is_quiescing(&self) -> bool {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .mode
            == Mode::Quiescing
    }

    pub(crate) fn is_fatal(&self) -> bool {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .fatal_reason
            .is_some()
    }

    pub(crate) fn poison(&self, reason: String) {
        self.mark_fatal(reason);
        self.shutdown_transports();
    }

    fn mark_fatal(&self, reason: String) {
        {
            let mut inner = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if inner.fatal_reason.is_none() {
                inner.fatal_reason = Some(reason);
            }
        }
    }

    fn shutdown_transports(&self) {
        let mut transports = self
            .inner
            .transports
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        transports.retain(GuestShutdown::is_alive);
        for transport in transports.iter() {
            transport.shutdown();
        }
    }

    pub(crate) fn register_transport(&self, transport: GuestShutdown) {
        let mut transports = self
            .inner
            .transports
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        transports.retain(GuestShutdown::is_alive);
        transports.push(transport.clone());
        drop(transports);
        if self.is_fatal() {
            transport.shutdown();
        }
    }

    pub(crate) fn containment(&self) -> ContainmentManager {
        self.inner.containment.clone()
    }

    pub(crate) fn audit_containment(&self) -> io::Result<()> {
        self.inner.containment.audit()
    }

    fn release_one(&self) {
        let mut inner = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending = inner.pending.saturating_sub(1);
    }

    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
    }
}

impl OperationGuard {
    pub(crate) fn release(&self) {
        if !self.inner.released.swap(true, Ordering::AcqRel) {
            self.inner.state.release_one();
        }
    }

    pub(crate) fn poison(&self, reason: String) {
        self.inner.state.mark_fatal(reason);
    }

    pub(crate) fn shutdown_transports(&self) {
        self.inner.state.shutdown_transports();
    }

    pub(crate) fn containment(&self) -> ContainmentManager {
        self.inner.state.containment()
    }
}

impl Default for OperationState {
    fn default() -> Self {
        Self::new(ContainmentManager::default())
    }
}

impl Drop for OperationGuardInner {
    fn drop(&mut self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.state.release_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_counts_one_operation_until_last_guard_clone_drops() {
        let state = OperationState::default();
        let guard = state.acquire().unwrap();
        let clone = guard.clone();

        assert_eq!(state.pending(), 1);
        drop(guard);
        assert_eq!(state.pending(), 1);
        drop(clone);
        assert_eq!(state.pending(), 0);
    }

    #[test]
    fn explicit_release_drops_pending_before_guard_clones_drop() {
        let state = OperationState::default();
        let guard = state.acquire().unwrap();
        let clone = guard.clone();

        guard.release();

        assert_eq!(state.pending(), 0);
        drop(guard);
        drop(clone);
        assert_eq!(state.pending(), 0);
    }

    #[test]
    fn quiesce_fences_new_operations_even_when_busy() {
        let state = OperationState::default();
        let guard = state.acquire().unwrap();

        assert_eq!(state.enter_quiescing(), QuiesceResult::Busy { pending: 1 });
        assert!(matches!(
            state.acquire(),
            Err(AcquireOperationError::Quiescing)
        ));

        drop(guard);
        assert_eq!(state.pending(), 0);
    }

    #[test]
    fn resume_allows_operations_after_quiesce() {
        let state = OperationState::default();

        assert_eq!(state.enter_quiescing(), QuiesceResult::Quiesced);
        assert!(matches!(
            state.acquire(),
            Err(AcquireOperationError::Quiescing)
        ));
        state.resume().unwrap();

        let guard = state.acquire().unwrap();
        assert_eq!(state.pending(), 1);
        drop(guard);
    }
}
