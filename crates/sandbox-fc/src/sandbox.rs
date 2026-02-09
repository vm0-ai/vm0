use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig, SandboxError, SpawnHandle,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};
use vsock_host::VsockHost;

use crate::config::FirecrackerConfig;
use crate::network::{GUEST_NETWORK, PooledNetns, generate_guest_network_boot_args};
use crate::paths::SandboxPaths;

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for graceful shutdown via vsock.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for Firecracker API socket readiness after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

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

pub struct FirecrackerSandbox {
    config: SandboxConfig,
    factory_config: FirecrackerConfig,
    /// Cached `config.id.to_string()`.
    pub(crate) id: String,
    /// Workspace paths (used by factory to delete workspace on destroy).
    pub(crate) paths: SandboxPaths,
    /// Pooled network namespace (returned to pool on destroy).
    pub(crate) network: PooledNetns,
    /// Overlay file path (deleted on destroy).
    pub(crate) overlay: PathBuf,
    process: Option<tokio::process::Child>,
    /// Lifecycle state, shared with background log tasks for crash detection.
    state: Arc<AtomicU8>,
    /// Vsock guest connection, shared with background log tasks so they can
    /// drop the connection immediately when the process exits unexpectedly.
    guest: Arc<tokio::sync::Mutex<Option<VsockHost>>>,
}

impl FirecrackerSandbox {
    pub(crate) fn new(
        config: SandboxConfig,
        factory_config: FirecrackerConfig,
        paths: SandboxPaths,
        network: PooledNetns,
        overlay: PathBuf,
    ) -> Self {
        let id = config.id.to_string();
        Self {
            config,
            factory_config,
            id,
            paths,
            network,
            overlay,
            process: None,
            state: Arc::new(AtomicU8::new(SandboxState::Created as u8)),
            guest: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    fn current_state(&self) -> SandboxState {
        SandboxState::from_u8(self.state.load(Ordering::Acquire))
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
        let kernel_path = self.factory_config.kernel_path.display().to_string();
        let rootfs_path = self.factory_config.rootfs_path.display().to_string();
        let overlay_path = self.overlay.display().to_string();
        let vsock_path = self.paths.vsock().display().to_string();

        let boot_args = format!(
            "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on \
             quiet loglevel=0 nokaslr audit=0 numa=off mitigations=off noresume \
             init=/sbin/guest-init {network}",
            network = generate_guest_network_boot_args(),
        );

        serde_json::json!({
            "boot-source": {
                "kernel_image_path": kernel_path,
                "boot_args": boot_args,
            },
            "drives": [
                {
                    "drive_id": "rootfs",
                    "path_on_host": rootfs_path,
                    "is_root_device": true,
                    "is_read_only": true,
                },
                {
                    "drive_id": "overlay",
                    "path_on_host": overlay_path,
                    "is_root_device": false,
                    "is_read_only": false,
                },
            ],
            "machine-config": {
                "vcpu_count": self.config.resources.cpu_count,
                "mem_size_mib": self.config.resources.memory_mb,
            },
            "network-interfaces": [
                {
                    "iface_id": "eth0",
                    "guest_mac": GUEST_NETWORK.guest_mac,
                    "host_dev_name": GUEST_NETWORK.tap_name,
                },
            ],
            "vsock": {
                "guest_cid": 3,
                "uds_path": vsock_path,
            },
        })
    }

    /// Start using a fresh boot with `--config-file --no-api`.
    async fn start_fresh(&mut self) -> sandbox::Result<()> {
        let config = self.build_config();
        let config_json = serde_json::to_string_pretty(&config)
            .map_err(|e| SandboxError::StartFailed(format!("serialize config: {e}")))?;

        tokio::fs::write(self.paths.config(), config_json.as_bytes())
            .await
            .map_err(|e| SandboxError::StartFailed(format!("write config: {e}")))?;

        let username = current_username()?;

        // sudo ip netns exec {ns} sudo -u {user} firecracker --config-file {path} --no-api
        let mut child = tokio::process::Command::new("sudo")
            .arg("ip")
            .arg("netns")
            .arg("exec")
            .arg(&self.network.name)
            .arg("sudo")
            .arg("-u")
            .arg(&username)
            .arg(&self.factory_config.binary_path)
            .arg("--config-file")
            .arg(self.paths.config())
            .arg("--no-api")
            .current_dir(self.paths.workspace())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| SandboxError::StartFailed(format!("spawn firecracker: {e}")))?;

        monitor_process(
            &self.id,
            &mut child,
            Arc::clone(&self.state),
            Arc::clone(&self.guest),
        );
        self.process = Some(child);
        info!(id = %self.id, "firecracker started (fresh boot)");
        Ok(())
    }

    /// Start from a snapshot using `--api-sock` and bind mounts.
    async fn start_from_snapshot(&mut self) -> sandbox::Result<()> {
        let snapshot = self
            .factory_config
            .snapshot
            .as_ref()
            .ok_or_else(|| SandboxError::StartFailed("missing snapshot config".into()))?;

        let username = current_username()?;

        // Ensure bind mount target directories exist.
        tokio::fs::create_dir_all(&snapshot.vsock_bind_dir)
            .await
            .map_err(|e| SandboxError::StartFailed(format!("mkdir snapshot vsock: {e}")))?;

        if let Some(parent) = snapshot.overlay_bind_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| SandboxError::StartFailed(format!("mkdir snapshot overlay: {e}")))?;
        }

