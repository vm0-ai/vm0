//! Host-side vsock endpoint for Firecracker VM communication.
//!
//! Connects to a guest agent via Unix domain socket (Firecracker forwards
//! vsock connections to `{vsock_path}_{port}` UDS files).
//!
//! ## Connection Flow
//!
//! 1. Host creates UDS listener at `{vsock_path}_{port}`
//! 2. Guest boots and vsock-guest connects to CID=2
//! 3. Firecracker forwards connection to Host's UDS listener
//! 4. Host accepts, receives `ready`, sends `ping`, waits for `pong`
//! 5. Connection established — host can send commands
//!
//! ## Concurrency
//!
//! After connection, a background reader task owns the read half of the
//! stream exclusively. All public methods take `&self` and can be called
//! concurrently. Responses are dispatched to callers via oneshot channels
//! keyed by sequence number.

mod exec_operation;
mod file;
mod operation_tracker;
mod process;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io;
use std::os::unix::io::RawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};

use operation_tracker::{
    NormalOperationFenceRejection as TrackerNormalOperationFenceRejection,
    NormalOperationRejection, NormalOperationToken, NormalOperationTracker,
    NormalOperationTransitionError, NormalOperationTransitionHandle,
};
use vsock_proto::{
    Decoder, MSG_ERROR, MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT,
    MSG_EXEC_STARTED, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_PING, MSG_PONG,
    MSG_PROCESS_EXIT, MSG_QUIESCE_OPERATIONS, MSG_READY, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK, MSG_SPAWN_PROCESS_RESULT, MSG_STDOUT_CHUNK, RawMessage,
};

pub use exec_operation::{
    ExecCaptureRequest, ExecControlAck, ExecControlGuestStatus, ExecControlHandle,
    ExecControlOutcome, ExecOperationHandle, ExecOperationRequest, ExecOperationResult,
    ExecOutputEvent, ExecOwnedCapturedOutput, ExecStreamRequest, SupervisedExecControl,
    SupervisedExecHandle, SupervisedExecRequest,
};
pub use file::{CopyFileOptions, CopyFileResult};
pub use process::{
    GuestProcessControlHandle, GuestProcessHandle, ProcessControlAck, ProcessControlGuestStatus,
    ProcessControlOutcome, ProcessExitEvent,
};

const READ_BUF_SIZE: usize = 64 * 1024;

/// Observer called when a request frame reaches the guest-write boundary.
///
/// The callback is synchronous because it runs while the shared writer lock is
/// held, immediately before frame bytes are written. Keep the callback fast and
/// do not call back into the same [`VsockHost`], because that can deadlock on
/// the writer lock. Multi-frame helper operations may invoke the same observer
/// more than once.
#[derive(Clone)]
pub struct FrameWriteObserver {
    record_write_start: Arc<dyn Fn() -> io::Result<()> + Send + Sync>,
}

impl FrameWriteObserver {
    pub fn new(record_write_start: impl Fn() -> io::Result<()> + Send + Sync + 'static) -> Self {
        Self {
            record_write_start: Arc::new(record_write_start),
        }
    }

    pub fn noop() -> Self {
        Self::new(|| Ok(()))
    }

    fn record_write_start(&self) -> io::Result<()> {
        (self.record_write_start)()
    }
}

impl Default for FrameWriteObserver {
    fn default() -> Self {
        Self::noop()
    }
}

/// Opaque guard that fences new normal guest operations on a [`VsockHost`].
///
/// While this guard is alive, normal operations such as exec, file transfer, and
/// spawn-process requests are rejected by the host-side operation tracker.
/// Lifecycle requests such as quiesce/resume are not normal operations and can
/// still be sent while the guard is held.
#[derive(Debug)]
pub struct NormalOperationFence {
    _inner: operation_tracker::NormalOperationFence,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalOperationFenceRejection {
    Busy,
    AlreadyFenced,
    NotParkable,
    Closed,
}

impl From<TrackerNormalOperationFenceRejection> for NormalOperationFenceRejection {
    fn from(error: TrackerNormalOperationFenceRejection) -> Self {
        match error {
            TrackerNormalOperationFenceRejection::Busy => Self::Busy,
            TrackerNormalOperationFenceRejection::AlreadyFenced => Self::AlreadyFenced,
            TrackerNormalOperationFenceRejection::NotParkable => Self::NotParkable,
            TrackerNormalOperationFenceRejection::Closed => Self::Closed,
        }
    }
}

/// Result of executing a command on the guest.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Request parameters for spawning a process on the guest.
pub struct ProcessSpawnRequest<'a> {
    pub command: &'a str,
    pub timeout_ms: u32,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub stream_stdout: bool,
    pub stdout_log_path: Option<&'a str>,
}

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
enum ConnectionState {
    Connected {
        /// Pending request responses: seq → response route.
        pending: HashMap<u32, PendingResponse>,
        /// Active exec-operation state owned by the exec_operation module.
        operations: exec_operation::Operations,
        /// Active spawn_process operation state owned by the process module.
        process: process::ConnectedProcessState,
    },
    Closed {
        /// Empty process state marker after connection close.
        _process: process::ClosedProcessState,
    },
}

