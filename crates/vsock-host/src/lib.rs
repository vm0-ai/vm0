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

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};

use vsock_proto::{
    BoundedExecStream as ProtoBoundedExecStream,
    BoundedExecTermination as ProtoBoundedExecTermination, Decoder, MSG_BOUNDED_EXEC,
    MSG_BOUNDED_EXEC_OUTPUT_CHUNK, MSG_BOUNDED_EXEC_RESULT, MSG_ERROR, MSG_EXEC, MSG_EXEC_RESULT,
    MSG_PING, MSG_PONG, MSG_PROCESS_EXIT, MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK,
    MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, RawMessage,
};

const READ_BUF_SIZE: usize = 64 * 1024;

/// Result of executing a command on the guest.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Event emitted when a spawned process exits.
#[derive(Debug, Clone)]
pub struct ProcessExitEvent {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BoundedExecStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BoundedExecTermination {
    Exited { exit_code: i32 },
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BoundedExecOutputEvent {
    pub stream: BoundedExecStream,
    pub sequence: u32,
    pub chunk: Vec<u8>,
    pub truncated: bool,
}

pub struct BoundedExecStreamRequest {
    pub event_tx: mpsc::UnboundedSender<BoundedExecOutputEvent>,
    pub stdout: bool,
    pub stderr: bool,
    pub chunk_limit_bytes: u32,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
}

pub struct BoundedExecRequest<'a> {
    pub command: &'a str,
    pub timeout_ms: u32,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub stdin: Option<&'a [u8]>,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
    pub stream: Option<BoundedExecStreamRequest>,
}

#[derive(Debug, Clone)]
pub struct BoundedExecResult {
    pub termination: BoundedExecTermination,
    pub duration_ms: u64,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Clone)]
struct BoundedOutputRegistration {
    event_tx: mpsc::UnboundedSender<BoundedExecOutputEvent>,
    stdout: bool,
    stderr: bool,
}

impl BoundedOutputRegistration {
    fn allows(&self, stream: BoundedExecStream) -> bool {
        match stream {
            BoundedExecStream::Stdout => self.stdout,
            BoundedExecStream::Stderr => self.stderr,
        }
    }
}

/// Connection lifecycle, expressed as data rather than a separate atomic flag.
///
/// The request and stream registration maps live inside the `Connected`
/// variant so they are structurally unreachable once the reader task has
/// exited. `exits` lives in BOTH variants because it is an observation log —
/// a cached exit event remains a valid answer to `wait_for_exit` after the
/// connection closes.
///
/// The invariant "connection is closed ⇔ registrations are impossible" is
/// enforced by the type: every code path that cares about liveness must
/// `match`, which precludes the old footgun of reading a stale close flag
/// without taking the corresponding lock.
enum ConnectionState {
    Connected {
        /// Pending request responses: seq → oneshot sender.
        pending: HashMap<u32, oneshot::Sender<RawMessage>>,
        /// Pre-registered stdout senders: request seq → channel sender.
        /// `spawn_watch` inserts here BEFORE sending the request so that
        /// `reader_loop` can move the sender to `stdout_senders` atomically
        /// when it processes the `spawn_watch_result` — before any
        /// `stdout_chunk` for that pid is processed.
        pending_stdout: HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>,
        /// Stdout chunk senders: pid → channel sender.
        /// Populated by `reader_loop` when it processes `spawn_watch_result`,
        /// fed by `reader_loop` when it processes `stdout_chunk`.
        stdout_senders: HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>,
        /// Bounded exec output registrations: request seq → event sender and
        /// requested stream allow-list.
        /// Populated before sending a bounded exec request and fed directly
        /// by request-scoped bounded output chunk events.
        bounded_output_senders: HashMap<u32, BoundedOutputRegistration>,
        /// Cached process exit events (unsolicited, seq=0).
        exits: HashMap<u32, ProcessExitEvent>,
    },
    Closed {
        /// Preserved across the close transition: callers of `wait_for_exit`
        /// can still retrieve an exit event that was cached before close.
        exits: HashMap<u32, ProcessExitEvent>,
    },
}

/// Shared state between the reader task and public API methods.
struct Shared {
    /// Serialises writes to the stream.
    writer: tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    /// Monotonically increasing sequence number (starts at 2, skips 0).
    /// Handshake uses seq=1 before Shared is created, so post-handshake
    /// sequences start at 2 to avoid collisions.
    seq: AtomicU32,
    /// Single source of truth for connection liveness plus all per-connection
    /// registration tables. See [`ConnectionState`].
    state: std::sync::Mutex<ConnectionState>,
    /// Notified when a new exit event lands in `exits` or when the connection
    /// closes. Pure signalling — all state is in `state`.
    exit_notify: Notify,
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

struct PendingStdoutGuard {
    shared: Arc<Shared>,
    seq: u32,
}

impl PendingStdoutGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self { shared, seq }
    }
}

impl Drop for PendingStdoutGuard {
    fn drop(&mut self) {
        self.shared.remove_pending_stdout(self.seq);
    }
}

struct ChunkedWriteCleanupGuard {
    shared: Option<Arc<Shared>>,
    command: String,
    sudo: bool,
}

impl ChunkedWriteCleanupGuard {
    fn new(shared: Arc<Shared>, command: String, sudo: bool) -> Self {
        Self {
            shared: Some(shared),
            command,
            sudo,
        }
    }

    fn disarm(&mut self) {
        self.shared = None;
    }

    async fn cleanup_now(&mut self) {
        if let Some(shared) = self.shared.as_ref() {
            let _ = exec_cleanup_on_shared(
                shared,
                &self.command,
                VsockHost::CLEANUP_EXEC_TIMEOUT_MS,
                &[],
                self.sudo,
            )
            .await;
        }
        self.disarm();
    }
}

impl Drop for ChunkedWriteCleanupGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else {
            return;
        };

        let command = std::mem::take(&mut self.command);
        let sudo = self.sudo;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = exec_cleanup_on_shared(
                    &shared,
                    &command,
                    VsockHost::CLEANUP_EXEC_TIMEOUT_MS,
                    &[],
                    sudo,
                )
                .await;
            });
        }
    }
}

struct PendingBoundedOutputGuard {
    shared: Arc<Shared>,
    seq: u32,
}

impl PendingBoundedOutputGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self { shared, seq }
    }
}

impl Drop for PendingBoundedOutputGuard {
    fn drop(&mut self) {
        self.shared.remove_bounded_output_sender(self.seq);
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

    /// Transition `Connected → Closed`, preserving the cached `exits` map and
    /// dropping the registration tables outside the state lock so that
    /// oneshot/mpsc sender drops (which wake their receivers) run without the
    /// lock held. Idempotent: a second call preserves whatever `exits` the
    /// first call cached and performs no further work.
    ///
    /// `mem::replace` writes a placeholder `Closed { exits: HashMap::new() }`
    /// so the old variant can be moved out for destructuring. The `Connected`
    /// arm rebuilds `Closed` with the cached `exits`; the already-`Closed`
    /// arm uses an `@` binding to write the whole variant back unchanged, so
    /// "cached `exits` survive a double-close" is enforced by the match
    /// binding rather than by convention.
    fn close(&self) {
        let maps_to_drop = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match std::mem::replace(
                &mut *guard,
                ConnectionState::Closed {
                    exits: HashMap::new(),
                },
            ) {
                ConnectionState::Connected {
                    pending,
                    pending_stdout,
                    stdout_senders,
                    bounded_output_senders,
                    exits,
                } => {
                    *guard = ConnectionState::Closed { exits };
                    Some((
                        pending,
                        pending_stdout,
                        stdout_senders,
                        bounded_output_senders,
                    ))
                }
                closed @ ConnectionState::Closed { .. } => {
                    // Reassign the whole variant; cached `exits` preserved
                    // by binding, not manually reconstructed.
                    *guard = closed;
                    None
                }
            }
        };
        if let Some(maps) = maps_to_drop {
            drop(maps);
            self.exit_notify.notify_waiters();
        }
    }

    fn remove_pending(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { pending, .. } = &mut *guard {
            pending.remove(&seq);
        }
    }

    fn remove_pending_stdout(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { pending_stdout, .. } = &mut *guard {
            pending_stdout.remove(&seq);
        }
    }

    fn remove_bounded_output_sender(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected {
            bounded_output_senders,
            ..
        } = &mut *guard
        {
            bounded_output_senders.remove(&seq);
        }
    }
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
    fd: std::os::unix::io::RawFd,
}

impl Drop for VsockHost {
    fn drop(&mut self) {
        // Signal EOF on the socket so the reader_loop's `read()` and the
        // remote peer's blocking `read()` return immediately. Without this,
        // the split stream halves keep the fd alive until the reader task is
        // cancelled, which requires an async yield — not possible in Drop.
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
        self._reader.abort();
    }
}

fn proto_stream_to_host(stream: ProtoBoundedExecStream) -> BoundedExecStream {
    match stream {
        ProtoBoundedExecStream::Stdout => BoundedExecStream::Stdout,
        ProtoBoundedExecStream::Stderr => BoundedExecStream::Stderr,
    }
}

