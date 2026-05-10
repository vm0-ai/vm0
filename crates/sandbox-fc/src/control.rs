//! Control socket protocol for `runner exec`.
//!
//! Provides a Unix domain socket server that runs alongside each sandbox,
//! allowing external processes to execute commands inside the VM via IPC.
//!
//! ## Wire format
//!
//! Length-prefixed JSON frames: `[4-byte big-endian length][JSON payload]`.
//! One request per connection, followed by response frames until one terminal
//! `complete` or `error` frame.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sandbox::{
    RemoteExecOutputSink, RemoteExecStatus, RemoteExecTermination, SandboxControl,
    SandboxControlError,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use vsock_host::{
    BoundedExecCapturePolicy, BoundedExecOutput, BoundedExecOutputEvent, BoundedExecOutputRequest,
    BoundedExecRequest, BoundedExecStream, BoundedExecStreamPolicy, BoundedExecTermination,
    VsockHost,
};

use crate::paths::{RuntimePaths, SockPaths};

// -----------------------------------------------------------------------
// Protocol types
// -----------------------------------------------------------------------

/// Request from `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecRequest {
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    #[serde(default)]
    pub sudo: bool,
}

fn default_timeout() -> u32 {
    30
}

/// Terminal state encoded in a control socket complete frame.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecTermination {
    Exited,
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
}

/// Response frame from the `runner exec` control socket.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecResponseFrame {
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    Complete {
        termination: ExecTermination,
        exit_code: Option<i32>,
        stdout_truncated: bool,
        stderr_truncated: bool,
        diagnostic: Option<String>,
    },
    Error {
        error: String,
    },
}

// -----------------------------------------------------------------------
// Framing
// -----------------------------------------------------------------------

/// Maximum JSON control frame size.
///
/// User stdout/stderr is streamed in smaller frames; this cap protects the
/// request frame and individual base64-encoded output chunks.
const MAX_FRAME_SIZE: u32 = 64 * 1024 * 1024;
/// Per-stream `runner exec` output budget. Truncation is reported in the final
/// complete frame and surfaced by the CLI.
const EXEC_STREAM_LIMIT_BYTES: u32 = 64 * 1024 * 1024;
/// Bounded exec output chunk size used for control socket streaming.
const EXEC_STREAM_CHUNK_LIMIT_BYTES: u32 = 64 * 1024;
/// Bound writes to `runner exec` clients so a connected but non-draining client
/// cannot keep a control handler and bounded exec request alive indefinitely.
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound the initial request read so an idle or partial client cannot pin a
/// control handler forever.
const CONTROL_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROL_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const CONTROL_HANDLER_SHUTDOWN_GRACE: Duration = Duration::from_millis(250);

/// Read a length-prefixed frame from the stream.
async fn read_frame(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let len = stream.read_u32().await?;
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} bytes"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Write a length-prefixed frame to the stream.
async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), data: &[u8]) -> io::Result<()> {
    let len = u32::try_from(data.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload too large: {} bytes", data.len()),
        )
    })?;
    stream.write_u32(len).await?;
    stream.write_all(data).await?;
    stream.flush().await?;
    Ok(())
}

async fn read_frame_with_timeout(
    stream: &mut (impl AsyncRead + Unpin),
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(timeout, read_frame(stream))
        .await
        .unwrap_or_else(|_| {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "control socket request read timed out",
            ))
        })
}

// -----------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------

/// A control socket server whose listener has already been bound.
pub(crate) struct BoundControlServer {
    sock_path: Option<SocketPathGuard>,
    listener: Option<UnixListener>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
}

impl BoundControlServer {
    /// Spawn the accept loop for this pre-bound control socket.
    pub(crate) fn spawn(mut self, shutdown: CancellationToken) -> ControlServerHandle {
        let Some(listener) = self.listener.take() else {
            return ControlServerHandle::stopped(self.sock_path.take(), shutdown);
        };
        let Some(sock_path) = self.sock_path.take() else {
            drop(listener);
            return ControlServerHandle::stopped(None, shutdown);
        };

        let task = spawn_bound_server(
            listener,
            sock_path.clone(),
            Arc::clone(&self.guest),
            shutdown.clone(),
        );
        ControlServerHandle {
            sock_path: Some(sock_path),
            shutdown,
            task: Some(task),
        }
    }

    pub(crate) fn close(mut self) {
        self.close_inner();
    }

    fn close_inner(&mut self) {
        drop(self.listener.take());
        if let Some(sock_path) = self.sock_path.take() {
            sock_path.unlink_once();
        }
    }
}

impl Drop for BoundControlServer {
    fn drop(&mut self) {
        self.close_inner();
    }
}

/// Runtime handle for an active control socket server.
pub(crate) struct ControlServerHandle {
    sock_path: Option<SocketPathGuard>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl ControlServerHandle {
    fn stopped(sock_path: Option<SocketPathGuard>, shutdown: CancellationToken) -> Self {
        Self {
            sock_path,
            shutdown,
            task: None,
        }
    }

    pub(crate) async fn shutdown(&mut self) {
        self.shutdown.cancel();
        self.unlink_socket();

        let Some(mut task) = self.task.take() else {
            return;
        };

        let timeout = tokio::time::sleep(CONTROL_SERVER_SHUTDOWN_TIMEOUT);
        tokio::pin!(timeout);
        tokio::select! {
            result = &mut task => {
                log_server_join(result);
            }
            () = &mut timeout => {
                task.abort();
                log_server_join(task.await);
            }
        }
    }

    fn unlink_socket(&mut self) {
        if let Some(sock_path) = self.sock_path.take() {
            sock_path.unlink_once();
        }
    }

    pub(crate) fn abort(&mut self) {
        self.shutdown.cancel();
        self.unlink_socket();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for ControlServerHandle {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Clone)]
struct SocketPathGuard {
    inner: Arc<SocketPathGuardInner>,
}

/// Shared ownership of a Unix socket pathname unlink.
///
/// The listener task and lifecycle handle can both observe shutdown. Unlinking
/// exactly once avoids a later drop removing a socket that has been recreated at
/// the same path.
struct SocketPathGuardInner {
    path: PathBuf,
    unlinked: AtomicBool,
}

impl SocketPathGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            inner: Arc::new(SocketPathGuardInner {
                path,
                unlinked: AtomicBool::new(false),
            }),
        }
    }

    fn path(&self) -> &Path {
        &self.inner.path
    }

    fn unlink_once(&self) {
        if self.inner.unlinked.swap(true, Ordering::AcqRel) {
            return;
        }
        remove_socket_path(&self.inner.path);
    }
}

