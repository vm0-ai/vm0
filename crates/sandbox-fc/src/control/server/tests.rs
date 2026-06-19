use super::*;

use std::future::Future;

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot::error::TryRecvError;
use tokio::sync::{mpsc, oneshot};
use vsock_host::{ExecOwnedCapturedOutput, NormalOperationFenceRejection, VsockHost};
use vsock_proto::{
    Decoder, ExecTermination, MSG_ERROR, MSG_EXEC_START, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
};

use crate::control::{
    ExecRequest, ExecResponse, TerminateAction, TerminateRequest, TerminateResponse,
    TerminateStatus, send_exec, send_terminate,
};
use crate::exec_result_compat::EXEC_TIMEOUT_EXIT_CODE;
use crate::park_coordinator::{
    CoordinatorState, DirtyReason, ParkCoordinator, PrepareParkEvidence,
};

type GuestState = Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>;

struct ControlServerFixture {
    _dir: tempfile::TempDir,
    sock_path: PathBuf,
}

impl ControlServerFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        Self {
            _dir: dir,
            sock_path,
        }
    }

    fn bind_default(&self) -> io::Result<BoundControlServer> {
        bind_test_server(self.sock_path.clone(), test_gate(empty_guest()))
    }

    fn bind_with_termination(
        &self,
        termination: ProcessTerminationHandle,
    ) -> io::Result<BoundControlServer> {
        bind_server(
            self.sock_path.clone(),
            test_gate(empty_guest()),
            termination,
        )
    }

    fn spawn_default(&self, shutdown: CancellationToken) -> ControlServerHandle {
        self.bind_default().unwrap().spawn(shutdown)
    }
}

struct VsockExecFixture {
    _dir: tempfile::TempDir,
    sock_path: PathBuf,
    vsock: Arc<VsockHost>,
    coordinator: ParkCoordinator,
    gate: GuestOperationStartGate,
    guest_task: tokio::task::JoinHandle<()>,
}

impl VsockExecFixture {
    async fn connect<F, Fut>(mock_guest: F) -> Self
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let dir = tempfile::tempdir().unwrap();
        let vsock_base = dir.path().join("vsock");
        let host_task = {
            let vsock_base = vsock_base.display().to_string();
            tokio::spawn(async move {
                VsockHost::wait_for_connection(&vsock_base, Duration::from_secs(5)).await
            })
        };
        let guest_task = tokio::spawn(mock_guest(vsock_base));
        let vsock = Arc::new(host_task.await.unwrap().unwrap());

        let sock_path = dir.path().join("control.sock");
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::clone(&vsock))));
        let coordinator = ParkCoordinator::new();
        let gate = GuestOperationStartGate::new(guest, coordinator.clone());

        Self {
            _dir: dir,
            sock_path,
            vsock,
            coordinator,
            gate,
            guest_task,
        }
    }

    fn spawn_server(&self) -> ControlServerHandle {
        bind_test_server(self.sock_path.clone(), self.gate.clone())
            .unwrap()
            .spawn(CancellationToken::new())
    }
}

fn empty_guest() -> GuestState {
    Arc::new(tokio::sync::Mutex::new(None))
}

fn exec_request(command: &str) -> ExecRequest {
    ExecRequest {
        command: command.into(),
        timeout_secs: 5,
        sudo: false,
    }
}

fn control_exec_result(
    termination: ExecTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    diagnostic: &str,
) -> vsock_host::ExecOperationResult {
    vsock_host::ExecOperationResult {
        termination,
        duration_ms: 10,
        stdout: ExecOwnedCapturedOutput::Captured {
            bytes: stdout,
            truncated: true,
        },
        stderr: ExecOwnedCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
        diagnostic: diagnostic.to_string(),
        stream_overflowed: false,
    }
}

fn expect_exec_success(response: ExecResponse) -> (i32, Vec<u8>, Vec<u8>, bool, bool) {
    match response {
        ExecResponse::Success {
            exit_code,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
        } => (
            exit_code,
            BASE64.decode(stdout).expect("stdout should decode"),
            BASE64.decode(stderr).expect("stderr should decode"),
            stdout_truncated,
            stderr_truncated,
        ),
        ExecResponse::Error { error } => panic!("expected success response, got error: {error}"),
    }
}

fn test_gate(guest: GuestState) -> GuestOperationStartGate {
    GuestOperationStartGate::new(guest, ParkCoordinator::new())
}

