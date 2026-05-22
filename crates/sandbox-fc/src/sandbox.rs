use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessCancelHandle,
    GuestProcessControlHandle, GuestProcessHandle, GuestProcessWaiter, ProcessControlAck,
    ProcessControlMode, ProcessExit, ProcessOutputChunk, ProcessOutputMode, Sandbox, SandboxConfig,
    SandboxError, SandboxIdleTransition, SandboxInvalidStateContext, SandboxOperation,
    SandboxOperationReason, StartProcessRequest,
};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{info, trace, warn};
use vsock_host::{
    ExecOutputEvent, ExecOwnedCapturedOutput, NormalOperationFence, NormalOperationFenceRejection,
    SupervisedExecControl, SupervisedExecRequest, VsockHost,
};
use vsock_proto::{ExecOutputPolicy, ExecOutputStream, ExecTermination, ExecTimeoutPolicy};

use crate::api::ApiError;
use nbd_cow::PooledNbdCowDevice;

use crate::api::ApiClient;
use crate::balloon;
use crate::config::{FirecrackerConfig, FirecrackerDeviceRateLimits};
use crate::control;
use crate::factory::InvariantConfig;
use crate::guest_operations::{GuestOperationStartError, GuestOperationStartGate};
use crate::leaked_resources::LeakedResources;
use crate::network::{NetnsInfo, NetnsLease};
use crate::park_coordinator::{
    CoordinatorState, DirtyReason, OperationStartRejection, ParkAttempt, ParkCoordinator,
    PrepareParkError, PrepareParkEvidence,
};
use crate::paths::{SandboxPaths, SockPaths};
use crate::process::{kill_process_group, kill_process_group_by_pid};

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for receiving a process start acknowledgement from the guest.
const PROCESS_START_ACK_TIMEOUT: Duration = Duration::from_secs(30);
/// Exit code returned by guest exec timeout handling.
const EXEC_TIMEOUT_EXIT_CODE: i32 = 124;

/// Timeout for graceful shutdown via vsock.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for Firecracker API socket readiness after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Short grace period for Firecracker stdout/stderr log readers after child exit.
const PROCESS_LOG_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Timeout for guest lifecycle acknowledgements during same-session park/unpark.
const GUEST_PARK_LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bash command run inside `unshare --mount` for snapshot restore.
/// Positional args are documented at the spawn site.
const SNAPSHOT_RESTORE_INNER_CMD: &str = r#"umount "$4" 2>/dev/null; mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec ip netns exec "$5" "$6" --api-sock "$7""#;
const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

async fn load_snapshot_and_apply_rate_limits(
    client: &ApiClient<'_>,
    snapshot_path: &str,
    memory_path: &str,
    rate_limits: Option<&FirecrackerDeviceRateLimits>,
) -> sandbox::Result<()> {
    // Keep the default restore path unchanged. Only hold the VM paused
    // when rate limiters must be patched before guest execution resumes.
    client
        .load_snapshot(snapshot_path, memory_path, rate_limits.is_none())
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("snapshot load failed: {e}"),
        })?;
    if let Some(rate_limits) = rate_limits {
        client
            .patch_drive_rate_limiter("rootfs", &rate_limits.drive)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot drive rate limiter patch failed: {e}"),
            })?;
        let inv = InvariantConfig::new();
        client
            .patch_network_rate_limiters(inv.iface_id, &rate_limits.net_rx, &rate_limits.net_tx)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot network rate limiter patch failed: {e}"),
            })?;
        client.resume().await.map_err(|e| SandboxError::Start {
            message: format!("snapshot resume failed: {e}"),
        })?;
    }

    Ok(())
}

fn build_fresh_boot_firecracker_config(
    resources: &sandbox::ResourceLimits,
    kernel_path: String,
    cow_device_path: String,
    vsock_path: String,
    device_rate_limits: Option<&FirecrackerDeviceRateLimits>,
) -> sandbox::Result<serde_json::Value> {
    let inv = InvariantConfig::new();
    let mut drive = serde_json::Map::from_iter([
        ("drive_id".to_string(), serde_json::json!("rootfs")),
        (
            "path_on_host".to_string(),
            serde_json::json!(cow_device_path),
        ),
        ("is_root_device".to_string(), serde_json::json!(true)),
        ("is_read_only".to_string(), serde_json::json!(false)),
    ]);
    let mut network_interface = serde_json::Map::from_iter([
        ("iface_id".to_string(), serde_json::json!(inv.iface_id)),
        ("guest_mac".to_string(), serde_json::json!(inv.guest_mac)),
        ("host_dev_name".to_string(), serde_json::json!(inv.tap_name)),
    ]);
    if let Some(rate_limits) = device_rate_limits {
        drive.insert(
            "rate_limiter".to_string(),
            serde_json::to_value(&rate_limits.drive).map_err(|e| SandboxError::Start {
                message: format!("serialize drive rate limiter: {e}"),
            })?,
        );
        network_interface.insert(
            "rx_rate_limiter".to_string(),
            serde_json::to_value(&rate_limits.net_rx).map_err(|e| SandboxError::Start {
                message: format!("serialize network rx rate limiter: {e}"),
            })?,
        );
        network_interface.insert(
            "tx_rate_limiter".to_string(),
            serde_json::to_value(&rate_limits.net_tx).map_err(|e| SandboxError::Start {
                message: format!("serialize network tx rate limiter: {e}"),
            })?,
        );
    }

    Ok(serde_json::json!({
        "boot-source": {
            "kernel_image_path": kernel_path,
            "boot_args": inv.boot_args,
        },
        "drives": [serde_json::Value::Object(drive)],
        "machine-config": {
            "vcpu_count": resources.cpu_count,
            "mem_size_mib": resources.memory_mb,
        },
        "network-interfaces": [serde_json::Value::Object(network_interface)],
        "vsock": {
            "guest_cid": inv.guest_cid,
            "uds_path": vsock_path,
        },
        "balloon": {
            "amount_mib": inv.balloon.amount_mib,
            "deflate_on_oom": inv.balloon.deflate_on_oom,
            "stats_polling_interval_s": inv.balloon.stats_polling_interval_s,
        },
    }))
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxState {
    Created = 0,
    Running = 1,
    Stopping = 2,
    Stopped = 3,
    Crashed = 4,
}

impl SandboxState {
    fn from_u8(v: u8) -> Self {
        debug_assert!(v <= 4, "invalid SandboxState: {v}");
        match v {
            0 => Self::Created,
            1 => Self::Running,
            2 => Self::Stopping,
            3 => Self::Stopped,
            4 => Self::Crashed,
            _ => Self::Stopped,
        }
    }
}

impl std::fmt::Display for SandboxState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Created => f.write_str("created"),
            Self::Running => f.write_str("running"),
            Self::Stopping => f.write_str("stopping"),
            Self::Stopped => f.write_str("stopped"),
            Self::Crashed => f.write_str("crashed"),
        }
    }
}

async fn ensure_snapshot_drive_bind_target(path: &Path) -> Result<(), SandboxError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("mkdir snapshot drive: {e}"),
            })?;
    }

    if create_snapshot_drive_bind_target_file(path).await? {
        return Ok(());
    }

    if snapshot_drive_bind_target_is_regular_file(path).await? {
        return Ok(());
    }

    if snapshot_drive_bind_target_is_mount_point(path)? {
        unmount_snapshot_drive_bind_target(path).await?;
        if create_snapshot_drive_bind_target_file(path).await? {
            return Ok(());
        }
        if snapshot_drive_bind_target_is_regular_file(path).await? {
            return Ok(());
        }
    }

    Err(SandboxError::Start {
        message: format!(
            "snapshot drive bind target is not a regular file: {}",
            path.display()
        ),
    })
}

async fn create_snapshot_drive_bind_target_file(path: &Path) -> Result<bool, SandboxError> {
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(SandboxError::Start {
            message: format!("create snapshot drive bind target: {e}"),
        }),
    }
}

async fn snapshot_drive_bind_target_is_regular_file(path: &Path) -> Result<bool, SandboxError> {
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("stat snapshot drive bind target: {e}"),
        })?;
    Ok(meta.file_type().is_file())
}

fn snapshot_drive_bind_target_is_mount_point(path: &Path) -> Result<bool, SandboxError> {
    let path =
        absolute_path_without_following_final_symlink(path).map_err(|e| SandboxError::Start {
            message: format!("resolve snapshot drive bind target path: {e}"),
        })?;
    let mountinfo =
        std::fs::read_to_string("/proc/self/mountinfo").map_err(|e| SandboxError::Start {
            message: format!("read /proc/self/mountinfo: {e}"),
        })?;
    Ok(mountinfo_contains_mount_point(&mountinfo, &path))
}

fn absolute_path_without_following_final_symlink(path: &Path) -> io::Result<std::path::PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn mountinfo_contains_mount_point(mountinfo: &str, path: &Path) -> bool {
    mountinfo.lines().any(|line| {
        let Some(encoded_mount_point) = line.split_whitespace().nth(4) else {
            return false;
        };
        decode_mountinfo_path(encoded_mount_point) == path
    })
}

fn decode_mountinfo_path(encoded: &str) -> std::path::PathBuf {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        let Some(&byte) = bytes.get(i) else {
            break;
        };
        if byte == b'\\' {
            let escape = (bytes.get(i + 1), bytes.get(i + 2), bytes.get(i + 3));
            let (Some(&first), Some(&second), Some(&third)) = escape else {
                decoded.push(byte);
                i += 1;
                continue;
            };
            if !is_octal_digit(first) || !is_octal_digit(second) || !is_octal_digit(third) {
                decoded.push(byte);
                i += 1;
                continue;
            }

            let value =
                ((first - b'0') as u16) * 64 + ((second - b'0') as u16) * 8 + (third - b'0') as u16;
            if value <= u8::MAX as u16 {
                decoded.push(value as u8);
                i += 4;
            } else {
                decoded.push(byte);
                i += 1;
            }
        } else {
            decoded.push(byte);
            i += 1;
        }
    }

    std::path::PathBuf::from(OsString::from_vec(decoded))
}

fn is_octal_digit(byte: u8) -> bool {
    (b'0'..=b'7').contains(&byte)
}

async fn unmount_snapshot_drive_bind_target(path: &Path) -> Result<(), SandboxError> {
    let output = tokio::process::Command::new("umount")
        .arg(path)
        .output()
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("spawn umount for snapshot drive bind target: {e}"),
        })?;

    if output.status.success() || !snapshot_drive_bind_target_is_mount_point(path)? {
        if output.status.success() {
            info!(
                path = %path.display(),
                "cleared stale snapshot drive bind target mount"
            );
        }
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(SandboxError::Start {
        message: format!(
            "umount stale snapshot drive bind target {}: {}",
            path.display(),
            stderr.trim()
        ),
    })
}

struct ProcessMonitorHandle {
    kill_tx: mpsc::UnboundedSender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ProcessMonitorHandle {
    fn kill(&self) {
        let _ = self.kill_tx.send(());
    }

    async fn wait(self) {
        let _ = self.task.await;
    }
}

#[derive(Default)]
struct SandboxRuntimeHandles {
    process: Option<ProcessMonitorHandle>,
    control: Option<control::ControlServerHandle>,
    balloon: Option<balloon::ControllerHandle>,
}

impl SandboxRuntimeHandles {
    fn set_process(&mut self, process: ProcessMonitorHandle) {
        self.process = Some(process);
    }

    fn set_control(&mut self, control: control::ControlServerHandle) {
        self.control = Some(control);
    }

    fn set_balloon(&mut self, balloon: balloon::ControllerHandle) {
        self.balloon = Some(balloon);
    }

    fn balloon_mut(&mut self) -> &mut Option<balloon::ControllerHandle> {
        &mut self.balloon
    }

    async fn shutdown_services(&mut self) {
        if let Some(mut control) = self.control.take() {
            control.shutdown().await;
        }
        if let Some(balloon) = self.balloon.take() {
            balloon.abort();
        }
    }

    async fn kill_process(&mut self) {
        if let Some(process) = self.process.take() {
            process.kill();
            process.wait().await;
        }
    }

    fn abort_for_drop(&mut self) {
        if let Some(mut control) = self.control.take() {
            control.abort();
        }
        if let Some(balloon) = self.balloon.take() {
            balloon.abort();
        }
        if let Some(process) = self.process.take() {
            // Ask the monitor to kill the process group before it reaps the
            // child. This avoids signalling by a cached PID after the child
            // could have exited and been reused by the OS.
            process.kill();
        }
    }
}

#[derive(Clone, Copy)]
enum ProcessLogStream {
    Stdout,
    Stderr,
}

impl ProcessLogStream {
    fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }

    fn log(self, id: &str, line: &str) {
        match self {
            Self::Stdout => info!(id = %id, "{line}"),
            Self::Stderr => warn!(id = %id, "stderr: {line}"),
        }
    }
}

