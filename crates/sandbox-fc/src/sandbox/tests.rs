use super::*;
use crate::api::test_support::{MockFirecrackerApi, MockResponse};
use crate::config::{RateLimiterConfig, TokenBucketConfig};
use sandbox::ExecTermination;
use std::os::unix::fs::PermissionsExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::Instant;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};
use vsock_proto::{
    Decoder, ExecControlStatus, HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_EXEC_CONTROL,
    MSG_EXEC_CONTROL_RESULT, MSG_PING, MSG_PONG, MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK,
    RawMessage,
};

struct TestNormalOperationFence;

async fn park_with_ready_for_park<Q, QF, P, PF>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    quiesce_guest: Q,
    park_firecracker: P,
) -> sandbox::Result<()>
where
    Q: FnOnce() -> QF,
    QF: Future<Output = io::Result<()>>,
    P: FnOnce() -> PF,
    PF: Future<Output = sandbox::Result<()>>,
{
    super::park_with_ready_for_park(
        log_id,
        coordinator,
        || async { Ok(TestNormalOperationFence) },
        quiesce_guest,
        park_firecracker,
    )
    .await
    .map(drop)
}

async fn unpark_with_ready_for_operations<U, UF, R, RF>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    unpark_firecracker: U,
    resume_guest: R,
) -> sandbox::Result<()>
where
    U: FnOnce() -> UF,
    UF: Future<Output = sandbox::Result<()>>,
    R: FnOnce() -> RF,
    RF: Future<Output = io::Result<()>>,
{
    super::unpark_with_ready_for_operations(
        log_id,
        coordinator,
        unpark_firecracker,
        resume_guest,
        || {},
    )
    .await
}

struct ExecProcessControlFixture {
    host: Arc<VsockHost>,
    handle: vsock_host::SupervisedExecHandle,
    guest: UnixStream,
    exec_seq: u32,
}

fn test_sandbox_with_state(state: SandboxState) -> FirecrackerSandbox {
    let id = sandbox::SandboxId::new_v4();
    let base_dir = std::env::temp_dir().join("sandbox-fc-operation-entrypoint-test");
    let (state_tx, _) = watch::channel(state);

    FirecrackerSandbox {
        config: sandbox::SandboxConfig {
            id,
            resources: test_resources(),
            device_rate_limits: None,
            workspace_drive: None,
        },
        factory_config: FirecrackerConfig {
            binary_path: base_dir.join("firecracker"),
            kernel_path: base_dir.join("vmlinux"),
            rootfs_path: base_dir.join("rootfs.ext4"),
            base_dir: base_dir.clone(),
            profile: "test".into(),
            proxy_port: None,
            dns_port: None,
            snapshot: None,
        },
        id: id.to_string(),
        sandbox_paths: SandboxPaths::new(base_dir.join("workspace")),
        sock_paths: SockPaths::new(base_dir.join("sock")),
        network: SandboxNetwork {
            info: NetnsLease::new_for_test("test-ns").into_info_for_test(),
            lease: None,
        },
        cow_device: None,
        device_rate_limits: None,
        runtime: SandboxRuntimeHandles::default(),
        process_group_pid: None,
        state: Arc::new(AtomicU8::new(state as u8)),
        state_publish_lock: Arc::new(Mutex::new(())),
        state_tx,
        guest: Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>)),
        park_coordinator: ParkCoordinator::new(),
        leak_tx: None,
        delete_workspace_on_leak_cleanup: true,
        destroyed: true,
        is_parked: false,
        park_outcome: None,
        park_fence: None,
    }
}

async fn connect_mock_guest(vsock_path: &str) -> UnixStream {
    let listener_path = format!("{vsock_path}_{}", vsock_proto::VSOCK_PORT);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match UnixStream::connect(&listener_path).await {
            Ok(stream) => return stream,
            Err(error) if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline => {
                tokio::task::yield_now().await;
            }
            Err(error) => panic!("connect mock guest: {error}"),
        }
    }
}

async fn read_vsock_message(stream: &mut UnixStream) -> RawMessage {
    let mut header = [0u8; HEADER_SIZE];
    stream.read_exact(&mut header).await.unwrap();

    let body_len = u32::from_be_bytes(header) as usize;
    assert!(
        (MIN_BODY_SIZE..=MAX_MESSAGE_SIZE).contains(&body_len),
        "invalid message body length: {body_len}",
    );

    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).await.unwrap();

    RawMessage {
        msg_type: body[0],
        seq: u32::from_be_bytes(body[1..MIN_BODY_SIZE].try_into().unwrap()),
        payload: body[MIN_BODY_SIZE..].to_vec(),
    }
}

async fn mock_vsock_handshake(stream: &mut UnixStream, decoder: &mut Decoder) {
    let ready = vsock_proto::encode(MSG_READY, 0, &[]).unwrap();
    stream.write_all(&ready).await.unwrap();

    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).await.unwrap();
    let msgs = decoder.decode(&buf[..n]).unwrap();
    assert_eq!(msgs[0].msg_type, MSG_PING);

    let pong = vsock_proto::encode(MSG_PONG, msgs[0].seq, &[]).unwrap();
    stream.write_all(&pong).await.unwrap();
}

async fn attach_mock_shutdown_guest(sandbox: &FirecrackerSandbox) -> UnixStream {
    let temp_dir = tempfile::tempdir().unwrap();
    let vsock_path = temp_dir
        .path()
        .join("shutdown")
        .to_string_lossy()
        .into_owned();
    let wait_vsock_path = vsock_path.clone();
    let host_task = tokio::spawn(async move {
        VsockHost::wait_for_connection(&wait_vsock_path, Duration::from_secs(5))
            .await
            .unwrap()
    });
    let mut guest = connect_mock_guest(&vsock_path).await;
    let mut decoder = Decoder::new();
    mock_vsock_handshake(&mut guest, &mut decoder).await;
    *sandbox.guest.lock().await = Some(Arc::new(host_task.await.unwrap()));
    guest
}

async fn setup_exec_process_control_fixture() -> ExecProcessControlFixture {
    let temp_dir = tempfile::tempdir().unwrap();
    let vsock_path = temp_dir
        .path()
        .join("exec-process-control")
        .to_string_lossy()
        .into_owned();
    let wait_vsock_path = vsock_path.clone();
    let host_task = tokio::spawn(async move {
        VsockHost::wait_for_connection(&wait_vsock_path, Duration::from_secs(5))
            .await
            .unwrap()
    });
    let mut guest = connect_mock_guest(&vsock_path).await;
    let mut decoder = Decoder::new();
    mock_vsock_handshake(&mut guest, &mut decoder).await;
    let host = Arc::new(host_task.await.unwrap());

    let start_host = Arc::clone(&host);
    let start_task = tokio::spawn(async move {
        start_host
            .start_supervised_exec(SupervisedExecRequest {
                timeout: ExecTimeoutPolicy::Duration { timeout_ms: 60_000 },
                command: "sleep 60",
                env: &[],
                sudo: false,
                label: "sleep 60",
                stdout: ExecOutputPolicy::Discard,
                stderr: ExecOutputPolicy::Discard,
                expected_exit_codes: &[],
                stdin_bytes: None,
                control: SupervisedExecControl::Enabled { sink: true },
                stream_queue_capacity: None,
                start_timeout: Duration::from_secs(5),
            })
            .await
            .unwrap()
    });
    let start = read_vsock_message(&mut guest).await;
    assert_eq!(start.msg_type, vsock_proto::MSG_EXEC_START);
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    assert_eq!(
        decoded_start.lifecycle,
        vsock_proto::ExecLifecyclePolicy::Supervised
    );
    assert!(matches!(
        decoded_start.control,
        vsock_proto::ExecControlPolicy::Enabled { sink: true, .. }
    ));

    let pid = 73;
    let payload = vsock_proto::encode_exec_started(pid).unwrap();
    let response = vsock_proto::encode(vsock_proto::MSG_EXEC_STARTED, start.seq, &payload).unwrap();
    guest.write_all(&response).await.unwrap();
    let handle = start_task.await.unwrap();

    ExecProcessControlFixture {
        host,
        handle,
        guest,
        exec_seq: start.seq,
    }
}

fn running_process_state() -> (Arc<AtomicU8>, watch::Sender<SandboxState>) {
    process_state(SandboxState::Running)
}

fn process_state(sandbox_state: SandboxState) -> (Arc<AtomicU8>, watch::Sender<SandboxState>) {
    let state = Arc::new(AtomicU8::new(sandbox_state as u8));
    let (state_tx, _state_rx) = watch::channel(sandbox_state);
    (state, state_tx)
}

fn state_after_first_read(next_state: SandboxState) -> impl Fn() -> SandboxState {
    let reads = std::sync::atomic::AtomicUsize::new(0);
    move || {
        if reads.fetch_add(1, Ordering::SeqCst) == 0 {
            SandboxState::Running
        } else {
            next_state
        }
    }
}