/// Bind the control socket before spawning the accept loop.
pub(crate) fn bind_server(
    sock_path: PathBuf,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
) -> io::Result<BoundControlServer> {
    let listener = bind_unix_listener(&sock_path)?;
    let sock_path = SocketPathGuard::new(sock_path);
    Ok(BoundControlServer {
        sock_path: Some(sock_path),
        listener: Some(listener),
        guest,
    })
}

fn bind_unix_listener(sock_path: &Path) -> io::Result<UnixListener> {
    let listener = std::os::unix::net::UnixListener::bind(sock_path)?;
    if let Err(e) = listener.set_nonblocking(true) {
        remove_socket_path(sock_path);
        return Err(e);
    }
    UnixListener::from_std(listener).inspect_err(|_| remove_socket_path(sock_path))
}

fn remove_socket_path(sock_path: &Path) {
    match std::fs::remove_file(sock_path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => warn!(path = %sock_path.display(), error = %e, "remove control socket"),
    }
}

fn spawn_bound_server(
    listener: UnixListener,
    sock_path: SocketPathGuard,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        info!(path = %sock_path.path().display(), "control socket listening");

        let mut handlers = JoinSet::new();

        loop {
            tokio::select! {
                biased;

                () = shutdown.cancelled() => {
                    break;
                }

                joined = handlers.join_next(), if !handlers.is_empty() => {
                    log_handler_join(joined);
                }

                accepted = listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(conn) => conn,
                        Err(e) => {
                            warn!(error = %e, "control socket accept error");
                            continue;
                        }
                    };

                    let guest = Arc::clone(&guest);
                    let handler_shutdown = shutdown.clone();
                    handlers.spawn(async move {
                        if let Err(e) = handle_connection(stream, guest, handler_shutdown).await {
                            warn!(error = %e, "control connection handler error");
                        }
                    });
                }
            }
        }

        drop(listener);
        sock_path.unlink_once();
        shutdown_handlers(&mut handlers).await;
    })
}

fn log_server_join(joined: Result<(), tokio::task::JoinError>) {
    if let Err(e) = joined
        && !e.is_cancelled()
    {
        warn!(error = %e, "control socket server task failed");
    }
}

fn log_handler_join(joined: Option<Result<(), tokio::task::JoinError>>) {
    if let Some(Err(e)) = joined
        && !e.is_cancelled()
    {
        warn!(error = %e, "control connection task failed");
    }
}

async fn shutdown_handlers(handlers: &mut JoinSet<()>) {
    let drain = async {
        while let Some(joined) = handlers.join_next().await {
            log_handler_join(Some(joined));
        }
    };

    if tokio::time::timeout(CONTROL_HANDLER_SHUTDOWN_GRACE, drain)
        .await
        .is_ok()
    {
        return;
    }

    handlers.abort_all();
    while let Some(joined) = handlers.join_next().await {
        log_handler_join(Some(joined));
    }
}

/// Handle a single control socket connection.
async fn handle_connection(
    stream: UnixStream,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    shutdown: CancellationToken,
) -> io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let frame = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        result = read_frame_with_timeout(&mut reader, CONTROL_REQUEST_READ_TIMEOUT) => result?,
    };

    let request = match serde_json::from_slice::<ExecRequest>(&frame) {
        Ok(request) => request,
        Err(e) => {
            return write_response_frame(
                &mut writer,
                &ExecResponseFrame::Error {
                    error: format!("invalid request: {e}"),
                },
                &shutdown,
            )
            .await;
        }
    };

    tokio::select! {
        biased;
        () = shutdown.cancelled() => Ok(()),
        () = wait_for_client_disconnect_or_extra_bytes(&mut reader) => Ok(()),
        result = execute(request, &mut writer, &guest, &shutdown) => result,
    }
}

async fn write_response_frame(
    stream: &mut (impl AsyncWrite + Unpin),
    frame: &ExecResponseFrame,
    shutdown: &CancellationToken,
) -> io::Result<()> {
    write_response_frame_with_timeout(stream, frame, shutdown, CONTROL_WRITE_TIMEOUT).await
}

async fn write_response_frame_with_timeout(
    stream: &mut (impl AsyncWrite + Unpin),
    frame: &ExecResponseFrame,
    shutdown: &CancellationToken,
    timeout: Duration,
) -> io::Result<()> {
    let response_json = serde_json::to_vec(frame)
        .map_err(|e| io::Error::other(format!("serialize response: {e}")))?;
    tokio::select! {
        biased;
        () = shutdown.cancelled() => Ok(()),
        result = tokio::time::timeout(timeout, write_frame(stream, &response_json)) => {
            result.unwrap_or_else(|_| {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control socket write timed out",
                ))
            })
        },
    }
}

/// The control protocol has one request per connection. EOF means the client
/// can no longer consume streamed output; extra bytes after the request are a
/// protocol violation and cancel the in-flight command as well.
async fn wait_for_client_disconnect_or_extra_bytes(reader: &mut (impl AsyncRead + Unpin)) {
    let mut buf = [0u8; 1];
    let _ = reader.read(&mut buf).await;
}