struct ProcessLogReaders {
    stdout: Option<tokio::task::JoinHandle<()>>,
    stderr: Option<tokio::task::JoinHandle<()>>,
}

impl ProcessLogReaders {
    fn from_child(id: &str, child: &mut tokio::process::Child) -> Self {
        Self {
            stdout: child
                .stdout
                .take()
                .map(|stdout| process_log_reader(id, ProcessLogStream::Stdout, stdout)),
            stderr: child
                .stderr
                .take()
                .map(|stderr| process_log_reader(id, ProcessLogStream::Stderr, stderr)),
        }
    }

    #[cfg(test)]
    fn new_for_test(
        stdout: Option<tokio::task::JoinHandle<()>>,
        stderr: Option<tokio::task::JoinHandle<()>>,
    ) -> Self {
        Self { stdout, stderr }
    }

    async fn drain_or_abort(mut self) {
        let stdout =
            drain_or_abort_process_log_reader(ProcessLogStream::Stdout, self.stdout.take());
        let stderr =
            drain_or_abort_process_log_reader(ProcessLogStream::Stderr, self.stderr.take());
        let _ = tokio::join!(stdout, stderr);
    }
}

fn process_log_reader<R>(
    id: &str,
    stream: ProcessLogStream,
    reader: R,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let id = id.to_owned();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                stream.log(&id, &line);
            }
        }
    })
}

async fn drain_or_abort_process_log_reader(
    stream: ProcessLogStream,
    handle: Option<tokio::task::JoinHandle<()>>,
) {
    let Some(mut handle) = handle else {
        return;
    };

    match tokio::time::timeout(PROCESS_LOG_READER_DRAIN_TIMEOUT, &mut handle).await {
        Ok(result) => log_process_log_reader_join(stream, result, false),
        Err(_) => {
            info!(
                stream = stream.name(),
                timeout_ms = PROCESS_LOG_READER_DRAIN_TIMEOUT.as_millis() as u64,
                "process log reader did not drain before timeout; aborting"
            );
            handle.abort();
            log_process_log_reader_join(stream, handle.await, true);
        }
    }
}

fn log_process_log_reader_join(
    stream: ProcessLogStream,
    result: Result<(), tokio::task::JoinError>,
    after_abort: bool,
) {
    if let Err(e) = result
        && !(after_abort && e.is_cancelled())
    {
        warn!(
            stream = stream.name(),
            error = %e,
            "process log reader task exited unexpectedly"
        );
    }
}

struct ProcessMonitorContext {
    state: Arc<AtomicU8>,
    state_publish_lock: Arc<Mutex<()>>,
    state_tx: watch::Sender<SandboxState>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    runtime_cancel: CancellationToken,
}

pub struct FirecrackerSandbox {
    pub(crate) config: SandboxConfig,
    factory_config: FirecrackerConfig,
    /// Cached `config.id.to_string()`.
    pub(crate) id: String,
    /// Workspace paths (config, COW — persistent data).
    pub(crate) sandbox_paths: SandboxPaths,
    /// Runtime socket paths (api.sock, vsock).
    pub(crate) sock_paths: SockPaths,
    /// Pooled network namespace metadata plus cleanup ownership.
    pub(crate) network: SandboxNetwork,
    /// NBD COW device (torn down on destroy).
    pub(crate) cow_device: Option<PooledNbdCowDevice>,
    /// Firecracker-local device rate limiters for this sandbox lifecycle.
    device_rate_limits: Option<FirecrackerDeviceRateLimits>,
    /// Per-sandbox runtime task handles.
    runtime: SandboxRuntimeHandles,
    /// Process-group leader PID for the spawned Firecracker wrapper.
    /// Captured at spawn time for cleanup and best-effort host-side OOM
    /// correlation.
    process_group_pid: Option<u32>,
    /// Lifecycle state, shared with the process monitor for crash detection.
    state: Arc<AtomicU8>,
    /// Serializes updates to `state` and `state_tx` so the durable watch state
    /// cannot be overwritten by an older lifecycle transition after the process
    /// monitor publishes a terminal state.
    state_publish_lock: Arc<Mutex<()>>,
    /// Durable lifecycle state stream. Unlike `Notify`, late subscribers see
    /// the latest value, which keeps crash/startup-exit classification
    /// deterministic after the process monitor has already observed exit.
    state_tx: watch::Sender<SandboxState>,
    /// Vsock guest connection, shared with the process monitor so it can
    /// drop the connection immediately when the process exits unexpectedly.
    /// Wrapped in `Arc` so operations can clone the handle and release the
    /// mutex immediately, allowing concurrent vsock operations.
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    /// Host-side park coordinator for same-session idle park safety.
    park_coordinator: ParkCoordinator,
    /// Sender for leaked resource cleanup. When Drop fires without prior
    /// `factory.destroy()`, pool resources are sent here for async cleanup.
    leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    delete_workspace_on_leak_cleanup: bool,
    /// Set to `true` by `factory.destroy()` to suppress Drop-based leak recovery.
    pub(crate) destroyed: bool,
    /// Tracks whether the sandbox is currently in the idle/parked state.
    /// When true, balloon is inflated (for large VMs) and vCPUs are paused.
    /// Set by `park()` on success and cleared by `unpark()`. Used to make
    /// both methods idempotent, to let `unpark()` know whether it should
    /// touch the balloon controller, and to let `stop()` skip vsock
    /// graceful shutdown (guest can't respond with paused vCPUs).
    is_parked: bool,
    /// Host-side normal-operation fence held while this sandbox is parked.
    park_fence: Option<NormalOperationFence>,
}

pub(crate) struct FirecrackerSandboxInit {
    pub(crate) config: SandboxConfig,
    pub(crate) factory_config: FirecrackerConfig,
    pub(crate) sandbox_paths: SandboxPaths,
    pub(crate) sock_paths: SockPaths,
    pub(crate) network: NetnsLease,
    pub(crate) cow_device: PooledNbdCowDevice,
    pub(crate) device_rate_limits: Option<FirecrackerDeviceRateLimits>,
    pub(crate) leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
}

pub(crate) struct SandboxNetwork {
    info: NetnsInfo,
    lease: Option<NetnsLease>,
}

impl SandboxNetwork {
    fn from_lease(lease: NetnsLease) -> Self {
        Self {
            info: lease.info().clone(),
            lease: Some(lease),
        }
    }

    fn name(&self) -> &str {
        self.info.name()
    }

    fn peer_ip(&self) -> &str {
        self.info.peer_ip()
    }

    pub(crate) fn lease_mut(&mut self) -> &mut Option<NetnsLease> {
        &mut self.lease
    }

    pub(crate) fn take_lease(&mut self) -> Option<NetnsLease> {
        self.lease.take()
    }

    pub(crate) fn has_lease(&self) -> bool {
        self.lease.is_some()
    }
}

