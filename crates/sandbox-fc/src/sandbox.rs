use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig, SandboxError,
    SandboxIdleTransition, SandboxInvalidStateContext, SandboxOperation, SandboxOperationReason,
    SpawnHandle,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;
use tracing::{info, trace, warn};
use vsock_host::VsockHost;

use crate::api::ApiError;
use nbd_cow::NbdCowDevice;

use crate::api::ApiClient;
use crate::balloon;
use crate::config::FirecrackerConfig;
use crate::control;
use crate::factory::InvariantConfig;
use crate::network::PooledNetns;
use crate::paths::{SandboxPaths, SockPaths};
use crate::process::kill_process_group;

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for graceful shutdown via vsock.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for Firecracker API socket readiness after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Bash command run inside `unshare --mount` for snapshot restore.
/// Positional args are documented at the spawn site.
const SNAPSHOT_RESTORE_INNER_CMD: &str = r#"umount "$4" 2>/dev/null; mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec ip netns exec "$5" "$6" --api-sock "$7""#;
const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SandboxState {
    Created = 0,
    Running = 1,
    Stopping = 2,
    Stopped = 3,
}

impl SandboxState {
    fn from_u8(v: u8) -> Self {
        debug_assert!(v <= 3, "invalid SandboxState: {v}");
        match v {
            0 => Self::Created,
            1 => Self::Running,
            2 => Self::Stopping,
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

pub struct FirecrackerSandbox {
    pub(crate) config: SandboxConfig,
    factory_config: FirecrackerConfig,
    /// Cached `config.id.to_string()`.
    pub(crate) id: String,
    /// Workspace paths (config, COW — persistent data).
    pub(crate) sandbox_paths: SandboxPaths,
    /// Runtime socket paths (api.sock, vsock).
    pub(crate) sock_paths: SockPaths,
    /// Pooled network namespace (returned to pool on destroy).
    pub(crate) network: PooledNetns,
    /// NBD COW device (torn down on destroy).
    pub(crate) cow_device: NbdCowDevice,
    process: Option<tokio::process::Child>,
    /// Firecracker process PID, captured at spawn time before the process
    /// could exit and be reaped.  Used for host-side OOM detection.
    firecracker_pid: Option<u32>,
    /// Lifecycle state, shared with background log tasks for crash detection.
    state: Arc<AtomicU8>,
    /// Vsock guest connection, shared with background log tasks so they can
    /// drop the connection immediately when the process exits unexpectedly.
    /// Wrapped in `Arc` so operations can clone the handle and release the
    /// mutex immediately, allowing concurrent vsock operations.
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    /// Notified when the firecracker process exits unexpectedly.
    /// Sandbox operations race against this to detect crashes promptly.
    crash_notify: Arc<Notify>,
    /// Control socket server for `runner exec`.
    control_server: Option<tokio::task::JoinHandle<()>>,
    /// Balloon memory reclaim controller.
    balloon_controller: Option<tokio::task::JoinHandle<()>>,
    /// Sender for leaked resource cleanup. When Drop fires without prior
    /// `factory.destroy()`, pool resources are sent here for async cleanup.
    leak_tx: Option<tokio::sync::mpsc::Sender<crate::factory::LeakedResources>>,
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

impl FirecrackerSandbox {
    pub(crate) fn new(
        config: SandboxConfig,
        factory_config: FirecrackerConfig,
        sandbox_paths: SandboxPaths,
        sock_paths: SockPaths,
        network: PooledNetns,
        cow_device: NbdCowDevice,
        leak_tx: Option<tokio::sync::mpsc::Sender<crate::factory::LeakedResources>>,
    ) -> Self {
        let id = config.id.to_string();
        Self {
            config,
            factory_config,
            id,
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
            process: None,
            firecracker_pid: None,
            state: Arc::new(AtomicU8::new(SandboxState::Created as u8)),
            guest: Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>)),
            crash_notify: Arc::new(Notify::new()),
            control_server: None,
            balloon_controller: None,
            leak_tx,
            destroyed: false,
            is_parked: false,
        }
    }

    fn current_state(&self) -> SandboxState {
        SandboxState::from_u8(self.state.load(Ordering::Acquire))
    }

    fn not_running_error(&self, operation: SandboxOperation) -> SandboxError {
        SandboxError::InvalidState {
            context: SandboxInvalidStateContext::Operation(operation),
            state: self.current_state().to_string(),
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

    fn operation_error(operation: SandboxOperation, error: io::Error) -> SandboxError {
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

    /// Atomically transition between states using CAS. Returns `true` if the
    /// transition succeeded, `false` if the current state did not match `from`.
    fn transition(&self, from: SandboxState, to: SandboxState) -> bool {
        self.state
            .compare_exchange(from as u8, to as u8, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Build the Firecracker JSON configuration for fresh boot.
    fn build_config(&self) -> serde_json::Value {
        let inv = InvariantConfig::new();
        let kernel_path = self.factory_config.kernel_path.display().to_string();
        let cow_device_path = self.cow_device.device_path().display().to_string();
        let vsock_path = self.sock_paths.vsock().display().to_string();

        serde_json::json!({
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
        })
    }

    /// Start using a fresh boot with `--config-file --api-sock`.
    async fn start_fresh(&mut self) -> sandbox::Result<()> {
        let config = self.build_config();
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

        let mut child = tokio::process::Command::new("ip")
            .args(["netns", "exec"])
            .arg(&self.network.name)
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

        self.firecracker_pid = child.id();
        monitor_process(
            &self.id,
            &mut child,
            Arc::clone(&self.state),
            Arc::clone(&self.guest),
            Arc::clone(&self.crash_notify),
        );
        self.process = Some(child);

        // Wait for API socket readiness so the balloon controller can connect.
        let client = ApiClient::new(&api_sock);
        let crash = Arc::clone(&self.crash_notify);
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
            () = crash.notified() => {
                return Err(SandboxError::Start {
                    message: format!(
                        "firecracker process exited before API became ready (api_sock={})",
                        api_sock.display()
                    ),
                });
            }
        }

        info!(id = %self.id, "firecracker started (fresh boot)");
        Ok(())
    }

    /// Start from a snapshot using `--api-sock` and bind mounts.
    async fn start_from_snapshot(&mut self) -> sandbox::Result<()> {
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
        let cow_device_path = self.cow_device.device_path();
        info!(
            id = %self.id,
            api_sock = %api_sock.display(),
            sock_dir = %sock_dir.display(),
            cow_device = %cow_device_path.display(),
            netns = %self.network.name,
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
        let mut child = tokio::process::Command::new("unshare")
            .args(UNSHARE_MOUNT_ARGS)
            .args(["bash", "-c", SNAPSHOT_RESTORE_INNER_CMD, "_"])
            .arg(self.sock_paths.vsock_dir()) // $1
            .arg(&snapshot.vsock_bind_dir) // $2
            .arg(cow_device_path) // $3
            .arg(&snapshot.drive_bind_path) // $4
            .arg(&self.network.name) // $5
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

        self.firecracker_pid = child.id();
        monitor_process(
            &self.id,
            &mut child,
            Arc::clone(&self.state),
            Arc::clone(&self.guest),
            Arc::clone(&self.crash_notify),
        );
        self.process = Some(child);

        // Wait for Firecracker API to be ready, but bail early if the
        // process crashes before the socket appears.
        let client = ApiClient::new(&api_sock);
        let crash = Arc::clone(&self.crash_notify);
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
            () = crash.notified() => {
                return Err(SandboxError::Start {
                    message: format!(
                        "firecracker process exited before API became ready (api_sock={})",
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

    /// Kill the process tree.
    ///
    /// The process chain is `unshare -> bash -> ip netns exec -> firecracker`.
    /// We must kill the entire tree to avoid orphan processes.
    async fn kill_process(&mut self) {
        let Some(ref mut child) = self.process else {
            return;
        };

        kill_process_group(child);

        // Reap the zombie process.
        let _ = child.wait().await;
        self.process = None;
    }
}

impl Drop for FirecrackerSandbox {
    fn drop(&mut self) {
        if let Some(h) = self.control_server.take() {
            h.abort();
        }
        if let Some(h) = self.balloon_controller.take() {
            h.abort();
        }
        // If the process is still alive (e.g. owning task panicked before
        // explicit cleanup), kill the entire process group synchronously.
        // `kill_on_drop(true)` only sends SIGKILL to the direct child (`unshare`);
        // `killpg` ensures the entire tree (including firecracker) is cleaned up.
        if let Some(ref child) = self.process {
            kill_process_group(child);
        }
        // Dropping `self.process` (Option<Child>) will trigger kill_on_drop as
        // a secondary safety net.

        // If factory.destroy() was not called, send pool resources to the
        // async cleanup channel so they can be released without blocking.
        // NbdCowDevice::Drop handles the kernel-level NBD disconnect; this
        // covers the pool index, network namespace, and directories.
        if !self.destroyed
            && let Some(tx) = self.leak_tx.take()
        {
            let resources = crate::factory::LeakedResources {
                sandbox_id: self.id.clone(),
                device_index: self.cow_device.device_index(),
                network: self.network.clone(),
                sock_dir: self.sock_paths.dir().to_owned(),
                workspace: self.sandbox_paths.workspace().to_owned(),
            };
            if tx.try_send(resources).is_err() {
                tracing::warn!(
                    id = %self.id,
                    "leak cleanup channel full or closed — resources will require runner gc"
                );
            }
        }
    }
}

/// Monitor the child process for unexpected exit and forward logs.
///
/// Spawns background tasks that read stdout/stderr until the pipes close.
/// When stdout closes, if the state is still `Running`, the process exited
/// unexpectedly — the task updates state to `Stopped` and drops the guest
/// connection.
fn monitor_process(
    id: &str,
    child: &mut tokio::process::Child,
    state: Arc<AtomicU8>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
    crash_notify: Arc<Notify>,
) {
    if let Some(stdout) = child.stdout.take() {
        let id = id.to_owned();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    info!(id = %id, "{line}");
                }
            }
            // Pipe closed — process exited.
            let prev =
                SandboxState::from_u8(state.swap(SandboxState::Stopped as u8, Ordering::AcqRel));
            if prev == SandboxState::Running {
                warn!(id = %id, "process exited unexpectedly");
                // Notify before acquiring the lock — operations holding the
                // lock can detect the crash via select! immediately.
                // Uses notify_waiters (not notify_one) because at most one
                // operation is waiting and we don't need stored permits.
                crash_notify.notify_waiters();
                guest.lock().await.take();
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let id = id.to_owned();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    warn!(id = %id, "stderr: {line}");
                }
            }
        });
    }
}

#[async_trait]
impl Sandbox for FirecrackerSandbox {
    // -- identity --

    fn id(&self) -> &str {
        &self.id
    }

    fn source_ip(&self) -> &str {
        &self.network.peer_ip
    }

    fn process_pid(&self) -> Option<u32> {
        self.firecracker_pid
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

        // Start the vsock listener BEFORE launching Firecracker.
        // The UDS must be bound before the guest tries to connect.
        let vsock_path = self.sock_paths.vsock().display().to_string();
        let vsock_task = tokio::spawn(async move {
            VsockHost::wait_for_connection(&vsock_path, VSOCK_CONNECT_TIMEOUT).await
        });

        let start_result = if self.factory_config.snapshot.is_some() {
            self.start_from_snapshot().await
        } else {
            self.start_fresh().await
        };

        if let Err(e) = start_result {
            vsock_task.abort();
            self.kill_process().await;
            return Err(e);
        }

        // Wait for guest to connect via vsock.
        let vsock_guest = match vsock_task.await {
            Ok(Ok(g)) => g,
            Ok(Err(e)) => {
                self.kill_process().await;
                return Err(SandboxError::Start {
                    message: format!("vsock connection: {e}"),
                });
            }
            Err(e) => {
                self.kill_process().await;
                return Err(SandboxError::Start {
                    message: format!("vsock task: {e}"),
                });
            }
        };

        *self.guest.lock().await = Some(Arc::new(vsock_guest));

        // Use CAS to avoid overwriting Stopped if the process crashed between
        // spawn and vsock connect (the background log task may have already
        // swapped the state to Stopped).
        if !self.transition(SandboxState::Created, SandboxState::Running) {
            self.guest.lock().await.take();
            self.kill_process().await;
            return Err(SandboxError::Start {
                message: "process exited during startup".into(),
            });
        }

        // Start control socket server for `runner exec`.
        self.control_server = Some(control::spawn_server(
            self.sock_paths.control_sock(),
            Arc::clone(&self.guest),
        ));

        // Spawn balloon controller to reclaim unused guest memory.
        self.balloon_controller = Some(balloon::spawn(
            self.sock_paths.api_sock().to_owned(),
            self.config.resources.memory_mb,
            Arc::clone(&self.crash_notify),
        ));

        info!(id = %self.id, "sandbox started");
        Ok(())
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            return Ok(());
        }

        if let Some(h) = self.control_server.take() {
            h.abort();
        }
        // abort() without await: unlike `park_inner` (which awaits to become
        // the sole writer to /balloon), stop() is about to kill the FC
        // process entirely, so any in-flight controller PATCHes against the
        // dying API socket are harmless — the subsequent kill_process call
        // tears down FC regardless of balloon state.
        if let Some(h) = self.balloon_controller.take() {
            h.abort();
        }

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

        self.kill_process().await;
        self.state
            .store(SandboxState::Stopped as u8, Ordering::Release);
        info!(id = %self.id, "sandbox stopped");
        Ok(())
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            return Ok(());
        }
        if let Some(h) = self.control_server.take() {
            h.abort();
        }
        // abort() without await — same rationale as `stop()`.
        if let Some(h) = self.balloon_controller.take() {
            h.abort();
        }
        self.guest.lock().await.take();
        self.kill_process().await;
        self.state
            .store(SandboxState::Stopped as u8, Ordering::Release);
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
            &mut self.balloon_controller,
            &self.sock_paths.api_sock(),
            &self.id,
        )
        .await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        unpark_inner(
            &mut self.is_parked,
            self.config.resources.memory_mb,
            &mut self.balloon_controller,
            &self.sock_paths.api_sock(),
            &self.crash_notify,
            &self.id,
        )
        .await
    }

    // -- operations --
    //
    // Each operation races the vsock call against `crash_notify` via select!.
    // `notify_waiters()` only wakes current waiters — if the notification
    // fires in the brief window before select! polls `notified()`, it is
    // lost. This is acceptable: `monitor_process` subsequently drops the
    // guest connection, so the vsock call fails with a connection error
    // anyway — just with a less specific message.

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        let guest = self
            .guest
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| self.not_running_error(SandboxOperation::Exec))?;

        tokio::select! {
            result = guest.exec(request.cmd, request.timeout_ms(), request.env, request.sudo) => {
                let result = result.map_err(|e| Self::operation_error(SandboxOperation::Exec, e))?;
                Ok(ExecResult {
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                })
            }
            _ = self.crash_notify.notified() => {
                Err(Self::backend_crashed_error(SandboxOperation::Exec))
            }
        }
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let guest = self
            .guest
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| self.not_running_error(SandboxOperation::WriteFile))?;

        tokio::select! {
            result = guest.write_file(path, content, false) => {
                result.map_err(|e| Self::operation_error(SandboxOperation::WriteFile, e))
            }
            _ = self.crash_notify.notified() => {
                Err(Self::backend_crashed_error(SandboxOperation::WriteFile))
            }
        }
    }

    async fn spawn_watch(
        &self,
        request: &ExecRequest<'_>,
        stdout_log_path: Option<&str>,
    ) -> sandbox::Result<SpawnHandle> {
        let guest = self
            .guest
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| self.not_running_error(SandboxOperation::SpawnWatch))?;

        tokio::select! {
            result = guest.spawn_watch(request.cmd, request.timeout_ms(), request.env, request.sudo, stdout_log_path) => {
                let (pid, stdout_rx) = result.map_err(|e| Self::operation_error(SandboxOperation::SpawnWatch, e))?;
                Ok(SpawnHandle { pid, stdout_rx: Some(stdout_rx) })
            }
            _ = self.crash_notify.notified() => {
                Err(Self::backend_crashed_error(SandboxOperation::SpawnWatch))
            }
        }
    }