        // Create empty file as bind mount target for the overlay.
        let exists = tokio::fs::try_exists(&snapshot.overlay_bind_path)
            .await
            .unwrap_or_else(|e| {
                warn!(error = %e, "failed to check overlay mount target");
                false
            });
        if !exists {
            tokio::fs::write(&snapshot.overlay_bind_path, b"")
                .await
                .map_err(|e| {
                    SandboxError::StartFailed(format!("create overlay mount target: {e}"))
                })?;
        }

        // Use positional args ($1..$8) to avoid shell injection from paths.
        let inner_cmd = r#"mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec ip netns exec "$5" sudo -u "$6" "$7" --api-sock "$8""#;

        let mut child = tokio::process::Command::new("sudo")
            .args(["unshare", "--mount", "bash", "-c", inner_cmd, "_"])
            .arg(self.paths.vsock_dir()) // $1
            .arg(&snapshot.vsock_bind_dir) // $2
            .arg(&self.overlay) // $3
            .arg(&snapshot.overlay_bind_path) // $4
            .arg(&self.network.name) // $5
            .arg(&username) // $6
            .arg(&self.factory_config.binary_path) // $7
            .arg(self.paths.api_sock()) // $8
            .current_dir(self.paths.workspace())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| SandboxError::StartFailed(format!("spawn firecracker: {e}")))?;

        monitor_process(
            &self.id,
            &mut child,
            Arc::clone(&self.state),
            Arc::clone(&self.guest),
        );
        self.process = Some(child);
        info!(id = %self.id, "firecracker started (snapshot restore)");

        // Wait for Firecracker API to be ready.
        let api_sock = self.paths.api_sock();
        let client = crate::api::ApiClient::new(&api_sock);
        client
            .wait_for_ready(API_READY_TIMEOUT)
            .await
            .map_err(|e| SandboxError::StartFailed(format!("API not ready: {e}")))?;

        // Load snapshot and resume VM.
        let snapshot_str = snapshot.snapshot_path.display().to_string();
        let memory_str = snapshot.memory_path.display().to_string();
        client
            .load_snapshot(&snapshot_str, &memory_str)
            .await
            .map_err(|e| SandboxError::StartFailed(format!("snapshot load failed: {e}")))?;

        info!(id = %self.id, "snapshot loaded and resumed");
        Ok(())
    }

    /// Kill the process tree.
    ///
    /// The process chain is `sudo -> ip netns exec -> sudo -> firecracker`.
    /// We must kill the entire tree to avoid orphan processes.
    async fn kill_process(&mut self) {
        let Some(ref mut child) = self.process else {
            return;
        };

        if let Some(pid) = child.id() {
            kill_process_tree(pid).await;
        }

        // Reap the zombie process.
        let _ = child.wait().await;
        self.process = None;
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
    guest: Arc<tokio::sync::Mutex<Option<VsockHost>>>,
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

/// Recursively kill a process and all its descendants (depth-first).
async fn kill_process_tree(pid: u32) {
    use crate::command::{Privilege, exec};

    // Find child PIDs.
    let pid_str = pid.to_string();
    if let Ok(stdout) = exec("pgrep", &["-P", &pid_str], Privilege::User).await {
        for line in stdout.lines() {
            if let Ok(child_pid) = line.trim().parse::<u32>() {
                Box::pin(kill_process_tree(child_pid)).await;
            }
        }
    }

    // Kill this process.
    let _ = exec("kill", &["-9", &pid_str], Privilege::Sudo).await;
}

/// Get the current username via `getuid()`.
fn current_username() -> sandbox::Result<String> {
    let uid = nix::unistd::getuid();
    let user = nix::unistd::User::from_uid(uid)
        .map_err(|e| SandboxError::StartFailed(format!("lookup uid {uid}: {e}")))?
        .ok_or_else(|| SandboxError::StartFailed(format!("no user for uid {uid}")))?;
    Ok(user.name)
}

#[async_trait]
impl Sandbox for FirecrackerSandbox {
    fn id(&self) -> &str {
        &self.id
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        if self.current_state() != SandboxState::Created {
            return Err(SandboxError::StartFailed("sandbox already started".into()));
        }

        // Start the vsock listener BEFORE launching Firecracker.
        // The UDS must be bound before the guest tries to connect.
        let vsock_path = self.paths.vsock().display().to_string();
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
                return Err(SandboxError::StartFailed(format!("vsock connection: {e}")));
            }
            Err(e) => {
                self.kill_process().await;
                return Err(SandboxError::StartFailed(format!("vsock task: {e}")));
            }
        };

        *self.guest.lock().await = Some(vsock_guest);

        // Use CAS to avoid overwriting Stopped if the process crashed between
        // spawn and vsock connect (the background log task may have already
        // swapped the state to Stopped).
        if !self.transition(SandboxState::Created, SandboxState::Running) {
            self.guest.lock().await.take();
            self.kill_process().await;
            return Err(SandboxError::StartFailed(
                "process exited during startup".into(),
            ));
        }

        info!(id = %self.id, "sandbox started");
        Ok(())
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        let mut guard = self.guest.lock().await;
        let Some(ref mut guest) = *guard else {
            return Err(SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            )));
        };

        let result = guest
            .exec(request.cmd, request.timeout_ms)
            .await
            .map_err(|e| SandboxError::ExecFailed(e.to_string()))?;

        Ok(ExecResult {
            exit_code: result.exit_code,
            stdout: String::from_utf8_lossy(&result.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&result.stderr).into_owned(),
        })
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let mut guard = self.guest.lock().await;
        let Some(ref mut guest) = *guard else {
            return Err(SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            )));
        };

        guest
            .write_file(path, content, false)
            .await
            .map_err(|e| SandboxError::ExecFailed(e.to_string()))?;

        Ok(())
    }

    async fn spawn_watch(&self, request: &ExecRequest<'_>) -> sandbox::Result<SpawnHandle> {
        let mut guard = self.guest.lock().await;
        let Some(ref mut guest) = *guard else {
            return Err(SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            )));
        };

        let pid = guest
            .spawn_watch(request.cmd, request.timeout_ms)
            .await
            .map_err(|e| SandboxError::ExecFailed(e.to_string()))?;

        Ok(SpawnHandle { pid })
    }

    async fn wait_exit(&self, handle: SpawnHandle) -> sandbox::Result<ProcessExit> {
        let mut guard = self.guest.lock().await;
        let Some(ref mut guest) = *guard else {
            return Err(SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            )));
        };

        let timeout = Duration::from_secs(self.config.resources.timeout_secs);
        let event = guest
            .wait_for_exit(handle.pid, timeout)
            .await
            .map_err(|e| SandboxError::ExecFailed(e.to_string()))?;

        Ok(ProcessExit {
            pid: event.pid,
            exit_code: event.exit_code,
            stdout: event.stdout,
            stderr: event.stderr,
        })
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            return Ok(());
        }

        // Try graceful shutdown via vsock.
        {
            let mut guard = self.guest.lock().await;
            if let Some(ref mut guest) = *guard
                && !guest.shutdown(SHUTDOWN_TIMEOUT).await
            {
                warn!(id = %self.id, "graceful shutdown timed out");
            }
            guard.take();
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
        self.guest.lock().await.take();
        self.kill_process().await;
        self.state
            .store(SandboxState::Stopped as u8, Ordering::Release);
        info!(id = %self.id, "sandbox killed");
        Ok(())
    }
}
