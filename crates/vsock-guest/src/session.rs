use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct SessionWorkTracker {
    pending: AtomicUsize,
    quiescing: AtomicBool,
}

impl SessionWorkTracker {
    pub(crate) fn begin_work(self: &Arc<Self>) -> io::Result<PendingWorkGuard> {
        if self.quiescing.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "control session is quiescing",
            ));
        }

        self.pending.fetch_add(1, Ordering::AcqRel);
        if self.quiescing.load(Ordering::Acquire) {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "control session is quiescing",
            ));
        }

        Ok(PendingWorkGuard {
            tracker: Arc::clone(self),
        })
    }

    pub(crate) fn begin_quiesce(&self) -> bool {
        self.quiescing.store(true, Ordering::Release);
        self.pending.load(Ordering::Acquire) == 0
    }
}

pub(crate) struct PendingWorkGuard {
    tracker: Arc<SessionWorkTracker>,
}

impl Drop for PendingWorkGuard {
    fn drop(&mut self) {
        self.tracker.pending.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone)]
pub(crate) struct PendingWorkSlot {
    guard: Arc<Mutex<Option<PendingWorkGuard>>>,
}

impl PendingWorkSlot {
    pub(crate) fn new(guard: Option<PendingWorkGuard>) -> Self {
        Self {
            guard: Arc::new(Mutex::new(guard)),
        }
    }

    pub(crate) fn take(&self) -> Option<PendingWorkGuard> {
        self.guard.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_slot_holds_guard_until_taken() {
        let tracker = Arc::new(SessionWorkTracker::default());
        let slot = PendingWorkSlot::new(Some(tracker.begin_work().unwrap()));
        let worker_slot = slot.clone();
        drop(slot);

        assert!(!tracker.begin_quiesce());

        drop(worker_slot.take());
        assert_eq!(tracker.pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn pending_slot_take_is_idempotent() {
        let tracker = Arc::new(SessionWorkTracker::default());
        let slot = PendingWorkSlot::new(Some(tracker.begin_work().unwrap()));

        assert!(slot.take().is_some());
        assert!(slot.take().is_none());
    }

    #[test]
    fn quiesce_rejects_new_work_until_session_resets() {
        let tracker = Arc::new(SessionWorkTracker::default());
        let work = tracker.begin_work().unwrap();

        assert!(!tracker.begin_quiesce());
        let err = match tracker.begin_work() {
            Ok(_) => panic!("quiescing tracker must reject new work"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);

        drop(work);
        assert!(tracker.begin_quiesce());
    }
}