fn test_termination_handle() -> ProcessTerminationHandle {
    let (kill_tx, _kill_rx) = mpsc::channel(1);
    ProcessTerminationHandle::new(kill_tx)
}

fn parked_coordinator() -> ParkCoordinator {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator.begin_prepare_park().unwrap();
    coordinator
        .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced)
        .unwrap();
    coordinator.mark_parked(&attempt).unwrap();
    coordinator
}

fn ready_for_park_coordinator() -> ParkCoordinator {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator.begin_prepare_park().unwrap();
    coordinator
        .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced)
        .unwrap();
    coordinator
}

fn bind_test_server(
    sock_path: PathBuf,
    guest_operations: GuestOperationStartGate,
) -> io::Result<BoundControlServer> {
    bind_server(sock_path, guest_operations, test_termination_handle())
}

#[test]
fn control_exec_result_preserves_ordinary_exit_compatibility() {
    let response = exec_response_from_operation_result(control_exec_result(
        ExecTermination::Exited { exit_code: 7 },
        b"out".to_vec(),
        b"err".to_vec(),
        "ignored",
    ))
    .expect("ordinary exit should convert");

    let (exit_code, stdout, stderr, stdout_truncated, stderr_truncated) =
        expect_exec_success(response);
    assert_eq!(exit_code, 7);
    assert_eq!(stdout, b"out");
    assert_eq!(stderr, b"err");
    assert!(stdout_truncated);
    assert!(!stderr_truncated);
}

#[test]
fn control_exec_result_preserves_terminal_state_compatibility_mapping() {
    for (termination, diagnostic, expected_code, expected_stderr) in [
        (
            ExecTermination::TimedOut,
            "",
            EXEC_TIMEOUT_EXIT_CODE,
            "Timeout",
        ),
        (
            ExecTermination::Cancelled,
            "cancel diagnostic",
            1,
            "Cancelled\ncancel diagnostic",
        ),
        (
            ExecTermination::StartFailed,
            "spawn failed",
            1,
            "spawn failed",
        ),
        (
            ExecTermination::WaitFailed,
            "wait failed",
            1,
            "stderr clue\nwait failed",
        ),
    ] {
        let stderr = if matches!(termination, ExecTermination::WaitFailed) {
            b"stderr clue".to_vec()
        } else {
            Vec::new()
        };
        let response = exec_response_from_operation_result(control_exec_result(
            termination,
            Vec::new(),
            stderr,
            diagnostic,
        ))
        .expect("terminal state should convert to compatibility response");

        let (exit_code, _, stderr, _, _) = expect_exec_success(response);
        assert_eq!(exit_code, expected_code);
        assert_eq!(String::from_utf8(stderr).unwrap(), expected_stderr);
    }
}

#[test]
fn control_exec_result_rejects_invalid_capture_state() {
    let overflow = exec_response_from_operation_result(vsock_host::ExecOperationResult {
        stream_overflowed: true,
        ..control_exec_result(
            ExecTermination::Exited { exit_code: 0 },
            Vec::new(),
            Vec::new(),
            "",
        )
    })
    .expect_err("stream overflow should fail");
    assert_eq!(overflow.kind(), io::ErrorKind::InvalidData);
    assert!(overflow.to_string().contains("overflowed a stream queue"));

    let stdout_discarded = exec_response_from_operation_result(vsock_host::ExecOperationResult {
        stdout: ExecOwnedCapturedOutput::Discarded,
        ..control_exec_result(
            ExecTermination::Exited { exit_code: 0 },
            Vec::new(),
            Vec::new(),
            "",
        )
    })
    .expect_err("discarded stdout should fail");
    assert_eq!(stdout_discarded.kind(), io::ErrorKind::InvalidData);
    assert!(stdout_discarded.to_string().contains("discarded stdout"));

    let stderr_discarded = exec_response_from_operation_result(vsock_host::ExecOperationResult {
        stderr: ExecOwnedCapturedOutput::Discarded,
        ..control_exec_result(
            ExecTermination::Exited { exit_code: 0 },
            Vec::new(),
            Vec::new(),
            "",
        )
    })
    .expect_err("discarded stderr should fail");
    assert_eq!(stderr_discarded.kind(), io::ErrorKind::InvalidData);
    assert!(stderr_discarded.to_string().contains("discarded stderr"));
}

async fn recv_termination_request(
    kill_rx: &mut mpsc::Receiver<ProcessTerminationRequest>,
) -> ProcessTerminationRequest {
    kill_rx
        .recv()
        .await
        .expect("terminate request should notify process monitor")
}

