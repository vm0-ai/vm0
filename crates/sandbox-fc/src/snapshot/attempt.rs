use std::collections::VecDeque;
use std::path::{Path, PathBuf};
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
use super::output::{cleanup_workspace_image_file_sync, remove_dir_all_if_exists_sync};
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

// The path is known at attempt construction; cleanup is required only after
// image creation starts.
#[derive(Default)]
enum AttemptWorkspaceImage {
    NotCreated(PathBuf),
    Owned(PathBuf),
    #[default]
    Cleaned,
}

impl AttemptWorkspaceImage {
    fn new(path: PathBuf) -> Self {
        Self::NotCreated(path)
    }

    fn mark_create_started(&mut self) -> Result<PathBuf, SnapshotError> {
        match std::mem::replace(self, Self::Cleaned) {
            Self::NotCreated(path) => {
                let prepare_path = path.clone();
                *self = Self::Owned(path);
                Ok(prepare_path)
            }
            Self::Owned(path) => {
                *self = Self::Owned(path);
                Err(SnapshotError::Setup(
                    "snapshot attempt workspace image creation already started".into(),
                ))
            }
            Self::Cleaned => Err(SnapshotError::Setup(
                "snapshot attempt workspace image already cleaned before prepare".into(),
            )),
        }
    }

    fn path_for_spawn(&self) -> Result<&Path, SnapshotError> {
        match self {
            Self::Owned(path) => Ok(path),
            Self::NotCreated(_) => Err(SnapshotError::Setup(
                "snapshot attempt workspace image not prepared before spawn".into(),
            )),
            Self::Cleaned => Err(SnapshotError::Setup(
                "snapshot attempt workspace image already cleaned before spawn".into(),
            )),
        }
    }

    fn has_cleanup_work(&self) -> bool {
        matches!(self, Self::Owned(_))
    }

