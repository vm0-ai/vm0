use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

use nbd_cow::KeptCow;
use nbd_cow::PooledNbdCowDevice;
use nbd_cow::pool::DevicePoolHandle;
use sandbox::SnapshotCreateConfig;
use tokio::task::JoinHandle;
use tracing::info;

use crate::config::SnapshotConfig;
use crate::network::{NetnsLease, NetnsPool};
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::process::kill_process_group;

use super::SnapshotError;
use super::cow::{destroy_snapshot_cow_after_error, destroy_snapshot_cow_and_cleanup_attempt_dir};
use super::output::remove_dir_all_if_exists_sync;
use super::publish::SnapshotPublishAttempt;
use super::runtime::{
    SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT, SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT, SPAWN_INNER_CMD,
    STDERR_BUF_LINES, StderrBuf, UNSHARE_MOUNT_ARGS, drain_or_abort_forwarder,
    drain_stderr_forwarder_after_spawn_exit, kill_and_reap_firecracker,
    kill_and_reap_firecracker_bounded, rewrap_spawn_chain_exit, spawn_stderr_forwarder,
    spawn_stdout_forwarder,
};

pub(super) async fn cleanup_existing_snapshot_sock_dir(sock_dir: &Path) {
    if sock_dir.exists()
        && let Err(e) = remove_dir_all_if_exists_sync(sock_dir)
    {
        tracing::warn!(error = %e, "failed to clean stale sock dir");
    }
}

async fn cleanup_snapshot_sock_dir(sock_dir: &Path, warning: &'static str) -> bool {
    match remove_dir_all_if_exists_sync(sock_dir) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(error = %e, "{warning}");
            false
        }
    }
}

