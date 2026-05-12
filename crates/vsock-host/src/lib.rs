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
use std::os::unix::io::RawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};

use vsock_proto::{
    CommandCapturedOutput, CommandOutputPolicy, CommandOutputStream, CommandTermination, Decoder,
    MSG_COMMAND_CANCEL, MSG_COMMAND_OUTPUT, MSG_COMMAND_RESULT, MSG_COMMAND_START, MSG_ERROR,
    MSG_EXEC, MSG_EXEC_RESULT, MSG_PING, MSG_PONG, MSG_PROCESS_EXIT, MSG_READY, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, RawMessage,
};

const READ_BUF_SIZE: usize = 64 * 1024;
const DEFAULT_COMMAND_CAPTURE_LIMIT_BYTES: u32 = 1024 * 1024;
const DEFAULT_COMMAND_STREAM_CAPACITY: usize = 32;
const MAX_COMMAND_STREAM_CAPACITY: usize = 1024;
const COMMAND_FRAME_WRITE_NOT_STARTED: u8 = 0;
const COMMAND_FRAME_WRITE_STARTED: u8 = 1;
const COMMAND_FRAME_WRITE_COMPLETED: u8 = 2;

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

/// Owned captured output from a command operation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOwnedCapturedOutput {
    /// The stream was discarded by policy and therefore has no captured bytes.
    Discarded,
    /// The stream was captured, possibly with protocol-level truncation.
    Captured { bytes: Vec<u8>, truncated: bool },
}

/// Terminal result for a host command operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOperationResult {
    pub termination: CommandTermination,
    pub duration_ms: u32,
    pub stdout: CommandOwnedCapturedOutput,
    pub stderr: CommandOwnedCapturedOutput,
    pub diagnostic: String,
    pub stream_overflowed: bool,
}

/// Streamed output event for a host command operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutputEvent {
    pub stream: CommandOutputStream,
    pub output_seq: u32,
    pub chunk: Vec<u8>,
    pub truncated: bool,
}

/// Request parameters for starting a command operation.
pub struct CommandOperationRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: CommandOutputPolicy,
    pub stderr: CommandOutputPolicy,
    /// Optional bounded host-side output event queue override.
    ///
    /// `None` uses the default queue capacity when either output policy
    /// streams, and creates no queue when neither output policy streams.
    /// `Some` is valid only when stdout or stderr streams; zero and oversized
    /// capacities are rejected.
    pub stream_queue_capacity: Option<usize>,
}

/// Request parameters for a capture-only command operation helper.
pub struct CommandCaptureRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
    pub wait_timeout: Duration,
}

/// Request parameters for a streaming command operation helper.
pub struct CommandStreamRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: CommandOutputPolicy,
    pub stderr: CommandOutputPolicy,
    /// Optional host-side output event queue capacity override.
    ///
    /// `None` uses the default queue capacity. Zero and oversized capacities
    /// are rejected.
    pub stream_queue_capacity: Option<usize>,
}

struct CommandOperation {
    result_tx: oneshot::Sender<io::Result<CommandOperationResult>>,
    stream_tx: Option<mpsc::Sender<CommandOutputEvent>>,
    stdout_capture: CommandCaptureState,
    stderr_capture: CommandCaptureState,
    stdout_stream: Option<CommandStreamState>,
    stderr_stream: Option<CommandStreamState>,
    expected_output_seq: u32,
    stream_overflowed: bool,
}

enum Operation {
    Command(CommandOperation),
}

enum CommandCaptureState {
    Discard,
    Capture { limit_bytes: usize },
}

struct CommandStreamState {
    limit_bytes: usize,
    chunk_limit_bytes: usize,
    emitted_bytes: usize,
    truncated: bool,
}

/// Connection lifecycle, expressed as data rather than a separate atomic flag.
///
/// The three registration tables (`pending`, `pending_stdout`, `stdout_senders`)
/// live inside the `Connected` variant so they are structurally unreachable
/// once the reader task has exited. `exits` lives in BOTH variants because it
/// is an observation log — a cached exit event remains a valid answer to
/// `wait_for_exit` after the connection closes.
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
        /// Active request-scoped operations: seq → operation state.
        operations: HashMap<u32, Operation>,
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
    /// Raw fd of the underlying socket, used to poison a corrupted stream.
    fd: RawFd,
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

