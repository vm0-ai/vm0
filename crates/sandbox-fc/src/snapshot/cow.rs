use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use nbd_cow::{DestroyRetryPolicy, PooledNbdCowDevice};
use tokio::task::JoinHandle;

use super::SnapshotError;
use super::output::cleanup_remove_dir_result;

pub(super) fn cow_destroy_retry_policy() -> DestroyRetryPolicy {
    crate::factory::cow_destroy_retry_policy()
}

pub(super) struct SnapshotCowCleanupFinalizer {
    handle: Option<JoinHandle<nbd_cow::error::Result<()>>>,
}

impl SnapshotCowCleanupFinalizer {
    pub(super) fn new(handle: JoinHandle<nbd_cow::error::Result<()>>) -> Self {
        Self {
            handle: Some(handle),
        }
    }
}

impl Future for SnapshotCowCleanupFinalizer {
    type Output = nbd_cow::error::Result<()>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let Some(handle) = this.handle.as_mut() else {
            return Poll::Ready(Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
                "snapshot COW cleanup finalizer polled after completion",
            ))));
        };

        match Pin::new(handle).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                this.handle.take();
                Poll::Ready(finish_snapshot_cow_cleanup_join(result))
            }
        }
    }
}

impl Drop for SnapshotCowCleanupFinalizer {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(observe_detached_snapshot_cow_cleanup(handle));
            }
            Err(e) => tracing::warn!(
                error = %e,
                "snapshot COW cleanup finalizer dropped outside Tokio runtime; continuing without observer"
            ),
        }
    }
}

fn finish_snapshot_cow_cleanup_join(
    result: std::result::Result<nbd_cow::error::Result<()>, tokio::task::JoinError>,
) -> nbd_cow::error::Result<()> {
    match result {
        Ok(result) => result,
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
            format!("snapshot COW cleanup finalizer task was cancelled: {e}"),
        ))),
    }
}

async fn observe_detached_snapshot_cow_cleanup(handle: JoinHandle<nbd_cow::error::Result<()>>) {
    match handle.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "detached snapshot COW cleanup finalizer failed");
        }
        Err(e) if e.is_panic() => {
            tracing::error!(error = %e, "detached snapshot COW cleanup finalizer panicked");
        }
        Err(e) => {
            tracing::warn!(error = %e, "detached snapshot COW cleanup finalizer task was cancelled");
        }
    }
}

pub(super) fn destroy_snapshot_cow_and_cleanup_attempt_dir(
    cow_device: PooledNbdCowDevice,
) -> SnapshotCowCleanupFinalizer {
    let cow_file = cow_device.cow_file().to_path_buf();
    SnapshotCowCleanupFinalizer::new(tokio::spawn(async move {
        cow_device
            .destroy_with_retries(cow_destroy_retry_policy())
            .await?;
        cleanup_snapshot_attempt_dir_for_cow(&cow_file).await;
        Ok(())
    }))
}

pub(super) async fn destroy_snapshot_cow_after_error(
    context: &'static str,
    cow_device: PooledNbdCowDevice,
) {
    if let Err(e) = destroy_snapshot_cow_and_cleanup_attempt_dir(cow_device).await {
        tracing::warn!(
            error = %e,
            context,
            "failed to destroy COW device after snapshot setup error"
        );
    }
}

pub(super) fn create_sparse_cow_file(path: &Path, size: u64) -> Result<(), SnapshotError> {
    let file = std::fs::File::create(path)
        .map_err(|e| SnapshotError::Setup(format!("create COW file: {e}")))?;
    file.set_len(size)
        .map_err(|e| SnapshotError::Setup(format!("set COW file size: {e}")))?;
    Ok(())
}

pub(super) fn snapshot_attempt_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(super) fn snapshot_attempt_dir(work_dir: &Path, token: &str) -> PathBuf {
    work_dir.join("attempts").join(token)
}

pub(super) fn snapshot_attempt_cow_file(work_dir: &Path, token: &str) -> PathBuf {
    snapshot_attempt_dir(work_dir, token).join("cow.img")
}

pub(super) struct SnapshotAttemptDirGuard {
    dir: Option<PathBuf>,
}

impl SnapshotAttemptDirGuard {
    pub(super) fn new(dir: PathBuf) -> Self {
        Self { dir: Some(dir) }
    }

    pub(super) fn disarm(&mut self) {
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

pub(super) async fn cleanup_snapshot_attempt_dir_for_cow(cow_file: &Path) -> bool {
    let Some(dir) = cow_file.parent() else {
        return true;
    };
    cleanup_remove_dir_result(
        tokio::fs::remove_dir(dir).await,
        dir,
        "failed to cleanup snapshot attempt dir",
    )
}

pub(super) fn cleanup_snapshot_attempt_dir_for_cow_sync(cow_file: &Path) -> bool {
    let Some(dir) = cow_file.parent() else {
        return true;
    };
    cleanup_remove_dir_result(
        std::fs::remove_dir(dir),
        dir,
        "failed to cleanup snapshot attempt dir",
    )
}
