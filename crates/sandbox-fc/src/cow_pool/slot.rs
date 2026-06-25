use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[cfg(test)]
use tokio::sync::oneshot;
use tracing::warn;

struct SlotWorkspaceCleanup {
    /// Unique slot ID. Used as workspace directory name before checkout.
    id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    workspace: PathBuf,
    #[cfg(test)]
    teardown_gate: Option<SlotTeardownGate>,
}

impl SlotWorkspaceCleanup {
    fn new(id: String, workspace: PathBuf) -> Self {
        Self {
            id,
            workspace,
            #[cfg(test)]
            teardown_gate: None,
        }
    }

    fn remove_best_effort(self) -> PathBuf {
        let Self {
            id,
            workspace,
            #[cfg(test)]
            teardown_gate,
        } = self;
        #[cfg(test)]
        if let Some(teardown_gate) = teardown_gate {
            let _ = teardown_gate.started.send(workspace.clone());
            let _ = teardown_gate.release.recv();
        }
        match std::fs::remove_dir_all(&workspace) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                warn!(id = %id, error = %e, "failed to delete pool workspace dir");
            }
        }
        workspace
    }
}

#[cfg(test)]
struct SlotTeardownGate {
    started: oneshot::Sender<PathBuf>,
    release: std::sync::mpsc::Receiver<()>,
}

/// A pre-warmed one-shot slot: workspace directory + COW file.
///
/// The caller must create the NBD device on acquire via
/// `DevicePoolHandle::create_cow_device()`.
pub(crate) struct PrewarmedSlot {
    /// Unique slot ID. Used as workspace directory name before checkout.
    id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    workspace: PathBuf,
    cleanup: Option<SlotWorkspaceCleanup>,
    #[cfg(test)]
    pub(super) drop_notify: Option<oneshot::Sender<PathBuf>>,
}

impl PrewarmedSlot {
    pub(crate) fn new(id: String, workspace: PathBuf) -> Self {
        let cleanup = SlotWorkspaceCleanup::new(id.clone(), workspace.clone());
        Self {
            id,
            workspace,
            cleanup: Some(cleanup),
            #[cfg(test)]
            drop_notify: None,
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(crate) fn disarm_after_workspace_rename(mut self) {
        self.cleanup.take();
    }

    #[cfg(test)]
    pub(super) fn set_teardown_gate(
        &mut self,
        started: oneshot::Sender<PathBuf>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        if let Some(cleanup) = self.cleanup.as_mut() {
            cleanup.teardown_gate = Some(SlotTeardownGate { started, release });
        }
    }

    /// Path to the COW file inside the workspace.
    #[cfg(test)]
    pub(super) fn cow_file(&self) -> PathBuf {
        self.workspace().join("cow.img")
    }

    #[cfg(test)]
    fn notify_teardown(&mut self, workspace: PathBuf) {
        if let Some(drop_notify) = self.drop_notify.take() {
            let _ = drop_notify.send(workspace);
        }
    }

    #[cfg(not(test))]
    fn notify_teardown(&mut self, _workspace: PathBuf) {}
}

impl Drop for PrewarmedSlot {
    fn drop(&mut self) {
        // Fallback cleanup for forgotten, cancelled, or unwound slots. Normal
        // async cleanup paths should use `destroy_slot_async`.
        if let Some(cleanup) = self.cleanup.take() {
            let workspace = cleanup.remove_best_effort();
            self.notify_teardown(workspace);
        }
    }
}

impl std::fmt::Debug for PrewarmedSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrewarmedSlot")
            .field("id", &self.id())
            .field("workspace", &self.workspace())
            .finish_non_exhaustive()
    }
}

/// Best-effort synchronous teardown of a pre-warmed slot.
///
/// Removes the workspace directory (which contains the COW file).
pub(crate) fn destroy_slot_sync(mut slot: PrewarmedSlot) {
    if let Some(cleanup) = slot.cleanup.take() {
        let workspace = cleanup.remove_best_effort();
        slot.notify_teardown(workspace);
    }
}

/// Best-effort teardown of a pre-warmed slot on Tokio's blocking pool.
///
/// The blocking task is spawned before this returns so dropping the returned
/// future cannot make the slot fall back to synchronous `Drop` on the caller.
pub(crate) fn destroy_slot_async(slot: PrewarmedSlot) -> impl std::future::Future<Output = ()> {
    let teardown = tokio::task::spawn_blocking(move || destroy_slot_sync(slot));
    async move {
        if let Err(e) = teardown.await {
            warn!(error = %e, "COW slot teardown task failed");
        }
    }
}