impl FirecrackerSandbox {
    pub(crate) fn new(init: FirecrackerSandboxInit) -> Self {
        let FirecrackerSandboxInit {
            config,
            factory_config,
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
            device_rate_limits,
            leak_tx,
        } = init;
        let id = config.id.to_string();
        Self {
            config,
            factory_config,
            id,
            sandbox_paths,
            sock_paths,
            network: SandboxNetwork::from_lease(network),
            cow_device: Some(cow_device),
            device_rate_limits,
            runtime: SandboxRuntimeHandles::default(),
            process_group_pid: None,
            state: Arc::new(AtomicU8::new(SandboxState::Created as u8)),
            state_publish_lock: Arc::new(Mutex::new(())),
            state_tx: watch::channel(SandboxState::Created).0,
            guest: Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>)),
            park_coordinator: ParkCoordinator::new(),
            leak_tx,
            delete_workspace_on_leak_cleanup: true,
            destroyed: false,
            is_parked: false,
            park_fence: None,
        }
    }

    pub(crate) fn cow_device(&self) -> sandbox::Result<&PooledNbdCowDevice> {
        self.cow_device.as_ref().ok_or_else(|| SandboxError::Start {
            message: "COW device missing before sandbox start".into(),
        })
    }

    pub(crate) fn preserve_workspace_on_leak_cleanup(&mut self) {
        self.delete_workspace_on_leak_cleanup = false;
    }

    pub(crate) fn allow_workspace_delete_on_leak_cleanup(&mut self) {
        self.delete_workspace_on_leak_cleanup = true;
    }

    fn current_state(&self) -> SandboxState {
        SandboxState::from_u8(self.state.load(Ordering::Acquire))
    }

    fn not_running_error(&self, operation: SandboxOperation) -> SandboxError {
        Self::operation_unavailable_error(operation, self.current_state())
    }

    fn operation_unavailable_error(
        operation: SandboxOperation,
        state: SandboxState,
    ) -> SandboxError {
        if state == SandboxState::Crashed {
            return Self::backend_crashed_error(operation);
        }

        SandboxError::InvalidState {
            context: SandboxInvalidStateContext::Operation(operation),
            state: state.to_string(),
            message: "sandbox not running".into(),
        }
    }

    fn backend_crashed_error(operation: SandboxOperation) -> SandboxError {
        SandboxError::Operation {
            operation,
            reason: SandboxOperationReason::BackendCrashed,
            message: "firecracker process crashed".into(),
        }
    }

    fn operation_error(
        operation: SandboxOperation,
        error: io::Error,
        backend_crashed: bool,
    ) -> SandboxError {
        if backend_crashed {
            return Self::backend_crashed_error(operation);
        }
        let reason = if error.kind() == io::ErrorKind::TimedOut {
            SandboxOperationReason::Timeout
        } else {
            SandboxOperationReason::Guest
        };
        SandboxError::Operation {
            operation,
            reason,
            message: error.to_string(),
        }
    }

    fn operation_gate_closed_error(
        operation: SandboxOperation,
        state: crate::park_coordinator::CoordinatorState,
    ) -> SandboxError {
        SandboxError::InvalidState {
            context: SandboxInvalidStateContext::Operation(operation),
            state: format!("{state:?}"),
            message: "sandbox operation gate closed".into(),
        }
    }

    fn operation_start_error(
        &self,
        operation: SandboxOperation,
        error: GuestOperationStartError,
    ) -> SandboxError {
        match error {
            GuestOperationStartError::BackendCrashed => Self::backend_crashed_error(operation),
            GuestOperationStartError::NotRunning { state } => {
                Self::operation_unavailable_error(operation, state)
            }
            GuestOperationStartError::NoGuest => self.not_running_error(operation),
            GuestOperationStartError::GateClosed { state } => {
                Self::operation_gate_closed_error(operation, state)
            }
        }
    }

    fn has_backend_crashed(&self) -> bool {
        self.current_state() == SandboxState::Crashed
    }

    fn publish_state(&self, state: SandboxState) {
        publish_process_state(&self.state, &self.state_publish_lock, &self.state_tx, state);
    }

    fn guest_operation_start_gate(&self) -> GuestOperationStartGate {
        GuestOperationStartGate::new(Arc::clone(&self.guest), self.park_coordinator.clone())
    }

    async fn begin_guest_operation(
        &self,
        operation: SandboxOperation,
    ) -> sandbox::Result<Arc<VsockHost>> {
        self.guest_operation_start_gate()
            .begin_sandbox_operation(|| self.current_state())
            .await
            .map_err(|error| self.operation_start_error(operation, error))
    }

    async fn run_bounded_guest_operation<T, Fut>(
        &self,
        operation: SandboxOperation,
        call: impl FnOnce(Arc<VsockHost>) -> Fut,
    ) -> sandbox::Result<T>
    where
        Fut: Future<Output = io::Result<T>>,
    {
        enum GuestCallOutcome<T> {
            Returned(io::Result<T>),
            BackendCrashed,
        }

        let vsock = self.begin_guest_operation(operation).await?;

        let outcome = tokio::select! {
            result = call(vsock) => {
                GuestCallOutcome::Returned(result)
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                GuestCallOutcome::BackendCrashed
            }
        };

        match outcome {
            GuestCallOutcome::Returned(Ok(value)) => Ok(value),
            GuestCallOutcome::Returned(Err(error)) => {
                let backend_crashed = self.has_backend_crashed();
                Err(Self::operation_error(operation, error, backend_crashed))
            }
            GuestCallOutcome::BackendCrashed => Err(Self::backend_crashed_error(operation)),
        }
    }

    fn current_state_from(state: &AtomicU8) -> SandboxState {
        SandboxState::from_u8(state.load(Ordering::Acquire))
    }

    fn begin_process_control(
        coordinator: &ParkCoordinator,
        current_state: impl Fn() -> SandboxState,
    ) -> Result<(), GuestOperationStartError> {
        match current_state() {
            SandboxState::Running => {}
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        coordinator
            .ensure_operation_start_allowed()
            .map_err(|error| match error {
                OperationStartRejection::GateClosed { state } => {
                    GuestOperationStartError::GateClosed { state }
                }
            })?;

        match current_state() {
            SandboxState::Running => {}
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        Ok(())
    }

    fn operation_start_io_error(
        operation: SandboxOperation,
        error: GuestOperationStartError,
        current_state: SandboxState,
    ) -> io::Error {
        let error = match error {
            GuestOperationStartError::BackendCrashed => Self::backend_crashed_error(operation),
            GuestOperationStartError::NotRunning { state } => {
                Self::operation_unavailable_error(operation, state)
            }
            GuestOperationStartError::NoGuest => {
                Self::operation_unavailable_error(operation, current_state)
            }
            GuestOperationStartError::GateClosed { state } => {
                Self::operation_gate_closed_error(operation, state)
            }
        };
        io::Error::other(error)
    }

    async fn exec_process_control(
        coordinator: ParkCoordinator,
        state: Arc<AtomicU8>,
        state_rx: watch::Receiver<SandboxState>,
        control: vsock_host::ExecControlHandle,
        message_id: String,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> io::Result<ProcessControlAck> {
        enum ControlOutcome {
            Returned(io::Result<vsock_host::ExecControlAck>),
            BackendCrashed,
        }

        let operation = SandboxOperation::ProcessControl;
        Self::begin_process_control(&coordinator, || Self::current_state_from(&state)).map_err(
            |error| {
                Self::operation_start_io_error(operation, error, Self::current_state_from(&state))
            },
        )?;

        let outcome = tokio::select! {
            result = control.control(
                &message_id,
                &payload,
                timeout,
            ) => ControlOutcome::Returned(result),
            () = wait_for_backend_crash(state_rx) => ControlOutcome::BackendCrashed,
        };

        match outcome {
            ControlOutcome::Returned(Ok(ack)) => Ok(ProcessControlAck {
                message_id: ack.message_id,
            }),
            ControlOutcome::Returned(Err(error)) => {
                if Self::current_state_from(&state) == SandboxState::Crashed {
                    return Err(io::Error::other(Self::backend_crashed_error(operation)));
                }
                Err(error)
            }
            ControlOutcome::BackendCrashed => {
                Err(io::Error::other(Self::backend_crashed_error(operation)))
            }
        }
    }

    /// Atomically transition between states using CAS. Returns `true` if the
    /// transition succeeded, `false` if the current state did not match `from`.
    fn transition(&self, from: SandboxState, to: SandboxState) -> bool {
        transition_process_state(
            &self.state,
            &self.state_publish_lock,
            &self.state_tx,
            from,
            to,
        )
    }

    /// Build the Firecracker JSON configuration for fresh boot.
    fn build_config(&self) -> sandbox::Result<serde_json::Value> {
        let kernel_path = self.factory_config.kernel_path.display().to_string();
        let cow_device_path = self.cow_device()?.device_path().display().to_string();
        let vsock_path = self.sock_paths.vsock().display().to_string();

        build_fresh_boot_firecracker_config(
            &self.config.resources,
            kernel_path,
            cow_device_path,
            vsock_path,
            self.device_rate_limits.as_ref(),
        )
    }

    /// Start using a fresh boot with `--config-file --api-sock`.
    async fn start_fresh(&mut self, runtime_cancel: CancellationToken) -> sandbox::Result<()> {
        let config = self.build_config()?;
        let config_json =
            serde_json::to_string_pretty(&config).map_err(|e| SandboxError::Start {
                message: format!("serialize config: {e}"),
            })?;

        tokio::fs::write(self.sandbox_paths.config(), config_json.as_bytes())
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("write config: {e}"),
            })?;

        let api_sock = self.sock_paths.api_sock();

        let child = tokio::process::Command::new("ip")
            .args(["netns", "exec"])
            .arg(self.network.name())
            .arg(&self.factory_config.binary_path)
            .args(["--config-file"])
            .arg(self.sandbox_paths.config())
            .args(["--api-sock"])
            .arg(&api_sock)
            .current_dir(self.sandbox_paths.workspace())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| SandboxError::Start {
                message: format!("spawn firecracker: {e}"),
            })?;

        self.process_group_pid = child.id();
        self.runtime.set_process(monitor_process(
            &self.id,
            child,
            Arc::clone(&self.state),
            Arc::clone(&self.state_publish_lock),
            self.state_tx.clone(),
            Arc::clone(&self.guest),
            runtime_cancel,
        ));

        // Wait for API socket readiness so the balloon controller can connect.
        let client = ApiClient::new(&api_sock);
        tokio::select! {
            result = client.wait_for_ready(API_READY_TIMEOUT) => {
                result.map_err(|e| {
                    SandboxError::Start {
                        message: format!(
                            "API not ready: {e} (api_sock={})",
                            api_sock.display()
                        ),
                    }
                })?;
            }
            state = wait_for_process_exit(self.state_tx.subscribe()) => {
                return Err(SandboxError::Start {
                    message: format!(
                        "firecracker process exited before API became ready (state={state}, api_sock={})",
                        api_sock.display()
                    ),
                });
            }
        }

        info!(id = %self.id, "firecracker started (fresh boot)");
        Ok(())
    }

    /// Start from a snapshot using `--api-sock` and bind mounts.
    async fn start_from_snapshot(
        &mut self,
        runtime_cancel: CancellationToken,
    ) -> sandbox::Result<()> {
        let snapshot =
            self.factory_config
                .snapshot
                .as_ref()
                .ok_or_else(|| SandboxError::Start {
                    message: "missing snapshot config".into(),
                })?;

        // Ensure bind mount target directories exist.
        tokio::fs::create_dir_all(&snapshot.vsock_bind_dir)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("mkdir snapshot vsock: {e}"),
            })?;

        ensure_snapshot_drive_bind_target(&snapshot.drive_bind_path).await?;

        // Verify sock dir exists before spawning — if this fails, we know
        // the directory was never created or was removed before spawn.
        let api_sock = self.sock_paths.api_sock();
        let sock_dir = self.sock_paths.dir();
        let sock_dir_exists = tokio::fs::try_exists(sock_dir).await.unwrap_or(false);
        if !sock_dir_exists {
            return Err(SandboxError::Start {
                message: format!("sock dir missing before spawn: {}", sock_dir.display()),
            });
        }
        let cow_device_path = self.cow_device()?.device_path();
        info!(
            id = %self.id,
            api_sock = %api_sock.display(),
            sock_dir = %sock_dir.display(),
            cow_device = %cow_device_path.display(),
            netns = %self.network.name(),
            binary = %self.factory_config.binary_path.display(),
            "spawning firecracker (snapshot restore)"
        );

        // Use positional args ($1..$7) to avoid shell injection from paths.
        //
        // Bind mount targets ($2, $4) are snapshot-level paths shared by all
        // sandboxes.  Each sandbox runs inside `unshare --mount`, so bind
        // mounts are per-namespace and don't conflict.
        //
        // IMPORTANT: we must NOT `rm -f` the bind mount target.  The target
        // file is shared across all mount namespaces via the underlying
        // filesystem.  Deleting it would orphan bind mounts in other
        // namespaces (their mount is on the old dentry, but the directory
        // now points to a replacement dentry), causing Firecracker to
        // see an empty file instead of the dm device → Permission denied.
        //
        // `umount` clears any stale mount inherited from the parent
        // namespace (e.g. from a crashed snapshot creation).
        let child = tokio::process::Command::new("unshare")
            .args(UNSHARE_MOUNT_ARGS)
            .args(["bash", "-c", SNAPSHOT_RESTORE_INNER_CMD, "_"])
            .arg(self.sock_paths.vsock_dir()) // $1
            .arg(&snapshot.vsock_bind_dir) // $2
            .arg(cow_device_path) // $3
            .arg(&snapshot.drive_bind_path) // $4
            .arg(self.network.name()) // $5
            .arg(&self.factory_config.binary_path) // $6
            .arg(&api_sock) // $7
            .current_dir(self.sandbox_paths.workspace())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| SandboxError::Start {
                message: format!("spawn firecracker: {e}"),
            })?;

        self.process_group_pid = child.id();
        self.runtime.set_process(monitor_process(
            &self.id,
            child,
            Arc::clone(&self.state),
            Arc::clone(&self.state_publish_lock),
            self.state_tx.clone(),
            Arc::clone(&self.guest),
            runtime_cancel,
        ));

        // Wait for Firecracker API to be ready, but bail early if the
        // process crashes before the socket appears.
        let client = ApiClient::new(&api_sock);
        tokio::select! {
            result = client.wait_for_ready(API_READY_TIMEOUT) => {
                result.map_err(|e| {
                    let sock_dir_after = sock_dir.exists();
                    SandboxError::Start {
                        message: format!(
                            "API not ready: {e} (api_sock={}, sock_dir_exists_after={sock_dir_after})",
                            api_sock.display()
                        ),
                    }
                })?;
            }
            state = wait_for_process_exit(self.state_tx.subscribe()) => {
                return Err(SandboxError::Start {
                    message: format!(
                        "firecracker process exited before API became ready (state={state}, api_sock={})",
                        api_sock.display()
                    ),
                });
            }
        }

        let snapshot_str = snapshot.snapshot_path.display().to_string();
        let memory_str = snapshot.memory_path.display().to_string();
        load_snapshot_and_apply_rate_limits(
            &client,
            &snapshot_str,
            &memory_str,
            self.device_rate_limits.as_ref(),
        )
        .await?;

        info!(id = %self.id, "snapshot loaded and resumed");
        Ok(())
    }
}

async fn abort_and_join<T>(task: tokio::task::JoinHandle<T>) {
    task.abort();
    let _ = task.await;
}

impl Drop for FirecrackerSandbox {
    fn drop(&mut self) {
        // Drop cannot await async teardown, so fall back to synchronous
        // runtime aborts and ask the monitor to kill the process group.
        self.runtime.abort_for_drop();
        // Dropping the task handle detaches it; the monitor still owns and
        // reaps the `Child` while the runtime is alive.

        // If factory.destroy() was not called, send pool resources to the
        // async cleanup channel so they can be released without blocking.
        // The owned pooled COW device carries the pool lease; copied device
        // indices are diagnostics only and are not release authority.
        if !self.destroyed
            && let Some(tx) = self.leak_tx.take()
        {
            let resources = LeakedResources {
                sandbox_id: self.id.clone(),
                cow_device: self.cow_device.take(),
                network: self.network.take_lease(),
                sock_dir: self.sock_paths.dir().to_owned(),
                workspace: self.sandbox_paths.workspace().to_owned(),
                delete_workspace: self.delete_workspace_on_leak_cleanup,
            };
            if tx.send(resources).is_err() {
                tracing::warn!(
                    id = %self.id,
                    "leak cleanup channel closed — resources will require runner gc"
                );
            }
        }
    }
}

/// Wait until the durable lifecycle stream observes the backend process exit.
async fn wait_for_process_exit(mut state_rx: watch::Receiver<SandboxState>) -> SandboxState {
    loop {
        let state = *state_rx.borrow_and_update();
        if matches!(state, SandboxState::Stopped | SandboxState::Crashed) {
            return state;
        }
        if state_rx.changed().await.is_err() {
            return *state_rx.borrow();
        }
    }
}

/// Wait until the durable lifecycle stream observes an unexpected backend exit.
async fn wait_for_backend_crash(mut state_rx: watch::Receiver<SandboxState>) {
    loop {
        if *state_rx.borrow_and_update() == SandboxState::Crashed {
            return;
        }
        if state_rx.changed().await.is_err() {
            return;
        }
    }
}

