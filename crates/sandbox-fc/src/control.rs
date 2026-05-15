//! Control socket protocol for `runner exec`.
//!
//! Provides a Unix domain socket server that runs alongside each sandbox,
//! allowing external processes to execute commands inside the VM via IPC.
//!
//! ## Wire format
//!
//! Length-prefixed JSON frames: `[4-byte big-endian length][JSON payload]`.
//! One request per connection, one response per connection.
//!
//! The request payload is [`ExecRequest`]. The response payload is
//! [`ExecResponse`], serialized as an untagged JSON object: command-result
//! responses contain command result fields, and error responses contain an
//! `error` field.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sandbox::{RemoteExecResult, SandboxControl, SandboxControlError};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::guest_operations::{
    GuestOperationGate, GuestOperationStartError, guest_error_is_terminal,
};
use crate::paths::{RuntimePaths, SockPaths};

// -----------------------------------------------------------------------
// Protocol types
// -----------------------------------------------------------------------

/// Request from a `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecRequest {
    /// Command text to execute inside the guest.
    pub command: String,
    /// Command timeout in seconds.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// 30 seconds.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    /// Whether to request sudo execution inside the guest.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// `false`. The guest command runner decides how sudo is applied.
    #[serde(default)]
    pub sudo: bool,
}

fn default_timeout() -> u32 {
    30
}

/// Response to a `runner exec` client.
///
/// This enum is serialized without a tag. Clients should distinguish variants
/// by shape: a command result response contains command result fields, while an
/// error response contains only an `error` string.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExecResponse {
    /// Command execution produced a captured result.
    ///
    /// This variant does not imply a zero exit code; inspect `exit_code` for the
    /// command's status.
    Success {
        /// Process exit code returned by the guest command runner.
        exit_code: i32,
        /// Base64-encoded captured stdout bytes.
        ///
        /// This is not plain UTF-8 text. `FirecrackerControl::exec_remote`
        /// decodes it before returning `sandbox::RemoteExecResult`.
        stdout: String,
        /// Base64-encoded captured stderr bytes.
        ///
        /// This is not plain UTF-8 text. `FirecrackerControl::exec_remote`
        /// decodes it before returning `sandbox::RemoteExecResult`.
        stderr: String,
        /// Whether stdout was cut at the capture limit.
        ///
        /// Truncation is independent of the command exit code.
        stdout_truncated: bool,
        /// Whether stderr was cut at the capture limit.
        ///
        /// Truncation is independent of the command exit code.
        stderr_truncated: bool,
    },
    /// Request failed before a command result could be returned.
    Error {
        /// Human-readable error message for operators and clients.
        error: String,
    },
}

// -----------------------------------------------------------------------
// Framing
// -----------------------------------------------------------------------

/// Maximum frame size: 64 MiB (generous for large stdout/stderr).
const MAX_FRAME_SIZE: u32 = 64 * 1024 * 1024;
const RUNNER_EXEC_CAPTURE_LIMIT_BYTES: u32 = 7 * 1024 * 1024;
const CONTROL_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const CONTROL_HANDLER_SHUTDOWN_GRACE: Duration = Duration::from_millis(250);

