use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncBufReadExt;
use tokio::task::JoinHandle;
use tracing::info;

use nbd_cow::pool::DevicePoolHandle;
use nbd_cow::{DestroyRetryPolicy, PooledNbdCowDevice};
use sandbox::{SnapshotCreateConfig, SnapshotOutput, SnapshotProvider};

use crate::api::{ApiClient, ApiError};
use crate::config::SnapshotConfig;
use crate::factory::{InvariantConfig, config_hash};
use crate::network::{NetnsLease, NetnsPool, NetnsPoolConfig};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::prerequisites;
use crate::process::kill_process_group;

/// Timeout for waiting for the Firecracker API socket after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

use crate::factory::{DESTROY_RETRIES, DESTROY_RETRY_DELAY};

fn cow_destroy_retry_policy() -> DestroyRetryPolicy {
    DestroyRetryPolicy {
        attempts: DESTROY_RETRIES,
        delay: DESTROY_RETRY_DELAY,
    }
}

async fn destroy_snapshot_cow_after_error(context: &'static str, cow_device: PooledNbdCowDevice) {
    let cow_file = cow_device.cow_file().to_path_buf();
    if let Err(e) = cow_device
        .destroy_with_retries(cow_destroy_retry_policy())
        .await
    {
        tracing::warn!(
            error = %e,
            context,
            "failed to destroy COW device after snapshot setup error"
        );
    } else {
        cleanup_snapshot_attempt_dir_for_cow(&cow_file).await;
    }
}

/// Errors that can occur during Firecracker snapshot creation.
///
/// These are the backend-specific errors returned by direct calls to
/// [`create_snapshot`]. When snapshotting is invoked through
/// [`FirecrackerSnapshotProvider`], they are converted into the provider-neutral
/// `sandbox::SnapshotError` categories.
///
/// A failed attempt should be treated as not producing a usable snapshot.
/// Cleanup is best-effort on most failure paths: stale output artifacts are
/// removed at the start of the next attempt where possible, while some backend
/// resources may need the runner garbage collector or operator inspection.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// Host or guest setup failed before a valid snapshot was finalized.
    ///
    /// This includes prerequisite checks, output/work/socket path setup, COW
    /// file and NBD device preparation, network namespace setup/acquisition,
    /// and guest pre-warm command execution. Retry is meaningful after fixing
    /// the reported prerequisite/configuration issue or after a transient
    /// resource failure clears.
    #[error("setup failed: {0}")]
    Setup(String),
    /// The Firecracker launch path failed at the process boundary.
    ///
    /// This includes failing to spawn the `unshare`/network-namespace
    /// Firecracker command and cases where that launch chain exits early and an
    /// API timeout is reclassified with the captured process stderr. The
    /// snapshot output is not valid.
    #[error("firecracker process failed: {0}")]
    Process(String),
    /// Snapshot resource teardown failed after the workflow had otherwise
    /// reached the finalization phase.
    ///
    /// Currently this is used when `destroy_keep_cow` exhausts its retries.
    /// The NBD device is abandoned for later garbage collection and the
    /// snapshot is aborted rather than publishing a COW file without a trusted
    /// bitmap sidecar.
    #[error("teardown failed: {0}")]
    Teardown(String),
    /// The Firecracker API failed while waiting for readiness, configuring the
    /// VM, starting the instance, pausing it, or asking Firecracker to write
    /// snapshot state and memory files.
    #[error("api error: {0}")]
    Api(#[from] ApiError),
    /// The guest did not establish the expected vsock readiness connection, or
    /// the listener task failed while waiting for it.
    ///
    /// Firecracker may already be running when this happens, but the snapshot
    /// workflow has not reached the pre-warm, pause, or snapshot stages.
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    /// A host filesystem I/O operation failed while creating directories,
    /// moving finalized COW artifacts, or syncing the output directory.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl SnapshotError {
    fn into_sandbox_error(self) -> sandbox::SnapshotError {
        match self {
            Self::Setup(msg) => sandbox::SnapshotError::Setup(msg),
            Self::Process(msg) => sandbox::SnapshotError::Process(msg),
            Self::Teardown(msg) => sandbox::SnapshotError::Teardown(msg),
            Self::Api(api_err) => sandbox::SnapshotError::Api(api_err.to_string()),
            Self::Vsock(msg) => sandbox::SnapshotError::Vsock(msg),
            Self::Io(io_err) => sandbox::SnapshotError::Io(io_err),
        }
    }
}

async fn prepare_snapshot_output(output: &SnapshotOutputPaths) -> Result<PathBuf, SnapshotError> {
    // Paths inside work_dir get baked into the snapshot and are used as
    // bind-mount targets during restore, so they must be deterministic.
    //
    // Only remove snapshot-specific artifacts, not the entire output directory.
    let work = output.work_dir();
    let _ = tokio::fs::remove_dir_all(&work).await;
    for stale in [
        output.snapshot(),
        output.memory(),
        output.cow(),
        output.cow_bitmap(),
    ] {
        let _ = tokio::fs::remove_file(&stale).await;
    }
    tokio::fs::create_dir_all(&work).await?;
    Ok(work)
}

async fn cleanup_existing_snapshot_sock_dir(sock_dir: &Path) {
    if sock_dir.exists()
        && let Err(e) = tokio::fs::remove_dir_all(sock_dir).await
    {
        tracing::warn!(error = %e, "failed to clean stale sock dir");
    }
}

async fn cleanup_snapshot_sock_dir(sock_dir: &Path, warning: &'static str) -> bool {
    match tokio::fs::remove_dir_all(sock_dir).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(error = %e, "{warning}");
            false
        }
    }
}

fn create_sparse_cow_file(path: &Path, size: u64) -> Result<(), SnapshotError> {
    let file = std::fs::File::create(path)
        .map_err(|e| SnapshotError::Setup(format!("create COW file: {e}")))?;
    file.set_len(size)
        .map_err(|e| SnapshotError::Setup(format!("set COW file size: {e}")))?;
    Ok(())
}

fn snapshot_attempt_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn snapshot_attempt_dir(work_dir: &Path, token: &str) -> PathBuf {
    work_dir.join("attempts").join(token)
}

fn snapshot_attempt_cow_file(work_dir: &Path, token: &str) -> PathBuf {
    snapshot_attempt_dir(work_dir, token).join("cow.img")
}

struct SnapshotAttemptDirGuard {
    dir: Option<PathBuf>,
}

impl SnapshotAttemptDirGuard {
    fn new(dir: PathBuf) -> Self {
        Self { dir: Some(dir) }
    }

    fn disarm(&mut self) {
        self.dir.take();
    }
}

impl Drop for SnapshotAttemptDirGuard {
    fn drop(&mut self) {
        let Some(dir) = self.dir.take() else {
            return;
        };
        if let Err(e) = std::fs::remove_dir_all(&dir)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(
                error = %e,
                dir = %dir.display(),
                "failed to cleanup unowned snapshot attempt dir"
            );
        }
    }
}

async fn cleanup_snapshot_attempt_dir_for_cow(cow_file: &Path) -> bool {
    let Some(dir) = cow_file.parent() else {
        return true;
    };
    match tokio::fs::remove_dir(dir).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                dir = %dir.display(),
                "failed to cleanup snapshot attempt dir"
            );
            false
        }
    }
}

async fn cleanup_after_netns_pool_failure(
    cow_device: PooledNbdCowDevice,
    device_pool: &DevicePoolHandle,
    sock_dir: &Path,
) {
    let cow_file = cow_device.cow_file().to_path_buf();
    if let Err(cleanup_err) = cow_device
        .destroy_with_retries(cow_destroy_retry_policy())
        .await
    {
        tracing::warn!(
            error = %cleanup_err,
            "failed to destroy COW device after netns pool failure"
        );
    } else {
        cleanup_snapshot_attempt_dir_for_cow(&cow_file).await;
    }
    device_pool.cleanup().await;
    cleanup_snapshot_sock_dir(
        sock_dir,
        "failed to cleanup sock dir after netns pool failure",
    )
    .await;
}

async fn release_snapshot_netns(
    netns_pool: &mut NetnsPool,
    network: &mut Option<NetnsLease>,
    warning: &'static str,
) {
    if let Err(e) = netns_pool.release(network).await {
        tracing::warn!(error = %e, "{warning}");
    }
}