struct CommandOperationRegistrationGuard {
    shared: Arc<Shared>,
    seq: u32,
    disarmed: bool,
}

impl CommandOperationRegistrationGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self {
            shared,
            seq,
            disarmed: false,
        }
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for CommandOperationRegistrationGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            self.shared.remove_operation(self.seq);
        }
    }
}

struct CommandFrameWriteGuard {
    shared: Arc<Shared>,
    state: Arc<AtomicU8>,
}

impl CommandFrameWriteGuard {
    fn new(shared: Arc<Shared>, state: Arc<AtomicU8>) -> Self {
        Self { shared, state }
    }
}

impl Drop for CommandFrameWriteGuard {
    fn drop(&mut self) {
        if self.state.load(Ordering::Acquire) == COMMAND_FRAME_WRITE_STARTED {
            self.shared.poison_connection();
        }
    }
}

/// Handle for a host-side command operation.
///
/// Dropping the handle removes the host-side registration only. It never sends
/// `MSG_COMMAND_CANCEL`; callers that need remote cancellation must call
/// [`CommandOperationHandle::cancel_and_wait`].
pub struct CommandOperationHandle {
    shared: Arc<Shared>,
    seq: Option<u32>,
    result_rx: Option<oneshot::Receiver<io::Result<CommandOperationResult>>>,
    stream_rx: Option<mpsc::Receiver<CommandOutputEvent>>,
}

impl CommandOperationHandle {
    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<CommandOutputEvent>> {
        self.stream_rx.take()
    }

    /// Wait for the terminal command result.
    ///
    /// On timeout, this removes the host-side operation registration but does
    /// not cancel the guest-side command.
    pub async fn wait(self, timeout: Duration) -> io::Result<CommandOperationResult> {
        self.wait_with_timeout(timeout, false).await
    }

    /// Send an explicit cancel request and wait for a cancelled terminal result.
    ///
    /// If the terminal result is already available before cancel is sent, this
    /// returns that result without sending a duplicate cancel frame.
    pub async fn cancel_and_wait(
        mut self,
        timeout: Duration,
    ) -> io::Result<CommandOperationResult> {
        if let Some(result) = self.try_take_ready_result()? {
            return Ok(result);
        }

        let seq = self.seq.ok_or_else(|| {
            io::Error::new(io::ErrorKind::ConnectionReset, "command operation closed")
        })?;
        let payload = vsock_proto::encode_command_cancel();
        write_command_frame(&self.shared, MSG_COMMAND_CANCEL, seq, &payload).await?;

        let result = self.wait_with_timeout(timeout, true).await?;
        if result.termination == CommandTermination::Cancelled {
            return Ok(result);
        }

        Err(io::Error::other(format!(
            "command cancel returned terminal state: {:?}",
            result.termination
        )))
    }

    fn try_take_ready_result(&mut self) -> io::Result<Option<CommandOperationResult>> {
        let Some(rx) = self.result_rx.as_mut() else {
            return Ok(None);
        };

        match rx.try_recv() {
            Ok(result) => {
                self.seq = None;
                self.result_rx = None;
                result.map(Some)
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.seq = None;
                self.result_rx = None;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
            }
        }
    }

    async fn wait_with_timeout(
        mut self,
        timeout: Duration,
        poison_on_timeout: bool,
    ) -> io::Result<CommandOperationResult> {
        let seq = self.seq.ok_or_else(|| {
            io::Error::new(io::ErrorKind::ConnectionReset, "command operation closed")
        })?;
        let rx = self.result_rx.as_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::ConnectionReset, "command operation closed")
        })?;

        tokio::select! {
            biased;
            result = rx => {
                self.seq = None;
                self.result_rx = None;
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))?
            }
            _ = tokio::time::sleep(timeout) => {
                self.shared.remove_operation(seq);
                self.seq = None;
                self.result_rx = None;
                if poison_on_timeout {
                    self.shared.poison_connection();
                }
                Err(io::Error::new(io::ErrorKind::TimedOut, "command operation timeout"))
            }
        }
    }
}

