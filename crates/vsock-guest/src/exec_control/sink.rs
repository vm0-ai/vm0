//! Exec-control sink lifecycle and stream serialization.
//!
//! A sink belongs to one active exec operation and is shared by the accept
//! thread, forwarding workers, and operation cleanup. `accept.rs` drives the
//! process-control accept and hello handshake, while `forward.rs` waits for the
//! sink, serializes access to the connected stream, and marks the sink failed on
//! terminal connected-stream errors. While the operation is active, accept or
//! hello failures move the sink to `Failed`; operation cleanup moves it to
//! `Closed`.
//!
//! The lifecycle starts in `Waiting`. A successful connection path moves through
//! `Handshaking` while the accepted process-control stream sends its hello, and
//! reaches `Connected` once forwarding can use the stream. `Failed` preserves a
//! sink error for later requests, and `Closed` represents operation cleanup.
//! Requests wait in `Waiting` or `Handshaking` until the sink connects, fails,
//! closes, or their deadline expires. Connected requests serialize over the
//! process-control stream. Failed sinks return `SinkError`; closed or inactive
//! sinks return `Inactive`.
//!
//! `inner` and `ready` own connection-state changes and wake waiting forwarders.
//! `active` is the operation-lifetime gate, so close/drop can stop queued or
//! in-flight forwarding even when a connected stream guard is busy. The
//! connected stream has a separate `locked` gate so waiters can keep their
//! request deadlines and be woken by close/fail before taking the stream mutex.
//! `pending` limits outstanding forwarding work; when it is full, new requests
//! release their transient count and return `QueueFull`. `PendingControlSlot`
//! releases reserved work. The shutdown stream clones let close/fail interrupt
//! handshakes or connected I/O without waiting for the active stream guard.

use std::io;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Instant;

use vsock_proto::ExecControlStatus;

use super::{
    EXEC_CONTROL_CLONE_SINK_ERROR_PREFIX, EXEC_CONTROL_QUEUE_FULL_MESSAGE,
    EXEC_OPERATION_INACTIVE_MESSAGE, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, MAX_PENDING_CONTROL_REQUESTS,
    duration_until, request_timeout_error,
};

pub(super) struct ControlSinkState {
    /// Connection lifecycle state paired with `ready` for waiter wakeups.
    pub(super) inner: Mutex<ControlSinkInner>,
    /// Notifies waiters after lifecycle state changes.
    pub(super) ready: Condvar,
    /// Operation-lifetime gate; once false, requests resolve as inactive.
    pub(super) active: AtomicBool,
    /// Backpressure counter for outstanding forwarding work; full means queue-full.
    pub(super) pending: AtomicUsize,
}

/// Connected sink state.
///
/// `shutdown` is a clone of the stream used only to interrupt connected I/O
/// without taking the stream mutex held by the active forwarder.
pub(super) struct ConnectedControlSink {
    pub(super) stream: Arc<ControlStreamState>,
    shutdown: UnixStream,
}

/// Shared connected stream plus a waitable serialization gate.
///
/// `locked` is separate from `stream` so waiting forwarders can wait with their
/// request deadline and can be woken by close/fail without contending on a busy
/// stream mutex.
pub(super) struct ControlStreamState {
    stream: Mutex<UnixStream>,
    locked: Mutex<bool>,
    ready: Condvar,
}

/// RAII guard for the forwarder that owns the connected-stream gate.
pub(super) struct ControlStreamGuard<'a> {
    state: &'a ControlStreamState,
    stream: MutexGuard<'a, UnixStream>,
}

pub(super) enum ControlSinkInner {
    /// No process-control stream has been accepted yet.
    Waiting,
    /// A stream was accepted and can be interrupted through the stored clone.
    Handshaking(UnixStream),
    /// The process-control stream is ready for serialized forwarding.
    Connected(ConnectedControlSink),
    /// A terminal sink error to return to subsequent requests.
    Failed(String),
    /// Operation cleanup completed; subsequent requests resolve inactive.
    Closed,
}

/// Reserved pending capacity for one forwarding worker.
///
/// Dropping the slot releases the `pending` counter even if forwarding exits
/// through timeout, sink failure, inactive operation, or result-send failure.
pub(super) struct PendingControlSlot {
    sink: Arc<ControlSinkState>,
}

impl PendingControlSlot {
    fn new(sink: Arc<ControlSinkState>) -> Self {
        Self { sink }
    }
}

impl Drop for PendingControlSlot {
    fn drop(&mut self) {
        self.sink.pending.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ControlSinkState {
    pub(super) fn new() -> Self {
        Self {
            inner: Mutex::new(ControlSinkInner::Waiting),
            ready: Condvar::new(),
            active: AtomicBool::new(true),
            pending: AtomicUsize::new(0),
        }
    }

    pub(super) fn connect(&self, stream: UnixStream) {
        if !self.active.load(Ordering::Acquire) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        }
        let connected = match ConnectedControlSink::new(stream) {
            Ok(connected) => connected,
            Err(error) => {
                let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if !matches!(*guard, ControlSinkInner::Closed) {
                    *guard = ControlSinkInner::Failed(format!(
                        "{}: {error}",
                        EXEC_CONTROL_CLONE_SINK_ERROR_PREFIX
                    ));
                }
                self.ready.notify_all();
                return;
            }
        };
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !self.active.load(Ordering::Acquire) {
            connected.shutdown();
            *guard = ControlSinkInner::Closed;
            self.ready.notify_all();
            return;
        }
        *guard = ControlSinkInner::Connected(connected);
        self.ready.notify_all();
    }

    pub(super) fn begin_handshake(&self, stream: &UnixStream) -> io::Result<bool> {
        let shutdown = stream.try_clone()?;
        if !self.active.load(Ordering::Acquire) {
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
            return Ok(false);
        }

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !self.active.load(Ordering::Acquire) {
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
            *guard = ControlSinkInner::Closed;
            self.ready.notify_all();
            return Ok(false);
        }
        if !matches!(*guard, ControlSinkInner::Waiting) {
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
            return Ok(false);
        }

        *guard = ControlSinkInner::Handshaking(shutdown);
        self.ready.notify_all();
        Ok(true)
    }

    pub(super) fn fail(&self, message: String) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        shutdown_sink_stream(&guard);
        {
            if !matches!(*guard, ControlSinkInner::Closed) {
                *guard = ControlSinkInner::Failed(message);
            }
            self.ready.notify_all();
        }
    }