fn spawn_stdout_forwarder(child: &mut tokio::process::Child) -> Option<JoinHandle<()>> {
    child.stdout.take().map(|stdout| {
        // Intentionally detached: stdout has no cleanup decision input, and
        // EOF on the child pipe ends the task after Firecracker exits.
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    info!(target: "firecracker", "{line}");
                }
            }
        })
    })
}

fn spawn_stderr_forwarder(
    child: &mut tokio::process::Child,
    stderr_buf: &StderrBuf,
) -> Option<JoinHandle<()>> {
    child.stderr.take().map(|stderr| {
        let buf = Arc::clone(stderr_buf);
        // The caller retains this handle only for the early-exit drain path.
        // Otherwise EOF on the child pipe ends the task after Firecracker exits.
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    tracing::warn!(target: "firecracker", "stderr: {line}");
                    if let Ok(mut g) = buf.lock() {
                        if g.len() == STDERR_BUF_LINES {
                            g.pop_front();
                        }
                        g.push_back(line);
                    }
                }
            }
        })
    })
}

async fn drain_stderr_forwarder_after_spawn_exit(
    child_status: &std::io::Result<Option<std::process::ExitStatus>>,
    stderr_handle: Option<JoinHandle<()>>,
) -> Option<JoinHandle<()>> {
    if matches!(child_status, Ok(Some(status)) if !status.success())
        && let Some(handle) = stderr_handle
    {
        // Child's write end of stderr is closed; wait briefly for the
        // forwarder to finish reading so the captured buffer contains
        // the crash's final lines.
        let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, handle).await;
        None
    } else {
        stderr_handle
    }
}

async fn kill_and_reap_firecracker(child: &mut tokio::process::Child) {
    kill_process_group(child);
    let _ = child.wait().await;
}

async fn kill_and_reap_firecracker_bounded(
    child: &mut tokio::process::Child,
    timeout: Duration,
) -> bool {
    kill_process_group(child);
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "failed to wait for snapshot firecracker child during cleanup");
            false
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = timeout.as_millis() as u64,
                "timed out waiting for snapshot firecracker child during cleanup"
            );
            false
        }
    }
}

async fn drain_or_abort_forwarder(
    handle: &mut Option<JoinHandle<()>>,
    pipe: &'static str,
    timeout: Duration,
) -> bool {
    let Some(mut handle) = handle.take() else {
        return true;
    };

    tokio::select! {
        result = &mut handle => {
            match result {
                Ok(()) => true,
                Err(e) if e.is_cancelled() => true,
                Err(e) => {
                    tracing::warn!(pipe, error = %e, "snapshot pipe forwarder failed during cleanup");
                    false
                }
            }
        }
        () = tokio::time::sleep(timeout) => {
            handle.abort();
            if let Err(e) = handle.await
                && !e.is_cancelled()
            {
                tracing::warn!(pipe, error = %e, "snapshot pipe forwarder failed after abort");
                return false;
            }
            true
        }
    }
}

async fn finalize_snapshot_cow_output(
    cow_device: PooledNbdCowDevice,
    output: &SnapshotOutputPaths,
) -> Result<(), SnapshotError> {
    let kept_cow = cow_device
        .destroy_keep_cow_with_retries(cow_destroy_retry_policy())
        .await
        .map_err(|e| {
            SnapshotError::Teardown(format!(
                "destroy_keep_cow exhausted retries; device abandoned, snapshot aborted (last error: {e})"
            ))
        })?;
    // destroy_keep_cow succeeded, so save_bitmap succeeded — the bitmap
    // sidecar is on disk. Rename is unconditional: if the sidecar is
    // missing we want to fail loudly, not silently produce a
    // bitmap-less snapshot.
    tokio::fs::rename(&kept_cow.bitmap_file, &output.cow_bitmap()).await?;
    tokio::fs::rename(&kept_cow.cow_file, &output.cow()).await?;
    cleanup_snapshot_attempt_dir_for_cow(&kept_cow.cow_file).await;
    // Persist the output directory so all four final dir entries
    // (snapshot.bin and memory.bin written by Firecracker via the API,
    // cow.img and cow.img.bitmap just renamed in) are durable. Without
    // this fsync, rename(2) and Firecracker's creates return once the
    // update is journaled but the entry may not hit disk until the FS's
    // next commit (~5s on ext4 data=ordered). A crash in that window can
    // leave is_complete() returning true while one or more files are
    // missing or rolled back — worst case, cow.img present but
    // cow.img.bitmap absent, which silently corrupts restore reads
    // (same failure class as #9794, one layer up).
    let dir = tokio::fs::File::open(output.dir()).await?;
    dir.sync_all().await?;
    Ok(())
}

async fn destroy_snapshot_cow_after_workflow_error(cow_device: PooledNbdCowDevice) {
    let cow_file = cow_device.cow_file().to_path_buf();
    if let Err(e) = cow_device
        .destroy_with_retries(cow_destroy_retry_policy())
        .await
    {
        tracing::warn!(error = %e, "failed to destroy COW device after snapshot error");
    } else {
        cleanup_snapshot_attempt_dir_for_cow(&cow_file).await;
    }
}

/// Snapshot-local owner for resources acquired while producing one snapshot.
///
/// This owner centralizes the explicit success/failure cleanup path for
/// snapshot creation. It intentionally does not participate in the factory
/// leak-cleaner path used by sandbox creation: a snapshot attempt owns a
/// one-shot netns pool, a per-snapshot NBD device pool, a single COW device,
/// and one Firecracker child only until `finish_workflow` and the outer pool /
/// socket cleanup steps run.
///
/// Drop never performs async cleanup inline. If cancellation drops the attempt
/// while it still owns runtime resources, Drop moves them into a detached
/// snapshot cleanup finalizer when a Tokio runtime is available.
struct SnapshotAttempt {
    paths: SandboxPaths,
    // Socket paths are cleaned only by the explicit path while the caller still
    // holds the snapshot build lock. A detached Drop finalizer must not remove
    // this stable snapshot-id directory after cancellation, because another
    // runner may already be rebuilding the same snapshot.
    sock_paths: Option<SockPaths>,
    output: SnapshotOutputPaths,
    netns_pool: Option<NetnsPool>,
    device_pool: Option<DevicePoolHandle>,
    cow_device: Option<PooledNbdCowDevice>,
    network: Option<NetnsLease>,
    child: Option<tokio::process::Child>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    stderr_buf: StderrBuf,
    #[cfg(test)]
    cleanup_complete_tx: Option<tokio::sync::oneshot::Sender<SnapshotCleanupReport>>,
}