    async fn wait_exit(
        &self,
        handle: SpawnHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let guest = self
            .guest
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| self.not_running_error(SandboxOperation::WaitExit))?;

        tokio::select! {
            result = guest.wait_for_exit(handle.pid, timeout) => {
                let event = result.map_err(|e| Self::operation_error(SandboxOperation::WaitExit, e))?;
                Ok(ProcessExit {
                    pid: event.pid,
                    exit_code: event.exit_code,
                    stdout: event.stdout,
                    stderr: event.stderr,
                })
            }
            _ = self.crash_notify.notified() => {
                Err(Self::backend_crashed_error(SandboxOperation::WaitExit))
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

/// Wait until the guest balloon driver inflates to `target_mib`.
///
/// The guest needs running vCPUs to inflate, so this must be called
/// **before** pausing. Returns when `actual_mib >= target_mib`, or
/// after [`BALLOON_SETTLE_TIMEOUT`] (partial inflation is better than
/// none). Errors from stats fetching are non-fatal — we log and
/// proceed to pause.
async fn wait_for_balloon(client: &ApiClient<'_>, target_mib: u32, log_id: &str) {
    let deadline = tokio::time::Instant::now() + BALLOON_SETTLE_TIMEOUT;
    let mut last_actual: Option<u32> = None;
    loop {
        match client.get_balloon_statistics().await {
            Ok(stats) if stats.actual_mib >= target_mib => {
                info!(
                    id = %log_id,
                    actual = stats.actual_mib,
                    target = target_mib,
                    "balloon fully inflated, proceeding to pause"
                );
                return;
            }
            Ok(stats) => {
                last_actual = Some(stats.actual_mib);
                trace!(
                    id = %log_id,
                    actual = stats.actual_mib,
                    target = target_mib,
                    "waiting for balloon"
                );
            }
            Err(e) => {
                warn!(
                    id = %log_id,
                    %e,
                    actual = ?last_actual,
                    target = target_mib,
                    "balloon stats unavailable, proceeding to pause"
                );
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            warn!(
                id = %log_id,
                actual = ?last_actual,
                target = target_mib,
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
    balloon_controller: &mut Option<tokio::task::JoinHandle<()>>,
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
        if let Some(h) = balloon_controller.take() {
            h.abort();
            let _ = h.await;
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
    balloon_controller: &mut Option<tokio::task::JoinHandle<()>>,
    api_sock: &std::path::Path,
    crash_notify: &Arc<Notify>,
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
        // invariant doesn't silently leak the old task (dropping a
        // JoinHandle detaches; it does not abort).
        debug_assert!(
            balloon_controller.is_none(),
            "controller slot must be None when entering unpark from a parked state",
        );
        if let Some(h) = balloon_controller.take() {
            h.abort();
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

        *balloon_controller = Some(balloon::spawn(
            api_sock.to_path_buf(),
            memory_mb,
            Arc::clone(crash_notify),
        ));
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

    async fn wait_for_state(state: &AtomicU8, expected: SandboxState) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while SandboxState::from_u8(state.load(Ordering::Acquire)) != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
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
        );

        assert_operation_reason(err, SandboxOperationReason::Timeout);
    }

    #[test]
    fn operation_error_classifies_non_timeout_as_guest() {
        let err = FirecrackerSandbox::operation_error(
            SandboxOperation::Exec,
            io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
        );

        assert_operation_reason(err, SandboxOperationReason::Guest);
    }

    /// Exercise the `monitor_process` crash detection flow through the real
    /// stdout EOF path. A running process exit should mark the sandbox stopped
    /// and notify waiters.
    #[tokio::test]
    async fn crash_notify_fires_on_unexpected_exit() {
        let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
        let crash_notify = Arc::new(Notify::new());
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut child = monitored_cat_process();

        monitor_process(
            "test-sandbox",
            &mut child,
            Arc::clone(&state),
            guest,
            Arc::clone(&crash_notify),
        );

        let notified = crash_notify.notified();
        drop(child.stdin.take());

        tokio::time::timeout(Duration::from_secs(1), notified)
            .await
            .unwrap();
        assert_eq!(
            SandboxState::from_u8(state.load(Ordering::Acquire)),
            SandboxState::Stopped
        );

        let status = child.wait().await.unwrap();
        assert!(status.success());
    }

    /// When the process is stopped gracefully (state transitions to Stopping
    /// before pipe close), the real `monitor_process` stdout EOF path should
    /// not fire crash_notify.
    #[tokio::test]
    async fn crash_notify_does_not_fire_on_graceful_stop() {
        let state = Arc::new(AtomicU8::new(SandboxState::Stopping as u8));
        let crash_notify = Arc::new(Notify::new());
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let mut child = monitored_cat_process();

        monitor_process(
            "test-sandbox",
            &mut child,
            Arc::clone(&state),
            guest,
            Arc::clone(&crash_notify),
        );

        let notified = crash_notify.notified();
        drop(child.stdin.take());
        wait_for_state(&state, SandboxState::Stopped).await;

        let result = tokio::time::timeout(Duration::from_millis(50), notified).await;
        assert!(result.is_err(), "notify should have timed out");

        let status = child.wait().await.unwrap();
        assert!(status.success());
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

    #[tokio::test]
    async fn park_inflates_and_pauses() {
        let (sock, reqs, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new(), None).await;

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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

        let original_controller: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
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
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        let result = unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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

        let original_controller: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
        let original_id = original_controller.id();
        let mut controller = Some(original_controller);
        let mut is_parked = true;
        let crash_notify = Arc::new(Notify::new());

        unpark_inner(
            &mut is_parked,
            512,
            &mut controller,
            &sock,
            &crash_notify,
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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
            &crash_notify,
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

        let original_controller: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
        let original_id = original_controller.id();
        let mut controller = Some(original_controller);
        let mut is_parked = false;
        let crash_notify = Arc::new(Notify::new());

        unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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

        let initial: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
        let mut controller = Some(initial);
        let mut is_parked = false;
        let crash_notify = Arc::new(Notify::new());

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
            &crash_notify,
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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
        let crash_notify = Arc::new(Notify::new());
        unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        let first = unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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
            &crash_notify,
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        let result = unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        // First attempt: resume OK, deflate fails.
        let first = unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
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
            &crash_notify,
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
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

        let original_controller: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
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