fn proto_termination_to_host(termination: ProtoBoundedExecTermination) -> BoundedExecTermination {
    match termination {
        ProtoBoundedExecTermination::Exited { exit_code } => {
            BoundedExecTermination::Exited { exit_code }
        }
        ProtoBoundedExecTermination::TimedOut => BoundedExecTermination::TimedOut,
        ProtoBoundedExecTermination::Cancelled => BoundedExecTermination::Cancelled,
        ProtoBoundedExecTermination::StartFailed => BoundedExecTermination::StartFailed,
        ProtoBoundedExecTermination::WaitFailed => BoundedExecTermination::WaitFailed,
    }
}

fn validate_bounded_exec_request(request: &BoundedExecRequest<'_>) -> io::Result<()> {
    if request.timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bounded_exec requires a positive timeout",
        ));
    }

    let total_output_limit = (request.stdout_limit_bytes as usize)
        .checked_add(request.stderr_limit_bytes as usize)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "bounded_exec final output limits overflow",
            )
        })?;
    if total_output_limit > vsock_proto::MAX_BOUNDED_EXEC_RESULT_OUTPUT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "bounded_exec final output limits exceed protocol result frame: {} > {}",
                total_output_limit,
                vsock_proto::MAX_BOUNDED_EXEC_RESULT_OUTPUT_BYTES
            ),
        ));
    }

    if let Some(stream) = &request.stream
        && (stream.stdout || stream.stderr)
    {
        let chunk_limit = stream.chunk_limit_bytes as usize;
        if chunk_limit < vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "bounded_exec stream chunk limit below minimum: {} < {}",
                    stream.chunk_limit_bytes,
                    vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES
                ),
            ));
        }
        if chunk_limit > vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "bounded_exec stream chunk limit exceeds protocol frame: {} > {}",
                    stream.chunk_limit_bytes,
                    vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES
                ),
            ));
        }
    }

    Ok(())
}

/// Background reader task: owns the read half and decoder exclusively.
///
/// Dispatches responses to pending requests by seq number, and caches
/// unsolicited process_exit events for `wait_for_exit`.
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
            if msg.msg_type == MSG_STDOUT_CHUNK && msg.seq == 0 {
                if let Ok((pid, data)) = vsock_proto::decode_stdout_chunk(&msg.payload) {
                    let sender = {
                        let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        match &*guard {
                            ConnectionState::Connected { stdout_senders, .. } => {
                                stdout_senders.get(&pid).cloned()
                            }
                            ConnectionState::Closed { .. } => None,
                        }
                    };
                    if let Some(tx) = sender {
                        // Best-effort: if receiver is dropped, remove sender.
                        if tx.send(data.to_vec()).is_err() {
                            let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                            if let ConnectionState::Connected { stdout_senders, .. } = &mut *guard {
                                stdout_senders.remove(&pid);
                            }
                        }
                    }
                }
            } else if msg.msg_type == MSG_PROCESS_EXIT && msg.seq == 0 {
                if let Ok((pid, exit_code, stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                {
                    let event = ProcessExitEvent {
                        pid,
                        exit_code,
                        stdout: stdout.to_vec(),
                        stderr: stderr.to_vec(),
                    };
                    {
                        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        if let ConnectionState::Connected {
                            stdout_senders,
                            exits,
                            ..
                        } = &mut *guard
                        {
                            // Close stdout channel for this pid (if any).
                            stdout_senders.remove(&pid);
                            exits.insert(pid, event);
                        }
                    }
                    shared.exit_notify.notify_waiters();
                }
            } else if msg.msg_type == MSG_BOUNDED_EXEC_OUTPUT_CHUNK && msg.seq != 0 {
                if let Ok(decoded) = vsock_proto::decode_bounded_exec_output_chunk(&msg.payload) {
                    let stream = proto_stream_to_host(decoded.stream);
                    let registration = {
                        let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        match &*guard {
                            ConnectionState::Connected {
                                bounded_output_senders,
                                ..
                            } => bounded_output_senders.get(&msg.seq).cloned(),
                            ConnectionState::Closed { .. } => None,
                        }
                    };
                    if let Some(registration) = registration {
                        if !registration.allows(stream) {
                            continue;
                        }
                        let event = BoundedExecOutputEvent {
                            stream,
                            sequence: decoded.sequence,
                            chunk: decoded.chunk.to_vec(),
                            truncated: decoded.truncated,
                        };
                        if registration.event_tx.send(event).is_err() {
                            shared.remove_bounded_output_sender(msg.seq);
                        }
                    }
                }
            } else {
                // For spawn_watch_result: move the pre-registered stdout sender
                // from pending_stdout to stdout_senders BEFORE dispatching the
                // response — under one lock so the channel is keyed by pid in
                // stdout_senders before any subsequent MSG_STDOUT_CHUNK arrives.
                let response_sender = {
                    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    match &mut *guard {
                        ConnectionState::Connected {
                            pending,
                            pending_stdout,
                            stdout_senders,
                            bounded_output_senders,
                            ..
                        } => {
                            if msg.msg_type == MSG_SPAWN_WATCH_RESULT
                                && let Ok(pid) =
                                    vsock_proto::decode_spawn_watch_result(&msg.payload)
                                && let Some(tx) = pending_stdout.remove(&msg.seq)
                            {
                                stdout_senders.insert(pid, tx);
                            }
                            bounded_output_senders.remove(&msg.seq);
                            pending.remove(&msg.seq)
                        }
                        ConnectionState::Closed { .. } => None,
                    }
                };
                if let Some(tx) = response_sender {
                    let _ = tx.send(msg);
                }
            }
        }
    }
    // Connection lost — transition state to Closed. `close()` drops all
    // registration maps outside the lock (waking every pending receiver
    // with `RecvError`) and fires `exit_notify` so `wait_for_exit` wakes.
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
                pending.insert(seq, tx);
            }
        }
    }
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    // The guard removes the pending entry on write failure, timeout, or
    // cancellation before reader_loop dispatches a response.
    shared.writer.lock().await.write_all(&data).await?;

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

async fn exec_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<ExecResult> {
    let request_timeout = Duration::from_millis(timeout_ms as u64 + 5000);
    exec_on_shared_with_request_timeout(shared, command, timeout_ms, env, sudo, request_timeout)
        .await
}

async fn exec_cleanup_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<ExecResult> {
    exec_on_shared_with_request_timeout(
        shared,
        command,
        timeout_ms,
        env,
        sudo,
        Duration::from_millis(timeout_ms as u64),
    )
    .await
}