impl Drop for CommandOperationHandle {
    fn drop(&mut self) {
        if let Some(seq) = self.seq.take() {
            self.shared.remove_operation(seq);
        }
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
    /// dropping the three registration tables outside the state lock so that
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
                    operations,
                    exits,
                } => {
                    *guard = ConnectionState::Closed { exits };
                    Some((pending, pending_stdout, stdout_senders, operations))
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

    fn poison_connection(&self) {
        self.close();
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
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

    fn remove_operation(&self, seq: u32) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard {
            operations.remove(&seq);
        }
    }
}

fn command_protocol_error(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn command_output_policy_streams(policy: CommandOutputPolicy) -> bool {
    matches!(
        policy,
        CommandOutputPolicy::Stream { .. } | CommandOutputPolicy::CaptureAndStream { .. }
    )
}

fn command_capture_state(policy: CommandOutputPolicy) -> CommandCaptureState {
    match policy {
        CommandOutputPolicy::Discard | CommandOutputPolicy::Stream { .. } => {
            CommandCaptureState::Discard
        }
        CommandOutputPolicy::Capture { limit_bytes }
        | CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: limit_bytes,
            ..
        } => CommandCaptureState::Capture {
            limit_bytes: limit_bytes as usize,
        },
    }
}

fn command_stream_state(policy: CommandOutputPolicy) -> Option<CommandStreamState> {
    match policy {
        CommandOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        }
        | CommandOutputPolicy::CaptureAndStream {
            stream_limit_bytes: limit_bytes,
            chunk_limit_bytes,
            ..
        } => Some(CommandStreamState {
            limit_bytes: limit_bytes as usize,
            chunk_limit_bytes: chunk_limit_bytes as usize,
            emitted_bytes: 0,
            truncated: false,
        }),
        CommandOutputPolicy::Discard | CommandOutputPolicy::Capture { .. } => None,
    }
}

fn validate_command_output(
    operation: &mut CommandOperation,
    output: &vsock_proto::DecodedCommandOutput<'_>,
) -> io::Result<()> {
    if output.output_seq != operation.expected_output_seq {
        return Err(command_protocol_error(format!(
            "command output seq mismatch: {} != {}",
            output.output_seq, operation.expected_output_seq
        )));
    }
    let stream = match output.stream {
        CommandOutputStream::Stdout => &mut operation.stdout_stream,
        CommandOutputStream::Stderr => &mut operation.stderr_stream,
    };
    let Some(stream) = stream else {
        return Err(command_protocol_error(
            "command output received for non-streaming output policy",
        ));
    };
    if stream.truncated {
        return Err(command_protocol_error(
            "command output received after stream truncation",
        ));
    }
    if output.chunk.is_empty() && !output.truncated {
        return Err(command_protocol_error(
            "command output empty chunk must mark stream truncation",
        ));
    }
    if output.chunk.len() > stream.chunk_limit_bytes {
        return Err(command_protocol_error(
            "command output chunk exceeds requested chunk limit",
        ));
    }
    let emitted_bytes = stream
        .emitted_bytes
        .checked_add(output.chunk.len())
        .ok_or_else(|| command_protocol_error("command output stream byte count overflow"))?;
    if emitted_bytes > stream.limit_bytes {
        return Err(command_protocol_error(
            "command output exceeds requested stream limit",
        ));
    }
    stream.emitted_bytes = emitted_bytes;
    if output.truncated {
        stream.truncated = true;
    }
    operation.expected_output_seq = operation.expected_output_seq.wrapping_add(1);
    Ok(())
}

fn validate_command_result_output(
    name: &str,
    state: &CommandCaptureState,
    output: CommandCapturedOutput<'_>,
) -> io::Result<()> {
    match (state, output) {
        (CommandCaptureState::Discard, CommandCapturedOutput::Discarded) => Ok(()),
        (CommandCaptureState::Discard, CommandCapturedOutput::Captured { .. }) => {
            Err(command_protocol_error(format!(
                "command result {name} captured output for non-capturing policy",
            )))
        }
        (
            CommandCaptureState::Capture { limit_bytes },
            CommandCapturedOutput::Captured { bytes, .. },
        ) if bytes.len() <= *limit_bytes => Ok(()),
        (
            CommandCaptureState::Capture { limit_bytes },
            CommandCapturedOutput::Captured { bytes, .. },
        ) => Err(command_protocol_error(format!(
            "command result {name} exceeds requested capture limit: {} > {limit_bytes}",
            bytes.len()
        ))),
        (CommandCaptureState::Capture { .. }, CommandCapturedOutput::Discarded) => {
            Err(command_protocol_error(format!(
                "command result {name} discarded output for capturing policy",
            )))
        }
    }
}