fn state_publish_guard(state_publish_lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    state_publish_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn publish_watch_state(state_tx: &watch::Sender<SandboxState>, state: SandboxState) {
    let _ = state_tx.send_replace(state);
}

fn publish_process_state(
    state: &AtomicU8,
    state_publish_lock: &Mutex<()>,
    state_tx: &watch::Sender<SandboxState>,
    next: SandboxState,
) {
    let _guard = state_publish_guard(state_publish_lock);
    state.store(next as u8, Ordering::Release);
    publish_watch_state(state_tx, next);
}

fn transition_process_state(
    state: &AtomicU8,
    state_publish_lock: &Mutex<()>,
    state_tx: &watch::Sender<SandboxState>,
    from: SandboxState,
    to: SandboxState,
) -> bool {
    let _guard = state_publish_guard(state_publish_lock);
    let transitioned = state
        .compare_exchange(from as u8, to as u8, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();
    if transitioned {
        publish_watch_state(state_tx, to);
    }
    transitioned
}

/// Monitor the child process for exit and forward logs.
///
/// The process monitor owns the `Child`, so process exit is classified from
/// `wait()` rather than from stdout/stderr pipe EOF. Stdout and stderr readers
/// are only log forwarders.
fn monitor_process(
    id: &str,
    mut child: tokio::process::Child,
    state: Arc<AtomicU8>,
    state_publish_lock: Arc<Mutex<()>>,
    state_tx: watch::Sender<SandboxState>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    runtime_cancel: CancellationToken,
) -> ProcessMonitorHandle {
    let readers = ProcessLogReaders::from_child(id, &mut child);
    let context = ProcessMonitorContext {
        state,
        state_publish_lock,
        state_tx,
        guest,
        runtime_cancel,
    };
    monitor_process_with_log_readers(id, child, context, readers)
}

fn monitor_process_with_log_readers(
    id: &str,
    mut child: tokio::process::Child,
    context: ProcessMonitorContext,
    readers: ProcessLogReaders,
) -> ProcessMonitorHandle {
    let process_group_pid = child.id();
    let id = id.to_owned();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status,
            request = kill_rx.recv() => {
                if request.is_some() {
                    kill_process_group(&child);
                }
                child.wait().await
            }
        };
        match &status {
            Ok(status) => trace!(id = %id, %status, "process monitor observed exit"),
            Err(error) => warn!(id = %id, %error, "process monitor failed to wait for child"),
        }
        context.runtime_cancel.cancel();

        let prev = {
            let _guard = state_publish_guard(&context.state_publish_lock);
            match context.state.compare_exchange(
                SandboxState::Running as u8,
                SandboxState::Crashed as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(v) => {
                    publish_watch_state(&context.state_tx, SandboxState::Crashed);
                    SandboxState::from_u8(v)
                }
                Err(v) => {
                    let prev = SandboxState::from_u8(v);
                    if matches!(
                        prev,
                        SandboxState::Created | SandboxState::Stopping | SandboxState::Stopped
                    ) {
                        context
                            .state
                            .store(SandboxState::Stopped as u8, Ordering::Release);
                        publish_watch_state(&context.state_tx, SandboxState::Stopped);
                    }
                    prev
                }
            }
        };

        match prev {
            SandboxState::Running => {
                if let Some(pid) = process_group_pid {
                    kill_process_group_by_pid(pid);
                }
                match status {
                    Ok(status) => warn!(id = %id, %status, "process exited unexpectedly"),
                    Err(error) => warn!(id = %id, %error, "process wait failed unexpectedly"),
                }
                context.guest.lock().await.take();
            }
            SandboxState::Created | SandboxState::Stopping | SandboxState::Stopped => {}
            SandboxState::Crashed => {}
        }
        readers.drain_or_abort().await;
    });

    ProcessMonitorHandle { kill_tx, task }
}

fn process_timeout_policy(timeout_ms: u32) -> ExecTimeoutPolicy {
    if timeout_ms == 0 {
        ExecTimeoutPolicy::None
    } else {
        ExecTimeoutPolicy::Duration { timeout_ms }
    }
}

fn process_stdout_policy(output: ProcessOutputMode) -> ExecOutputPolicy {
    match output {
        ProcessOutputMode::Buffered { output_limits } => ExecOutputPolicy::Capture {
            limit_bytes: output_limits.stdout_limit_bytes,
        },
        ProcessOutputMode::Stream {
            stream_limit_bytes,
            chunk_limit_bytes,
            ..
        } => ExecOutputPolicy::Stream {
            limit_bytes: stream_limit_bytes,
            chunk_limit_bytes,
        },
    }
}

fn process_stderr_policy(output: ProcessOutputMode) -> ExecOutputPolicy {
    match output {
        ProcessOutputMode::Buffered { output_limits } => ExecOutputPolicy::Capture {
            limit_bytes: output_limits.stderr_limit_bytes,
        },
        ProcessOutputMode::Stream { .. } => ExecOutputPolicy::Discard,
    }
}

fn process_stream_queue_capacity(output: ProcessOutputMode) -> Option<usize> {
    match output {
        ProcessOutputMode::Buffered { .. } => None,
        ProcessOutputMode::Stream { queue_capacity, .. } => Some(queue_capacity),
    }
}

fn captured_output_bytes(output: ExecOwnedCapturedOutput) -> (Vec<u8>, bool) {
    match output {
        ExecOwnedCapturedOutput::Discarded => (Vec::new(), false),
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => (bytes, truncated),
    }
}

fn append_diagnostic(stderr: &mut Vec<u8>, diagnostic: &str) {
    if diagnostic.is_empty() {
        return;
    }
    if !stderr.is_empty() && !stderr.ends_with(b"\n") {
        stderr.push(b'\n');
    }
    stderr.extend_from_slice(diagnostic.as_bytes());
}

fn supervised_exec_result_to_process_exit(
    pid: u32,
    result: vsock_host::ExecOperationResult,
) -> ProcessExit {
    let (stdout, stdout_truncated) = captured_output_bytes(result.stdout);
    let (mut stderr, stderr_truncated) = captured_output_bytes(result.stderr);
    let exit_code = match result.termination {
        ExecTermination::Exited { exit_code } => exit_code,
        ExecTermination::TimedOut => {
            if stderr.is_empty() {
                stderr.extend_from_slice(b"Timeout");
            }
            EXEC_TIMEOUT_EXIT_CODE
        }
        ExecTermination::Cancelled => {
            if stderr.is_empty() {
                stderr.extend_from_slice(b"Cancelled");
            }
            append_diagnostic(&mut stderr, &result.diagnostic);
            1
        }
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            append_diagnostic(&mut stderr, &result.diagnostic);
            1
        }
    };

    ProcessExit {
        pid,
        exit_code,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic: result.diagnostic,
        stream_overflowed: result.stream_overflowed,
    }
}

fn supervised_stdout_receiver(
    mut stream_rx: mpsc::Receiver<ExecOutputEvent>,
    queue_capacity: usize,
) -> (
    sandbox::ProcessOutputReceiver,
    Box<dyn FnOnce() + Send + 'static>,
) {
    let (stdout_tx, stdout_rx) = mpsc::channel(queue_capacity.max(1));
    let stdout_closed = stdout_tx.clone();
    let close = CancellationToken::new();
    let task_close = close.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = task_close.cancelled() => {
                    break;
                }
                () = stdout_closed.closed() => {
                    break;
                }
                event = stream_rx.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    match event.stream {
                        ExecOutputStream::Stdout => {
                            let chunk = ProcessOutputChunk {
                                bytes: event.chunk,
                                truncated: event.truncated,
                            };
                            tokio::select! {
                                biased;
                                () = task_close.cancelled() => {
                                    break;
                                }
                                result = stdout_tx.send(chunk) => {
                                    if result.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                        ExecOutputStream::Stderr => {
                            warn!(
                                output_seq = event.output_seq,
                                "discarding unexpected stderr event from stdout-only process stream"
                            );
                        }
                    }
                }
            }
        }
    });

    (
        stdout_rx,
        Box::new(move || {
            close.cancel();
        }),
    )
}

#[async_trait]
impl Sandbox for FirecrackerSandbox {
    // -- identity --

    fn id(&self) -> &str {
        &self.id
    }

    fn source_ip(&self) -> &str {
        self.network.peer_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.process_group_pid
    }

    // -- lifecycle --