impl SnapshotAttempt {
    fn new(
        paths: SandboxPaths,
        sock_paths: SockPaths,
        output: SnapshotOutputPaths,
        netns_pool: NetnsPool,
        device_pool: DevicePoolHandle,
        cow_device: PooledNbdCowDevice,
    ) -> Self {
        Self {
            paths,
            sock_paths: Some(sock_paths),
            output,
            netns_pool: Some(netns_pool),
            device_pool: Some(device_pool),
            cow_device: Some(cow_device),
            network: None,
            child: None,
            stdout_handle: None,
            stderr_handle: None,
            stderr_buf: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES))),
            #[cfg(test)]
            cleanup_complete_tx: None,
        }
    }

    #[cfg(test)]
    fn new_without_cow_for_test(
        paths: SandboxPaths,
        sock_paths: SockPaths,
        output: SnapshotOutputPaths,
    ) -> Self {
        Self {
            paths,
            sock_paths: Some(sock_paths),
            output,
            netns_pool: Some(NetnsPool::inactive_for_test()),
            device_pool: None,
            cow_device: None,
            network: None,
            child: None,
            stdout_handle: None,
            stderr_handle: None,
            stderr_buf: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES))),
            #[cfg(test)]
            cleanup_complete_tx: None,
        }
    }

    #[cfg(test)]
    fn track_network_for_test(&mut self, name: &str) {
        if let Some(netns_pool) = self.netns_pool.as_mut() {
            let network = netns_pool.lease_for_test(name);
            netns_pool.track_lease_for_test(&network);
            self.network = Some(network);
        }
    }

    #[cfg(test)]
    fn track_child_for_test(&mut self, child: tokio::process::Child) {
        self.child = Some(child);
    }

    #[cfg(test)]
    fn track_stdout_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.stdout_handle = Some(handle);
    }

    #[cfg(test)]
    fn track_stderr_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.stderr_handle = Some(handle);
    }

    #[cfg(test)]
    fn notify_cleanup_complete_for_test(
        &mut self,
        tx: tokio::sync::oneshot::Sender<SnapshotCleanupReport>,
    ) {
        self.cleanup_complete_tx = Some(tx);
    }

    fn paths(&self) -> &SandboxPaths {
        &self.paths
    }

    fn sock_paths(&self) -> Result<&SockPaths, SnapshotError> {
        self.sock_paths
            .as_ref()
            .ok_or_else(|| SnapshotError::Setup("snapshot attempt missing socket paths".into()))
    }

    fn output(&self) -> &SnapshotOutputPaths {
        &self.output
    }

    async fn prepare_firecracker_files(&mut self) -> Result<(), SnapshotError> {
        // Filesystem pre-requisites that don't require the netns: do these
        // *before* `netns_pool.acquire()` so that a transient fs error
        // (mkdir, write) doesn't leak an acquired netns. A checked-out netns
        // lease requires explicit release, and `netns_pool.cleanup()` only
        // drains queued (not acquired) entries.
        //
        // The empty bind target file is consumed by `mount --bind` inside
        // `unshare --mount` at spawn time; file content is irrelevant
        // because the bind overlay is what FC reads.
        if let Err(e) = tokio::fs::create_dir_all(self.sock_paths()?.dir()).await {
            self.destroy_cow_after_setup_error("mkdir sock dir").await;
            return Err(SnapshotError::Setup(format!("mkdir sock dir: {e}")));
        }

        let drive_bind = self.paths.cow_device_bind();
        if let Err(e) = tokio::fs::write(&drive_bind, b"").await {
            self.destroy_cow_after_setup_error("create bind target")
                .await;
            return Err(SnapshotError::Setup(format!("create bind target: {e}")));
        }

        Ok(())
    }

    async fn acquire_network(&mut self) -> Result<(), SnapshotError> {
        let acquire_result = match self.netns_pool.as_mut() {
            Some(netns_pool) => netns_pool.acquire().await,
            None => {
                self.destroy_cow_after_setup_error("missing netns pool before acquire")
                    .await;
                return Err(SnapshotError::Setup(
                    "snapshot attempt missing netns pool before acquire".into(),
                ));
            }
        };
        let network = match acquire_result {
            Ok(network) => network,
            Err(e) => {
                self.destroy_cow_after_setup_error("acquire netns").await;
                return Err(SnapshotError::Setup(format!("acquire netns: {e}")));
            }
        };

        info!(netns = %network.info().name(), "namespace acquired");
        self.network = Some(network);
        Ok(())
    }

    async fn spawn_firecracker(
        &mut self,
        config: &SnapshotCreateConfig,
    ) -> Result<(), SnapshotError> {
        let api_sock = self.sock_paths()?.api_sock();
        let drive_bind = self.paths.cow_device_bind();
        let cow_device_path = self
            .cow_device
            .as_ref()
            .ok_or_else(|| {
                SnapshotError::Setup("snapshot attempt missing COW device before spawn".into())
            })?
            .device_path()
            .to_path_buf();
        let network_name = self
            .network
            .as_ref()
            .ok_or_else(|| {
                SnapshotError::Setup("snapshot attempt missing netns before spawn".into())
            })?
            .info()
            .name()
            .to_string();

        info!(
            netns = %network_name,
            binary = %config.binary_path.display(),
            api_sock = %api_sock.display(),
            "spawning firecracker"
        );

        // Spawn Firecracker inside `unshare --mount` so the COW-device bind
        // mount lives in a private mount namespace and dies with the process.
        // Mirrors the spawn pattern in `sandbox.rs::start_from_snapshot`.
        // Inner command is [`SPAWN_INNER_CMD`].
        let spawn_result = tokio::process::Command::new("unshare")
            .args(UNSHARE_MOUNT_ARGS)
            .args(["bash", "-c", SPAWN_INNER_CMD, "_"])
            .arg(&cow_device_path) // $1
            .arg(&drive_bind) // $2
            .arg(&network_name) // $3
            .arg(&config.binary_path) // $4
            .arg(&api_sock) // $5
            .current_dir(self.paths.workspace())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn();

        let mut child = match spawn_result {
            Ok(child) => child,
            Err(e) => {
                // Release the checked-out netns before returning —
                // `netns_pool.cleanup()` only drains queued entries, not
                // already-acquired ones.
                self.release_network("failed to release netns after spawn failure")
                    .await;
                self.destroy_cow_after_setup_error("spawn firecracker")
                    .await;
                return Err(SnapshotError::Process(format!("spawn firecracker: {e}")));
            }
        };

        // Stream stdout/stderr lines to tracing (same pattern as sandbox.rs).
        // Stderr is also retained in a bounded ring buffer so that an early
        // spawn-chain exit (mount failure inside unshare bash, etc.) can be
        // reported with its real cause instead of just an API timeout.
        self.stdout_handle = spawn_stdout_forwarder(&mut child);
        // The stderr forwarder handle is retained so that, on detected early
        // exit, we can wait a bounded time for it to drain buffered lines
        // before snapshotting the ring buffer for the error message. Without
        // this join, the most informative lines (mount: bind failed, etc.)
        // can race the `try_wait` observation and be missed.
        self.stderr_handle = spawn_stderr_forwarder(&mut child, &self.stderr_buf);
        self.child = Some(child);

        Ok(())
    }

    async fn finish_workflow(
        &mut self,
        result: Result<SnapshotConfig, SnapshotError>,
    ) -> Result<SnapshotConfig, SnapshotError> {
        // Probe for early spawn-chain exit *before* killing the process. This
        // distinguishes "firecracker is still running, error was an API/setup
        // issue" (try_wait → None) from "firecracker already died, error is
        // the downstream symptom of that" (try_wait → Some(non-zero)).
        let child_status = self
            .child
            .as_mut()
            .map_or(Ok(None), tokio::process::Child::try_wait);
        self.stderr_handle =
            drain_stderr_forwarder_after_spawn_exit(&child_status, self.stderr_handle.take()).await;
        let result = rewrap_spawn_chain_exit(result, child_status, &self.stderr_buf);

        // Kill Firecracker first — it holds the NBD device fd open.
        if let Some(child) = self.child.as_mut() {
            kill_and_reap_firecracker(child).await;
        }
        self.child.take();

        // Release network namespace back to the pool before teardown.
        // Without this, the namespace resources (veth, iptables) leak because
        // cleanup() only drains pool-owned namespaces, not checked-out leases.
        self.release_network("failed to release netns").await;

        // Tear down NBD COW device.
        //
        // After kill_process_group + child.wait(), the kernel may still be
        // releasing the NBD device fd. Retry destroy until all references are
        // released. The COW-device bind mount lived inside the FC process's
        // private mount namespace and was auto-cleaned when the process exited.
        if result.is_ok() {
            self.finalize_success().await?;
        } else {
            self.cleanup_failure().await;
        }

        self.drop_forwarder_handles();
        result
    }

    async fn cleanup_device_pool(&mut self) {
        if let Some(device_pool) = self.device_pool.as_ref() {
            device_pool.cleanup().await;
        }
        self.device_pool.take();
    }

    async fn cleanup_netns_pool(&mut self) {
        if let Some(netns_pool) = self.netns_pool.as_mut()
            && let Err(e) = netns_pool.cleanup().await
        {
            tracing::warn!(error = %e, "failed to cleanup netns pool");
        }
        self.netns_pool.take();
    }

    async fn cleanup_sock_dir(&mut self) {
        if let Some(sock_paths) = self.sock_paths.as_ref() {
            cleanup_snapshot_sock_dir(sock_paths.dir(), "failed to cleanup sock dir").await;
        }
        self.sock_paths.take();
    }

    async fn destroy_cow_after_setup_error(&mut self, context: &'static str) {
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_error(context, cow_device).await;
        }
    }

    async fn release_network(&mut self, warning: &'static str) {
        if self.network.is_some() {
            let Some(netns_pool) = self.netns_pool.as_mut() else {
                tracing::warn!("snapshot attempt missing netns pool while releasing netns");
                return;
            };
            release_snapshot_netns(netns_pool, &mut self.network, warning).await;
        }
    }

    async fn finalize_success(&mut self) -> Result<(), SnapshotError> {
        let cow_device = self.cow_device.take().ok_or_else(|| {
            SnapshotError::Teardown("snapshot attempt missing COW device before finalize".into())
        })?;
        finalize_snapshot_cow_output(cow_device, &self.output).await
    }

    async fn cleanup_failure(&mut self) {
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_workflow_error(cow_device).await;
        }
    }

    fn drop_forwarder_handles(&mut self) {
        self.stdout_handle.take();
        self.stderr_handle.take();
    }

    fn has_cleanup_work(&self) -> bool {
        self.device_pool.is_some()
            || self.netns_pool.is_some()
            || self.cow_device.is_some()
            || self.network.is_some()
            || self.child.is_some()
            || self.stdout_handle.is_some()
            || self.stderr_handle.is_some()
    }

    fn take_cleanup_finalizer(&mut self) -> Option<SnapshotCleanupFinalizer> {
        if !self.has_cleanup_work() {
            return None;
        }

        Some(SnapshotCleanupFinalizer {
            netns_pool: self.netns_pool.take(),
            device_pool: self.device_pool.take(),
            cow_device: self.cow_device.take(),
            network: self.network.take(),
            child: self.child.take(),
            stdout_handle: self.stdout_handle.take(),
            stderr_handle: self.stderr_handle.take(),
            #[cfg(test)]
            cleanup_complete_tx: self.cleanup_complete_tx.take(),
        })
    }
}