#[test]
fn process_control_stop_after_policy_check_keeps_policy_open() {
    let coordinator = ParkCoordinator::new();

    let error = match FirecrackerSandbox::begin_process_control(
        &coordinator,
        state_after_first_read(SandboxState::Stopped),
    ) {
        Ok(_) => panic!("expected process control boundary to reject stopped state"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        GuestOperationStartError::NotRunning {
            state: SandboxState::Stopped
        }
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[test]
fn process_control_crash_after_policy_check_keeps_policy_open() {
    let coordinator = ParkCoordinator::new();

    let error = match FirecrackerSandbox::begin_process_control(
        &coordinator,
        state_after_first_read(SandboxState::Crashed),
    ) {
        Ok(_) => panic!("expected process control boundary to reject crashed state"),
        Err(error) => error,
    };

    assert_eq!(error, GuestOperationStartError::BackendCrashed);
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

async fn send_exec_control_result(
    stream: &mut UnixStream,
    request: RawMessage,
    status: ExecControlStatus,
    diagnostic: &str,
) {
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);
    let decoded = vsock_proto::decode_exec_control(&request.payload).unwrap();
    let payload = vsock_proto::encode_exec_control_result(
        decoded.target_seq,
        decoded.control_nonce,
        decoded.message_id,
        status,
        diagnostic,
    )
    .unwrap();
    let response = vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, request.seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

async fn send_exec_control_error(stream: &mut UnixStream, request: RawMessage, message: &str) {
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);
    let payload = vsock_proto::encode_error(message);
    let response = vsock_proto::encode(vsock_proto::MSG_ERROR, request.seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

async fn send_mismatched_exec_control_result(stream: &mut UnixStream, request: RawMessage) {
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);
    let decoded = vsock_proto::decode_exec_control(&request.payload).unwrap();
    let payload = vsock_proto::encode_exec_control_result(
        decoded.target_seq + 1,
        decoded.control_nonce,
        decoded.message_id,
        ExecControlStatus::Delivered,
        "",
    )
    .unwrap();
    let response = vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, request.seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

async fn send_exec_exit(stream: &mut UnixStream, exec_seq: u32) {
    let payload = vsock_proto::encode_exec_result(
        vsock_proto::ExecTermination::Exited { exit_code: 0 },
        1,
        vsock_proto::ExecCapturedOutput::Discarded,
        vsock_proto::ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    let response = vsock_proto::encode(vsock_proto::MSG_EXEC_RESULT, exec_seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

fn monitored_cat_process() -> tokio::process::Child {
    tokio::process::Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

fn monitored_cat_process_without_log_pipes() -> tokio::process::Child {
    tokio::process::Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

fn stdout_stderr_writing_process() -> tokio::process::Child {
    tokio::process::Command::new("bash")
        .args(["-c", "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

fn stdout_closing_process() -> tokio::process::Child {
    tokio::process::Command::new("bash")
        .args(["-c", "exec 1>&-; sleep 60"])
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

fn parent_exits_with_child_process(pid_file: &std::path::Path) -> tokio::process::Child {
    tokio::process::Command::new("bash")
        .args([
            "-c",
            "trap '' HUP; sleep 60 & echo $! > \"$1\"; exit 1",
            "_",
        ])
        .arg(pid_file)
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for DropNotify {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

fn pending_log_reader_for_test() -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _notify = DropNotify(Some(dropped_tx));
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    (handle, started_rx, dropped_rx)
}

fn test_resources() -> sandbox::ResourceLimits {
    sandbox::ResourceLimits {
        cpu_count: 2,
        memory_mb: 4096,
    }
}

fn test_rate_limits() -> FirecrackerDeviceRateLimits {
    FirecrackerDeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 10_240,
            ops_per_sec: 100,
        },
        net_rx: RateLimiterConfig {
            bandwidth: Some(TokenBucketConfig {
                size: 2048,
                refill_time: 100,
            }),
            ops: None,
        },
        net_tx: RateLimiterConfig {
            bandwidth: Some(TokenBucketConfig {
                size: 4096,
                refill_time: 100,
            }),
            ops: None,
        },
    }
}

#[test]
fn fresh_boot_config_omits_rate_limiters_when_disabled() {
    let config = build_fresh_boot_firecracker_config(
        &test_resources(),
        "/kernel".to_string(),
        "/dev/nbd0".to_string(),
        None,
        "/run/vsock.sock".to_string(),
        None,
    )
    .unwrap();

    assert!(config["drives"][0].get("rate_limiter").is_none());
    assert!(
        config["network-interfaces"][0]
            .get("rx_rate_limiter")
            .is_none()
    );
    assert!(
        config["network-interfaces"][0]
            .get("tx_rate_limiter")
            .is_none()
    );
}

#[test]
fn fresh_boot_config_includes_rate_limiters_when_enabled() {
    let rate_limits = test_rate_limits();
    let config = build_fresh_boot_firecracker_config(
        &test_resources(),
        "/kernel".to_string(),
        "/dev/nbd0".to_string(),
        None,
        "/run/vsock.sock".to_string(),
        Some(&rate_limits),
    )
    .unwrap();

    assert_eq!(
        config["drives"][0]["rate_limiter"],
        serde_json::json!({
            "bandwidth": { "size": 1024, "refill_time": 100 },
            "ops": { "size": 10, "refill_time": 100 },
        })
    );
    assert_eq!(
        config["network-interfaces"][0]["rx_rate_limiter"],
        serde_json::json!({
            "bandwidth": { "size": 2048, "refill_time": 100 },
        })
    );
    assert_eq!(
        config["network-interfaces"][0]["tx_rate_limiter"],
        serde_json::json!({
            "bandwidth": { "size": 4096, "refill_time": 100 },
        })
    );
}

#[test]
fn fresh_boot_config_includes_workspace_drive_without_rate_limiters() {
    let config = build_fresh_boot_firecracker_config(
        &test_resources(),
        "/kernel".to_string(),
        "/dev/nbd0".to_string(),
        Some("/workspaces/test/workspace.ext4".to_string()),
        "/run/vsock.sock".to_string(),
        None,
    )
    .unwrap();

    assert_eq!(config["drives"][0]["drive_id"], "rootfs");
    assert_eq!(config["drives"][1]["drive_id"], "workspace");
    assert_eq!(
        config["drives"][1]["path_on_host"],
        "/workspaces/test/workspace.ext4"
    );
    assert_eq!(config["drives"][1]["is_root_device"], false);
    assert_eq!(config["drives"][1]["is_read_only"], false);
    assert!(config["drives"][0].get("rate_limiter").is_none());
    assert!(config["drives"][1].get("rate_limiter").is_none());
}

#[test]
fn fresh_boot_config_includes_workspace_drive_and_splits_block_limiters() {
    let rate_limits = test_rate_limits();
    let config = build_fresh_boot_firecracker_config(
        &test_resources(),
        "/kernel".to_string(),
        "/dev/nbd0".to_string(),
        Some("/workspaces/test/workspace.ext4".to_string()),
        "/run/vsock.sock".to_string(),
        Some(&rate_limits),
    )
    .unwrap();

    assert_eq!(config["drives"][0]["drive_id"], "rootfs");
    assert_eq!(config["drives"][1]["drive_id"], "workspace");
    assert_eq!(
        config["drives"][1]["path_on_host"],
        "/workspaces/test/workspace.ext4"
    );
    assert_eq!(config["drives"][1]["is_root_device"], false);
    assert_eq!(config["drives"][1]["is_read_only"], false);
    assert_eq!(
        config["drives"][0]["rate_limiter"]["bandwidth"]["size"],
        512
    );
    assert_eq!(
        config["drives"][1]["rate_limiter"]["bandwidth"]["size"],
        512
    );
}

fn stdout_eof_notifying_log_reader_for_test<R>(
    id: &str,
    reader: R,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Receiver<()>,
)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let id = id.to_owned();
    let (eof_tx, eof_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        if read_process_log_records(reader, |record| {
            ProcessLogStream::Stdout.log(&id, record);
        })
        .await
        .is_ok()
        {
            let _ = eof_tx.send(());
        }
    });
    (handle, eof_rx)
}

fn pid_is_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, after_comm)) = stat.rsplit_once(") ") else {
        return false;
    };
    !after_comm.starts_with('Z')
}

async fn wait_for_pid_not_running(pid: u32) -> bool {
    tokio::time::timeout(Duration::from_secs(1), async {
        while pid_is_running(pid) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

async fn wait_for_state(state: &AtomicU8, expected: SandboxState) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while SandboxState::from_u8(state.load(Ordering::Acquire)) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_path_removed(path: &Path) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn assert_idle_transition<T: std::fmt::Debug>(
    result: sandbox::Result<T>,
    expected: SandboxIdleTransition,
) {
    match result {
        Err(SandboxError::IdleTransition { transition, .. }) => {
            assert_eq!(transition, expected);
        }
        other => panic!("expected {expected} idle transition error, got {other:?}"),
    }
}

fn assert_operation_error(
    error: SandboxError,
    expected_operation: SandboxOperation,
    expected_reason: SandboxOperationReason,
) {
    match error {
        SandboxError::Operation {
            operation, reason, ..
        } => {
            assert_eq!(operation, expected_operation);
            assert_eq!(reason, expected_reason);
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

fn assert_invalid_state_operation(
    error: SandboxError,
    expected_operation: SandboxOperation,
    expected_state: &str,
) {
    match error {
        SandboxError::InvalidState { context, state, .. } => {
            assert_eq!(
                context,
                SandboxInvalidStateContext::Operation(expected_operation)
            );
            assert_eq!(state, expected_state);
        }
        other => panic!("expected invalid state error, got {other:?}"),
    }
}

async fn assert_file_entrypoints_invalid_state(sandbox: &FirecrackerSandbox, expected_state: &str) {
    let read_err = sandbox
        .read_file("/tmp/system.log", 1024)
        .await
        .unwrap_err();
    assert_invalid_state_operation(read_err, SandboxOperation::ReadFile, expected_state);

    let copy_err = sandbox
        .copy_file(
            "/tmp/system.log",
            Path::new("unused-copy-target"),
            CopyFileOptions {
                max_bytes: 1024,
                timeout: Duration::from_secs(5),
                missing_ok: false,
            },
        )
        .await
        .unwrap_err();
    assert_invalid_state_operation(copy_err, SandboxOperation::CopyFile, expected_state);
}

fn mark_coordinator_parked(coordinator: &ParkCoordinator) {
    let attempt = coordinator
        .begin_prepare_park()
        .expect("begin prepare park");
    coordinator
        .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced)
        .expect("complete prepare park");
    coordinator.mark_parked(&attempt).expect("mark parked");
}

fn event_log() -> Arc<Mutex<Vec<&'static str>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn logged_events(events: &Arc<Mutex<Vec<&'static str>>>) -> Vec<&'static str> {
    events.lock().unwrap().clone()
}

#[derive(Debug)]
struct RecordedFence {
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl Drop for RecordedFence {
    fn drop(&mut self) {
        self.events.lock().unwrap().push("release_fence");
    }
}

struct ClosingStateFence {
    coordinator: ParkCoordinator,
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl Drop for ClosingStateFence {
    fn drop(&mut self) {
        assert!(matches!(
            self.coordinator.state(),
            CoordinatorState::ClosingForPark { .. }
        ));
        self.events.lock().unwrap().push("release_fence");
    }
}

#[test]
fn termination_releases_park_fence_and_clears_parked_flag() {
    let events = event_log();
    let mut is_parked = true;
    let mut park_outcome = Some(SandboxParkOutcome::Reusable);
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });

    release_park_state_for_termination(&mut is_parked, &mut park_outcome, &mut fence);

    assert!(!is_parked);
    assert!(park_outcome.is_none());
    assert!(fence.is_none());
    assert_eq!(logged_events(&events), vec!["release_fence"]);
}

#[test]
fn park_noop_with_parked_gate_succeeds() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);

    ensure_park_noop_state(&coordinator).unwrap();
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[test]
fn park_noop_reports_dirty_gate_instead_of_succeeding() {
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("mark parked failed"));

    assert_idle_transition(
        ensure_park_noop_state(&coordinator),
        SandboxIdleTransition::Park,
    );
}

#[test]
fn park_noop_with_open_gate_marks_dirty() {
    let coordinator = ParkCoordinator::new();

    assert_idle_transition(
        ensure_park_noop_state(&coordinator),
        SandboxIdleTransition::Park,
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_quiesces_before_firecracker_park() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let park_state = coordinator.clone();

    park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            assert!(matches!(
                park_state.state(),
                CoordinatorState::ReadyForPark { .. }
            ));
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["guest_quiesce", "firecracker_park"]
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn ready_for_park_boundary_preserves_non_reusable_outcome() {
    let coordinator = ParkCoordinator::new();

    let (_fence, outcome) = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async { Ok(TestNormalOperationFence) },
        || async { Ok(()) },
        || async {
            Ok(SandboxParkOutcome::NonReusable(
                SandboxParkNonReusableReason::SevereMemoryRetention,
            ))
        },
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention)
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn final_preparation_runs_after_operation_admission_closes() {
    let coordinator = ParkCoordinator::new();
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let operation_gate = GuestOperationStartGate::new(guest, coordinator.clone());
    let (preparation_entered_tx, preparation_entered_rx) = tokio::sync::oneshot::channel();
    let (release_preparation_tx, release_preparation_rx) = tokio::sync::oneshot::channel();

    let transition = super::park_with_ready_for_park_and_preparation(
        "test-sandbox",
        &coordinator,
        || async move {
            preparation_entered_tx.send(()).unwrap();
            release_preparation_rx.await.unwrap();
            Ok((TestNormalOperationFence, "prepared"))
        },
        || async { Ok(()) },
        || async { Ok(SandboxParkOutcome::Reusable) },
    );
    tokio::pin!(transition);

    tokio::select! {
        _ = &mut transition => panic!("park completed before final preparation was released"),
        result = preparation_entered_rx => result.unwrap(),
    }

    assert!(matches!(
        operation_gate
            .begin_sandbox_operation(|| SandboxState::Running)
            .await,
        Err(GuestOperationStartError::GateClosed { .. })
    ));
    assert!(matches!(
        operation_gate.begin_control_operation().await,
        Err(GuestOperationStartError::GateClosed { .. })
    ));

    release_preparation_tx.send(()).unwrap();
    let (_fence, outcome, preparation) = transition.await.unwrap();
    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    assert_eq!(preparation, "prepared");
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn final_preparation_transport_failure_marks_dirty_without_quiesce_or_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park_and_preparation(
        "test-sandbox",
        &coordinator,
        || async {
            Err::<(TestNormalOperationFence, ()), _>(ParkNormalOperationFenceError::FinalOperation(
                io::Error::new(io::ErrorKind::ConnectionReset, "final exec disconnected"),
            ))
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(SandboxParkOutcome::Reusable)
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_fences_before_quiesce_and_holds_until_returned() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let fence = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "firecracker_park"]
    );
    drop(fence);
    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
}

#[test]
fn ready_for_park_boundary_cancel_after_fence_releases_before_reopening_gate() {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator.begin_prepare_park().unwrap();
    let events = event_log();
    let mut guard = ParkBoundaryGuard::new(coordinator.clone(), attempt);

    guard.mark_normal_operations_fenced(ClosingStateFence {
        coordinator: coordinator.clone(),
        events: Arc::clone(&events),
    });
    drop(guard);

    assert_eq!(logged_events(&events), vec!["release_fence"]);
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[test]
fn ready_for_park_boundary_missing_fence_marks_dirty_after_ready_for_park() {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator.begin_prepare_park().unwrap();
    let mut guard: ParkBoundaryGuard<RecordedFence> =
        ParkBoundaryGuard::new(coordinator.clone(), attempt);

    guard.complete_prepare().unwrap();
    let error = guard.mark_parked().unwrap_err();

    assert!(matches!(error, PrepareParkError::Dirty { .. }));
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_busy_fence_aborts_without_dirtying() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Err::<RecordedFence, _>(ParkNormalOperationFenceError::Rejected(
                NormalOperationFenceRejection::Busy,
            ))
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert_eq!(logged_events(&events), vec!["fence"]);
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[tokio::test]
async fn ready_for_park_boundary_not_parkable_fence_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async {
            Err::<RecordedFence, _>(ParkNormalOperationFenceError::Rejected(
                NormalOperationFenceRejection::NotParkable,
            ))
        },
        || async { Ok(()) },
        || async { Ok(()) },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_guest_unavailable_fence_marks_dirty_without_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async {
            Err::<RecordedFence, _>(ParkNormalOperationFenceError::GuestUnavailable(
                io::Error::new(io::ErrorKind::NotConnected, "guest missing"),
            ))
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_dirty_prevents_quiesce_and_pause() {
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("test dirty"));
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(logged_events(&events).is_empty());
}

#[tokio::test]
async fn ready_for_park_boundary_invalid_state_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(logged_events(&events).is_empty());
}

#[tokio::test]
async fn ready_for_park_boundary_quiesce_failure_marks_dirty_without_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Err(io::Error::new(io::ErrorKind::TimedOut, "quiesce timeout"))
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "release_fence"]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_complete_prepare_failure_marks_dirty_without_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let quiesce_state = coordinator.clone();

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            quiesce_state.mark_dirty(DirtyReason::new("operation dropped during quiesce"));
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "release_fence"]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_firecracker_failure_after_quiesce_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Err::<(), _>(idle_transition_error(
                SandboxIdleTransition::Park,
                "pause failed",
            ))
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_mark_parked_failure_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let park_state = coordinator.clone();

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            park_state.mark_dirty(DirtyReason::new("mark parked race"));
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_cancel_during_guest_quiesce_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let (quiesce_started_tx, quiesce_started_rx) = tokio::sync::oneshot::channel();

    {
        let park = super::park_with_ready_for_park(
            "test-sandbox",
            &coordinator,
            || async move {
                fence_events.lock().unwrap().push("fence");
                Ok(RecordedFence {
                    events: Arc::clone(&fence_events),
                })
            },
            || async move {
                quiesce_events.lock().unwrap().push("guest_quiesce");
                let _ = quiesce_started_tx.send(());
                std::future::pending::<io::Result<()>>().await
            },
            || async { Ok(()) },
        );
        tokio::pin!(park);

        tokio::select! {
            result = &mut park => panic!("park completed unexpectedly: {result:?}"),
            result = quiesce_started_rx => result.unwrap(),
        }
    }

    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "release_fence"]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_cancel_after_ready_for_park_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let (park_started_tx, park_started_rx) = tokio::sync::oneshot::channel();

    {
        let park = super::park_with_ready_for_park(
            "test-sandbox",
            &coordinator,
            || async move {
                fence_events.lock().unwrap().push("fence");
                Ok(RecordedFence {
                    events: Arc::clone(&fence_events),
                })
            },
            || async move {
                quiesce_events.lock().unwrap().push("guest_quiesce");
                Ok(())
            },
            || async move {
                park_events.lock().unwrap().push("firecracker_park");
                let _ = park_started_tx.send(());
                std::future::pending::<sandbox::Result<()>>().await
            },
        );
        tokio::pin!(park);

        tokio::select! {
            result = &mut park => panic!("park completed unexpectedly: {result:?}"),
            result = park_started_rx => result.unwrap(),
        }
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { .. }
        ));
    }

    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_resumes_firecracker_before_guest_and_reopens() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let resume_state = coordinator.clone();

    unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            assert!(matches!(resume_state.state(), CoordinatorState::Parked));
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume"]
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[tokio::test]
async fn ready_for_operations_boundary_releases_fence_before_reopening_gate() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let release_events = Arc::clone(&events);
    let release_state = coordinator.clone();

    super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
        || {
            assert!(matches!(release_state.state(), CoordinatorState::Parked));
            release_events.lock().unwrap().push("release_fence");
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume", "release_fence"]
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[tokio::test]
async fn ready_for_operations_boundary_firecracker_failure_does_not_resume_guest() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                "resume failed",
            ))
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
        || {
            drop(fence.take());
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(fence.is_some());
    assert_eq!(logged_events(&events), vec!["firecracker_unpark"]);
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn ready_for_operations_boundary_guest_resume_failure_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "resume failed",
            ))
        },
        || {
            drop(fence.take());
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(fence.is_some());
    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume"]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_dirty_state_does_not_resume_firecracker() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    coordinator.mark_dirty(DirtyReason::new("park completion failed"));
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_cancel_after_firecracker_resume_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let (resume_started_tx, resume_started_rx) = tokio::sync::oneshot::channel();

    {
        let unpark = unpark_with_ready_for_operations(
            "test-sandbox",
            &coordinator,
            || async { Ok(()) },
            || async move {
                let _ = resume_started_tx.send(());
                std::future::pending::<io::Result<()>>().await
            },
        );
        tokio::pin!(unpark);

        tokio::select! {
            result = &mut unpark => panic!("unpark completed unexpectedly: {result:?}"),
            result = resume_started_rx => result.unwrap(),
        }
    }

    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_cancel_during_firecracker_unpark_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let (firecracker_started_tx, firecracker_started_rx) = tokio::sync::oneshot::channel();

    {
        let unpark = unpark_with_ready_for_operations(
            "test-sandbox",
            &coordinator,
            || async move {
                firecracker_events
                    .lock()
                    .unwrap()
                    .push("firecracker_unpark");
                let _ = firecracker_started_tx.send(());
                std::future::pending::<sandbox::Result<()>>().await
            },
            || async move {
                resume_events.lock().unwrap().push("guest_resume");
                Ok(())
            },
        );
        tokio::pin!(unpark);

        tokio::select! {
            result = &mut unpark => panic!("unpark completed unexpectedly: {result:?}"),
            result = firecracker_started_rx => result.unwrap(),
        }
    }

    assert_eq!(logged_events(&events), vec!["firecracker_unpark"]);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_cancel_during_firecracker_unpark_keeps_fence() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });
    let (firecracker_started_tx, firecracker_started_rx) = tokio::sync::oneshot::channel();

    {
        let unpark = super::unpark_with_ready_for_operations(
            "test-sandbox",
            &coordinator,
            || async move {
                let _ = firecracker_started_tx.send(());
                std::future::pending::<sandbox::Result<()>>().await
            },
            || async { Ok(()) },
            || {
                drop(fence.take());
            },
        );
        tokio::pin!(unpark);

        tokio::select! {
            result = &mut unpark => panic!("unpark completed unexpectedly: {result:?}"),
            result = firecracker_started_rx => result.unwrap(),
        }
    }

    assert!(fence.is_some());
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_invalid_state_marks_dirty_without_resume() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_reopen_failure_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let release_events = Arc::clone(&events);
    let resume_state = coordinator.clone();

    let result = super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            resume_state.mark_dirty(DirtyReason::new("reopen race"));
            Ok(())
        },
        || {
            release_events.lock().unwrap().push("release_fence");
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume", "release_fence"]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[test]
fn unpark_noop_reports_dirty_gate_instead_of_succeeding() {
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("resume failed"));

    assert_idle_transition(
        ensure_unpark_noop_state(&coordinator),
        SandboxIdleTransition::Unpark,
    );
}

#[test]
fn unpark_noop_with_closed_gate_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);

    assert_idle_transition(
        ensure_unpark_noop_state(&coordinator),
        SandboxIdleTransition::Unpark,
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[test]
fn operation_error_classifies_io_timeout() {
    let err = FirecrackerSandbox::operation_error(
        SandboxOperation::WaitProcess,
        io::Error::new(io::ErrorKind::TimedOut, "wait timeout"),
        false,
    );

    assert_operation_error(
        err,
        SandboxOperation::WaitProcess,
        SandboxOperationReason::Timeout,
    );
}

#[test]
fn operation_error_classifies_non_timeout_as_guest() {
    let err = FirecrackerSandbox::operation_error(
        SandboxOperation::Exec,
        io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
        false,
    );

    assert_operation_error(err, SandboxOperation::Exec, SandboxOperationReason::Guest);
}

#[test]
fn invalid_exec_env_key_returns_operation_error() {
    let err =
        FirecrackerSandbox::validate_exec_env_keys(SandboxOperation::Exec, &[("BAD-NAME", "x")])
            .unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::Exec);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("BAD-NAME"), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[test]
fn invalid_start_process_env_key_returns_operation_error() {
    let err = FirecrackerSandbox::validate_exec_env_keys(
        SandboxOperation::StartProcess,
        &[("1BAD", "x")],
    )
    .unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::StartProcess);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("1BAD"), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[test]
fn operation_error_preserves_file_operation_context_for_guest_failures() {
    for operation in [SandboxOperation::ReadFile, SandboxOperation::CopyFile] {
        let timeout = FirecrackerSandbox::operation_error(
            operation,
            io::Error::new(io::ErrorKind::TimedOut, "operation timed out"),
            false,
        );
        let guest = FirecrackerSandbox::operation_error(
            operation,
            io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
            false,
        );

        assert_operation_error(timeout, operation, SandboxOperationReason::Timeout);
        assert_operation_error(guest, operation, SandboxOperationReason::Guest);
    }
}

#[test]
fn process_timeout_policy_maps_zero_to_none_and_millis_to_duration() {
    assert_eq!(process_timeout_policy(0), ExecTimeoutPolicy::None);
    assert_eq!(
        process_timeout_policy(2500),
        ExecTimeoutPolicy::Duration { timeout_ms: 2500 }
    );
    assert_eq!(
        process_timeout_policy(u32::MAX),
        ExecTimeoutPolicy::Duration {
            timeout_ms: u32::MAX
        }
    );
}

#[test]
fn process_output_stream_maps_to_supervised_stdout_only() {
    let output = ProcessOutputMode::Stream {
        stream_limit_bytes: 123,
        chunk_limit_bytes: 45,
        queue_capacity: 7,
        stderr_capture_limit_bytes: None,
    };

    assert_eq!(
        process_stdout_policy(output),
        ExecOutputPolicy::Stream {
            limit_bytes: 123,
            chunk_limit_bytes: 45,
        }
    );
    assert_eq!(process_stderr_policy(output), ExecOutputPolicy::Discard);
    assert_eq!(process_stream_queue_capacity(output), Some(7));
}

#[test]
fn process_output_stream_can_capture_stderr() {
    let output = ProcessOutputMode::Stream {
        stream_limit_bytes: 123,
        chunk_limit_bytes: 45,
        queue_capacity: 7,
        stderr_capture_limit_bytes: Some(4096),
    };

    assert_eq!(
        process_stderr_policy(output),
        ExecOutputPolicy::Capture { limit_bytes: 4096 }
    );
}

#[test]
fn process_output_buffered_maps_to_bounded_capture() {
    let output = ProcessOutputMode::buffered(sandbox::ExecOutputLimits::separate(11, 13));

    assert_eq!(
        process_stdout_policy(output),
        ExecOutputPolicy::Capture { limit_bytes: 11 }
    );
    assert_eq!(
        process_stderr_policy(output),
        ExecOutputPolicy::Capture { limit_bytes: 13 }
    );
    assert_eq!(process_stream_queue_capacity(output), None);
}

#[test]
fn exec_result_from_operation_result_preserves_terminal_metadata() {
    let result = exec_result_from_operation_result(vsock_host::ExecOperationResult {
        termination: vsock_proto::ExecTermination::Exited { exit_code: 7 },
        duration_ms: 10,
        stdout: ExecOwnedCapturedOutput::Captured {
            bytes: b"out".to_vec(),
            truncated: true,
        },
        stderr: ExecOwnedCapturedOutput::Captured {
            bytes: b"err".to_vec(),
            truncated: false,
        },
        diagnostic: "ignored on ordinary exit".to_string(),
        stream_overflowed: false,
    })
    .expect("bounded exec result should convert");

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert_eq!(result.diagnostic, "ignored on ordinary exit");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
}

#[test]
fn exec_result_from_operation_result_maps_terminal_edge_states() {
    for (termination, diagnostic, input_stderr, expected_termination) in [
        (
            vsock_proto::ExecTermination::TimedOut,
            "",
            Vec::new(),
            ExecTermination::TimedOut,
        ),
        (
            vsock_proto::ExecTermination::Cancelled,
            "cancel diagnostic",
            Vec::new(),
            ExecTermination::Cancelled,
        ),
        (
            vsock_proto::ExecTermination::StartFailed,
            "spawn failed",
            Vec::new(),
            ExecTermination::StartFailed,
        ),
        (
            vsock_proto::ExecTermination::WaitFailed,
            "wait failed",
            b"stderr clue".to_vec(),
            ExecTermination::WaitFailed,
        ),
    ] {
        let result = exec_result_from_operation_result(vsock_host::ExecOperationResult {
            termination,
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: input_stderr.clone(),
                truncated: false,
            },
            diagnostic: diagnostic.to_string(),
            stream_overflowed: false,
        })
        .expect("bounded exec result should convert");

        assert_eq!(result.termination, expected_termination);
        assert_eq!(result.stderr, input_stderr);
        assert_eq!(result.diagnostic, diagnostic);
    }
}

#[test]
fn exec_result_from_operation_result_rejects_invalid_capture_state() {
    let overflow = match exec_result_from_operation_result(vsock_host::ExecOperationResult {
        termination: vsock_proto::ExecTermination::Exited { exit_code: 0 },
        duration_ms: 10,
        stdout: ExecOwnedCapturedOutput::Captured {
            bytes: Vec::new(),
            truncated: false,
        },
        stderr: ExecOwnedCapturedOutput::Captured {
            bytes: Vec::new(),
            truncated: false,
        },
        diagnostic: String::new(),
        stream_overflowed: true,
    }) {
        Ok(_) => panic!("bounded capture should reject stream overflow"),
        Err(error) => error,
    };
    assert_eq!(overflow.kind(), io::ErrorKind::InvalidData);
    assert!(overflow.to_string().contains("overflowed a stream queue"));

    let stdout_discarded =
        match exec_result_from_operation_result(vsock_host::ExecOperationResult {
            termination: vsock_proto::ExecTermination::Exited { exit_code: 0 },
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Discarded,
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            diagnostic: String::new(),
            stream_overflowed: false,
        }) {
            Ok(_) => panic!("bounded capture should reject discarded stdout"),
            Err(error) => error,
        };
    assert_eq!(stdout_discarded.kind(), io::ErrorKind::InvalidData);
    assert!(stdout_discarded.to_string().contains("discarded stdout"));

    let stderr_discarded =
        match exec_result_from_operation_result(vsock_host::ExecOperationResult {
            termination: vsock_proto::ExecTermination::Exited { exit_code: 0 },
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: ExecOwnedCapturedOutput::Discarded,
            diagnostic: String::new(),
            stream_overflowed: false,
        }) {
            Ok(_) => panic!("bounded capture should reject discarded stderr"),
            Err(error) => error,
        };
    assert_eq!(stderr_discarded.kind(), io::ErrorKind::InvalidData);
    assert!(stderr_discarded.to_string().contains("discarded stderr"));
}

#[test]
fn supervised_exec_result_to_process_exit_preserves_terminal_metadata() {
    let exit = supervised_exec_result_to_process_exit(
        42,
        vsock_host::ExecOperationResult {
            termination: vsock_proto::ExecTermination::WaitFailed,
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: b"out".to_vec(),
                truncated: true,
            },
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: b"err".to_vec(),
                truncated: false,
            },
            diagnostic: "wait failed".to_string(),
            stream_overflowed: true,
        },
    );

    assert_eq!(exit.guest_pid, 42);
    assert_eq!(exit.termination, ExecTermination::WaitFailed);
    assert_eq!(exit.stdout, b"out");
    assert_eq!(exit.stderr, b"err");
    assert!(exit.stdout_truncated);
    assert!(!exit.stderr_truncated);
    assert_eq!(exit.diagnostic, "wait failed");
    assert!(exit.stream_overflowed);
}