    fn cleanup(&mut self, warning: &'static str) -> bool {
        let Self::Owned(path) = self else {
            return true;
        };
        let cleaned = cleanup_workspace_image_file_sync(path, warning);
        if cleaned {
            cleanup_empty_workspace_image_parent_dir(path);
            *self = Self::Cleaned;
        }
        cleaned
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SnapshotCleanupPresence {
    has_device_pool: bool,
    has_netns_pool: bool,
    has_cow_device: bool,
    has_workspace_image: bool,
    has_publish_attempt: bool,
    has_network: bool,
    has_child: bool,
    has_stdout_forwarder: bool,
    has_stderr_forwarder: bool,
}

impl SnapshotCleanupPresence {
    fn has_cleanup_work(self) -> bool {
        self.has_device_pool
            || self.has_netns_pool
            || self.has_cow_device
            || self.has_workspace_image
            || self.has_publish_attempt
            || self.has_network
            || self.has_child
            || self.has_stdout_forwarder
            || self.has_stderr_forwarder
    }
}

#[derive(Default)]
struct SnapshotCleanupResources {
    netns_pool: Option<NetnsPool>,
    device_pool: Option<DevicePoolHandle>,
    cow_device: Option<PooledNbdCowDevice>,
    workspace_image: AttemptWorkspaceImage,
    publish_attempt: Option<SnapshotPublishAttempt>,
    network: Option<NetnsLease>,
    child: Option<tokio::process::Child>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
}

impl SnapshotCleanupResources {
    fn new(
        netns_pool: NetnsPool,
        device_pool: DevicePoolHandle,
        cow_device: PooledNbdCowDevice,
        workspace_image_path: PathBuf,
    ) -> Self {
        Self {
            netns_pool: Some(netns_pool),
            device_pool: Some(device_pool),
            cow_device: Some(cow_device),
            workspace_image: AttemptWorkspaceImage::new(workspace_image_path),
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn without_cow_for_test(workspace_image_path: PathBuf) -> Self {
        Self {
            netns_pool: Some(NetnsPool::inactive_for_test()),
            workspace_image: AttemptWorkspaceImage::new(workspace_image_path),
            ..Self::default()
        }
    }

    fn presence(&self) -> SnapshotCleanupPresence {
        SnapshotCleanupPresence {
            has_device_pool: self.device_pool.is_some(),
            has_netns_pool: self.netns_pool.is_some(),
            has_cow_device: self.cow_device.is_some(),
            has_workspace_image: self.workspace_image.has_cleanup_work(),
            has_publish_attempt: self
                .publish_attempt
                .as_ref()
                .is_some_and(SnapshotPublishAttempt::has_cleanup_work),
            has_network: self.network.is_some(),
            has_child: self.child.is_some(),
            has_stdout_forwarder: self.stdout_handle.is_some(),
            has_stderr_forwarder: self.stderr_handle.is_some(),
        }
    }

    fn has_cleanup_work(&self) -> bool {
        self.presence().has_cleanup_work()
    }

    async fn destroy_cow_after_setup_error(&mut self, context: &'static str) {
        self.cleanup_workspace_image(
            "failed to cleanup snapshot workspace image after setup error",
        );
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_error(context, cow_device).await;
        }
    }

    async fn release_network(
        &mut self,
        warning: &'static str,
        missing_pool_warning: &'static str,
    ) -> bool {
        if self.network.is_none() {
            return true;
        }
        let Some(netns_pool) = self.netns_pool.as_mut() else {
            tracing::warn!("{missing_pool_warning}");
            return false;
        };
        release_snapshot_netns(netns_pool, &mut self.network, warning).await;
        self.network.is_none()
    }

    async fn prepare_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
        let cow_device = self.cow_device.take().ok_or_else(|| {
            SnapshotError::Teardown("snapshot attempt missing COW device before publish".into())
        })?;
        self.publish_attempt = Some(SnapshotPublishAttempt::new(cow_device));
        let kept_cow = match self.resolve_success_publish().await {
            Ok(kept_cow) => kept_cow,
            Err(err) => {
                self.cleanup_workspace_image(
                    "failed to cleanup snapshot workspace image after publish preparation error",
                );
                return Err(err);
            }
        };
        self.cleanup_workspace_image("failed to cleanup snapshot workspace image after success");
        Ok(kept_cow)
    }

    async fn resolve_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
        let publish_attempt = self.publish_attempt.as_mut().ok_or_else(|| {
            SnapshotError::Teardown("snapshot publish attempt missing before publish".into())
        })?;
        let kept_cow = publish_attempt.resolve_into_kept_cow().await?;
        self.publish_attempt.take();
        Ok(kept_cow)
    }

    async fn cleanup_failure(&mut self) {
        self.cleanup_workspace_image(
            "failed to cleanup snapshot workspace image after workflow error",
        );
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_workflow_error(cow_device).await;
        }
        self.cleanup_publish_attempt().await;
    }