struct SnapshotCleanupReport {
    child_reaped: bool,
    stdout_forwarder_finished: bool,
    stderr_forwarder_finished: bool,
    network_released: bool,
    cow_destroyed: bool,
    device_pool_cleaned: bool,
    netns_pool_cleaned: bool,
}

struct SnapshotCleanupFinalizer {
    netns_pool: Option<NetnsPool>,
    device_pool: Option<DevicePoolHandle>,
    cow_device: Option<PooledNbdCowDevice>,
    network: Option<NetnsLease>,
    child: Option<tokio::process::Child>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    #[cfg(test)]
    cleanup_complete_tx: Option<tokio::sync::oneshot::Sender<SnapshotCleanupReport>>,
}

impl SnapshotCleanupFinalizer {
    async fn run(mut self) {
        let child_reaped = if let Some(child) = self.child.as_mut() {
            kill_and_reap_firecracker_bounded(child, SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT).await
        } else {
            true
        };
        self.child.take();

        let stdout_forwarder_finished = drain_or_abort_forwarder(
            &mut self.stdout_handle,
            "stdout",
            SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
        )
        .await;
        let stderr_forwarder_finished = drain_or_abort_forwarder(
            &mut self.stderr_handle,
            "stderr",
            SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
        )
        .await;

        let network_released = self.release_network().await;
        let cow_destroyed = self.destroy_cow().await;
        let device_pool_cleaned = self.cleanup_device_pool().await;
        let netns_pool_cleaned = self.cleanup_netns_pool().await;

        let report = SnapshotCleanupReport {
            child_reaped,
            stdout_forwarder_finished,
            stderr_forwarder_finished,
            network_released,
            cow_destroyed,
            device_pool_cleaned,
            netns_pool_cleaned,
        };

        tracing::info!(
            child_reaped = report.child_reaped,
            stdout_forwarder_finished = report.stdout_forwarder_finished,
            stderr_forwarder_finished = report.stderr_forwarder_finished,
            network_released = report.network_released,
            cow_destroyed = report.cow_destroyed,
            device_pool_cleaned = report.device_pool_cleaned,
            netns_pool_cleaned = report.netns_pool_cleaned,
            "snapshot cancellation cleanup complete"
        );

        #[cfg(test)]
        if let Some(tx) = self.cleanup_complete_tx.take() {
            let _ = tx.send(report);
        }
    }

    async fn release_network(&mut self) -> bool {
        if self.network.is_none() {
            return true;
        }
        let Some(netns_pool) = self.netns_pool.as_mut() else {
            tracing::warn!(
                "snapshot cancellation cleanup missing netns pool while releasing netns"
            );
            return false;
        };
        release_snapshot_netns(
            netns_pool,
            &mut self.network,
            "failed to release netns during snapshot cancellation cleanup",
        )
        .await;
        self.network.is_none()
    }

    async fn destroy_cow(&mut self) -> bool {
        let Some(cow_device) = self.cow_device.take() else {
            return true;
        };
        let cow_file = cow_device.cow_file().to_path_buf();
        match cow_device
            .destroy_with_retries(cow_destroy_retry_policy())
            .await
        {
            Ok(()) => {
                cleanup_snapshot_attempt_dir_for_cow(&cow_file).await;
                true
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "failed to destroy COW device during snapshot cancellation cleanup"
                );
                false
            }
        }
    }

    async fn cleanup_device_pool(&mut self) -> bool {
        let Some(device_pool) = self.device_pool.as_ref() else {
            return true;
        };
        device_pool.cleanup().await;
        self.device_pool.take();
        true
    }

    async fn cleanup_netns_pool(&mut self) -> bool {
        let Some(netns_pool) = self.netns_pool.as_mut() else {
            return true;
        };
        if let Err(e) = netns_pool.cleanup().await {
            tracing::warn!(error = %e, "failed to cleanup netns pool during snapshot cancellation cleanup");
            return false;
        }
        self.netns_pool.take();
        true
    }

    fn has_cleanup_work(&self) -> bool {
        self.device_pool.is_some()
            || self.netns_pool.is_some()
            || self.cow_device.is_some()
            || self.network.is_some()
            || self.child.is_some()
            || self.stdout_handle.is_some()
            || self.stderr_handle.is_some()
    }
}

impl Drop for SnapshotCleanupFinalizer {
    fn drop(&mut self) {
        if !self.has_cleanup_work() {
            return;
        }

        tracing::warn!(
            has_device_pool = self.device_pool.is_some(),
            has_netns_pool = self.netns_pool.is_some(),
            has_cow_device = self.cow_device.is_some(),
            has_network = self.network.is_some(),
            has_child = self.child.is_some(),
            has_stdout_forwarder = self.stdout_handle.is_some(),
            has_stderr_forwarder = self.stderr_handle.is_some(),
            "snapshot cancellation finalizer dropped before cleanup completed"
        );
    }
}

impl Drop for SnapshotAttempt {
    fn drop(&mut self) {
        let Some(finalizer) = self.take_cleanup_finalizer() else {
            return;
        };
        let has_device_pool = finalizer.device_pool.is_some();
        let has_netns_pool = finalizer.netns_pool.is_some();
        let has_cow_device = finalizer.cow_device.is_some();
        let has_network = finalizer.network.is_some();
        let has_child = finalizer.child.is_some();
        let has_stdout_forwarder = finalizer.stdout_handle.is_some();
        let has_stderr_forwarder = finalizer.stderr_handle.is_some();

        if let Some(child) = finalizer.child.as_ref() {
            // The outer snapshot build lock can be released as soon as the
            // cancelled future is dropped. Signal the process group before the
            // async handoff so a later build of the same snapshot does not race
            // a still-running Firecracker process. Reaping remains async.
            kill_process_group(child);
        }

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                tracing::info!(
                    has_device_pool,
                    has_netns_pool,
                    has_cow_device,
                    has_network,
                    has_child,
                    has_stdout_forwarder,
                    has_stderr_forwarder,
                    "snapshot attempt dropped; scheduling cancellation cleanup"
                );
                runtime.spawn(async move {
                    finalizer.run().await;
                });
            }
            Err(e) => tracing::warn!(
                error = %e,
                has_device_pool,
                has_netns_pool,
                has_cow_device,
                has_network,
                has_child,
                has_stdout_forwarder,
                has_stderr_forwarder,
                "snapshot attempt dropped outside Tokio runtime; async cancellation cleanup not scheduled"
            ),
        }
    }
}