#[test]
fn supervised_exec_result_to_process_exit_maps_terminal_edge_states() {
    for (termination, diagnostic, expected_termination) in [
        (
            vsock_proto::ExecTermination::TimedOut,
            "",
            ExecTermination::TimedOut,
        ),
        (
            vsock_proto::ExecTermination::Cancelled,
            "cancel diagnostic",
            ExecTermination::Cancelled,
        ),
        (
            vsock_proto::ExecTermination::StartFailed,
            "spawn failed",
            ExecTermination::StartFailed,
        ),
        (
            vsock_proto::ExecTermination::WaitFailed,
            "wait failed",
            ExecTermination::WaitFailed,
        ),
    ] {
        let exit = supervised_exec_result_to_process_exit(
            42,
            vsock_host::ExecOperationResult {
                termination,
                duration_ms: 10,
                stdout: ExecOwnedCapturedOutput::Discarded,
                stderr: ExecOwnedCapturedOutput::Captured {
                    bytes: Vec::new(),
                    truncated: false,
                },
                diagnostic: diagnostic.to_string(),
                stream_overflowed: false,
            },
        );

        assert_eq!(exit.termination, expected_termination);
        assert_eq!(exit.guest_duration_ms, Some(10));
        assert_eq!(exit.stderr, Vec::<u8>::new());
        assert_eq!(exit.diagnostic, diagnostic);
    }
}