pub(super) async fn cleanup_after_netns_pool_failure(
    cow_device: PooledNbdCowDevice,
    device_pool: &DevicePoolHandle,
    sock_dir: &Path,
) {
    if let Err(cleanup_err) = destroy_snapshot_cow_and_cleanup_attempt_dir(cow_device).await {
        tracing::warn!(
            error = %cleanup_err,
            "failed to destroy COW device after netns pool failure"
        );
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

async fn destroy_snapshot_cow_after_workflow_error(cow_device: PooledNbdCowDevice) {
    if let Err(e) = destroy_snapshot_cow_and_cleanup_attempt_dir(cow_device).await {
        tracing::warn!(error = %e, "failed to destroy COW device after snapshot error");
    }
}

/// Snapshot-local owner for resources acquired while producing one snapshot.
///
/// This owner centralizes the explicit success/failure cleanup path for
/// snapshot creation. It intentionally does not participate in the factory
/// leak-cleaner path used by sandbox creation: a snapshot attempt owns a
/// one-shot netns pool, a per-snapshot NBD device pool, a single COW device,
/// and one Firecracker child only until the workflow runtime cleanup and the
/// outer pool / socket cleanup steps run.
///
/// Drop never performs async cleanup inline. If cancellation drops the attempt
/// while it still owns runtime resources, Drop moves them into a detached
/// snapshot cleanup finalizer when a Tokio runtime is available.
pub(super) struct SnapshotAttempt {
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
    publish_attempt: Option<SnapshotPublishAttempt>,
    network: Option<NetnsLease>,
    child: Option<tokio::process::Child>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    stderr_buf: StderrBuf,
    #[cfg(test)]
    cleanup_complete_tx: Option<tokio::sync::oneshot::Sender<SnapshotCleanupReport>>,
}

impl SnapshotAttempt {
    pub(super) fn new(
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
            publish_attempt: None,
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
    pub(super) fn new_without_cow_for_test(
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
            publish_attempt: None,
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
    pub(super) fn track_network_for_test(&mut self, name: &str) {
        if let Some(netns_pool) = self.netns_pool.as_mut() {
            let network = netns_pool.lease_for_test(name);
            netns_pool.track_lease_for_test(&network);
            self.network = Some(network);
        }
    }

    #[cfg(test)]
    pub(super) fn track_child_for_test(&mut self, child: tokio::process::Child) {
        self.child = Some(child);
    }

    #[cfg(test)]
    pub(super) fn track_stdout_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.stdout_handle = Some(handle);
    }

    #[cfg(test)]
    pub(super) fn track_stderr_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.stderr_handle = Some(handle);
    }

    #[cfg(test)]
    pub(super) fn track_device_pool_for_test(&mut self, device_pool: DevicePoolHandle) {
        self.device_pool = Some(device_pool);
    }

    #[cfg(test)]
    pub(super) fn track_publish_attempt_for_test(
        &mut self,
        publish_attempt: SnapshotPublishAttempt,
    ) {
        self.publish_attempt = Some(publish_attempt);
    }

    #[cfg(test)]
    pub(super) fn notify_cleanup_complete_for_test(
        &mut self,
        tx: tokio::sync::oneshot::Sender<SnapshotCleanupReport>,
    ) {
        self.cleanup_complete_tx = Some(tx);
    }

    pub(super) fn paths(&self) -> &SandboxPaths {
        &self.paths
    }

    pub(super) fn sock_paths(&self) -> Result<&SockPaths, SnapshotError> {
        self.sock_paths
            .as_ref()
            .ok_or_else(|| SnapshotError::Setup("snapshot attempt missing socket paths".into()))
    }

    pub(super) fn output(&self) -> &SnapshotOutputPaths {
        &self.output
    }

    pub(super) async fn prepare_firecracker_files(&mut self) -> Result<(), SnapshotError> {
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

    pub(super) async fn acquire_network(&mut self) -> Result<(), SnapshotError> {
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

    pub(super) async fn spawn_firecracker(
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

    pub(super) async fn finish_runtime_after_workflow(
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

        if result.is_err() {
            self.cleanup_failure().await;
        }

        self.drop_forwarder_handles();
        result
    }

    pub(super) async fn cleanup_device_pool(&mut self) {
        self.cleanup_publish_attempt().await;
        if let Some(device_pool) = self.device_pool.as_ref() {
            device_pool.cleanup().await;
        }
        self.device_pool.take();
    }

    pub(super) async fn cleanup_netns_pool(&mut self) {
        if let Some(netns_pool) = self.netns_pool.as_mut()
            && let Err(e) = netns_pool.cleanup().await
        {
            tracing::warn!(error = %e, "failed to cleanup netns pool");
        }
        self.netns_pool.take();
    }

    pub(super) async fn cleanup_sock_dir(&mut self) {
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

    pub(super) async fn prepare_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
        let cow_device = self.cow_device.take().ok_or_else(|| {
            SnapshotError::Teardown("snapshot attempt missing COW device before publish".into())
        })?;
        self.publish_attempt = Some(SnapshotPublishAttempt::new(cow_device));
        self.resolve_success_publish().await
    }

    pub(super) async fn resolve_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
        let publish_attempt = self.publish_attempt.as_mut().ok_or_else(|| {
            SnapshotError::Teardown("snapshot publish attempt missing before publish".into())
        })?;
        let kept_cow = publish_attempt.resolve_into_kept_cow().await?;
        self.publish_attempt.take();
        Ok(kept_cow)
    }

    async fn cleanup_failure(&mut self) {
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_workflow_error(cow_device).await;
        }
        self.cleanup_publish_attempt().await;
    }

    async fn cleanup_publish_attempt(&mut self) -> bool {
        let Some(publish_attempt) = self.publish_attempt.as_mut() else {
            return true;
        };
        let cleaned = publish_attempt.cleanup_after_cancellation().await;
        if cleaned || !publish_attempt.has_cleanup_work() {
            self.publish_attempt.take();
        }
        cleaned
    }

    fn drop_forwarder_handles(&mut self) {
        self.stdout_handle.take();
        self.stderr_handle.take();
    }

    fn has_cleanup_work(&self) -> bool {
        self.device_pool.is_some()
            || self.netns_pool.is_some()
            || self.cow_device.is_some()
            || self
                .publish_attempt
                .as_ref()
                .is_some_and(SnapshotPublishAttempt::has_cleanup_work)
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
            publish_attempt: self.publish_attempt.take(),
            network: self.network.take(),
            child: self.child.take(),
            stdout_handle: self.stdout_handle.take(),
            stderr_handle: self.stderr_handle.take(),
            #[cfg(test)]
            cleanup_complete_tx: self.cleanup_complete_tx.take(),
            #[cfg(test)]
            cleanup_events: Vec::new(),
        })
    }
}

pub(super) struct SnapshotCleanupReport {
    pub(super) child_reaped: bool,
    pub(super) stdout_forwarder_finished: bool,
    pub(super) stderr_forwarder_finished: bool,
    pub(super) network_released: bool,
    pub(super) publish_cleaned: bool,
    pub(super) cow_destroyed: bool,
    pub(super) device_pool_cleaned: bool,
    pub(super) netns_pool_cleaned: bool,
    #[cfg(test)]
    pub(super) cleanup_events: Vec<&'static str>,
}

struct SnapshotCleanupFinalizer {
    netns_pool: Option<NetnsPool>,
    device_pool: Option<DevicePoolHandle>,
    cow_device: Option<PooledNbdCowDevice>,
    publish_attempt: Option<SnapshotPublishAttempt>,
    network: Option<NetnsLease>,
    child: Option<tokio::process::Child>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    #[cfg(test)]
    cleanup_complete_tx: Option<tokio::sync::oneshot::Sender<SnapshotCleanupReport>>,
    #[cfg(test)]
    pub(super) cleanup_events: Vec<&'static str>,
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
        let publish_cleaned = self.cleanup_publish_attempt().await;
        let cow_destroyed = self.destroy_cow().await;
        let device_pool_cleaned = self.cleanup_device_pool().await;
        let netns_pool_cleaned = self.cleanup_netns_pool().await;

        let report = SnapshotCleanupReport {
            child_reaped,
            stdout_forwarder_finished,
            stderr_forwarder_finished,
            network_released,
            publish_cleaned,
            cow_destroyed,
            device_pool_cleaned,
            netns_pool_cleaned,
            #[cfg(test)]
            cleanup_events: self.cleanup_events.clone(),
        };

        tracing::info!(
            child_reaped = report.child_reaped,
            stdout_forwarder_finished = report.stdout_forwarder_finished,
            stderr_forwarder_finished = report.stderr_forwarder_finished,
            network_released = report.network_released,
            publish_cleaned = report.publish_cleaned,
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

    async fn cleanup_publish_attempt(&mut self) -> bool {
        let Some(publish_attempt) = self.publish_attempt.as_mut() else {
            return true;
        };
        #[cfg(test)]
        self.cleanup_events.push("publish");
        let cleaned = publish_attempt.cleanup_after_cancellation().await;
        if cleaned || !publish_attempt.has_cleanup_work() {
            self.publish_attempt.take();
        }
        cleaned
    }

    async fn destroy_cow(&mut self) -> bool {
        let Some(cow_device) = self.cow_device.take() else {
            return true;
        };
        match destroy_snapshot_cow_and_cleanup_attempt_dir(cow_device).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "failed to destroy COW device during snapshot cancellation cleanup"
                );
                false
            }
        }
    }

    pub(super) async fn cleanup_device_pool(&mut self) -> bool {
        let Some(device_pool) = self.device_pool.as_ref() else {
            return true;
        };
        #[cfg(test)]
        self.cleanup_events.push("device_pool");
        device_pool.cleanup().await;
        self.device_pool.take();
        true
    }

    pub(super) async fn cleanup_netns_pool(&mut self) -> bool {
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
            || self
                .publish_attempt
                .as_ref()
                .is_some_and(SnapshotPublishAttempt::has_cleanup_work)
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
            has_publish_attempt = self
                .publish_attempt
                .as_ref()
                .is_some_and(SnapshotPublishAttempt::has_cleanup_work),
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
        let has_publish_attempt = finalizer
            .publish_attempt
            .as_ref()
            .is_some_and(SnapshotPublishAttempt::has_cleanup_work);
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
                    has_publish_attempt,
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
                has_publish_attempt,
                has_network,
                has_child,
                has_stdout_forwarder,
                has_stderr_forwarder,
                "snapshot attempt dropped outside Tokio runtime; async cancellation cleanup not scheduled"
            ),
        }
    }
}
