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

mod command;
mod file;
mod process;

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

#[cfg(test)]
use vsock_proto::{
    CommandCapturedOutput, CommandOutputPolicy, CommandOutputStream, CommandTermination,
    MSG_COMMAND_CANCEL, MSG_COMMAND_START, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT,
};
use vsock_proto::{
    Decoder, MSG_COMMAND_OUTPUT, MSG_COMMAND_RESULT, MSG_ERROR, MSG_PING, MSG_PONG,
    MSG_PROCESS_EXIT, MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH_RESULT,
    MSG_STDOUT_CHUNK, RawMessage,
};

pub use command::{
    CommandCaptureRequest, CommandOperationHandle, CommandOperationRequest, CommandOperationResult,
    CommandOutputEvent, CommandOwnedCapturedOutput, CommandStreamRequest,
};
pub use file::{CopyFileOptions, CopyFileResult};
pub use process::ProcessExitEvent;

const READ_BUF_SIZE: usize = 64 * 1024;

/// Result of executing a command on the guest.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Connection lifecycle, expressed as data rather than a separate atomic flag.
///
/// Pending requests, active command operations, and connected process state
/// live inside the `Connected` variant so registrations are structurally
/// unreachable once the reader task has exited. Process cached exits live in
/// BOTH variants because they are an observation log — a cached exit event
/// remains a valid answer to `wait_for_exit` after the connection closes.
///
/// The invariant "connection is closed ⇔ registrations are impossible" is
/// enforced by the type: every code path that cares about liveness must
/// `match`, which precludes the old footgun of reading a stale close flag
/// without taking the corresponding lock.
enum ConnectionState {
    Connected {
        /// Pending request responses: seq → oneshot sender.
        pending: HashMap<u32, oneshot::Sender<RawMessage>>,
        /// Active command-operation state owned by the command module.
        operations: command::Operations,
        /// Legacy process lifecycle state owned by the process module.
        process: process::ConnectedProcessState,
    },
    Closed {
        /// Preserves cached process exits after connection close.
        process: process::ClosedProcessState,
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
    /// Notified when a new process exit event is cached or when the connection
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

    /// Transition `Connected → Closed`, preserving the process exit cache and
    /// dropping registration maps outside the state lock so sender drops (which
    /// wake their receivers) run without the lock held. Idempotent: a second
    /// call preserves whatever exits the first call cached and performs no
    /// further work.
    ///
    /// `mem::replace` writes a placeholder `Closed` state so the old variant
    /// can be moved out for destructuring. The `Connected` arm rebuilds
    /// `Closed` with the cached exits; the already-`Closed` arm uses an `@`
    /// binding to write the whole variant back unchanged, so "cached exits
    /// survive a double-close" is enforced by the match binding rather than by
    /// convention.
    fn close(&self) {
        self.close_with_reason("connection closed");
    }

    fn close_with_reason(&self, reason: &'static str) {
        let maps_to_drop = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match std::mem::replace(
                &mut *guard,
                ConnectionState::Closed {
                    process: process::ClosedProcessState::empty(),
                },
            ) {
                ConnectionState::Connected {
                    pending,
                    operations,
                    process,
                } => {
                    let command_snapshot = operations.close_snapshot();
                    let (closed_process, process_maps) = process.close();
                    *guard = ConnectionState::Closed {
                        process: closed_process,
                    };
                    Some((pending, process_maps, operations, command_snapshot))
                }
                closed @ ConnectionState::Closed { .. } => {
                    // Reassign the whole variant; cached exits preserved
                    // by binding, not manually reconstructed.
                    *guard = closed;
                    None
                }
            }
        };
        if let Some((pending, process_maps, operations, command_snapshot)) = maps_to_drop {
            let process_maps = process_maps.into_inner();
            let maps = (pending, process_maps, operations);
            drop(maps);
            self.exit_notify.notify_waiters();
            command::log_operations_closed(reason, &command_snapshot);
        }
    }

