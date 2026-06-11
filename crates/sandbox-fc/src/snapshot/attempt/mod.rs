mod cleanup;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use nbd_cow::KeptCow;
use nbd_cow::PooledNbdCowDevice;
use nbd_cow::pool::DevicePoolHandle;
use sandbox::SnapshotCreateConfig;
#[cfg(test)]
use tokio::task::JoinHandle;
use tracing::info;

use crate::config::SnapshotConfig;
use crate::network::NetnsPool;
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::process::kill_process_group;

use super::SnapshotError;
use super::cow::destroy_snapshot_cow_and_cleanup_attempt_dir;
use super::output::remove_dir_all_if_exists_sync;
#[cfg(test)]
use super::publish::SnapshotPublishAttempt;
use super::runtime::{
    SPAWN_INNER_CMD, STDERR_BUF_LINES, StderrBuf, UNSHARE_MOUNT_ARGS,
    drain_stderr_forwarder_after_spawn_exit, kill_and_reap_firecracker, rewrap_spawn_chain_exit,
    spawn_stderr_forwarder, spawn_stdout_forwarder,
};

#[cfg(test)]
use self::cleanup::{AttemptWorkspaceImage, SnapshotCleanupReport};
use self::cleanup::{SnapshotCleanupFinalizer, SnapshotCleanupResources};

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
    cleanup_resources: SnapshotCleanupResources,
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
        workspace_image_path: PathBuf,
    ) -> Self {
        Self {
            paths,
            sock_paths: Some(sock_paths),
            output,
            cleanup_resources: SnapshotCleanupResources::new(
                netns_pool,
                device_pool,
                cow_device,
                workspace_image_path,
            ),
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
        workspace_image_path: PathBuf,
    ) -> Self {
        Self {
            paths,
            sock_paths: Some(sock_paths),
            output,
            cleanup_resources: SnapshotCleanupResources::without_cow_for_test(workspace_image_path),
            stderr_buf: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES))),
            #[cfg(test)]
            cleanup_complete_tx: None,
        }
    }

    #[cfg(test)]
    fn track_network_for_test(&mut self, name: &str) {
        if let Some(netns_pool) = self.cleanup_resources.netns_pool.as_mut() {
            let network = netns_pool.lease_for_test(name);
            netns_pool.track_lease_for_test(&network);
            self.cleanup_resources.network = Some(network);
        }
    }

    #[cfg(test)]
    fn track_child_for_test(&mut self, child: tokio::process::Child) {
        self.cleanup_resources.child = Some(child);
    }

    #[cfg(test)]
    fn track_stdout_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.cleanup_resources.stdout_handle = Some(handle);
    }

    #[cfg(test)]
    fn track_stderr_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.cleanup_resources.stderr_handle = Some(handle);
    }

    #[cfg(test)]
    fn track_device_pool_for_test(&mut self, device_pool: DevicePoolHandle) {
        self.cleanup_resources.device_pool = Some(device_pool);
    }

    #[cfg(test)]
    fn track_workspace_image_for_test(&mut self, workspace_image: PathBuf) {
        self.cleanup_resources.workspace_image = AttemptWorkspaceImage::Owned(workspace_image);
    }

    #[cfg(test)]
    fn track_publish_attempt_for_test(&mut self, publish_attempt: SnapshotPublishAttempt) {
        self.cleanup_resources.publish_attempt = Some(publish_attempt);
    }

    #[cfg(test)]
    fn notify_cleanup_complete_for_test(
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

    pub(super) async fn prepare_firecracker_files(
        &mut self,
        config: &SnapshotCreateConfig,
    ) -> Result<(), SnapshotError> {
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
            self.cleanup_resources
                .destroy_cow_after_setup_error("mkdir sock dir")
                .await;
            return Err(SnapshotError::Setup(format!("mkdir sock dir: {e}")));
        }

        let drive_bind = self.paths.cow_device_bind();
        if let Err(e) = tokio::fs::write(&drive_bind, b"").await {
            self.cleanup_resources
                .destroy_cow_after_setup_error("create bind target")
                .await;
            return Err(SnapshotError::Setup(format!("create bind target: {e}")));
        }

        let workspace_drive_bind = self.paths.workspace_device_bind();
        if let Err(e) = tokio::fs::write(&workspace_drive_bind, b"").await {
            self.cleanup_resources
                .destroy_cow_after_setup_error("create workspace bind target")
                .await;
            return Err(SnapshotError::Setup(format!(
                "create workspace bind target: {e}"
            )));
        }

        let workspace_image_path =
            match self.cleanup_resources.workspace_image.mark_create_started() {
                Ok(path) => path,
                Err(err) => {
                    self.cleanup_resources
                        .destroy_cow_after_setup_error("prepare workspace image state")
                        .await;
                    return Err(err);
                }
            };
        if let Err(e) = crate::factory::prepare_workspace_drive_image(
            &workspace_image_path,
            &sandbox::WorkspaceDriveConfig {
                size_mb: config.workspace_disk_mb,
                seed_image: None,
            },
        )
        .await
        {
            self.cleanup_resources.cleanup_workspace_image(
                "failed to cleanup snapshot workspace image after prepare failure",
            );
            self.cleanup_resources
                .destroy_cow_after_setup_error("prepare workspace image")
                .await;
            return Err(SnapshotError::Setup(format!(
                "prepare workspace image: {e}"
            )));
        }

        Ok(())
    }

    pub(super) async fn acquire_network(&mut self) -> Result<(), SnapshotError> {
        let acquire_result = match self.cleanup_resources.netns_pool.as_mut() {
            Some(netns_pool) => netns_pool.acquire().await,
            None => {
                self.cleanup_resources
                    .destroy_cow_after_setup_error("missing netns pool before acquire")
                    .await;
                return Err(SnapshotError::Setup(
                    "snapshot attempt missing netns pool before acquire".into(),
                ));
            }
        };
        let network = match acquire_result {
            Ok(network) => network,
            Err(e) => {
                self.cleanup_resources
                    .destroy_cow_after_setup_error("acquire netns")
                    .await;
                return Err(SnapshotError::Setup(format!("acquire netns: {e}")));
            }
        };

        info!(netns = %network.info().name(), "namespace acquired");
        self.cleanup_resources.network = Some(network);
        Ok(())
    }

    pub(super) async fn spawn_firecracker(
        &mut self,
        config: &SnapshotCreateConfig,
    ) -> Result<(), SnapshotError> {
        let api_sock = self.sock_paths()?.api_sock();
        let drive_bind = self.paths.cow_device_bind();
        let workspace_image = match self.cleanup_resources.workspace_image.path_for_spawn() {
            Ok(path) => path.to_path_buf(),
            Err(err) => {
                self.cleanup_resources
                    .release_network(
                        "failed to release netns after workspace image state error",
                        "snapshot attempt missing netns pool after workspace image state error",
                    )
                    .await;
                self.cleanup_resources
                    .destroy_cow_after_setup_error("workspace image state before spawn")
                    .await;
                return Err(err);
            }
        };
        let workspace_drive_bind = self.paths.workspace_device_bind();
        let cow_device_path = self
            .cleanup_resources
            .cow_device
            .as_ref()
            .ok_or_else(|| {
                SnapshotError::Setup("snapshot attempt missing COW device before spawn".into())
            })?
            .device_path()
            .to_path_buf();
        let network_name = self
            .cleanup_resources
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
            .arg(&workspace_image) // $3
            .arg(&workspace_drive_bind) // $4
            .arg(&network_name) // $5
            .arg(&config.binary_path) // $6
            .arg(&api_sock) // $7
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
                self.cleanup_resources
                    .destroy_cow_after_setup_error("spawn firecracker")
                    .await;
                return Err(SnapshotError::Process(format!("spawn firecracker: {e}")));
            }
        };

        // Stream stdout/stderr lines to tracing (same pattern as sandbox.rs).
        // Stderr is also retained in a bounded ring buffer so that an early
        // spawn-chain exit (mount failure inside unshare bash, etc.) can be
        // reported with its real cause instead of just an API timeout.
        self.cleanup_resources.stdout_handle = spawn_stdout_forwarder(&mut child);
        // The stderr forwarder handle is retained so that, on detected early
        // exit, we can wait a bounded time for it to drain buffered lines
        // before snapshotting the ring buffer for the error message. Without
        // this join, the most informative lines (mount: bind failed, etc.)
        // can race the `try_wait` observation and be missed.
        self.cleanup_resources.stderr_handle = spawn_stderr_forwarder(&mut child, &self.stderr_buf);
        self.cleanup_resources.child = Some(child);

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
            .cleanup_resources
            .child
            .as_mut()
            .map_or(Ok(None), tokio::process::Child::try_wait);
        self.cleanup_resources.stderr_handle = drain_stderr_forwarder_after_spawn_exit(
            &child_status,
            self.cleanup_resources.stderr_handle.take(),
        )
        .await;
        let result = rewrap_spawn_chain_exit(result, child_status, &self.stderr_buf);

        // Kill Firecracker first — it holds the NBD device fd open.
        if let Some(child) = self.cleanup_resources.child.as_mut() {
            kill_and_reap_firecracker(child).await;
        }
        self.cleanup_resources.child.take();

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
        self.cleanup_resources.cleanup_device_pool().await;
    }

    pub(super) async fn cleanup_netns_pool(&mut self) {
        self.cleanup_resources
            .cleanup_netns_pool_after_explicit_teardown()
            .await;
    }

    pub(super) async fn cleanup_sock_dir(&mut self) {
        if let Some(sock_paths) = self.sock_paths.as_ref() {
            cleanup_snapshot_sock_dir(sock_paths.dir(), "failed to cleanup sock dir").await;
        }
        self.sock_paths.take();
    }

    async fn release_network(&mut self, warning: &'static str) {
        self.cleanup_resources
            .release_network(
                warning,
                "snapshot attempt missing netns pool while releasing netns",
            )
            .await;
    }

    pub(super) async fn prepare_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
        self.cleanup_resources.prepare_success_publish().await
    }

    async fn cleanup_failure(&mut self) {
        self.cleanup_resources.cleanup_failure().await;
    }

    async fn cleanup_publish_attempt(&mut self) -> bool {
        self.cleanup_resources.cleanup_publish_attempt().await
    }

    fn drop_forwarder_handles(&mut self) {
        self.cleanup_resources.drop_forwarder_handles();
    }

    fn has_cleanup_work(&self) -> bool {
        self.cleanup_resources.has_cleanup_work()
    }

    fn take_cleanup_finalizer(&mut self) -> Option<SnapshotCleanupFinalizer> {
        if !self.has_cleanup_work() {
            return None;
        }

        Some(SnapshotCleanupFinalizer {
            resources: std::mem::take(&mut self.cleanup_resources),
            #[cfg(test)]
            cleanup_complete_tx: self.cleanup_complete_tx.take(),
            #[cfg(test)]
            cleanup_events: Vec::new(),
        })
    }
}