#[tokio::test]
async fn supervised_stdout_receiver_forwards_only_stdout_output() {
    let (stream_tx, stream_rx) = mpsc::channel(4);
    let (mut stdout_rx, _close) = supervised_stdout_receiver(stream_rx, 2);

    stream_tx
        .send(ExecOutputEvent {
            stream: ExecOutputStream::Stderr,
            output_seq: 1,
            chunk: b"stderr".to_vec(),
            truncated: false,
        })
        .await
        .unwrap();
    stream_tx
        .send(ExecOutputEvent {
            stream: ExecOutputStream::Stdout,
            output_seq: 2,
            chunk: b"stdout".to_vec(),
            truncated: true,
        })
        .await
        .unwrap();
    drop(stream_tx);

    let chunk = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
        .await
        .expect("stdout chunk was not forwarded")
        .expect("stdout stream closed before forwarded chunk");
    assert_eq!(chunk.bytes, b"stdout");
    assert!(chunk.truncated);
    assert!(stdout_rx.recv().await.is_none());
}

#[tokio::test]
async fn supervised_stdout_receiver_cleanup_closes_unclaimed_adapter() {
    let (_stream_tx, stream_rx) = mpsc::channel(1);
    let (mut stdout_rx, close) = supervised_stdout_receiver(stream_rx, 1);

    close();

    let received = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
        .await
        .expect("stdout adapter did not close");
    assert!(received.is_none());
}

#[tokio::test]
async fn supervised_stdout_receiver_cleanup_interrupts_blocked_forwarder() {
    let (stream_tx, stream_rx) = mpsc::channel(1);
    let (mut stdout_rx, close) = supervised_stdout_receiver(stream_rx, 1);

    stream_tx
        .send(ExecOutputEvent {
            stream: ExecOutputStream::Stdout,
            output_seq: 1,
            chunk: b"first".to_vec(),
            truncated: false,
        })
        .await
        .unwrap();

    tokio::time::timeout(
        Duration::from_secs(1),
        stream_tx.send(ExecOutputEvent {
            stream: ExecOutputStream::Stdout,
            output_seq: 2,
            chunk: b"second".to_vec(),
            truncated: false,
        }),
    )
    .await
    .expect("second stdout event was not accepted")
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        stream_tx.send(ExecOutputEvent {
            stream: ExecOutputStream::Stdout,
            output_seq: 3,
            chunk: b"third".to_vec(),
            truncated: false,
        }),
    )
    .await
    .expect("third stdout event was not accepted")
    .unwrap();

    close();

    let first = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
        .await
        .expect("first stdout chunk was not received")
        .expect("stdout stream closed before first chunk");
    assert_eq!(first.bytes, b"first");

    let closed = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
        .await
        .expect("stdout adapter did not close after cleanup");
    assert!(closed.is_none());
}

#[tokio::test]
async fn supervised_stdout_receiver_dropping_cleanup_handle_does_not_close_claimed_stream() {
    let (stream_tx, stream_rx) = mpsc::channel(4);
    let (mut stdout_rx, close) = supervised_stdout_receiver(stream_rx, 2);

    stream_tx
        .send(ExecOutputEvent {
            stream: ExecOutputStream::Stdout,
            output_seq: 1,
            chunk: b"before".to_vec(),
            truncated: false,
        })
        .await
        .unwrap();

    drop(close);

    stream_tx
        .send(ExecOutputEvent {
            stream: ExecOutputStream::Stdout,
            output_seq: 2,
            chunk: b"after".to_vec(),
            truncated: false,
        })
        .await
        .unwrap();
    drop(stream_tx);

    let first = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
        .await
        .expect("first stdout chunk was not forwarded")
        .expect("stdout stream closed before first chunk");
    let second = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
        .await
        .expect("second stdout chunk was not forwarded")
        .expect("stdout stream closed before second chunk");

    assert_eq!(first.bytes, b"before");
    assert_eq!(second.bytes, b"after");
    assert!(stdout_rx.recv().await.is_none());
}

#[tokio::test]
async fn supervised_stdout_receiver_dropping_output_receiver_stops_adapter() {
    let (stream_tx, stream_rx) = mpsc::channel(1);
    let (stdout_rx, close) = supervised_stdout_receiver(stream_rx, 1);

    drop(close);
    drop(stdout_rx);

    tokio::time::timeout(Duration::from_secs(1), stream_tx.closed())
        .await
        .expect("stdout adapter kept the supervised stream receiver alive");
}

#[test]
fn operation_error_classifies_observed_backend_crash_for_all_operations() {
    for operation in [
        SandboxOperation::Exec,
        SandboxOperation::ReadFile,
        SandboxOperation::CopyFile,
        SandboxOperation::WriteFile,
        SandboxOperation::StartProcess,
        SandboxOperation::ProcessControl,
        SandboxOperation::WaitProcess,
    ] {
        let err = FirecrackerSandbox::operation_error(
            operation,
            io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
            true,
        );

        assert_operation_error(err, operation, SandboxOperationReason::BackendCrashed);
    }
}

#[test]
fn unavailable_guest_classifies_observed_backend_crash_for_all_operations() {
    for operation in [
        SandboxOperation::Exec,
        SandboxOperation::ReadFile,
        SandboxOperation::CopyFile,
        SandboxOperation::WriteFile,
        SandboxOperation::StartProcess,
        SandboxOperation::ProcessControl,
        SandboxOperation::WaitProcess,
    ] {
        let err = FirecrackerSandbox::operation_unavailable_error(operation, SandboxState::Crashed);

        assert_operation_error(err, operation, SandboxOperationReason::BackendCrashed);
    }
}

#[test]
fn unavailable_guest_preserves_file_operation_context_for_non_crashed_states() {
    for operation in [SandboxOperation::ReadFile, SandboxOperation::CopyFile] {
        for (state, expected_state) in [
            (SandboxState::Created, "created"),
            (SandboxState::Running, "running"),
            (SandboxState::Stopping, "stopping"),
            (SandboxState::Stopped, "stopped"),
        ] {
            let err = FirecrackerSandbox::operation_unavailable_error(operation, state);

            assert_invalid_state_operation(err, operation, expected_state);
        }
    }
}

#[test]
fn operation_gate_closed_preserves_file_operation_context() {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator
        .begin_prepare_park()
        .expect("begin prepare park");
    let gate_state = coordinator.state();

    for operation in [SandboxOperation::ReadFile, SandboxOperation::CopyFile] {
        let err = FirecrackerSandbox::operation_gate_closed_error(operation, gate_state.clone());

        assert_invalid_state_operation(
            err,
            operation,
            "ClosingForPark { attempt_id: ParkAttemptId(1) }",
        );
    }
    coordinator
        .abort_prepare_park(&attempt)
        .expect("abort prepare park");
}

#[tokio::test]
async fn file_operation_entrypoints_preserve_operation_context_for_start_rejections() {
    for (state, expected_state) in [
        (SandboxState::Created, "created"),
        (SandboxState::Running, "running"),
    ] {
        let sandbox = test_sandbox_with_state(state);

        assert_file_entrypoints_invalid_state(&sandbox, expected_state).await;
    }

    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let attempt = sandbox
        .park_coordinator
        .begin_prepare_park()
        .expect("begin prepare park");

    assert_file_entrypoints_invalid_state(
        &sandbox,
        "ClosingForPark { attempt_id: ParkAttemptId(1) }",
    )
    .await;

    sandbox
        .park_coordinator
        .abort_prepare_park(&attempt)
        .expect("abort prepare park");
}

#[tokio::test]
async fn process_control_rejects_closed_policy_gate_without_dirtying() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator
        .begin_prepare_park()
        .expect("begin prepare park");
    let (state, state_tx) = running_process_state();

    let error = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "gate-closed".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    )
    .await
    .unwrap_err();

    assert!(
        error.to_string().contains("sandbox operation gate closed"),
        "unexpected error: {error}",
    );
    coordinator.abort_prepare_park(&attempt).unwrap();
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_rejects_stopped_state_without_dirtying() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = process_state(SandboxState::Stopped);

    let error = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "stopped".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    )
    .await
    .unwrap_err();

    assert!(
        error.to_string().contains("sandbox not running"),
        "unexpected error: {error}",
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_local_validation_failure_keeps_gate_clean() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();
    let too_large = vec![0; vsock_proto::EXEC_CONTROL_MAX_PAYLOAD_BYTES + 1];

    let error = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        Arc::clone(&state),
        state_tx.subscribe(),
        control.clone(),
        "too-large".to_owned(),
        too_large,
        Duration::from_secs(5),
    )
    .await
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "valid-after-local-failure".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_exec_control_result(&mut guest, request, ExecControlStatus::Delivered, "").await;

    let ack = control_task.await.unwrap().unwrap();
    assert_eq!(ack.message_id, "valid-after-local-failure");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_guest_status_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "sink-timeout".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        request,
        ExecControlStatus::SinkTimeout,
        "guest sink timed out",
    )
    .await;

    let error = control_task.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "guest sink timed out");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_guest_error_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "guest-error".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_exec_control_error(&mut guest, request, "guest rejected control").await;

    let error = control_task.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(error.to_string(), "guest rejected control");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_allows_concurrent_requests_while_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let first_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        Arc::clone(&state),
        state_tx.subscribe(),
        control.clone(),
        "concurrent-a".to_owned(),
        b"payload-a".to_vec(),
        Duration::from_secs(5),
    ));
    let second_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "concurrent-b".to_owned(),
        b"payload-b".to_vec(),
        Duration::from_secs(5),
    ));

    let first_request = read_vsock_message(&mut guest).await;
    let second_request = read_vsock_message(&mut guest).await;
    let mut message_ids = [
        vsock_proto::decode_exec_control(&first_request.payload)
            .unwrap()
            .message_id
            .to_owned(),
        vsock_proto::decode_exec_control(&second_request.payload)
            .unwrap()
            .message_id
            .to_owned(),
    ];
    message_ids.sort();
    assert_eq!(message_ids, ["concurrent-a", "concurrent-b"]);

    send_exec_control_result(&mut guest, second_request, ExecControlStatus::Delivered, "").await;
    send_exec_control_result(&mut guest, first_request, ExecControlStatus::Delivered, "").await;

    let first_ack = first_task.await.unwrap().unwrap();
    let second_ack = second_task.await.unwrap().unwrap();
    assert_eq!(first_ack.message_id, "concurrent-a");
    assert_eq!(second_ack.message_id, "concurrent-b");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_protocol_poison_after_guest_write_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq: _,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "malformed-result".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_mismatched_exec_control_result(&mut guest, request).await;

    let error = control_task.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[tokio::test]
async fn process_control_backend_crash_after_guest_write_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        Arc::clone(&state),
        state_tx.subscribe(),
        control,
        "backend-crash".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);

    state.store(SandboxState::Crashed as u8, Ordering::Release);
    state_tx.send(SandboxState::Crashed).unwrap();

    let error = tokio::time::timeout(Duration::from_secs(1), control_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("firecracker process crashed"),
        "unexpected error: {error}",
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_timeout_after_guest_write_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "timeout-after-write".to_owned(),
        b"payload".to_vec(),
        Duration::ZERO,
    ));
    let request = read_vsock_message(&mut guest).await;
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);

    let error = tokio::time::timeout(Duration::from_secs(1), control_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

/// Exercise the `monitor_process` crash detection flow through real child
/// exit. A running process exit should mark the sandbox crashed and wake
/// current subscribers.
#[tokio::test]
async fn process_monitor_reports_unexpected_exit() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let runtime_cancel = CancellationToken::new();
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        Arc::clone(&guest),
        runtime_cancel.clone(),
    );

    drop(stdin);

    tokio::time::timeout(Duration::from_secs(1), runtime_cancel.cancelled())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), wait_for_backend_crash(state_rx))
        .await
        .unwrap();
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );

    handle.wait().await;
}