fn validate_command_result(
    operation: &CommandOperation,
    result: &vsock_proto::DecodedCommandResult<'_>,
) -> io::Result<()> {
    validate_command_result_output("stdout", &operation.stdout_capture, result.stdout)?;
    validate_command_result_output("stderr", &operation.stderr_capture, result.stderr)
}

fn owned_captured_output(output: CommandCapturedOutput<'_>) -> CommandOwnedCapturedOutput {
    match output {
        CommandCapturedOutput::Discarded => CommandOwnedCapturedOutput::Discarded,
        CommandCapturedOutput::Captured { bytes, truncated } => {
            CommandOwnedCapturedOutput::Captured {
                bytes: bytes.to_vec(),
                truncated,
            }
        }
    }
}

fn owned_command_output_event(output: vsock_proto::DecodedCommandOutput<'_>) -> CommandOutputEvent {
    CommandOutputEvent {
        stream: output.stream,
        output_seq: output.output_seq,
        chunk: output.chunk.to_vec(),
        truncated: output.truncated,
    }
}

fn owned_command_result(
    result: vsock_proto::DecodedCommandResult<'_>,
    stream_overflowed: bool,
) -> CommandOperationResult {
    CommandOperationResult {
        termination: result.termination,
        duration_ms: result.duration_ms,
        stdout: owned_captured_output(result.stdout),
        stderr: owned_captured_output(result.stderr),
        diagnostic: result.diagnostic.to_string(),
        stream_overflowed,
    }
}

fn dispatch_command_output(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard
        && let Some(Operation::Command(operation)) = operations.get_mut(&msg.seq)
    {
        let decoded =
            vsock_proto::decode_command_output(&msg.payload).map_err(command_protocol_error)?;
        validate_command_output(operation, &decoded)?;
        if let Some(tx) = operation.stream_tx.take() {
            match tx.try_reserve_owned() {
                Ok(permit) => {
                    operation.stream_tx = Some(permit.send(owned_command_output_event(decoded)));
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    operation.stream_overflowed = true;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {}
            }
        }
    }

    Ok(())
}

fn dispatch_command_result(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let (operation, decoded) = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains_key(&msg.seq) => {
                let decoded = vsock_proto::decode_command_result(&msg.payload)
                    .map_err(command_protocol_error)?;
                (operations.remove(&msg.seq), decoded)
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed { .. } => {
                return Ok(());
            }
        }
    };

    if let Some(Operation::Command(operation)) = operation {
        validate_command_result(&operation, &decoded)?;
        let CommandOperation {
            result_tx,
            stream_overflowed,
            ..
        } = operation;
        let result = owned_command_result(decoded, stream_overflowed);
        let _ = result_tx.send(Ok(result));
    }

    Ok(())
}