/// Execute an [`ExecRequest`] against the sandbox's VsockHost.
async fn execute(
    request: ExecRequest,
    stream: &mut (impl AsyncWrite + Unpin),
    guest: &Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    shutdown: &CancellationToken,
) -> io::Result<()> {
    let vsock = {
        let lock = guest.lock().await;
        match lock.as_ref() {
            Some(v) => Arc::clone(v),
            None => {
                return write_response_frame(
                    stream,
                    &ExecResponseFrame::Error {
                        error: "sandbox not running".into(),
                    },
                    shutdown,
                )
                .await;
            }
        }
    };

    let timeout_ms = request.timeout_secs.saturating_mul(1000);
    let env: &[(&str, &str)] = &[];
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let bounded_request = BoundedExecRequest {
        command: &request.command,
        timeout_ms,
        env,
        sudo: request.sudo,
        stdin: None,
        stdout: exec_stream_output_request(event_tx.clone()),
        stderr: exec_stream_output_request(event_tx),
    };
    let bounded_exec = vsock.bounded_exec(&bounded_request);
    tokio::pin!(bounded_exec);

    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut event_rx_closed = false;

    let result = loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => return Ok(()),
            maybe_event = event_rx.recv(), if !event_rx_closed => {
                match maybe_event {
                    Some(event) => {
                        write_bounded_exec_output_event(
                            stream,
                            event,
                            &mut stdout_truncated,
                            &mut stderr_truncated,
                            shutdown,
                        )
                        .await?;
                    }
                    None => event_rx_closed = true,
                }
            }
            result = &mut bounded_exec => break result,
        }
    };

    while let Ok(event) = event_rx.try_recv() {
        write_bounded_exec_output_event(
            stream,
            event,
            &mut stdout_truncated,
            &mut stderr_truncated,
            shutdown,
        )
        .await?;
    }

    match result {
        Ok(result) => {
            stdout_truncated |= bounded_output_truncated(&result.stdout);
            stderr_truncated |= bounded_output_truncated(&result.stderr);
            let status = remote_status_from_bounded_result(
                result.termination,
                stdout_truncated,
                stderr_truncated,
                result.diagnostic,
            );
            write_response_frame(stream, &complete_frame_from_status(status), shutdown).await
        }
        Err(e) => {
            write_response_frame(
                stream,
                &ExecResponseFrame::Error {
                    error: format!("exec failed: {e}"),
                },
                shutdown,
            )
            .await
        }
    }
}

fn exec_stream_output_request(
    event_tx: tokio::sync::mpsc::UnboundedSender<BoundedExecOutputEvent>,
) -> BoundedExecOutputRequest {
    BoundedExecOutputRequest {
        capture: BoundedExecCapturePolicy::Discard,
        stream: Some(BoundedExecStreamPolicy {
            event_tx,
            limit_bytes: EXEC_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: EXEC_STREAM_CHUNK_LIMIT_BYTES,
        }),
    }
}

async fn write_bounded_exec_output_event(
    stream: &mut (impl AsyncWrite + Unpin),
    event: BoundedExecOutputEvent,
    stdout_truncated: &mut bool,
    stderr_truncated: &mut bool,
    shutdown: &CancellationToken,
) -> io::Result<()> {
    match event.stream {
        BoundedExecStream::Stdout => {
            *stdout_truncated |= event.truncated;
            if !event.chunk.is_empty() {
                write_response_frame(
                    stream,
                    &ExecResponseFrame::Stdout {
                        data: BASE64.encode(&event.chunk),
                    },
                    shutdown,
                )
                .await?;
            }
        }
        BoundedExecStream::Stderr => {
            *stderr_truncated |= event.truncated;
            if !event.chunk.is_empty() {
                write_response_frame(
                    stream,
                    &ExecResponseFrame::Stderr {
                        data: BASE64.encode(&event.chunk),
                    },
                    shutdown,
                )
                .await?;
            }
        }
    }

    Ok(())
}

fn bounded_output_truncated(output: &BoundedExecOutput) -> bool {
    match output {
        BoundedExecOutput::Discarded => false,
        BoundedExecOutput::Captured { truncated, .. } => *truncated,
    }
}

fn remote_status_from_bounded_result(
    termination: BoundedExecTermination,
    stdout_truncated: bool,
    stderr_truncated: bool,
    diagnostic: Option<String>,
) -> RemoteExecStatus {
    RemoteExecStatus {
        termination: remote_termination_from_bounded(termination),
        stdout_truncated,
        stderr_truncated,
        diagnostic,
    }
}

fn remote_termination_from_bounded(termination: BoundedExecTermination) -> RemoteExecTermination {
    match termination {
        BoundedExecTermination::Exited { exit_code } => RemoteExecTermination::Exited { exit_code },
        BoundedExecTermination::TimedOut => RemoteExecTermination::TimedOut,
        BoundedExecTermination::Cancelled => RemoteExecTermination::Cancelled,
        BoundedExecTermination::StartFailed => RemoteExecTermination::StartFailed,
        BoundedExecTermination::WaitFailed => RemoteExecTermination::WaitFailed,
    }
}

fn complete_frame_from_status(status: RemoteExecStatus) -> ExecResponseFrame {
    let (termination, exit_code) = match status.termination {
        RemoteExecTermination::Exited { exit_code } => (ExecTermination::Exited, Some(exit_code)),
        RemoteExecTermination::TimedOut => (ExecTermination::TimedOut, None),
        RemoteExecTermination::Cancelled => (ExecTermination::Cancelled, None),
        RemoteExecTermination::StartFailed => (ExecTermination::StartFailed, None),
        RemoteExecTermination::WaitFailed => (ExecTermination::WaitFailed, None),
    };

    ExecResponseFrame::Complete {
        termination,
        exit_code,
        stdout_truncated: status.stdout_truncated,
        stderr_truncated: status.stderr_truncated,
        diagnostic: status.diagnostic,
    }
}

// -----------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------

/// Send an exec request to a control socket and stream output frames into
/// `output` until a terminal status or error frame is received.
///
/// Used by `runner exec` to communicate with a running sandbox.
pub async fn send_exec(
    sock_path: &Path,
    request: &ExecRequest,
    timeout: Duration,
    output: &mut dyn RemoteExecOutputSink,
) -> Result<RemoteExecStatus, SandboxControlError> {
    let deadline = tokio::time::Instant::now() + timeout;

    let mut stream = tokio::time::timeout_at(deadline, UnixStream::connect(sock_path))
        .await
        .map_err(|_| SandboxControlError::Connection("connect timed out".into()))?
        .map_err(|e| SandboxControlError::Connection(format!("connect failed: {e}")))?;

    let request_json = serde_json::to_vec(request)
        .map_err(|e| SandboxControlError::Connection(format!("serialize request: {e}")))?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json)
            .await
            .map_err(|e| SandboxControlError::Connection(format!("write request: {e}")))?;

        loop {
            let frame = read_frame(&mut stream)
                .await
                .map_err(|e| SandboxControlError::Connection(format!("read response: {e}")))?;
            let response: ExecResponseFrame = serde_json::from_slice(&frame)
                .map_err(|e| SandboxControlError::Connection(format!("invalid response: {e}")))?;

            match response {
                ExecResponseFrame::Stdout { data } => {
                    let bytes = BASE64.decode(&data).map_err(|e| {
                        SandboxControlError::Connection(format!("decode stdout: {e}"))
                    })?;
                    output.stdout(&bytes)?;
                }
                ExecResponseFrame::Stderr { data } => {
                    let bytes = BASE64.decode(&data).map_err(|e| {
                        SandboxControlError::Connection(format!("decode stderr: {e}"))
                    })?;
                    output.stderr(&bytes)?;
                }
                ExecResponseFrame::Complete {
                    termination,
                    exit_code,
                    stdout_truncated,
                    stderr_truncated,
                    diagnostic,
                } => {
                    return status_from_complete_frame(
                        termination,
                        exit_code,
                        stdout_truncated,
                        stderr_truncated,
                        diagnostic,
                    );
                }
                ExecResponseFrame::Error { error } => {
                    return Err(SandboxControlError::Remote(error));
                }
            }
        }
    })
    .await
    .map_err(|_| SandboxControlError::Connection("request timed out".into()))?
}