async fn exec_on_shared_with_request_timeout(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    request_timeout: Duration,
) -> io::Result<ExecResult> {
    if timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec requires a positive timeout; use spawn_watch for unbounded commands",
        ));
    }
    let payload = vsock_proto::encode_exec(timeout_ms, command, env, sudo);
    let resp = request_on_shared(shared, MSG_EXEC, &payload, request_timeout).await?;

    if resp.msg_type == MSG_ERROR {
        let msg = vsock_proto::decode_error(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        return Ok(ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: msg.as_bytes().to_vec(),
        });
    }

    if resp.msg_type != MSG_EXEC_RESULT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected response type: 0x{:02X}", resp.msg_type),
        ));
    }

    let (exit_code, stdout, stderr) = vsock_proto::decode_exec_result(&resp.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    Ok(ExecResult {
        exit_code,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    })
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
            seq: AtomicU32::new(2),
            state: std::sync::Mutex::new(ConnectionState::Connected {
                pending: HashMap::new(),
                pending_stdout: HashMap::new(),
                stdout_senders: HashMap::new(),
                bounded_output_senders: HashMap::new(),
                exits: HashMap::new(),
            }),
            exit_notify: Notify::new(),
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

    /// Send a request with a pre-allocated sequence number.
    ///
    /// Used by [`spawn_watch`](Self::spawn_watch) which needs the seq to
    /// pre-register the stdout channel before sending the request.
    async fn request_raw(
        &self,
        msg_type: u8,
        seq: u32,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<RawMessage> {
        request_raw_on_shared(&self.shared, msg_type, seq, payload, timeout).await
    }

    /// Execute a command on the guest.
    ///
    /// `timeout_ms` must be positive. Callers needing unbounded commands
    /// should use [`spawn_watch`](Self::spawn_watch), which decouples the
    /// host request/response cycle from the command's lifetime and does not
    /// leak a guest-side orphan when the host stops waiting.
    pub async fn exec(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
    ) -> io::Result<ExecResult> {
        exec_on_shared(&self.shared, command, timeout_ms, env, sudo).await
    }

    /// Execute a command on the guest using the bounded exec protocol.
    ///
    /// This is request/response scoped like [`exec`](Self::exec), but it
    /// returns structured termination, bounded final buffers, and optional
    /// request-scoped stdout/stderr stream events.
    pub async fn bounded_exec(
        &self,
        request: &BoundedExecRequest<'_>,
    ) -> io::Result<BoundedExecResult> {
        validate_bounded_exec_request(request)?;

        let stream_stdout = request.stream.as_ref().is_some_and(|s| s.stdout);
        let stream_stderr = request.stream.as_ref().is_some_and(|s| s.stderr);
        let stream_chunk_limit_bytes = request.stream.as_ref().map_or(0, |s| s.chunk_limit_bytes);
        let stdout_stream_limit_bytes = request.stream.as_ref().map_or(0, |s| s.stdout_limit_bytes);
        let stderr_stream_limit_bytes = request.stream.as_ref().map_or(0, |s| s.stderr_limit_bytes);

        let proto_request = vsock_proto::BoundedExecRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            stdin: request.stdin,
            stdout_limit_bytes: request.stdout_limit_bytes,
            stderr_limit_bytes: request.stderr_limit_bytes,
            stream_stdout,
            stream_stderr,
            stream_chunk_limit_bytes,
            stdout_stream_limit_bytes,
            stderr_stream_limit_bytes,
        };
        let payload = vsock_proto::encode_bounded_exec(&proto_request)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

        let seq = self.shared.next_seq();
        let data = vsock_proto::encode(MSG_BOUNDED_EXEC, seq, &payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *guard {
                ConnectionState::Closed { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
                ConnectionState::Connected {
                    pending,
                    bounded_output_senders,
                    ..
                } => {
                    pending.insert(seq, tx);
                    if let Some(stream) = &request.stream
                        && (stream.stdout || stream.stderr)
                    {
                        bounded_output_senders.insert(
                            seq,
                            BoundedOutputRegistration {
                                event_tx: stream.event_tx.clone(),
                                stdout: stream.stdout,
                                stderr: stream.stderr,
                            },
                        );
                    }
                }
            }
        }
        let _pending_guard = PendingRequestGuard::new(Arc::clone(&self.shared), seq);
        let _bounded_output_guard = request.stream.as_ref().and_then(|stream| {
            (stream.stdout || stream.stderr)
                .then(|| PendingBoundedOutputGuard::new(Arc::clone(&self.shared), seq))
        });

        self.shared.writer.lock().await.write_all(&data).await?;

        let timeout = Duration::from_millis(request.timeout_ms as u64 + 5000);
        let resp = tokio::select! {
            biased;
            result = rx => {
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))?
            }
            _ = tokio::time::sleep(timeout) => {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"));
            }
        };

        if resp.msg_type == MSG_ERROR {
            let msg = vsock_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(io::Error::other(msg));
        }

        if resp.msg_type != MSG_BOUNDED_EXEC_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let decoded = vsock_proto::decode_bounded_exec_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        Ok(BoundedExecResult {
            termination: proto_termination_to_host(decoded.termination),
            duration_ms: decoded.duration_ms,
            stdout: decoded.stdout.to_vec(),
            stderr: decoded.stderr.to_vec(),
            stdout_truncated: decoded.stdout_truncated,
            stderr_truncated: decoded.stderr_truncated,
        })
    }

    /// Maximum content per write_file message.  Leaves headroom below
    /// [`vsock_proto::MAX_MESSAGE_SIZE`] for the path and frame overhead.
    const WRITE_FILE_CHUNK_LIMIT: usize = 15 * 1024 * 1024;

    /// Timeout (ms) for short helper commands (mv, rm) used during chunked writes.
    const HELPER_EXEC_TIMEOUT_MS: u32 = 5000;

    /// Shorter timeout (ms) for best-effort cleanup when the connection may
    /// already be broken.  Avoids blocking for a full 5 s on a dead socket.
    const CLEANUP_EXEC_TIMEOUT_MS: u32 = 1000;

    /// Write a file on the guest.
    ///
    /// Content larger than 15 MB is automatically split into multiple
    /// messages using the `WRITE_FILE_FLAG_APPEND` protocol flag. Chunks are written
    /// to a temporary file and atomically renamed to the target path after
    /// the last chunk succeeds, so a partial transfer never leaves a
    /// truncated file at the destination.
    ///
    /// Non-sudo writes create missing parent directories on the guest.
    pub async fn write_file(&self, path: &str, content: &[u8], sudo: bool) -> io::Result<()> {
        if content.len() <= Self::WRITE_FILE_CHUNK_LIMIT {
            return self.write_file_chunk(path, content, sudo, false).await;
        }

        // Write chunks to a per-call temp file, then atomic rename. The
        // suffix prevents concurrent large writes to the same destination
        // from appending to or cleaning up each other's staging file.
        let tmp = format!("{path}.vm0tmp-{}", self.shared.next_seq());
        let escaped_tmp = tmp.replace('\'', "'\\''");
        let rm_tmp = format!("rm -f -- '{escaped_tmp}'");
        let mut cleanup_guard =
            ChunkedWriteCleanupGuard::new(Arc::clone(&self.shared), rm_tmp, sudo);

        let result = async {
            for (i, chunk) in content.chunks(Self::WRITE_FILE_CHUNK_LIMIT).enumerate() {
                self.write_file_chunk(&tmp, chunk, sudo, i > 0).await?;
            }
            io::Result::Ok(())
        }
        .await;

        if result.is_err() {
            // Best-effort cleanup of the temp file.
            cleanup_guard.cleanup_now().await;
            return result;
        }

        // Atomic rename temp → target.
        let escaped_path = path.replace('\'', "'\\''");
        let mv_cmd = format!("mv -f -- '{escaped_tmp}' '{escaped_path}'");
        match self
            .exec(&mv_cmd, Self::HELPER_EXEC_TIMEOUT_MS, &[], sudo)
            .await
        {
            Ok(r) if r.exit_code == 0 => {
                cleanup_guard.disarm();
                Ok(())
            }
            Ok(r) => {
                cleanup_guard.cleanup_now().await;
                Err(io::Error::other(format!(
                    "failed to rename temp file to {path}: {}",
                    String::from_utf8_lossy(&r.stderr),
                )))
            }
            Err(e) => {
                // Connection likely broken — short timeout to avoid blocking.
                cleanup_guard.cleanup_now().await;
                Err(e)
            }
        }
    }

    /// Send a single write_file message and validate the response.
    async fn write_file_chunk(
        &self,
        path: &str,
        content: &[u8],
        sudo: bool,
        append: bool,
    ) -> io::Result<()> {
        let payload = vsock_proto::encode_write_file(path, content, sudo, append)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        let timeout = Duration::from_secs(300);
        let resp = self.request(MSG_WRITE_FILE, &payload, timeout).await?;

        if resp.msg_type == MSG_ERROR {
            let msg = vsock_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(io::Error::other(msg));
        }

        if resp.msg_type != MSG_WRITE_FILE_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let (success, error) = vsock_proto::decode_write_file_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        if !success {
            return Err(io::Error::other(error));
        }

        Ok(())
    }

    /// Spawn a process on the guest and monitor for exit.
    ///
    /// Returns immediately with `(pid, stdout_rx)`. Use [`wait_for_exit`](Self::wait_for_exit)
    /// to wait for completion.
    ///
    /// When `stream_stdout` is true, stdout chunks are streamed to the host via
    /// `MSG_STDOUT_CHUNK`. `stdout_log_path`, when present, additionally asks
    /// the guest to tee those chunks into the given guest-side file.
    /// The returned `stdout_rx` channel receives streamed chunks when enabled
    /// and is closed when the process exits or the connection drops.
    pub async fn spawn_watch(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        stream_stdout: bool,
        stdout_log_path: Option<&str>,
    ) -> io::Result<(u32, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>)> {
        let payload = vsock_proto::encode_spawn_watch(
            timeout_ms,
            command,
            env,
            sudo,
            stream_stdout,
            stdout_log_path,
        )
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

        // Pre-create the stdout channel. In streaming mode, register it by seq
        // number BEFORE sending the request. reader_loop will atomically move
        // it from pending_stdout[seq] to stdout_senders[pid] when it processes
        // the spawn_watch_result — before any stdout_chunk for that pid.
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();
        let seq = self.shared.next_seq();
        {
            let mut guard = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *guard {
                ConnectionState::Closed { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
                ConnectionState::Connected { pending_stdout, .. } if stream_stdout => {
                    pending_stdout.insert(seq, stdout_tx);
                }
                ConnectionState::Connected { .. } => {}
            }
        }
        let _pending_stdout_guard =
            stream_stdout.then(|| PendingStdoutGuard::new(Arc::clone(&self.shared), seq));

        let resp = match self
            .request_raw(MSG_SPAWN_WATCH, seq, &payload, Duration::from_secs(30))
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                return Err(e);
            }
        };

        if resp.msg_type == MSG_ERROR {
            // No pid assigned — clean up pending stdout sender.
            let msg = vsock_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(io::Error::other(msg));
        }

        if resp.msg_type != MSG_SPAWN_WATCH_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        // If `decode_spawn_watch_result` fails here, reader's identical
        // decode also failed: reader's `&&` chain short-circuited and did
        // NOT move `pending_stdout[seq]` to `stdout_senders[pid]`, so our
        // entry is still in `pending_stdout` and must be cleaned up before
        // returning.
        let pid = match vsock_proto::decode_spawn_watch_result(&resp.payload) {
            Ok(pid) => pid,
            Err(e) => {
                return Err(io::Error::new(io::ErrorKind::InvalidData, e.to_string()));
            }
        };

        // Channel already moved from pending_stdout to stdout_senders by reader_loop.
        Ok((pid, stdout_rx))
    }

    /// Wait for a spawned process to exit.
    ///
    /// Returns immediately if the exit event was already cached.
    pub async fn wait_for_exit(&self, pid: u32, timeout: Duration) -> io::Result<ProcessExitEvent> {
        let deadline = Instant::now() + timeout;
        loop {
            // Register interest BEFORE checking the cache so a `notify_waiters`
            // firing between the cache check and `select!` still wakes us.
            let exit_notified = self.shared.exit_notify.notified();
            tokio::pin!(exit_notified);
            exit_notified.as_mut().enable();

            // `match state` covers both the cache check and the closed signal
            // under one lock. The two arms are exhaustive siblings — the
            // Closed arm's cache re-check cannot be forgotten by a reviewer
            // because there is no sequential "check is_closed → maybe retry"
            // dance to get wrong.
            {
                let mut guard = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
                match &mut *guard {
                    ConnectionState::Connected { exits, .. } => {
                        if let Some(event) = exits.remove(&pid) {
                            return Ok(event);
                        }
                    }
                    ConnectionState::Closed { exits } => {
                        if let Some(event) = exits.remove(&pid) {
                            return Ok(event);
                        }
                        return Err(io::Error::new(
                            io::ErrorKind::ConnectionReset,
                            "connection closed",
                        ));
                    }
                }
            }

            tokio::select! {
                biased;
                _ = exit_notified => {
                    // Either a new exit event, or `close()` fired its
                    // `exit_notify.notify_waiters()` — re-check on next iter.
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "wait timeout"));
                }
            }
        }
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
    /// `exit_notify` signal that [`Shared::close`] fires on exit, and re-checks
    /// state under the same lock that `close` holds, so no transition is
    /// missed.
    ///
    /// Note that `exit_notify` also fires on `MSG_PROCESS_EXIT`; those wake
    /// this helper early but it re-checks state and re-parks if still
    /// `Connected`.
    async fn wait_until_closed(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            let notified = self.shared.exit_notify.notified();
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn make_pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    /// Perform mock guest handshake: send ready, receive ping, send pong.
    async fn mock_handshake(stream: &mut UnixStream, decoder: &mut Decoder) {
        // Send ready
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).unwrap();
        stream.write_all(&ready).await.unwrap();

        // Read ping
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_PING);

        // Send pong
        let pong = vsock_proto::encode(MSG_PONG, msgs[0].seq, &[]).unwrap();
        stream.write_all(&pong).await.unwrap();
    }

    async fn host_from_stream(stream: UnixStream) -> io::Result<VsockHost> {
        let deadline = Instant::now() + Duration::from_secs(5);
        VsockHost::from_stream(stream, deadline).await
    }

    fn registration_counts(host: &VsockHost) -> (usize, usize, usize, usize) {
        let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            ConnectionState::Connected {
                pending,
                pending_stdout,
                stdout_senders,
                bounded_output_senders,
                ..
            } => (
                pending.len(),
                pending_stdout.len(),
                stdout_senders.len(),
                bounded_output_senders.len(),
            ),
            ConnectionState::Closed { .. } => (0, 0, 0, 0),
        }
    }

    fn simple_bounded_request<'a>(
        command: &'a str,
        stream: Option<BoundedExecStreamRequest>,
    ) -> BoundedExecRequest<'a> {
        BoundedExecRequest {
            command,
            timeout_ms: 5000,
            env: &[],
            sudo: false,
            stdin: None,
            stdout_limit_bytes: 1024,
            stderr_limit_bytes: 1024,
            stream,
        }
    }

    fn bounded_stream_request(
        event_tx: mpsc::UnboundedSender<BoundedExecOutputEvent>,
    ) -> BoundedExecStreamRequest {
        BoundedExecStreamRequest {
            event_tx,
            stdout: true,
            stderr: true,
            chunk_limit_bytes: vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
            stdout_limit_bytes: 2048,
            stderr_limit_bytes: 2048,
        }
    }

    #[tokio::test]
    async fn wait_for_connection_removes_listener_socket_on_abort() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("vsock-host-abort-{}-{unique}", std::process::id()));
        let listener =
            std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
        let base = base.display().to_string();

        let handle = tokio::spawn(async move {
            VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while !listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        handle.abort();
        let _ = handle.await;

        assert!(
            !listener.exists(),
            "aborted listener should remove its socket path"
        );
    }

    #[tokio::test]
    async fn test_exec() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);

            let d = vsock_proto::decode_exec(&msgs[0].payload).unwrap();
            assert_eq!(d.command, "echo hello");
            assert_eq!(d.timeout_ms, 5000);
            assert!(d.env.is_empty());
            assert!(!d.sudo);

            let payload = vsock_proto::encode_exec_result(0, b"hello\n", b"");
            let resp = vsock_proto::encode(MSG_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("echo hello", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, b"hello\n");
        assert!(result.stderr.is_empty());
    }

    /// `host.exec` with `timeout_ms == 0` must reject at the boundary rather
    /// than send the request to the guest — an unbounded exec would leak a
    /// guest-side orphan when the host's outer timeout fires.
    #[tokio::test]
    async fn test_exec_rejects_zero_timeout() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host.exec("echo hi", 0, &[], false).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn test_exec_error_response() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();

            let payload = vsock_proto::encode_error("command not found");
            let resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("badcmd", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.stderr, b"command not found");
    }

    #[tokio::test]
    async fn test_bounded_exec() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);

            let d = vsock_proto::decode_bounded_exec(&msgs[0].payload).unwrap();
            assert_eq!(d.command, "printf bounded");
            assert_eq!(d.timeout_ms, 7500);
            assert_eq!(d.env, vec![("K", "V")]);
            assert!(d.sudo);
            assert_eq!(d.stdin, Some(b"input".as_slice()));
            assert_eq!(d.stdout_limit_bytes, 10);
            assert_eq!(d.stderr_limit_bytes, 11);
            assert!(!d.stream_stdout);
            assert!(!d.stream_stderr);

            let payload = vsock_proto::encode_bounded_exec_result(
                vsock_proto::BoundedExecTermination::Exited { exit_code: 7 },
                123,
                b"out",
                b"err",
                true,
                false,
            )
            .unwrap();
            let resp = vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let env = [("K", "V")];
        let request = BoundedExecRequest {
            command: "printf bounded",
            timeout_ms: 7500,
            env: &env,
            sudo: true,
            stdin: Some(b"input"),
            stdout_limit_bytes: 10,
            stderr_limit_bytes: 11,
            stream: None,
        };
        let result = host.bounded_exec(&request).await.unwrap();
        assert_eq!(
            result.termination,
            BoundedExecTermination::Exited { exit_code: 7 }
        );
        assert_eq!(result.duration_ms, 123);
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert!(result.stdout_truncated);
        assert!(!result.stderr_truncated);
    }

    #[tokio::test]
    async fn test_bounded_exec_stream_events_route_by_request_seq() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut requests = Vec::new();
            let mut buf = [0u8; 4096];
            while requests.len() < 2 {
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                for msg in msgs {
                    assert_eq!(msg.msg_type, MSG_BOUNDED_EXEC);
                    let decoded = vsock_proto::decode_bounded_exec(&msg.payload).unwrap();
                    requests.push((msg.seq, decoded.command.to_string()));
                }
            }

            for (seq, command) in &requests {
                let (stream, sequence, chunk) = if command == "cmd-a" {
                    (
                        vsock_proto::BoundedExecStream::Stdout,
                        11,
                        b"a-out".as_slice(),
                    )
                } else {
                    (
                        vsock_proto::BoundedExecStream::Stderr,
                        22,
                        b"b-err".as_slice(),
                    )
                };
                let payload =
                    vsock_proto::encode_bounded_exec_output_chunk(stream, sequence, chunk, false)
                        .unwrap();
                let msg =
                    vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, *seq, &payload).unwrap();
                guest.write_all(&msg).await.unwrap();
            }

            for (seq, command) in requests.iter().rev() {
                let stdout = format!("final-{command}");
                let payload = vsock_proto::encode_bounded_exec_result(
                    vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                    1,
                    stdout.as_bytes(),
                    b"",
                    false,
                    false,
                )
                .unwrap();
                let resp = vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, *seq, &payload).unwrap();
                guest.write_all(&resp).await.unwrap();
            }
        });

        let host = std::sync::Arc::new(host_from_stream(host_stream).await.unwrap());
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        let host_a = std::sync::Arc::clone(&host);
        let task_a = tokio::spawn(async move {
            let request = simple_bounded_request("cmd-a", Some(bounded_stream_request(tx_a)));
            host_a.bounded_exec(&request).await
        });

        let host_b = std::sync::Arc::clone(&host);
        let task_b = tokio::spawn(async move {
            let request = simple_bounded_request("cmd-b", Some(bounded_stream_request(tx_b)));
            host_b.bounded_exec(&request).await
        });

        let result_a = task_a.await.unwrap().unwrap();
        let result_b = task_b.await.unwrap().unwrap();
        assert_eq!(result_a.stdout, b"final-cmd-a");
        assert_eq!(result_b.stdout, b"final-cmd-b");

        assert_eq!(
            rx_a.recv().await.unwrap(),
            BoundedExecOutputEvent {
                stream: BoundedExecStream::Stdout,
                sequence: 11,
                chunk: b"a-out".to_vec(),
                truncated: false,
            }
        );
        assert_eq!(
            rx_b.recv().await.unwrap(),
            BoundedExecOutputEvent {
                stream: BoundedExecStream::Stderr,
                sequence: 22,
                chunk: b"b-err".to_vec(),
                truncated: false,
            }
        );
    }

    #[tokio::test]
    async fn test_bounded_exec_stream_events_filter_unrequested_streams() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
            let decoded = vsock_proto::decode_bounded_exec(&msgs[0].payload).unwrap();
            assert!(decoded.stream_stdout);
            assert!(!decoded.stream_stderr);

            let ignored_payload = vsock_proto::encode_bounded_exec_output_chunk(
                vsock_proto::BoundedExecStream::Stderr,
                1,
                b"ignored",
                false,
            )
            .unwrap();
            let ignored =
                vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, msgs[0].seq, &ignored_payload)
                    .unwrap();
            guest.write_all(&ignored).await.unwrap();

            let kept_payload = vsock_proto::encode_bounded_exec_output_chunk(
                vsock_proto::BoundedExecStream::Stdout,
                2,
                b"kept",
                false,
            )
            .unwrap();
            let kept =
                vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, msgs[0].seq, &kept_payload)
                    .unwrap();
            guest.write_all(&kept).await.unwrap();

            let payload = vsock_proto::encode_bounded_exec_result(
                vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                1,
                b"done",
                b"",
                false,
                false,
            )
            .unwrap();
            let resp = vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let request = simple_bounded_request(
            "stdout-only",
            Some(BoundedExecStreamRequest {
                event_tx,
                stdout: true,
                stderr: false,
                chunk_limit_bytes: vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
                stdout_limit_bytes: 2048,
                stderr_limit_bytes: 0,
            }),
        );

        let result = host.bounded_exec(&request).await.unwrap();
        assert_eq!(result.stdout, b"done");
        assert_eq!(
            event_rx.recv().await.unwrap(),
            BoundedExecOutputEvent {
                stream: BoundedExecStream::Stdout,
                sequence: 2,
                chunk: b"kept".to_vec(),
                truncated: false,
            }
        );
        assert!(matches!(
            event_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn test_bounded_exec_ignores_unroutable_or_malformed_stream_chunks() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);

            let valid_chunk = vsock_proto::encode_bounded_exec_output_chunk(
                vsock_proto::BoundedExecStream::Stdout,
                1,
                b"ignored",
                false,
            )
            .unwrap();
            let seq_zero =
                vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, 0, &valid_chunk).unwrap();
            guest.write_all(&seq_zero).await.unwrap();

            let unknown_seq =
                vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, msgs[0].seq + 1, &valid_chunk)
                    .unwrap();
            guest.write_all(&unknown_seq).await.unwrap();

            let malformed =
                vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, msgs[0].seq, b"\x00").unwrap();
            guest.write_all(&malformed).await.unwrap();

            let payload = vsock_proto::encode_bounded_exec_result(
                vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                1,
                b"done",
                b"",
                false,
                false,
            )
            .unwrap();
            let resp = vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let request =
            simple_bounded_request("ignore-bad-chunks", Some(bounded_stream_request(event_tx)));

        let result = host.bounded_exec(&request).await.unwrap();

        assert_eq!(result.stdout, b"done");
        assert!(matches!(
            event_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(registration_counts(&host), (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn test_bounded_exec_ignores_stream_chunks_after_final_result() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);

            let result_payload = vsock_proto::encode_bounded_exec_result(
                vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                1,
                b"done",
                b"",
                false,
                false,
            )
            .unwrap();
            let result =
                vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &result_payload).unwrap();

            let late_chunk_payload = vsock_proto::encode_bounded_exec_output_chunk(
                vsock_proto::BoundedExecStream::Stdout,
                99,
                b"late",
                false,
            )
            .unwrap();
            let late_chunk = vsock_proto::encode(
                MSG_BOUNDED_EXEC_OUTPUT_CHUNK,
                msgs[0].seq,
                &late_chunk_payload,
            )
            .unwrap();

            let mut combined = result;
            combined.extend_from_slice(&late_chunk);
            guest.write_all(&combined).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let request = simple_bounded_request("late-chunk", Some(bounded_stream_request(event_tx)));

        let result = host.bounded_exec(&request).await.unwrap();

        assert_eq!(result.stdout, b"done");
        assert!(matches!(
            event_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(registration_counts(&host), (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn test_bounded_exec_malformed_result_cleans_up() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
            let bad_resp =
                vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, b"\x00").unwrap();
            guest.write_all(&bad_resp).await.unwrap();

            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
            let payload = vsock_proto::encode_bounded_exec_result(
                vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                1,
                b"ok",
                b"",
                false,
                false,
            )
            .unwrap();
            let ok_resp =
                vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&ok_resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let request = simple_bounded_request("bad-result", Some(bounded_stream_request(tx)));
        let err = host.bounded_exec(&request).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0, 0),
            "malformed bounded_exec result must clean pending registrations",
        );

        let request = simple_bounded_request("good-result", None);
        let result = host.bounded_exec(&request).await.unwrap();
        assert_eq!(result.stdout, b"ok");
    }

    #[tokio::test]
    async fn test_bounded_exec_cancel_cleans_up_registrations() {
        let (host_stream, mut guest) = make_pair();
        let request_seen = std::sync::Arc::new(Notify::new());
        let release_guest = std::sync::Arc::new(Notify::new());

        {
            let request_seen = std::sync::Arc::clone(&request_seen);
            let release_guest = std::sync::Arc::clone(&release_guest);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
                request_seen.notify_one();

                release_guest.notified().await;
            });
        }

        let host = std::sync::Arc::new(host_from_stream(host_stream).await.unwrap());
        let task_host = std::sync::Arc::clone(&host);
        let task = tokio::spawn(async move {
            let (tx, _rx) = mpsc::unbounded_channel();
            let request = simple_bounded_request("long-running", Some(bounded_stream_request(tx)));
            task_host.bounded_exec(&request).await
        });

        tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
            .await
            .expect("guest should receive bounded_exec request");
        assert_eq!(registration_counts(&host), (1, 0, 0, 1));

        task.abort();
        let _ = task.await;
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0, 0),
            "aborted bounded_exec future must clean pending registrations",
        );

        release_guest.notify_one();
    }

    #[tokio::test]
    async fn test_bounded_exec_connection_close_cleans_up_registrations() {
        let (host_stream, mut guest) = make_pair();
        let request_seen = std::sync::Arc::new(Notify::new());
        let release_guest = std::sync::Arc::new(Notify::new());

        {
            let request_seen = std::sync::Arc::clone(&request_seen);
            let release_guest = std::sync::Arc::clone(&release_guest);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
                request_seen.notify_one();

                release_guest.notified().await;
                drop(guest);
            });
        }

        let host = std::sync::Arc::new(host_from_stream(host_stream).await.unwrap());
        let task_host = std::sync::Arc::clone(&host);
        let task = tokio::spawn(async move {
            let (tx, _rx) = mpsc::unbounded_channel();
            let request =
                simple_bounded_request("connection-close", Some(bounded_stream_request(tx)));
            task_host.bounded_exec(&request).await
        });

        tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
            .await
            .expect("guest should receive bounded_exec request");
        assert_eq!(registration_counts(&host), (1, 0, 0, 1));

        release_guest.notify_one();
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0, 0),
            "closed connection must clean pending bounded_exec registrations",
        );
    }

    #[tokio::test]
    async fn test_bounded_exec_dropped_event_receiver_removes_stream_registration() {
        let (host_stream, mut guest) = make_pair();
        let chunk_written = std::sync::Arc::new(Notify::new());
        let release_result = std::sync::Arc::new(Notify::new());

        {
            let chunk_written = std::sync::Arc::clone(&chunk_written);
            let release_result = std::sync::Arc::clone(&release_result);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);

                let payload = vsock_proto::encode_bounded_exec_output_chunk(
                    vsock_proto::BoundedExecStream::Stdout,
                    1,
                    b"orphaned",
                    false,
                )
                .unwrap();
                let chunk =
                    vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, msgs[0].seq, &payload)
                        .unwrap();
                guest.write_all(&chunk).await.unwrap();
                chunk_written.notify_one();

                release_result.notified().await;
                let payload = vsock_proto::encode_bounded_exec_result(
                    vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                    1,
                    b"done",
                    b"",
                    false,
                    false,
                )
                .unwrap();
                let resp =
                    vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
                guest.write_all(&resp).await.unwrap();
            });
        }

        let host = std::sync::Arc::new(host_from_stream(host_stream).await.unwrap());
        let task_host = std::sync::Arc::clone(&host);
        let task = tokio::spawn(async move {
            let (tx, rx) = mpsc::unbounded_channel();
            drop(rx);
            let request =
                simple_bounded_request("dropped-receiver", Some(bounded_stream_request(tx)));
            task_host.bounded_exec(&request).await
        });

        tokio::time::timeout(Duration::from_secs(5), chunk_written.notified())
            .await
            .expect("guest should write bounded_exec stream chunk");
        tokio::time::timeout(Duration::from_secs(5), async {
            while registration_counts(&host) != (1, 0, 0, 0) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped receiver should remove bounded stream registration");

        release_result.notify_one();
        let result = task.await.unwrap().unwrap();
        assert_eq!(result.stdout, b"done");
        assert_eq!(registration_counts(&host), (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn test_bounded_exec_error_response_cleans_up_registrations() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
            let payload = vsock_proto::encode_error("bounded failed");
            let resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
            let payload = vsock_proto::encode_bounded_exec_result(
                vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                1,
                b"ok",
                b"",
                false,
                false,
            )
            .unwrap();
            let ok_resp =
                vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&ok_resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let request = simple_bounded_request("error-result", Some(bounded_stream_request(tx)));
        let err = host.bounded_exec(&request).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Other);
        assert_eq!(err.to_string(), "bounded failed");
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0, 0),
            "bounded_exec MSG_ERROR response must clean pending registrations",
        );

        let request = simple_bounded_request("good-result", None);
        let result = host.bounded_exec(&request).await.unwrap();
        assert_eq!(result.stdout, b"ok");
    }

    #[tokio::test]
    async fn test_bounded_exec_stream_request_with_no_streams_does_not_register_sender() {
        let (host_stream, mut guest) = make_pair();
        let request_seen = std::sync::Arc::new(Notify::new());
        let release_result = std::sync::Arc::new(Notify::new());

        {
            let request_seen = std::sync::Arc::clone(&request_seen);
            let release_result = std::sync::Arc::clone(&release_result);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
                let decoded = vsock_proto::decode_bounded_exec(&msgs[0].payload).unwrap();
                assert!(!decoded.stream_stdout);
                assert!(!decoded.stream_stderr);
                assert_eq!(decoded.stream_chunk_limit_bytes, 0);
                request_seen.notify_one();

                release_result.notified().await;
                let payload = vsock_proto::encode_bounded_exec_result(
                    vsock_proto::BoundedExecTermination::Exited { exit_code: 0 },
                    1,
                    b"done",
                    b"",
                    false,
                    false,
                )
                .unwrap();
                let resp =
                    vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
                guest.write_all(&resp).await.unwrap();
            });
        }

        let host = std::sync::Arc::new(host_from_stream(host_stream).await.unwrap());
        let task_host = std::sync::Arc::clone(&host);
        let task = tokio::spawn(async move {
            let (event_tx, _event_rx) = mpsc::unbounded_channel();
            let request = simple_bounded_request(
                "no-streams",
                Some(BoundedExecStreamRequest {
                    event_tx,
                    stdout: false,
                    stderr: false,
                    chunk_limit_bytes: 0,
                    stdout_limit_bytes: 0,
                    stderr_limit_bytes: 0,
                }),
            );
            task_host.bounded_exec(&request).await
        });

        tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
            .await
            .expect("guest should receive bounded_exec request");
        assert_eq!(
            registration_counts(&host),
            (1, 0, 0, 0),
            "disabled streams should not create a stream registration",
        );

        release_result.notify_one();
        let result = task.await.unwrap().unwrap();
        assert_eq!(result.stdout, b"done");
        assert_eq!(registration_counts(&host), (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn test_bounded_exec_rejects_invalid_boundaries() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let zero_timeout = BoundedExecRequest {
            timeout_ms: 0,
            ..simple_bounded_request("zero-timeout", None)
        };
        let err = host.bounded_exec(&zero_timeout).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let oversized_final = BoundedExecRequest {
            stdout_limit_bytes: u32::MAX,
            stderr_limit_bytes: u32::MAX,
            ..simple_bounded_request("oversized-final", None)
        };
        let err = host.bounded_exec(&oversized_final).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let (tx, _rx) = mpsc::unbounded_channel();
        let invalid_stream = BoundedExecRequest {
            stream: Some(BoundedExecStreamRequest {
                chunk_limit_bytes: 0,
                ..bounded_stream_request(tx)
            }),
            ..simple_bounded_request("invalid-stream", None)
        };
        let err = host.bounded_exec(&invalid_stream).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let (tx, _rx) = mpsc::unbounded_channel();
        let oversized_stream = BoundedExecRequest {
            stream: Some(BoundedExecStreamRequest {
                chunk_limit_bytes: u32::MAX,
                ..bounded_stream_request(tx)
            }),
            ..simple_bounded_request("oversized-stream", None)
        };
        let err = host.bounded_exec(&oversized_stream).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn test_write_file() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_WRITE_FILE);

            let (path, content, sudo, append) =
                vsock_proto::decode_write_file(&msgs[0].payload).unwrap();
            assert_eq!(path, "/tmp/test.txt");
            assert_eq!(content, b"hello");
            assert!(!sudo);
            assert!(!append);

            let payload = vsock_proto::encode_write_file_result(true, "");
            let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        host.write_file("/tmp/test.txt", b"hello", false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_write_file_chunked() {
        let (host_stream, mut guest) = make_pair();

        // Content just over the chunk limit → 2 write messages + 1 exec (mv)
        let chunk_limit = VsockHost::WRITE_FILE_CHUNK_LIMIT;
        let content = vec![0xABu8; chunk_limit + 100];
        let content_clone = content.clone();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut chunks_received = Vec::new();
            let mut temp_path = None::<String>;
            let mut buf = vec![0u8; chunk_limit + 4096];

            // Read write_file chunks + final exec (mv) message
            loop {
                let n = guest.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                let msgs = decoder.decode(&buf[..n]).unwrap();
                for msg in msgs {
                    if msg.msg_type == MSG_WRITE_FILE {
                        let (path, chunk, _sudo, append) =
                            vsock_proto::decode_write_file(&msg.payload).unwrap();
                        // Chunks go to temp file
                        if let Some(temp_path) = &temp_path {
                            assert_eq!(path, temp_path);
                        } else {
                            assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                            temp_path = Some(path.to_string());
                        }
                        chunks_received.push((append, chunk.to_vec()));

                        let payload = vsock_proto::encode_write_file_result(true, "");
                        let resp =
                            vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                    } else if msg.msg_type == MSG_EXEC {
                        // Atomic rename: mv temp → target
                        let decoded = vsock_proto::decode_exec(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        assert!(decoded.command.contains("mv -f --"));
                        assert!(decoded.command.contains(temp_path));
                        assert!(decoded.command.contains("/tmp/big.bin"));

                        let payload = vsock_proto::encode_exec_result(0, &[], &[]);
                        let resp = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                        // Done — verify chunks and return
                        assert_eq!(chunks_received.len(), 2);
                        assert!(!chunks_received[0].0); // first: create
                        assert_eq!(chunks_received[0].1.len(), chunk_limit);
                        assert!(chunks_received[1].0); // second: append
                        assert_eq!(chunks_received[1].1.len(), 100);
                        let mut reassembled = chunks_received[0].1.clone();
                        reassembled.extend_from_slice(&chunks_received[1].1);
                        assert_eq!(reassembled, content_clone);
                        return;
                    }
                }
            }
            panic!("guest loop ended without receiving exec (mv)");
        });

        let host = host_from_stream(host_stream).await.unwrap();
        host.write_file("/tmp/big.bin", &content, false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_write_file_at_chunk_limit_uses_single_message() {
        let (host_stream, mut guest) = make_pair();

        let chunk_limit = VsockHost::WRITE_FILE_CHUNK_LIMIT;
        let content = vec![0xABu8; chunk_limit];
        let content_clone = content.clone();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = vec![0u8; chunk_limit + 4096];
            let mut msgs = Vec::new();
            while msgs.is_empty() {
                let n = guest.read(&mut buf).await.unwrap();
                assert_ne!(n, 0, "connection closed before write_file message");
                msgs.extend(decoder.decode(&buf[..n]).unwrap());
            }
            assert_eq!(msgs.len(), 1);
            assert_eq!(msgs[0].msg_type, MSG_WRITE_FILE);

            let (path, chunk, _sudo, append) =
                vsock_proto::decode_write_file(&msgs[0].payload).unwrap();
            assert_eq!(path, "/tmp/exact-limit.bin");
            assert_eq!(chunk, content_clone);
            assert!(!append);

            let payload = vsock_proto::encode_write_file_result(true, "");
            let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        host.write_file("/tmp/exact-limit.bin", &content, false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_write_file_chunked_cleans_up_on_chunk_failure() {
        let (host_stream, mut guest) = make_pair();

        let chunk_limit = VsockHost::WRITE_FILE_CHUNK_LIMIT;
        let content = vec![0xABu8; chunk_limit + 100];

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = vec![0u8; chunk_limit + 4096];
            let mut chunk_count = 0u32;
            let mut temp_path = None::<String>;
            loop {
                let n = guest.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                let msgs = decoder.decode(&buf[..n]).unwrap();
                for msg in msgs {
                    if msg.msg_type == MSG_WRITE_FILE {
                        chunk_count += 1;
                        let (path, _chunk, _sudo, _append) =
                            vsock_proto::decode_write_file(&msg.payload).unwrap();
                        if let Some(temp_path) = &temp_path {
                            assert_eq!(path, temp_path);
                        } else {
                            assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                            temp_path = Some(path.to_string());
                        }
                        let (success, err) = if chunk_count == 2 {
                            (false, "disk full")
                        } else {
                            (true, "")
                        };
                        let payload = vsock_proto::encode_write_file_result(success, err);
                        let resp =
                            vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                    } else if msg.msg_type == MSG_EXEC {
                        // Cleanup: rm -f temp file
                        let decoded = vsock_proto::decode_exec(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        assert!(decoded.command.contains("rm -f --"));
                        assert!(decoded.command.contains(temp_path));
                        let payload = vsock_proto::encode_exec_result(0, &[], &[]);
                        let resp = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                        return;
                    }
                }
            }
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host
            .write_file("/tmp/big.bin", &content, false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("disk full"));
    }

    #[tokio::test]
    async fn test_write_file_chunked_cleans_up_on_mv_failure() {
        let (host_stream, mut guest) = make_pair();

        let chunk_limit = VsockHost::WRITE_FILE_CHUNK_LIMIT;
        let content = vec![0xABu8; chunk_limit + 100];

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = vec![0u8; chunk_limit + 4096];
            let mut exec_count = 0u32;
            let mut temp_path = None::<String>;
            loop {
                let n = guest.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                let msgs = decoder.decode(&buf[..n]).unwrap();
                for msg in msgs {
                    if msg.msg_type == MSG_WRITE_FILE {
                        let (path, _chunk, _sudo, _append) =
                            vsock_proto::decode_write_file(&msg.payload).unwrap();
                        if let Some(temp_path) = &temp_path {
                            assert_eq!(path, temp_path);
                        } else {
                            assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                            temp_path = Some(path.to_string());
                        }
                        let payload = vsock_proto::encode_write_file_result(true, "");
                        let resp =
                            vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                    } else if msg.msg_type == MSG_EXEC {
                        exec_count += 1;
                        let decoded = vsock_proto::decode_exec(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        if decoded.command.contains("mv -f --") {
                            // mv fails
                            assert!(decoded.command.contains(temp_path));
                            let payload =
                                vsock_proto::encode_exec_result(1, &[], b"permission denied");
                            let resp =
                                vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                            guest.write_all(&resp).await.unwrap();
                        } else {
                            // cleanup rm
                            assert!(decoded.command.contains("rm -f --"));
                            assert!(decoded.command.contains(temp_path));
                            let payload = vsock_proto::encode_exec_result(0, &[], &[]);
                            let resp =
                                vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                            guest.write_all(&resp).await.unwrap();
                            assert_eq!(exec_count, 2); // mv then rm
                            return;
                        }
                    }
                }
            }
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host
            .write_file("/tmp/big.bin", &content, false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("permission denied"));
    }

    #[tokio::test]
    async fn test_write_file_chunked_cleans_up_when_cancelled() {
        let (host_stream, mut guest) = make_pair();

        let chunk_limit = VsockHost::WRITE_FILE_CHUNK_LIMIT;
        let content = vec![0xABu8; chunk_limit + 100];
        let (first_chunk_tx, first_chunk_rx) = oneshot::channel::<()>();
        let (cleanup_tx, cleanup_rx) = oneshot::channel::<String>();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = vec![0u8; chunk_limit + 4096];
            let mut temp_path = None::<String>;
            let mut first_chunk_tx = Some(first_chunk_tx);
            let mut cleanup_tx = Some(cleanup_tx);

            loop {
                let n = guest.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                let msgs = decoder.decode(&buf[..n]).unwrap();
                for msg in msgs {
                    if msg.msg_type == MSG_WRITE_FILE {
                        let (path, _chunk, _sudo, _append) =
                            vsock_proto::decode_write_file(&msg.payload).unwrap();
                        if let Some(temp_path) = &temp_path {
                            assert_eq!(path, temp_path);
                            continue;
                        }

                        assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                        temp_path = Some(path.to_string());
                        let payload = vsock_proto::encode_write_file_result(true, "");
                        let resp =
                            vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                        if let Some(tx) = first_chunk_tx.take() {
                            let _ = tx.send(());
                        }
                    } else if msg.msg_type == MSG_EXEC {
                        let decoded = vsock_proto::decode_exec(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        assert!(decoded.command.contains("rm -f --"));
                        assert!(decoded.command.contains(temp_path));
                        if let Some(tx) = cleanup_tx.take() {
                            let _ = tx.send(decoded.command.to_string());
                        }
                        let payload = vsock_proto::encode_exec_result(0, &[], &[]);
                        let resp = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                        guest.write_all(&resp).await.unwrap();
                        return;
                    }
                }
            }
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let mut write = Box::pin(host.write_file("/tmp/big.bin", &content, false));
        tokio::select! {
            _ = &mut write => panic!("chunked write completed before cancellation"),
            result = first_chunk_rx => result.unwrap(),
        }
        drop(write);

        let cleanup_command = tokio::time::timeout(Duration::from_secs(2), cleanup_rx)
            .await
            .expect("cleanup command was not sent after cancellation")
            .expect("cleanup sender dropped");
        assert!(cleanup_command.contains("rm -f --"));
    }

    #[tokio::test]
    async fn test_write_file_failure() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();

            let payload = vsock_proto::encode_write_file_result(false, "permission denied");
            let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host
            .write_file("/etc/shadow", b"bad", false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("permission denied"));
    }

    #[tokio::test]
    async fn test_spawn_watch_and_wait() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Send spawn_watch_result with pid=42
            let payload = vsock_proto::encode_spawn_watch_result(42);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Send process_exit (unsolicited, seq=0)
            let exit_payload = vsock_proto::encode_process_exit(42, 0, b"done", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            // Keep connection alive until host drops
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, mut stdout_rx) = host
            .spawn_watch("sleep 1", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 42);
        assert!(
            stdout_rx.recv().await.is_none(),
            "buffered spawn_watch must not keep a stdout stream registered",
        );

        let event = host
            .wait_for_exit(42, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.pid, 42);
        assert_eq!(event.exit_code, 0);
        assert_eq!(event.stdout, b"done");
    }

    #[tokio::test]
    async fn test_cached_exit_event() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Send spawn_watch_result followed immediately by process_exit
            // in the same write, so they arrive together before wait_for_exit
            let payload = vsock_proto::encode_spawn_watch_result(99);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            let exit_payload = vsock_proto::encode_process_exit(99, 1, b"", b"error");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

            // Write both together
            let mut combined = resp;
            combined.extend_from_slice(&exit_msg);
            guest.write_all(&combined).await.unwrap();

            // Keep connection alive until host drops
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("false", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 99);

        let event = host
            .wait_for_exit(99, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.exit_code, 1);
        assert_eq!(event.stderr, b"error");
    }

    /// When a `spawn_watch` request is answered with `MSG_ERROR`, the
    /// pre-registered `pending_stdout` entry must be removed by the
    /// registration guard. Assert the error surfaces with the
    /// guest-provided message AND that a follow-up successful `spawn_watch`
    /// can still run — proving no stale state lingers.
    #[tokio::test]
    async fn test_spawn_watch_error_response_cleans_up() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // First spawn_watch: reply with MSG_ERROR.
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let err_payload = vsock_proto::encode_error("no such command");
            let err_resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &err_payload).unwrap();
            guest.write_all(&err_resp).await.unwrap();

            // Second spawn_watch: happy path with pid=222.
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let ok_payload = vsock_proto::encode_spawn_watch_result(222);
            let ok_resp =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &ok_payload).unwrap();
            guest.write_all(&ok_resp).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();

        let err = host
            .spawn_watch("bad-cmd", 0, &[], false, false, None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no such command"));

        let (pid, _stdout_rx) = host
            .spawn_watch("good-cmd", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 222);
    }

    /// The guest replies with `MSG_SPAWN_WATCH_RESULT` but its payload is
    /// malformed (not a valid u32). Host's `decode_spawn_watch_result` fails
    /// AFTER the msg_type check has passed; reader's identical decode also
    /// failed and did NOT move `pending_stdout[seq]` to `stdout_senders`, so
    /// the entry is still there and must be cleaned up. A follow-up
    /// `spawn_watch` succeeding on the same connection proves the cleanup
    /// worked.
    #[tokio::test]
    async fn test_spawn_watch_malformed_result_cleans_up() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // First spawn_watch: reply with correct msg_type but truncated
            // payload (3 bytes, not the required 4 for a u32 pid).
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            let bad_payload = b"\x00\x01\x02";
            let bad_resp =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, bad_payload).unwrap();
            guest.write_all(&bad_resp).await.unwrap();

            // Second spawn_watch: well-formed response with pid=333.
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            let ok_payload = vsock_proto::encode_spawn_watch_result(333);
            let ok_resp =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &ok_payload).unwrap();
            guest.write_all(&ok_resp).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();

        let err = host
            .spawn_watch("bad-payload-cmd", 0, &[], false, false, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        let (pid, _stdout_rx) = host
            .spawn_watch("good-cmd", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 333);
    }

    #[tokio::test]
    async fn test_spawn_watch_cancel_cleans_up_registrations() {
        let (host_stream, mut guest) = make_pair();
        let request_seen = std::sync::Arc::new(Notify::new());
        let release_guest = std::sync::Arc::new(Notify::new());

        {
            let request_seen = std::sync::Arc::clone(&request_seen);
            let release_guest = std::sync::Arc::clone(&release_guest);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
                request_seen.notify_one();

                release_guest.notified().await;
            });
        }

        let host = std::sync::Arc::new(host_from_stream(host_stream).await.unwrap());
        let task_host = std::sync::Arc::clone(&host);
        let task = tokio::spawn(async move {
            task_host
                .spawn_watch("long-running", 0, &[], false, true, None)
                .await
        });

        tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
            .await
            .expect("guest should receive spawn_watch request");
        assert_eq!(registration_counts(&host), (1, 1, 0, 0));

        task.abort();
        let _ = task.await;
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0, 0),
            "aborted spawn_watch future must clean pending registrations",
        );

        release_guest.notify_one();
    }

    #[tokio::test]
    async fn test_shutdown() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SHUTDOWN);

            let resp = vsock_proto::encode(MSG_SHUTDOWN_ACK, msgs[0].seq, &[]).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        assert!(host.shutdown(Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn test_connection_closed_returns_error() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read the exec request then close the connection.
            let mut buf = [0u8; 4096];
            let _ = guest.read(&mut buf).await.unwrap();
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host.exec("echo hi", 5000, &[], false).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    /// Request made after connection is already closed returns ConnectionReset
    /// immediately (not after timeout).
    #[tokio::test]
    async fn test_request_after_close_returns_immediately() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;
            // Close immediately after handshake.
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();

        // Deterministically wait for reader to detect EOF and transition state
        // to Closed — no wall-clock sleep, driven by `exit_notify`.
        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();

        // This should fail quickly (via write error or Closed short-circuit),
        // NOT wait for the 5s exec timeout.
        let start = Instant::now();
        let err = host.exec("echo hi", 5000, &[], false).await.unwrap_err();
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
            ),
            "expected ConnectionReset or BrokenPipe, got {:?}",
            err.kind()
        );
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "request should fail immediately, took {:?}",
            start.elapsed()
        );
    }

    /// `spawn_watch` has its own `Closed` short-circuit at the `pending_stdout`
    /// insert point, separate from `request_raw`. Exercise it: after the
    /// connection has closed, a subsequent `spawn_watch` must fail fast with
    /// a connection error and must not leak the stdout channel it would have
    /// pre-registered.
    #[tokio::test]
    async fn test_spawn_watch_after_close_returns_immediately() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();

        // Deterministically wait for reader to observe EOF and transition
        // state to Closed — driven by `exit_notify`, no wall-clock sleep.
        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();

        let start = Instant::now();
        let err = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
            ),
            "expected ConnectionReset or BrokenPipe, got {:?}",
            err.kind()
        );
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "spawn_watch should fail immediately, took {:?}",
            start.elapsed()
        );
    }

    /// Two concurrent exec calls get the correct response matched by seq.
    #[tokio::test]
    async fn test_concurrent_execs() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read both exec requests (may arrive in one or two reads).
            let mut all_msgs = Vec::new();
            let mut buf = [0u8; 4096];
            while all_msgs.len() < 2 {
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                all_msgs.extend(msgs);
            }
            assert_eq!(all_msgs.len(), 2);
            assert!(all_msgs.iter().all(|m| m.msg_type == MSG_EXEC));

            // Reply in reverse order to exercise seq-based dispatching.
            for msg in all_msgs.iter().rev() {
                let d = vsock_proto::decode_exec(&msg.payload).unwrap();
                let out = format!("reply:{}", d.command);
                let payload = vsock_proto::encode_exec_result(0, out.as_bytes(), b"");
                let resp = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                guest.write_all(&resp).await.unwrap();
            }

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());

        let h1 = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.exec("cmd-a", 5000, &[], false).await })
        };
        let h2 = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.exec("cmd-b", 5000, &[], false).await })
        };

        let r1 = h1.await.unwrap().unwrap();
        let r2 = h2.await.unwrap().unwrap();

        // Each response matches its own command, regardless of reply order.
        let out1 = String::from_utf8_lossy(&r1.stdout);
        let out2 = String::from_utf8_lossy(&r2.stdout);
        assert_eq!(out1, "reply:cmd-a");
        assert_eq!(out2, "reply:cmd-b");
    }

    /// Verify that post-handshake request seq starts at 2 (seq=1 is used by handshake ping).
    #[tokio::test]
    async fn test_seq_starts_at_2() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read the first exec request and verify its seq.
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);
            // Handshake used seq=1, so first request must be seq=2.
            assert_eq!(msgs[0].seq, 2, "first post-handshake seq should be 2");

            let payload = vsock_proto::encode_exec_result(0, b"ok", b"");
            let resp = vsock_proto::encode(MSG_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("test", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 0);
    }

    /// Exit event arrives between wait_for_exit registration and select! —
    /// the enable() pattern ensures the notification is not lost.
    #[tokio::test]
    async fn test_wait_for_exit_no_lost_notification() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch request
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Reply with pid=88
            let payload = vsock_proto::encode_spawn_watch_result(88);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Immediately send exit event — this races with host calling wait_for_exit
            let exit_payload = vsock_proto::encode_process_exit(88, 7, b"quick", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            // Keep alive
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("quick-exit", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 88);

        // The exit event may already be cached OR still in-flight. Either way
        // wait_for_exit must succeed (not hang or lose the notification).
        let event = host
            .wait_for_exit(88, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.pid, 88);
        assert_eq!(event.exit_code, 7);
        assert_eq!(event.stdout, b"quick");
    }

    /// wait_for_exit returns an error when the connection drops.
    #[tokio::test]
    async fn test_wait_for_exit_connection_closed() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch request
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Reply with pid=77
            let payload = vsock_proto::encode_spawn_watch_result(77);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Small delay then close the connection WITHOUT sending process_exit.
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 77);

        let err = host
            .wait_for_exit(77, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    /// An exit event cached in `ConnectionState::Connected { exits, .. }` must
    /// survive the `Connected → Closed` transition in `close()` and remain
    /// retrievable by a `wait_for_exit` call made AFTER the connection has
    /// closed. Regression guard: if a future refactor replaces the `exits`
    /// field in `Closed { exits }` with an empty map, this test fails.
    #[tokio::test]
    async fn test_wait_for_exit_returns_cached_event_after_close() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Send SPAWN_WATCH_RESULT + PROCESS_EXIT together, then close the
            // socket. The reader processes both messages synchronously in one
            // for-loop iteration, then sees EOF on the next read and calls
            // close() which transitions state to `Closed { exits }` while
            // preserving the cached exit event.
            let result_payload = vsock_proto::encode_spawn_watch_result(111);
            let result =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &result_payload).unwrap();
            let exit_payload = vsock_proto::encode_process_exit(111, 3, b"cached-output", b"err");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

            let mut combined = result;
            combined.extend_from_slice(&exit_msg);
            guest.write_all(&combined).await.unwrap();
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("quick-exit", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 111);

        // Deterministically wait for reader to observe EOF and run `close()`
        // so the subsequent `wait_for_exit` definitely hits the `Closed` arm
        // rather than the `Connected` arm — driven by `exit_notify`.
        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();

        let event = host
            .wait_for_exit(pid, Duration::from_secs(5))
            .await
            .expect("cached exit event must survive the Connected → Closed transition");
        assert_eq!(event.pid, 111);
        assert_eq!(event.exit_code, 3);
        assert_eq!(event.stdout, b"cached-output");
        assert_eq!(event.stderr, b"err");
    }

    /// Host-side deadline fires when the guest never sends process_exit.
    ///
    /// This exercises the `tokio::time::sleep_until(deadline)` arm of the
    /// `select!` loop in `wait_for_exit` — the only exit path that was
    /// previously untested (see issue #9611).
    #[tokio::test]
    async fn test_wait_for_exit_timeout() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch, reply with pid — but never send process_exit.
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            let payload = vsock_proto::encode_spawn_watch_result(55);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Keep connection alive so the timeout, not the close path, fires.
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 55);

        let err = host
            .wait_for_exit(pid, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    /// Regression for #10076: the guest writes the exec response and then
    /// immediately closes the socket. The reader dispatches the response,
    /// then observes EOF and transitions state to `Closed`. Before the fix,
    /// `request_raw` would observe `is_closed=true` after `write_all` and
    /// return `ConnectionReset`, discarding the already-delivered response
    /// sitting in `rx`. Under the new `ConnectionState` refactor the
    /// `is_closed` early-exit no longer exists — the response must be
    /// returned via the biased `rx` arm of `select!`.
    #[tokio::test]
    async fn test_response_then_close_returns_ok() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read the exec request.
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);

            // Write the response and close the socket. The response must
            // race with EOF such that reader_loop processes both before the
            // host's `request_raw` returns from its select!.
            let payload = vsock_proto::encode_exec_result(0, b"race-survived", b"");
            let resp = vsock_proto::encode(MSG_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("echo race", 5000, &[], false).await;

        // The response was delivered before close; the refactor guarantees
        // it is returned via `rx` rather than being shadowed by a close
        // observation.
        let result = result.expect("response delivered before close must not be lost");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, b"race-survived");
    }

    /// Prove the core requirement: wait_for_exit and exec can run concurrently.
    #[tokio::test]
    async fn test_concurrent_exec_and_wait_exit() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch request
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let spawn_seq = msgs[0].seq;

            // Reply with pid=50
            let payload = vsock_proto::encode_spawn_watch_result(50);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, spawn_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Now read the exec request (sent concurrently with wait_for_exit)
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);
            let exec_seq = msgs[0].seq;

            // Reply to exec first
            let exec_payload = vsock_proto::encode_exec_result(0, b"concurrent", b"");
            let exec_resp = vsock_proto::encode(MSG_EXEC_RESULT, exec_seq, &exec_payload).unwrap();
            guest.write_all(&exec_resp).await.unwrap();

            // Small delay then send process_exit
            tokio::time::sleep(Duration::from_millis(50)).await;
            let exit_payload = vsock_proto::encode_process_exit(50, 42, b"exited", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            // Keep alive
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 50);

        // Start wait_for_exit in background
        let host2 = Arc::clone(&host);
        let wait_task =
            tokio::spawn(async move { host2.wait_for_exit(50, Duration::from_secs(5)).await });

        // Concurrently call exec — this should NOT block on wait_for_exit
        let exec_result = host
            .exec("echo concurrent", 5000, &[], false)
            .await
            .unwrap();
        assert_eq!(exec_result.exit_code, 0);
        assert_eq!(exec_result.stdout, b"concurrent");

        // wait_for_exit should also resolve
        let exit_event = wait_task.await.unwrap().unwrap();
        assert_eq!(exit_event.pid, 50);
        assert_eq!(exit_event.exit_code, 42);
        assert_eq!(exit_event.stdout, b"exited");
    }
}
