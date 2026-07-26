mod listener;
mod request;

use std::collections::HashMap;
use std::io;
use std::os::unix::io::RawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(test)]
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::{Notify, oneshot};
use vsock_proto::{BorrowedRawMessage, DecodeWithError, Decoder, RawMessage};

use crate::operation_tracker::{
    NormalOperationToken, NormalOperationTracker, NormalOperationTransitionHandle,
};
use crate::{VsockHost, exec_operation};

pub(super) use request::{
    CompositeNormalOperation, normal_operation_transition_error,
    normal_request_on_shared_with_write_observer_frame_builder,
    request_on_shared_with_composite_operation_and_observer_frame_builder,
};
#[cfg(test)]
pub(super) use request::{RequestWriteGuard, write_request_frame_with_builder};

const READ_BUF_SIZE: usize = 64 * 1024;

/// Connection lifecycle, expressed as data rather than a separate atomic flag.
///
/// Pending requests, active exec operations, and connected process state
/// live inside the `Connected` variant so registrations are structurally
/// unreachable once the reader task has exited.
///
/// The invariant "connection is closed ⇔ registrations are impossible" is
/// enforced by the type: every code path that cares about liveness must
/// `match`, which precludes the old footgun of reading a stale close flag
/// without taking the corresponding lock.
pub(super) enum ConnectionState {
    Connected {
        /// Pending request responses: seq → response route.
        pending: HashMap<u32, PendingResponse>,
        /// Active exec-operation state owned by the exec_operation module.
        operations: exec_operation::Operations,
    },
    Closed,
}

/// Shared state between the reader task and public API methods.
pub(super) struct Shared {
    /// Serialises writes to the stream.
    pub(super) writer: tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    /// Serialises memory-heavy encoded frame construction without blocking
    /// ordinary writer-lock users such as lifecycle and control frames.
    pub(super) frame_builder: tokio::sync::Mutex<()>,
    /// Serialises file-write request lifecycles through their terminal
    /// responses while allowing control and lifecycle frames to bypass them.
    pub(super) file_write_gate: tokio::sync::Mutex<()>,
    /// Raw fd of the underlying socket, used to poison a corrupted stream.
    pub(super) fd: RawFd,
    /// Monotonically increasing sequence number (starts at 2, skips 0).
    /// Handshake uses seq=1 before Shared is created, so post-handshake
    /// sequences start at 2 to avoid collisions.
    pub(super) seq: AtomicU32,
    /// Single source of truth for connection liveness plus all per-connection
    /// registration tables. See [`ConnectionState`].
    pub(super) state: std::sync::Mutex<ConnectionState>,
    /// Connection-local tracker for logical normal guest operations.
    ///
    /// Routing maps stay inside [`ConnectionState`]; this tracker records the
    /// neutral operation-readiness facts that sandbox policy can consume later.
    pub(super) normal_operations: NormalOperationTracker,
    /// Notified when the connection closes. Pure signalling — all state is in
    /// `state`.
    pub(super) close_notify: Notify,
    /// One-shot test hook at the unlocked exec-output payload-copy boundary.
    #[cfg(test)]
    pub(super) exec_output_before_copy_hook: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub(super) struct PendingResponse {
    response_tx: oneshot::Sender<RawMessage>,
    normal_operation: Option<PendingNormalOperation>,
    normal_terminal_msg_types: &'static [u8],
}

enum PendingNormalOperation {
    Owned(NormalOperationToken),
    Composite(NormalOperationTransitionHandle),
}

impl Shared {
    /// Get next sequence number, skipping 0 (reserved for unsolicited messages).
    pub(super) fn next_seq(&self) -> u32 {
        loop {
            let seq = self.seq.fetch_add(1, Ordering::Relaxed);
            if seq != 0 {
                return seq;
            }
            // Wrapped to 0 — skip it.
        }
    }

    /// Transition `Connected → Closed`, dropping registration maps outside the
    /// state lock so sender drops (which wake their receivers) run without the
    /// lock held. Idempotent: a second call leaves the existing closed state
    /// untouched.
    ///
    /// `mem::replace` writes a placeholder `Closed` state so the old variant
    /// can be moved out for destructuring. The already-`Closed` arm uses an `@`
    /// binding to write the whole variant back unchanged, so double-close is a
    /// structural no-op rather than a convention.
    fn close(&self) {
        self.close_with_reason("connection closed", ConnectionCloseKind::Closed);
    }