/// Shared state between the reader task and public API methods.
struct Shared {
    /// Serialises writes to the stream.
    writer: tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    /// Raw fd of the underlying socket, used to poison a corrupted stream.
    fd: RawFd,
    /// Monotonically increasing sequence number (starts at 2, skips 0).
    /// Handshake uses seq=1 before Shared is created, so post-handshake
    /// sequences start at 2 to avoid collisions.
    seq: AtomicU32,
    /// Single source of truth for connection liveness plus all per-connection
    /// registration tables. See [`ConnectionState`].
    state: std::sync::Mutex<ConnectionState>,
    /// Connection-local tracker for logical normal guest operations.
    ///
    /// Routing maps stay inside [`ConnectionState`]; this tracker records the
    /// neutral operation-readiness facts that sandbox policy can consume later.
    normal_operations: NormalOperationTracker,
    /// Notified when the connection closes. Pure signalling — all state is in
    /// `state`.
    close_notify: Notify,
}

struct ListenerSocketGuard {
    path: Option<String>,
}

impl ListenerSocketGuard {
    fn remove(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for ListenerSocketGuard {
    fn drop(&mut self) {
        self.remove();
    }
}

struct PendingRequestGuard {
    shared: Arc<Shared>,
    seq: u32,
}

struct PendingResponse {
    response_tx: oneshot::Sender<RawMessage>,
    normal_operation: Option<PendingNormalOperation>,
    normal_terminal_msg_types: &'static [u8],
}

enum PendingNormalOperation {
    Owned(NormalOperationToken),
    Composite(NormalOperationTransitionHandle),
}

struct RequestWriteGuard {
    shared: Arc<Shared>,
    write_started: bool,
    write_returned: bool,
}

impl PendingRequestGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self { shared, seq }
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        self.shared.remove_pending(self.seq);
    }
}

impl RequestWriteGuard {
    fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            write_started: false,
            write_returned: false,
        }
    }

    fn mark_started(&mut self) {
        self.write_started = true;
    }

    fn mark_returned(&mut self) {
        self.write_returned = true;
    }
}

impl Drop for RequestWriteGuard {
    fn drop(&mut self) {
        if self.write_started && !self.write_returned {
            self.shared.poison_connection();
        }
    }
}

impl Shared {
    /// Get next sequence number, skipping 0 (reserved for unsolicited messages).
    fn next_seq(&self) -> u32 {
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
            match std::mem::replace(
                &mut *guard,
                ConnectionState::Closed {
                    _process: process::ClosedProcessState::empty(),
                },
            ) {
                ConnectionState::Connected {
                    pending,
                    operations,
                    process,
                } => {
                    // Serialize tracker close/poison with terminal dispatch,
                    // which completes tracker tokens under this same state lock.
                    match kind {
                        ConnectionCloseKind::Closed => self.normal_operations.mark_closed(),
                        ConnectionCloseKind::Poisoned => self.normal_operations.mark_not_parkable(),
                    }
                    let exec_operation_snapshot = operations.close_snapshot();
                    let (closed_process, process_maps) = process.close();
                    *guard = ConnectionState::Closed {
                        _process: closed_process,
                    };
                    Some((pending, process_maps, operations, exec_operation_snapshot))
                }
                closed @ ConnectionState::Closed { .. } => {
                    // Reassign the whole variant by binding rather than by
                    // convention.
                    *guard = closed;
                    None
                }
            }
        };
        if let Some((pending, process_maps, operations, exec_operation_snapshot)) = maps_to_drop {
            let maps = (pending, process_maps, operations);
            drop(maps);
            self.close_notify.notify_waiters();
            exec_operation::log_operations_closed(reason, &exec_operation_snapshot);
        }
    }

    fn poison_connection(&self) {
        self.close_with_reason("connection poisoned", ConnectionCloseKind::Poisoned);
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
    }

    fn remove_pending(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { pending, .. } = &mut *guard {
            pending.remove(&seq);
        }
    }

    fn remove_operation(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard {
            operations.remove(seq);
        }
    }

    fn reserve_normal_operation(&self) -> io::Result<NormalOperationToken> {
        self.normal_operations
            .reserve()
            .map_err(normal_operation_rejection_error)
    }
}