#[tokio::test]
async fn process_monitor_cancels_control_server_after_exit() {
    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("control.sock");
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let runtime_cancel = CancellationToken::new();
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        Arc::clone(&guest),
        runtime_cancel.clone(),
    );
    let mut control = crate::control::bind_server(
        sock_path.clone(),
        GuestOperationStartGate::new(Arc::clone(&guest), ParkCoordinator::new()),
        handle.termination_handle(ParkCoordinator::new()),
    )
    .unwrap()
    .spawn(runtime_cancel.clone());

    drop(stdin);
    wait_for_path_removed(&sock_path).await;

    handle.wait().await;
    control.shutdown().await;
}

#[tokio::test]
async fn process_monitor_drains_log_readers_after_exit() {
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let child = stdout_stderr_writing_process();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        CancellationToken::new(),
    );

    tokio::time::timeout(Duration::from_secs(1), handle.wait())
        .await
        .expect("process monitor should drain completed log readers");
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );
}

#[tokio::test]
async fn process_monitor_aborts_stuck_log_reader_after_exit() {
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = monitored_cat_process_without_log_pipes();
    let stdin = child.stdin.take();
    let (stdout_reader, stdout_started_rx, stdout_dropped_rx) = pending_log_reader_for_test();
    let (stderr_reader, stderr_started_rx, stderr_dropped_rx) = pending_log_reader_for_test();
    let readers = ProcessLogReaders::new_for_test(Some(stdout_reader), Some(stderr_reader));

    tokio::time::timeout(Duration::from_secs(1), stdout_started_rx)
        .await
        .expect("pending stdout reader should start")
        .expect("pending stdout reader started sender should stay alive");
    tokio::time::timeout(Duration::from_secs(1), stderr_started_rx)
        .await
        .expect("pending stderr reader should start")
        .expect("pending stderr reader started sender should stay alive");
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
    };
    let handle = monitor_process_with_log_readers("test-sandbox", child, context, readers);

    drop(stdin);

    tokio::time::timeout(Duration::from_secs(1), handle.wait())
        .await
        .expect("process monitor should not hang on stuck log reader");
    tokio::time::timeout(Duration::from_secs(1), stdout_dropped_rx)
        .await
        .expect("stuck stdout log reader should be aborted")
        .expect("stuck stdout log reader drop notification should be sent");
    tokio::time::timeout(Duration::from_secs(1), stderr_dropped_rx)
        .await
        .expect("stuck stderr log reader should be aborted")
        .expect("stuck stderr log reader drop notification should be sent");
}

#[tokio::test]
async fn process_monitor_wait_cancel_keeps_log_reader_cleanup_owned() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = monitored_cat_process_without_log_pipes();
    let stdin = child.stdin.take();
    let (reader, started_rx, dropped_rx) = pending_log_reader_for_test();
    let readers = ProcessLogReaders::new_for_test(Some(reader), None);

    tokio::time::timeout(Duration::from_secs(1), started_rx)
        .await
        .expect("pending reader should start")
        .expect("pending reader started sender should stay alive");
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
    };
    let handle = monitor_process_with_log_readers("test-sandbox", child, context, readers);

    let waiter = tokio::spawn(async move {
        handle.wait().await;
    });
    tokio::task::yield_now().await;
    waiter.abort();
    let _ = waiter.await;

    drop(stdin);

    tokio::time::timeout(Duration::from_secs(1), dropped_rx)
        .await
        .expect("detached monitor should still cleanup owned log reader")
        .expect("pending reader drop notification should be sent");
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
}

/// The lifecycle stream stores the latest state, so late subscribers still
/// classify an already-observed backend crash deterministically.
#[tokio::test]
async fn backend_crash_state_is_visible_to_late_subscribers() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx.clone(),
        guest,
        CancellationToken::new(),
    );

    drop(stdin);
    wait_for_state(&state, SandboxState::Crashed).await;

    tokio::time::timeout(
        Duration::from_millis(50),
        wait_for_backend_crash(state_tx.subscribe()),
    )
    .await
    .unwrap();

    handle.wait().await;
}

/// When the process is stopped gracefully (state transitions to Stopping
/// before process exit), `monitor_process` records Stopped without marking
/// the backend crashed.
#[tokio::test]
async fn process_monitor_records_graceful_stop_without_crash() {
    let state = Arc::new(AtomicU8::new(SandboxState::Stopping as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Stopping);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx.clone(),
        guest,
        CancellationToken::new(),
    );

    drop(stdin);
    let exit_state = tokio::time::timeout(
        Duration::from_secs(1),
        wait_for_process_exit(state_tx.subscribe()),
    )
    .await
    .unwrap();
    assert_eq!(exit_state, SandboxState::Stopped);
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );

    handle.wait().await;
}

#[tokio::test]
async fn process_monitor_reports_startup_exit_as_stopped() {
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx.clone(),
        guest,
        CancellationToken::new(),
    );

    drop(stdin);
    let exit_state = tokio::time::timeout(
        Duration::from_secs(1),
        wait_for_process_exit(state_tx.subscribe()),
    )
    .await
    .unwrap();
    assert_eq!(exit_state, SandboxState::Stopped);
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );

    handle.wait().await;
}

#[derive(Default)]
struct RecordingSandboxStartObserver {
    records: Vec<(SandboxStartStage, bool)>,
}

impl SandboxStartObserver for RecordingSandboxStartObserver {
    fn record_stage(&mut self, stage: SandboxStartStage, _duration: Duration, success: bool) {
        self.records.push((stage, success));
    }
}

#[tokio::test]
async fn start_with_observer_reports_backend_launch_failure() {
    let workspace = tempfile::tempdir().unwrap();
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    sandbox.sandbox_paths = SandboxPaths::new(workspace.path().join("workspace"));
    sandbox.sock_paths = SockPaths::new(workspace.path().join("sock"));
    let mut observer = RecordingSandboxStartObserver::default();

    let error = sandbox
        .start_with_observer(&mut observer)
        .await
        .unwrap_err();

    let SandboxError::Start { message } = error else {
        panic!("expected startup error");
    };
    assert!(message.contains("COW device missing before sandbox start"));
    assert_eq!(
        observer.records,
        vec![(SandboxStartStage::BackendLaunch, false)]
    );
}

#[tokio::test]
async fn spawn_and_wait_for_api_adopts_process_and_secures_socket() {
    let workspace = tempfile::tempdir().unwrap();
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    sandbox.sandbox_paths = SandboxPaths::new(workspace.path().to_path_buf());

    let mut api = MockFirecrackerApi::repeating(MockResponse::ok());
    std::fs::set_permissions(api.socket_path(), std::fs::Permissions::from_mode(0o666)).unwrap();

    let mut command = tokio::process::Command::new("bash");
    command.args(["-c", "sleep 60"]);

    let _client = sandbox
        .spawn_and_wait_for_api(
            command,
            api.socket_path(),
            CancellationToken::new(),
            "fresh boot",
        )
        .await
        .unwrap();

    let request = api.next_request().await;
    assert_eq!(request.method, "GET", "raw request: {}", request.raw);
    assert_eq!(request.path, "/", "raw request: {}", request.raw);
    assert_eq!(
        std::fs::metadata(api.socket_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let pid = i32::try_from(sandbox.host_process_pid().unwrap()).unwrap();
    let pid = nix::unistd::Pid::from_raw(pid);
    assert!(nix::sys::signal::kill(pid, None).is_ok());

    sandbox.runtime.kill_process().await;

    assert!(nix::sys::signal::kill(pid, None).is_err());
}

#[tokio::test]
async fn spawn_and_wait_for_api_reports_process_exit_before_readiness() {
    let workspace = tempfile::tempdir().unwrap();
    let api_dir = tempfile::tempdir().unwrap();
    let api_sock = api_dir.path().join("missing.sock");
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    sandbox.sandbox_paths = SandboxPaths::new(workspace.path().to_path_buf());

    let mut command = tokio::process::Command::new("bash");
    command.args(["-c", "exit 23"]);

    let result = tokio::time::timeout(
        Duration::from_secs(1),
        sandbox.spawn_and_wait_for_api(
            command,
            &api_sock,
            CancellationToken::new(),
            "snapshot restore",
        ),
    )
    .await
    .expect("process exit should win before API readiness timeout");
    let error = match result {
        Ok(_) => panic!("startup should fail when the child exits"),
        Err(error) => error,
    };
    let SandboxError::Start { message } = error else {
        panic!("expected startup error");
    };
    assert!(
        message.contains("firecracker process exited before API became ready"),
        "got: {message}"
    );
    assert!(
        message.contains("boot_mode=snapshot restore"),
        "got: {message}"
    );
    assert!(message.contains("state=stopped"), "got: {message}");
    assert!(
        message.contains(&format!("api_sock={}", api_sock.display())),
        "got: {message}"
    );
    assert!(sandbox.host_process_pid().is_some());

    sandbox.runtime.kill_process().await;
}

#[tokio::test]
async fn stdout_eof_does_not_mark_running_process_crashed() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = stdout_closing_process();
    let stdout = child.stdout.take().expect("stdout should be piped");
    let stderr = child
        .stderr
        .take()
        .map(|stderr| process_log_reader("test-sandbox", ProcessLogStream::Stderr, stderr));
    let (stdout_reader, stdout_eof_rx) =
        stdout_eof_notifying_log_reader_for_test("test-sandbox", stdout);
    let readers = ProcessLogReaders::new_for_test(Some(stdout_reader), stderr);
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx: state_tx.clone(),
        guest,
        runtime_cancel: CancellationToken::new(),
    };

    let handle = monitor_process_with_log_readers("test-sandbox", child, context, readers);

    tokio::time::timeout(Duration::from_secs(1), stdout_eof_rx)
        .await
        .expect("stdout reader should observe EOF")
        .expect("stdout EOF notification sender should stay alive");
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Running
    );
    assert_eq!(*state_rx.borrow(), SandboxState::Running);

    publish_process_state(
        &state,
        &state_publish_lock,
        &state_tx,
        SandboxState::Stopping,
    );
    handle.kill();
    handle.wait().await;
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );
}

#[tokio::test]
async fn process_monitor_kills_group_after_unexpected_parent_exit() {
    if !ChildExitNotifier::available_for_current_process_for_test() {
        eprintln!("skipping pidfd-dependent process group cleanup test");
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let child = parent_exits_with_child_process(&pid_file);

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        CancellationToken::new(),
    );

    handle.wait().await;

    let leaked_pid: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let child_stopped = wait_for_pid_not_running(leaked_pid).await;
    if !child_stopped {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(leaked_pid).unwrap()),
            nix::sys::signal::Signal::SIGKILL,
        );
    }

    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
    assert!(
        child_stopped,
        "unexpected parent exit should not leave process-group children running"
    );
}

#[tokio::test]
async fn process_monitor_fallback_does_not_kill_group_after_parent_reap() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
    let mut child = parent_exits_with_child_process(&pid_file);
    let readers = ProcessLogReaders::from_child("test-sandbox", &mut child);
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
    };

    let handle = monitor_process_with_log_readers_and_exit_notifier(
        "test-sandbox",
        child,
        context,
        readers,
        ChildExitNotifier::unavailable_for_test(),
    );

    handle.wait().await;

    let leaked_pid: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let child_still_running = pid_is_running(leaked_pid);
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(leaked_pid).unwrap()),
        nix::sys::signal::Signal::SIGKILL,
    );

    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
    assert!(
        child_still_running,
        "pidfd-unavailable fallback must not signal a cached process group after parent reap"
    );
}

/// Verify that `killpg` kills the entire process group spawned with
/// `process_group(0)`.  This is the mechanism the `Drop` impl relies on.
#[tokio::test]
async fn killpg_kills_entire_process_group() {
    // "bash -c 'sleep 60'" creates two processes in the same group:
    //   bash (group leader, PGID = its PID) → sleep (inherits PGID).
    let mut child = tokio::process::Command::new("bash")
        .args(["-c", "sleep 60"])
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let raw_pid = child.id().unwrap();
    let pid = i32::try_from(raw_pid).unwrap();
    let pgid = nix::unistd::Pid::from_raw(pid);

    // killpg should kill both bash and sleep.
    nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL).unwrap();

    // Reap the direct child.
    let status = child.wait().await.unwrap();
    assert!(!status.success(), "process should have been killed");

    // Signal 0 checks existence — should fail with ESRCH.
    let exists = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None);
    assert!(exists.is_err(), "process group leader should be dead");
}

// -- Firecracker API-backed lifecycle tests --
//
// These exercise snapshot restore and `park_inner` / `unpark_inner`
// against a mock Firecracker API socket. We assert on:
//   1. the correct sequence of HTTP requests (method, path, body);
//   2. whether the reactive controller handle is present / absent;
//   3. the is_parked flag state; and
//   4. idempotency on repeat calls.

use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use tokio::net::UnixListener;
use tokio::sync::Mutex as TokioMutex;

/// A captured HTTP request from the mock FC API server.
#[derive(Debug, Clone)]
struct MockRequest {
    method: String,
    path: String,
    body: String,
}

#[derive(Debug, Clone)]
struct MockBalloonStats {
    target_mib: u32,
    actual_mib: u32,
    free_memory: Option<i64>,
    available_memory: Option<i64>,
    total_memory: Option<i64>,
}

impl MockBalloonStats {
    fn new(target_mib: u32, actual_mib: u32) -> Self {
        Self {
            target_mib,
            actual_mib,
            free_memory: None,
            available_memory: None,
            total_memory: None,
        }
    }

    fn with_memory(mut self, free_memory: i64, available_memory: i64, total_memory: i64) -> Self {
        self.free_memory = Some(free_memory);
        self.available_memory = Some(available_memory);
        self.total_memory = Some(total_memory);
        self
    }