    fn close_with_reason(&self, reason: &'static str, kind: ConnectionCloseKind) {
        let maps_to_drop = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match std::mem::replace(&mut *guard, ConnectionState::Closed) {
                ConnectionState::Connected {
                    pending,
                    operations,
                } => {
                    // Serialize tracker close/poison with terminal dispatch,
                    // which completes tracker tokens under this same state lock.
                    match kind {
                        ConnectionCloseKind::Closed => self.normal_operations.mark_closed(),
                        ConnectionCloseKind::Poisoned => self.normal_operations.mark_not_parkable(),
                    }
                    let exec_operation_snapshot = operations.close_snapshot();
                    *guard = ConnectionState::Closed;
                    Some((pending, operations, exec_operation_snapshot))
                }
                closed @ ConnectionState::Closed => {
                    // Reassign the whole variant by binding rather than by
                    // convention.
                    *guard = closed;
                    None
                }
            }
        };
        if let Some((pending, operations, exec_operation_snapshot)) = maps_to_drop {
            let maps = (pending, operations);
            drop(maps);
            self.close_notify.notify_waiters();
            exec_operation::log_operations_closed(reason, &exec_operation_snapshot);
        }
    }

    pub(super) fn poison_connection(&self) {
        self.close_with_reason("connection poisoned", ConnectionCloseKind::Poisoned);
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
    }

    fn remove_pending(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { pending, .. } = &mut *guard {
            pending.remove(&seq);
        }
    }

    pub(super) fn remove_operation(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard {
            operations.remove(seq);
        }
    }

    pub(super) fn reserve_normal_operation(&self) -> io::Result<NormalOperationToken> {
        self.normal_operations
            .reserve()
            .map_err(request::normal_operation_rejection_error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionCloseKind {
    Closed,
    Poisoned,
}

impl Drop for VsockHost {
    fn drop(&mut self) {
        // Drop registration state synchronously. The shutdown below normally
        // lets `reader_loop` observe EOF and call `close()`, but aborting the
        // reader task can win that race. Closing here makes active exec
        // handles and stream receivers release immediately when the host is
        // dropped.
        self.shared.close();
        // Signal EOF on the socket so the reader_loop's `read()` and the
        // remote peer's blocking `read()` return immediately. Without this,
        // the split stream halves keep the fd alive until the reader task is
        // cancelled, which requires an async yield — not possible in Drop.
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
        self._reader.abort();
    }
}

/// Background reader task: owns the read half and decoder exclusively.
///
/// Dispatches responses and exec operation lifecycle frames by seq number.
async fn reader_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    mut decoder: Decoder,
    shared: Arc<Shared>,
) {
    let mut buf = Box::new([0u8; READ_BUF_SIZE]);
    loop {
        let n = match reader.read(buf.as_mut()).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // n <= READ_BUF_SIZE guaranteed by read()
        match decoder.decode_with(buf.get(..n).unwrap_or_default(), |msg| {
            dispatch_reader_frame(&shared, msg)
        }) {
            Ok(()) => {}
            Err(DecodeWithError::Protocol(_)) => break,
            Err(DecodeWithError::Visitor(_)) => {
                shared.poison_connection();
                return;
            }
        }
    }
    // Connection lost — transition state to Closed. `close()` drops all
    // registration maps outside the lock (waking every pending receiver
    // with `RecvError`) and fires `close_notify` so test helpers wake.
    shared.close();
}

fn dispatch_reader_frame(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    match exec_operation::dispatch_incoming_frame(shared, msg) {
        Ok(true) => {
            return Ok(());
        }
        Ok(false) => {}
        Err(error) => {
            return Err(error);
        }
    }

    let pending_response = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { pending, .. } => {
                if let Some(mut pending_response) = pending.remove(&msg.seq) {
                    if pending_response
                        .normal_terminal_msg_types
                        .contains(&msg.msg_type)
                        && let Some(normal_operation) = pending_response.normal_operation.take()
                    {
                        request::complete_pending_normal_operation(normal_operation)?;
                    }
                    Some(pending_response)
                } else {
                    None
                }
            }
            ConnectionState::Closed => None,
        }
    };
    if let Some(pending_response) = pending_response {
        let _ = pending_response.response_tx.send(msg.to_owned_message());
    }
    Ok(())
}

#[cfg(test)]
impl VsockHost {
    /// Test-only: deterministically await the `Connected → Closed` transition
    /// without relying on a wall-clock sleep. Subscribes to the same
    /// `close_notify` signal that [`Shared::close`] fires on exit, and re-checks
    /// state under the same lock that `close` holds, so no transition is
    /// missed.
    pub(crate) async fn wait_until_closed(&self, timeout: Duration) -> io::Result<()> {
        let deadline = request::deadline_after(timeout, "wait_until_closed timeout overflowed")?;
        loop {
            let notified = self.shared.close_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if matches!(
                &*self.shared.state.lock().unwrap_or_else(|e| e.into_inner()),
                ConnectionState::Closed
            ) {
                return Ok(());
            }

            tokio::select! {
                biased;
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "wait_until_closed: reader did not transition to Closed in time",
                    ));
                }
            }
        }
    }
}