/// Create a snapshot by booting a fresh VM, configuring it, and capturing state.
///
/// This is the Rust equivalent of the TS `commands/snapshot.ts` workflow:
///  1. Create work directory
///  2. Create NBD COW device backed by the rootfs image
///  3. Create network namespace
///  4. Spawn Firecracker with `--api-sock`
///  5. Wait for API socket ready
///  6. Configure VM via API (6 parallel PUT calls)
///  7. Bind vsock listener
///  8. Start instance
///  9. Wait for guest vsock connection
/// 10. Pre-warm guest caches (PAM/nsswitch, CLI modules)
/// 11. Pause VM
/// 12. Create snapshot
/// 13. Move COW file + bitmap to output dir
/// 14. Cleanup (kill Firecracker, destroy netns, release base image)
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    // Check prerequisites (binary, kernel, rootfs, kvm, runtime dir, etc.).
    prerequisites::check_prerequisites(&prerequisites::PrerequisiteConfig {
        binary_path: &config.binary_path,
        kernel_path: &config.kernel_path,
        rootfs_path: &config.rootfs_path,
        mode: prerequisites::PrerequisiteMode::SnapshotCreate,
    })
    .await
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    let output = SnapshotOutputPaths::new(config.output_dir.clone());

    // 1. Clean stale snapshot output from a previous failed attempt and create work dir.
    let work = prepare_snapshot_output(&output).await?;

    // Socket directory under /run, keyed by config id so concurrent builds don't collide.
    let runtime_paths = RuntimePaths::new();
    let sock_dir = runtime_paths.sock_dir(&config.id);
    cleanup_existing_snapshot_sock_dir(&sock_dir).await;

    let paths = SandboxPaths::new(work);
    let sock_paths = SockPaths::new(sock_dir.clone());

    info!(work_dir = %paths.workspace().display(), "starting snapshot creation");

    // Validate network prerequisites before allocating an NBD device. The
    // actual namespace pool is still created after the device so the workflow
    // order stays the same, but this keeps pure host-command failures from
    // falling onto the NBD best-effort Drop path.
    let netns_config = NetnsPoolConfig {
        proxy_port: None,
        dns_port: None,
    }
    .into_checked()
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    // 2. Create NBD COW device backed by the rootfs image.
    let base_size = tokio::fs::metadata(&config.rootfs_path)
        .await
        .map_err(|e| SnapshotError::Setup(format!("base image metadata: {e}")))?
        .len();

    // The stable `work/cow-device-bind` path is baked into the snapshot for
    // restore, but the temporary COW backing file is not. Keep the COW under an
    // attempt-scoped directory so a cancelled attempt's detached finalizer cannot
    // unlink a later rebuild's COW after the outer snapshot lock has been released.
    let attempt_token = snapshot_attempt_token();
    let attempt_dir = snapshot_attempt_dir(paths.workspace(), &attempt_token);
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create snapshot attempt dir: {e}")))?;
    let mut attempt_dir_guard = SnapshotAttemptDirGuard::new(attempt_dir);
    let cow_file = snapshot_attempt_cow_file(paths.workspace(), &attempt_token);
    create_sparse_cow_file(&cow_file, base_size)?;

    let device_pool =
        nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    device_pool.warmup().await;
    let cow_device = device_pool
        .create_cow_device(&config.rootfs_path, &cow_file, base_size)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create NBD COW device: {e}")))?;

    info!(device = %cow_device.device_path().display(), "NBD COW device created");

    // 3. Create network namespace (pool of 1, index auto-allocated via flock).
    let netns_pool = match NetnsPool::create_checked(netns_config).await {
        Ok(pool) => pool,
        Err(e) => {
            cleanup_after_netns_pool_failure(cow_device, &device_pool, &sock_dir).await;
            return Err(SnapshotError::Setup(format!("netns pool: {e}")));
        }
    };

    let mut attempt = SnapshotAttempt::new(
        paths,
        sock_paths,
        output,
        netns_pool,
        device_pool,
        cow_device,
    );
    attempt_dir_guard.disarm();
    let result = run_snapshot_workflow(&config, &mut attempt).await;

    attempt.cleanup_device_pool().await;
    attempt.cleanup_netns_pool().await;
    attempt.cleanup_sock_dir().await;

    result
}

/// Bash command run inside `unshare --mount` to bind the COW device into a
/// private mount namespace and exec Firecracker. Positional args are:
///   $1 = cow device path (e.g. /dev/nbdN)
///   $2 = bind target path (cow-device-bind regular file)
///   $3 = network namespace name
///   $4 = firecracker binary path
///   $5 = api socket path
///
/// The `&&` is load-bearing: if `mount --bind` fails, the chain short-circuits
/// and bash exits with a non-zero status. This is what lets us detect spawn
/// failures via `child.try_wait()` instead of an opaque API-ready timeout.
const SPAWN_INNER_CMD: &str =
    r#"mount --bind "$1" "$2" && exec ip netns exec "$3" "$4" --api-sock "$5""#;
const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

/// Number of recent stderr lines retained from the spawn chain, used to
/// surface the underlying cause when the chain (`unshare → bash → ip netns
/// exec → firecracker`) exits before the API socket appears. 32 is enough
/// for a typical mount/unshare/netns error plus a few lines of bash/kernel
/// noise, far less than the memory cost warrants worrying about.
const STDERR_BUF_LINES: usize = 32;

/// Time granted to the stderr forwarder task to drain buffered lines after
/// the spawn chain has been observed to exit. Kept small: if the forwarder
/// hasn't caught up in 100ms after the pipe's write end closed, the buffer
/// we have is what the operator sees.
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Cancellation finalizer child reap budget after SIGKILL. This is a fallback
/// path: keep it bounded so a cancelled snapshot cannot pin cleanup forever.
const SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Short grace period for stdout/stderr log forwarders after child cleanup.
const SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Shared bounded ring buffer of recent stderr lines from the spawn chain.
type StderrBuf = Arc<Mutex<VecDeque<String>>>;

/// Drain the captured stderr lines into a single newline-joined string.
/// Used in error reporting when the spawn chain exits prematurely; always
/// returns a non-empty string so the operator never sees a bare error.
fn drain_stderr_buf(buf: &StderrBuf) -> String {
    match buf.lock() {
        Ok(g) => {
            if g.is_empty() {
                "<no stderr captured>".to_string()
            } else {
                g.iter().cloned().collect::<Vec<_>>().join("\n")
            }
        }
        Err(_) => {
            // Poisoning means the stderr forwarder task panicked while
            // holding the lock — a real bug signal worth surfacing
            // independently of the error message that carries this sentinel.
            tracing::warn!("stderr buffer mutex poisoned during forwarder task");
            "<stderr buffer poisoned>".to_string()
        }
    }
}

/// If the snapshot workflow returned an API error AND the firecracker
/// spawn chain (unshare → bash → ip netns exec → firecracker) has
/// already exited with a non-zero status, re-wrap the error with the
/// captured stderr so the operator sees the underlying cause (e.g.
/// `mount: bind failed`) instead of a generic API timeout.
///
/// In every other case the original result is returned unchanged:
/// - `Ok(_)`: success — no rewrap.
/// - `Err(non-Api)`: the error is already specific (Setup / Vsock / Io /
///   Process) and shouldn't be replaced.
/// - `Ok(None)` child status: firecracker is still running, so the API
///   error is about API behavior, not a crashed spawn chain.
/// - `Ok(Some(success))` child status: firecracker exited cleanly (rare
///   at this point), not a mount/setup failure.
/// - `Err(_)` child status: `try_wait` failed for an unrelated reason
///   (EINTR, etc.); stay conservative and keep the original error.
fn rewrap_spawn_chain_exit(
    result: Result<SnapshotConfig, SnapshotError>,
    child_status: std::io::Result<Option<std::process::ExitStatus>>,
    stderr_buf: &StderrBuf,
) -> Result<SnapshotConfig, SnapshotError> {
    match (result, child_status) {
        (Err(SnapshotError::Api(api_err)), Ok(Some(status))) if !status.success() => {
            let stderr = drain_stderr_buf(stderr_buf);
            Err(SnapshotError::Process(format!(
                "firecracker spawn chain exited (status={status}): {stderr} \
                 (original API error: {api_err})"
            )))
        }
        (other, _) => other,
    }
}