    fn to_json(&self) -> String {
        serde_json::json!({
            "target_mib": self.target_mib,
            "actual_mib": self.actual_mib,
            "target_pages": u64::from(self.target_mib) * 256,
            "actual_pages": u64::from(self.actual_mib) * 256,
            "free_memory": self.free_memory,
            "available_memory": self.available_memory,
            "total_memory": self.total_memory,
        })
        .to_string()
    }
}

#[derive(Debug, Clone)]
enum MockBalloonStatsReply {
    Ok(MockBalloonStats),
    DelayedOk(Duration, MockBalloonStats),
    Status(u16),
}

fn mock_balloon_stats_ok_response(stats: &MockBalloonStats) -> String {
    let body = stats.to_json();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn mock_balloon_stats_status_response(status: u16) -> String {
    let body = r#"{"fault_message":"test"}"#;
    format!(
        "HTTP/1.1 {status} Bad Request\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[derive(Debug)]
struct MockBalloonStatsSequence {
    replies: std::collections::VecDeque<MockBalloonStatsReply>,
    last: MockBalloonStatsReply,
}

impl MockBalloonStatsSequence {
    fn new(replies: std::collections::VecDeque<MockBalloonStatsReply>) -> Self {
        let last = replies
            .back()
            .cloned()
            .unwrap_or_else(|| MockBalloonStatsReply::Ok(MockBalloonStats::new(0, 99999)));
        Self { replies, last }
    }

    fn next(&mut self) -> MockBalloonStatsReply {
        if let Some(reply) = self.replies.pop_front() {
            self.last = reply.clone();
            reply
        } else {
            self.last.clone()
        }
    }
}

#[derive(Clone)]
enum MockBalloonStatsSource {
    DynamicActual(Option<Arc<AtomicU32>>),
    Sequence(Arc<TokioMutex<MockBalloonStatsSequence>>),
}

impl MockBalloonStatsSource {
    async fn next(&self) -> MockBalloonStatsReply {
        match self {
            Self::DynamicActual(balloon_actual) => {
                let actual_mib = balloon_actual
                    .as_ref()
                    .map_or(99999, |actual| actual.load(Ordering::Relaxed));
                MockBalloonStatsReply::Ok(MockBalloonStats::new(0, actual_mib))
            }
            Self::Sequence(sequence) => sequence.lock().await.next(),
        }
    }
}

/// Spawn a mock FC API server on a temporary Unix socket.
///
/// - PATCH requests: status consumed FIFO from `responses` (defaults to
///   204 once empty). All requests are captured into the returned list.
/// - GET /balloon/statistics: returns a 200 JSON response with
///   `actual_mib` read from `balloon_actual` (or a large value if None,
///   so `wait_for_balloon` returns immediately in most tests).
///
/// Returns (sock_path, requests_handle, tempdir) — keep the tempdir
/// alive until the test finishes.
async fn spawn_mock_fc_api(
    responses: std::collections::VecDeque<u16>,
    balloon_actual: Option<Arc<AtomicU32>>,
) -> (
    PathBuf,
    Arc<TokioMutex<Vec<MockRequest>>>,
    tempfile::TempDir,
) {
    spawn_mock_fc_api_with_stats_source(
        responses,
        MockBalloonStatsSource::DynamicActual(balloon_actual),
    )
    .await
}

async fn spawn_mock_fc_api_with_stats(
    responses: std::collections::VecDeque<u16>,
    balloon_stats: std::collections::VecDeque<MockBalloonStatsReply>,
) -> (
    PathBuf,
    Arc<TokioMutex<Vec<MockRequest>>>,
    tempfile::TempDir,
) {
    spawn_mock_fc_api_with_stats_source(
        responses,
        MockBalloonStatsSource::Sequence(Arc::new(TokioMutex::new(MockBalloonStatsSequence::new(
            balloon_stats,
        )))),
    )
    .await
}

async fn spawn_mock_fc_api_with_stats_source(
    responses: std::collections::VecDeque<u16>,
    balloon_stats_source: MockBalloonStatsSource,
) -> (
    PathBuf,
    Arc<TokioMutex<Vec<MockRequest>>>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
    let sock_path = dir.path().join("api.sock");
    let listener = UnixListener::bind(&sock_path)
        .unwrap_or_else(|e| panic!("bind {}: {e}", sock_path.display()));

    let requests: Arc<TokioMutex<Vec<MockRequest>>> = Arc::new(TokioMutex::new(Vec::new()));
    let requests_clone = Arc::clone(&requests);

    // Wrap the response queue in a mutex so per-connection tasks can
    // pop from it without moving the entire VecDeque into the closure.
    let responses = Arc::new(TokioMutex::new(responses));
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let reqs_inner = Arc::clone(&requests_clone);
            let responses = Arc::clone(&responses);
            let balloon_stats_source = balloon_stats_source.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let raw = String::from_utf8_lossy(&buf[..n]);

                // Parse request line: "METHOD /path HTTP/1.1"
                let first_line = raw.lines().next().unwrap_or("");
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();

                let body = raw
                    .find("\r\n\r\n")
                    .map(|pos| raw[pos + 4..].to_string())
                    .unwrap_or_default();

                reqs_inner.lock().await.push(MockRequest {
                    method: method.clone(),
                    path: path.clone(),
                    body,
                });

                // Route response by method + path.
                // GET /balloon/statistics: always 200 with configurable stats.
                // PATCH: consume next entry from the FIFO response queue.
                // Other methods: 204 (no queue consumption).
                if method == "GET" && path == "/balloon/statistics" {
                    let reply = balloon_stats_source.next().await;
                    let resp = match reply {
                        MockBalloonStatsReply::Ok(stats) => mock_balloon_stats_ok_response(&stats),
                        MockBalloonStatsReply::DelayedOk(delay, stats) => {
                            tokio::time::sleep(delay).await;
                            mock_balloon_stats_ok_response(&stats)
                        }
                        MockBalloonStatsReply::Status(status) => {
                            mock_balloon_stats_status_response(status)
                        }
                    };
                    let _ = stream.write_all(resp.as_bytes()).await;
                } else if method == "PATCH" {
                    let status = responses.lock().await.pop_front().unwrap_or(204);
                    let (reason, resp_body) = if status == 204 {
                        ("No Content", String::new())
                    } else {
                        ("Bad Request", r#"{"fault_message":"test"}"#.to_string())
                    };
                    let resp = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                } else {
                    // Unknown method — return 204 without consuming the queue.
                    let resp = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
                    let _ = stream.write_all(resp.as_bytes()).await;
                }
            });
        }
    });

    (sock_path, requests, dir)
}

/// Filter captured requests to only PATCH requests (ignoring GET stats
/// polls from `wait_for_balloon` and the reactive balloon controller).
fn patches(reqs: &[MockRequest]) -> Vec<&MockRequest> {
    reqs.iter().filter(|r| r.method == "PATCH").collect()
}

fn mock_request_body_json(request: &MockRequest) -> serde_json::Value {
    serde_json::from_str(&request.body)
        .unwrap_or_else(|error| panic!("invalid JSON body: {error}; request: {request:?}"))
}

async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
}

fn captured_event_field<'a>(event: &'a CapturedEvent, field: &str) -> &'a str {
    event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"))
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = captured_event_field(event, field);
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}

#[test]
fn exec_capture_request_preserves_stable_operation_label() {
    let stdin = [1, 2, 3];
    let request = ExecRequest {
        cmd: "echo hello",
        timeout: Duration::from_millis(42),
        env: &[("TEST_ENV", "value")],
        sudo: true,
        expected_exit_codes: &[10],
        stdin_bytes: Some(&stdin),
        output_limits: sandbox::ExecOutputLimits::separate(123, 456),
    };

    let capture = exec_capture_request(&request, 42, "storage-download");

    assert_eq!(capture.command, "echo hello");
    assert_eq!(capture.label, "storage-download");
    assert_eq!(capture.timeout_ms, 42);
    assert_eq!(capture.env, &[("TEST_ENV", "value")]);
    assert!(capture.sudo);
    assert_eq!(capture.stdin_bytes, Some(stdin.as_slice()));
    assert_eq!(capture.stdout_limit_bytes, 123);
    assert_eq!(capture.stderr_limit_bytes, 456);
    assert_eq!(capture.expected_exit_codes, &[10]);
    assert_eq!(capture.wait_timeout, Duration::from_millis(5042));
}

fn has_captured_event(events: &[CapturedEvent], message: &str) -> bool {
    events.iter().any(|event| {
        event
            .fields
            .get("message")
            .is_some_and(|actual| actual == message)
    })
}

fn assert_shutdown_failure_event<'a>(
    events: &'a [CapturedEvent],
    sandbox_id: &str,
    failure_kind: &str,
) -> &'a CapturedEvent {
    let event = captured_event(events, "graceful shutdown failed");
    assert_event_field(event, "sandbox_id", sandbox_id);
    assert_event_field(event, "timeout_ms", "5000");
    assert_event_field(event, "failure_kind", failure_kind);
    captured_event_field(event, "elapsed_ms")
        .parse::<u64>()
        .unwrap_or_else(|error| panic!("invalid elapsed_ms; error={error}; event={event:#?}"));
    event
}

#[tokio::test]
async fn stop_with_shutdown_ack_is_quiet() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        assert!(shutdown.payload.is_empty());
        let response = vsock_proto::encode(MSG_SHUTDOWN_ACK, shutdown.seq, &[]).unwrap();
        guest.write_all(&response).await.unwrap();
    });

    let (result, events) = capture_async_log_events(sandbox.stop()).await;

    result.unwrap();
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    assert!(!has_captured_event(&events, "graceful shutdown failed"));
}

#[tokio::test]
async fn stop_logs_shutdown_timeout_and_reaches_stopped() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let sandbox_id = sandbox.id.clone();
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let (shutdown_seen_tx, shutdown_seen_rx) = tokio::sync::oneshot::channel();
    let (release_guest_tx, release_guest_rx) = tokio::sync::oneshot::channel();
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        shutdown_seen_tx.send(()).unwrap();
        let _ = release_guest_rx.await;
    });

    let (result, events) = capture_async_log_events(async {
        let stop = sandbox.stop();
        tokio::pin!(stop);
        tokio::select! {
            result = &mut stop => panic!("stop completed before timeout: {result:?}"),
            seen = shutdown_seen_rx => seen.unwrap(),
        }
        tokio::time::pause();
        tokio::time::advance(SHUTDOWN_TIMEOUT).await;
        stop.await
    })
    .await;

    result.unwrap();
    let _ = release_guest_tx.send(());
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    let event = assert_shutdown_failure_event(&events, &sandbox_id, "timeout");
    let elapsed_ms = captured_event_field(event, "elapsed_ms")
        .parse::<u64>()
        .unwrap();
    assert!(
        elapsed_ms >= duration_ms(SHUTDOWN_TIMEOUT),
        "shutdown timeout elapsed too early; event={event:#?}"
    );
    assert_event_field(event, "error", "request timeout");
}

#[tokio::test]
async fn stop_logs_shutdown_request_failure_and_reaches_stopped() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let sandbox_id = sandbox.id.clone();
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        drop(guest);
    });

    let (result, events) = capture_async_log_events(sandbox.stop()).await;

    result.unwrap();
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    let event = assert_shutdown_failure_event(&events, &sandbox_id, "request_failure");
    assert_event_field(event, "error", "connection closed");
}

#[tokio::test]
async fn stop_logs_unexpected_shutdown_response_and_kills_process() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let sandbox_id = sandbox.id.clone();
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let child = tokio::process::Command::new("cat")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let child_pid = child.id().unwrap();
    let process = monitor_process(
        &sandbox.id,
        child,
        Arc::clone(&sandbox.state),
        Arc::clone(&sandbox.state_publish_lock),
        sandbox.state_tx.clone(),
        Arc::clone(&sandbox.guest),
        CancellationToken::new(),
    );
    sandbox.runtime.set_process(process);
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        let response = vsock_proto::encode(MSG_PONG, shutdown.seq, &[]).unwrap();
        guest.write_all(&response).await.unwrap();
    });

    let (result, events) = capture_async_log_events(sandbox.stop()).await;

    result.unwrap();
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    assert!(!pid_is_running(child_pid), "fallback must kill the process");
    let event = assert_shutdown_failure_event(&events, &sandbox_id, "unexpected_response");
    assert!(
        captured_event_field(event, "error").contains("unexpected lifecycle response type"),
        "unexpected shutdown error; event={event:#?}"
    );
}

fn mib(value: i64) -> i64 {
    value * BYTES_PER_MIB
}

fn balloon_statistics(target_mib: u32, actual_mib: u32) -> BalloonStatistics {
    BalloonStatistics {
        target_mib,
        actual_mib,
        target_pages: u64::from(target_mib) * 256,
        actual_pages: u64::from(actual_mib) * 256,
        free_memory: None,
        available_memory: None,
        total_memory: None,
        swap_in: None,
        swap_out: None,
        major_faults: None,
        minor_faults: None,
        disk_caches: None,
    }
}