    pub(super) fn close(&self) {
        self.active.store(false, Ordering::Release);
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        shutdown_sink_stream(&guard);
        *guard = ControlSinkInner::Closed;
        self.ready.notify_all();
    }

    pub(super) fn wait_for_stream(
        &self,
        deadline: Instant,
    ) -> Result<Arc<ControlStreamState>, (ExecControlStatus, String)> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !self.active.load(Ordering::Acquire) {
                return Err((
                    ExecControlStatus::Inactive,
                    EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                ));
            }
            match &*guard {
                ControlSinkInner::Connected(connected) => return Ok(Arc::clone(&connected.stream)),
                ControlSinkInner::Waiting | ControlSinkInner::Handshaking(_) => {
                    let Some(wait) = duration_until(deadline) else {
                        return Err((
                            ExecControlStatus::SinkTimeout,
                            EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                        ));
                    };
                    let (next_guard, wait_result) = self
                        .ready
                        .wait_timeout(guard, wait)
                        .unwrap_or_else(|e| e.into_inner());
                    guard = next_guard;
                    // A timeout can race with a notify; re-check the condition
                    // unless the request deadline has actually elapsed.
                    if wait_result.timed_out() && duration_until(deadline).is_none() {
                        return Err((
                            ExecControlStatus::SinkTimeout,
                            EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                        ));
                    }
                }
                ControlSinkInner::Failed(message) => {
                    return Err((ExecControlStatus::SinkError, message.clone()));
                }
                ControlSinkInner::Closed => {
                    return Err((
                        ExecControlStatus::Inactive,
                        EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                    ));
                }
            }
        }
    }

    pub(super) fn reserve_pending_slot(
        self: &Arc<Self>,
    ) -> Result<PendingControlSlot, (ExecControlStatus, String)> {
        if !self.active.load(Ordering::Acquire) {
            return Err((
                ExecControlStatus::Inactive,
                EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
            ));
        }

        let previous = self.pending.fetch_add(1, Ordering::AcqRel);
        if previous >= MAX_PENDING_CONTROL_REQUESTS {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            return Err((
                ExecControlStatus::QueueFull,
                EXEC_CONTROL_QUEUE_FULL_MESSAGE.to_owned(),
            ));
        }

        Ok(PendingControlSlot::new(Arc::clone(self)))
    }
}

fn shutdown_sink_stream(inner: &ControlSinkInner) {
    match inner {
        ControlSinkInner::Handshaking(stream) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        ControlSinkInner::Connected(connected) => connected.shutdown(),
        ControlSinkInner::Waiting | ControlSinkInner::Failed(_) | ControlSinkInner::Closed => {}
    }
}

impl ConnectedControlSink {
    fn new(stream: UnixStream) -> io::Result<Self> {
        let shutdown = stream.try_clone()?;
        Ok(Self {
            stream: Arc::new(ControlStreamState::new(stream)),
            shutdown,
        })
    }

    fn shutdown(&self) {
        let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
        self.stream.notify_waiters();
    }
}

impl ControlStreamState {
    fn new(stream: UnixStream) -> Self {
        Self {
            stream: Mutex::new(stream),
            locked: Mutex::new(false),
            ready: Condvar::new(),
        }
    }

    pub(super) fn lock_until(
        &self,
        deadline: Instant,
        active: &AtomicBool,
    ) -> io::Result<ControlStreamGuard<'_>> {
        let mut locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !active.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    EXEC_OPERATION_INACTIVE_MESSAGE,
                ));
            }
            if !*locked {
                *locked = true;
                drop(locked);
                let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
                return Ok(ControlStreamGuard {
                    state: self,
                    stream,
                });
            }
            let Some(wait) = duration_until(deadline) else {
                return Err(request_timeout_error());
            };
            let (next_locked, wait_result) = self
                .ready
                .wait_timeout(locked, wait)
                .unwrap_or_else(|e| e.into_inner());
            locked = next_locked;
            // A timeout can race with unlock notification; re-check the locked
            // flag unless the request deadline has actually elapsed.
            if wait_result.timed_out() && duration_until(deadline).is_none() {
                return Err(request_timeout_error());
            }
        }
    }

    fn notify_waiters(&self) {
        let _locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        self.ready.notify_all();
    }
}

impl std::ops::Deref for ControlStreamGuard<'_> {
    type Target = UnixStream;

    fn deref(&self) -> &Self::Target {
        &self.stream
    }
}

impl std::ops::DerefMut for ControlStreamGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.stream
    }
}

impl Drop for ControlStreamGuard<'_> {
    fn drop(&mut self) {
        let mut locked = self.state.locked.lock().unwrap_or_else(|e| e.into_inner());
        *locked = false;
        self.state.ready.notify_one();
    }
}