/// Inner workflow, separated so the caller can always run cleanup.
async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    attempt: &mut SnapshotAttempt,
) -> Result<SnapshotConfig, SnapshotError> {
    attempt.prepare_firecracker_files().await?;
    attempt.acquire_network().await?;
    attempt.spawn_firecracker(config).await?;

    // Guard: ensure process and NBD cleanup on any explicit exit path.
    let result = run_with_firecracker(
        config,
        attempt.paths(),
        attempt.sock_paths()?,
        attempt.output(),
    )
    .await;
    attempt.finish_workflow(result).await
}

/// Inner workflow that runs while Firecracker is alive.
async fn run_with_firecracker(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    output: &SnapshotOutputPaths,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = sock_paths.api_sock();
    let client = ApiClient::new(&api_sock);
    client.wait_for_ready(API_READY_TIMEOUT).await?;

    info!("firecracker API ready");

    // The COW-device bind mount was established inside `unshare --mount`
    // at spawn time; `configure_drive` only needs the path string FC will
    // open inside its private mount namespace.
    let drive_bind_str = paths.cow_device_bind().display().to_string();

    // 6. Configure VM via API (6 parallel PUT calls).
    let inv = InvariantConfig::new();
    let kernel_path = config.kernel_path.display().to_string();
    tokio::fs::create_dir_all(&sock_paths.vsock_dir()).await?;
    let vsock_uds_str = sock_paths.vsock().display().to_string();

    tokio::try_join!(
        client.configure_machine(config.vcpu_count, config.memory_mb),
        client.configure_boot_source(&kernel_path, &inv.boot_args),
        client.configure_drive("rootfs", &drive_bind_str, true, false),
        client.configure_network_interface(inv.iface_id, inv.guest_mac, inv.tap_name),
        client.configure_vsock(inv.guest_cid, &vsock_uds_str),
        client.configure_balloon(
            inv.balloon.amount_mib,
            inv.balloon.deflate_on_oom,
            inv.balloon.stats_polling_interval_s
        ),
    )?;

    info!("VM configured");

    // 7. Bind vsock listener BEFORE starting the instance (race: guest connects ~300ms after boot).
    let vsock_path_for_listen = vsock_uds_str.clone();
    let vsock_task = tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&vsock_path_for_listen, VSOCK_CONNECT_TIMEOUT)
            .await
    });

    // 8. Start instance.
    let start_result = client.start_instance().await;
    if let Err(e) = start_result {
        vsock_task.abort();
        return Err(e.into());
    }

    info!("instance started, waiting for guest vsock connection");

    // 9. Wait for guest to connect via vsock.
    let guest = match vsock_task.await {
        Ok(Ok(g)) => g,
        Ok(Err(e)) => return Err(SnapshotError::Vsock(e.to_string())),
        Err(e) => return Err(SnapshotError::Vsock(format!("vsock task: {e}"))),
    };

    info!("guest connected");

    // 9.5. Pre-warm caches (PAM/nsswitch, CLI modules) so post-restore calls
    //      are fast. The snapshot captures memory + disk state, so caches
    //      populated here persist across restores.
    let prewarm_result = guest
        .exec(inv.prewarm_script, 30_000, &[], false)
        .await
        .map_err(|e| SnapshotError::Setup(format!("pre-warm exec: {e}")))?;
    if prewarm_result.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&prewarm_result.stderr);
        return Err(SnapshotError::Setup(format!(
            "pre-warm failed (exit code {}): {}",
            prewarm_result.exit_code,
            stderr.trim(),
        )));
    }
    info!("pre-warm complete");

    // 10. Pause VM.
    client.pause().await?;

    info!("VM paused");

    // 11. Create snapshot — Firecracker writes directly to output_dir.
    //
    // File content durability is guaranteed upstream: as of Firecracker
    // v1.14.1 (see `FIRECRACKER_VERSION` in `runner/src/deps.rs`), both
    // snapshot.bin and memory.bin are flushed and fsynced before the API
    // response returns. References (pinned to the v1.14.1 tag):
    //   - `snapshot_state_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.14.1/src/vmm/src/persist.rs
    //   - `snapshot_memory_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.14.1/src/vmm/src/vstate/vm.rs
    // Re-verify this guarantee whenever `FIRECRACKER_VERSION` is bumped;
    // if it ever regresses, add a host-side `sync_all` on both files here.
    // Directory-entry durability (persisting the `name → inode` mapping)
    // is handled separately; see #9825.
    let snapshot_str = output.snapshot().display().to_string();
    let memory_str = output.memory().display().to_string();
    client.create_snapshot(&snapshot_str, &memory_str).await?;

    info!("snapshot created");

    info!(output_dir = %config.output_dir.display(), "snapshot creation complete");

    Ok(output.snapshot_config(&config.id))
}

// ---------------------------------------------------------------------------
// SnapshotProvider trait implementation
// ---------------------------------------------------------------------------

/// Firecracker-backed snapshot provider.
///
/// Stateless — can be created with zero cost and used immediately.
pub struct FirecrackerSnapshotProvider;

#[async_trait]
impl SnapshotProvider for FirecrackerSnapshotProvider {
    async fn create_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<SnapshotOutput, sandbox::SnapshotError> {
        let sc = create_snapshot(config)
            .await
            .map_err(SnapshotError::into_sandbox_error)?;
        Ok(SnapshotOutput {
            snapshot_path: sc.snapshot_path,
            memory_path: sc.memory_path,
            cow_path: sc.cow_path,
        })
    }

    fn config_hash(&self) -> String {
        config_hash()
    }