    async fn start(&mut self) -> sandbox::Result<()> {
        if self.current_state() != SandboxState::Created {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Sandbox,
                state: self.current_state().to_string(),
                message: "sandbox already started".into(),
            });
        }

        let runtime_cancel = CancellationToken::new();

        // Start the vsock listener BEFORE launching Firecracker.
        // The UDS must be bound before the guest tries to connect.
        let vsock_path = self.sock_paths.vsock().display().to_string();
        let mut vsock_task = tokio::spawn(async move {
            VsockHost::wait_for_connection(&vsock_path, VSOCK_CONNECT_TIMEOUT).await
        });

        let start_result = if self.factory_config.snapshot.is_some() {
            self.start_from_snapshot(runtime_cancel.clone()).await
        } else {
            self.start_fresh(runtime_cancel.clone()).await
        };

        if let Err(e) = start_result {
            abort_and_join(vsock_task).await;
            self.runtime.kill_process().await;
            return Err(e);
        }

        // Wait for guest to connect via vsock.
        let vsock_guest = tokio::select! {
            result = &mut vsock_task => {
                match result {
                    Ok(Ok(g)) => g,
                    Ok(Err(e)) => {
                        self.runtime.kill_process().await;
                        return Err(SandboxError::Start {
                            message: format!("vsock connection: {e}"),
                        });
                    }
                    Err(e) => {
                        self.runtime.kill_process().await;
                        return Err(SandboxError::Start {
                            message: format!("vsock task: {e}"),
                        });
                    }
                }
            }
            state = wait_for_process_exit(self.state_tx.subscribe()) => {
                abort_and_join(vsock_task).await;
                self.runtime.kill_process().await;
                return Err(SandboxError::Start {
                    message: format!("process exited before vsock connected (state={state})"),
                });
            }
        };

        *self.guest.lock().await = Some(Arc::new(vsock_guest));

        let control_sock_path = self.sock_paths.control_sock();
        let control_server = match control::bind_server(
            control_sock_path.clone(),
            self.guest_operation_start_gate(),
        ) {
            Ok(server) => server,
            Err(e) => {
                self.guest.lock().await.take();
                self.runtime.kill_process().await;
                return Err(SandboxError::Start {
                    message: format!("control socket bind {}: {e}", control_sock_path.display()),
                });
            }
        };

        // Use CAS to avoid overwriting Stopped if the process crashed between
        // spawn and vsock connect (the process monitor may have already
        // recorded process exit).
        if !self.transition(SandboxState::Created, SandboxState::Running) {
            self.guest.lock().await.take();
            control_server.close();
            self.runtime.kill_process().await;
            return Err(SandboxError::Start {
                message: "process exited during startup".into(),
            });
        }

        // Start control socket server for `runner exec`.
        self.runtime
            .set_control(control_server.spawn(runtime_cancel));

        // Spawn balloon controller to reclaim unused guest memory.
        self.runtime.set_balloon(balloon::spawn(
            self.sock_paths.api_sock().to_owned(),
            self.config.resources.memory_mb,
            self.state_tx.subscribe(),
        ));

        info!(id = %self.id, "sandbox started");
        Ok(())
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            if self.current_state() == SandboxState::Crashed {
                self.runtime.shutdown_services().await;
                self.guest.lock().await.take();
                release_park_state_for_termination(&mut self.is_parked, &mut self.park_fence);
                self.runtime.kill_process().await;
            }
            return Ok(());
        }

        self.runtime.shutdown_services().await;
        // The control server is awaited so its socket path becomes
        // undiscoverable before teardown continues. The balloon controller is
        // only aborted: stop() is about to kill the FC process entirely, so
        // any in-flight controller PATCH against the dying API socket is
        // harmless.

        // Skip vsock graceful shutdown for parked sandboxes — vCPUs are
        // paused and cannot process the message. No in-flight user work
        // to clean up. Go straight to force-kill.
        //
        // Edge case: after a partial unpark failure (resume succeeded but
        // deflate failed), is_parked is true but vCPUs are actually running.
        // Skipping graceful shutdown is still correct — the sandbox was idle
        // with no user workload.
        let was_parked = self.is_parked;
        let guest = self.guest.lock().await.take();
        if !was_parked
            && let Some(guest) = guest
            && !guest.shutdown(SHUTDOWN_TIMEOUT).await
        {
            warn!(id = %self.id, "graceful shutdown timed out");
        }
        release_park_state_for_termination(&mut self.is_parked, &mut self.park_fence);

        self.runtime.kill_process().await;
        self.publish_state(SandboxState::Stopped);
        info!(id = %self.id, "sandbox stopped");
        Ok(())
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            if self.current_state() == SandboxState::Crashed {
                self.runtime.shutdown_services().await;
                self.guest.lock().await.take();
                release_park_state_for_termination(&mut self.is_parked, &mut self.park_fence);
                self.runtime.kill_process().await;
            }
            return Ok(());
        }
        self.runtime.shutdown_services().await;
        self.guest.lock().await.take();
        release_park_state_for_termination(&mut self.is_parked, &mut self.park_fence);
        self.runtime.kill_process().await;
        self.publish_state(SandboxState::Stopped);
        info!(id = %self.id, "sandbox killed");
        Ok(())
    }

    // -- idle transitions --
    //
    // `park()` is called by the runner when a sandbox is handed off to the
    // idle pool. It stops the reactive balloon controller, inflates the
    // balloon to reclaim guest memory, waits for inflation to complete,
    // then pauses vCPUs to eliminate idle CPU overhead (timer ticks,
    // kernel scheduling). Ordering: inflate before pause — the guest
    // balloon driver needs running vCPUs to process the inflate.
    //
    // `unpark()` is called when the runner pulls the sandbox back out of
    // the idle pool. It resumes vCPUs, deflates the balloon, and respawns
    // the reactive controller so active workload is served with full
    // memory again. Ordering: resume before deflate — the guest needs
    // running vCPUs to process the deflate.
    //
    // Park first closes the sandbox policy gate, then acquires a host-side
    // vsock normal-operation fence before guest lifecycle quiesce. Unpark
    // resumes the guest, releases the vsock fence, then reopens the policy
    // gate. Both methods propagate guest lifecycle, operation-gate, fence, and
    // Firecracker PATCH failures as `IdleTransition(Park|Unpark)` errors. On
    // failure the caller (runner) destroys the sandbox and falls through to
    // fresh-create. Firecracker's pause/resume returns 400 when the VM is
    // already in the target state; within park/unpark this only happens after
    // a partial retry, so 400 is treated as success (idempotent).
    //
    // For profiles where `memory_mb <= MIN_GUEST_MIB` there is no memory
    // to reclaim (balloon is skipped), but vCPUs are still paused — timer
    // ticks waste CPU regardless of memory size.
    //
    // The `is_parked` flag handles healthy idempotent calls and lets unpark
    // skip the abort+respawn dance when park was a no-op. The operation
    // coordinator is still checked on no-op paths so Dirty/desynchronised gates
    // cannot be silently reused.

    async fn park(&mut self) -> sandbox::Result<()> {
        if self.is_parked {
            if self.park_fence.is_none() {
                let message = "sandbox is parked without a normal-operation fence";
                self.park_coordinator.mark_dirty(DirtyReason::new(message));
                return Err(idle_transition_error(SandboxIdleTransition::Park, message));
            }
            return ensure_park_noop_state(&self.park_coordinator);
        }

        let coordinator = self.park_coordinator.clone();
        let guest = Arc::clone(&self.guest);
        let fence_guest = Arc::clone(&guest);
        let id = self.id.clone();
        let api_sock = self.sock_paths.api_sock();
        let normal_operations_fence = park_with_ready_for_park(
            &id,
            &coordinator,
            || async move {
                let guest = fence_guest.lock().await.as_ref().cloned().ok_or_else(|| {
                    ParkNormalOperationFenceError::GuestUnavailable(io::Error::new(
                        io::ErrorKind::NotConnected,
                        "guest connection missing during park fence",
                    ))
                })?;
                guest
                    .try_fence_normal_operations()
                    .map_err(ParkNormalOperationFenceError::Rejected)
            },
            || async move {
                let guest = guest.lock().await.as_ref().cloned().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotConnected,
                        "guest connection missing during park quiesce",
                    )
                })?;
                guest.quiesce_operations(GUEST_PARK_LIFECYCLE_TIMEOUT).await
            },
            || {
                park_inner(
                    &mut self.is_parked,
                    self.config.resources.memory_mb,
                    self.runtime.balloon_mut(),
                    &api_sock,
                    &id,
                )
            },
        )
        .await?;
        self.park_fence = Some(normal_operations_fence);
        Ok(())
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        if !self.is_parked {
            if self.park_fence.is_some() {
                let message = "sandbox has a normal-operation fence while unpark is a no-op";
                self.park_coordinator.mark_dirty(DirtyReason::new(message));
                return Err(idle_transition_error(
                    SandboxIdleTransition::Unpark,
                    message,
                ));
            }
            return ensure_unpark_noop_state(&self.park_coordinator);
        }
        if self.park_fence.is_none() {
            let message = "sandbox is parked without a normal-operation fence";
            self.park_coordinator.mark_dirty(DirtyReason::new(message));
            return Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                message,
            ));
        }

        let coordinator = self.park_coordinator.clone();
        let guest = Arc::clone(&self.guest);
        let id = self.id.clone();
        let api_sock = self.sock_paths.api_sock();
        let memory_mb = self.config.resources.memory_mb;
        let state_rx = self.state_tx.subscribe();
        let is_parked = &mut self.is_parked;
        let balloon_controller = self.runtime.balloon_mut();
        let park_fence = &mut self.park_fence;
        unpark_with_ready_for_operations(
            &id,
            &coordinator,
            || {
                unpark_inner(
                    is_parked,
                    memory_mb,
                    balloon_controller,
                    &api_sock,
                    state_rx,
                    &id,
                )
            },
            || async move {
                let guest = guest.lock().await.as_ref().cloned().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotConnected,
                        "guest connection missing during unpark resume",
                    )
                })?;
                guest.resume_operations(GUEST_PARK_LIFECYCLE_TIMEOUT).await
            },
            || {
                drop(park_fence.take());
            },
        )
        .await
    }

    // -- operations --
    //
    // Each operation races the vsock call against the durable lifecycle stream.
    // Late subscribers observe `Crashed` immediately, so crash classification
    // does not depend on catching a one-shot notification while select! is
    // already polling.

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::Exec;
        let limits = request.output_limits;
        let timeout_ms = request.timeout_ms();

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest
                .exec_capture(vsock_host::ExecCaptureRequest {
                    command: request.cmd,
                    timeout_ms,
                    env: request.env,
                    sudo: request.sudo,
                    label: "sandbox-exec",
                    stdout_limit_bytes: limits.stdout_limit_bytes,
                    stderr_limit_bytes: limits.stderr_limit_bytes,
                    expected_exit_codes: &[],
                    wait_timeout: Duration::from_millis(timeout_ms as u64 + 5000),
                })
                .await
                .map(|result| ExecResult {
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    stdout_truncated: result.stdout_truncated,
                    stderr_truncated: result.stderr_truncated,
                })
        })
        .await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        let operation = SandboxOperation::Exec;

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.read_file(path, max_bytes, 5000).await
        })
        .await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<CopyFileResult> {
        let operation = SandboxOperation::Exec;
        let timeout_ms = options.timeout_ms();

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest
                .copy_file(
                    path,
                    host_path,
                    vsock_host::CopyFileOptions {
                        max_bytes: options.max_bytes,
                        timeout_ms,
                        missing_ok: options.missing_ok,
                    },
                )
                .await
                .map(|result| CopyFileResult {
                    bytes_copied: result.bytes_copied,
                })
        })
        .await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let operation = SandboxOperation::WriteFile;

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.write_file(path, content, false).await
        })
        .await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<GuestProcessHandle> {
        let operation = SandboxOperation::StartProcess;
        let vsock = self.begin_guest_operation(operation).await?;

        let start_future = async move {
            vsock
                .start_supervised_exec(SupervisedExecRequest {
                    timeout: process_timeout_policy(request.timeout_ms()),
                    command: request.cmd,
                    env: request.env,
                    sudo: request.sudo,
                    label: request.cmd,
                    stdout: process_stdout_policy(request.output),
                    stderr: process_stderr_policy(request.output),
                    expected_exit_codes: &[],
                    control: match request.control {
                        ProcessControlMode::None => SupervisedExecControl::Disabled,
                        ProcessControlMode::Enabled => {
                            SupervisedExecControl::Enabled { sink: true }
                        }
                    },
                    stream_queue_capacity: process_stream_queue_capacity(request.output),
                    start_timeout: PROCESS_START_ACK_TIMEOUT,
                })
                .await
        };

        tokio::select! {
            result = start_future => {
                let mut handle = match result {
                    Ok(handle) => handle,
                    Err(error) => {
                        let backend_crashed = self.has_backend_crashed();
                        return Err(Self::operation_error(operation, error, backend_crashed));
                    }
                };
                let pid = handle.pid();
                let process_control = handle.control_handle().map(|control| {
                    let coordinator = self.park_coordinator.clone();
                    let state = Arc::clone(&self.state);
                    let state_rx = self.state_tx.subscribe();
                    GuestProcessControlHandle::new(move |message_id, payload, timeout| {
                        let control = control.clone();
                        let coordinator = coordinator.clone();
                        let state = Arc::clone(&state);
                        let state_rx = state_rx.clone();
                        Box::pin(async move {
                            Self::exec_process_control(
                                coordinator, state, state_rx, control, message_id, payload, timeout,
                            )
                            .await
                        })
                    })
                });
                let (stdout_rx, close_stdout) = if request.output.streams_stdout() {
                    match handle.take_stream_receiver() {
                        Some(stream_rx) => {
                            let queue_capacity = process_stream_queue_capacity(request.output)
                                .unwrap_or(ProcessOutputMode::DEFAULT_QUEUE_CAPACITY);
                            let (stdout_rx, close_stdout) =
                                supervised_stdout_receiver(stream_rx, queue_capacity);
                            (Some(stdout_rx), Some(close_stdout))
                        }
                        None => (None, None),
                    }
                } else {
                    (None, None)
                };
                let process_cancel = handle.take_cancel_handle().map(|cancel| {
                    GuestProcessCancelHandle::new(move |timeout| {
                        Box::pin(async move { cancel.cancel(timeout).await })
                    })
                });
                let wait = GuestProcessWaiter::new(move |timeout| {
                    Box::pin(async move {
                        let result = handle.wait(timeout).await?;
                        Ok(supervised_exec_result_to_process_exit(pid, result))
                    })
                });
                let mut public_handle =
                    GuestProcessHandle::new(pid, stdout_rx, process_control, wait);
                if let Some(process_cancel) = process_cancel {
                    public_handle = public_handle.with_cancel_handle(process_cancel);
                }
                Ok(match close_stdout {
                    Some(close_stdout) => public_handle.with_unclaimed_stdout_cleanup(close_stdout),
                    None => public_handle,
                })
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }

    async fn wait_process(
        &self,
        mut handle: GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let operation = SandboxOperation::WaitProcess;
        let waiter = handle.take_waiter().ok_or_else(|| {
            Self::operation_error(
                operation,
                std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "start_process handle already consumed",
                ),
                self.has_backend_crashed(),
            )
        })?;
        // `wait_process` consumes the handle; an unclaimed stream receiver can no
        // longer be observed by the caller and would otherwise buffer forever.
        handle.drop_unclaimed_stdout();
        let mut wait = waiter.wait(timeout);

        tokio::select! {
            biased;
            result = &mut wait => {
                result.map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }
}

enum ParkBoundaryGuardState {
    Closing,
    NormalOperationsFenced,
    GuestQuiesceStarted,
    ReadyForPark,
    Disarmed,
}

enum ParkNormalOperationFenceError {
    GuestUnavailable(io::Error),
    Rejected(NormalOperationFenceRejection),
}

struct ParkBoundaryGuard<Fence> {
    coordinator: ParkCoordinator,
    attempt: ParkAttempt,
    state: ParkBoundaryGuardState,
    normal_operations_fence: Option<Fence>,
}

impl<Fence> ParkBoundaryGuard<Fence> {
    fn new(coordinator: ParkCoordinator, attempt: ParkAttempt) -> Self {
        Self {
            coordinator,
            attempt,
            state: ParkBoundaryGuardState::Closing,
            normal_operations_fence: None,
        }
    }

    fn mark_normal_operations_fenced(&mut self, fence: Fence) {
        self.normal_operations_fence = Some(fence);
        self.state = ParkBoundaryGuardState::NormalOperationsFenced;
    }

    fn mark_guest_quiesce_started(&mut self) {
        self.state = ParkBoundaryGuardState::GuestQuiesceStarted;
    }

    fn complete_prepare(&mut self) -> Result<(), PrepareParkError> {
        self.coordinator
            .complete_prepare_park(&self.attempt, PrepareParkEvidence::AgentQuiesced)?;
        self.state = ParkBoundaryGuardState::ReadyForPark;
        Ok(())
    }

    fn mark_dirty(mut self, reason: impl Into<String>) {
        self.coordinator.mark_dirty(DirtyReason::new(reason));
        self.state = ParkBoundaryGuardState::Disarmed;
    }

    fn mark_parked(mut self) -> Result<Fence, PrepareParkError> {
        match self.coordinator.mark_parked(&self.attempt) {
            Ok(()) => {
                self.state = ParkBoundaryGuardState::Disarmed;
                match self.normal_operations_fence.take() {
                    Some(fence) => Ok(fence),
                    None => {
                        let reason =
                            DirtyReason::new("park completed without a normal-operation fence");
                        self.coordinator.mark_dirty(reason.clone());
                        Err(PrepareParkError::Dirty { reason })
                    }
                }
            }
            Err(error) => {
                let message = format!(
                    "park policy failed to mark parked after Firecracker park: {}",
                    prepare_park_error_message(&error)
                );
                self.coordinator
                    .mark_dirty(DirtyReason::new(message.clone()));
                self.state = ParkBoundaryGuardState::Disarmed;
                Err(error)
            }
        }
    }
}

impl<Fence> Drop for ParkBoundaryGuard<Fence> {
    fn drop(&mut self) {
        match self.state {
            ParkBoundaryGuardState::Closing => {
                let _ = self.coordinator.abort_prepare_park(&self.attempt);
            }
            ParkBoundaryGuardState::NormalOperationsFenced => {
                drop(self.normal_operations_fence.take());
                let _ = self.coordinator.abort_prepare_park(&self.attempt);
            }
            ParkBoundaryGuardState::GuestQuiesceStarted => {
                self.coordinator.mark_dirty(DirtyReason::new(
                    "park attempt dropped after guest quiesce started",
                ));
            }
            ParkBoundaryGuardState::ReadyForPark => {
                self.coordinator
                    .mark_dirty(DirtyReason::new("park attempt dropped after ReadyForPark"));
            }
            ParkBoundaryGuardState::Disarmed => {}
        }
    }
}

enum UnparkBoundaryGuardState {
    FirecrackerResumeStarted,
    FirecrackerResumed,
    Disarmed,
}

struct UnparkBoundaryGuard {
    coordinator: ParkCoordinator,
    state: UnparkBoundaryGuardState,
}

impl UnparkBoundaryGuard {
    fn new(coordinator: ParkCoordinator) -> Self {
        Self {
            coordinator,
            state: UnparkBoundaryGuardState::FirecrackerResumeStarted,
        }
    }

    fn mark_firecracker_resumed(&mut self) {
        self.state = UnparkBoundaryGuardState::FirecrackerResumed;
    }

    fn mark_dirty(mut self, reason: impl Into<String>) {
        self.coordinator.mark_dirty(DirtyReason::new(reason));
        self.state = UnparkBoundaryGuardState::Disarmed;
    }

    fn disarm(&mut self) {
        self.state = UnparkBoundaryGuardState::Disarmed;
    }
}

impl Drop for UnparkBoundaryGuard {
    fn drop(&mut self) {
        match self.state {
            UnparkBoundaryGuardState::FirecrackerResumeStarted => {
                self.coordinator.mark_dirty(DirtyReason::new(
                    "unpark attempt dropped during Firecracker resume before guest operations reopened",
                ));
            }
            UnparkBoundaryGuardState::FirecrackerResumed => {
                self.coordinator.mark_dirty(DirtyReason::new(
                    "unpark attempt dropped after Firecracker resume before guest operations reopened",
                ));
            }
            UnparkBoundaryGuardState::Disarmed => {}
        }
    }
}

fn release_park_state_for_termination<Fence>(is_parked: &mut bool, park_fence: &mut Option<Fence>) {
    *is_parked = false;
    drop(park_fence.take());
}

async fn park_with_ready_for_park<Fence, F, FF, Q, QF, P, PF>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    fence_normal_operations: F,
    quiesce_guest: Q,
    park_firecracker: P,
) -> sandbox::Result<Fence>
where
    F: FnOnce() -> FF,
    FF: Future<Output = Result<Fence, ParkNormalOperationFenceError>>,
    Q: FnOnce() -> QF,
    QF: Future<Output = io::Result<()>>,
    P: FnOnce() -> PF,
    PF: Future<Output = sandbox::Result<()>>,
{
    info!(
        id = %log_id,
        transition = "park",
        phase = "prepare",
        "sandbox park lifecycle prepare started"
    );
    let attempt = match coordinator.begin_prepare_park() {
        Ok(attempt) => attempt,
        Err(error) => {
            let reason_kind = prepare_park_error_reason_kind(&error);
            let error_message = prepare_park_error_message(&error);
            if matches!(
                error,
                PrepareParkError::InvalidState { .. } | PrepareParkError::StaleAttempt { .. }
            ) {
                coordinator.mark_dirty(DirtyReason::new(format!(
                    "park policy failed to start park prepare: {}",
                    error_message
                )));
            }
            warn!(
                id = %log_id,
                transition = "park",
                phase = "prepare",
                reason_kind = reason_kind,
                error = %error_message,
                "sandbox park lifecycle prepare rejected"
            );
            return Err(prepare_park_error(SandboxIdleTransition::Park, error));
        }
    };
    let mut guard = ParkBoundaryGuard::new(coordinator.clone(), attempt);

    info!(
        id = %log_id,
        transition = "park",
        phase = "normal_operations_fence",
        "sandbox park lifecycle normal-operation fence started"
    );
    match fence_normal_operations().await {
        Ok(fence) => {
            guard.mark_normal_operations_fenced(fence);
        }
        Err(ParkNormalOperationFenceError::Rejected(NormalOperationFenceRejection::Busy)) => {
            warn!(
                id = %log_id,
                transition = "park",
                phase = "normal_operations_fence",
                reason_kind = "busy",
                "sandbox park lifecycle normal-operation fence rejected"
            );
            return Err(idle_transition_error(
                SandboxIdleTransition::Park,
                "normal operations busy while preparing park",
            ));
        }
        Err(ParkNormalOperationFenceError::Rejected(error)) => {
            let message = format!(
                "normal operation fence failed while preparing park: {}",
                normal_operation_fence_rejection_message(error)
            );
            warn!(
                id = %log_id,
                transition = "park",
                phase = "normal_operations_fence",
                reason_kind = normal_operation_fence_rejection_reason_kind(error),
                error = %message,
                "sandbox park lifecycle normal-operation fence failed"
            );
            guard.mark_dirty(message.clone());
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
        Err(ParkNormalOperationFenceError::GuestUnavailable(error)) => {
            let message = format!("guest connection unavailable while fencing park: {error}");
            warn!(
                id = %log_id,
                transition = "park",
                phase = "normal_operations_fence",
                reason_kind = "protocol_or_transport",
                error = %error,
                "sandbox park lifecycle normal-operation fence failed"
            );
            guard.mark_dirty(message.clone());
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
    }

    info!(
        id = %log_id,
        transition = "park",
        phase = "guest_quiesce",
        "sandbox park lifecycle guest quiesce started"
    );
    guard.mark_guest_quiesce_started();
    if let Err(error) = quiesce_guest().await {
        let message = format!("guest quiesce failed during park: {error}");
        warn!(
            id = %log_id,
            transition = "park",
            phase = "guest_quiesce",
            reason_kind = "protocol_or_transport",
            error = %error,
            "sandbox park lifecycle guest quiesce failed"
        );
        guard.mark_dirty(message.clone());
        return Err(idle_transition_error(SandboxIdleTransition::Park, message));
    }

    if let Err(error) = guard.complete_prepare() {
        let reason_kind = prepare_park_error_reason_kind(&error);
        let error_message = prepare_park_error_message(&error);
        let message = format!(
            "park policy failed to enter ReadyForPark: {}",
            error_message
        );
        warn!(
            id = %log_id,
            transition = "park",
            phase = "ready_for_park",
            reason_kind = reason_kind,
            error = %error_message,
            "sandbox park lifecycle failed to enter ReadyForPark"
        );
        guard.mark_dirty(message.clone());
        return Err(idle_transition_error(SandboxIdleTransition::Park, message));
    }

    info!(
        id = %log_id,
        transition = "park",
        phase = "ready_for_park",
        "sandbox park lifecycle ReadyForPark reached"
    );
    if let Err(error) = park_firecracker().await {
        warn!(
            id = %log_id,
            transition = "park",
            phase = "firecracker_park",
            reason_kind = "firecracker",
            error = %error,
            "sandbox park lifecycle Firecracker park failed after ReadyForPark"
        );
        guard.mark_dirty(format!(
            "Firecracker park failed after ReadyForPark: {error}"
        ));
        return Err(error);
    }

    let normal_operations_fence = match guard.mark_parked() {
        Ok(fence) => fence,
        Err(error) => {
            let reason_kind = prepare_park_error_reason_kind(&error);
            let error_message = prepare_park_error_message(&error);
            let message = format!(
                "park policy failed to mark parked after Firecracker park: {}",
                error_message
            );
            warn!(
                id = %log_id,
                transition = "park",
                phase = "parked",
                reason_kind = reason_kind,
                error = %error_message,
                "sandbox park lifecycle failed to mark parked"
            );
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
    };

    info!(
        id = %log_id,
        transition = "park",
        phase = "parked",
        "sandbox park lifecycle marked parked"
    );
    Ok(normal_operations_fence)
}

async fn unpark_with_ready_for_operations<U, UF, R, RF, F>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    unpark_firecracker: U,
    resume_guest: R,
    release_normal_operations_fence: F,
) -> sandbox::Result<()>
where
    U: FnOnce() -> UF,
    UF: Future<Output = sandbox::Result<()>>,
    R: FnOnce() -> RF,
    RF: Future<Output = io::Result<()>>,
    F: FnOnce(),
{
    info!(
        id = %log_id,
        transition = "unpark",
        phase = "start",
        "sandbox unpark lifecycle started"
    );
    let pre_unpark_state = coordinator.state();
    if let Err(error) = ensure_parked_before_unpark(coordinator) {
        let reason_kind = match pre_unpark_state {
            CoordinatorState::Dirty { .. } => "dirty",
            _ => "invalid_state",
        };
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "start",
            reason_kind = reason_kind,
            error = %error,
            "sandbox unpark lifecycle rejected before Firecracker resume"
        );
        return Err(error);
    }

    let mut guard = UnparkBoundaryGuard::new(coordinator.clone());
    if let Err(error) = unpark_firecracker().await {
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "firecracker_unpark",
            reason_kind = "firecracker",
            error = %error,
            "sandbox unpark lifecycle Firecracker unpark failed"
        );
        guard.disarm();
        return Err(error);
    }
    guard.mark_firecracker_resumed();

    info!(
        id = %log_id,
        transition = "unpark",
        phase = "firecracker_resumed",
        "sandbox unpark lifecycle Firecracker resumed"
    );
    if let Err(error) = resume_guest().await {
        let message = format!("guest resume failed during unpark: {error}");
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "guest_resume",
            reason_kind = "protocol_or_transport",
            error = %error,
            "sandbox unpark lifecycle guest resume failed"
        );
        guard.mark_dirty(message.clone());
        return Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            message,
        ));
    }

    release_normal_operations_fence();

    if let Err(error) = coordinator.reopen_after_unpark() {
        let reason_kind = prepare_park_error_reason_kind(&error);
        let error_message = prepare_park_error_message(&error);
        let message = format!(
            "park policy failed to reopen after unpark: {}",
            error_message
        );
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "ready_for_operations",
            reason_kind = reason_kind,
            error = %error_message,
            "sandbox unpark lifecycle failed to enter ReadyForOperations"
        );
        guard.mark_dirty(message.clone());
        return Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            message,
        ));
    }

    guard.disarm();
    info!(
        id = %log_id,
        transition = "unpark",
        phase = "ready_for_operations",
        "sandbox unpark lifecycle ReadyForOperations reached"
    );
    Ok(())
}