pub(crate) struct CompositeNormalOperation {
    normal_operation: Option<NormalOperationToken>,
}

impl CompositeNormalOperation {
    fn reserve(shared: &Arc<Shared>) -> io::Result<Self> {
        Ok(Self {
            normal_operation: Some(shared.reserve_normal_operation()?),
        })
    }

    fn transition_handle(&self) -> io::Result<NormalOperationTransitionHandle> {
        self.normal_operation
            .as_ref()
            .map(NormalOperationToken::transition_handle)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "composite normal operation already completed",
                )
            })
    }

    fn mark_possible_guest_write_started(&mut self) -> io::Result<()> {
        let normal_operation = self.normal_operation.as_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "composite normal operation already completed",
            )
        })?;
        normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error)?;
        Ok(())
    }

    fn complete(mut self) -> io::Result<()> {
        let normal_operation = self.normal_operation.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "composite normal operation already completed",
            )
        })?;
        // Terminal proof can race with connection close, which clears tracker
        // operations. Completion is idempotent for the composite owner.
        match normal_operation.complete() {
            Ok(()) | Err(NormalOperationTransitionError::UnknownOperation { .. }) => Ok(()),
            Err(error) => Err(normal_operation_transition_error(error)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionCloseKind {
    Closed,
    Poisoned,
}

/// Host-side vsock endpoint.
///
/// Maintains a persistent connection to the guest agent and provides
/// high-level methods for command execution, file operations, and
/// process lifecycle management.
///
/// All public methods take `&self` and can be called concurrently.
/// A background reader task dispatches incoming messages to the
/// appropriate caller.
pub struct VsockHost {
    shared: Arc<Shared>,
    _reader: JoinHandle<()>,
    /// Raw fd of the underlying socket, used for shutdown on Drop.
    ///
    /// `shutdown(SHUT_RDWR)` does NOT close the fd — it only signals EOF,
    /// unblocking the reader_loop's async read and any remote peer's
    /// blocking read. The fd itself is still owned by the read/write halves
    /// and is closed normally when they are dropped.
    fd: RawFd,
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
/// Dispatches responses, exec operations, and spawn_process lifecycle frames
/// by seq number.
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
        let messages = match decoder.decode(buf.get(..n).unwrap_or_default()) {
            Ok(msgs) => msgs,
            Err(_) => break,
        };
        for msg in messages {
            if msg.msg_type == MSG_ERROR {
                // Intercept active exec-operation errors before the legacy
                // pending-request dispatch. If no exec operation owns this
                // seq, the error falls through as a normal request response.
                match exec_operation::dispatch_error(&shared, &msg) {
                    Ok(true) => {
                        continue;
                    }
                    Ok(false) => {}
                    Err(_) => {
                        shared.poison_connection();
                        return;
                    }
                }
                if process::record_spawn_process_error(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            }

            if msg.msg_type == MSG_EXEC_OUTPUT {
                if exec_operation::dispatch_output(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_EXEC_STARTED {
                if exec_operation::dispatch_started(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_EXEC_RESULT {
                if exec_operation::dispatch_result(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_EXEC_CONTROL_RESULT {
                if exec_operation::dispatch_control_result(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_STDOUT_CHUNK {
                if process::dispatch_stdout_chunk(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_PROCESS_EXIT {
                if process::dispatch_process_exit(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else {
                if msg.msg_type == MSG_SPAWN_PROCESS_RESULT
                    && process::record_spawn_process_result(&shared, &msg).is_err()
                {
                    shared.poison_connection();
                    return;
                }
                if msg.msg_type != MSG_SPAWN_PROCESS_RESULT
                    && process::reject_unexpected_process_response(&shared, msg.seq, msg.msg_type)
                        .is_err()
                {
                    shared.poison_connection();
                    return;
                }
                let mut normal_operation_transition_failed = false;
                let pending_response = {
                    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    match &mut *guard {
                        ConnectionState::Connected { pending, .. } => {
                            if let Some(mut pending_response) = pending.remove(&msg.seq) {
                                if pending_response
                                    .normal_terminal_msg_types
                                    .contains(&msg.msg_type)
                                    && let Some(normal_operation) =
                                        pending_response.normal_operation.take()
                                    && complete_pending_normal_operation(normal_operation).is_err()
                                {
                                    normal_operation_transition_failed = true;
                                }
                                Some(pending_response)
                            } else {
                                None
                            }
                        }
                        ConnectionState::Closed { .. } => None,
                    }
                };
                if normal_operation_transition_failed {
                    shared.poison_connection();
                    return;
                }
                if let Some(pending_response) = pending_response {
                    let _ = pending_response.response_tx.send(msg);
                }
            }
        }
    }
    // Connection lost — transition state to Closed. `close()` drops all
    // registration maps outside the lock (waking every pending receiver
    // with `RecvError`) and fires `close_notify` so test helpers wake.
    shared.close();
}

/// Send a request and wait for a response with matching sequence number.
async fn request_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    timeout: Duration,
) -> io::Result<RawMessage> {
    let seq = shared.next_seq();
    request_raw_on_shared(shared, msg_type, seq, payload, timeout).await
}

async fn write_request_frame(
    shared: &Arc<Shared>,
    data: &[u8],
    before_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let mut write_guard = RequestWriteGuard::new(Arc::clone(shared));
    let mut writer = shared.writer.lock().await;
    before_write()?;
    write_guard.mark_started();
    if let Err(error) = writer.write_all(data).await {
        write_guard.mark_returned();
        shared.poison_connection();
        return Err(error);
    }
    write_guard.mark_returned();
    Ok(())
}

/// Send a request with a pre-allocated sequence number.
async fn request_raw_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    timeout: Duration,
) -> io::Result<RawMessage> {
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    // Register under the state lock: `Closed` short-circuits to an
    // immediate error, and insertion into `pending` is serialised with
    // the `Connected -> Closed` transition in `close()`. There is no
    // post-write `is_closed` check because close is observed via the
    // oneshot receiver becoming `Closed` when `close()` drops the map.
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { pending, .. } => {
                pending.insert(
                    seq,
                    PendingResponse {
                        response_tx: tx,
                        normal_operation: None,
                        normal_terminal_msg_types: &[],
                    },
                );
            }
        }
    }
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    // The pending guard removes the pending entry on write failure, timeout,
    // or cancellation before reader_loop dispatches a response. The write
    // helper separately poisons the connection if cancellation interrupts an
    // in-progress frame write.
    write_request_frame(shared, &data, || Ok(())).await?;

    // `rx` returns `Ok(msg)` when the reader dispatches a response and
    // `Err(RecvError)` when `close()` drops the `Connected` variant. The
    // timeout arm is the only other way out.
    tokio::select! {
        biased;
        result = rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))
        }
        _ = tokio::time::sleep(timeout) => {
            Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
        }
    }
}

async fn normal_request_on_shared_with_write_observer(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
) -> io::Result<RawMessage> {
    normal_request_on_shared_with_pre_write_observer(
        shared,
        msg_type,
        payload,
        terminal_msg_types,
        timeout,
        |_| Ok(()),
        write_observer,
    )
    .await
}

async fn normal_request_on_shared_with_pre_write_observer(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    pre_write: impl FnOnce(&mut ConnectionState) -> io::Result<()>,
    write_observer: FrameWriteObserver,
) -> io::Result<RawMessage> {
    let seq = shared.next_seq();
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let normal_operation = shared.reserve_normal_operation()?;

    let (tx, rx) = oneshot::channel();
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { pending, .. } => {
                pending.insert(
                    seq,
                    PendingResponse {
                        response_tx: tx,
                        normal_operation: Some(PendingNormalOperation::Owned(normal_operation)),
                        normal_terminal_msg_types: terminal_msg_types,
                    },
                );
            }
        }
    }
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    write_request_frame(shared, &data, || {
        mark_pending_normal_operation_possible_guest_write(shared, seq, pre_write)?;
        write_observer.record_write_start()
    })
    .await?;

    tokio::select! {
        biased;
        result = rx => {
            result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
        }
        _ = tokio::time::sleep(timeout) => {
            Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
        }
    }
}

async fn request_on_shared_with_composite_operation_and_observer(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> io::Result<RawMessage> {
    let seq = shared.next_seq();
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    let (tx, rx) = oneshot::channel();
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { pending, .. } => {
                pending.insert(
                    seq,
                    PendingResponse {
                        response_tx: tx,
                        normal_operation: Some(PendingNormalOperation::Composite(
                            normal_operation.transition_handle()?,
                        )),
                        normal_terminal_msg_types: terminal_msg_types,
                    },
                );
            }
        }
    }
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    write_request_frame(shared, &data, || {
        normal_operation.mark_possible_guest_write_started()?;
        write_observer.record_write_start()
    })
    .await?;

    tokio::select! {
        biased;
        result = rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))
        }
        _ = tokio::time::sleep(timeout) => {
            Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
        }
    }
}

fn mark_pending_normal_operation_possible_guest_write(
    shared: &Arc<Shared>,
    seq: u32,
    pre_write: impl FnOnce(&mut ConnectionState) -> io::Result<()>,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    pre_write(&mut guard)?;
    match &mut *guard {
        ConnectionState::Connected { pending, .. } => {
            let Some(pending_response) = pending.get_mut(&seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "normal request closed before frame write",
                ));
            };
            let Some(normal_operation) = pending_response.normal_operation.as_mut() else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "normal request missing operation token",
                ));
            };
            mark_pending_normal_operation_possible_guest_write_started(normal_operation)
        }
        ConnectionState::Closed { .. } => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