    async fn is_complete(&self, output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
        let output = SnapshotOutputPaths::new(output_dir.to_path_buf());
        for path in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            let exists = tokio::fs::try_exists(&path).await?;
            if !exists {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prepare_snapshot_output_removes_snapshot_artifacts_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        let stale_work_file = output.work_dir().join("nested").join("stale.txt");
        let unrelated = dir.path().join("keep.txt");

        tokio::fs::create_dir_all(stale_work_file.parent().expect("parent"))
            .await
            .expect("create stale work dir");
        tokio::fs::write(&stale_work_file, b"stale")
            .await
            .expect("write stale work file");
        tokio::fs::write(&unrelated, b"keep")
            .await
            .expect("write unrelated file");
        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            tokio::fs::write(&artifact, b"stale")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }

        let work = prepare_snapshot_output(&output)
            .await
            .expect("prepare output");

        assert_eq!(work, output.work_dir());
        assert!(
            tokio::fs::try_exists(output.work_dir()).await.unwrap(),
            "work dir should be recreated"
        );
        assert!(
            !tokio::fs::try_exists(stale_work_file).await.unwrap(),
            "stale work contents should be removed"
        );
        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            assert!(
                !tokio::fs::try_exists(&artifact).await.unwrap(),
                "stale artifact should be removed: {}",
                artifact.display()
            );
        }
        assert!(
            tokio::fs::try_exists(unrelated).await.unwrap(),
            "non-snapshot output-dir contents should be preserved"
        );
    }

    #[tokio::test]
    async fn snapshot_provider_requires_cow_bitmap_for_complete_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(output.dir())
            .await
            .expect("create output dir");

        for artifact in [output.snapshot(), output.memory(), output.cow()] {
            tokio::fs::write(&artifact, b"snapshot artifact")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "snapshot without dirty bitmap sidecar must be incomplete"
        );

        tokio::fs::write(output.cow_bitmap(), b"bitmap")
            .await
            .expect("write cow bitmap");
        assert!(provider.is_complete(output.dir()).await.unwrap());
    }

    #[test]
    fn snapshot_attempt_cow_file_is_attempt_scoped() {
        let work = std::path::Path::new("/tmp/snapshot-work");

        assert_eq!(
            snapshot_attempt_cow_file(work, "abc123ef"),
            work.join("attempts").join("abc123ef").join("cow.img")
        );
        assert_ne!(
            snapshot_attempt_cow_file(work, "abc123ef"),
            work.join("cow.img")
        );
    }

    #[test]
    fn snapshot_attempt_dir_guard_removes_unowned_attempt_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
        std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");
        std::fs::write(attempt_dir.join("cow.img"), b"partial cow").expect("write cow");

        {
            let _guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
        }

        assert!(
            !attempt_dir.exists(),
            "unowned attempt dir should be removed on cancellation"
        );
    }

    #[test]
    fn snapshot_attempt_dir_guard_disarm_preserves_owned_attempt_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
        std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");

        {
            let mut guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
            guard.disarm();
        }

        assert!(
            attempt_dir.exists(),
            "disarmed attempt dir guard should leave the owned dir intact"
        );
    }

    #[tokio::test]
    async fn cleanup_snapshot_attempt_dir_removes_empty_token_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let work = dir.path().join("work");
        let cow = snapshot_attempt_cow_file(&work, "abc123ef");
        let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
        tokio::fs::create_dir_all(&attempt_dir)
            .await
            .expect("create attempt dir");
        tokio::fs::write(&cow, b"cow").await.expect("write cow");
        tokio::fs::remove_file(&cow).await.expect("remove cow");

        assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
        assert!(
            !tokio::fs::try_exists(&attempt_dir).await.unwrap(),
            "empty attempt token dir should be removed after cow cleanup"
        );
    }

    #[tokio::test]
    async fn cleanup_snapshot_attempt_dir_treats_missing_dir_as_clean() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cow = snapshot_attempt_cow_file(&dir.path().join("work"), "missing");

        assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
    }

    #[tokio::test]
    async fn cleanup_snapshot_attempt_dir_reports_nonempty_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let work = dir.path().join("work");
        let cow = snapshot_attempt_cow_file(&work, "abc123ef");
        let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
        tokio::fs::create_dir_all(&attempt_dir)
            .await
            .expect("create attempt dir");
        tokio::fs::write(attempt_dir.join("extra"), b"keep")
            .await
            .expect("write extra");

        assert!(!cleanup_snapshot_attempt_dir_for_cow(&cow).await);
        assert!(
            tokio::fs::try_exists(&attempt_dir).await.unwrap(),
            "nonempty attempt dir should not be force removed"
        );
    }

    #[tokio::test]
    async fn cleanup_existing_snapshot_sock_dir_removes_existing_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sock_dir = dir.path().join("sock");
        let stale_socket = sock_dir.join("api.sock");

        tokio::fs::create_dir_all(&sock_dir)
            .await
            .expect("create sock dir");
        tokio::fs::write(&stale_socket, b"stale")
            .await
            .expect("write stale socket placeholder");

        cleanup_existing_snapshot_sock_dir(&sock_dir).await;

        assert!(
            !tokio::fs::try_exists(&sock_dir).await.unwrap(),
            "stale socket directory should be removed"
        );

        cleanup_existing_snapshot_sock_dir(&sock_dir).await;
    }

    #[tokio::test]
    async fn snapshot_attempt_routes_socket_cleanup_through_owner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().join("output"));
        let paths = SandboxPaths::new(output.work_dir());
        let sock_dir = dir.path().join("sock");
        let sock_paths = SockPaths::new(sock_dir.clone());
        let stale_socket = sock_dir.join("api.sock");
        let mut attempt = SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output);

        tokio::fs::create_dir_all(&sock_dir)
            .await
            .expect("create sock dir");
        tokio::fs::write(&stale_socket, b"stale")
            .await
            .expect("write stale socket placeholder");

        attempt.cleanup_sock_dir().await;
        attempt.cleanup_netns_pool().await;

        assert!(
            !tokio::fs::try_exists(&sock_dir).await.unwrap(),
            "snapshot attempt should own runtime socket cleanup"
        );
    }

    fn snapshot_attempt_for_test(dir: &tempfile::TempDir) -> (SnapshotAttempt, std::path::PathBuf) {
        let output = SnapshotOutputPaths::new(dir.path().join("output"));
        let paths = SandboxPaths::new(output.work_dir());
        let sock_dir = dir.path().join("sock");
        let sock_paths = SockPaths::new(sock_dir.clone());
        (
            SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output),
            sock_dir,
        )
    }

    async fn wait_for_snapshot_cleanup(
        rx: tokio::sync::oneshot::Receiver<SnapshotCleanupReport>,
    ) -> SnapshotCleanupReport {
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .expect("snapshot cleanup finalizer should complete")
            .expect("snapshot cleanup finalizer should report completion")
    }

    fn long_running_child_for_test() -> tokio::process::Child {
        tokio::process::Command::new("sh")
            .arg("-c")
            .arg("while true; do sleep 60; done")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn long-running child")
    }

    #[tokio::test]
    async fn snapshot_attempt_drop_handoff_releases_netns_without_unlocked_sock_cleanup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
        let (tx, rx) = tokio::sync::oneshot::channel();

        attempt.track_network_for_test("test-snapshot-netns");
        attempt.notify_cleanup_complete_for_test(tx);
        tokio::fs::create_dir_all(&sock_dir)
            .await
            .expect("create sock dir");

        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.network_released);
        assert!(report.netns_pool_cleaned);
        assert!(
            tokio::fs::try_exists(&sock_dir).await.unwrap(),
            "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
        );
    }

    #[tokio::test]
    async fn snapshot_attempt_drop_handoff_kills_child_before_netns_release() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let child = long_running_child_for_test();

        attempt.track_network_for_test("test-snapshot-netns-child");
        attempt.track_child_for_test(child);
        attempt.notify_cleanup_complete_for_test(tx);
        tokio::fs::create_dir_all(&sock_dir)
            .await
            .expect("create sock dir");

        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.child_reaped);
        assert!(report.network_released);
        assert!(
            tokio::fs::try_exists(&sock_dir).await.unwrap(),
            "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
        );
    }

    #[tokio::test]
    async fn snapshot_attempt_drop_handoff_aborts_unfinished_forwarders() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
        let (tx, rx) = tokio::sync::oneshot::channel();

        attempt.track_stdout_handle_for_test(tokio::spawn(std::future::pending::<()>()));
        attempt.track_stderr_handle_for_test(tokio::spawn(std::future::pending::<()>()));
        attempt.notify_cleanup_complete_for_test(tx);
        tokio::fs::create_dir_all(&sock_dir)
            .await
            .expect("create sock dir");

        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.stdout_forwarder_finished);
        assert!(report.stderr_forwarder_finished);
        assert!(
            tokio::fs::try_exists(&sock_dir).await.unwrap(),
            "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
        );
    }

    #[tokio::test]
    async fn drain_stderr_forwarder_after_spawn_exit_waits_for_failed_status() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let drained = Arc::new(AtomicBool::new(false));
        let drained_for_task = Arc::clone(&drained);
        let handle = tokio::spawn(async move {
            drained_for_task.store(true, Ordering::SeqCst);
        });

        let returned =
            drain_stderr_forwarder_after_spawn_exit(&Ok(Some(exit_status_nonzero())), Some(handle))
                .await;

        assert!(returned.is_none());
        assert!(drained.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn drain_stderr_forwarder_after_spawn_exit_preserves_other_handles() {
        async fn assert_handle_preserved(
            child_status: std::io::Result<Option<std::process::ExitStatus>>,
        ) {
            let handle = tokio::spawn(std::future::pending::<()>());

            let returned = drain_stderr_forwarder_after_spawn_exit(&child_status, Some(handle))
                .await
                .expect("handle should be preserved");

            assert!(
                !returned.is_finished(),
                "helper should not join or abort the forwarder"
            );
            returned.abort();
            let _ = returned.await;
        }

        assert_handle_preserved(Ok(None)).await;
        assert_handle_preserved(Ok(Some(exit_status_zero()))).await;
        assert_handle_preserved(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))).await;
    }

    /// Empty stderr buffer should produce a sentinel string rather than
    /// an empty error body. Verifies the early-exit error path is
    /// always informative even with no captured output.
    #[test]
    fn drain_stderr_buf_reports_empty_with_sentinel() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        let s = drain_stderr_buf(&buf);
        assert!(s.contains("no stderr"), "got: {s}");
    }

    /// Captured lines are joined with newlines in insertion order.
    #[test]
    fn drain_stderr_buf_joins_lines() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            g.push_back("mount: bind failed".into());
            g.push_back("exit code 32".into());
        }
        assert_eq!(drain_stderr_buf(&buf), "mount: bind failed\nexit code 32");
    }

    /// Boundary: exactly `STDERR_BUF_LINES` entries — no eviction should
    /// have happened, and all lines (including `line 0`) must be present.
    /// Guards against off-by-one in the `if len == N { pop_front }` check.
    #[test]
    fn drain_stderr_buf_handles_exact_capacity() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            for i in 0..STDERR_BUF_LINES {
                if g.len() == STDERR_BUF_LINES {
                    g.pop_front();
                }
                g.push_back(format!("line {i}"));
            }
        }
        let joined = drain_stderr_buf(&buf);
        assert!(
            joined.contains("line 0"),
            "line 0 should survive at exact capacity: {joined}"
        );
        assert!(
            joined.contains(&format!("line {}", STDERR_BUF_LINES - 1)),
            "last line should be present: {joined}"
        );
    }

    /// Ring buffer drops oldest entries past the bound, keeping only the
    /// most recent N lines — the relevant ones for diagnosing a recent crash.
    #[test]
    fn drain_stderr_buf_keeps_only_recent_lines_when_overflowing() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            // Simulate the same eviction policy used by the stderr forwarder.
            for i in 0..(STDERR_BUF_LINES + 5) {
                if g.len() == STDERR_BUF_LINES {
                    g.pop_front();
                }
                g.push_back(format!("line {i}"));
            }
        }
        let joined = drain_stderr_buf(&buf);
        assert!(
            !joined.contains("line 0"),
            "oldest line should be evicted: {joined}"
        );
        assert!(
            joined.contains(&format!("line {}", STDERR_BUF_LINES + 4)),
            "newest line should be retained: {joined}"
        );
    }

    /// Build a placeholder `SnapshotConfig` for `Ok(_)` rewrap cases.
    /// Values are irrelevant — the rewrap helper never inspects them.
    fn placeholder_snapshot_config() -> SnapshotConfig {
        SnapshotConfig {
            snapshot_path: "/tmp/snapshot.bin".into(),
            memory_path: "/tmp/memory.bin".into(),
            cow_path: "/tmp/cow.img".into(),
            drive_bind_path: "/tmp/cow-device-bind".into(),
            vsock_bind_dir: "/tmp/vsock".into(),
        }
    }

    /// Build a `std::process::ExitStatus` with a given raw value. On Unix
    /// this encodes: `raw = (exit_code << 8) | signal`. Using
    /// `ExitStatus::from_raw(0x100)` yields exit code 1 / success=false.
    fn exit_status_nonzero() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0x100)
    }

    fn exit_status_zero() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }

    fn stderr_buf_with_lines(lines: &[&str]) -> StderrBuf {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            for line in lines {
                g.push_back((*line).to_string());
            }
        }
        buf
    }

    /// The target case: API error + child already exited non-zero → rewrap
    /// into a Process error that names the captured stderr.
    #[test]
    fn rewrap_replaces_api_error_when_child_exited_nonzero() {
        let api_err = ApiError::Other("timeout".into());
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(api_err)),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&["mount: bind failed", "exit 32"]),
        )
        .unwrap_err();
        match err {
            SnapshotError::Process(msg) => {
                assert!(msg.contains("mount: bind failed"), "got: {msg}");
                assert!(msg.contains("exit 32"), "got: {msg}");
                assert!(msg.contains("original API error"), "got: {msg}");
                // Exit status must appear in the message — operators need it
                // to distinguish `exit 1` (mount denied) from `signal 9`
                // (OOM kill) from `exit 32` (mount target missing).
                assert!(msg.contains("status="), "should include exit status: {msg}");
            }
            other => panic!("expected Process error, got {other:?}"),
        }
    }

    /// Even when the stderr buffer is empty, the rewrapped message should
    /// still be informative — falling back to the `<no stderr captured>`
    /// sentinel rather than a bare `status=...:  (original ...)` string.
    #[test]
    fn rewrap_uses_sentinel_when_stderr_empty() {
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&[]),
        )
        .unwrap_err();
        match err {
            SnapshotError::Process(msg) => {
                assert!(
                    msg.contains("no stderr"),
                    "should fall back to sentinel when buffer is empty: {msg}"
                );
                assert!(msg.contains("status="), "got: {msg}");
            }
            other => panic!("expected Process error, got {other:?}"),
        }
    }

    /// `try_wait` itself returning `Err` (EINTR or similar) must not be
    /// mistaken for "spawn chain exited" — stay conservative and keep the
    /// original error instead of asserting something we couldn't observe.
    #[test]
    fn rewrap_preserves_api_error_when_try_wait_fails() {
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
            Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
            &stderr_buf_with_lines(&["would-be-rewrapped"]),
        )
        .unwrap_err();
        assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
    }

    /// FC is still running (try_wait → None) → API error is genuine, keep it.
    #[test]
    fn rewrap_preserves_api_error_when_child_still_running() {
        let api_err = ApiError::Other("misconfigured".into());
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(api_err)),
            Ok(None),
            &stderr_buf_with_lines(&[]),
        )
        .unwrap_err();
        assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
    }

    /// FC exited with code 0 (rare but possible) → not a mount-style crash.
    #[test]
    fn rewrap_preserves_api_error_when_child_exited_zero() {
        let api_err = ApiError::Other("timeout".into());
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(api_err)),
            Ok(Some(exit_status_zero())),
            &stderr_buf_with_lines(&["noise"]),
        )
        .unwrap_err();
        assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
    }

    /// Non-API errors already carry their specific cause and should not
    /// be replaced by a generic "spawn chain exited" message.
    #[test]
    fn rewrap_preserves_non_api_errors() {
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Setup("pre-warm failed".into())),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&["stderr junk"]),
        )
        .unwrap_err();
        match err {
            SnapshotError::Setup(msg) => assert_eq!(msg, "pre-warm failed"),
            other => panic!("expected Setup error, got {other:?}"),
        }
    }

    /// `Ok(_)` passes through untouched.
    #[test]
    fn rewrap_passes_ok_through() {
        let result = rewrap_spawn_chain_exit(
            Ok(placeholder_snapshot_config()),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&["noise"]),
        );
        assert!(result.is_ok(), "ok should pass through");
    }

    /// Structural assertion that the unshare inner_cmd uses positional
    /// parameters (no path interpolation that could shell-inject) and
    /// performs the bind-then-exec sequence.
    ///
    /// The bind mount must run inside `unshare --mount` so it auto-cleans
    /// when the FC process dies — see issue #9494. This test guards against
    /// refactor regressions before the kernel-interaction CI job runs.
    #[test]
    fn spawn_inner_cmd_uses_positional_args() {
        // Only positional args, no $0 or unquoted vars.
        assert!(!SPAWN_INNER_CMD.contains("$0"));
        for arg in ["$1", "$2", "$3", "$4", "$5"] {
            let quoted = format!(r#""{arg}""#);
            assert!(
                SPAWN_INNER_CMD.contains(&quoted),
                "expected quoted positional {arg} in inner_cmd: {SPAWN_INNER_CMD}"
            );
        }
        // Strictly 5 positional args — if someone adds a `$6`..`$9` without
        // updating the spawn site's `.arg(...)` count, the bash call
        // silently expands to empty strings and fails at runtime.
        for unexpected in ["$6", "$7", "$8", "$9"] {
            assert!(
                !SPAWN_INNER_CMD.contains(unexpected),
                "unexpected positional {unexpected} in inner_cmd: {SPAWN_INNER_CMD}"
            );
        }

        // Flow: bind the device, then exec into ip netns exec firecracker.
        // `exec` is critical so signals reach FC directly without an extra
        // bash layer holding a process slot.
        assert!(
            SPAWN_INNER_CMD.starts_with("mount --bind"),
            "inner_cmd must establish bind mount first: {SPAWN_INNER_CMD}"
        );
        assert!(
            SPAWN_INNER_CMD.contains("&& exec ip netns exec"),
            "inner_cmd must exec ip netns exec firecracker: {SPAWN_INNER_CMD}"
        );
    }

    #[test]
    fn snapshot_create_unshare_uses_private_mount_propagation() {
        assert_eq!(UNSHARE_MOUNT_ARGS, ["--mount", "--propagation", "private"]);
    }
}