// Basic client/server behavior.

#[tokio::test]
async fn client_server_no_guest() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let request = exec_request("ps aux");

    let response = send_exec(&fixture.sock_path, &request, Duration::from_secs(5))
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

// Terminate protocol behavior.

#[tokio::test]
async fn client_server_terminate_accepted() {
    let fixture = ControlServerFixture::new();
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let mut handle = fixture
        .bind_with_termination(ProcessTerminationHandle::new(kill_tx))
        .unwrap()
        .spawn(CancellationToken::new());

    let client = tokio::spawn({
        let sock_path = fixture.sock_path.clone();
        async move {
            let request = TerminateRequest {
                action: TerminateAction::Terminate,
            };
            send_terminate(&sock_path, &request, Duration::from_secs(5)).await
        }
    });
    recv_termination_request(&mut kill_rx).await.acknowledge();
    let response = client.await.unwrap().unwrap();

    assert_eq!(
        response,
        TerminateResponse::Status {
            status: TerminateStatus::Accepted
        }
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn client_server_terminate_already_stopped() {
    let fixture = ControlServerFixture::new();
    let (kill_tx, kill_rx) = mpsc::channel(1);
    drop(kill_rx);
    let mut handle = fixture
        .bind_with_termination(ProcessTerminationHandle::new(kill_tx))
        .unwrap()
        .spawn(CancellationToken::new());

    let request = TerminateRequest {
        action: TerminateAction::Terminate,
    };
    let response = send_terminate(&fixture.sock_path, &request, Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(
        response,
        TerminateResponse::Status {
            status: TerminateStatus::AlreadyStopped
        }
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn client_server_terminate_refuses_idle_sandbox() {
    let fixture = ControlServerFixture::new();
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let mut handle = fixture
        .bind_with_termination(ProcessTerminationHandle::with_park_coordinator(
            kill_tx,
            parked_coordinator(),
        ))
        .unwrap()
        .spawn(CancellationToken::new());

    let request = TerminateRequest {
        action: TerminateAction::Terminate,
    };
    let response = send_terminate(&fixture.sock_path, &request, Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(
        response,
        TerminateResponse::Status {
            status: TerminateStatus::RefusedIdle
        }
    );
    assert!(matches!(
        kill_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));

    handle.shutdown().await;
}

#[tokio::test]
async fn terminate_response_survives_shutdown_after_request_is_queued() {
    let fixture = ControlServerFixture::new();
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let shutdown = CancellationToken::new();
    let mut handle = fixture
        .bind_with_termination(ProcessTerminationHandle::new(kill_tx))
        .unwrap()
        .spawn(shutdown.clone());

    let client = tokio::spawn({
        let sock_path = fixture.sock_path.clone();
        async move {
            let request = TerminateRequest {
                action: TerminateAction::Terminate,
            };
            send_terminate(&sock_path, &request, Duration::from_secs(5)).await
        }
    });
    let request = recv_termination_request(&mut kill_rx).await;

    shutdown.cancel();
    request.acknowledge();
    let response = client.await.unwrap().unwrap();

    assert_eq!(
        response,
        TerminateResponse::Status {
            status: TerminateStatus::Accepted
        }
    );
    handle.shutdown().await;
}

// ProcessTerminationHandle behavior.

#[tokio::test]
async fn termination_handle_waits_behind_full_channel() {
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    kill_tx
        .try_send(ProcessTerminationRequest::fire_and_forget())
        .unwrap();
    let termination = ProcessTerminationHandle::new(kill_tx);
    let terminate_task = tokio::spawn(async move { termination.request_terminate().await });

    let queued_request = recv_termination_request(&mut kill_rx).await;

    assert!(!terminate_task.is_finished());
    queued_request.acknowledge();
    let request = recv_termination_request(&mut kill_rx).await;
    assert!(!terminate_task.is_finished());
    request.acknowledge();
    assert_eq!(terminate_task.await.unwrap(), TerminateStatus::Accepted);
}

#[tokio::test]
async fn termination_handle_waits_for_monitor_ack_before_accepting() {
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let termination = ProcessTerminationHandle::new(kill_tx);
    let terminate_task = tokio::spawn(async move { termination.request_terminate().await });

    let request = recv_termination_request(&mut kill_rx).await;

    assert!(!terminate_task.is_finished());
    request.acknowledge();
    assert_eq!(terminate_task.await.unwrap(), TerminateStatus::Accepted);
}

#[tokio::test]
async fn termination_handle_blocks_future_park_before_queueing_kill() {
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let coordinator = ParkCoordinator::new();
    let termination = ProcessTerminationHandle::with_park_coordinator(kill_tx, coordinator.clone());
    let terminate_task = tokio::spawn(async move { termination.request_terminate().await });

    let request = recv_termination_request(&mut kill_rx).await;
    assert_eq!(coordinator.state(), CoordinatorState::Terminating);
    assert!(coordinator.begin_prepare_park().is_err());
    assert!(!terminate_task.is_finished());
    request.acknowledge();
    assert_eq!(terminate_task.await.unwrap(), TerminateStatus::Accepted);
}

#[tokio::test]
async fn termination_handle_accepts_dirty_policy() {
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("transport failed"));
    let termination = ProcessTerminationHandle::with_park_coordinator(kill_tx, coordinator.clone());
    let terminate_task = tokio::spawn(async move { termination.request_terminate().await });

    recv_termination_request(&mut kill_rx).await.acknowledge();
    assert_eq!(terminate_task.await.unwrap(), TerminateStatus::Accepted);
    assert_eq!(coordinator.state(), CoordinatorState::Terminating);
}

#[tokio::test]
async fn termination_handle_accepts_ready_for_park_policy() {
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let coordinator = ready_for_park_coordinator();
    let termination = ProcessTerminationHandle::with_park_coordinator(kill_tx, coordinator.clone());
    let terminate_task = tokio::spawn(async move { termination.request_terminate().await });

    recv_termination_request(&mut kill_rx).await.acknowledge();
    assert_eq!(terminate_task.await.unwrap(), TerminateStatus::Accepted);
    assert_eq!(coordinator.state(), CoordinatorState::Terminating);
}

#[tokio::test]
async fn termination_handle_refuses_when_parked_without_queueing() {
    let (kill_tx, kill_rx) = mpsc::channel(1);
    let termination =
        ProcessTerminationHandle::with_park_coordinator(kill_tx, parked_coordinator());

    assert_eq!(
        termination.request_terminate().await,
        TerminateStatus::RefusedIdle
    );
    assert_eq!(kill_rx.len(), 0);
}

// Bound control server socket lifecycle.

#[tokio::test]
async fn bound_control_server_close_removes_socket() {
    let fixture = ControlServerFixture::new();

    let server = fixture.bind_default().unwrap();
    assert!(fixture.sock_path.exists());

    server.close();

    assert!(!fixture.sock_path.exists());
}

#[tokio::test]
async fn bound_control_server_drop_removes_socket() {
    let fixture = ControlServerFixture::new();

    {
        let _server = fixture.bind_default().unwrap();
        assert!(fixture.sock_path.exists());
    }

    assert!(!fixture.sock_path.exists());
}

#[tokio::test]
async fn control_server_shutdown_removes_socket() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());

    assert!(fixture.sock_path.exists());

    handle.shutdown().await;
    handle.shutdown().await;

    assert!(!fixture.sock_path.exists());
    let err = UnixStream::connect(&fixture.sock_path).await.unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
}

#[tokio::test]
async fn control_server_cancel_removes_socket() {
    let fixture = ControlServerFixture::new();
    let shutdown = CancellationToken::new();
    let mut handle = fixture.spawn_default(shutdown.clone());

    shutdown.cancel();
    wait_for_socket_removed(&fixture.sock_path).await;

    handle.shutdown().await;
    assert!(!fixture.sock_path.exists());
}

#[tokio::test]
async fn control_server_cancel_cancels_pending_connection() {
    let fixture = ControlServerFixture::new();
    let shutdown = CancellationToken::new();
    let mut handle = fixture.spawn_default(shutdown.clone());
    let mut stream = UnixStream::connect(&fixture.sock_path).await.unwrap();
    stream.write_u32(1024).await.unwrap();

    shutdown.cancel();
    wait_for_socket_removed(&fixture.sock_path).await;

    tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
        .await
        .unwrap();
    assert!(!fixture.sock_path.exists());
}

#[tokio::test]
async fn control_server_shutdown_cancels_pending_connection() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let mut stream = UnixStream::connect(&fixture.sock_path).await.unwrap();
    stream.write_u32(1024).await.unwrap();

    tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
        .await
        .unwrap();

    assert!(!fixture.sock_path.exists());
}

// Vsock-backed control exec lifecycle.

#[tokio::test]
async fn control_server_shutdown_cancels_in_flight_vsock_exec() {
    let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
    let fixture =
        VsockExecFixture::connect(|vsock_base| mock_guest_holds_exec(vsock_base, exec_seen_tx))
            .await;
    let mut handle = fixture.spawn_server();
    let client = tokio::spawn({
        let sock_path = fixture.sock_path.clone();
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
    assert_eq!(fixture.coordinator.state(), CoordinatorState::Open);
    assert!(
        matches!(
            fixture.vsock.try_fence_normal_operations(),
            Err(NormalOperationFenceRejection::NotParkable | NormalOperationFenceRejection::Closed)
        ),
        "cancelled in-flight control exec should leave vsock-host not parkable"
    );

    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn control_exec_rejects_when_policy_gate_is_closing() {
    let (exec_seen_tx, mut exec_seen_rx) = oneshot::channel();
    let fixture =
        VsockExecFixture::connect(|vsock_base| mock_guest_records_exec(vsock_base, exec_seen_tx))
            .await;
    let attempt = fixture
        .coordinator
        .begin_prepare_park()
        .expect("gate should enter closing state");
    let mut handle = fixture.spawn_server();
    let request = exec_request("echo should-not-run");
    let response = send_exec(&fixture.sock_path, &request, Duration::from_secs(5))
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
        matches!(exec_seen_rx.try_recv(), Err(TryRecvError::Empty)),
        "control exec should not send a guest command while the gate is closing or drop the mock guest"
    );

    handle.shutdown().await;
    fixture.coordinator.abort_prepare_park(&attempt).unwrap();
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn control_exec_rejects_zero_timeout_without_guest_exec() {
    let (exec_seen_tx, mut exec_seen_rx) = oneshot::channel();
    let fixture =
        VsockExecFixture::connect(|vsock_base| mock_guest_records_exec(vsock_base, exec_seen_tx))
            .await;
    let mut handle = fixture.spawn_server();
    let request = ExecRequest {
        command: "echo should-not-run".into(),
        timeout_secs: 0,
        sudo: false,
    };
    let response = send_exec(&fixture.sock_path, &request, Duration::from_secs(5))
        .await
        .unwrap();

    match response {
        ExecResponse::Error { error } => {
            assert_eq!(
                error,
                "exec failed: exec requires a positive timeout; use supervised exec for unbounded commands"
            );
        }
        ExecResponse::Success { .. } => panic!("expected zero-timeout validation error"),
    }
    assert!(
        matches!(exec_seen_rx.try_recv(), Err(TryRecvError::Empty)),
        "control exec should not send a guest command with zero timeout or drop the mock guest"
    );

    handle.shutdown().await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn control_exec_terminal_guest_error_completes_vsock_operation() {
    let fixture = VsockExecFixture::connect(|vsock_base| {
        mock_guest_errors_exec(vsock_base, "guest refused exec")
    })
    .await;
    let mut handle = fixture.spawn_server();
    let request = exec_request("exit-before-start");
    let response = send_exec(&fixture.sock_path, &request, Duration::from_secs(5))
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
    assert!(fixture.vsock.try_fence_normal_operations().is_ok());
    let attempt = fixture
        .coordinator
        .begin_prepare_park()
        .expect("terminal guest error should leave park policy open");
    fixture.coordinator.abort_prepare_park(&attempt).unwrap();

    handle.shutdown().await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn control_exec_transport_error_makes_vsock_not_parkable() {
    let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
    let fixture =
        VsockExecFixture::connect(|vsock_base| mock_guest_records_exec(vsock_base, exec_seen_tx))
            .await;
    let mut handle = fixture.spawn_server();
    let request = exec_request("disconnect-after-start");
    let response = send_exec(&fixture.sock_path, &request, Duration::from_secs(5))
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
    assert_eq!(fixture.coordinator.state(), CoordinatorState::Open);
    assert!(
        matches!(
            fixture.vsock.try_fence_normal_operations(),
            Err(NormalOperationFenceRejection::NotParkable | NormalOperationFenceRejection::Closed)
        ),
        "transport error after command write should leave vsock-host not parkable"
    );

    handle.shutdown().await;
    fixture.guest_task.await.unwrap();
}

// Bind failure behavior.

#[tokio::test]
async fn bind_server_reports_bind_failure() {
    let fixture = ControlServerFixture::new();
    let _existing = UnixListener::bind(&fixture.sock_path).unwrap();

    let result = fixture.bind_default();

    let Err(err) = result else {
        panic!("binding an occupied control socket should fail");
    };
    assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    assert!(fixture.sock_path.exists());
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