#[tokio::test]
async fn wait_for_balloon_near_target_logs_summary_without_timeout() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let (sock, _reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib,
            target_mib - 39,
        ))]),
    )
    .await;
    let client = ApiClient::new(&sock).unwrap();

    let (outcome, events) =
        capture_async_log_events(wait_for_balloon(&client, target_mib, "near-target")).await;

    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    assert!(!has_captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway"
    ));
    let event = captured_event(
        &events,
        "balloon inflated within tolerance, proceeding to pause",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "actual", "3545");
    assert_event_field(event, "target", "3584");
    assert_event_field(event, "deficit_mib", "39");
    assert_event_field(event, "sample_count", "1");
    assert_event_field(event, "requested_target_mib", "3584");
    assert_event_field(event, "target_observed", "true");
    assert_event_field(event, "observed_target_mib", "Some(3584)");
    assert_event_field(event, "first_actual_mib", "Some(3545)");
    assert_event_field(event, "max_actual_mib", "Some(3545)");
    assert_event_field(event, "actual_delta_mib", "Some(0)");
}

#[tokio::test]
async fn wait_for_balloon_timeout_logs_actual_stalled_reason() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let (sock, _reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib, 1250,
        ))]),
    )
    .await;
    let client = ApiClient::new(&sock).unwrap();

    let (outcome, events) =
        capture_async_log_events(wait_for_balloon(&client, target_mib, "stalled")).await;

    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "Some(1250)");
    assert_event_field(event, "target", "1536");
    assert_event_field(event, "deficit_mib", "Some(286)");
    assert_event_field(event, "requested_target_mib", "1536");
    assert_event_field(event, "target_observed", "true");
    assert_event_field(event, "observed_target_mib", "Some(1536)");
    assert_event_field(event, "first_actual_mib", "Some(1250)");
    assert_event_field(event, "max_actual_mib", "Some(1250)");
    assert_event_field(event, "actual_delta_mib", "Some(0)");
    assert_event_field(event, "reason", "actual_stalled");
    assert_event_field(event, "admission_action", "reuse");
}

#[tokio::test]
async fn wait_for_balloon_accepts_pressure_limited_partial_reclaim() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let stats = MockBalloonStats::new(target_mib, 1250).with_memory(mib(64), mib(128), mib(2048));
    let (sock, _reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(stats)]),
    )
    .await;
    let client = ApiClient::new(&sock).unwrap();

    let (outcome, events) =
        capture_async_log_events(wait_for_balloon(&client, target_mib, "pressure-limited")).await;

    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    assert!(!has_captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway"
    ));
    let event = captured_event(
        &events,
        "balloon pressure-limited partial reclaim, proceeding to pause",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "actual", "1250");
    assert_event_field(event, "target", "1536");
    assert_event_field(event, "deficit_mib", "286");
    assert_event_field(event, "tolerance_mib", "192");
    assert_event_field(event, "sample_count", "1");
    assert_event_field(event, "target_observed", "true");
    assert_event_field(event, "reported_free_mib", "Some(64)");
    assert_event_field(event, "reported_available_mib", "Some(128)");
    assert_event_field(event, "reason", "pressure_limited_partial_reclaim");
}

#[test]
fn balloon_settle_tolerance_is_capped_and_scales_for_small_targets() {
    assert_eq!(
        balloon_settle_tolerance_mib(4096 - balloon::MIN_GUEST_MIB),
        256
    );
    assert_eq!(
        balloon_settle_tolerance_mib(2048 - balloon::MIN_GUEST_MIB),
        192
    );
    assert_eq!(
        balloon_settle_tolerance_mib(1024 - balloon::MIN_GUEST_MIB),
        64
    );
    assert_eq!(balloon_settle_tolerance_mib(1), 0);
}

#[test]
fn balloon_settle_summary_classifies_progressing_timeout() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut summary = BalloonSettleSummary::new(target_mib);

    summary.observe(&balloon_statistics(target_mib, 1200));
    summary.observe(&balloon_statistics(target_mib, 1300));

    assert_eq!(summary.reason(), "actual_progressing_timeout");
    assert_eq!(summary.park_outcome(), SandboxParkOutcome::Reusable);
    assert_eq!(summary.last_actual_mib, Some(1300));
    assert_eq!(summary.last_deficit_mib, Some(236));
    assert_eq!(summary.first_actual_mib, Some(1200));
    assert_eq!(summary.max_actual_mib, Some(1300));
    assert_eq!(summary.actual_delta_mib(), Some(100));
}

#[test]
fn pressure_limited_reclaim_ignores_free_memory_when_available_memory_is_missing() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let tolerance_mib = balloon_settle_tolerance_mib(target_mib);
    let mut available_summary = BalloonSettleSummary::new(target_mib);
    let mut available_stats = balloon_statistics(target_mib, 1250);
    available_stats.free_memory = Some(mib(2048));
    available_stats.available_memory = Some(mib(128));
    available_stats.total_memory = Some(mib(2048));
    let available_deficit_mib = available_summary.observe(&available_stats);

    assert!(
        available_summary.is_pressure_limited_partial_reclaim(available_deficit_mib, tolerance_mib)
    );

    let mut missing_available_summary = BalloonSettleSummary::new(target_mib);
    let mut missing_available_stats = balloon_statistics(target_mib, 1250);
    missing_available_stats.free_memory = Some(mib(32));
    missing_available_stats.total_memory = Some(mib(2048));
    let missing_available_deficit_mib = missing_available_summary.observe(&missing_available_stats);

    assert!(
        !missing_available_summary
            .is_pressure_limited_partial_reclaim(missing_available_deficit_mib, tolerance_mib)
    );
}

#[tokio::test]
async fn wait_for_balloon_timeout_logs_target_not_observed_reason() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let (sock, _reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            1024, 1200,
        ))]),
    )
    .await;
    let client = ApiClient::new(&sock).unwrap();

    let (outcome, events) =
        capture_async_log_events(wait_for_balloon(&client, target_mib, "stale-target")).await;

    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "target_observed", "false");
    assert_event_field(event, "observed_target_mib", "Some(1024)");
    assert_event_field(event, "reason", "target_not_observed");
}

#[tokio::test]
async fn wait_for_balloon_stats_poll_is_bounded_by_settle_timeout() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let (sock, _reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::DelayedOk(
            BALLOON_SETTLE_TIMEOUT + Duration::from_secs(1),
            MockBalloonStats::new(target_mib, target_mib),
        )]),
    )
    .await;
    let client = ApiClient::new(&sock).unwrap();

    let (outcome, events) =
        capture_async_log_events(wait_for_balloon(&client, target_mib, "slow-stats")).await;

    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "sample_count", "0");
    assert_event_field(event, "reason", "stats_unavailable");
    assert_event_field(event, "actual", "None");
    assert_event_field(event, "deficit_mib", "None");
}

#[tokio::test]
async fn wait_for_balloon_timeout_logs_severe_deficit_and_memory_stats() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let stats = MockBalloonStats::new(target_mib, 900).with_memory(mib(32), mib(0), mib(2048));
    let (sock, _reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(stats)]),
    )
    .await;
    let client = ApiClient::new(&sock).unwrap();

    let (outcome, events) =
        capture_async_log_events(wait_for_balloon(&client, target_mib, "severe")).await;

    assert_eq!(
        outcome,
        SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention)
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "Some(900)");
    assert_event_field(event, "deficit_mib", "Some(636)");
    assert_event_field(event, "reported_free_mib", "Some(32)");
    assert_event_field(event, "reported_available_mib", "Some(0)");
    assert_event_field(event, "reported_total_mib", "Some(2048)");
    assert_event_field(event, "reason", "severe_deficit");
    assert_event_field(event, "admission_action", "reject_and_destroy");
}

#[tokio::test]
async fn park_pauses_when_balloon_stats_are_unavailable() {
    let (sock, reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Status(500)]),
    )
    .await;
    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let (result, events) = capture_async_log_events(park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        "stats-error",
    ))
    .await;
    result.unwrap();

    assert!(is_parked);
    let event = captured_event(&events, "balloon stats unavailable, proceeding to pause");
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "None");
    assert_event_field(event, "deficit_mib", "None");
    assert_event_field(event, "sample_count", "0");
    assert_event_field(event, "reason", "stats_unavailable");

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn snapshot_restore_with_limiters_loads_paused_patches_then_resumes() {
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 204, 204]), None).await;
    let client = ApiClient::new(&sock).unwrap();
    let rate_limits = test_rate_limits();

    load_snapshot_and_apply_rate_limits(&client, "/snap/state", "/snap/memory", Some(&rate_limits))
        .await
        .unwrap();

    let reqs = reqs.lock().await;
    assert_eq!(
        reqs.len(),
        5,
        "expected load, rootfs drive patch, workspace drive patch, network patch, resume"
    );
    assert_eq!(reqs[0].method, "PUT");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);

    assert_eq!(reqs[1].method, "PATCH");
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert_eq!(
        mock_request_body_json(&reqs[1])["rate_limiter"]["bandwidth"]["size"],
        512
    );

    assert_eq!(reqs[2].method, "PATCH");
    assert_eq!(reqs[2].path, "/drives/workspace");
    assert_eq!(
        mock_request_body_json(&reqs[2])["rate_limiter"]["bandwidth"]["size"],
        512
    );

    assert_eq!(reqs[3].method, "PATCH");
    assert_eq!(reqs[3].path, "/network-interfaces/eth0");
    assert_eq!(
        mock_request_body_json(&reqs[3])["rx_rate_limiter"]["bandwidth"]["size"],
        2048
    );
    assert_eq!(
        mock_request_body_json(&reqs[3])["tx_rate_limiter"]["bandwidth"]["size"],
        4096
    );

    assert_eq!(reqs[4].method, "PATCH");
    assert_eq!(reqs[4].path, "/vm");
    assert!(reqs[4].body.contains("Resumed"));
}

#[tokio::test]
async fn snapshot_restore_without_limiters_loads_and_resumes_without_patching() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;
    let client = ApiClient::new(&sock).unwrap();

    load_snapshot_and_apply_rate_limits(&client, "/snap/state", "/snap/memory", None)
        .await
        .unwrap();

    let reqs = reqs.lock().await;
    assert_eq!(reqs.len(), 1, "expected only snapshot load");
    assert_eq!(reqs[0].method, "PUT");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], true);
}

#[tokio::test]
async fn snapshot_restore_limiter_patch_failure_does_not_resume() {
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![500]), None).await;
    let client = ApiClient::new(&sock).unwrap();
    let rate_limits = test_rate_limits();

    let err = load_snapshot_and_apply_rate_limits(
        &client,
        "/snap/state",
        "/snap/memory",
        Some(&rate_limits),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(err.contains("snapshot drive rate limiter patch failed"));
    let reqs = reqs.lock().await;
    assert_eq!(reqs.len(), 2, "resume must not be attempted");
    assert_eq!(reqs[0].method, "PUT");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
    assert_eq!(reqs[1].method, "PATCH");
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert!(reqs.iter().all(|request| request.path != "/vm"));
}

#[tokio::test]
async fn snapshot_restore_workspace_limiter_patch_failure_does_not_resume() {
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 500]), None).await;
    let client = ApiClient::new(&sock).unwrap();
    let rate_limits = test_rate_limits();

    let err = load_snapshot_and_apply_rate_limits(
        &client,
        "/snap/state",
        "/snap/memory",
        Some(&rate_limits),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(err.contains("snapshot workspace drive rate limiter patch failed"));
    let reqs = reqs.lock().await;
    assert_eq!(
        reqs.len(),
        3,
        "network patch and resume must not be attempted"
    );
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert_eq!(reqs[2].path, "/drives/workspace");
    assert!(
        reqs.iter()
            .all(|request| request.path != "/network-interfaces/eth0")
    );
    assert!(reqs.iter().all(|request| request.path != "/vm"));
}

#[tokio::test]
async fn snapshot_restore_network_limiter_patch_failure_does_not_resume() {
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 204, 500]), None).await;
    let client = ApiClient::new(&sock).unwrap();
    let rate_limits = test_rate_limits();

    let err = load_snapshot_and_apply_rate_limits(
        &client,
        "/snap/state",
        "/snap/memory",
        Some(&rate_limits),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(err.contains("snapshot network rate limiter patch failed"));
    let reqs = reqs.lock().await;
    assert_eq!(reqs.len(), 4, "resume must not be attempted");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert_eq!(reqs[2].path, "/drives/workspace");
    assert_eq!(reqs[3].path, "/network-interfaces/eth0");
    assert!(reqs.iter().all(|request| request.path != "/vm"));
}

fn test_balloon_controller() -> balloon::ControllerHandle {
    balloon::ControllerHandle::from_task_for_test(tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(3600)).await
    }))
}

#[tokio::test]
async fn park_inflates_and_pauses() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(&mut is_parked, 2048, &mut controller, &sock, "test-park")
        .await
        .unwrap();

    assert!(is_parked, "is_parked should be set");
    assert!(controller.is_none(), "controller handle should be taken");

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(
        ps.len(),
        2,
        "expected balloon inflate + vm pause, got {ps:?}"
    );
    assert_eq!(ps[0].path, "/balloon");
    let parsed: serde_json::Value = serde_json::from_str(&ps[0].body).unwrap();
    assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 1536); // 2048 - 512
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_inflates_by_one_at_min_plus_one() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        513,
        &mut controller,
        &sock,
        "test-min-plus-1",
    )
    .await
    .unwrap();

    assert!(is_parked);
    assert!(controller.is_none());
    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2);
    assert_eq!(ps[0].path, "/balloon");
    let parsed: serde_json::Value = serde_json::from_str(&ps[0].body).unwrap();
    assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 1);
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_small_vm_skips_balloon_but_pauses_vcpus() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        512,
        &mut controller,
        &sock,
        "test-park-small",
    )
    .await
    .unwrap();

    assert!(is_parked, "is_parked should be set");
    let still_there = controller.as_ref().expect("controller must be preserved");
    assert_eq!(
        still_there.id(),
        original_id,
        "controller must not be replaced or aborted"
    );

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "expected only vm pause, no balloon PATCH");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Paused"));
}

