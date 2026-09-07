//! Canonical cancellation-safe writer for every post-handshake frame.
//!
//! Admission runs under the writer lock before any bytes can be emitted. An
//! error or `Skip` leaves the stream untouched. Once writing starts, a guard
//! poisons the connection on error or cancellation because a partial frame
//! cannot safely be followed by another frame. Only a successful `write_all`
//! disarms the guard. The guard drops before the writer lock is released.
//!
//! Callers retain ownership of encoding, admission, request/operation cleanup,
//! deadlines, and diagnostics. In particular, frame-builder callers must keep
//! their encoded buffer inside the builder gate for the entire write.

use std::io;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::time::Instant;

use super::Shared;

/// `Skip` is a successful no-frame outcome, decided under the writer lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrameWriteDecision {
    Write,
    Skip,
}

pub(crate) struct FrameWriteTiming {
    pub(crate) wait: Duration,
    pub(crate) write: Duration,
}

/// Exists only inside the possible partial-write window, while holding the writer.
struct FrameWriteGuard<'a> {
    shared: &'a Shared,
    completed: bool,
}

impl Drop for FrameWriteGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.shared.poison_connection();
        }
    }
}

impl Shared {
    /// Serialize admission and writing, then observe the finished write after unlocking.
    ///
    /// `pre_write` owns admission and write-start notifications. An admission
    /// error or `Skip` does not invoke `write_finished`. Wait timing excludes
    /// admission; write timing excludes poisoning, unlocking, and observation.
    pub(crate) async fn write_frame(
        &self,
        data: &[u8],
        pre_write: impl FnOnce() -> io::Result<FrameWriteDecision>,
        write_finished: impl FnOnce(FrameWriteTiming, &io::Result<()>),
    ) -> io::Result<FrameWriteDecision> {
        let wait_started_at = Instant::now();
        let mut writer = self.writer.lock().await;
        let wait = wait_started_at.elapsed();
        if pre_write()? == FrameWriteDecision::Skip {
            return Ok(FrameWriteDecision::Skip);
        }

        // Declared after the writer so cancellation poisons before unlocking.
        let mut guard = FrameWriteGuard {
            shared: self,
            completed: false,
        };
        let write_started_at = Instant::now();
        let result = writer.write_all(data).await;
        let write = write_started_at.elapsed();
        guard.completed = result.is_ok();
        drop(guard);
        drop(writer);

        write_finished(FrameWriteTiming { wait, write }, &result);
        result?;
        Ok(FrameWriteDecision::Write)
    }
}