fn ensure_parked_before_unpark(coordinator: &ParkCoordinator) -> sandbox::Result<()> {
    match coordinator.state() {
        CoordinatorState::Parked => Ok(()),
        CoordinatorState::Dirty { reason } => Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            format!("park policy dirty while unpark is starting: {reason}"),
        )),
        state => {
            let message = format!("park policy is {state:?} while unpark is starting");
            coordinator.mark_dirty(DirtyReason::new(message.clone()));
            Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                message,
            ))
        }
    }
}

fn ensure_park_noop_state(coordinator: &ParkCoordinator) -> sandbox::Result<()> {
    match coordinator.state() {
        CoordinatorState::Parked => Ok(()),
        CoordinatorState::Dirty { reason } => Err(idle_transition_error(
            SandboxIdleTransition::Park,
            format!("park policy dirty while park is a no-op: {reason}"),
        )),
        state => {
            let message = format!("park policy is {state:?} while park is a no-op");
            coordinator.mark_dirty(DirtyReason::new(message.clone()));
            Err(idle_transition_error(SandboxIdleTransition::Park, message))
        }
    }
}

fn ensure_unpark_noop_state(coordinator: &ParkCoordinator) -> sandbox::Result<()> {
    match coordinator.state() {
        CoordinatorState::Open => Ok(()),
        CoordinatorState::Dirty { reason } => Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            format!("park policy dirty while unpark is a no-op: {reason}"),
        )),
        state => {
            let message = format!("park policy is {state:?} while unpark is a no-op");
            coordinator.mark_dirty(DirtyReason::new(message.clone()));
            Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                message,
            ))
        }
    }
}

fn prepare_park_error(transition: SandboxIdleTransition, error: PrepareParkError) -> SandboxError {
    idle_transition_error(transition, prepare_park_error_message(&error))
}

fn prepare_park_error_message(error: &PrepareParkError) -> String {
    match error {
        PrepareParkError::Dirty { reason } => format!("park policy dirty: {reason}"),
        PrepareParkError::InvalidState { state } => {
            format!("park policy state {state:?} cannot continue park lifecycle")
        }
        PrepareParkError::StaleAttempt { attempt_id, state } => {
            format!("stale park attempt {attempt_id:?} while park policy is {state:?}")
        }
    }
}

fn prepare_park_error_reason_kind(error: &PrepareParkError) -> &'static str {
    match error {
        PrepareParkError::Dirty { .. } => "dirty",
        PrepareParkError::InvalidState { .. } => "invalid_state",
        PrepareParkError::StaleAttempt { .. } => "stale_attempt",
    }
}