fn mark_pending_normal_operation_possible_guest_write_started(
    normal_operation: &mut PendingNormalOperation,
) -> io::Result<()> {
    match normal_operation {
        PendingNormalOperation::Owned(normal_operation) => normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error),
        PendingNormalOperation::Composite(normal_operation) => normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error),
    }
}

fn complete_pending_normal_operation(normal_operation: PendingNormalOperation) -> io::Result<()> {
    match normal_operation {
        PendingNormalOperation::Owned(normal_operation) => normal_operation
            .complete()
            .map_err(normal_operation_transition_error),
        PendingNormalOperation::Composite(normal_operation) => normal_operation
            .mark_possible_guest_write_completed()
            .map_err(normal_operation_transition_error),
    }
}

fn normal_operation_rejection_error(error: NormalOperationRejection) -> io::Error {
    match error {
        NormalOperationRejection::Fenced => io::Error::new(
            io::ErrorKind::WouldBlock,
            "normal operations are currently fenced",
        ),
        NormalOperationRejection::NotParkable => io::Error::new(
            io::ErrorKind::ConnectionReset,
            "normal operations are not available on this connection",
        ),
        NormalOperationRejection::Closed => {
            io::Error::new(io::ErrorKind::ConnectionReset, "connection closed")
        }
    }
}

