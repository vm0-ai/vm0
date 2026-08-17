use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::writer::GuestWriter;

pub(crate) struct SingleActiveAdmission {
    active: Arc<AtomicBool>,
}

impl SingleActiveAdmission {
    pub(crate) fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn try_acquire(&self) -> Option<SingleActivePermit> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| SingleActivePermit {
                active: Arc::clone(&self.active),
            })
    }
}

pub(crate) struct SingleActivePermit {
    active: Arc<AtomicBool>,
}

impl Drop for SingleActivePermit {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

pub(crate) struct ShutdownConnectionOnDrop(GuestWriter);

impl ShutdownConnectionOnDrop {
    pub(crate) fn new(writer: GuestWriter) -> Self {
        Self(writer)
    }
}

impl Drop for ShutdownConnectionOnDrop {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}