/// Read a length-prefixed frame from the stream.
async fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
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
async fn write_frame(stream: &mut UnixStream, data: &[u8]) -> io::Result<()> {
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

// -----------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------

/// A control socket server whose listener has already been bound.
pub(crate) struct BoundControlServer {
    sock_path: Option<SocketPathGuard>,
    listener: Option<UnixListener>,
    guest_operations: GuestOperationGate,
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
            self.guest_operations.clone(),
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
    guest_operations: GuestOperationGate,
) -> io::Result<BoundControlServer> {
    let listener = bind_unix_listener(&sock_path)?;
    let sock_path = SocketPathGuard::new(sock_path);
    Ok(BoundControlServer {
        sock_path: Some(sock_path),
        listener: Some(listener),
        guest_operations,
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
    guest_operations: GuestOperationGate,
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

                    let guest_operations = guest_operations.clone();
                    let handler_shutdown = shutdown.clone();
                    handlers.spawn(async move {
                        if let Err(e) = handle_connection(stream, guest_operations, handler_shutdown).await {
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
    mut stream: UnixStream,
    guest_operations: GuestOperationGate,
    shutdown: CancellationToken,
) -> io::Result<()> {
    let frame = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        result = read_frame(&mut stream) => result?,
    };

    let response = match serde_json::from_slice::<ExecRequest>(&frame) {
        Ok(request) => tokio::select! {
            biased;
            () = shutdown.cancelled() => return Ok(()),
            response = execute(request, &guest_operations) => response,
        },
        Err(e) => ExecResponse::Error {
            error: format!("invalid request: {e}"),
        },
    };

    let response_json = serde_json::to_vec(&response)
        .map_err(|e| io::Error::other(format!("serialize response: {e}")))?;
    tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        result = write_frame(&mut stream, &response_json) => result?,
    }

    Ok(())
}

/// Execute an [`ExecRequest`] through the sandbox operation gate.
async fn execute(request: ExecRequest, guest_operations: &GuestOperationGate) -> ExecResponse {
    let mut operation = match guest_operations.begin_control_operation().await {
        Ok(operation) => operation,
        Err(error) => {
            return ExecResponse::Error {
                error: control_start_error(error),
            };
        }
    };
    if let Err(error) = operation.mark_writing() {
        return ExecResponse::Error {
            error: format!("operation gate transition failed: {error:?}"),
        };
    }

    let vsock = operation.guest();
    let timeout_ms = request.timeout_secs.saturating_mul(1000);
    let env: &[(&str, &str)] = &[];

    let result = vsock
        .exec_capture(vsock_host::ExecCaptureRequest {
            command: &request.command,
            timeout_ms,
            env,
            sudo: request.sudo,
            label: "runner-exec",
            stdout_limit_bytes: RUNNER_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: RUNNER_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            wait_timeout: Duration::from_millis(timeout_ms as u64 + 5000),
        })
        .await;

    match result {
        Ok(result) => {
            if let Err(error) = operation.complete() {
                return ExecResponse::Error {
                    error: format!("operation gate completion failed: {error:?}"),
                };
            }
            ExecResponse::Success {
                exit_code: result.exit_code,
                stdout: BASE64.encode(&result.stdout),
                stderr: BASE64.encode(&result.stderr),
                stdout_truncated: result.stdout_truncated,
                stderr_truncated: result.stderr_truncated,
            }
        }
        Err(e) => {
            let message = format!("exec failed: {e}");
            if guest_error_is_terminal(&e, false)
                && let Err(error) = operation.complete()
            {
                return ExecResponse::Error {
                    error: format!("operation gate completion failed: {error:?}"),
                };
            }
            ExecResponse::Error { error: message }
        }
    }
}

fn control_start_error(error: GuestOperationStartError) -> String {
    match error {
        GuestOperationStartError::BackendCrashed => "sandbox backend crashed".into(),
        GuestOperationStartError::NotRunning { state } => {
            format!("sandbox not running (state={state})")
        }
        GuestOperationStartError::NoGuest => "sandbox not running".into(),
        GuestOperationStartError::GateClosed { state } => {
            format!("sandbox operation gate closed: {state:?}")
        }
    }
}

// -----------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------

/// Send an exec request to a control socket and return the wire response.
///
/// Used by `runner exec` to communicate with a running sandbox.
///
/// The returned [`ExecResponse::Success`] still contains base64-encoded stdout
/// and stderr. Use `FirecrackerControl::exec_remote` when the caller wants
/// decoded byte buffers.
pub async fn send_exec(
    sock_path: &Path,
    request: &ExecRequest,
    timeout: Duration,
) -> io::Result<ExecResponse> {
    let deadline = tokio::time::Instant::now() + timeout;

    let mut stream = tokio::time::timeout_at(deadline, UnixStream::connect(sock_path))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect timed out"))??;

    let request_json = serde_json::to_vec(request)
        .map_err(|e| io::Error::other(format!("serialize request: {e}")))?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json).await?;
        let frame = read_frame(&mut stream).await?;
        let response: ExecResponse = serde_json::from_slice(&frame).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("invalid response: {e}"))
        })?;
        Ok(response)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request timed out"))?
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
    ) -> Result<RemoteExecResult, SandboxControlError> {
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
        let response = send_exec(&sock_path, &request, connect_timeout)
            .await
            .map_err(|e| {
                SandboxControlError::Connection(format!("failed to connect to sandbox: {e}"))
            })?;

        match response {
            ExecResponse::Success {
                exit_code,
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
            } => {
                let stdout_bytes = BASE64
                    .decode(&stdout)
                    .map_err(|e| SandboxControlError::Connection(format!("decode stdout: {e}")))?;
                let stderr_bytes = BASE64
                    .decode(&stderr)
                    .map_err(|e| SandboxControlError::Connection(format!("decode stderr: {e}")))?;
                Ok(RemoteExecResult {
                    exit_code,
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                    stdout_truncated,
                    stderr_truncated,
                })
            }
            ExecResponse::Error { error } => Err(SandboxControlError::Remote(error)),
        }
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
    use crate::park_coordinator::{CoordinatorState, ParkCoordinator};
    use tokio::sync::oneshot;
    use vsock_host::VsockHost;
    use vsock_proto::{
        Decoder, MSG_ERROR, MSG_EXEC_START, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
    };

    fn test_gate(guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>) -> GuestOperationGate {
        GuestOperationGate::new(guest, ParkCoordinator::new())
    }

    fn test_gate_with_coordinator(
        guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    ) -> (GuestOperationGate, ParkCoordinator) {
        let coordinator = ParkCoordinator::new();
        (
            GuestOperationGate::new(guest, coordinator.clone()),
            coordinator,
        )
    }

    #[tokio::test]
    async fn exec_remote_empty_id() {
        let control = FirecrackerControl;
        let result = control
            .exec_remote("", "echo hi", Duration::from_secs(5), false)
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

        // Verify success response round-trips.
        let response = ExecResponse::Success {
            exit_code: 0,
            stdout: BASE64.encode(b"hello\n"),
            stderr: BASE64.encode(b""),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Success {
                exit_code,
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
            } => {
                assert_eq!(exit_code, 0);
                assert_eq!(BASE64.decode(stdout).unwrap(), b"hello\n");
                assert_eq!(BASE64.decode(stderr).unwrap(), b"");
                assert!(!stdout_truncated);
                assert!(!stderr_truncated);
            }
            ExecResponse::Error { .. } => panic!("expected success"),
        }

        // Verify error response round-trips.
        let response = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Error { error } => {
                assert_eq!(error, "sandbox not running");
            }
            ExecResponse::Success { .. } => panic!("expected error"),
        }
    }

    #[tokio::test]
    async fn client_server_no_guest() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");

        // Server with no guest connected.
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut handle = bind_server(sock_path.clone(), test_gate(guest))
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "ps aux".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let response = send_exec(&sock_path, &request, Duration::from_secs(5))
            .await
            .unwrap();

        match response {
            ExecResponse::Error { error } => {
                assert!(error.contains("not running"), "unexpected error: {error}");
            }
            ExecResponse::Success { .. } => panic!("expected error when guest is None"),
        }

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn bound_control_server_close_removes_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));

        let server = bind_server(sock_path.clone(), test_gate(guest)).unwrap();
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
            let _server = bind_server(sock_path.clone(), test_gate(guest)).unwrap();
            assert!(sock_path.exists());
        }

        assert!(!sock_path.exists());
    }

    #[tokio::test]
    async fn control_server_shutdown_removes_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut handle = bind_server(sock_path.clone(), test_gate(guest))
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
        let mut handle = bind_server(sock_path.clone(), test_gate(guest))
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
        let mut handle = bind_server(sock_path.clone(), test_gate(guest))
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
        let mut handle = bind_server(sock_path.clone(), test_gate(guest))
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
    async fn control_server_shutdown_cancels_in_flight_vsock_exec() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_holds_exec(vsock_base, exec_seen_tx));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let (gate, coordinator) = test_gate_with_coordinator(guest);
        let mut handle = bind_server(sock_path.clone(), gate)
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
                send_exec(&sock_path, &request, Duration::from_secs(30)).await
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
        assert!(
            matches!(coordinator.state(), CoordinatorState::Dirty { .. }),
            "cancelled in-flight control exec should mark the operation gate dirty"
        );
        assert_eq!(
            coordinator.active_operation_count(),
            0,
            "cancelled in-flight control exec should not leave an active operation"
        );

        guest_task.abort();
        let _ = guest_task.await;
    }

    #[tokio::test]
    async fn control_exec_rejects_when_operation_gate_is_closing() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, mut exec_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_records_exec(vsock_base, exec_seen_tx));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let (gate, coordinator) = test_gate_with_coordinator(guest);
        let attempt = coordinator
            .begin_prepare_park()
            .expect("gate should enter closing state");
        let mut handle = bind_server(sock_path.clone(), gate)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "echo should-not-run".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let response = send_exec(&sock_path, &request, Duration::from_secs(5))
            .await
            .unwrap();

        match response {
            ExecResponse::Error { error } => {
                assert!(
                    error.contains("operation gate closed"),
                    "unexpected error: {error}"
                );
            }
            ExecResponse::Success { .. } => panic!("expected gate-closed error"),
        }
        assert!(
            exec_seen_rx.try_recv().is_err(),
            "control exec should not send a guest command while the gate is closing"
        );

        handle.shutdown().await;
        coordinator.abort_prepare_park(&attempt).unwrap();
        guest_task.abort();
        let _ = guest_task.await;
    }

    #[tokio::test]
    async fn control_exec_terminal_guest_error_completes_operation_gate() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest_errors_exec(vsock_base, "guest refused exec"));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let (gate, coordinator) = test_gate_with_coordinator(guest);
        let mut handle = bind_server(sock_path.clone(), gate)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "exit-before-start".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let response = send_exec(&sock_path, &request, Duration::from_secs(5))
            .await
            .unwrap();

        match response {
            ExecResponse::Error { error } => {
                assert!(
                    error.contains("guest refused exec"),
                    "unexpected error: {error}"
                );
            }
            ExecResponse::Success { .. } => panic!("expected guest error"),
        }
        assert_eq!(coordinator.active_operation_count(), 0);
        let attempt = coordinator
            .begin_prepare_park()
            .expect("terminal guest error should complete the operation");
        coordinator.abort_prepare_park(&attempt).unwrap();

        handle.shutdown().await;
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn control_exec_transport_error_marks_operation_gate_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
        let guest_task = tokio::spawn(mock_guest_records_exec(vsock_base, exec_seen_tx));
        let vsock = host_task.await.unwrap().unwrap();

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::new(vsock))));
        let (gate, coordinator) = test_gate_with_coordinator(guest);
        let mut handle = bind_server(sock_path.clone(), gate)
            .unwrap()
            .spawn(CancellationToken::new());

        let request = ExecRequest {
            command: "disconnect-after-start".into(),
            timeout_secs: 5,
            sudo: false,
        };
        let response = send_exec(&sock_path, &request, Duration::from_secs(5))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
            .await
            .unwrap()
            .unwrap();
        match response {
            ExecResponse::Error { error } => {
                assert!(error.contains("exec failed"), "unexpected error: {error}");
            }
            ExecResponse::Success { .. } => panic!("expected transport error"),
        }
        assert!(
            matches!(coordinator.state(), CoordinatorState::Dirty { .. }),
            "transport error after command write should dirty the operation gate"
        );
        assert_eq!(coordinator.active_operation_count(), 0);

        handle.shutdown().await;
        guest_task.await.unwrap();
    }

    #[tokio::test]
    async fn bind_server_reports_bind_failure() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let _existing = UnixListener::bind(&sock_path).unwrap();
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));

        let result = bind_server(sock_path.clone(), test_gate(guest));

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

    async fn mock_guest_holds_exec(vsock_base: PathBuf, exec_seen: oneshot::Sender<()>) {
        mock_guest_until_exec(vsock_base, exec_seen, true).await;
    }

    async fn mock_guest_records_exec(vsock_base: PathBuf, exec_seen: oneshot::Sender<()>) {
        mock_guest_until_exec(vsock_base, exec_seen, false).await;
    }

    async fn mock_guest_errors_exec(vsock_base: PathBuf, error: &'static str) {
        let listener_path = PathBuf::from(format!(
            "{}_{}",
            vsock_base.display(),
            vsock_proto::VSOCK_PORT
        ));
        wait_for_socket_exists(&listener_path).await;

        let mut stream = UnixStream::connect(&listener_path).await.unwrap();
        let mut decoder = Decoder::new();
        mock_vsock_handshake(&mut stream, &mut decoder).await;

        loop {
            let message = read_vsock_message(&mut stream, &mut decoder).await;
            if message.msg_type == MSG_EXEC_START {
                let payload = vsock_proto::encode_error(error);
                let frame = vsock_proto::encode(MSG_ERROR, message.seq, &payload).unwrap();
                stream.write_all(&frame).await.unwrap();
                return;
            }
        }
    }

    async fn mock_guest_until_exec(
        vsock_base: PathBuf,
        exec_seen: oneshot::Sender<()>,
        hold_after_exec: bool,
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
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                return;
            }
            let messages = decoder.decode(&buf[..n]).unwrap();
            for message in messages {
                if message.msg_type == MSG_EXEC_START {
                    if let Some(tx) = exec_seen.take() {
                        let _ = tx.send(());
                    }
                    if hold_after_exec {
                        std::future::pending::<()>().await;
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
    fn exec_response_success_serialization() {
        let resp = ExecResponse::Success {
            exit_code: 0,
            stdout: BASE64.encode(b"output\n"),
            stderr: BASE64.encode(b""),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let json = serde_json::to_value(&resp).unwrap();
        // Untagged enum: no "type" field, just the fields directly
        assert_eq!(json["exit_code"], 0);
        assert!(json.get("stdout").is_some());
        assert!(json.get("stderr").is_some());
        assert!(json.get("error").is_none());
    }

    #[test]
    fn exec_response_error_serialization() {
        let resp = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
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

        let result = send_exec(&sock_path, &request, Duration::from_millis(100)).await;
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