fn status_from_complete_frame(
    termination: ExecTermination,
    exit_code: Option<i32>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    diagnostic: Option<String>,
) -> Result<RemoteExecStatus, SandboxControlError> {
    let termination = match termination {
        ExecTermination::Exited => {
            let Some(exit_code) = exit_code else {
                return Err(SandboxControlError::Connection(
                    "complete frame missing exit_code for exited termination".into(),
                ));
            };
            RemoteExecTermination::Exited { exit_code }
        }
        ExecTermination::TimedOut => RemoteExecTermination::TimedOut,
        ExecTermination::Cancelled => RemoteExecTermination::Cancelled,
        ExecTermination::StartFailed => RemoteExecTermination::StartFailed,
        ExecTermination::WaitFailed => RemoteExecTermination::WaitFailed,
    };

    Ok(RemoteExecStatus {
        termination,
        stdout_truncated,
        stderr_truncated,
        diagnostic,
    })
}

// -----------------------------------------------------------------------
// SandboxControl trait implementation
// -----------------------------------------------------------------------

/// Firecracker-backed sandbox control.
///
/// Stateless — can be created with zero cost and used immediately.
pub struct FirecrackerControl;

#[async_trait]
impl SandboxControl for FirecrackerControl {
    async fn exec_remote(
        &self,
        sandbox_id: &str,
        command: &str,
        timeout: Duration,
        sudo: bool,
        output: &mut dyn RemoteExecOutputSink,
    ) -> Result<RemoteExecStatus, SandboxControlError> {
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;

        let timeout_secs = u32::try_from(timeout.as_secs()).unwrap_or(u32::MAX);
        let request = ExecRequest {
            command: command.to_owned(),
            timeout_secs,
            sudo,
        };

        // Add 5 seconds buffer for connection overhead beyond the command timeout.
        let connect_timeout = timeout + Duration::from_secs(5);
        send_exec(&sock_path, &request, connect_timeout, output).await
    }

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        RuntimePaths::new().sock_dir(sandbox_id)
    }
}

/// Find the control socket for a given sandbox ID (full UUID or prefix).
///
/// Scans the runtime socket directory for directories matching the prefix
/// that contain a `control.sock` file.
fn resolve_control_socket(input: &str) -> Result<PathBuf, SandboxControlError> {
    let runtime = RuntimePaths::new();
    let sock_parent = runtime.sock_base();
    resolve_control_socket_in(&sock_parent, input)
}