fn normal_operation_transition_error(error: NormalOperationTransitionError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("normal operation transition failed: {error:?}"),
    )
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn lifecycle_error_from_response(response: &RawMessage) -> io::Error {
    match vsock_proto::decode_error(&response.payload) {
        Ok(message) => io::Error::other(message.to_owned()),
        Err(error) => protocol_invalid_data(error),
    }
}

fn validate_empty_lifecycle_response(
    response: &RawMessage,
    payload_name: &'static str,
) -> io::Result<()> {
    vsock_proto::decode_empty_payload(payload_name, &response.payload)
        .map_err(protocol_invalid_data)
}

impl VsockHost {
    /// Wait for a guest to connect on the vsock UDS path.
    ///
    /// Creates a UDS listener at `{vsock_path}_{port}`, accepts the first
    /// connection, and performs the ready/ping/pong handshake.
    pub async fn wait_for_connection(vsock_path: &str, timeout: Duration) -> io::Result<Self> {
        let listener_path = format!("{vsock_path}_{}", vsock_proto::VSOCK_PORT);

        // Clean up stale socket
        let _ = std::fs::remove_file(&listener_path);

        let listener = UnixListener::bind(&listener_path)?;
        let mut listener_socket = ListenerSocketGuard {
            path: Some(listener_path.clone()),
        };
        let deadline = Instant::now() + timeout;

        let accept_result = time::timeout_at(deadline, listener.accept()).await;

        // Stop accepting and unlink the listener socket before the accepted
        // stream is handed off. The guard still covers cancellation before
        // this point.
        drop(listener);
        listener_socket.remove();

        let (stream, _) = accept_result.map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("guest connection timeout after {}ms", timeout.as_millis()),
            )
        })??;

        Self::from_stream(stream, deadline).await
    }

    /// Build a `VsockHost` from an already-connected stream.
    ///
    /// Performs the handshake on the unsplit stream, then splits it and
    /// spawns the background reader task.
    async fn from_stream(stream: UnixStream, deadline: Instant) -> io::Result<Self> {
        // Handshake on the unsplit stream (reader task not running yet).
        let (stream, handshake_decoder) = Self::handshake(stream, deadline).await?;

        // Grab the raw fd BEFORE splitting — used by Drop to shutdown the
        // socket and unblock any pending reads (both our reader_loop and the
        // remote peer).
        let fd = {
            use std::os::unix::io::AsRawFd;
            stream.as_raw_fd()
        };

        // Split the stream and spawn the reader task.
        let (read_half, write_half) = stream.into_split();

        let shared = Arc::new(Shared {
            writer: tokio::sync::Mutex::new(write_half),
            fd,
            seq: AtomicU32::new(2),
            state: std::sync::Mutex::new(ConnectionState::Connected {
                pending: HashMap::new(),
                operations: exec_operation::Operations::new(),
                process: process::ConnectedProcessState::new(),
            }),
            normal_operations: NormalOperationTracker::new(),
            close_notify: Notify::new(),
        });

        let reader_shared = Arc::clone(&shared);
        let reader = tokio::spawn(reader_loop(read_half, handshake_decoder, reader_shared));

        Ok(Self {
            shared,
            _reader: reader,
            fd,
        })
    }

    /// Perform the connection handshake: ready → ping → pong.
    ///
    /// Returns the stream and decoder for reuse by the reader task.
    async fn handshake(
        mut stream: UnixStream,
        deadline: Instant,
    ) -> io::Result<(UnixStream, Decoder)> {
        let mut decoder = Decoder::new();
        let mut buf = Box::new([0u8; READ_BUF_SIZE]);

        // Wait for ready
        Self::read_until_handshake(&mut stream, &mut decoder, &mut buf, deadline, |m| {
            m.msg_type == MSG_READY
        })
        .await?;

        // Send ping with a fixed seq. Shared.seq starts at 2 to avoid collision.
        let ping_seq: u32 = 1;
        let ping = vsock_proto::encode(MSG_PING, ping_seq, &[])
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        stream.write_all(&ping).await?;

        // Wait for pong with matching seq
        Self::read_until_handshake(&mut stream, &mut decoder, &mut buf, deadline, |m| {
            m.msg_type == MSG_PONG && m.seq == ping_seq
        })
        .await?;

        Ok((stream, decoder))
    }

    /// Read messages until one matches the predicate (used during handshake only).
    async fn read_until_handshake(
        stream: &mut UnixStream,
        decoder: &mut Decoder,
        buf: &mut [u8; READ_BUF_SIZE],
        deadline: Instant,
        predicate: impl Fn(&RawMessage) -> bool,
    ) -> io::Result<RawMessage> {
        loop {
            let n = time::timeout_at(deadline, stream.read(buf.as_mut()))
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "handshake timeout"))??;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed during handshake",
                ));
            }
            let messages = decoder
                .decode(buf.get(..n).unwrap_or_default())
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            for msg in messages {
                if predicate(&msg) {
                    return Ok(msg);
                }
            }
        }
    }

    /// Send a request and wait for a response with matching sequence number.
    async fn request(
        &self,
        msg_type: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<RawMessage> {
        request_on_shared(&self.shared, msg_type, payload, timeout).await
    }

    async fn lifecycle_request(
        &self,
        request_type: u8,
        expected_response_type: u8,
        response_payload_name: &'static str,
        timeout: Duration,
    ) -> io::Result<()> {
        let response = self.request(request_type, &[], timeout).await?;
        if response.msg_type == MSG_ERROR {
            return Err(lifecycle_error_from_response(&response));
        }
        if response.msg_type != expected_response_type {
            return Err(protocol_invalid_data(format!(
                "unexpected lifecycle response type: expected 0x{expected_response_type:02X}, got 0x{:02X}",
                response.msg_type,
            )));
        }
        validate_empty_lifecycle_response(&response, response_payload_name)
    }

    /// Try to fence new normal guest operations on this connection.
    ///
    /// The returned guard keeps normal operations fenced until it is dropped.
    /// Lifecycle requests such as [`quiesce_operations`](Self::quiesce_operations)
    /// and [`resume_operations`](Self::resume_operations) remain available while
    /// the guard is held.
    pub fn try_fence_normal_operations(
        &self,
    ) -> Result<NormalOperationFence, NormalOperationFenceRejection> {
        self.shared
            .normal_operations
            .try_fence()
            .map(|inner| NormalOperationFence { _inner: inner })
            .map_err(Into::into)
    }

    /// Ask the guest to quiesce its own operation dispatcher.
    ///
    /// This does not fence host-side normal operations. Callers that need a
    /// no-new-normal-operation boundary must hold a
    /// [`NormalOperationFence`] before sending this lifecycle request.
    pub async fn quiesce_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_QUIESCE_OPERATIONS,
            MSG_OPERATIONS_QUIESCED,
            "operations_quiesced payload must be empty",
            timeout,
        )
        .await
    }

    /// Resume guest operations after a failed or aborted quiesce attempt.
    pub async fn resume_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_RESUME_OPERATIONS,
            MSG_OPERATIONS_RESUMED,
            "operations_resumed payload must be empty",
            timeout,
        )
        .await
    }

    /// Start a request-scoped exec operation using the exec operation protocol.
    pub async fn start_exec_operation(
        &self,
        request: ExecOperationRequest<'_>,
    ) -> io::Result<ExecOperationHandle> {
        exec_operation::start_exec_operation_on_shared(&self.shared, request).await
    }

    /// Start a supervised exec operation and wait for its PID acknowledgement.
    pub async fn start_supervised_exec(
        &self,
        request: SupervisedExecRequest<'_>,
    ) -> io::Result<SupervisedExecHandle> {
        exec_operation::start_supervised_exec_on_shared(&self.shared, request).await
    }

    /// Run a capture-only exec operation with default capture limits.
    pub async fn exec_operation_capture_default(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        label: &str,
        wait_timeout: Duration,
    ) -> io::Result<ExecOperationResult> {
        self.exec_operation_capture(ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label,
            stdout_limit_bytes: exec_operation::DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: exec_operation::DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            wait_timeout,
        })
        .await
    }

    /// Run a capture-only exec operation with explicit stdout/stderr limits.
    pub async fn exec_operation_capture(
        &self,
        request: ExecCaptureRequest<'_>,
    ) -> io::Result<ExecOperationResult> {
        exec_operation::exec_operation_capture_on_shared(&self.shared, request).await
    }

    /// Start a streaming exec operation with a bounded output event receiver.
    pub async fn exec_operation_stream(
        &self,
        request: ExecStreamRequest<'_>,
    ) -> io::Result<ExecOperationHandle> {
        exec_operation::exec_operation_stream_on_shared(&self.shared, request).await
    }

    /// Execute a command on the guest.
    ///
    /// `timeout_ms` must be positive. Callers needing unbounded commands
    /// should use [`spawn_process`](Self::spawn_process), which decouples the
    /// host request/response cycle from the command's lifetime and keeps
    /// host-side lifecycle tracking until the guest reports process exit.
    pub async fn exec(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
    ) -> io::Result<ExecResult> {
        exec_operation::exec_on_shared(&self.shared, command, timeout_ms, env, sudo).await
    }

    /// Execute a capture-style command with explicit output limits.
    pub async fn exec_capture(&self, request: ExecCaptureRequest<'_>) -> io::Result<ExecResult> {
        exec_operation::exec_capture_on_shared(&self.shared, request).await
    }

    /// Execute a capture-style command and report when its start frame is
    /// about to be written to the guest.
    pub async fn exec_capture_with_write_observer(
        &self,
        request: ExecCaptureRequest<'_>,
        write_observer: FrameWriteObserver,
    ) -> io::Result<ExecResult> {
        exec_operation::exec_capture_on_shared_with_write_observer(
            &self.shared,
            request,
            write_observer,
        )
        .await
    }

    /// Spawn a process on the guest and monitor for exit.
    ///
    /// Returns immediately with a handle. Use [`GuestProcessHandle::wait`] to
    /// wait for completion. Dropping the handle does not cancel the guest
    /// process; the host continues tracking lifecycle frames until process exit
    /// or connection close.
    ///
    /// When `stream_stdout` is true, stdout chunks are streamed to the host via
    /// `MSG_STDOUT_CHUNK`. `stdout_log_path`, when present, additionally asks
    /// the guest to tee those chunks into the given guest-side file.
    /// Use [`GuestProcessHandle::take_stdout_receiver`] to receive streamed chunks
    /// when enabled. The receiver is closed when the process exits or the
    /// connection drops.
    pub async fn spawn_process(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        stream_stdout: bool,
        stdout_log_path: Option<&str>,
    ) -> io::Result<GuestProcessHandle> {
        self.spawn_process_with_request_and_write_observer(
            ProcessSpawnRequest {
                command,
                timeout_ms,
                env,
                sudo,
                stream_stdout,
                stdout_log_path,
            },
            FrameWriteObserver::default(),
        )
        .await
    }

    /// Spawn a process and report when its request frame is about to be
    /// written to the guest.
    pub async fn spawn_process_with_request_and_write_observer(
        &self,
        request: ProcessSpawnRequest<'_>,
        write_observer: FrameWriteObserver,
    ) -> io::Result<GuestProcessHandle> {
        let ProcessSpawnRequest {
            command,
            timeout_ms,
            env,
            sudo,
            stream_stdout,
            stdout_log_path,
        } = request;
        process::spawn_process_on_shared(
            &self.shared,
            process::SpawnProcessOnSharedRequest {
                command,
                timeout_ms,
                env,
                sudo,
                stream_stdout,
                stdout_log_path,
                control_sink: false,
                write_observer,
            },
        )
        .await
    }

    /// Spawn a process with an operation-bound control sink available to the
    /// guest process.
    pub async fn spawn_process_with_control_sink(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        stream_stdout: bool,
        stdout_log_path: Option<&str>,
    ) -> io::Result<GuestProcessHandle> {
        self.spawn_process_with_control_sink_request_and_write_observer(
            ProcessSpawnRequest {
                command,
                timeout_ms,
                env,
                sudo,
                stream_stdout,
                stdout_log_path,
            },
            FrameWriteObserver::default(),
        )
        .await
    }

    /// Spawn a process with an operation-bound control sink and report when
    /// its request frame is about to be written to the guest.
    pub async fn spawn_process_with_control_sink_request_and_write_observer(
        &self,
        request: ProcessSpawnRequest<'_>,
        write_observer: FrameWriteObserver,
    ) -> io::Result<GuestProcessHandle> {
        let ProcessSpawnRequest {
            command,
            timeout_ms,
            env,
            sudo,
            stream_stdout,
            stdout_log_path,
        } = request;
        process::spawn_process_on_shared(
            &self.shared,
            process::SpawnProcessOnSharedRequest {
                command,
                timeout_ms,
                env,
                sudo,
                stream_stdout,
                stdout_log_path,
                control_sink: true,
                write_observer,
            },
        )
        .await
    }

    /// Request graceful shutdown from guest.
    ///
    /// Returns `true` if guest acknowledged, `false` on timeout.
    pub async fn shutdown(&self, timeout: Duration) -> bool {
        let result = self.request(MSG_SHUTDOWN, &[], timeout).await;
        matches!(result, Ok(ref m) if m.msg_type == MSG_SHUTDOWN_ACK)
    }
}

#[cfg(test)]
impl VsockHost {
    /// Test-only: deterministically await the `Connected → Closed` transition
    /// without relying on a wall-clock sleep. Subscribes to the same
    /// `close_notify` signal that [`Shared::close`] fires on exit, and re-checks
    /// state under the same lock that `close` holds, so no transition is
    /// missed.
    async fn wait_until_closed(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            let notified = self.shared.close_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if matches!(
                &*self.shared.state.lock().unwrap_or_else(|e| e.into_inner()),
                ConnectionState::Closed { .. }
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