    fn cleanup_workspace_image(&mut self, warning: &'static str) -> bool {
        self.workspace_image.cleanup(warning)
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

    async fn cleanup_device_pool(&mut self) -> bool {
        let Some(device_pool) = self.device_pool.as_ref() else {
            return true;
        };
        device_pool.cleanup().await;
        self.device_pool.take();
        true
    }

    async fn cleanup_netns_pool_after_explicit_teardown(&mut self) {
        if let Some(netns_pool) = self.netns_pool.as_mut()
            && let Err(e) = netns_pool.cleanup().await
        {
            tracing::warn!(error = %e, "failed to cleanup netns pool");
        }
        self.netns_pool.take();
    }

    async fn cleanup_netns_pool_during_cancellation(&mut self) -> bool {
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

    async fn destroy_cow_during_cancellation(&mut self) -> bool {
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

    fn drop_forwarder_handles(&mut self) {
        self.stdout_handle.take();
        self.stderr_handle.take();
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

struct SnapshotCleanupReport {
    child_reaped: bool,
    stdout_forwarder_finished: bool,
    stderr_forwarder_finished: bool,
    network_released: bool,
    publish_cleaned: bool,
    workspace_image_cleaned: bool,
    cow_destroyed: bool,
    device_pool_cleaned: bool,
    netns_pool_cleaned: bool,
    #[cfg(test)]
    cleanup_events: Vec<&'static str>,
}

struct SnapshotCleanupFinalizer {
    resources: SnapshotCleanupResources,
    #[cfg(test)]
    cleanup_complete_tx: Option<tokio::sync::oneshot::Sender<SnapshotCleanupReport>>,
    #[cfg(test)]
    cleanup_events: Vec<&'static str>,
}

impl SnapshotCleanupFinalizer {
    async fn run(mut self) {
        let child_reaped = if let Some(child) = self.resources.child.as_mut() {
            kill_and_reap_firecracker_bounded(child, SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT).await
        } else {
            true
        };
        self.resources.child.take();

        let stdout_forwarder_finished = drain_or_abort_forwarder(
            &mut self.resources.stdout_handle,
            "stdout",
            SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
        )
        .await;
        let stderr_forwarder_finished = drain_or_abort_forwarder(
            &mut self.resources.stderr_handle,
            "stderr",
            SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
        )
        .await;

        let network_released = self
            .resources
            .release_network(
                "failed to release netns during snapshot cancellation cleanup",
                "snapshot cancellation cleanup missing netns pool while releasing netns",
            )
            .await;
        let workspace_image_cleaned = self.cleanup_workspace_image();
        let publish_cleaned = self.cleanup_publish_attempt().await;
        let cow_destroyed = self.resources.destroy_cow_during_cancellation().await;
        let device_pool_cleaned = self.cleanup_device_pool().await;
        let netns_pool_cleaned = self
            .resources
            .cleanup_netns_pool_during_cancellation()
            .await;

        let report = SnapshotCleanupReport {
            child_reaped,
            stdout_forwarder_finished,
            stderr_forwarder_finished,
            network_released,
            publish_cleaned,
            workspace_image_cleaned,
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
            workspace_image_cleaned = report.workspace_image_cleaned,
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

    async fn cleanup_publish_attempt(&mut self) -> bool {
        let has_publish_attempt = self
            .resources
            .publish_attempt
            .as_ref()
            .is_some_and(SnapshotPublishAttempt::has_cleanup_work);
        if !has_publish_attempt {
            return true;
        }
        #[cfg(test)]
        self.cleanup_events.push("publish");
        self.resources.cleanup_publish_attempt().await
    }

    fn cleanup_workspace_image(&mut self) -> bool {
        if !self.resources.workspace_image.has_cleanup_work() {
            return true;
        }
        #[cfg(test)]
        self.cleanup_events.push("workspace_image");
        self.resources.cleanup_workspace_image(
            "failed to cleanup snapshot workspace image during cancellation cleanup",
        )
    }

    async fn cleanup_device_pool(&mut self) -> bool {
        if self.resources.device_pool.is_none() {
            return true;
        }
        #[cfg(test)]
        self.cleanup_events.push("device_pool");
        self.resources.cleanup_device_pool().await
    }

    fn has_cleanup_work(&self) -> bool {
        self.resources.has_cleanup_work()
    }
}

fn cleanup_empty_workspace_image_parent_dir(workspace_image: &Path) {
    let Some(parent) = workspace_image.parent() else {
        return;
    };

    match std::fs::remove_dir(parent) {
        Ok(()) => {}
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(e) => {
            tracing::warn!(
                error = %e,
                dir = %parent.display(),
                "failed to cleanup empty snapshot workspace image attempt dir"
            );
        }
    }
}

impl Drop for SnapshotCleanupFinalizer {
    fn drop(&mut self) {
        if !self.has_cleanup_work() {
            return;
        }

        let presence = self.resources.presence();
        tracing::warn!(
            has_device_pool = presence.has_device_pool,
            has_netns_pool = presence.has_netns_pool,
            has_cow_device = presence.has_cow_device,
            has_workspace_image = presence.has_workspace_image,
            has_publish_attempt = presence.has_publish_attempt,
            has_network = presence.has_network,
            has_child = presence.has_child,
            has_stdout_forwarder = presence.has_stdout_forwarder,
            has_stderr_forwarder = presence.has_stderr_forwarder,
            "snapshot cancellation finalizer dropped before cleanup completed"
        );
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

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use nbd_cow::KeptCow;
    use nbd_cow::pool::DevicePoolHandle;

    use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
    use crate::snapshot::cow::{snapshot_attempt_cow_file, snapshot_attempt_workspace_image_file};
    use crate::snapshot::publish::SnapshotPublishAttempt;

    use super::*;

    async fn write_required_snapshot_artifacts(output: &SnapshotOutputPaths) {
        tokio::fs::create_dir_all(output.dir())
            .await
            .expect("create output dir");
        for artifact in [output.snapshot(), output.memory()] {
            tokio::fs::write(&artifact, b"snapshot artifact")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }
    }

    async fn write_kept_cow_for_test(work: &Path, token: &str) -> KeptCow {
        let cow_file = snapshot_attempt_cow_file(work, token);
        let bitmap_file = cow_file.with_file_name("cow.img.bitmap");
        let attempt_dir = cow_file.parent().expect("attempt dir");
        tokio::fs::create_dir_all(attempt_dir)
            .await
            .expect("create attempt dir");
        tokio::fs::write(&cow_file, b"cow")
            .await
            .expect("write cow");
        tokio::fs::write(&bitmap_file, b"bitmap")
            .await
            .expect("write bitmap");
        KeptCow {
            cow_file,
            bitmap_file,
        }
    }

    #[tokio::test]
    async fn snapshot_cleanup_resources_presence_tracks_all_handoff_resources() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
        let kept_cow =
            write_kept_cow_for_test(&attempt.output().work_dir(), "presence-summary").await;
        let (tx, rx) = tokio::sync::oneshot::channel();

        attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
            kept_cow,
        ));
        attempt.track_device_pool_for_test(DevicePoolHandle::new(
            nbd_cow::pool::DevicePoolConfig::default(),
        ));
        attempt.track_network_for_test("test-snapshot-presence");
        attempt.track_child_for_test(long_running_child_for_test());
        attempt.track_stdout_handle_for_test(tokio::spawn(std::future::pending::<()>()));
        attempt.track_stderr_handle_for_test(tokio::spawn(std::future::pending::<()>()));

        assert_eq!(
            attempt.cleanup_resources.presence(),
            SnapshotCleanupPresence {
                has_device_pool: true,
                has_netns_pool: true,
                has_cow_device: false,
                has_workspace_image: false,
                has_publish_attempt: true,
                has_network: true,
                has_child: true,
                has_stdout_forwarder: true,
                has_stderr_forwarder: true,
            }
        );
        assert!(attempt.cleanup_resources.has_cleanup_work());

        attempt.notify_cleanup_complete_for_test(tx);
        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.child_reaped);
        assert!(report.stdout_forwarder_finished);
        assert!(report.stderr_forwarder_finished);
        assert!(report.network_released);
        assert!(report.publish_cleaned);
        assert!(report.workspace_image_cleaned);
        assert!(report.device_pool_cleaned);
        assert!(report.netns_pool_cleaned);
    }

    #[tokio::test]
    async fn snapshot_cleanup_finalizer_resolves_publish_before_device_pool_cleanup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
        let kept_cow =
            write_kept_cow_for_test(&attempt.output().work_dir(), "publish-before-device-pool")
                .await;
        let (tx, rx) = tokio::sync::oneshot::channel();

        attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
            kept_cow,
        ));
        attempt.track_device_pool_for_test(DevicePoolHandle::new(
            nbd_cow::pool::DevicePoolConfig::default(),
        ));
        attempt.notify_cleanup_complete_for_test(tx);

        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.publish_cleaned);
        assert!(report.device_pool_cleaned);
        assert_eq!(
            report.cleanup_events,
            vec!["publish", "device_pool"],
            "publish cleanup must finish before device pool cleanup"
        );
    }