fn dispatch_command_error(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<bool> {
    let operation = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => operations.remove(&msg.seq),
            ConnectionState::Closed { .. } => None,
        }
    };

    if let Some(Operation::Command(operation)) = operation {
        let err = vsock_proto::decode_error(&msg.payload)
            .map(|message| io::Error::other(message.to_string()))
            .map_err(command_protocol_error)?;
        let _ = operation.result_tx.send(Err(err));
        return Ok(true);
    }

    Ok(false)
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
                match dispatch_command_error(&shared, &msg) {
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
                if dispatch_command_output(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_COMMAND_RESULT {
                if dispatch_command_result(&shared, &msg).is_err() {
                    shared.poison_connection();
                    return;
                }
            } else if msg.msg_type == MSG_STDOUT_CHUNK && msg.seq == 0 {
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
                            ..
                        } => {
                            if msg.msg_type == MSG_SPAWN_WATCH_RESULT
                                && let Ok(pid) =
                                    vsock_proto::decode_spawn_watch_result(&msg.payload)
                                && let Some(tx) = pending_stdout.remove(&msg.seq)
                            {
                                stdout_senders.insert(pid, tx);
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

async fn write_command_frame(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
) -> io::Result<()> {
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let state = Arc::new(AtomicU8::new(COMMAND_FRAME_WRITE_NOT_STARTED));
    let guard = CommandFrameWriteGuard::new(Arc::clone(shared), Arc::clone(&state));

    let mut writer = shared.writer.lock().await;
    state.store(COMMAND_FRAME_WRITE_STARTED, Ordering::Release);
    writer.write_all(&data).await?;
    state.store(COMMAND_FRAME_WRITE_COMPLETED, Ordering::Release);
    drop(guard);

    Ok(())
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
            fd,
            seq: AtomicU32::new(2),
            state: std::sync::Mutex::new(ConnectionState::Connected {
                pending: HashMap::new(),
                pending_stdout: HashMap::new(),
                stdout_senders: HashMap::new(),
                operations: HashMap::new(),
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

    /// Start a request-scoped command operation using the unified command protocol.
    pub async fn start_command_operation(
        &self,
        request: CommandOperationRequest<'_>,
    ) -> io::Result<CommandOperationHandle> {
        if request.timeout_ms == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command operation requires a positive timeout; use spawn_watch for unbounded commands",
            ));
        }
        if matches!(request.stream_queue_capacity, Some(0)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command stream queue capacity must be positive",
            ));
        }
        if let Some(capacity) = request.stream_queue_capacity
            && capacity > MAX_COMMAND_STREAM_CAPACITY
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "command stream queue capacity must be at most {MAX_COMMAND_STREAM_CAPACITY}"
                ),
            ));
        }
        let streams_output = command_output_policy_streams(request.stdout)
            || command_output_policy_streams(request.stderr);
        if !streams_output && request.stream_queue_capacity.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command stream queue capacity requires a streaming output policy",
            ));
        }
        let stream_queue_capacity = if streams_output {
            Some(
                request
                    .stream_queue_capacity
                    .unwrap_or(DEFAULT_COMMAND_STREAM_CAPACITY),
            )
        } else {
            None
        };

        let payload = vsock_proto::encode_command_start(
            request.timeout_ms,
            request.command,
            request.env,
            request.sudo,
            request.label,
            request.stdout,
            request.stderr,
        )
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

        let (stream_tx, stream_rx) = match stream_queue_capacity {
            Some(capacity) => {
                let (tx, rx) = mpsc::channel(capacity);
                (Some(tx), Some(rx))
            }
            None => (None, None),
        };
        let (result_tx, result_rx) = oneshot::channel();
        let seq = self.shared.next_seq();
        let operation = CommandOperation {
            result_tx,
            stream_tx,
            stdout_capture: command_capture_state(request.stdout),
            stderr_capture: command_capture_state(request.stderr),
            stdout_stream: command_stream_state(request.stdout),
            stderr_stream: command_stream_state(request.stderr),
            expected_output_seq: 0,
            stream_overflowed: false,
        };

        {
            let mut guard = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *guard {
                ConnectionState::Closed { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
                ConnectionState::Connected { operations, .. } => {
                    operations.insert(seq, Operation::Command(operation));
                }
            }
        }

        let mut registration_guard =
            CommandOperationRegistrationGuard::new(Arc::clone(&self.shared), seq);
        write_command_frame(&self.shared, MSG_COMMAND_START, seq, &payload).await?;
        registration_guard.disarm();

        Ok(CommandOperationHandle {
            shared: Arc::clone(&self.shared),
            seq: Some(seq),
            result_rx: Some(result_rx),
            stream_rx,
        })
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
            stdout_limit_bytes: DEFAULT_COMMAND_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: DEFAULT_COMMAND_CAPTURE_LIMIT_BYTES,
            wait_timeout,
        })
        .await
    }

    /// Run a capture-only command operation with explicit stdout/stderr limits.
    pub async fn command_capture(
        &self,
        request: CommandCaptureRequest<'_>,
    ) -> io::Result<CommandOperationResult> {
        let handle = self
            .start_command_operation(CommandOperationRequest {
                timeout_ms: request.timeout_ms,
                command: request.command,
                env: request.env,
                sudo: request.sudo,
                label: request.label,
                stdout: CommandOutputPolicy::Capture {
                    limit_bytes: request.stdout_limit_bytes,
                },
                stderr: CommandOutputPolicy::Capture {
                    limit_bytes: request.stderr_limit_bytes,
                },
                stream_queue_capacity: None,
            })
            .await?;
        handle.wait(request.wait_timeout).await
    }

    /// Start a streaming command operation with a bounded output event receiver.
    pub async fn command_stream(
        &self,
        request: CommandStreamRequest<'_>,
    ) -> io::Result<CommandOperationHandle> {
        if !command_output_policy_streams(request.stdout)
            && !command_output_policy_streams(request.stderr)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command_stream requires a streaming output policy",
            ));
        }

        self.start_command_operation(CommandOperationRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            stream_queue_capacity: request.stream_queue_capacity,
        })
        .await
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

    fn registration_counts(host: &VsockHost) -> (usize, usize, usize) {
        let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            ConnectionState::Connected {
                pending,
                pending_stdout,
                stdout_senders,
                ..
            } => (pending.len(), pending_stdout.len(), stdout_senders.len()),
            ConnectionState::Closed { .. } => (0, 0, 0),
        }
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

    async fn assert_connection_accepts_legacy_exec(
        host: &Arc<VsockHost>,
        guest: &mut UnixStream,
        decoder: &mut Decoder,
    ) {
        let exec_task = {
            let host = Arc::clone(host);
            tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
        };
        let msg = read_guest_message(guest, decoder).await;
        assert_eq!(msg.msg_type, MSG_EXEC);
        let payload = vsock_proto::encode_exec_result(0, b"ok", b"");
        let response = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
        guest.write_all(&response).await.unwrap();
        let exec_result = exec_task.await.unwrap().unwrap();
        assert_eq!(exec_result.stdout, b"ok");
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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
                stream_queue_capacity: Some(MAX_COMMAND_STREAM_CAPACITY + 1),
            })
            .await
        {
            Ok(_) => panic!("oversized stream capacity should be rejected"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
    }

    #[tokio::test]
    async fn command_operations_dispatch_out_of_order_results_by_seq() {
        let (host, mut guest, mut decoder) = setup_host_and_guest().await;
        let first = start_capture_operation(&host, "cmd-a").await;
        let second = start_capture_operation(&host, "cmd-b").await;

        let mut messages = Vec::new();
        let mut buf = [0u8; 4096];
        while messages.len() < 2 {
            let n = guest.read(&mut buf).await.unwrap();
            assert_ne!(n, 0, "connection closed before command start messages");
            messages.extend(decoder.decode(&buf[..n]).unwrap());
        }
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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
        assert_eq!(exec_msg.msg_type, MSG_EXEC);
        let payload = vsock_proto::encode_exec_result(0, b"ok", b"");
        let response = vsock_proto::encode(MSG_EXEC_RESULT, exec_msg.seq, &payload).unwrap();
        guest.write_all(&response).await.unwrap();
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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
        assert_eq!(msg.msg_type, MSG_EXEC, "start frame should not be written");
        let payload = vsock_proto::encode_exec_result(0, b"ok", b"");
        let response = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
        guest.write_all(&response).await.unwrap();
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
        assert_eq!(msg.msg_type, MSG_EXEC, "drop must not send command cancel");
        let payload = vsock_proto::encode_exec_result(0, b"ok", b"");
        let response = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
        guest.write_all(&response).await.unwrap();
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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

        assert_connection_accepts_legacy_exec(&host, &mut guest, &mut decoder).await;
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
        let state = Arc::new(AtomicU8::new(COMMAND_FRAME_WRITE_STARTED));
        drop(CommandFrameWriteGuard::new(Arc::clone(&host.shared), state));
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
        assert_eq!(registration_counts(&host), (1, 1, 0));

        task.abort();
        let _ = task.await;
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0),
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
        let (close_tx, close_rx) = oneshot::channel();

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

            let _ = close_rx.await;
            drop(guest);
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 77);

        let host_for_wait = Arc::clone(&host);
        let wait_task = tokio::spawn(async move {
            host_for_wait
                .wait_for_exit(77, Duration::from_secs(5))
                .await
        });
        close_tx.send(()).unwrap();

        let err = wait_task.await.unwrap().unwrap_err();
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
        let (send_exit, exit_after_exec) = oneshot::channel();

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

            let _ = exit_after_exec.await;
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

        send_exit.send(()).unwrap();

        // wait_for_exit should also resolve
        let exit_event = wait_task.await.unwrap().unwrap();
        assert_eq!(exit_event.pid, 50);
        assert_eq!(exit_event.exit_code, 42);
        assert_eq!(exit_event.stdout, b"exited");
    }
}
