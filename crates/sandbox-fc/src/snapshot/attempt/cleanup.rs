use std::path::{Path, PathBuf};

use nbd_cow::KeptCow;
use nbd_cow::PooledNbdCowDevice;
use nbd_cow::pool::DevicePoolHandle;
use tokio::task::JoinHandle;

use crate::network::{NetnsLease, NetnsPool};

use super::super::SnapshotError;
use super::super::cow::{
    destroy_snapshot_cow_after_error, destroy_snapshot_cow_and_cleanup_attempt_dir,
};
use super::super::output::cleanup_workspace_image_file_sync;
use super::super::publish::SnapshotPublishAttempt;
use super::super::runtime::{
    SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT, SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
    drain_or_abort_forwarder, kill_and_reap_firecracker_bounded,
};

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
pub(super) enum AttemptWorkspaceImage {
    NotCreated(PathBuf),
    Owned(PathBuf),
    #[default]
    Cleaned,
}

impl AttemptWorkspaceImage {
    fn new(path: PathBuf) -> Self {
        Self::NotCreated(path)
    }

    pub(super) fn mark_create_started(&mut self) -> Result<PathBuf, SnapshotError> {
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

    pub(super) fn path_for_spawn(&self) -> Result<&Path, SnapshotError> {
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
pub(super) struct SnapshotCleanupPresence {
    pub(super) has_device_pool: bool,
    pub(super) has_netns_pool: bool,
    pub(super) has_cow_device: bool,
    pub(super) has_workspace_image: bool,
    pub(super) has_publish_attempt: bool,
    pub(super) has_network: bool,
    pub(super) has_child: bool,
    pub(super) has_stdout_forwarder: bool,
    pub(super) has_stderr_forwarder: bool,
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
pub(super) struct SnapshotCleanupResources {
    pub(super) netns_pool: Option<NetnsPool>,
    pub(super) device_pool: Option<DevicePoolHandle>,
    pub(super) cow_device: Option<PooledNbdCowDevice>,
    pub(super) workspace_image: AttemptWorkspaceImage,
    pub(super) publish_attempt: Option<SnapshotPublishAttempt>,
    pub(super) network: Option<NetnsLease>,
    pub(super) child: Option<tokio::process::Child>,
    pub(super) stdout_handle: Option<JoinHandle<()>>,
    pub(super) stderr_handle: Option<JoinHandle<()>>,
}

impl SnapshotCleanupResources {
    pub(super) fn new(
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
    pub(super) fn without_cow_for_test(workspace_image_path: PathBuf) -> Self {
        Self {
            netns_pool: Some(NetnsPool::inactive_for_test()),
            workspace_image: AttemptWorkspaceImage::new(workspace_image_path),
            ..Self::default()
        }
    }

    pub(super) fn presence(&self) -> SnapshotCleanupPresence {
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

    pub(super) fn has_cleanup_work(&self) -> bool {
        self.presence().has_cleanup_work()
    }

    pub(super) async fn destroy_cow_after_setup_error(&mut self, context: &'static str) {
        self.cleanup_workspace_image(
            "failed to cleanup snapshot workspace image after setup error",
        );
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_error(context, cow_device).await;
        }
    }

    pub(super) async fn release_network(
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

    pub(super) async fn prepare_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
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

    pub(super) async fn resolve_success_publish(&mut self) -> Result<KeptCow, SnapshotError> {
        let publish_attempt = self.publish_attempt.as_mut().ok_or_else(|| {
            SnapshotError::Teardown("snapshot publish attempt missing before publish".into())
        })?;
        let kept_cow = publish_attempt.resolve_into_kept_cow().await?;
        self.publish_attempt.take();
        Ok(kept_cow)
    }

    pub(super) async fn cleanup_failure(&mut self) {
        self.cleanup_workspace_image(
            "failed to cleanup snapshot workspace image after workflow error",
        );
        if let Some(cow_device) = self.cow_device.take() {
            destroy_snapshot_cow_after_workflow_error(cow_device).await;
        }
        self.cleanup_publish_attempt().await;
    }

    pub(super) fn cleanup_workspace_image(&mut self, warning: &'static str) -> bool {
        self.workspace_image.cleanup(warning)
    }

    pub(super) async fn cleanup_publish_attempt(&mut self) -> bool {
        let Some(publish_attempt) = self.publish_attempt.as_mut() else {
            return true;
        };
        let cleaned = publish_attempt.cleanup_after_cancellation().await;
        if cleaned || !publish_attempt.has_cleanup_work() {
            self.publish_attempt.take();
        }
        cleaned
    }

    pub(super) async fn cleanup_device_pool(&mut self) -> bool {
        let Some(device_pool) = self.device_pool.as_ref() else {
            return true;
        };
        device_pool.cleanup().await;
        self.device_pool.take();
        true
    }

    pub(super) async fn cleanup_netns_pool_after_explicit_teardown(&mut self) {
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

    pub(super) fn drop_forwarder_handles(&mut self) {
        self.stdout_handle.take();
        self.stderr_handle.take();
    }
}

pub(super) struct SnapshotCleanupReport {
    pub(super) child_reaped: bool,
    pub(super) stdout_forwarder_finished: bool,
    pub(super) stderr_forwarder_finished: bool,
    pub(super) network_released: bool,
    pub(super) publish_cleaned: bool,
    pub(super) workspace_image_cleaned: bool,
    pub(super) cow_destroyed: bool,
    pub(super) device_pool_cleaned: bool,
    pub(super) netns_pool_cleaned: bool,
    #[cfg(test)]
    pub(super) cleanup_events: Vec<&'static str>,
}

pub(super) struct SnapshotCleanupFinalizer {
    pub(super) resources: SnapshotCleanupResources,
    #[cfg(test)]
    pub(super) cleanup_complete_tx: Option<tokio::sync::oneshot::Sender<SnapshotCleanupReport>>,
    #[cfg(test)]
    pub(super) cleanup_events: Vec<&'static str>,
}

impl SnapshotCleanupFinalizer {
    pub(super) async fn run(mut self) {
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