    #[tokio::test]
    async fn snapshot_cleanup_finalizer_removes_workspace_image() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
        let workspace_image =
            snapshot_attempt_workspace_image_file(attempt.paths().workspace(), "default-test");
        let (tx, rx) = tokio::sync::oneshot::channel();

        tokio::fs::create_dir_all(workspace_image.parent().expect("workspace image parent"))
            .await
            .expect("create workspace image parent");
        tokio::fs::write(&workspace_image, b"workspace")
            .await
            .expect("write workspace image");
        attempt.track_workspace_image_for_test(workspace_image.clone());
        attempt.notify_cleanup_complete_for_test(tx);

        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.workspace_image_cleaned);
        assert_eq!(report.cleanup_events, vec!["workspace_image"]);
        assert!(
            !tokio::fs::try_exists(&workspace_image).await.unwrap(),
            "detached cleanup should remove temporary workspace image"
        );
        assert!(
            !tokio::fs::try_exists(workspace_image.parent().expect("workspace image parent"))
                .await
                .unwrap(),
            "detached cleanup should remove the empty attempt dir"
        );
    }

    #[tokio::test]
    async fn snapshot_workspace_image_cleanup_preserves_nonempty_attempt_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
        let workspace_image =
            snapshot_attempt_workspace_image_file(attempt.paths().workspace(), "default-test");
        let attempt_dir = workspace_image
            .parent()
            .expect("workspace image parent")
            .to_path_buf();
        let cow_file = attempt_dir.join("cow.img");

        tokio::fs::create_dir_all(&attempt_dir)
            .await
            .expect("create attempt dir");
        tokio::fs::write(&workspace_image, b"workspace")
            .await
            .expect("write workspace image");
        tokio::fs::write(&cow_file, b"cow")
            .await
            .expect("write cow");
        attempt.track_workspace_image_for_test(workspace_image.clone());

        assert!(
            attempt
                .cleanup_resources
                .cleanup_workspace_image("failed to cleanup workspace image in test")
        );

        assert!(
            !tokio::fs::try_exists(&workspace_image).await.unwrap(),
            "workspace image should be removed"
        );
        assert!(
            tokio::fs::try_exists(&attempt_dir).await.unwrap(),
            "attempt dir must remain while COW artifacts still exist"
        );
        assert_eq!(
            tokio::fs::read(&cow_file).await.unwrap(),
            b"cow",
            "cleanup must not remove unrelated attempt files"
        );
    }

    #[tokio::test]
    async fn snapshot_setup_error_cleanup_removes_workspace_image_inline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
        let workspace_image =
            snapshot_attempt_workspace_image_file(attempt.paths().workspace(), "default-test");

        tokio::fs::create_dir_all(workspace_image.parent().expect("workspace image parent"))
            .await
            .expect("create workspace image parent");
        tokio::fs::write(&workspace_image, b"workspace")
            .await
            .expect("write workspace image");
        attempt.track_workspace_image_for_test(workspace_image.clone());

        attempt
            .cleanup_resources
            .destroy_cow_after_setup_error("test setup error")
            .await;

        assert!(matches!(
            attempt.cleanup_resources.workspace_image,
            AttemptWorkspaceImage::Cleaned
        ));
        assert!(
            !tokio::fs::try_exists(&workspace_image).await.unwrap(),
            "setup error cleanup should remove temporary workspace image inline"
        );
    }

    #[tokio::test]
    async fn snapshot_cleanup_finalizer_removes_attempt_dir_after_workspace_and_publish_cleanup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().join("output"));
        let paths = SandboxPaths::new(output.work_dir());
        let sock_paths = SockPaths::new(dir.path().join("sock"));
        let kept_cow = write_kept_cow_for_test(&output.work_dir(), "shared-attempt").await;
        let attempt_dir = kept_cow
            .cow_file
            .parent()
            .expect("attempt dir")
            .to_path_buf();
        let workspace_image = attempt_dir.join("workspace.ext4");
        let (tx, rx) = tokio::sync::oneshot::channel();

        tokio::fs::write(&workspace_image, b"workspace")
            .await
            .expect("write workspace image");
        let mut attempt = SnapshotAttempt::new_without_cow_for_test(
            paths,
            sock_paths,
            output,
            workspace_image.clone(),
        );
        attempt.track_workspace_image_for_test(workspace_image);
        attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
            kept_cow,
        ));
        attempt.notify_cleanup_complete_for_test(tx);

        drop(attempt);
        let report = wait_for_snapshot_cleanup(rx).await;

        assert!(report.workspace_image_cleaned);
        assert!(report.publish_cleaned);
        assert_eq!(
            report.cleanup_events,
            vec!["workspace_image", "publish"],
            "workspace image must be removed before COW publish cleanup removes the attempt dir"
        );
        assert!(
            !tokio::fs::try_exists(&attempt_dir).await.unwrap(),
            "attempt dir should be removed after workspace image and kept COW cleanup"
        );
    }

    #[tokio::test]
    async fn snapshot_attempt_drop_handoff_cleans_publish_resolve_cancellation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
        write_required_snapshot_artifacts(attempt.output()).await;
        let kept_cow =
            write_kept_cow_for_test(&attempt.output().work_dir(), "cancel-resolve").await;
        let cow_file = kept_cow.cow_file.clone();
        let bitmap_file = kept_cow.bitmap_file.clone();
        let output_dir = attempt.output().dir().to_path_buf();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (kept_tx, kept_rx) = tokio::sync::oneshot::channel();
        let (cleanup_tx, cleanup_rx) = tokio::sync::oneshot::channel();

        attempt.track_publish_attempt_for_test(
            SnapshotPublishAttempt::new_with_keep_future_for_test(async move {
                let _ = started_tx.send(());
                kept_rx.await.map_err(|_| {
                    nbd_cow::error::NbdCowError::Io(std::io::Error::other("test sender dropped"))
                })
            }),
        );
        attempt.notify_cleanup_complete_for_test(cleanup_tx);

        let handle =
            tokio::spawn(async move { attempt.cleanup_resources.resolve_success_publish().await });
        started_rx
            .await
            .expect("keep-COW finalizer should be polled");
        handle.abort();
        let _ = handle.await;

        kept_tx.send(kept_cow).expect("send kept cow");
        let report = wait_for_snapshot_cleanup(cleanup_rx).await;
        let output = SnapshotOutputPaths::new(output_dir);

        assert!(report.publish_cleaned);
        assert!(
            !tokio::fs::try_exists(&cow_file).await.unwrap(),
            "cancellation cleanup should remove temporary cow"
        );
        assert!(
            !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
            "cancellation cleanup should remove temporary bitmap"
        );
        assert!(
            !tokio::fs::try_exists(output.complete_marker())
                .await
                .unwrap(),
            "cancellation cleanup must not publish complete marker"
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
        let workspace_image =
            snapshot_attempt_workspace_image_file(paths.workspace(), "socket-cleanup-test");
        let mut attempt =
            SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output, workspace_image);

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
        let workspace_image =
            snapshot_attempt_workspace_image_file(paths.workspace(), "default-test");
        (
            SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output, workspace_image),
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
}
