use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(crate) struct OperationState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Open,
    Quiescing,
}

struct Inner {
    mode: Mode,
    pending: usize,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            mode: Mode::Open,
            pending: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcquireOperationError {
    Quiescing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuiesceResult {
    Quiesced,
    Busy { pending: usize },
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
    pub(crate) fn acquire(&self) -> Result<OperationGuard, AcquireOperationError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.mode = Mode::Quiescing;
        if inner.pending == 0 {
            QuiesceResult::Quiesced
        } else {
            QuiesceResult::Busy {
                pending: inner.pending,
            }
        }
    }

    pub(crate) fn resume(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).mode = Mode::Open;
    }

    pub(crate) fn is_quiescing(&self) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).mode == Mode::Quiescing
    }

    fn release_one(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending = inner.pending.saturating_sub(1);
    }

    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).pending
    }
}

impl OperationGuard {
    pub(crate) fn release(&self) {
        if !self.inner.released.swap(true, Ordering::AcqRel) {
            self.inner.state.release_one();
        }
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
        state.resume();

        let guard = state.acquire().unwrap();
        assert_eq!(state.pending(), 1);
        drop(guard);
    }
}