#[tokio::test]
async fn unpark_resumes_and_deflates() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "test-unpark",
    )
    .await
    .unwrap();

    assert!(!is_parked, "is_parked should be cleared");
    assert!(
        controller.is_some(),
        "reactive controller must be respawned"
    );

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    // resume, then deflate (+ possible reactive controller PATCHes)
    assert!(ps.len() >= 2, "expected at least resume + deflate");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
    assert_eq!(ps[1].path, "/balloon");
    let parsed: serde_json::Value = serde_json::from_str(&ps[1].body).unwrap();
    assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 0);

    if let Some(h) = controller.take() {
        h.abort();
    }
}

#[tokio::test]
async fn unpark_propagates_deflate_error() {
    // Resume succeeds (204), deflate fails (400).
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 400]), None).await;

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    let result = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "test-unpark-err",
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true on failure");
    assert!(
        controller.is_none(),
        "controller must not be respawned on failure"
    );

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected resume + failed deflate");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
    assert_eq!(ps[1].path, "/balloon");
}

#[tokio::test]
async fn unpark_small_vm_skips_balloon_but_resumes_vcpus() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = true;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        512,
        &mut controller,
        &sock,
        state_rx.clone(),
        "test-unpark-small",
    )
    .await
    .unwrap();

    assert!(!is_parked);
    let still_there = controller.as_ref().expect("controller must be preserved");
    assert_eq!(
        still_there.id(),
        original_id,
        "controller must not be replaced"
    );

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "expected only vm resume, no balloon PATCH");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
}

#[tokio::test]
async fn double_park_is_idempotent() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(&mut is_parked, 2048, &mut controller, &sock, "dp")
        .await
        .unwrap();
    park_inner(&mut is_parked, 2048, &mut controller, &sock, "dp")
        .await
        .unwrap();

    assert!(is_parked);
    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(
        ps.len(),
        2,
        "expected exactly one park sequence (inflate + pause) despite double-park"
    );
}

#[tokio::test]
async fn double_unpark_is_idempotent() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "du",
    )
    .await
    .unwrap();
    let first_controller_id = controller.as_ref().unwrap().id();

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "du",
    )
    .await
    .unwrap();

    assert!(!is_parked);
    assert_eq!(
        controller.as_ref().unwrap().id(),
        first_controller_id,
        "second unpark must not replace the controller"
    );
    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    let deflate_count = ps.iter().filter(|r| r.path == "/balloon").count();
    assert_eq!(deflate_count, 1, "expected exactly one deflate PATCH");

    if let Some(h) = controller.take() {
        h.abort();
    }
}

#[tokio::test]
async fn unpark_without_park_is_noop() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = false;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "fresh",
    )
    .await
    .unwrap();

    assert!(!is_parked);
    assert_eq!(
        controller.as_ref().unwrap().id(),
        original_id,
        "controller must not be touched"
    );
    assert!(patches(&reqs.lock().await).is_empty());
}

#[tokio::test]
async fn park_unpark_park_cycle() {
    let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    // Turn 1: park.
    park_inner(&mut is_parked, 2048, &mut controller, &sock, "cycle")
        .await
        .unwrap();
    assert!(is_parked);
    assert!(controller.is_none());

    // Turn 2: unpark → park.
    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "cycle",
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(controller.is_some(), "unpark must respawn the controller");

    park_inner(&mut is_parked, 2048, &mut controller, &sock, "cycle")
        .await
        .unwrap();
    assert!(is_parked);
    assert!(
        controller.is_none(),
        "second park must abort the controller respawned by unpark"
    );

    // PATCH sequence: inflate, pause, resume, deflate, inflate, pause.
    // Filter to only PATCHes (ignoring GET /balloon/statistics from
    // wait_for_balloon and the respawned reactive controller).
    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    let ops: Vec<(&str, Option<u64>)> = ps
        .iter()
        .map(|r| {
            let amt = serde_json::from_str::<serde_json::Value>(&r.body)
                .ok()
                .and_then(|v| v["amount_mib"].as_u64());
            (r.path.as_str(), amt)
        })
        .collect();
    assert_eq!(
        ops,
        vec![
            ("/balloon", Some(1536)), // park 1: inflate
            ("/vm", None),            // park 1: pause
            ("/vm", None),            // unpark: resume
            ("/balloon", Some(0)),    // unpark: deflate
            ("/balloon", Some(1536)), // park 2: inflate
            ("/vm", None),            // park 2: pause
        ],
        "unexpected PATCH sequence: {ops:?}"
    );
}

#[tokio::test]
async fn park_balloon_failure_leaves_flag_false() {
    // Balloon inflate fails (400). Pause should not be attempted.
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![400]), None).await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let result = park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        "test-park-fail",
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(!is_parked, "flag must stay false on failure");
    assert!(controller.is_none());

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "only balloon inflate should be attempted");
    assert_eq!(ps[0].path, "/balloon");

    // A follow-up unpark must be a clean no-op because is_parked is false.
    drop(reqs);
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "test-park-fail",
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(controller.is_none());
}

#[tokio::test]
async fn park_retry_after_failure_succeeds() {
    // First park: balloon fails (400). Second park: balloon OK (204), pause OK (204).
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![400, 204, 204]), None).await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let first = park_inner(&mut is_parked, 2048, &mut controller, &sock, "retry").await;
    assert_idle_transition(first, SandboxIdleTransition::Park);
    assert!(!is_parked);
    assert!(controller.is_none());

    park_inner(&mut is_parked, 2048, &mut controller, &sock, "retry")
        .await
        .unwrap();
    assert!(is_parked);

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    // First attempt: balloon(400). Second: balloon(204) + pause(204).
    assert_eq!(ps.len(), 3);
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/balloon");
    assert_eq!(ps[2].path, "/vm");
    assert!(ps[2].body.contains("Paused"));
}

#[tokio::test]
async fn unpark_retry_after_failure_succeeds() {
    // First unpark: resume fails (500 — genuine error, not idempotent 400).
    // Second unpark: resume OK (204), deflate OK (204).
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![500, 204, 204]), None).await;

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    let first = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "retry",
    )
    .await;
    assert_idle_transition(first, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true on failure");
    assert!(controller.is_none());

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "retry",
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(controller.is_some(), "controller must be respawned");

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 3);
    // First attempt: resume(500).
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
    // Second attempt: resume(204), deflate(204).
    assert_eq!(ps[1].path, "/vm");
    assert_eq!(ps[2].path, "/balloon");

    if let Some(h) = controller.take() {
        h.abort();
    }
}

// -- new tests for vCPU pause/resume --

#[tokio::test]
async fn park_pause_failure_propagates_as_idle_transition() {
    // Balloon inflate succeeds and observes a severe deficit. The next stats
    // request fails, terminating settle with that severe classification, but
    // the final VM pause still fails and must remain an operational error.
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let (sock, reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::from(vec![204, 500]),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 0)),
            MockBalloonStatsReply::Status(500),
        ]),
    )
    .await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let result = park_inner(&mut is_parked, 2048, &mut controller, &sock, "pause-fail").await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(!is_parked, "flag must stay false on failure");
    // Controller was aborted before balloon PATCH.
    assert!(controller.is_none());

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2);
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
}

#[tokio::test]
async fn unpark_resume_failure_propagates_as_idle_transition() {
    // Resume fails with 500 (genuine error). No deflate should be attempted.
    let (sock, reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![500]), None).await;

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    let result = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "resume-fail",
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true on failure");
    assert!(controller.is_none(), "controller must not be respawned");

    let reqs = reqs.lock().await;
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "only resume should be attempted, no deflate");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
}

#[tokio::test]
async fn unpark_retry_after_partial_failure_resumes_idempotently() {
    // First unpark: resume OK (204), deflate fails (400).
    // Second unpark: resume 400 (already running — treated as OK), deflate OK (204).
    let (sock, _reqs, _dir) = spawn_mock_fc_api(
        std::collections::VecDeque::from(vec![204, 400, 400, 204]),
        None,
    )
    .await;

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    // First attempt: resume OK, deflate fails.
    let first = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "idem",
    )
    .await;
    assert_idle_transition(first, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true after partial failure");

    // Second attempt: resume 400 (idempotent), deflate OK.
    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        state_rx.clone(),
        "idem",
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(
        controller.is_some(),
        "controller must be respawned on success"
    );

    if let Some(h) = controller.take() {
        h.abort();
    }
}

#[tokio::test]
async fn park_waits_for_balloon_before_pause() {
    // Mock returns actual_mib = 0 initially, then 1536 before the next
    // poll interval. This uses the real clock because
    // the API boundary uses a real Unix socket.
    let balloon_actual = Arc::new(AtomicU32::new(0));
    let (sock, reqs, _dir) = spawn_mock_fc_api(
        std::collections::VecDeque::new(),
        Some(Arc::clone(&balloon_actual)),
    )
    .await;

    // Set actual to target before the second 500ms poll.
    let actual_clone = Arc::clone(&balloon_actual);
    tokio::spawn(async move {
        // Let the first stats request complete before changing the value.
        tokio::time::sleep(Duration::from_millis(250)).await;
        actual_clone.store(1536, Ordering::Relaxed);
    });

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(&mut is_parked, 2048, &mut controller, &sock, "wait-test")
        .await
        .unwrap();

    assert!(is_parked);
    let reqs = reqs.lock().await;

    // Should have at least one GET /balloon/statistics before the PATCH /vm pause.
    let stats_gets: Vec<_> = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .collect();
    assert!(
        !stats_gets.is_empty(),
        "expected at least one balloon stats poll before pause"
    );

    // Verify PATCH ordering: balloon inflate, then vm pause.
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2);
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_pauses_when_balloon_is_within_settle_tolerance() {
    // Production samples have shown 4 GiB VMs often settling with a
    // low-hundreds MiB residual while the guest reports little available
    // memory. That is close enough to park without waiting for the full
    // timeout and emitting a WARN.
    let balloon_actual = Arc::new(AtomicU32::new(3545));
    let (sock, reqs, _dir) = spawn_mock_fc_api(
        std::collections::VecDeque::new(),
        Some(Arc::clone(&balloon_actual)),
    )
    .await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(&mut is_parked, 4096, &mut controller, &sock, "near-test")
        .await
        .unwrap();

    assert!(is_parked);
    let reqs = reqs.lock().await;
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert_eq!(
        stats_gets, 1,
        "near-target balloon should settle on the first stats poll"
    );

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_pauses_when_balloon_deficit_equals_settle_tolerance() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let balloon_actual = Arc::new(AtomicU32::new(
        target_mib - balloon_settle_tolerance_mib(target_mib),
    ));
    let (sock, reqs, _dir) = spawn_mock_fc_api(
        std::collections::VecDeque::new(),
        Some(Arc::clone(&balloon_actual)),
    )
    .await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        4096,
        &mut controller,
        &sock,
        "tolerance-edge",
    )
    .await
    .unwrap();

    assert!(is_parked);
    let reqs = reqs.lock().await;
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert_eq!(
        stats_gets, 1,
        "exact tolerance boundary should settle on the first stats poll"
    );

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_pauses_when_balloon_reclaim_is_pressure_limited() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let stats = MockBalloonStats::new(target_mib, 1250).with_memory(mib(64), mib(128), mib(2048));
    let (sock, reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(stats)]),
    )
    .await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let (result, events) = capture_async_log_events(park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        &sock,
        "pressure-limited-park",
    ))
    .await;
    assert_eq!(result.unwrap(), SandboxParkOutcome::Reusable);

    assert!(is_parked);
    assert!(controller.is_none());
    let event = captured_event(
        &events,
        "balloon pressure-limited partial reclaim, proceeding to pause",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "reason", "pressure_limited_partial_reclaim");

    let reqs = reqs.lock().await;
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert_eq!(
        stats_gets, 1,
        "pressure-limited balloon should settle on the first stats poll"
    );

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_rejects_severe_balloon_retention_after_pausing() {
    // Balloon never progresses despite observing the requested target.
    // Parking must still pause the VM, then report it as non-reusable.
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let (sock, reqs, _dir) = spawn_mock_fc_api_with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib, 0,
        ))]),
    )
    .await;

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let outcome = park_inner(&mut is_parked, 2048, &mut controller, &sock, "timeout-test")
        .await
        .unwrap();

    assert_eq!(
        outcome,
        SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention)
    );
    assert!(is_parked);

    let reqs = reqs.lock().await;

    // At least one stats poll must have occurred before the timeout.
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert!(
        stats_gets >= 1,
        "expected at least one balloon stats poll before timeout, got {stats_gets}"
    );

    // Final PATCH must be the vm pause.
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_small_vm_pause_failure_preserves_controller() {
    // Small VM (≤512 MiB): no balloon work, just pause. If pause
    // fails, the controller must be preserved (not aborted) — unlike
    // large VMs where the controller is already gone.
    let (sock, _reqs, _dir) =
        spawn_mock_fc_api(std::collections::VecDeque::from(vec![500]), None).await;

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = false;

    let result = park_inner(&mut is_parked, 512, &mut controller, &sock, "small-fail").await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(!is_parked, "flag must stay false on failure");
    // Key assertion: controller is preserved for small VMs (no balloon
    // work was done, so no need to abort the controller).
    let still_there = controller.as_ref().expect("controller must be preserved");
    assert_eq!(
        still_there.id(),
        original_id,
        "controller must not be replaced or aborted"
    );
}