fn normal_operation_fence_rejection_message(error: NormalOperationFenceRejection) -> &'static str {
    match error {
        NormalOperationFenceRejection::Busy => "normal operations busy",
        NormalOperationFenceRejection::AlreadyFenced => "normal operations already fenced",
        NormalOperationFenceRejection::NotParkable => "normal operations not parkable",
        NormalOperationFenceRejection::Closed => "guest connection closed",
    }
}

fn normal_operation_fence_rejection_reason_kind(
    error: NormalOperationFenceRejection,
) -> &'static str {
    match error {
        NormalOperationFenceRejection::Busy => "busy",
        NormalOperationFenceRejection::AlreadyFenced => "already_fenced",
        NormalOperationFenceRejection::NotParkable => "not_parkable",
        NormalOperationFenceRejection::Closed => "closed",
    }
}

fn idle_transition_error(
    transition: SandboxIdleTransition,
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::IdleTransition {
        transition,
        message: message.into(),
    }
}

// -- idle transition helpers --
//
// Extracted from `impl Sandbox for FirecrackerSandbox` as free functions so
// that tests can drive them against a mock Unix-domain API socket without
// building a fully-initialised `FirecrackerSandbox` (which pulls in the
// network pool, NBD COW device, firecracker child process, etc.).

/// Maximum time to wait for balloon inflation before pausing vCPUs.
const BALLOON_SETTLE_TIMEOUT: Duration = Duration::from_secs(10);
/// Poll interval while waiting for balloon inflation.
const BALLOON_SETTLE_POLL: Duration = Duration::from_millis(500);
/// Accept small residual differences between requested and reported balloon size.
/// This fixed tolerance is calibrated for the current 4 GiB production profile,
/// where observed post-settle deficits were tens of MiB. If much smaller
/// production profiles are introduced, revisit whether this should scale with
/// `target_mib` so tiny balloon targets are not fully swallowed by tolerance.
const BALLOON_SETTLE_TOLERANCE_MIB: u32 = 64;

/// Wait until the guest balloon driver inflates close enough to `target_mib`.
///
/// The guest needs running vCPUs to inflate, so this must be called
/// **before** pausing. Returns when `actual_mib >= target_mib`, when
/// the remaining deficit is within [`BALLOON_SETTLE_TOLERANCE_MIB`],
/// or after [`BALLOON_SETTLE_TIMEOUT`] (partial inflation is better
/// than none). Errors from stats fetching are non-fatal — we log and
/// proceed to pause.
async fn wait_for_balloon(client: &ApiClient<'_>, target_mib: u32, log_id: &str) {
    let deadline = tokio::time::Instant::now() + BALLOON_SETTLE_TIMEOUT;
    let mut last_actual: Option<u32> = None;
    loop {
        match client.get_balloon_statistics().await {
            Ok(stats) => {
                let deficit_mib = target_mib.saturating_sub(stats.actual_mib);
                if deficit_mib == 0 {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib = BALLOON_SETTLE_TOLERANCE_MIB,
                        "balloon fully inflated, proceeding to pause"
                    );
                    return;
                }

                if deficit_mib <= BALLOON_SETTLE_TOLERANCE_MIB {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib = BALLOON_SETTLE_TOLERANCE_MIB,
                        "balloon inflated within tolerance, proceeding to pause"
                    );
                    return;
                }

                last_actual = Some(stats.actual_mib);
                trace!(
                    id = %log_id,
                    actual = stats.actual_mib,
                    target = target_mib,
                    deficit_mib,
                    tolerance_mib = BALLOON_SETTLE_TOLERANCE_MIB,
                    "waiting for balloon"
                );
            }
            Err(e) => {
                let deficit_mib = last_actual.map(|actual| target_mib.saturating_sub(actual));
                warn!(
                    id = %log_id,
                    actual = ?last_actual,
                    target = target_mib,
                    deficit_mib = ?deficit_mib,
                    tolerance_mib = BALLOON_SETTLE_TOLERANCE_MIB,
                    %e,
                    "balloon stats unavailable, proceeding to pause"
                );
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let deficit_mib = last_actual.map(|actual| target_mib.saturating_sub(actual));
            warn!(
                id = %log_id,
                actual = ?last_actual,
                target = target_mib,
                deficit_mib = ?deficit_mib,
                tolerance_mib = BALLOON_SETTLE_TOLERANCE_MIB,
                "balloon inflate incomplete after {}s, pausing anyway",
                BALLOON_SETTLE_TIMEOUT.as_secs()
            );
            return;
        }
        tokio::time::sleep(BALLOON_SETTLE_POLL).await;
    }
}

async fn park_inner(
    is_parked: &mut bool,
    memory_mb: u32,
    balloon_controller: &mut Option<balloon::ControllerHandle>,
    api_sock: &std::path::Path,
    log_id: &str,
) -> sandbox::Result<()> {
    if *is_parked {
        return Ok(());
    }

    let target = memory_mb.saturating_sub(balloon::MIN_GUEST_MIB);
    let client = ApiClient::new(api_sock);

    if target > 0 {
        // Stop the reactive controller so we're the sole writer to /balloon.
        // abort() + await ensures any in-flight PATCH from the controller
        // completes (or is cancelled) before ours lands.
        //
        // Ordering note: we abort BEFORE the PATCH (rather than after) because
        // the controller's reactive logic would otherwise see the post-inflate
        // drop in `available_memory` as memory pressure and immediately deflate
        // back, undoing our work.
        //
        // Failure-mode invariant: if patch_balloon or pause returns Err, the
        // controller is gone and `is_parked` stays false. This is an
        // intentional "transient inconsistent" state — the runner's only
        // failure handling is `stop_and_destroy_sandbox`, so the sandbox is
        // dropped (and Drop ensures any leftover handles are aborted) before
        // any further operations can observe the missing controller.
        if let Some(controller) = balloon_controller.take() {
            controller.abort_and_join().await;
        }

        client
            .patch_balloon(target)
            .await
            .map_err(|e| SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Park,
                message: format!("balloon inflate: {e}"),
            })?;

        // Wait for the guest to fully inflate the balloon before pausing
        // vCPUs. The guest balloon driver needs running vCPUs to process
        // the inflate — pausing immediately would negate the memory savings.
        wait_for_balloon(&client, target, log_id).await;
    }

    // Pause vCPUs to eliminate idle CPU overhead (timer ticks, kernel
    // scheduling). For small VMs (target == 0) we skip the balloon but
    // still pause — timer ticks waste CPU regardless of memory size.
    //
    // Idempotent 400 handling: Firecracker returns 400 if the VM is
    // already paused. Within park_inner this only happens if a prior
    // partial park (balloon OK, pause failed on transient error) already
    // paused the VM. Treat as success to preserve retry semantics.
    match client.pause().await {
        Ok(()) => {}
        Err(ApiError::Http { status: 400, .. }) => {
            info!(id = %log_id, "vm already paused, continuing park");
        }
        Err(e) => {
            return Err(SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Park,
                message: format!("vm pause: {e}"),
            });
        }
    }

    *is_parked = true;
    if target > 0 {
        info!(id = %log_id, target_mib = target, "sandbox parked (balloon inflated, vCPUs paused)");
    } else {
        info!(id = %log_id, "sandbox parked (vCPUs paused, balloon skipped)");
    }
    Ok(())
}