impl Drop for SnapshotAttempt {
    fn drop(&mut self) {
        let Some(finalizer) = self.take_cleanup_finalizer() else {
            return;
        };
        let presence = finalizer.resources.presence();

        if let Some(child) = finalizer.resources.child.as_ref() {
            // The outer snapshot build lock can be released as soon as the
            // cancelled future is dropped. Signal the process group before the
            // async handoff so a later build of the same snapshot does not race
            // a still-running Firecracker process. Reaping remains async.
            kill_process_group(child);
        }

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                tracing::info!(
                    has_device_pool = presence.has_device_pool,
                    has_netns_pool = presence.has_netns_pool,
                    has_cow_device = presence.has_cow_device,
                    has_workspace_image = presence.has_workspace_image,
                    has_publish_attempt = presence.has_publish_attempt,
                    has_network = presence.has_network,
                    has_child = presence.has_child,
                    has_stdout_forwarder = presence.has_stdout_forwarder,
                    has_stderr_forwarder = presence.has_stderr_forwarder,
                    "snapshot attempt dropped; scheduling cancellation cleanup"
                );
                runtime.spawn(async move {
                    finalizer.run().await;
                });
            }
            Err(e) => tracing::warn!(
                error = %e,
                has_device_pool = presence.has_device_pool,
                has_netns_pool = presence.has_netns_pool,
                has_cow_device = presence.has_cow_device,
                has_workspace_image = presence.has_workspace_image,
                has_publish_attempt = presence.has_publish_attempt,
                has_network = presence.has_network,
                has_child = presence.has_child,
                has_stdout_forwarder = presence.has_stdout_forwarder,
                has_stderr_forwarder = presence.has_stderr_forwarder,
                "snapshot attempt dropped outside Tokio runtime; async cancellation cleanup not scheduled"
            ),
        }
    }
}