fn resolve_control_socket_in(
    sock_parent: &Path,
    input: &str,
) -> Result<PathBuf, SandboxControlError> {
    let entries = std::fs::read_dir(sock_parent).map_err(|e| {
        SandboxControlError::Connection(format!(
            "cannot read {}: {e} (is a sandbox running?)",
            sock_parent.display()
        ))
    })?;

    let mut matches: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(input) {
            continue;
        }
        let control_sock = SockPaths::new(entry.path()).control_sock();
        if control_sock.exists() {
            matches.push((name_str.to_owned(), control_sock));
        }
    }

    match matches.as_slice() {
        [] => Err(SandboxControlError::NotFound(format!(
            "no running sandbox matches '{input}' (no control.sock found)"
        ))),
        [single] => Ok(single.1.clone()),
        _ => {
            let ids: Vec<&str> = matches.iter().map(|(id, _)| id.as_str()).collect();
            Err(SandboxControlError::Ambiguous(format!(
                "prefix '{input}' matches: {}",
                ids.join(", ")
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;
    use vsock_proto::{
        Decoder, MSG_BOUNDED_EXEC, MSG_BOUNDED_EXEC_CANCEL, MSG_BOUNDED_EXEC_OUTPUT_CHUNK,
        MSG_BOUNDED_EXEC_RESULT, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
    };

    #[derive(Default)]
    struct CollectRemoteExecOutput {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    }

    impl RemoteExecOutputSink for CollectRemoteExecOutput {
        fn stdout(&mut self, chunk: &[u8]) -> std::io::Result<()> {
            self.stdout.extend_from_slice(chunk);
            Ok(())
        }

        fn stderr(&mut self, chunk: &[u8]) -> std::io::Result<()> {
            self.stderr.extend_from_slice(chunk);
            Ok(())
        }
    }

    struct BrokenPipeStdout;

    impl RemoteExecOutputSink for BrokenPipeStdout {
        fn stdout(&mut self, _chunk: &[u8]) -> std::io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdout closed"))
        }

        fn stderr(&mut self, _chunk: &[u8]) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BrokenPipeStderr;

    impl RemoteExecOutputSink for BrokenPipeStderr {
        fn stdout(&mut self, _chunk: &[u8]) -> std::io::Result<()> {
            Ok(())
        }

        fn stderr(&mut self, _chunk: &[u8]) -> std::io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "stderr closed"))
        }
    }

    #[tokio::test]
    async fn exec_remote_empty_id() {
        let control = FirecrackerControl;
        let mut output = CollectRemoteExecOutput::default();
        let result = control
            .exec_remote("", "echo hi", Duration::from_secs(5), false, &mut output)
            .await;
        let Err(e) = result else {
            panic!("expected error");
        };
        assert!(e.to_string().contains("must not be empty"));
    }

    #[test]
    fn runtime_dir_returns_sock_dir() {
        let control = FirecrackerControl;
        let dir = control.runtime_dir("test-id");
        assert!(dir.ends_with("test-id"));
    }

    #[tokio::test]
    async fn frame_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");

        let listener = UnixListener::bind(&sock_path).unwrap();

        let payload = b"hello world";
        let sock = sock_path.clone();
        let client = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            write_frame(&mut stream, payload).await.unwrap();
            read_frame(&mut stream).await.unwrap()
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        let received = read_frame(&mut stream).await.unwrap();
        assert_eq!(received, payload);

        write_frame(&mut stream, b"reply").await.unwrap();
        let reply = client.await.unwrap();
        assert_eq!(reply, b"reply");
    }

    #[tokio::test]
    async fn write_response_frame_times_out_when_client_does_not_drain() {
        struct PendingWriter;

        impl AsyncWrite for PendingWriter {
            fn poll_write(
                self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                _buf: &[u8],
            ) -> std::task::Poll<io::Result<usize>> {
                std::task::Poll::Pending
            }

            fn poll_flush(
                self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<io::Result<()>> {
                std::task::Poll::Pending
            }

            fn poll_shutdown(
                self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<io::Result<()>> {
                std::task::Poll::Ready(Ok(()))
            }
        }

        let mut writer = PendingWriter;
        let shutdown = CancellationToken::new();
        let err = write_response_frame_with_timeout(
            &mut writer,
            &ExecResponseFrame::Error {
                error: "stalled".into(),
            },
            &shutdown,
            Duration::ZERO,
        )
        .await
        .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn request_frame_read_timeout_prevents_idle_handler_leak() {
        struct PendingReader;

        impl AsyncRead for PendingReader {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                _buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<io::Result<()>> {
                std::task::Poll::Pending
            }
        }

        let mut reader = PendingReader;
        let err = read_frame_with_timeout(&mut reader, Duration::ZERO)
            .await
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn protocol_round_trip() {
        let request = ExecRequest {
            command: "echo hello".into(),
            timeout_secs: 10,
            sudo: false,
        };
        let request_json = serde_json::to_vec(&request).unwrap();

        // Verify request deserializes correctly.
        let decoded: ExecRequest = serde_json::from_slice(&request_json).unwrap();
        assert_eq!(decoded.command, "echo hello");
        assert_eq!(decoded.timeout_secs, 10);
        assert!(!decoded.sudo);

        // Verify stdout response frame round-trips.
        let response = ExecResponseFrame::Stdout {
            data: BASE64.encode(b"hello\n"),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponseFrame = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponseFrame::Stdout { data } => {
                assert_eq!(BASE64.decode(data).unwrap(), b"hello\n");
            }
            _ => panic!("expected stdout frame"),
        }

        // Verify stderr response frame round-trips.
        let response = ExecResponseFrame::Stderr {
            data: BASE64.encode(b"warn\n"),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponseFrame = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponseFrame::Stderr { data } => {
                assert_eq!(BASE64.decode(data).unwrap(), b"warn\n");
            }
            _ => panic!("expected stderr frame"),
        }

        // Verify complete response frame round-trips.
        let response = ExecResponseFrame::Complete {
            termination: ExecTermination::Exited,
            exit_code: Some(0),
            stdout_truncated: false,
            stderr_truncated: true,
            diagnostic: Some("done".into()),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponseFrame = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponseFrame::Complete {
                termination,
                exit_code,
                stdout_truncated,
                stderr_truncated,
                diagnostic,
            } => {
                assert_eq!(termination, ExecTermination::Exited);
                assert_eq!(exit_code, Some(0));
                assert!(!stdout_truncated);
                assert!(stderr_truncated);
                assert_eq!(diagnostic.as_deref(), Some("done"));
            }
            _ => panic!("expected complete frame"),
        }

        // Verify error response round-trips.
        let response = ExecResponseFrame::Error {
            error: "sandbox not running".into(),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponseFrame = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponseFrame::Error { error } => {
                assert_eq!(error, "sandbox not running");
            }
            _ => panic!("expected error"),
        }
    }

    #[tokio::test]
    async fn client_server_no_guest() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");

        // Server with no guest connected.
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "ps aux".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let mut output = CollectRemoteExecOutput::default();
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();
        match err {
            SandboxControlError::Remote(error) => {
                assert!(error.contains("not running"), "unexpected error: {error}");
            }
            other => panic!("expected remote error when guest is None, got {other:?}"),
        }
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn send_exec_streams_output_until_complete_frame() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let frame = read_frame(&mut stream).await.unwrap();
            let request: ExecRequest = serde_json::from_slice(&frame).unwrap();
            assert_eq!(request.command, "echo hello");

            write_test_response_frame(
                &mut stream,
                &ExecResponseFrame::Stdout {
                    data: BASE64.encode(b"hello\n"),
                },
            )
            .await;
            write_test_response_frame(
                &mut stream,
                &ExecResponseFrame::Stderr {
                    data: BASE64.encode(b"warn\n"),
                },
            )
            .await;
            write_test_response_frame(
                &mut stream,
                &ExecResponseFrame::Complete {
                    termination: ExecTermination::Exited,
                    exit_code: Some(7),
                    stdout_truncated: true,
                    stderr_truncated: false,
                    diagnostic: None,
                },
            )
            .await;
        });

        let request = ExecRequest {
            command: "echo hello".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let status = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap();

        server.await.unwrap();
        assert_eq!(
            status,
            RemoteExecStatus {
                termination: RemoteExecTermination::Exited { exit_code: 7 },
                stdout_truncated: true,
                stderr_truncated: false,
                diagnostic: None,
            }
        );
        assert_eq!(output.stdout, b"hello\n");
        assert_eq!(output.stderr, b"warn\n");
    }

    #[tokio::test]
    async fn send_exec_reports_malformed_response_frame() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _request = read_frame(&mut stream).await.unwrap();
            write_frame(&mut stream, b"{").await.unwrap();
        });

        let request = ExecRequest {
            command: "true".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();

        server.await.unwrap();
        assert!(
            matches!(err, SandboxControlError::Connection(message) if message.contains("invalid response"))
        );
    }

    #[tokio::test]
    async fn send_exec_reports_invalid_output_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _request = read_frame(&mut stream).await.unwrap();
            write_test_response_frame(
                &mut stream,
                &ExecResponseFrame::Stdout {
                    data: "not base64".into(),
                },
            )
            .await;
        });

        let request = ExecRequest {
            command: "true".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();

        server.await.unwrap();
        assert!(
            matches!(err, SandboxControlError::Connection(message) if message.contains("decode stdout"))
        );
    }

    #[tokio::test]
    async fn send_exec_reports_exited_complete_without_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _request = read_frame(&mut stream).await.unwrap();
            write_test_response_frame(
                &mut stream,
                &ExecResponseFrame::Complete {
                    termination: ExecTermination::Exited,
                    exit_code: None,
                    stdout_truncated: false,
                    stderr_truncated: false,
                    diagnostic: None,
                },
            )
            .await;
        });

        let request = ExecRequest {
            command: "true".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();

        server.await.unwrap();
        assert!(
            matches!(err, SandboxControlError::Connection(message) if message.contains("missing exit_code"))
        );
    }

    #[tokio::test]
    async fn send_exec_reports_eof_before_terminal_frame() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _request = read_frame(&mut stream).await.unwrap();
            write_test_response_frame(
                &mut stream,
                &ExecResponseFrame::Stdout {
                    data: BASE64.encode(b"partial\n"),
                },
            )
            .await;
        });

        let request = ExecRequest {
            command: "true".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();

        server.await.unwrap();
        assert_eq!(output.stdout, b"partial\n");
        assert!(
            matches!(err, SandboxControlError::Connection(message) if message.contains("read response"))
        );
    }

    #[tokio::test]
    async fn bound_control_server_close_removes_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));

        let server = bind_server(sock_path.clone(), guest).unwrap();
        assert!(sock_path.exists());

        server.close();

        assert!(!sock_path.exists());
    }

    #[tokio::test]
    async fn bound_control_server_drop_removes_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));

        {
            let _server = bind_server(sock_path.clone(), guest).unwrap();
            assert!(sock_path.exists());
        }

        assert!(!sock_path.exists());
    }

    #[tokio::test]
    async fn control_server_shutdown_removes_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        assert!(sock_path.exists());

        handle.shutdown().await;
        handle.shutdown().await;

        assert!(!sock_path.exists());
        let err = UnixStream::connect(&sock_path).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn control_server_cancel_removes_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let shutdown = CancellationToken::new();
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(shutdown.clone());

        shutdown.cancel();
        wait_for_socket_removed(&sock_path).await;

        handle.shutdown().await;
        assert!(!sock_path.exists());
    }

    #[tokio::test]
    async fn control_server_cancel_cancels_pending_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let shutdown = CancellationToken::new();
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(shutdown.clone());
        let mut stream = UnixStream::connect(&sock_path).await.unwrap();
        stream.write_u32(1024).await.unwrap();

        shutdown.cancel();
        wait_for_socket_removed(&sock_path).await;

        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .unwrap();
        assert!(!sock_path.exists());
    }

    #[tokio::test]
    async fn control_server_shutdown_cancels_pending_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());
        let mut stream = UnixStream::connect(&sock_path).await.unwrap();
        stream.write_u32(1024).await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .unwrap();

        assert!(!sock_path.exists());
    }

    #[tokio::test]
    async fn control_server_streams_bounded_exec_output_and_status() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock-stream");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest_completes_bounded_exec(
            vsock_base,
            MockBoundedExecCompletion {
                stdout: b"hello\n".to_vec(),
                stderr: b"warn\n".to_vec(),
                exit_code: 7,
                stdout_truncated: true,
                stderr_truncated: false,
            },
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "echo hello".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let status = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap();

        assert_eq!(
            status,
            RemoteExecStatus {
                termination: RemoteExecTermination::Exited { exit_code: 7 },
                stdout_truncated: true,
                stderr_truncated: false,
                diagnostic: None,
            }
        );
        assert_eq!(output.stdout, b"hello\n");
        assert_eq!(output.stderr, b"warn\n");

        handle.shutdown().await;
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn control_server_handles_closed_stream_channel_before_bounded_exec_result() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock-stream-closed");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest_completes_bounded_exec(
            vsock_base,
            MockBoundedExecCompletion {
                stdout: b"hello\n".to_vec(),
                stderr: b"warn\n".to_vec(),
                exit_code: 0,
                stdout_truncated: true,
                stderr_truncated: true,
            },
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "echo hello".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let status = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap();

        assert_eq!(
            status,
            RemoteExecStatus {
                termination: RemoteExecTermination::Exited { exit_code: 0 },
                stdout_truncated: true,
                stderr_truncated: true,
                diagnostic: None,
            }
        );
        assert_eq!(output.stdout, b"hello\n");
        assert_eq!(output.stderr, b"warn\n");

        handle.shutdown().await;
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn control_server_forwards_non_exit_bounded_exec_status_and_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock-non-exit-status");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest_finishes_bounded_exec(
            vsock_base,
            vsock_proto::BoundedExecTermination::WaitFailed,
            Some("wait failed"),
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "broken-wait".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let status = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap();

        assert_eq!(
            status,
            RemoteExecStatus {
                termination: RemoteExecTermination::WaitFailed,
                stdout_truncated: false,
                stderr_truncated: false,
                diagnostic: Some("wait failed".into()),
            }
        );
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());

        handle.shutdown().await;
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn control_server_preserves_empty_truncation_markers() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock-empty-truncation");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest_completes_bounded_exec(
            vsock_base,
            MockBoundedExecCompletion {
                stdout: Vec::new(),
                stderr: Vec::new(),
                exit_code: 0,
                stdout_truncated: true,
                stderr_truncated: true,
            },
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "printf large-output".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let mut output = CollectRemoteExecOutput::default();
        let status = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap();

        assert_eq!(
            status,
            RemoteExecStatus {
                termination: RemoteExecTermination::Exited { exit_code: 0 },
                stdout_truncated: true,
                stderr_truncated: true,
                diagnostic: None,
            }
        );
        assert!(
            output.stdout.is_empty(),
            "empty truncation marker should not emit stdout bytes",
        );
        assert!(
            output.stderr.is_empty(),
            "empty truncation marker should not emit stderr bytes",
        );

        handle.shutdown().await;
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn control_server_shutdown_cancels_in_flight_vsock_bounded_exec() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_holds_exec(
            vsock_base,
            exec_seen_tx,
            cancel_seen_tx,
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());
        let client = tokio::spawn({
            let sock_path = sock_path.clone();
            async move {
                let request = ExecRequest {
                    command: "sleep 30".into(),
                    timeout_secs: 30,
                    sudo: false,
                };
                let mut output = CollectRemoteExecOutput::default();
                send_exec(&sock_path, &request, Duration::from_secs(30), &mut output).await
            }
        });

        tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .unwrap();

        let client_result = tokio::time::timeout(Duration::from_secs(1), client)
            .await
            .unwrap()
            .unwrap();
        assert!(client_result.is_err());

        tokio::time::timeout(Duration::from_secs(1), cancel_seen_rx)
            .await
            .unwrap()
            .unwrap();
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn control_client_disconnect_cancels_in_flight_vsock_bounded_exec() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_holds_exec(
            vsock_base,
            exec_seen_tx,
            cancel_seen_tx,
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        wait_for_socket_exists(&sock_path).await;
        let mut client = UnixStream::connect(&sock_path).await.unwrap();
        let request = ExecRequest {
            command: "sleep 30".into(),
            timeout_secs: 30,
            sudo: false,
        };
        let request_json = serde_json::to_vec(&request).unwrap();
        write_frame(&mut client, &request_json).await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
            .await
            .unwrap()
            .unwrap();
        drop(client);

        tokio::time::timeout(Duration::from_secs(1), cancel_seen_rx)
            .await
            .unwrap()
            .unwrap();
        guest_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn control_client_extra_bytes_cancel_in_flight_vsock_bounded_exec() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_holds_exec(
            vsock_base,
            exec_seen_tx,
            cancel_seen_tx,
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        wait_for_socket_exists(&sock_path).await;
        let mut client = UnixStream::connect(&sock_path).await.unwrap();
        let request = ExecRequest {
            command: "sleep 30".into(),
            timeout_secs: 30,
            sudo: false,
        };
        let request_json = serde_json::to_vec(&request).unwrap();
        write_frame(&mut client, &request_json).await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
            .await
            .unwrap()
            .unwrap();
        client.write_all(b"x").await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), cancel_seen_rx)
            .await
            .unwrap()
            .unwrap();
        guest_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn send_exec_stdout_sink_error_cancels_in_flight_vsock_bounded_exec() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_streams_then_holds_exec(
            vsock_base,
            exec_seen_tx,
            cancel_seen_tx,
            vsock_proto::BoundedExecStream::Stdout,
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "printf output".into(),
            timeout_secs: 30,
            sudo: false,
        };
        let mut output = BrokenPipeStdout;
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();
        assert!(matches!(err, SandboxControlError::Io(e) if e.kind() == io::ErrorKind::BrokenPipe));

        tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), cancel_seen_rx)
            .await
            .unwrap()
            .unwrap();
        guest_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn send_exec_stderr_sink_error_cancels_in_flight_vsock_bounded_exec() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock-stderr-sink-error");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_streams_then_holds_exec(
            vsock_base,
            exec_seen_tx,
            cancel_seen_tx,
            vsock_proto::BoundedExecStream::Stderr,
        ));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let mut handle = bind_server(sock_path.clone(), guest)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "printf error >&2".into(),
            timeout_secs: 30,
            sudo: false,
        };
        let mut output = BrokenPipeStderr;
        let err = send_exec(&sock_path, &request, Duration::from_secs(5), &mut output)
            .await
            .unwrap_err();
        assert!(matches!(err, SandboxControlError::Io(e) if e.kind() == io::ErrorKind::BrokenPipe));

        tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), cancel_seen_rx)
            .await
            .unwrap()
            .unwrap();
        guest_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn bind_server_reports_bind_failure() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let _existing = UnixListener::bind(&sock_path).unwrap();
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));

        let result = bind_server(sock_path.clone(), guest);

        let Err(err) = result else {
            panic!("binding an occupied control socket should fail");
        };
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
        assert!(sock_path.exists());
    }

    async fn wait_for_socket_removed(sock_path: &Path) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while sock_path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn wait_for_socket_exists(sock_path: &Path) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !sock_path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn write_test_response_frame(stream: &mut UnixStream, frame: &ExecResponseFrame) {
        let payload = serde_json::to_vec(frame).unwrap();
        write_frame(stream, &payload).await.unwrap();
    }

    async fn mock_vsock_handshake(stream: &mut UnixStream, decoder: &mut Decoder) {
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).unwrap();
        stream.write_all(&ready).await.unwrap();

        let message = read_vsock_message(stream, decoder).await;
        assert_eq!(message.msg_type, MSG_PING);

        let pong = vsock_proto::encode(MSG_PONG, message.seq, &[]).unwrap();
        stream.write_all(&pong).await.unwrap();
    }

    async fn read_vsock_message(stream: &mut UnixStream, decoder: &mut Decoder) -> RawMessage {
        let mut buf = [0u8; 1024];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0, "vsock stream closed before next message");

            let mut messages = decoder.decode(&buf[..n]).unwrap();
            if !messages.is_empty() {
                assert_eq!(
                    messages.len(),
                    1,
                    "mock guest expected one message at a time"
                );
                return messages.remove(0);
            }
        }
    }

    struct MockBoundedExecCompletion {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        exit_code: i32,
        stdout_truncated: bool,
        stderr_truncated: bool,
    }

    async fn mock_guest_completes_bounded_exec(
        vsock_base: PathBuf,
        completion: MockBoundedExecCompletion,
    ) {
        let listener_path = PathBuf::from(format!(
            "{}_{}",
            vsock_base.display(),
            vsock_proto::VSOCK_PORT
        ));
        wait_for_socket_exists(&listener_path).await;

        let mut stream = UnixStream::connect(&listener_path).await.unwrap();
        let mut decoder = Decoder::new();
        mock_vsock_handshake(&mut stream, &mut decoder).await;

        let message = read_vsock_message(&mut stream, &mut decoder).await;
        assert_eq!(message.msg_type, MSG_BOUNDED_EXEC);
        let request = vsock_proto::decode_bounded_exec(&message.payload).unwrap();
        assert!(request.stdout.stream.is_some());
        assert!(request.stderr.stream.is_some());

        write_bounded_exec_output_chunk(
            &mut stream,
            message.seq,
            vsock_proto::BoundedExecStream::Stdout,
            0,
            &completion.stdout,
            completion.stdout_truncated,
        )
        .await;
        write_bounded_exec_output_chunk(
            &mut stream,
            message.seq,
            vsock_proto::BoundedExecStream::Stderr,
            0,
            &completion.stderr,
            completion.stderr_truncated,
        )
        .await;
        write_bounded_exec_result(
            &mut stream,
            message.seq,
            vsock_proto::BoundedExecTermination::Exited {
                exit_code: completion.exit_code,
            },
            None,
        )
        .await;
    }

    async fn mock_guest_finishes_bounded_exec(
        vsock_base: PathBuf,
        termination: vsock_proto::BoundedExecTermination,
        diagnostic: Option<&'static str>,
    ) {
        let listener_path = PathBuf::from(format!(
            "{}_{}",
            vsock_base.display(),
            vsock_proto::VSOCK_PORT
        ));
        wait_for_socket_exists(&listener_path).await;

        let mut stream = UnixStream::connect(&listener_path).await.unwrap();
        let mut decoder = Decoder::new();
        mock_vsock_handshake(&mut stream, &mut decoder).await;

        let message = read_vsock_message(&mut stream, &mut decoder).await;
        assert_eq!(message.msg_type, MSG_BOUNDED_EXEC);
        let request = vsock_proto::decode_bounded_exec(&message.payload).unwrap();
        assert!(request.stdout.stream.is_some());
        assert!(request.stderr.stream.is_some());

        write_bounded_exec_result(&mut stream, message.seq, termination, diagnostic).await;
    }

    async fn mock_guest_streams_then_holds_exec(
        vsock_base: PathBuf,
        exec_seen: oneshot::Sender<()>,
        cancel_seen: oneshot::Sender<()>,
        stream_kind: vsock_proto::BoundedExecStream,
    ) {
        let listener_path = PathBuf::from(format!(
            "{}_{}",
            vsock_base.display(),
            vsock_proto::VSOCK_PORT
        ));
        wait_for_socket_exists(&listener_path).await;

        let mut stream = UnixStream::connect(&listener_path).await.unwrap();
        let mut decoder = Decoder::new();
        mock_vsock_handshake(&mut stream, &mut decoder).await;

        let message = read_vsock_message(&mut stream, &mut decoder).await;
        assert_eq!(message.msg_type, MSG_BOUNDED_EXEC);
        let _ = exec_seen.send(());
        write_bounded_exec_output_chunk(
            &mut stream,
            message.seq,
            stream_kind,
            0,
            b"partial\n",
            false,
        )
        .await;

        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                return;
            }
            let messages = decoder.decode(&buf[..n]).unwrap();
            for message in messages {
                if message.msg_type == MSG_BOUNDED_EXEC_CANCEL {
                    let _ = cancel_seen.send(());
                    return;
                }
            }
        }
    }

    async fn write_bounded_exec_output_chunk(
        stream: &mut UnixStream,
        seq: u32,
        bounded_stream: vsock_proto::BoundedExecStream,
        sequence: u32,
        chunk: &[u8],
        truncated: bool,
    ) {
        let payload = vsock_proto::encode_bounded_exec_output_chunk(
            bounded_stream,
            sequence,
            chunk,
            truncated,
        )
        .unwrap();
        let frame = vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, seq, &payload).unwrap();
        stream.write_all(&frame).await.unwrap();
    }

    async fn write_bounded_exec_result(
        stream: &mut UnixStream,
        seq: u32,
        termination: vsock_proto::BoundedExecTermination,
        diagnostic: Option<&str>,
    ) {
        let payload = vsock_proto::encode_bounded_exec_result(
            termination,
            1,
            vsock_proto::BoundedExecOutput::Discarded,
            vsock_proto::BoundedExecOutput::Discarded,
            diagnostic,
        )
        .unwrap();
        let frame = vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, seq, &payload).unwrap();
        stream.write_all(&frame).await.unwrap();
    }

    async fn mock_guest_holds_exec(
        vsock_base: PathBuf,
        exec_seen: oneshot::Sender<()>,
        cancel_seen: oneshot::Sender<()>,
    ) {
        let listener_path = PathBuf::from(format!(
            "{}_{}",
            vsock_base.display(),
            vsock_proto::VSOCK_PORT
        ));
        wait_for_socket_exists(&listener_path).await;

        let mut stream = UnixStream::connect(&listener_path).await.unwrap();
        let mut decoder = Decoder::new();
        mock_vsock_handshake(&mut stream, &mut decoder).await;

        let mut exec_seen = Some(exec_seen);
        let mut cancel_seen = Some(cancel_seen);
        let mut exec_seq = None;
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                return;
            }
            let messages = decoder.decode(&buf[..n]).unwrap();
            for message in messages {
                if message.msg_type == MSG_BOUNDED_EXEC {
                    exec_seq = Some(message.seq);
                    if let Some(tx) = exec_seen.take() {
                        let _ = tx.send(());
                    }
                } else if message.msg_type == MSG_BOUNDED_EXEC_CANCEL {
                    assert_eq!(Some(message.seq), exec_seq);
                    if let Some(tx) = cancel_seen.take() {
                        let _ = tx.send(());
                    }
                    return;
                }
            }
        }
    }

    #[test]
    fn exec_request_default_timeout() {
        // timeout_secs has a serde default of 30
        let json = r#"{"command":"echo hi"}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "echo hi");
        assert_eq!(req.timeout_secs, 30);
        assert!(!req.sudo);
    }

    #[test]
    fn exec_request_with_sudo() {
        let json = r#"{"command":"apt install curl","timeout_secs":60,"sudo":true}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "apt install curl");
        assert_eq!(req.timeout_secs, 60);
        assert!(req.sudo);
    }

    #[test]
    fn exec_response_complete_serialization() {
        let resp = ExecResponseFrame::Complete {
            termination: ExecTermination::Exited,
            exit_code: Some(0),
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["type"], "complete");
        assert_eq!(json["termination"], "exited");
        assert_eq!(json["exit_code"], 0);
        assert_eq!(json["stdout_truncated"], false);
        assert_eq!(json["stderr_truncated"], false);
        assert!(json.get("error").is_none());
    }

    #[test]
    fn exec_response_error_serialization() {
        let resp = ExecResponseFrame::Error {
            error: "sandbox not running".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(json["error"], "sandbox not running");
        assert!(json.get("exit_code").is_none());
    }

    #[tokio::test]
    async fn send_exec_connect_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("nonexistent.sock");

        let request = ExecRequest {
            command: "echo test".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let mut output = CollectRemoteExecOutput::default();
        let result = send_exec(
            &sock_path,
            &request,
            Duration::from_millis(100),
            &mut output,
        )
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn resolve_control_socket_missing_parent_returns_connection() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");

        let err = resolve_control_socket_in(&missing, "nonexistent-id-12345").unwrap_err();

        assert!(matches!(err, SandboxControlError::Connection(_)));
    }

    #[test]
    fn resolve_control_socket_empty_parent_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        std::fs::create_dir(&sock_parent).unwrap();

        let err = resolve_control_socket_in(&sock_parent, "nonexistent-id-12345").unwrap_err();

        assert!(matches!(err, SandboxControlError::NotFound(_)));
    }
}