async fn unpark_inner(
    is_parked: &mut bool,
    memory_mb: u32,
    balloon_controller: &mut Option<balloon::ControllerHandle>,
    api_sock: &std::path::Path,
    state_rx: watch::Receiver<SandboxState>,
    log_id: &str,
) -> sandbox::Result<()> {
    if !*is_parked {
        return Ok(());
    }

    // Resume vCPUs before any balloon work — the guest needs running
    // vCPUs to process the deflate PATCH.
    //
    // Idempotent 400 handling: Firecracker returns 400 if the VM is
    // already running. Within unpark_inner this only happens if a prior
    // partial unpark (resume OK, deflate failed) already resumed the VM.
    // Treat as success to preserve the trait's retry contract.
    let client = ApiClient::new(api_sock);
    match client.resume().await {
        Ok(()) => {}
        Err(ApiError::Http { status: 400, .. }) => {
            info!(id = %log_id, "vm already running, continuing unpark");
        }
        Err(e) => {
            return Err(SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Unpark,
                message: format!("vm resume: {e}"),
            });
        }
    }

    let park_touched_controller = memory_mb > balloon::MIN_GUEST_MIB;

    if park_touched_controller {
        // By construction, park_inner left the slot None when it inflated
        // (and the is_parked guard above ensures we entered exactly one
        // park→unpark transition). Loudly catch invariant violations in
        // debug, and defensively take+abort in release so a violated
        // invariant doesn't leave an unexpected controller running.
        debug_assert!(
            balloon_controller.is_none(),
            "controller slot must be None when entering unpark from a parked state",
        );
        if let Some(controller) = balloon_controller.take() {
            controller.abort();
        }

        // Propagate deflate failure rather than swallow it. On a healthy
        // Firecracker, PATCH /balloon doesn't return transient errors —
        // any failure here (Connect / Http / Other) strongly suggests FC
        // is dead or unhealthy. Symmetric with park's failure mode: the
        // caller (runner take-site) destroys the sandbox and falls
        // through to fresh-create. Leaving is_parked=true and controller=None
        // is safe: the sandbox is about to be dropped; a hypothetical retry
        // would re-enter this branch and attempt deflate again.
        client
            .patch_balloon(0)
            .await
            .map_err(|e| SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Unpark,
                message: format!("balloon deflate: {e}"),
            })?;

        *balloon_controller = Some(balloon::spawn(api_sock.to_path_buf(), memory_mb, state_rx));
    }

    *is_parked = false;
    info!(id = %log_id, "sandbox unparked (vCPUs resumed)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{RateLimiterConfig, TokenBucketConfig};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    use tokio::time::Instant;
    use vsock_proto::{
        Decoder, ExecControlStatus, HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_EXEC_CONTROL,
        MSG_EXEC_CONTROL_RESULT, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
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

    async fn connect_mock_guest(vsock_path: &str) -> UnixStream {
        let listener_path = format!("{vsock_path}_{}", vsock_proto::VSOCK_PORT);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match UnixStream::connect(&listener_path).await {
                Ok(stream) => return stream,
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline =>
                {
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
        let response =
            vsock_proto::encode(vsock_proto::MSG_EXEC_STARTED, start.seq, &payload).unwrap();
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
            ExecTermination::Exited { exit_code: 0 },
            1,
            vsock_proto::ExecCapturedOutput::Discarded,
            vsock_proto::ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        let response =
            vsock_proto::encode(vsock_proto::MSG_EXEC_RESULT, exec_seq, &payload).unwrap();
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
            drive: RateLimiterConfig {
                bandwidth: Some(TokenBucketConfig {
                    size: 1024,
                    refill_time: 100,
                }),
                ops: Some(TokenBucketConfig {
                    size: 10,
                    refill_time: 100,
                }),
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
            let mut lines = BufReader::new(reader).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if !line.is_empty() {
                            ProcessLogStream::Stdout.log(&id, &line);
                        }
                    }
                    Ok(None) => {
                        let _ = eof_tx.send(());
                        break;
                    }
                    Err(_) => break,
                }
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

    #[test]
    fn process_state_publish_updates_atomic_and_watch_together() {
        let state = AtomicU8::new(SandboxState::Created as u8);
        let state_publish_lock = Mutex::new(());
        let (state_tx, state_rx) = watch::channel(SandboxState::Created);

        publish_process_state(
            &state,
            &state_publish_lock,
            &state_tx,
            SandboxState::Stopped,
        );

        assert_eq!(
            SandboxState::from_u8(state.load(Ordering::Acquire)),
            SandboxState::Stopped
        );
        assert_eq!(*state_rx.borrow(), SandboxState::Stopped);
    }

    #[test]
    fn failed_process_state_transition_does_not_regress_watch_state() {
        let state = AtomicU8::new(SandboxState::Stopped as u8);
        let state_publish_lock = Mutex::new(());
        let (state_tx, state_rx) = watch::channel(SandboxState::Stopped);

        assert!(!transition_process_state(
            &state,
            &state_publish_lock,
            &state_tx,
            SandboxState::Created,
            SandboxState::Running,
        ));

        assert_eq!(
            SandboxState::from_u8(state.load(Ordering::Acquire)),
            SandboxState::Stopped
        );
        assert_eq!(*state_rx.borrow(), SandboxState::Stopped);
    }

    fn assert_idle_transition(result: sandbox::Result<()>, expected: SandboxIdleTransition) {
        match result {
            Err(SandboxError::IdleTransition { transition, .. }) => {
                assert_eq!(transition, expected);
            }
            other => panic!("expected {expected} idle transition error, got {other:?}"),
        }
    }

    fn assert_operation_reason(error: SandboxError, expected: SandboxOperationReason) {
        match error {
            SandboxError::Operation { reason, .. } => assert_eq!(reason, expected),
            other => panic!("expected operation error, got {other:?}"),
        }
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
        let mut fence = Some(RecordedFence {
            events: Arc::clone(&events),
        });

        release_park_state_for_termination(&mut is_parked, &mut fence);

        assert!(!is_parked);
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
                Err(idle_transition_error(
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

        assert_operation_reason(err, SandboxOperationReason::Timeout);
    }

    #[test]
    fn operation_error_classifies_non_timeout_as_guest() {
        let err = FirecrackerSandbox::operation_error(
            SandboxOperation::Exec,
            io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
            false,
        );

        assert_operation_reason(err, SandboxOperationReason::Guest);
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
    fn supervised_exec_result_to_process_exit_preserves_terminal_metadata() {
        let exit = supervised_exec_result_to_process_exit(
            42,
            vsock_host::ExecOperationResult {
                termination: ExecTermination::WaitFailed,
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

        assert_eq!(exit.pid, 42);
        assert_eq!(exit.exit_code, 1);
        assert_eq!(exit.stdout, b"out");
        assert_eq!(exit.stderr, b"err\nwait failed");
        assert!(exit.stdout_truncated);
        assert!(!exit.stderr_truncated);
        assert_eq!(exit.diagnostic, "wait failed");
        assert!(exit.stream_overflowed);
    }

    #[test]
    fn supervised_exec_result_to_process_exit_maps_terminal_edge_states() {
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

            assert_eq!(exit.exit_code, expected_code);
            assert_eq!(String::from_utf8(exit.stderr).unwrap(), expected_stderr);
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

            assert_operation_reason(err, SandboxOperationReason::BackendCrashed);
        }
    }

    #[test]
    fn unavailable_guest_classifies_observed_backend_crash_for_all_operations() {
        for operation in [
            SandboxOperation::Exec,
            SandboxOperation::WriteFile,
            SandboxOperation::StartProcess,
            SandboxOperation::ProcessControl,
            SandboxOperation::WaitProcess,
        ] {
            let err =
                FirecrackerSandbox::operation_unavailable_error(operation, SandboxState::Crashed);

            assert_operation_reason(err, SandboxOperationReason::BackendCrashed);
        }
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

        send_exec_control_result(&mut guest, second_request, ExecControlStatus::Delivered, "")
            .await;
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
            guest,
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
        let mut control = crate::control::bind_server(
            sock_path.clone(),
            GuestOperationStartGate::new(Arc::clone(&guest), ParkCoordinator::new()),
        )
        .unwrap()
        .spawn(runtime_cancel.clone());
        let mut child = monitored_cat_process();
        let stdin = child.stdin.take();

        let handle = monitor_process(
            "test-sandbox",
            child,
            Arc::clone(&state),
            Arc::clone(&state_publish_lock),
            state_tx,
            guest,
            runtime_cancel,
        );

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

    #[test]
    fn snapshot_restore_inner_cmd_uses_positional_args_without_touch() {
        assert!(!SNAPSHOT_RESTORE_INNER_CMD.contains("$0"));
        for arg in ["$1", "$2", "$3", "$4", "$5", "$6", "$7"] {
            let quoted = format!(r#""{arg}""#);
            assert!(
                SNAPSHOT_RESTORE_INNER_CMD.contains(&quoted),
                "expected quoted positional {arg} in inner_cmd: {SNAPSHOT_RESTORE_INNER_CMD}"
            );
        }
        for unexpected in ["$8", "$9"] {
            assert!(
                !SNAPSHOT_RESTORE_INNER_CMD.contains(unexpected),
                "unexpected positional {unexpected} in inner_cmd: {SNAPSHOT_RESTORE_INNER_CMD}"
            );
        }

        assert!(
            SNAPSHOT_RESTORE_INNER_CMD.starts_with(r#"umount "$4" 2>/dev/null; mount --bind"#),
            "inner_cmd must clear stale bind mount before binding: {SNAPSHOT_RESTORE_INNER_CMD}"
        );
        assert!(
            SNAPSHOT_RESTORE_INNER_CMD
                .contains(r#"&& mount --bind "$3" "$4" && exec ip netns exec"#),
            "inner_cmd must bind COW device and exec firecracker: {SNAPSHOT_RESTORE_INNER_CMD}"
        );
        assert!(
            !SNAPSHOT_RESTORE_INNER_CMD.contains("touch"),
            "bind target creation must stay in Rust: {SNAPSHOT_RESTORE_INNER_CMD}"
        );
    }

    #[test]
    fn snapshot_restore_unshare_uses_private_mount_propagation() {
        assert_eq!(UNSHARE_MOUNT_ARGS, ["--mount", "--propagation", "private"]);
    }

    #[test]
    fn mountinfo_contains_exact_snapshot_drive_bind_target() {
        let mountinfo = "\
36 25 0:32 / /tmp/snapshot-work/cow-device-bind rw,relatime - ext4 /dev/nbd0 rw
37 25 0:33 / /tmp/snapshot-work rw,relatime - ext4 /dev/root rw
";

        assert!(mountinfo_contains_mount_point(
            mountinfo,
            std::path::Path::new("/tmp/snapshot-work/cow-device-bind"),
        ));
        assert!(!mountinfo_contains_mount_point(
            mountinfo,
            std::path::Path::new("/tmp/snapshot-work/cow"),
        ));
    }

    #[test]
    fn mountinfo_decodes_escaped_mount_point_path() {
        let mountinfo =
            r"36 25 0:32 / /tmp/vm0\040snapshot/cow-device-bind rw,relatime - ext4 /dev/nbd0 rw";

        assert!(mountinfo_contains_mount_point(
            mountinfo,
            std::path::Path::new("/tmp/vm0 snapshot/cow-device-bind"),
        ));
    }

    #[test]
    fn normal_temp_bind_target_is_not_a_mount_point() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("cow-device-bind");
        std::fs::write(&bind_target, b"").unwrap();

        assert!(!snapshot_drive_bind_target_is_mount_point(&bind_target).unwrap());
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_rejects_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("cow-device-bind");
        tokio::fs::create_dir(&bind_target).await.unwrap();

        let result = ensure_snapshot_drive_bind_target(&bind_target).await;

        assert!(
            matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
        );
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_rejects_existing_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let bind_target = dir.path().join("cow-device-bind");
        tokio::fs::write(&target, b"").await.unwrap();
        std::os::unix::fs::symlink(&target, &bind_target).unwrap();

        let result = ensure_snapshot_drive_bind_target(&bind_target).await;

        assert!(
            matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
        );
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_creates_missing_file_and_parent() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("snapshot-work").join("cow-device-bind");

        ensure_snapshot_drive_bind_target(&bind_target)
            .await
            .unwrap();

        let meta = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
        assert!(meta.file_type().is_file());
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_allows_concurrent_first_use() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("snapshot-work").join("cow-device-bind");
        let left = bind_target.clone();
        let right = bind_target.clone();

        let (left_result, right_result) = tokio::join!(
            ensure_snapshot_drive_bind_target(&left),
            ensure_snapshot_drive_bind_target(&right),
        );

        left_result.unwrap();
        right_result.unwrap();
        let meta = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
        assert!(meta.file_type().is_file());
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_allows_existing_file() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("cow-device-bind");
        tokio::fs::write(&bind_target, b"existing target")
            .await
            .unwrap();
        let before = tokio::fs::symlink_metadata(&bind_target).await.unwrap();

        ensure_snapshot_drive_bind_target(&bind_target)
            .await
            .unwrap();

        let after = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
        assert_eq!(
            before.ino(),
            after.ino(),
            "existing bind target must not be replaced"
        );
        assert_eq!(
            tokio::fs::read(&bind_target).await.unwrap(),
            b"existing target",
            "existing bind target must not be truncated"
        );
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
                let balloon_actual = balloon_actual.clone();
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
                        let actual = balloon_actual
                            .as_ref()
                            .map_or(99999, |a| a.load(Ordering::Relaxed));
                        let stats = format!(
                            r#"{{"target_mib":0,"actual_mib":{actual},"target_pages":0,"actual_pages":0}}"#
                        );
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{stats}",
                            stats.len()
                        );
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

    #[tokio::test]
    async fn snapshot_restore_with_limiters_loads_paused_patches_then_resumes() {
        let (sock, reqs, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 204, 204]), None).await;
        let client = ApiClient::new(&sock);
        let rate_limits = test_rate_limits();

        load_snapshot_and_apply_rate_limits(
            &client,
            "/snap/state",
            "/snap/memory",
            Some(&rate_limits),
        )
        .await
        .unwrap();

        let reqs = reqs.lock().await;
        assert_eq!(
            reqs.len(),
            4,
            "expected load, drive patch, network patch, resume"
        );
        assert_eq!(reqs[0].method, "PUT");
        assert_eq!(reqs[0].path, "/snapshot/load");
        assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);

        assert_eq!(reqs[1].method, "PATCH");
        assert_eq!(reqs[1].path, "/drives/rootfs");
        assert_eq!(
            mock_request_body_json(&reqs[1])["rate_limiter"]["bandwidth"]["size"],
            1024
        );

        assert_eq!(reqs[2].method, "PATCH");
        assert_eq!(reqs[2].path, "/network-interfaces/eth0");
        assert_eq!(
            mock_request_body_json(&reqs[2])["rx_rate_limiter"]["bandwidth"]["size"],
            2048
        );
        assert_eq!(
            mock_request_body_json(&reqs[2])["tx_rate_limiter"]["bandwidth"]["size"],
            4096
        );

        assert_eq!(reqs[3].method, "PATCH");
        assert_eq!(reqs[3].path, "/vm");
        assert!(reqs[3].body.contains("Resumed"));
    }

    #[tokio::test]
    async fn snapshot_restore_without_limiters_loads_and_resumes_without_patching() {
        let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;
        let client = ApiClient::new(&sock);

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
        let client = ApiClient::new(&sock);
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
    async fn snapshot_restore_network_limiter_patch_failure_does_not_resume() {
        let (sock, reqs, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 500]), None).await;
        let client = ApiClient::new(&sock);
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
        assert_eq!(reqs.len(), 3, "resume must not be attempted");
        assert_eq!(reqs[0].path, "/snapshot/load");
        assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
        assert_eq!(reqs[1].path, "/drives/rootfs");
        assert_eq!(reqs[2].path, "/network-interfaces/eth0");
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
        // Balloon inflate OK (204), vm pause fails (500).
        let (sock, reqs, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![204, 500]), None).await;

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

    #[tokio::test(start_paused = true)]
    async fn park_waits_for_balloon_before_pause() {
        // Mock returns actual_mib = 0 initially, then 1536 after we advance
        // time past the first poll interval. Using `start_paused = true` for
        // deterministic timing — no wall-clock dependencies.
        let balloon_actual = Arc::new(AtomicU32::new(0));
        let (sock, reqs, _dir) = spawn_mock_fc_api(
            std::collections::VecDeque::new(),
            Some(Arc::clone(&balloon_actual)),
        )
        .await;

        // After the first poll sees actual=0 and sleeps 500ms, the auto-advance
        // fires. Set actual to target so the second poll succeeds.
        let actual_clone = Arc::clone(&balloon_actual);
        tokio::spawn(async move {
            // Wait for one poll cycle (the 500ms sleep auto-advances).
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

    #[tokio::test(start_paused = true)]
    async fn park_pauses_when_balloon_is_within_settle_tolerance() {
        // Production samples have shown 4 GiB VMs reaching 3545-3555 MiB
        // against a 3584 MiB target. That is close enough to park without
        // waiting for the full 10s timeout and emitting a WARN.
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

    #[tokio::test(start_paused = true)]
    async fn park_pauses_when_balloon_deficit_equals_settle_tolerance() {
        let target_mib = 4096 - balloon::MIN_GUEST_MIB;
        let balloon_actual = Arc::new(AtomicU32::new(target_mib - BALLOON_SETTLE_TOLERANCE_MIB));
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

    #[tokio::test(start_paused = true)]
    async fn park_pauses_after_balloon_settle_timeout() {
        // Balloon never reaches target — wait_for_balloon must time out
        // and proceed to pause anyway. With `start_paused = true`, tokio
        // auto-advances simulated time when all tasks await timers, so
        // the 10s timeout completes instantly in wall-clock time.
        let balloon_actual = Arc::new(AtomicU32::new(0)); // stuck at 0
        let (sock, reqs, _dir) = spawn_mock_fc_api(
            std::collections::VecDeque::new(),
            Some(Arc::clone(&balloon_actual)),
        )
        .await;

        let mut controller = Some(test_balloon_controller());
        let mut is_parked = false;

        park_inner(&mut is_parked, 2048, &mut controller, &sock, "timeout-test")
            .await
            .unwrap();

        // Park must succeed despite balloon never reaching target.
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
}
