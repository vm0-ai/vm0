use std::time::Instant;

/// Host monotonic milestones from one guest connection attempt.
///
/// Missing milestones were not reached, not zero-duration work. The record is
/// returned with ordinary I/O errors, but not if the owning future is dropped.
/// These observations include host scheduling and are not guest execution times.
#[derive(Clone, Copy, Debug)]
pub struct GuestConnectionTiming {
    /// First poll of the timed connection operation, before listener setup.
    pub started: Instant,
    /// The listener socket was bound successfully.
    pub listener_bound: Option<Instant>,
    /// A guest stream was accepted, before listener unlinking.
    pub accepted: Option<Instant>,
    /// The READY message was decoded.
    pub ready: Option<Instant>,
    /// The complete PING frame was written.
    pub ping_written: Option<Instant>,
    /// A PONG with the expected sequence was decoded.
    pub pong_received: Option<Instant>,
    /// The operation completed, including client setup or its original error.
    pub completed: Instant,
}

impl GuestConnectionTiming {
    pub(super) fn new() -> Self {
        let started = Instant::now();
        Self {
            started,
            listener_bound: None,
            accepted: None,
            ready: None,
            ping_written: None,
            pong_received: None,
            completed: started,
        }
    }
}
