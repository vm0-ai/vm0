use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use tokio::net::{UnixListener, UnixStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::CONTROL_SOCKET_OVERHEAD_MS;
use super::protocol::{ExecRequest, ExecResponse, read_frame, write_frame};
use crate::guest_operations::{GuestOperationStartError, GuestOperationStartGate};

const RUNNER_EXEC_CAPTURE_LIMIT_BYTES: u32 = 7 * 1024 * 1024;
const CONTROL_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const CONTROL_HANDLER_SHUTDOWN_GRACE: Duration = Duration::from_millis(250);

/// A control socket server whose listener has already been bound.
pub(crate) struct BoundControlServer {
    sock_path: Option<SocketPathGuard>,
    listener: Option<UnixListener>,
    guest_operations: GuestOperationStartGate,
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
    guest_operations: GuestOperationStartGate,
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
    guest_operations: GuestOperationStartGate,
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
    guest_operations: GuestOperationStartGate,
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

/// Execute an [`ExecRequest`] through the sandbox operation start gate.
async fn execute(request: ExecRequest, guest_operations: &GuestOperationStartGate) -> ExecResponse {
    let vsock = match guest_operations.begin_control_operation().await {
        Ok(vsock) => vsock,
        Err(error) => {
            return ExecResponse::Error {
                error: control_start_error(error),
            };
        }
    };

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
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(timeout_ms as u64 + CONTROL_SOCKET_OVERHEAD_MS),
        })
        .await;

    match result {
        Ok(result) => ExecResponse::Success {
            exit_code: result.exit_code,
            stdout: BASE64.encode(&result.stdout),
            stderr: BASE64.encode(&result.stderr),
            stdout_truncated: result.stdout_truncated,
            stderr_truncated: result.stderr_truncated,
        },
        Err(e) => ExecResponse::Error {
            error: format!("exec failed: {e}"),
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;
    use vsock_host::{NormalOperationFenceRejection, VsockHost};
    use vsock_proto::{
        Decoder, MSG_ERROR, MSG_EXEC_START, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
    };

    use crate::control::{ExecRequest, ExecResponse, send_exec};
    use crate::park_coordinator::{CoordinatorState, ParkCoordinator};

    fn test_gate(
        guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    ) -> GuestOperationStartGate {
        GuestOperationStartGate::new(guest, ParkCoordinator::new())
    }

    fn test_gate_with_coordinator(
        guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    ) -> (GuestOperationStartGate, ParkCoordinator) {
        let coordinator = ParkCoordinator::new();
        (
            GuestOperationStartGate::new(guest, coordinator.clone()),
            coordinator,
        )
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
        let vsock = Arc::new(host_task.await.unwrap().unwrap());

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::clone(&vsock))));
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
        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert!(
            matches!(
                vsock.try_fence_normal_operations(),
                Err(NormalOperationFenceRejection::NotParkable
                    | NormalOperationFenceRejection::Closed)
            ),
            "cancelled in-flight control exec should leave vsock-host not parkable"
        );

        guest_task.abort();
        let _ = guest_task.await;
    }

    #[tokio::test]
    async fn control_exec_rejects_when_policy_gate_is_closing() {
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
    async fn control_exec_terminal_guest_error_completes_vsock_operation() {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest_errors_exec(vsock_base, "guest refused exec"));
        let vsock = Arc::new(host_task.await.unwrap().unwrap());

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::clone(&vsock))));
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
        assert!(vsock.try_fence_normal_operations().is_ok());
        let attempt = coordinator
            .begin_prepare_park()
            .expect("terminal guest error should leave park policy open");
        coordinator.abort_prepare_park(&attempt).unwrap();

        handle.shutdown().await;
        guest_task.abort();
        let _ = guest_task.await;
    }

    #[tokio::test]
    async fn control_exec_transport_error_makes_vsock_not_parkable() {
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
        let vsock = Arc::new(host_task.await.unwrap().unwrap());

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::clone(&vsock))));
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
        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert!(
            matches!(
                vsock.try_fence_normal_operations(),
                Err(NormalOperationFenceRejection::NotParkable
                    | NormalOperationFenceRejection::Closed)
            ),
            "transport error after command write should leave vsock-host not parkable"
        );

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
                std::future::pending::<()>().await;
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
}
