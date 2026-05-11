use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    BoundedExecCapturePolicy, BoundedExecOutput, BoundedExecOutputEvent, BoundedExecOutputRequest,
    BoundedExecRequest, BoundedExecResult, BoundedExecStream, BoundedExecTermination, ExecRequest,
    ExecResult, ProcessExit, Sandbox, SandboxConfig, SandboxError, SandboxIdleTransition,
    SandboxInvalidStateContext, SandboxOperation, SandboxOperationReason, SpawnHandle,
};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{info, trace, warn};
use vsock_host::{
    BoundedExecOutputEvent as HostBoundedExecOutputEvent,
    BoundedExecOutputRequest as HostBoundedExecOutputRequest,
    BoundedExecRequest as HostBoundedExecRequest, BoundedExecResult as HostBoundedExecResult,
    BoundedExecStream as HostBoundedExecStream,
    BoundedExecStreamPolicy as HostBoundedExecStreamPolicy,
    BoundedExecTermination as HostBoundedExecTermination, VsockHost,
};

use crate::api::ApiError;
use nbd_cow::PooledNbdCowDevice;

use crate::api::ApiClient;
use crate::balloon;
use crate::config::FirecrackerConfig;
use crate::control;
use crate::factory::InvariantConfig;
use crate::network::{NetnsInfo, NetnsLease};
use crate::paths::{SandboxPaths, SockPaths};
use crate::process::{kill_process_group, kill_process_group_by_pid};

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for graceful shutdown via vsock.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for Firecracker API socket readiness after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Short grace period for Firecracker stdout/stderr log readers after child exit.
const PROCESS_LOG_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Bash command run inside `unshare --mount` for snapshot restore.
/// Positional args are documented at the spawn site.
const SNAPSHOT_RESTORE_INNER_CMD: &str = r#"umount "$4" 2>/dev/null; mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec ip netns exec "$5" "$6" --api-sock "$7""#;
const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

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
                .map(|stdout| spawn_process_log_reader(id, ProcessLogStream::Stdout, stdout)),
            stderr: child
                .stderr
                .take()
                .map(|stderr| spawn_process_log_reader(id, ProcessLogStream::Stderr, stderr)),
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