    fn poison_connection(&self) {
        self.close_with_reason("connection poisoned");
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
        // reader task can win that race. Closing here makes active command
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
            if msg.msg_type == MSG_ERROR {
                // Intercept active command-operation errors before the legacy
                // pending-request dispatch. If no command operation owns this
                // seq, the error falls through as a normal request response.
                match command::dispatch_error(&shared, &msg) {
                    Ok(true) => {
                        continue;
                    }
                    Ok(false) => {}
                    Err(_) => {
                        shared.poison_connection();
                        return;
                    }
                }
            }

            if msg.msg_type == MSG_COMMAND_OUTPUT {
                if command::dispatch_output(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_COMMAND_RESULT {
                if command::dispatch_result(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_STDOUT_CHUNK && msg.seq == 0 {
                process::dispatch_stdout_chunk(&shared, &msg.payload);
            } else if msg.msg_type == MSG_PROCESS_EXIT && msg.seq == 0 {
                process::dispatch_process_exit(&shared, &msg.payload);
            } else {
                // For spawn_watch_result: move the pre-registered stdout sender
                // from pending_stdout to stdout_senders BEFORE dispatching the
                // response — under one lock so the channel is keyed by pid in
                // stdout_senders before any subsequent MSG_STDOUT_CHUNK arrives.
                let response_sender = {
                    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    match &mut *guard {
                        ConnectionState::Connected {
                            pending, process, ..
                        } => {
                            if msg.msg_type == MSG_SPAWN_WATCH_RESULT {
                                process::move_stdout_registration_to_pid_before_response_dispatch(
                                    process,
                                    msg.seq,
                                    &msg.payload,
                                );
                            }
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
                operations: command::Operations::new(),
                process: process::ConnectedProcessState::new(),
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

    /// Start a request-scoped command operation using the unified command protocol.
    pub async fn start_command_operation(
        &self,
        request: CommandOperationRequest<'_>,
    ) -> io::Result<CommandOperationHandle> {
        command::start_command_operation_on_shared(&self.shared, request).await
    }

    /// Run a capture-only command operation with default capture limits.
    pub async fn command_capture_default(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        label: &str,
        wait_timeout: Duration,
    ) -> io::Result<CommandOperationResult> {
        self.command_capture(CommandCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label,
            stdout_limit_bytes: command::DEFAULT_COMMAND_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: command::DEFAULT_COMMAND_CAPTURE_LIMIT_BYTES,
            wait_timeout,
        })
        .await
    }

    /// Run a capture-only command operation with explicit stdout/stderr limits.
    pub async fn command_capture(
        &self,
        request: CommandCaptureRequest<'_>,
    ) -> io::Result<CommandOperationResult> {
        command::command_capture_on_shared(&self.shared, request).await
    }

    /// Start a streaming command operation with a bounded output event receiver.
    pub async fn command_stream(
        &self,
        request: CommandStreamRequest<'_>,
    ) -> io::Result<CommandOperationHandle> {
        command::command_stream_on_shared(&self.shared, request).await
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
        command::exec_on_shared(&self.shared, command, timeout_ms, env, sudo).await
    }

    /// Execute a capture-style command with explicit output limits.
    pub async fn exec_capture(&self, request: CommandCaptureRequest<'_>) -> io::Result<ExecResult> {
        command::exec_capture_on_shared(&self.shared, request).await
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
        process::spawn_watch_on_shared(
            &self.shared,
            command,
            timeout_ms,
            env,
            sudo,
            stream_stdout,
            stdout_log_path,
        )
        .await
    }

    /// Wait for a spawned process to exit.
    ///
    /// Returns immediately if the exit event was already cached.
    pub async fn wait_for_exit(&self, pid: u32, timeout: Duration) -> io::Result<ProcessExitEvent> {
        process::wait_for_exit_on_shared(&self.shared, pid, timeout).await
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
    use std::path::Path;
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

    fn operation_count(host: &VsockHost) -> usize {
        let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            ConnectionState::Connected { operations, .. } => operations.len(),
            ConnectionState::Closed { .. } => 0,
        }
    }

    fn is_connected(host: &VsockHost) -> bool {
        let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        matches!(&*guard, ConnectionState::Connected { .. })
    }

    async fn read_guest_message(stream: &mut UnixStream, decoder: &mut Decoder) -> RawMessage {
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0, "connection closed before message");
            let mut msgs = decoder.decode(&buf[..n]).unwrap();
            if !msgs.is_empty() {
                return msgs.remove(0);
            }
        }
    }

    async fn read_guest_messages(
        stream: &mut UnixStream,
        decoder: &mut Decoder,
        count: usize,
    ) -> Vec<RawMessage> {
        let mut messages = Vec::new();
        let mut buf = [0u8; 4096];
        while messages.len() < count {
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0, "connection closed before messages");
            messages.extend(decoder.decode(&buf[..n]).unwrap());
        }
        messages
    }

    async fn setup_host_and_guest() -> (VsockHost, UnixStream, Decoder) {
        let (host_stream, mut guest) = make_pair();
        let host_task = tokio::spawn(async move { host_from_stream(host_stream).await.unwrap() });
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
        let host = host_task.await.unwrap();
        (host, guest, decoder)
    }

    async fn start_capture_operation(host: &VsockHost, command: &str) -> CommandOperationHandle {
        host.start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command,
            env: &[],
            sudo: false,
            label: "test-command",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stream_queue_capacity: None,
        })
        .await
        .unwrap()
    }

    fn command_result_payload(
        termination: CommandTermination,
        stdout: &[u8],
        stderr: &[u8],
    ) -> Vec<u8> {
        vsock_proto::encode_command_result(
            termination,
            12,
            CommandCapturedOutput::Captured {
                bytes: stdout,
                truncated: false,
            },
            CommandCapturedOutput::Captured {
                bytes: stderr,
                truncated: false,
            },
            "",
        )
        .unwrap()
    }

    async fn send_command_result(
        stream: &mut UnixStream,
        seq: u32,
        termination: CommandTermination,
        stdout: &[u8],
        stderr: &[u8],
    ) {
        let payload = command_result_payload(termination, stdout, stderr);
        let frame = vsock_proto::encode(MSG_COMMAND_RESULT, seq, &payload).unwrap();
        stream.write_all(&frame).await.unwrap();
    }

    async fn send_stream_command_result(
        stream: &mut UnixStream,
        seq: u32,
        termination: CommandTermination,
        stderr: &[u8],
    ) {
        let payload = vsock_proto::encode_command_result(
            termination,
            12,
            CommandCapturedOutput::Discarded,
            CommandCapturedOutput::Captured {
                bytes: stderr,
                truncated: false,
            },
            "",
        )
        .unwrap();
        let frame = vsock_proto::encode(MSG_COMMAND_RESULT, seq, &payload).unwrap();
        stream.write_all(&frame).await.unwrap();
    }

    async fn send_raw_command_result(stream: &mut UnixStream, seq: u32, payload: Vec<u8>) {
        let frame = vsock_proto::encode(MSG_COMMAND_RESULT, seq, &payload).unwrap();
        stream.write_all(&frame).await.unwrap();
    }

    async fn send_discarded_command_result(
        stream: &mut UnixStream,
        seq: u32,
        termination: CommandTermination,
    ) {
        let payload = vsock_proto::encode_command_result(
            termination,
            12,
            CommandCapturedOutput::Discarded,
            CommandCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        send_raw_command_result(stream, seq, payload).await;
    }

    async fn send_command_output(
        stream: &mut UnixStream,
        seq: u32,
        output_seq: u32,
        output_stream: CommandOutputStream,
        chunk: &[u8],
        truncated: bool,
    ) {
        let payload =
            vsock_proto::encode_command_output(output_stream, output_seq, chunk, truncated)
                .unwrap();
        let frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, seq, &payload).unwrap();
        stream.write_all(&frame).await.unwrap();
    }

    async fn wait_for_operation_count(host: &VsockHost, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while operation_count(host) != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn assert_connection_accepts_command_exec(
        host: &Arc<VsockHost>,
        guest: &mut UnixStream,
        decoder: &mut Decoder,
    ) {
        let exec_task = {
            let host = Arc::clone(host);
            tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
        };
        let msg = read_guest_message(guest, decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
        assert_eq!(decoded.command, "echo ok");
        assert_eq!(decoded.label, "exec");
        send_command_result(
            guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;
        let exec_result = exec_task.await.unwrap().unwrap();
        assert_eq!(exec_result.stdout, b"ok");
    }

    #[tokio::test]
    async fn copy_file_rejects_max_bytes_above_stream_budget() {
        let (host, _guest, _decoder) = setup_host_and_guest().await;
        let err = host
            .copy_file(
                "/tmp/large.log",
                Path::new("/tmp/large.log"),
                CopyFileOptions {
                    max_bytes: file::test_support::COPY_FILE_STREAM_MAX_BYTES + 1,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("copy_file max_bytes"));
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
    async fn command_capture_sends_start_and_receives_result() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let task = {
            let host = Arc::clone(&host);
            tokio::spawn(async move {
                host.command_capture(CommandCaptureRequest {
                    timeout_ms: 7000,
                    command: "printf hello",
                    env: &[("A", "B")],
                    sudo: true,
                    label: "capture-test",
                    stdout_limit_bytes: 7,
                    stderr_limit_bytes: 9,
                    wait_timeout: Duration::from_secs(5),
                })
                .await
            })
        };

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 7000);
        assert_eq!(decoded.command, "printf hello");
        assert_eq!(decoded.env, vec![("A", "B")]);
        assert!(decoded.sudo);
        assert_eq!(decoded.label, "capture-test");
        assert_eq!(
            decoded.stdout,
            CommandOutputPolicy::Capture { limit_bytes: 7 }
        );
        assert_eq!(
            decoded.stderr,
            CommandOutputPolicy::Capture { limit_bytes: 9 }
        );

        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"stdout",
            b"stderr",
        )
        .await;

        let result = task.await.unwrap().unwrap();
        assert_eq!(
            result.termination,
            CommandTermination::Exited { exit_code: 0 }
        );
        assert_eq!(
            result.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"stdout".to_vec(),
                truncated: false,
            }
        );
        assert_eq!(
            result.stderr,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"stderr".to_vec(),
                truncated: false,
            }
        );
        assert_eq!(operation_count(&host), 0);
    }

    #[tokio::test]
    async fn command_capture_repeated_short_operations_soak() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        for i in 0..8 {
            let label = format!("repeat-{i}");
            let handle = host
                .start_command_operation(CommandOperationRequest {
                    timeout_ms: 5000,
                    command: "printf ok",
                    env: &[],
                    sudo: false,
                    label: &label,
                    stdout: CommandOutputPolicy::Capture { limit_bytes: 16 },
                    stderr: CommandOutputPolicy::Capture { limit_bytes: 16 },
                    stream_queue_capacity: None,
                })
                .await
                .unwrap();

            let msg = read_guest_message(&mut guest, &mut decoder).await;
            assert_eq!(msg.msg_type, MSG_COMMAND_START);
            let stdout = format!("ok-{i}");
            send_command_result(
                &mut guest,
                msg.seq,
                CommandTermination::Exited { exit_code: 0 },
                stdout.as_bytes(),
                b"",
            )
            .await;

            let result = handle.wait(Duration::from_secs(5)).await.unwrap();
            assert_eq!(
                result.stdout,
                CommandOwnedCapturedOutput::Captured {
                    bytes: stdout.into_bytes(),
                    truncated: false,
                }
            );
            assert_eq!(operation_count(&host), 0);
            assert!(is_connected(&host));
        }

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_capture_large_stdout_stderr_within_limits_soak() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let stdout = vec![b'o'; 64 * 1024];
        let stderr = vec![b'e'; 64 * 1024];
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "large-capture",
                env: &[],
                sudo: false,
                label: "large-capture",
                stdout: CommandOutputPolicy::Capture {
                    limit_bytes: stdout.len() as u32,
                },
                stderr: CommandOutputPolicy::Capture {
                    limit_bytes: stderr.len() as u32,
                },
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            &stdout,
            &stderr,
        )
        .await;

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: stdout,
                truncated: false,
            }
        );
        assert_eq!(
            result.stderr,
            CommandOwnedCapturedOutput::Captured {
                bytes: stderr,
                truncated: false,
            }
        );
        assert_eq!(operation_count(&host), 0);
        assert!(is_connected(&host));
    }

    #[tokio::test]
    async fn command_result_preserves_non_default_metadata() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "metadata",
                env: &[],
                sudo: false,
                label: "metadata",
                stdout: CommandOutputPolicy::Discard,
                stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stream_queue_capacity: None,
            })
            .await
            .unwrap();
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        let payload = vsock_proto::encode_command_result(
            CommandTermination::WaitFailed,
            345,
            CommandCapturedOutput::Discarded,
            CommandCapturedOutput::Captured {
                bytes: b"stderr",
                truncated: true,
            },
            "wait failed",
        )
        .unwrap();
        let frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &payload).unwrap();
        guest.write_all(&frame).await.unwrap();

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(result.termination, CommandTermination::WaitFailed);
        assert_eq!(result.duration_ms, 345);
        assert_eq!(result.stdout, CommandOwnedCapturedOutput::Discarded);
        assert_eq!(
            result.stderr,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"stderr".to_vec(),
                truncated: true,
            }
        );
        assert_eq!(result.diagnostic, "wait failed");
    }

    #[tokio::test]
    async fn command_result_capture_for_discard_policy_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "discard",
                env: &[],
                sudo: false,
                label: "discard-result",
                stdout: CommandOutputPolicy::Discard,
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        let payload = vsock_proto::encode_command_result(
            CommandTermination::Exited { exit_code: 0 },
            1,
            CommandCapturedOutput::Captured {
                bytes: b"unexpected",
                truncated: false,
            },
            CommandCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        send_raw_command_result(&mut guest, msg.seq, payload).await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_result_over_capture_limit_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "capture-limit",
                env: &[],
                sudo: false,
                label: "capture-limit",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 4 },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        let payload = vsock_proto::encode_command_result(
            CommandTermination::Exited { exit_code: 0 },
            1,
            CommandCapturedOutput::Captured {
                bytes: b"abcde",
                truncated: true,
            },
            CommandCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        send_raw_command_result(&mut guest, msg.seq, payload).await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_result_discard_for_capture_policy_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "missing-capture",
                env: &[],
                sudo: false,
                label: "missing-capture",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 4 },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        let payload = vsock_proto::encode_command_result(
            CommandTermination::Exited { exit_code: 0 },
            1,
            CommandCapturedOutput::Discarded,
            CommandCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        send_raw_command_result(&mut guest, msg.seq, payload).await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_result_zero_capture_limit_accepts_empty_capture() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "zero-capture",
                env: &[],
                sudo: false,
                label: "zero-capture",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 0 },
                stderr: CommandOutputPolicy::Capture { limit_bytes: 0 },
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        let payload = vsock_proto::encode_command_result(
            CommandTermination::Exited { exit_code: 0 },
            1,
            CommandCapturedOutput::Captured {
                bytes: b"",
                truncated: true,
            },
            CommandCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            },
            "",
        )
        .unwrap();
        send_raw_command_result(&mut guest, msg.seq, payload).await;

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: true,
            }
        );
        assert_eq!(
            result.stderr,
            CommandOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            }
        );
        assert!(is_connected(&host));
    }

    #[tokio::test]
    async fn command_stream_rejects_zero_capacity_without_sending_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = match host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "zero-capacity",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(0),
            })
            .await
        {
            Ok(_) => panic!("zero stream capacity should be rejected"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_stream_rejects_oversized_capacity_without_sending_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = match host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "oversized-capacity",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(command::test_support::MAX_STREAM_CAPACITY + 1),
            })
            .await
        {
            Ok(_) => panic!("oversized stream capacity should be rejected"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_start_stream_policy_uses_default_receiver() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let mut handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "default-receiver",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stderr: CommandOutputPolicy::CaptureAndStream {
                    capture_limit_bytes: 1024,
                    stream_limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stream_queue_capacity: None,
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stderr,
            b"default-queued",
            false,
        )
        .await;
        let event = rx.recv().await.unwrap();
        assert_eq!(event.stream, CommandOutputStream::Stderr);
        assert_eq!(event.chunk, b"default-queued");
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"",
            b"",
        )
        .await;
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert!(!result.stream_overflowed);
    }

    #[tokio::test]
    async fn command_start_rejects_receiver_without_stream_policy() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = match host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "capture",
                env: &[],
                sudo: false,
                label: "unexpected-receiver",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
        {
            Ok(_) => panic!("receiver without streaming output policy should be rejected"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_stream_rejects_non_streaming_policy() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = match host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "capture",
                env: &[],
                sudo: false,
                label: "non-streaming-helper",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: None,
            })
            .await
        {
            Ok(_) => panic!("command_stream should reject non-streaming output policies"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_start_encode_error_does_not_register_or_send_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = match host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "bad-policy",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 0,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
        {
            Ok(_) => panic!("invalid command output policy should be rejected"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_start_rejects_zero_timeout_without_sending_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = match host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 0,
                command: "sleep 60",
                env: &[],
                sudo: false,
                label: "zero-timeout",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stream_queue_capacity: None,
            })
            .await
        {
            Ok(_) => panic!("zero timeout command operation should be rejected"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_operations_dispatch_out_of_order_results_by_seq() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let first = start_capture_operation(&host, "cmd-a").await;
        let second = start_capture_operation(&host, "cmd-b").await;

        let mut messages = read_guest_messages(&mut guest, &mut decoder, 2).await;
        let msg_a = messages.remove(0);
        let msg_b = messages.remove(0);
        assert_eq!(msg_a.msg_type, MSG_COMMAND_START);
        assert_eq!(msg_b.msg_type, MSG_COMMAND_START);

        send_command_result(
            &mut guest,
            msg_b.seq,
            CommandTermination::Exited { exit_code: 2 },
            b"b",
            b"",
        )
        .await;
        send_command_result(
            &mut guest,
            msg_a.seq,
            CommandTermination::Exited { exit_code: 1 },
            b"a",
            b"",
        )
        .await;

        let first = first.wait(Duration::from_secs(5)).await.unwrap();
        let second = second.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            first.termination,
            CommandTermination::Exited { exit_code: 1 }
        );
        assert_eq!(
            first.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"a".to_vec(),
                truncated: false,
            }
        );
        assert_eq!(
            second.termination,
            CommandTermination::Exited { exit_code: 2 }
        );
        assert_eq!(
            second.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"b".to_vec(),
                truncated: false,
            }
        );
    }

    #[tokio::test]
    async fn command_stream_dispatches_stdout_stderr_and_closes_on_result() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-test",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stream_queue_capacity: None,
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"out",
            false,
        )
        .await;
        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stderr,
            b"err",
            true,
        )
        .await;

        let out = rx.recv().await.unwrap();
        assert_eq!(out.stream, CommandOutputStream::Stdout);
        assert_eq!(out.output_seq, 0);
        assert_eq!(out.chunk, b"out");
        assert!(!out.truncated);

        let err = rx.recv().await.unwrap();
        assert_eq!(err.stream, CommandOutputStream::Stderr);
        assert_eq!(err.output_seq, 1);
        assert_eq!(err.chunk, b"err");
        assert!(err.truncated);

        send_discarded_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
        )
        .await;
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert!(!result.stream_overflowed);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn command_stream_full_channel_closes_stream_and_marks_result() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-overflow",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"first",
            false,
        )
        .await;
        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stdout,
            b"second",
            false,
        )
        .await;
        send_discarded_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
        )
        .await;

        let first = rx.recv().await.unwrap();
        assert_eq!(first.output_seq, 0);
        assert_eq!(first.chunk, b"first");
        assert!(rx.recv().await.is_none());

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert!(result.stream_overflowed);
    }

    #[tokio::test]
    async fn command_stream_many_chunks_soak_does_not_block_terminal_result() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream-many",
                env: &[],
                sudo: false,
                label: "stream-many",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(2),
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        for output_seq in 0..32 {
            send_command_output(
                &mut guest,
                msg.seq,
                output_seq,
                CommandOutputStream::Stdout,
                b"x",
                false,
            )
            .await;
        }
        send_discarded_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
        )
        .await;

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert!(result.stream_overflowed);
        assert_eq!(operation_count(&host), 0);
        let mut buffered_chunks = 0;
        loop {
            match rx.try_recv() {
                Ok(_) => buffered_chunks += 1,
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    panic!("stream receiver should be closed after terminal result");
                }
            }
        }
        assert!(buffered_chunks <= 2);
    }

    #[tokio::test]
    async fn command_output_for_non_streamed_side_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-side",
                stdout: CommandOutputPolicy::Discard,
                stderr: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"unexpected",
            false,
        )
        .await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_output_seq_gap_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-seq",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stdout,
            b"gap",
            false,
        )
        .await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_output_zero_stream_limit_accepts_empty_truncation_marker() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-zero-limit",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 0,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"",
            true,
        )
        .await;
        send_discarded_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
        )
        .await;

        let event = rx.recv().await.unwrap();
        assert_eq!(event.output_seq, 0);
        assert_eq!(event.chunk, b"");
        assert!(event.truncated);
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert!(!result.stream_overflowed);
    }

    #[tokio::test]
    async fn command_output_empty_non_truncated_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-empty",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"",
            false,
        )
        .await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_output_over_requested_chunk_limit_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-limits",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 4,
                    chunk_limit_bytes: 3,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(4),
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"abcd",
            false,
        )
        .await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_output_over_requested_stream_limit_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-total-limit",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 4,
                    chunk_limit_bytes: 3,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(4),
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"abc",
            false,
        )
        .await;
        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stdout,
            b"de",
            false,
        )
        .await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_output_after_truncation_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-truncated",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 4,
                    chunk_limit_bytes: 4,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(4),
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"",
            true,
        )
        .await;
        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stdout,
            b"late",
            false,
        )
        .await;

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_stream_dropped_receiver_does_not_block_result() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "stream-dropped",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();
        drop(handle.take_stream_receiver());

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"ignored",
            false,
        )
        .await;
        send_discarded_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
        )
        .await;

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert!(!result.stream_overflowed);
    }

    #[tokio::test]
    async fn command_wait_timeout_cleans_operation_state() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "timeout").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        assert_eq!(operation_count(&host), 1);

        let err = handle.wait(Duration::ZERO).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(operation_count(&host), 0);
        assert!(is_connected(&host));
    }

    #[tokio::test]
    async fn command_error_response_completes_operation_without_timeout() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "error-response").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        let payload = vsock_proto::encode_error("command operation already active");
        let frame = vsock_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap();
        guest.write_all(&frame).await.unwrap();

        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Other);
        assert_eq!(err.to_string(), "command operation already active");
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn malformed_command_error_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "bad-error").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        let frame = vsock_proto::encode(MSG_ERROR, msg.seq, &[0]).unwrap();
        guest.write_all(&frame).await.unwrap();

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_connection_close_wakes_result_and_stream() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "close",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        drop(guest);
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn command_start_after_connection_close_returns_connection_reset() {
        let (host, guest, _decoder) = setup_host_and_guest().await;
        drop(guest);
        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();

        let err = match host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "echo ok",
                env: &[],
                sudo: false,
                label: "closed",
                stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
                stream_queue_capacity: None,
            })
            .await
        {
            Ok(_) => panic!("command start after connection close should fail"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
        assert_eq!(operation_count(&host), 0);
    }

    #[tokio::test]
    async fn host_drop_closes_active_command_result_and_stream() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let mut handle = host
            .command_stream(CommandStreamRequest {
                timeout_ms: 5000,
                command: "stream",
                env: &[],
                sudo: false,
                label: "host-drop",
                stdout: CommandOutputPolicy::Stream {
                    limit_bytes: 1024,
                    chunk_limit_bytes: 16,
                },
                stderr: CommandOutputPolicy::Discard,
                stream_queue_capacity: Some(1),
            })
            .await
            .unwrap();
        let mut rx = handle.take_stream_receiver().unwrap();
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        drop(host);

        let err =
            tokio::time::timeout(Duration::from_secs(5), handle.wait(Duration::from_secs(60)))
                .await
                .unwrap()
                .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn malformed_command_output_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "bad-output").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        let frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, msg.seq, &[0]).unwrap();
        guest.write_all(&frame).await.unwrap();

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn malformed_command_result_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "bad-result").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        let frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &[0]).unwrap();
        guest.write_all(&frame).await.unwrap();

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
        let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn command_output_after_result_does_not_poison_or_resurrect_state() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "done").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"done",
            b"",
        )
        .await;
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.termination,
            CommandTermination::Exited { exit_code: 0 }
        );
        assert_eq!(operation_count(&host), 0);

        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stdout,
            b"late",
            false,
        )
        .await;

        let exec_task = tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await });
        let exec_msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(exec_msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&exec_msg.payload).unwrap();
        assert_eq!(decoded.command, "echo ok");
        send_command_result(
            &mut guest,
            exec_msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;
        let exec_result = exec_task.await.unwrap().unwrap();
        assert_eq!(exec_result.stdout, b"ok");
    }

    #[tokio::test]
    async fn malformed_command_output_after_result_is_ignored() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "done").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"done",
            b"",
        )
        .await;
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.termination,
            CommandTermination::Exited { exit_code: 0 }
        );
        assert_eq!(operation_count(&host), 0);

        let frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, msg.seq, &[0]).unwrap();
        guest.write_all(&frame).await.unwrap();

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn malformed_command_frames_after_handle_drop_are_ignored() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "abandoned").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        assert_eq!(operation_count(&host), 1);

        drop(handle);
        wait_for_operation_count(&host, 0).await;

        let output_frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, msg.seq, &[0]).unwrap();
        guest.write_all(&output_frame).await.unwrap();
        let result_frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &[0]).unwrap();
        guest.write_all(&result_frame).await.unwrap();

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn duplicate_command_result_after_completion_is_ignored() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "duplicate-result").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"first",
            b"",
        )
        .await;
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"first".to_vec(),
                truncated: false,
            }
        );
        assert_eq!(operation_count(&host), 0);

        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 1 },
            b"duplicate",
            b"",
        )
        .await;

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn malformed_duplicate_command_result_after_completion_is_ignored() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "malformed-duplicate-result").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);

        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"first",
            b"",
        )
        .await;
        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: b"first".to_vec(),
                truncated: false,
            }
        );
        assert_eq!(operation_count(&host), 0);

        let frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &[0]).unwrap();
        guest.write_all(&frame).await.unwrap();

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_start_cancelled_before_write_does_not_poison_or_send_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let writer_guard = host.shared.writer.lock().await;
        let task = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { start_capture_operation(&host, "blocked").await })
        };

        tokio::time::timeout(Duration::from_secs(5), async {
            while operation_count(&host) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        assert_eq!(operation_count(&host), 0);
        assert!(is_connected(&host));

        drop(writer_guard);
        let exec_task = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
        };
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(
            msg.msg_type, MSG_COMMAND_START,
            "start frame should not be written"
        );
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;
        let exec_result = exec_task.await.unwrap().unwrap();
        assert_eq!(exec_result.stdout, b"ok");
        assert!(is_connected(&host));
    }

    #[tokio::test]
    async fn command_handle_drop_after_full_write_sends_no_cancel() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "drop-after-write").await;
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        drop(handle);
        assert_eq!(operation_count(&host), 0);

        let exec_task = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
        };
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(
            msg.msg_type, MSG_COMMAND_START,
            "drop must not send command cancel"
        );
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;
        let exec_result = exec_task.await.unwrap().unwrap();
        assert_eq!(exec_result.stdout, b"ok");
        assert!(is_connected(&host));
    }

    #[tokio::test]
    async fn command_cancel_sends_cancel_and_waits_for_cancelled_result() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "cancel").await;
        let start = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(start.msg_type, MSG_COMMAND_START);

        let cancel_task =
            tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
        let cancel = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
        assert_eq!(cancel.seq, start.seq);
        vsock_proto::decode_command_cancel(&cancel.payload).unwrap();

        send_command_result(
            &mut guest,
            start.seq,
            CommandTermination::Cancelled,
            b"",
            b"",
        )
        .await;
        let result = cancel_task.await.unwrap().unwrap();
        assert_eq!(result.termination, CommandTermination::Cancelled);
    }

    #[tokio::test]
    async fn command_cancel_after_terminal_result_returns_result_without_cancel_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "already-done").await;
        let start = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(start.msg_type, MSG_COMMAND_START);
        send_command_result(
            &mut guest,
            start.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"done",
            b"",
        )
        .await;
        wait_for_operation_count(&host, 0).await;

        let result = handle
            .cancel_and_wait(Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            result.termination,
            CommandTermination::Exited { exit_code: 0 }
        );

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_cancel_non_cancelled_terminal_result_cleans_operation_without_poisoning() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let handle = start_capture_operation(&host, "cancel-race").await;
        let start = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(start.msg_type, MSG_COMMAND_START);

        let cancel_task =
            tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
        let cancel = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
        assert_eq!(cancel.seq, start.seq);

        send_command_result(
            &mut guest,
            start.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"",
            b"",
        )
        .await;
        let err = cancel_task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Other);
        assert_eq!(operation_count(&host), 0);
        assert!(is_connected(&host));

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_cancel_result_timeout_poisons_connection() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let handle = start_capture_operation(&host, "cancel-timeout").await;
        let start = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(start.msg_type, MSG_COMMAND_START);

        let cancel_task = tokio::spawn(async move { handle.cancel_and_wait(Duration::ZERO).await });
        let cancel = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
        assert_eq!(cancel.seq, start.seq);

        let err = cancel_task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn command_frame_write_guard_started_drop_poisons_connection() {
        let (host, _guest, _decoder) = setup_host_and_guest().await;
        command::test_support::drop_started_frame_write_guard(Arc::clone(&host.shared));
        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();
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
            assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);

            let d = vsock_proto::decode_command_start(&msgs[0].payload).unwrap();
            assert_eq!(d.command, "echo hello");
            assert_eq!(d.timeout_ms, 5000);
            assert!(d.env.is_empty());
            assert!(!d.sudo);
            assert_eq!(d.label, "exec");

            send_command_result(
                &mut guest,
                msgs[0].seq,
                CommandTermination::Exited { exit_code: 0 },
                b"hello\n",
                b"",
            )
            .await;
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
        let err = host.exec("badcmd", 5000, &[], false).await.unwrap_err();
        assert!(err.to_string().contains("command not found"));
    }

    #[tokio::test]
    async fn read_file_returns_content_and_missing() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let read_task = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.read_file("/tmp/session.txt", 1024, 5000).await })
        };
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
        assert_eq!(decoded.label, "read-file");
        assert!(decoded.command.contains("cat -- '/tmp/session.txt'"));
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"session-id\n",
            b"",
        )
        .await;
        let content = read_task.await.unwrap().unwrap();
        assert_eq!(content.as_deref(), Some(&b"session-id\n"[..]));

        let missing_task = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.read_file("/tmp/missing.txt", 1024, 5000).await })
        };
        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 66 },
            b"",
            b"",
        )
        .await;
        let missing = missing_task.await.unwrap().unwrap();
        assert_eq!(missing, None);
    }

    #[tokio::test]
    async fn read_file_errors_on_truncated_stdout() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let read_task =
            tokio::spawn(async move { host.read_file("/tmp/large.txt", 5, 5000).await });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let payload = vsock_proto::encode_command_result(
            CommandTermination::Exited { exit_code: 0 },
            12,
            CommandCapturedOutput::Captured {
                bytes: b"hello",
                truncated: true,
            },
            CommandCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            },
            "",
        )
        .unwrap();
        send_raw_command_result(&mut guest, msg.seq, payload).await;

        let err = read_task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("exceeded 5 bytes"));
    }

    #[tokio::test]
    async fn read_file_rejects_invalid_max_bytes_without_sending_frame() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);

        let err = host.read_file("/tmp/empty.txt", 0, 5000).await.unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        let err = host
            .read_file("/tmp/huge.txt", u64::from(u32::MAX) + 1, 5000)
            .await
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);
        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn read_file_quotes_guest_path_with_single_quote() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let read_task =
            tokio::spawn(async move { host.read_file("/tmp/session'one.txt", 1024, 5000).await });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
        assert_eq!(
            decoded.command,
            "if test -f '/tmp/session'\\''one.txt'; then cat -- '/tmp/session'\\''one.txt'; else exit 66; fi"
        );
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;

        let content = read_task.await.unwrap().unwrap();
        assert_eq!(content.as_deref(), Some(&b"ok"[..]));
    }

    #[tokio::test]
    async fn copy_file_streams_to_temp_then_renames() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("vsock-host-copy-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");
        let copy_path = host_path.clone();

        let copy_task = tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
        assert_eq!(decoded.label, "copy-file");
        assert_eq!(
            decoded.command,
            "if test -f '/tmp/vm0-system-run.log'; then cat -- '/tmp/vm0-system-run.log'; else exit 66; fi"
        );
        assert_eq!(
            decoded.stdout,
            CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 64 * 1024,
            }
        );
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"line 1\n",
            false,
        )
        .await;
        send_command_output(
            &mut guest,
            msg.seq,
            1,
            CommandOutputStream::Stdout,
            b"line 2\n",
            false,
        )
        .await;
        send_stream_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"",
        )
        .await;

        let result = copy_task.await.unwrap().unwrap();
        assert_eq!(result.bytes_copied, 14);
        assert_eq!(std::fs::read(&host_path).unwrap(), b"line 1\nline 2\n");
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")),
            "copy temp file should not remain"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn copy_file_rejects_invalid_options_without_sending_frame_or_creating_parent() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-invalid-{}-{unique}",
            std::process::id()
        ));
        let host_path = dir.join("nested/system.log");

        let err = host
            .copy_file(
                "/tmp/system.log",
                &host_path,
                CopyFileOptions {
                    max_bytes: 0,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!dir.exists());

        let err = host
            .copy_file(
                "/tmp/system.log",
                &host_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 0,
                    missing_ok: false,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!dir.exists());
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn copy_file_creates_parent_and_quotes_guest_path_with_single_quote() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-parent-quote-{}-{unique}",
            std::process::id()
        ));
        let host_path = dir.join("nested/system.log");
        let copy_path = host_path.clone();

        let copy_task = tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run's.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
        assert_eq!(
            decoded.command,
            "if test -f '/tmp/vm0-system-run'\\''s.log'; then cat -- '/tmp/vm0-system-run'\\''s.log'; else exit 66; fi"
        );
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"quoted path\n",
            false,
        )
        .await;
        send_stream_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            b"",
        )
        .await;

        let result = copy_task.await.unwrap().unwrap();
        assert_eq!(result.bytes_copied, 12);
        assert_eq!(std::fs::read(&host_path).unwrap(), b"quoted path\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn copy_file_removes_temp_without_publishing_on_stream_truncation() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-truncated-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");
        std::fs::write(&host_path, b"old host log").unwrap();
        let copy_path = host_path.clone();

        let copy_task = tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"partial",
            true,
        )
        .await;

        let cancel = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
        assert_eq!(cancel.seq, msg.seq);
        send_stream_command_result(&mut guest, msg.seq, CommandTermination::Cancelled, b"").await;

        let err = copy_task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("truncated"));
        assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")),
            "failed copy temp file should be removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn copy_file_nonzero_exit_removes_temp_without_publishing_partial_output() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-nonzero-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");
        std::fs::write(&host_path, b"old host log").unwrap();
        let copy_path = host_path.clone();

        let copy_task = tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        send_command_output(
            &mut guest,
            msg.seq,
            0,
            CommandOutputStream::Stdout,
            b"partial",
            false,
        )
        .await;
        send_stream_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 1 },
            b"read error",
        )
        .await;

        let err = copy_task.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("read error"));
        assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")),
            "failed copy temp file should be removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn copy_file_missing_ok_leaves_no_final_or_temp_file() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-missing-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");
        let copy_path = host_path.clone();

        let copy_task = tokio::spawn(async move {
            host.copy_file(
                "/tmp/missing.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: true,
                },
            )
            .await
        });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        send_stream_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 66 },
            b"",
        )
        .await;

        let result = copy_task.await.unwrap().unwrap();
        assert_eq!(result.bytes_copied, 0);
        assert!(!host_path.exists());
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")),
            "missing copy temp file should be removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn copy_file_missing_without_missing_ok_preserves_existing_file_and_removes_temp() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-missing-error-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");
        std::fs::write(&host_path, b"old host log").unwrap();
        let copy_path = host_path.clone();

        let copy_task = tokio::spawn(async move {
            host.copy_file(
                "/tmp/missing.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        });

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        send_stream_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 66 },
            b"",
        )
        .await;

        let err = copy_task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")),
            "missing copy temp file should be removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn copy_file_cancellation_cancels_guest_command_and_removes_temp() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-cancel-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");
        let copy_path = host_path.clone();

        let task_host = Arc::clone(&host);
        let copy_task = tokio::spawn(async move {
            task_host
                .copy_file(
                    "/tmp/vm0-system-run.log",
                    &copy_path,
                    CopyFileOptions {
                        max_bytes: 1024,
                        timeout_ms: 5000,
                        missing_ok: false,
                    },
                )
                .await
        });

        let start = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(start.msg_type, MSG_COMMAND_START);
        let temp_paths: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains("vm0tmp"))
            })
            .collect();
        assert_eq!(temp_paths.len(), 1);

        copy_task.abort();
        assert!(copy_task.await.unwrap_err().is_cancelled());

        let cancel = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
        assert_eq!(cancel.seq, start.seq);
        assert!(!host_path.exists());
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")),
            "cancelled copy temp file should be removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
        let chunk_limit = file::test_support::WRITE_FILE_CHUNK_LIMIT;
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
                    } else if msg.msg_type == MSG_COMMAND_START {
                        // Atomic rename: mv temp → target
                        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        assert!(decoded.command.contains("mv -f --"));
                        assert!(decoded.command.contains(temp_path));
                        assert!(decoded.command.contains("/tmp/big.bin"));
                        assert_eq!(decoded.label, "write-file-rename");

                        send_command_result(
                            &mut guest,
                            msg.seq,
                            CommandTermination::Exited { exit_code: 0 },
                            &[],
                            &[],
                        )
                        .await;
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

        let chunk_limit = file::test_support::WRITE_FILE_CHUNK_LIMIT;
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

        let chunk_limit = file::test_support::WRITE_FILE_CHUNK_LIMIT;
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
                    } else if msg.msg_type == MSG_COMMAND_START {
                        // Cleanup: rm -f temp file
                        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        assert!(decoded.command.contains("rm -f --"));
                        assert!(decoded.command.contains(temp_path));
                        assert_eq!(decoded.label, "exec-cleanup");
                        send_command_result(
                            &mut guest,
                            msg.seq,
                            CommandTermination::Exited { exit_code: 0 },
                            &[],
                            &[],
                        )
                        .await;
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

        let chunk_limit = file::test_support::WRITE_FILE_CHUNK_LIMIT;
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
                    } else if msg.msg_type == MSG_COMMAND_START {
                        exec_count += 1;
                        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        if decoded.command.contains("mv -f --") {
                            // mv fails
                            assert!(decoded.command.contains(temp_path));
                            assert_eq!(decoded.label, "write-file-rename");
                            send_command_result(
                                &mut guest,
                                msg.seq,
                                CommandTermination::Exited { exit_code: 1 },
                                &[],
                                b"permission denied",
                            )
                            .await;
                        } else {
                            // cleanup rm
                            assert!(decoded.command.contains("rm -f --"));
                            assert!(decoded.command.contains(temp_path));
                            assert_eq!(decoded.label, "exec-cleanup");
                            send_command_result(
                                &mut guest,
                                msg.seq,
                                CommandTermination::Exited { exit_code: 0 },
                                &[],
                                &[],
                            )
                            .await;
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

        let chunk_limit = file::test_support::WRITE_FILE_CHUNK_LIMIT;
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
                    } else if msg.msg_type == MSG_COMMAND_START {
                        let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
                        let temp_path = temp_path.as_ref().expect("temp path");
                        assert!(decoded.command.contains("rm -f --"));
                        assert!(decoded.command.contains(temp_path));
                        assert_eq!(decoded.label, "exec-cleanup");
                        if let Some(tx) = cleanup_tx.take() {
                            let _ = tx.send(decoded.command.to_string());
                        }
                        send_command_result(
                            &mut guest,
                            msg.seq,
                            CommandTermination::Exited { exit_code: 0 },
                            &[],
                            &[],
                        )
                        .await;
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
            assert!(all_msgs.iter().all(|m| m.msg_type == MSG_COMMAND_START));

            // Reply in reverse order to exercise seq-based dispatching.
            for msg in all_msgs.iter().rev() {
                let d = vsock_proto::decode_command_start(&msg.payload).unwrap();
                let out = format!("reply:{}", d.command);
                send_command_result(
                    &mut guest,
                    msg.seq,
                    CommandTermination::Exited { exit_code: 0 },
                    out.as_bytes(),
                    b"",
                )
                .await;
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
            assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);
            // Handshake used seq=1, so first request must be seq=2.
            assert_eq!(msgs[0].seq, 2, "first post-handshake seq should be 2");

            send_command_result(
                &mut guest,
                msgs[0].seq,
                CommandTermination::Exited { exit_code: 0 },
                b"ok",
                b"",
            )
            .await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("test", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 0);
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
            assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);

            // Write the response and close the socket. The response must
            // race with EOF such that reader_loop processes both before the
            // host's `request_raw` returns from its select!.
            send_command_result(
                &mut guest,
                msgs[0].seq,
                CommandTermination::Exited { exit_code: 0 },
                b"race-survived",
                b"",
            )
            .await;
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
}
