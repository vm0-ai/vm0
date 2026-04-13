use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig, SandboxError, SpawnHandle,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;
use tracing::{info, warn};
use vsock_host::VsockHost;

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
    /// Set by `park()` on success (including the small-profile no-op case)
    /// and cleared by `unpark()`. Used to make both methods idempotent and
    /// to let `unpark()` know whether it should touch the balloon
    /// controller or treat the call as a pure no-op.
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
        let config_json = serde_json::to_string_pretty(&config)
            .map_err(|e| SandboxError::StartFailed(format!("serialize config: {e}")))?;

        tokio::fs::write(self.sandbox_paths.config(), config_json.as_bytes())
            .await
            .map_err(|e| SandboxError::StartFailed(format!("write config: {e}")))?;

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
            .map_err(|e| SandboxError::StartFailed(format!("spawn firecracker: {e}")))?;

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
                result.map_err(|e| SandboxError::StartFailed(format!(
                    "API not ready: {e} (api_sock={})",
                    api_sock.display()
                )))?;
            }
            () = crash.notified() => {
                return Err(SandboxError::StartFailed(format!(
                    "firecracker process exited before API became ready (api_sock={})",
                    api_sock.display()
                )));
            }
        }

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

        // Ensure bind mount target directories exist.
        tokio::fs::create_dir_all(&snapshot.vsock_bind_dir)
            .await
            .map_err(|e| SandboxError::StartFailed(format!("mkdir snapshot vsock: {e}")))?;

        if let Some(parent) = snapshot.drive_bind_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| SandboxError::StartFailed(format!("mkdir snapshot drive: {e}")))?;
        }

        // Verify sock dir exists before spawning — if this fails, we know
        // the directory was never created or was removed before spawn.
        let api_sock = self.sock_paths.api_sock();
        let sock_dir = self.sock_paths.dir();
        let sock_dir_exists = tokio::fs::try_exists(sock_dir).await.unwrap_or(false);
        if !sock_dir_exists {
            return Err(SandboxError::StartFailed(format!(
                "sock dir missing before spawn: {}",
                sock_dir.display()
            )));
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

        // Use positional args ($1..$8) to avoid shell injection from paths.
        //
        // Bind mount targets ($2, $4) are snapshot-level paths shared by all
        // sandboxes.  Each sandbox runs inside `unshare --mount`, so bind
        // mounts are per-namespace and don't conflict.
        //
        // IMPORTANT: we must NOT `rm -f` the bind mount target.  The target
        // file is shared across all mount namespaces via the underlying
        // filesystem.  Deleting it would orphan bind mounts in other
        // namespaces (their mount is on the old dentry, but the directory
        // now points to a new dentry from `touch`), causing Firecracker to
        // see an empty file instead of the dm device → Permission denied.
        //
        // `umount` clears any stale mount inherited from the parent
        // namespace (e.g. from a crashed snapshot creation).
        // `test -e || touch` creates the file only if missing (first use
        // or after manual cleanup), never deleting an existing one.
        let inner_cmd = r#"umount "$4" 2>/dev/null; test -e "$4" || touch "$4"; mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec ip netns exec "$5" "$6" --api-sock "$7""#;

        let mut child = tokio::process::Command::new("unshare")
            .args(["--mount", "bash", "-c", inner_cmd, "_"])
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
            .map_err(|e| SandboxError::StartFailed(format!("spawn firecracker: {e}")))?;

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
                    SandboxError::StartFailed(format!(
                        "API not ready: {e} (api_sock={}, sock_dir_exists_after={sock_dir_after})",
                        api_sock.display()
                    ))
                })?;
            }
            () = crash.notified() => {
                return Err(SandboxError::StartFailed(format!(
                    "firecracker process exited before API became ready (api_sock={})",
                    api_sock.display()
                )));
            }
        }

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
            return Err(SandboxError::StartFailed("sandbox already started".into()));
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
                return Err(SandboxError::StartFailed(format!("vsock connection: {e}")));
            }
            Err(e) => {
                self.kill_process().await;
                return Err(SandboxError::StartFailed(format!("vsock task: {e}")));
            }
        };

        *self.guest.lock().await = Some(Arc::new(vsock_guest));

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

        // Try graceful shutdown via vsock.
        {
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
    // idle pool. It stops the reactive balloon controller, then issues a
    // single PATCH /balloon to reclaim as much guest memory as possible
    // (down to `MIN_GUEST_MIB` for kernel headroom).
    //
    // `unpark()` is called when the runner pulls the sandbox back out of
    // the idle pool. It deflates the balloon and respawns the reactive
    // controller so active workload is served with full memory again.
    //
    // Both methods propagate balloon PATCH failures as `IdleTransition`
    // errors — on failure the caller (runner) destroys the sandbox and
    // falls through to fresh-create. On a healthy Firecracker the PATCH
    // /balloon API is essentially infallible; a failure here strongly
    // indicates FC is dead or unhealthy, which destroy-and-refresh
    // handles cleanly.
    //
    // For profiles where `memory_mb <= MIN_GUEST_MIB` there is nothing to
    // reclaim, so both methods become pure no-ops — the reactive controller
    // is left running throughout the idle period.
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
        let guest = self.guest.lock().await.as_ref().cloned().ok_or_else(|| {
            SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            ))
        })?;

        tokio::select! {
            result = guest.exec(request.cmd, request.timeout_ms(), request.env, request.sudo) => {
                let result = result.map_err(|e| SandboxError::ExecFailed(e.to_string()))?;
                Ok(ExecResult {
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                })
            }
            _ = self.crash_notify.notified() => {
                Err(SandboxError::ExecFailed("firecracker process crashed".into()))
            }
        }
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let guest = self.guest.lock().await.as_ref().cloned().ok_or_else(|| {
            SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            ))
        })?;

        tokio::select! {
            result = guest.write_file(path, content, false) => {
                result.map_err(|e| SandboxError::ExecFailed(e.to_string()))
            }
            _ = self.crash_notify.notified() => {
                Err(SandboxError::ExecFailed("firecracker process crashed".into()))
            }
        }
    }

    async fn spawn_watch(
        &self,
        request: &ExecRequest<'_>,
        stdout_log_path: Option<&str>,
    ) -> sandbox::Result<SpawnHandle> {
        let guest = self.guest.lock().await.as_ref().cloned().ok_or_else(|| {
            SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            ))
        })?;

        tokio::select! {
            result = guest.spawn_watch(request.cmd, request.timeout_ms(), request.env, request.sudo, stdout_log_path) => {
                let (pid, stdout_rx) = result.map_err(|e| SandboxError::ExecFailed(e.to_string()))?;
                Ok(SpawnHandle { pid, stdout_rx: Some(stdout_rx) })
            }
            _ = self.crash_notify.notified() => {
                Err(SandboxError::ExecFailed("firecracker process crashed".into()))
            }
        }
    }

    async fn wait_exit(
        &self,
        handle: SpawnHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let guest = self.guest.lock().await.as_ref().cloned().ok_or_else(|| {
            SandboxError::ExecFailed(format!(
                "sandbox not running (state: {})",
                self.current_state()
            ))
        })?;

        tokio::select! {
            result = guest.wait_for_exit(handle.pid, timeout) => {
                let event = result.map_err(|e| SandboxError::ExecFailed(e.to_string()))?;
                Ok(ProcessExit {
                    pid: event.pid,
                    exit_code: event.exit_code,
                    stdout: event.stdout,
                    stderr: event.stderr,
                })
            }
            _ = self.crash_notify.notified() => {
                Err(SandboxError::ExecFailed("firecracker process crashed".into()))
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
    if target == 0 {
        // Profile too small to balloon — keep the reactive controller
        // running (it will be a no-op anyway since max_inflate == 0).
        *is_parked = true;
        info!(id = %log_id, memory_mb, "sandbox parked (no-op: memory below balloon threshold)");
        return Ok(());
    }

    // Stop the reactive controller so we're the sole writer to /balloon.
    // abort() + await ensures any in-flight PATCH from the controller
    // completes (or is cancelled) before ours lands.
    //
    // Ordering note: we abort BEFORE the PATCH (rather than after) because
    // the controller's reactive logic would otherwise see the post-inflate
    // drop in `available_memory` as memory pressure and immediately deflate
    // back, undoing our work.
    //
    // Failure-mode invariant: if patch_balloon returns Err, the controller
    // is gone and `is_parked` stays false. This is an intentional
    // "transient inconsistent" state — the runner's only failure handling
    // is `stop_and_destroy_sandbox`, so the sandbox is dropped (and Drop
    // ensures any leftover handles are aborted) before any further
    // operations can observe the missing controller.
    if let Some(h) = balloon_controller.take() {
        h.abort();
        let _ = h.await;
    }

    let client = ApiClient::new(api_sock);
    client
        .patch_balloon(target)
        .await
        .map_err(|e| SandboxError::IdleTransition(format!("balloon inflate: {e}")))?;

    *is_parked = true;
    info!(id = %log_id, target_mib = target, "sandbox parked (balloon inflated)");
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
        let client = ApiClient::new(api_sock);
        client
            .patch_balloon(0)
            .await
            .map_err(|e| SandboxError::IdleTransition(format!("balloon deflate: {e}")))?;

        *balloon_controller = Some(balloon::spawn(
            api_sock.to_path_buf(),
            memory_mb,
            Arc::clone(crash_notify),
        ));
    }

    *is_parked = false;
    info!(id = %log_id, "sandbox unparked");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulate the `monitor_process` crash detection flow:
    /// swap state from Running → Stopped, then fire crash_notify.
    /// Verify that a waiter on `crash_notify.notified()` resolves.
    #[tokio::test]
    async fn crash_notify_fires_on_unexpected_exit() {
        let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
        let crash_notify = Arc::new(Notify::new());

        let notify_clone = Arc::clone(&crash_notify);
        let state_clone = Arc::clone(&state);
        tokio::spawn(async move {
            // Simulate monitor_process detecting unexpected exit.
            let prev = SandboxState::from_u8(
                state_clone.swap(SandboxState::Stopped as u8, Ordering::AcqRel),
            );
            assert_eq!(prev, SandboxState::Running);
            notify_clone.notify_waiters();
        });

        // Waiter should resolve promptly.
        tokio::time::timeout(std::time::Duration::from_secs(1), crash_notify.notified())
            .await
            .unwrap();
    }

    /// When the process is stopped gracefully (state transitions to Stopping
    /// before pipe close), crash_notify should NOT fire.
    #[tokio::test]
    async fn crash_notify_does_not_fire_on_graceful_stop() {
        let state = Arc::new(AtomicU8::new(SandboxState::Stopping as u8));
        let crash_notify = Arc::new(Notify::new());

        // Simulate pipe close after graceful stop — state is Stopping, not Running.
        let prev = SandboxState::from_u8(state.swap(SandboxState::Stopped as u8, Ordering::AcqRel));
        assert_eq!(prev, SandboxState::Stopping);
        // crash_notify is NOT fired (prev != Running).

        // Verify notify does NOT resolve.
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            crash_notify.notified(),
        )
        .await;
        assert!(result.is_err(), "notify should have timed out");
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

    // -- idle transition tests --
    //
    // These exercise `park_inner` / `unpark_inner` against a mock Firecracker
    // API socket. We assert on:
    //   1. the correct sequence of PATCH /balloon requests (bodies captured);
    //   2. whether the reactive controller handle is present / absent;
    //   3. the is_parked flag state; and
    //   4. idempotency on repeat calls.

    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;
    use tokio::sync::Mutex as TokioMutex;

    /// Spawn a mock FC API server on a temporary Unix socket. It responds to
    /// any number of PATCH /balloon calls. The response status is configurable
    /// per call via `responses` (consumed FIFO; defaults to 204 once empty).
    /// All received PATCH bodies are captured into `bodies`.
    ///
    /// Returns (sock_path, bodies_handle, tempdir) — keep the tempdir alive
    /// until the test finishes so the socket isn't cleaned up prematurely.
    async fn spawn_mock_fc_api(
        mut responses: std::collections::VecDeque<u16>,
    ) -> (PathBuf, Arc<TokioMutex<Vec<String>>>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("api.sock");
        let listener = UnixListener::bind(&sock_path)
            .unwrap_or_else(|e| panic!("bind {}: {e}", sock_path.display()));

        let bodies: Arc<TokioMutex<Vec<String>>> = Arc::new(TokioMutex::new(Vec::new()));
        let bodies_clone = Arc::clone(&bodies);

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let bodies_inner = Arc::clone(&bodies_clone);
                let status = responses.pop_front().unwrap_or(204);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if let Some(pos) = req.find("\r\n\r\n") {
                        bodies_inner.lock().await.push(req[pos + 4..].to_string());
                    }
                    let (reason, body) = if status == 204 {
                        ("No Content", String::new())
                    } else {
                        ("Bad Request", r#"{"fault_message":"test"}"#.to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        (sock_path, bodies, dir)
    }

    #[tokio::test]
    async fn park_inflates_and_aborts_controller() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

        // Stand in for the existing reactive controller with a simple
        // sleeping task — park_inner should abort it.
        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
        let mut is_parked = false;

        park_inner(&mut is_parked, 2048, &mut controller, &sock, "test-park")
            .await
            .unwrap();

        assert!(is_parked, "is_parked should be set");
        assert!(controller.is_none(), "controller handle should be taken");
        let bodies = bodies.lock().await;
        assert_eq!(
            bodies.len(),
            1,
            "expected exactly one PATCH, got {bodies:?}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 1536); // 2048 - 512
    }

    #[tokio::test]
    async fn park_inflates_by_one_at_min_plus_one() {
        // Boundary: memory_mb = MIN_GUEST_MIB + 1 → target = 1.
        // Confirms the saturating_sub branch and the >0 check route the
        // smallest non-trivial profile through the active-inflate path.
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

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
        assert!(
            controller.is_none(),
            "513 MiB profile must take the active-inflate branch (controller aborted)"
        );
        let bodies = bodies.lock().await;
        assert_eq!(bodies.len(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 1);
    }

    #[tokio::test]
    async fn park_noop_when_memory_at_min() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

        let original_controller: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
        let original_id = original_controller.id();
        let mut controller = Some(original_controller);
        let mut is_parked = false;

        park_inner(
            &mut is_parked,
            512, // equal to MIN_GUEST_MIB
            &mut controller,
            &sock,
            "test-park-small",
        )
        .await
        .unwrap();

        assert!(is_parked, "is_parked should still be set");
        let still_there = controller.as_ref().expect("controller must be preserved");
        assert_eq!(
            still_there.id(),
            original_id,
            "controller must not be replaced or aborted"
        );
        assert!(
            bodies.lock().await.is_empty(),
            "no PATCH should be issued for small profiles"
        );
    }

    #[tokio::test]
    async fn unpark_deflates_and_respawns_controller() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

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

        // PATCH /balloon {amount_mib: 0} from unpark, plus the first tick
        // of the freshly spawned reactive controller may issue a GET
        // /balloon/statistics (which we don't handle here, but that's fine —
        // we're only checking that the deflate PATCH was observed).
        let bodies = bodies.lock().await;
        let deflate = bodies
            .iter()
            .find(|b| {
                serde_json::from_str::<serde_json::Value>(b)
                    .ok()
                    .and_then(|v| v["amount_mib"].as_u64())
                    == Some(0)
            })
            .expect("deflate PATCH not observed");
        assert!(deflate.contains("amount_mib"), "body: {deflate}");

        // Abort the respawned reactive controller so the test runtime
        // doesn't leave a 5s-tick task running against the mock socket.
        if let Some(h) = controller.take() {
            h.abort();
        }
    }

    #[tokio::test]
    async fn unpark_propagates_deflate_error() {
        // Mock returns 400 on the first PATCH (deflate). Unpark must
        // propagate the failure as `IdleTransition` so the runner can
        // destroy the sandbox and fall through to fresh-create. On Err,
        // is_parked stays true and controller stays None — consistent with
        // park_inner's failure semantics.
        let (sock, bodies, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![400])).await;

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

        assert!(matches!(result, Err(SandboxError::IdleTransition(_))));
        assert!(is_parked, "flag must stay true on failure");
        assert!(
            controller.is_none(),
            "controller must not be respawned on failure"
        );

        // Verify a deflate PATCH was actually attempted — guards against
        // refactors that accidentally short-circuit before the PATCH.
        let bodies = bodies.lock().await;
        assert_eq!(bodies.len(), 1, "expected exactly one PATCH attempt");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&bodies[0]).unwrap()["amount_mib"]
                .as_u64()
                .unwrap(),
            0,
            "deflate PATCH must target amount_mib=0"
        );
    }

    #[tokio::test]
    async fn unpark_on_small_vm_is_a_noop() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

        let original_controller: tokio::task::JoinHandle<()> =
            tokio::spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
        let original_id = original_controller.id();
        let mut controller = Some(original_controller);
        let mut is_parked = true; // was parked (as a no-op) earlier
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
        assert!(
            bodies.lock().await.is_empty(),
            "no PATCH should be issued for small profiles"
        );
    }

    #[tokio::test]
    async fn double_park_is_idempotent() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

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
        let bodies = bodies.lock().await;
        assert_eq!(
            bodies.len(),
            1,
            "expected exactly one PATCH despite double-park, got {bodies:?}"
        );
    }

    #[tokio::test]
    async fn double_unpark_is_idempotent() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

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
        // Only one deflate PATCH should have been issued.
        let deflate_count = bodies
            .lock()
            .await
            .iter()
            .filter(|b| {
                serde_json::from_str::<serde_json::Value>(b)
                    .ok()
                    .and_then(|v| v["amount_mib"].as_u64())
                    == Some(0)
            })
            .count();
        assert_eq!(deflate_count, 1, "expected exactly one deflate PATCH");

        // Abort the respawned reactive controller.
        if let Some(h) = controller.take() {
            h.abort();
        }
    }

    #[tokio::test]
    async fn unpark_without_park_is_noop() {
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

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
        assert!(bodies.lock().await.is_empty());
    }

    #[tokio::test]
    async fn park_unpark_park_cycle() {
        // Simulates a production reuse sequence:
        //   turn 1: sandbox created → park
        //   turn 2: take → unpark → (job runs) → park
        // The is_parked flag should oscillate correctly, PATCHes should
        // follow the expected sequence (inflate, deflate, inflate), and
        // each unpark's respawned controller must be aborted by the next
        // park (no leak of the intermediate controller task).
        let (sock, bodies, _dir) = spawn_mock_fc_api(std::collections::VecDeque::new()).await;

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

        // PATCH sequence: inflate(1536), deflate(0), inflate(1536).
        //
        // Fragility note: the respawned reactive controller's first tick
        // fires immediately (tokio::time::interval burst-mode) and issues
        // GET /balloon/statistics against this mock. `spawn_mock_fc_api`
        // returns an empty 204 for any request, so the client's JSON parse
        // fails and the controller tick early-returns without issuing a
        // PATCH. The `filter_map(|v| v["amount_mib"].as_u64())` below also
        // drops any empty GET bodies that did land in `bodies`. If the
        // mock is ever upgraded to return a parseable stats body, this
        // test may see an extra controller-originated PATCH and will need
        // to be reworked.
        let bodies = bodies.lock().await;
        let amounts: Vec<u64> = bodies
            .iter()
            .filter_map(|b| serde_json::from_str::<serde_json::Value>(b).ok())
            .filter_map(|v| v["amount_mib"].as_u64())
            .collect();
        assert_eq!(
            amounts,
            vec![1536, 0, 1536],
            "expected inflate, deflate, inflate sequence; got {amounts:?}"
        );
    }

    #[tokio::test]
    async fn park_patch_failure_leaves_flag_false() {
        // Mock returns 400 on the first PATCH.
        let (sock, _bodies, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![400])).await;

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

        assert!(matches!(result, Err(SandboxError::IdleTransition(_))));
        assert!(!is_parked, "flag must stay false on failure");
        // Controller was already aborted by park before the PATCH attempt.
        assert!(controller.is_none());

        // A follow-up unpark must be a clean no-op because is_parked is false.
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
        // First PATCH fails (400), the retry succeeds (204).
        let (sock, bodies, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![400, 204])).await;

        let mut controller: Option<tokio::task::JoinHandle<()>> = Some(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await
        }));
        let mut is_parked = false;

        // First park attempt: PATCH returns 400, flag stays false, controller
        // is gone (aborted before PATCH).
        let first = park_inner(&mut is_parked, 2048, &mut controller, &sock, "retry").await;
        assert!(matches!(first, Err(SandboxError::IdleTransition(_))));
        assert!(!is_parked);
        assert!(controller.is_none());

        // Second park attempt: controller slot is already None (no-op
        // .take()), PATCH succeeds (204), flag flips to true.
        park_inner(&mut is_parked, 2048, &mut controller, &sock, "retry")
            .await
            .unwrap();
        assert!(is_parked);
        assert!(controller.is_none());

        // Both PATCHes targeted the same inflate amount (2048 - 512 = 1536).
        let bodies = bodies.lock().await;
        assert_eq!(bodies.len(), 2, "expected two PATCH attempts");
        for (i, body) in bodies.iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(
                parsed["amount_mib"].as_u64().unwrap(),
                1536,
                "PATCH #{i} body must inflate to 1536 MiB"
            );
        }
    }

    #[tokio::test]
    async fn unpark_retry_after_failure_succeeds() {
        // Symmetric counterpart to `park_retry_after_failure_succeeds`.
        // First PATCH (deflate) fails with 400, the retry succeeds with 204.
        let (sock, bodies, _dir) =
            spawn_mock_fc_api(std::collections::VecDeque::from(vec![400, 204])).await;

        let mut is_parked = true;
        let mut controller: Option<tokio::task::JoinHandle<()>> = None;
        let crash_notify = Arc::new(Notify::new());

        // First unpark attempt: PATCH 400, flag stays true, controller
        // stays None (not respawned on failure).
        let first = unpark_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &sock,
            &crash_notify,
            "retry",
        )
        .await;
        assert!(matches!(first, Err(SandboxError::IdleTransition(_))));
        assert!(is_parked, "flag must stay true on failure");
        assert!(controller.is_none(), "controller must not be respawned");

        // Second unpark attempt: PATCH 204, flag flips to false, controller
        // is respawned.
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

        // Both PATCHes targeted the deflate amount (0).
        let bodies = bodies.lock().await;
        let deflate_count = bodies
            .iter()
            .filter_map(|b| serde_json::from_str::<serde_json::Value>(b).ok())
            .filter(|v| v["amount_mib"].as_u64() == Some(0))
            .count();
        assert_eq!(deflate_count, 2, "expected two deflate PATCHes");

        // Abort the respawned reactive controller so the test runtime
        // doesn't leave a 5s-tick task running against the mock socket.
        if let Some(h) = controller.take() {
            h.abort();
        }
    }
}