fn spawn_process_log_reader<R>(
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
    if let Err(e) = result {
        if after_abort && e.is_cancelled() {
            trace!(stream = stream.name(), "process log reader aborted");
        } else {
            warn!(
                stream = stream.name(),
                error = %e,
                "process log reader task exited unexpectedly"
            );
        }
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
    /// Sender for leaked resource cleanup. When Drop fires without prior
    /// `factory.destroy()`, pool resources are sent here for async cleanup.
    leak_tx: Option<tokio::sync::mpsc::UnboundedSender<crate::factory::LeakedResources>>,
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
    pub(crate) fn new(
        config: SandboxConfig,
        factory_config: FirecrackerConfig,
        sandbox_paths: SandboxPaths,
        sock_paths: SockPaths,
        network: NetnsLease,
        cow_device: PooledNbdCowDevice,
        leak_tx: Option<tokio::sync::mpsc::UnboundedSender<crate::factory::LeakedResources>>,
    ) -> Self {
        let id = config.id.to_string();
        Self {
            config,
            factory_config,
            id,
            sandbox_paths,
            sock_paths,
            network: SandboxNetwork::from_lease(network),
            cow_device: Some(cow_device),
            runtime: SandboxRuntimeHandles::default(),
            process_group_pid: None,
            state: Arc::new(AtomicU8::new(SandboxState::Created as u8)),
            state_publish_lock: Arc::new(Mutex::new(())),
            state_tx: watch::channel(SandboxState::Created).0,
            guest: Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>)),
            leak_tx,
            delete_workspace_on_leak_cleanup: true,
            destroyed: false,
            is_parked: false,
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

    fn has_backend_crashed(&self) -> bool {
        self.current_state() == SandboxState::Crashed
    }

    fn publish_state(&self, state: SandboxState) {
        publish_process_state(&self.state, &self.state_publish_lock, &self.state_tx, state);
    }

    async fn operation_guest(
        &self,
        operation: SandboxOperation,
    ) -> sandbox::Result<Arc<VsockHost>> {
        if self.has_backend_crashed() {
            return Err(Self::backend_crashed_error(operation));
        }

        let guest = self.guest.lock().await.as_ref().cloned();
        if self.has_backend_crashed() {
            return Err(Self::backend_crashed_error(operation));
        }

        guest.ok_or_else(|| self.not_running_error(operation))
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
        let inv = InvariantConfig::new();
        let kernel_path = self.factory_config.kernel_path.display().to_string();
        let cow_device_path = self.cow_device()?.device_path().display().to_string();
        let vsock_path = self.sock_paths.vsock().display().to_string();

        Ok(serde_json::json!({
            "boot-source": {
                "kernel_image_path": kernel_path,
                "boot_args": inv.boot_args,
            },
            "drives": [
                {
                    "drive_id": "rootfs",
                    "path_on_host": cow_device_path,
                    "is_root_device": true,
                    "is_read_only": false,
                },
            ],
            "machine-config": {
                "vcpu_count": self.config.resources.cpu_count,
                "mem_size_mib": self.config.resources.memory_mb,
            },
            "network-interfaces": [
                {
                    "iface_id": inv.iface_id,
                    "guest_mac": inv.guest_mac,
                    "host_dev_name": inv.tap_name,
                },
            ],
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

        // Load snapshot and resume VM.
        let snapshot_str = snapshot.snapshot_path.display().to_string();
        let memory_str = snapshot.memory_path.display().to_string();
        client
            .load_snapshot(&snapshot_str, &memory_str)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot load failed: {e}"),
            })?;

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
            let resources = crate::factory::LeakedResources {
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

fn host_bounded_stream_to_sandbox(stream: HostBoundedExecStream) -> BoundedExecStream {
    match stream {
        HostBoundedExecStream::Stdout => BoundedExecStream::Stdout,
        HostBoundedExecStream::Stderr => BoundedExecStream::Stderr,
    }
}

fn host_bounded_event_to_sandbox(event: HostBoundedExecOutputEvent) -> BoundedExecOutputEvent {
    BoundedExecOutputEvent {
        stream: host_bounded_stream_to_sandbox(event.stream),
        sequence: event.sequence,
        chunk: event.chunk,
        truncated: event.truncated,
    }
}

fn host_bounded_termination_to_sandbox(
    termination: HostBoundedExecTermination,
) -> BoundedExecTermination {
    match termination {
        HostBoundedExecTermination::Exited { exit_code } => {
            BoundedExecTermination::Exited { exit_code }
        }
        HostBoundedExecTermination::TimedOut => BoundedExecTermination::TimedOut,
        HostBoundedExecTermination::Cancelled => BoundedExecTermination::Cancelled,
        HostBoundedExecTermination::StartFailed => BoundedExecTermination::StartFailed,
        HostBoundedExecTermination::WaitFailed => BoundedExecTermination::WaitFailed,
    }
}

fn host_bounded_output_to_sandbox(output: vsock_host::BoundedExecOutput) -> BoundedExecOutput {
    match output {
        vsock_host::BoundedExecOutput::Discarded => BoundedExecOutput::Discarded,
        vsock_host::BoundedExecOutput::Captured { bytes, truncated } => {
            BoundedExecOutput::Captured { bytes, truncated }
        }
    }
}

fn host_bounded_result_to_sandbox(result: HostBoundedExecResult) -> BoundedExecResult {
    BoundedExecResult {
        termination: host_bounded_termination_to_sandbox(result.termination),
        duration: Duration::from_millis(result.duration_ms),
        stdout: host_bounded_output_to_sandbox(result.stdout),
        stderr: host_bounded_output_to_sandbox(result.stderr),
        diagnostic: result.diagnostic,
    }
}

fn sandbox_capture_to_host(
    capture: BoundedExecCapturePolicy,
) -> vsock_host::BoundedExecCapturePolicy {
    match capture {
        BoundedExecCapturePolicy::Discard => vsock_host::BoundedExecCapturePolicy::Discard,
        BoundedExecCapturePolicy::Capture { limit_bytes } => {
            vsock_host::BoundedExecCapturePolicy::Capture { limit_bytes }
        }
    }
}

fn sandbox_output_to_host(
    output: &BoundedExecOutputRequest,
    stream: Option<HostBoundedExecStreamPolicy>,
) -> HostBoundedExecOutputRequest {
    HostBoundedExecOutputRequest {
        capture: sandbox_capture_to_host(output.capture),
        stream,
    }
}

fn spawn_bounded_stream_bridge(
    expected_stream: HostBoundedExecStream,
    stream: Option<&sandbox::BoundedExecStreamPolicy>,
    bridge_tasks: &mut Vec<tokio::task::JoinHandle<()>>,
) -> Option<HostBoundedExecStreamPolicy> {
    let stream = stream?;
    let (host_tx, mut host_rx) = mpsc::unbounded_channel::<HostBoundedExecOutputEvent>();
    let sandbox_tx = stream.event_tx.clone();
    bridge_tasks.push(tokio::spawn(async move {
        while let Some(event) = host_rx.recv().await {
            debug_assert_eq!(event.stream, expected_stream);
            if event.stream != expected_stream {
                continue;
            }
            if sandbox_tx
                .send(host_bounded_event_to_sandbox(event))
                .is_err()
            {
                break;
            }
        }
    }));
    Some(HostBoundedExecStreamPolicy {
        event_tx: host_tx,
        limit_bytes: stream.limit_bytes,
        chunk_limit_bytes: stream.chunk_limit_bytes,
    })
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
        let control_server =
            match control::bind_server(control_sock_path.clone(), Arc::clone(&self.guest)) {
                Ok(server) => server,
                Err(e) => {
                    self.guest.lock().await.take();
                    self.runtime.kill_process().await;
                    return Err(SandboxError::Start {
                        message: format!(
                            "control socket bind {}: {e}",
                            control_sock_path.display()
                        ),
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
        if !self.is_parked {
            let guest = self.guest.lock().await.take();
            if let Some(guest) = guest
                && !guest.shutdown(SHUTDOWN_TIMEOUT).await
            {
                warn!(id = %self.id, "graceful shutdown timed out");
            }
        }

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
                self.runtime.kill_process().await;
            }
            return Ok(());
        }
        self.runtime.shutdown_services().await;
        self.guest.lock().await.take();
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
    // Both methods propagate PATCH failures as `IdleTransition(Park|Unpark)` errors —
    // on failure the caller (runner) destroys the sandbox and falls
    // through to fresh-create. Firecracker's pause/resume returns 400
    // when the VM is already in the target state; within park/unpark
    // this only happens after a partial retry, so 400 is treated as
    // success (idempotent).
    //
    // For profiles where `memory_mb <= MIN_GUEST_MIB` there is no memory
    // to reclaim (balloon is skipped), but vCPUs are still paused — timer
    // ticks waste CPU regardless of memory size.
    //
    // The `is_parked` flag makes both methods idempotent and lets unpark
    // skip the abort+respawn dance when park was a no-op.

    async fn park(&mut self) -> sandbox::Result<()> {
        park_inner(
            &mut self.is_parked,
            self.config.resources.memory_mb,
            self.runtime.balloon_mut(),
            &self.sock_paths.api_sock(),
            &self.id,
        )
        .await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        unpark_inner(
            &mut self.is_parked,
            self.config.resources.memory_mb,
            self.runtime.balloon_mut(),
            &self.sock_paths.api_sock(),
            self.state_tx.subscribe(),
            &self.id,
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
        // Legacy buffered exec path. New request/response command execution
        // should call bounded_exec so output, termination, streaming, and
        // cancellation semantics are explicit.
        let operation = SandboxOperation::Exec;
        let guest = self.operation_guest(operation).await?;

        tokio::select! {
            result = guest.exec(request.cmd, request.timeout_ms(), request.env, request.sudo) => {
                let result = result.map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))?;
                Ok(ExecResult {
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                })
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }

    async fn bounded_exec(
        &self,
        request: &BoundedExecRequest<'_>,
    ) -> sandbox::Result<BoundedExecResult> {
        let operation = SandboxOperation::BoundedExec;
        let guest = self.operation_guest(operation).await?;

        let mut bridge_tasks = Vec::new();
        let stdout_stream = spawn_bounded_stream_bridge(
            HostBoundedExecStream::Stdout,
            request.stdout.stream.as_ref(),
            &mut bridge_tasks,
        );
        let stderr_stream = spawn_bounded_stream_bridge(
            HostBoundedExecStream::Stderr,
            request.stderr.stream.as_ref(),
            &mut bridge_tasks,
        );

        let host_request = HostBoundedExecRequest {
            command: request.cmd,
            timeout_ms: request.timeout_ms(),
            env: request.env,
            sudo: request.sudo,
            stdin: request.stdin,
            stdout: sandbox_output_to_host(&request.stdout, stdout_stream),
            stderr: sandbox_output_to_host(&request.stderr, stderr_stream),
        };

        let result = tokio::select! {
            result = guest.bounded_exec(&host_request) => {
                result
                    .map(host_bounded_result_to_sandbox)
                    .map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        };

        drop(host_request);
        for task in bridge_tasks {
            let _ = task.await;
        }

        result
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let operation = SandboxOperation::WriteFile;
        let guest = self.operation_guest(operation).await?;

        tokio::select! {
            result = guest.write_file(path, content, false) => {
                result.map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }

    async fn spawn_watch(
        &self,
        request: &ExecRequest<'_>,
        output: sandbox::SpawnOutputMode<'_>,
    ) -> sandbox::Result<SpawnHandle> {
        let operation = SandboxOperation::SpawnWatch;
        let guest = self.operation_guest(operation).await?;

        tokio::select! {
            result = guest.spawn_watch(
                request.cmd,
                request.timeout_ms(),
                request.env,
                request.sudo,
                output.streams_stdout(),
                output.guest_log_path(),
            ) => {
                let (pid, stdout_rx) = result.map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))?;
                Ok(SpawnHandle {
                    pid,
                    stdout_rx: output.streams_stdout().then_some(stdout_rx),
                })
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }

    async fn wait_exit(
        &self,
        handle: SpawnHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let operation = SandboxOperation::WaitExit;
        let guest = self.operation_guest(operation).await?;

        tokio::select! {
            result = guest.wait_for_exit(handle.pid, timeout) => {
                let event = result.map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))?;
                Ok(ProcessExit {
                    pid: event.pid,
                    exit_code: event.exit_code,
                    stdout: event.stdout,
                    stderr: event.stderr,
                })
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
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

    #[test]
    fn operation_error_classifies_io_timeout() {
        let err = FirecrackerSandbox::operation_error(
            SandboxOperation::WaitExit,
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
    fn operation_error_classifies_observed_backend_crash_for_all_operations() {
        for operation in [
            SandboxOperation::Exec,
            SandboxOperation::BoundedExec,
            SandboxOperation::WriteFile,
            SandboxOperation::SpawnWatch,
            SandboxOperation::WaitExit,
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
            SandboxOperation::BoundedExec,
            SandboxOperation::WriteFile,
            SandboxOperation::SpawnWatch,
            SandboxOperation::WaitExit,
        ] {
            let err =
                FirecrackerSandbox::operation_unavailable_error(operation, SandboxState::Crashed);

            assert_operation_reason(err, SandboxOperationReason::BackendCrashed);
        }
    }

    #[tokio::test]
    async fn bounded_stream_bridges_close_independently() {
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();
        drop(stdout_rx);
        let (stderr_tx, mut stderr_rx) = mpsc::unbounded_channel();
        let stdout_policy = sandbox::BoundedExecStreamPolicy {
            event_tx: stdout_tx,
            limit_bytes: 128,
            chunk_limit_bytes: 64,
        };
        let stderr_policy = sandbox::BoundedExecStreamPolicy {
            event_tx: stderr_tx,
            limit_bytes: 256,
            chunk_limit_bytes: 64,
        };

        let mut bridge_tasks = Vec::new();
        let stdout_host = spawn_bounded_stream_bridge(
            HostBoundedExecStream::Stdout,
            Some(&stdout_policy),
            &mut bridge_tasks,
        )
        .expect("stdout stream should create a host bridge");
        let stderr_host = spawn_bounded_stream_bridge(
            HostBoundedExecStream::Stderr,
            Some(&stderr_policy),
            &mut bridge_tasks,
        )
        .expect("stderr stream should create a host bridge");
        assert_eq!(bridge_tasks.len(), 2);

        let stdout_task = bridge_tasks.remove(0);
        let stderr_task = bridge_tasks.remove(0);
        stdout_host
            .event_tx
            .send(HostBoundedExecOutputEvent {
                stream: HostBoundedExecStream::Stdout,
                sequence: 1,
                chunk: b"lost".to_vec(),
                truncated: false,
            })
            .expect("stdout host bridge should be open for first event");
        tokio::time::timeout(Duration::from_secs(1), stdout_task)
            .await
            .expect("stdout bridge should exit after receiver is dropped")
            .expect("stdout bridge task should not panic");
        assert!(stdout_host.event_tx.is_closed());

        stderr_host
            .event_tx
            .send(HostBoundedExecOutputEvent {
                stream: HostBoundedExecStream::Stderr,
                sequence: 2,
                chunk: b"kept".to_vec(),
                truncated: true,
            })
            .expect("stderr host bridge should remain open");
        assert_eq!(
            stderr_rx.recv().await.unwrap(),
            BoundedExecOutputEvent {
                stream: BoundedExecStream::Stderr,
                sequence: 2,
                chunk: b"kept".to_vec(),
                truncated: true,
            }
        );

        drop(stderr_host);
        tokio::time::timeout(Duration::from_secs(1), stderr_task)
            .await
            .expect("stderr bridge should exit after host sender is dropped")
            .expect("stderr bridge task should not panic");
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
        let mut control = crate::control::bind_server(sock_path.clone(), Arc::clone(&guest))
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
        let stderr = child.stderr.take().map(|stderr| {
            spawn_process_log_reader("test-sandbox", ProcessLogStream::Stderr, stderr)
        });
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

    // -- idle transition tests --
    //
    // These exercise `park_inner` / `unpark_inner` against a mock Firecracker
    // API socket. We assert on:
    //   1. the correct sequence of PATCH requests (method, path, body);
    //   2. whether the reactive controller handle is present / absent;
    //   3. the is_parked flag state; and
    //   4. idempotency on repeat calls.

    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
