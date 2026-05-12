use std::path::PathBuf;

use async_trait::async_trait;
use sandbox::{SandboxError, SandboxInvalidStateContext};
use tracing::warn;

use nbd_cow::PooledNbdCowDevice;

use crate::factory::cleanup_group::{FactoryCleanupGroup, FactoryCleanupTaskKind};
use crate::factory::cow_cleanup::destroy_cow_device_with_retries;
use crate::leaked_resources::LeakedResources;
use crate::network::{NetnsLease, NetnsPoolHandle};
use crate::paths::{SandboxPaths, SockPaths};

#[async_trait]
pub(super) trait CreateRollbackCleanup {
    async fn destroy_cow_device(&self, cow_device: PooledNbdCowDevice) -> bool;
    async fn release_network(&self, network: &mut Option<NetnsLease>);
    async fn remove_dir(&self, kind: &'static str, path: PathBuf);
    fn destroy_slot(&self, slot: crate::cow_pool::PrewarmedSlot);
}

pub(super) struct FactoryCreateRollbackCleanup {
    pub(super) id: String,
    pub(super) netns_pool: NetnsPoolHandle,
}

#[async_trait]
impl CreateRollbackCleanup for FactoryCreateRollbackCleanup {
    async fn destroy_cow_device(&self, cow_device: PooledNbdCowDevice) -> bool {
        destroy_cow_device_with_retries(&self.id, cow_device).await
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let outcome = self.netns_pool.release(network).await;
        if let Some(message) = outcome.invalid_message() {
            warn!(id = %self.id, error = %message, "failed to release netns during rollback");
        }
    }

    async fn remove_dir(&self, kind: &'static str, path: PathBuf) {
        match tokio::fs::remove_dir_all(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                warn!(
                    id = %self.id,
                    error = %e,
                    path = %path.display(),
                    kind,
                    "failed to delete create-rollback directory"
                );
            }
        }
    }

    fn destroy_slot(&self, slot: crate::cow_pool::PrewarmedSlot) {
        crate::cow_pool::destroy_slot(slot);
    }
}

pub(super) struct SandboxCreateResources {
    pub(super) sandbox_paths: SandboxPaths,
    pub(super) sock_paths: SockPaths,
    pub(super) network: NetnsLease,
    pub(super) cow_device: PooledNbdCowDevice,
}

#[cfg(test)]
pub(super) struct SandboxCreateResourcesWithoutCow {
    sandbox_paths: SandboxPaths,
    sock_paths: SockPaths,
    network: NetnsLease,
}

pub(super) struct SandboxCreateTransaction {
    id: String,
    slot: Option<crate::cow_pool::PrewarmedSlot>,
    workspace: Option<PathBuf>,
    sock_dir: Option<PathBuf>,
    network: Option<NetnsLease>,
    cow_device: Option<PooledNbdCowDevice>,
    leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    delete_workspace_on_leak_cleanup: bool,
}

impl SandboxCreateTransaction {
    #[cfg(test)]
    fn new(id: String) -> Self {
        Self::new_with_leak_tx(id, None)
    }

    pub(super) fn new_with_leak_tx(
        id: String,
        leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    ) -> Self {
        Self {
            id,
            slot: None,
            workspace: None,
            sock_dir: None,
            network: None,
            cow_device: None,
            leak_tx,
            delete_workspace_on_leak_cleanup: true,
        }
    }

    pub(super) fn track_slot(&mut self, slot: crate::cow_pool::PrewarmedSlot) {
        self.slot = Some(slot);
    }

    pub(super) fn slot_workspace(&self) -> sandbox::Result<PathBuf> {
        self.slot
            .as_ref()
            .map(|slot| slot.workspace.clone())
            .ok_or_else(|| create_transaction_invalid_state("missing COW slot before rename"))
    }

    pub(super) fn slot_renamed_to(&mut self, workspace: PathBuf) {
        self.slot.take();
        self.workspace = Some(workspace);
    }

    pub(super) fn track_sock_dir(&mut self, sock_dir: PathBuf) {
        self.sock_dir = Some(sock_dir);
    }

    pub(super) fn track_network(&mut self, network: NetnsLease) {
        self.network = Some(network);
    }

    pub(super) fn track_cow_device(&mut self, cow_device: PooledNbdCowDevice) {
        self.cow_device = Some(cow_device);
    }

    pub(super) fn commit(&mut self) -> sandbox::Result<SandboxCreateResources> {
        self.validate_base_resources("commit")?;
        if self.cow_device.is_none() {
            return Err(create_transaction_invalid_state(
                "missing COW device at commit",
            ));
        }

        let (workspace, sock_dir, network) = self.take_base_resources_after_validation()?;
        let cow_device = self
            .cow_device
            .take()
            .ok_or_else(|| create_transaction_invalid_state("missing COW device at commit"))?;
        self.slot.take();

        Ok(SandboxCreateResources {
            sandbox_paths: SandboxPaths::new(workspace),
            sock_paths: SockPaths::new(sock_dir),
            network,
            cow_device,
        })
    }

    #[cfg(test)]
    fn commit_without_cow_for_test(&mut self) -> sandbox::Result<SandboxCreateResourcesWithoutCow> {
        self.validate_base_resources("test commit")?;
        let (workspace, sock_dir, network) = self.take_base_resources_after_validation()?;
        self.slot.take();

        Ok(SandboxCreateResourcesWithoutCow {
            sandbox_paths: SandboxPaths::new(workspace),
            sock_paths: SockPaths::new(sock_dir),
            network,
        })
    }

    fn validate_base_resources(&self, context: &str) -> sandbox::Result<()> {
        if self.workspace.is_none() {
            return Err(create_transaction_invalid_state(&format!(
                "missing workspace at {context}"
            )));
        }
        if self.sock_dir.is_none() {
            return Err(create_transaction_invalid_state(&format!(
                "missing sock dir at {context}"
            )));
        }
        if self.network.is_none() {
            return Err(create_transaction_invalid_state(&format!(
                "missing netns at {context}"
            )));
        }
        Ok(())
    }

    fn take_base_resources_after_validation(
        &mut self,
    ) -> sandbox::Result<(PathBuf, PathBuf, NetnsLease)> {
        let workspace = self.workspace.take().ok_or_else(|| {
            create_transaction_invalid_state("missing workspace after validation")
        })?;
        let sock_dir = self
            .sock_dir
            .take()
            .ok_or_else(|| create_transaction_invalid_state("missing sock dir after validation"))?;
        let network = self
            .network
            .take()
            .ok_or_else(|| create_transaction_invalid_state("missing netns after validation"))?;
        Ok((workspace, sock_dir, network))
    }

    async fn rollback<C>(&mut self, cleanup: &C)
    where
        C: CreateRollbackCleanup + Sync,
    {
        let keep_workspace = if let Some(cow_device) = self.cow_device.take() {
            // The COW finalizer continues in the background if this future is
            // cancelled. Keep the workspace until the finalizer reports success.
            self.delete_workspace_on_leak_cleanup = false;
            let cow_destroyed = cleanup.destroy_cow_device(cow_device).await;
            self.delete_workspace_on_leak_cleanup = cow_destroyed;
            !cow_destroyed
        } else {
            false
        };
        if let Some(network) = self.network.take() {
            self.network = Some(network);
            cleanup.release_network(&mut self.network).await;
        }
        if self.network.is_some() {
            warn!(
                id = %self.id,
                "keeping create rollback directories so Drop can hand unreleased netns to leak cleaner"
            );
            return;
        }
        if let Some(sock_dir) = self.sock_dir.take() {
            cleanup.remove_dir("sock", sock_dir).await;
        }
        if let Some(workspace) = self.workspace.take() {
            if keep_workspace {
                warn!(
                    id = %self.id,
                    path = %workspace.display(),
                    "keeping workspace after failed COW rollback"
                );
            } else {
                cleanup.remove_dir("workspace", workspace).await;
            }
        }
        if let Some(slot) = self.slot.take() {
            cleanup.destroy_slot(slot);
        }
    }

    fn has_resources(&self) -> bool {
        self.slot.is_some()
            || self.workspace.is_some()
            || self.sock_dir.is_some()
            || self.network.is_some()
            || self.cow_device.is_some()
    }

    fn send_async_leaked_resources(&mut self) -> bool {
        if self.network.is_none() && self.cow_device.is_none() {
            return false;
        }

        let Some(leak_tx) = self.leak_tx.as_ref() else {
            return false;
        };
        let Some(sock_dir) = self.sock_dir.take() else {
            return false;
        };
        let Some(workspace) = self.workspace.take() else {
            self.sock_dir = Some(sock_dir);
            return false;
        };

        let leaked = LeakedResources {
            sandbox_id: self.id.clone(),
            cow_device: self.cow_device.take(),
            network: self.network.take(),
            sock_dir,
            workspace,
            delete_workspace: self.delete_workspace_on_leak_cleanup,
        };

        match leak_tx.send(leaked) {
            Ok(()) => true,
            Err(tokio::sync::mpsc::error::SendError(mut leaked)) => {
                self.cow_device = leaked.cow_device.take();
                self.network = leaked.network.take();
                self.sock_dir = Some(leaked.sock_dir);
                self.workspace = Some(leaked.workspace);
                false
            }
        }
    }
}

impl Drop for SandboxCreateTransaction {
    fn drop(&mut self) {
        if !self.has_resources() {
            return;
        }

        warn!(
            id = %self.id,
            has_slot = self.slot.is_some(),
            has_workspace = self.workspace.is_some(),
            has_sock_dir = self.sock_dir.is_some(),
            has_network = self.network.is_some(),
            has_cow_device = self.cow_device.is_some(),
            "sandbox create transaction dropped without explicit commit or rollback"
        );

        if let Some(slot) = self.slot.take() {
            crate::cow_pool::destroy_slot(slot);
        }
        if self.send_async_leaked_resources() {
            return;
        }
        if let Some(sock_dir) = self.sock_dir.take() {
            let _ = std::fs::remove_dir_all(sock_dir);
        }
        if let Some(workspace) = self.workspace.take() {
            if self.delete_workspace_on_leak_cleanup {
                let _ = std::fs::remove_dir_all(workspace);
            } else {
                warn!(
                    id = %self.id,
                    path = %workspace.display(),
                    "preserving workspace after failed COW cleanup"
                );
            }
        }
        if self.cow_device.is_some() {
            warn!(
                id = %self.id,
                "COW device acquired during create requires async rollback and may need runner gc"
            );
        }
        if self.network.is_some() {
            warn!(
                id = %self.id,
                "netns acquired during create requires async rollback and may need runner gc"
            );
        }
    }
}

fn create_transaction_invalid_state(message: &str) -> SandboxError {
    SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Factory,
        state: "create transaction invalid".into(),
        message: message.into(),
    }
}

pub(super) async fn rollback_create_transaction<C>(
    tx: SandboxCreateTransaction,
    cleanup: C,
    cleanup_group: &FactoryCleanupGroup,
) where
    C: CreateRollbackCleanup + Send + Sync + 'static,
{
    let rollback_id = tx.id.clone();
    let rollback_waiter = cleanup_group.spawn(
        FactoryCleanupTaskKind::Rollback,
        rollback_id.clone(),
        async move {
            let mut tx = tx;
            tx.rollback(&cleanup).await;
        },
    );
    rollback_waiter.wait_logging_panic().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use crate::factory::cleanup_group::FactoryCleanupGroup;

    fn test_network() -> NetnsLease {
        NetnsLease::new_for_test("test-ns")
    }

    #[derive(Default)]
    struct RecordingCreateRollbackCleanup {
        events: Arc<Mutex<Vec<String>>>,
    }

    impl RecordingCreateRollbackCleanup {
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        fn record(&self, event: String) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[derive(Default)]
    struct FailingNetworkReleaseCleanup {
        events: Arc<Mutex<Vec<String>>>,
    }

    impl FailingNetworkReleaseCleanup {
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        fn record(&self, event: String) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[derive(Clone, Default)]
    struct BlockingRemoveDirCleanup {
        events: Arc<Mutex<Vec<String>>>,
        entered: Arc<AtomicUsize>,
        entered_notify: Arc<tokio::sync::Notify>,
        removed: Arc<AtomicUsize>,
        removed_notify: Arc<tokio::sync::Notify>,
        release: Arc<AtomicBool>,
        release_notify: Arc<tokio::sync::Notify>,
    }

    impl BlockingRemoveDirCleanup {
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        fn record(&self, event: String) {
            self.events.lock().unwrap().push(event);
        }

        async fn wait_entered(&self, expected: usize) {
            loop {
                let notified = self.entered_notify.notified();
                if self.entered.load(Ordering::SeqCst) >= expected {
                    return;
                }
                notified.await;
            }
        }

        async fn wait_removed(&self, expected: usize) {
            loop {
                let notified = self.removed_notify.notified();
                if self.removed.load(Ordering::SeqCst) >= expected {
                    return;
                }
                notified.await;
            }
        }

        fn release(&self) {
            self.release.store(true, Ordering::SeqCst);
            self.release_notify.notify_waiters();
        }

        async fn wait_until_released(&self) {
            loop {
                let notified = self.release_notify.notified();
                if self.release.load(Ordering::SeqCst) {
                    return;
                }
                notified.await;
            }
        }
    }

    #[async_trait]
    impl CreateRollbackCleanup for BlockingRemoveDirCleanup {
        async fn destroy_cow_device(&self, _cow_device: PooledNbdCowDevice) -> bool {
            panic!("test cleanup should not receive a real COW device");
        }

        async fn release_network(&self, network: &mut Option<NetnsLease>) {
            let network = network.take().expect("test network lease");
            self.record(format!("release_network:{}", network.name()));
            let _ = network.into_info_for_test();
        }

        async fn remove_dir(&self, kind: &'static str, path: PathBuf) {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("<unknown>");
            self.record(format!("remove_dir:{kind}:{name}"));
            self.entered.fetch_add(1, Ordering::SeqCst);
            self.entered_notify.notify_waiters();

            self.wait_until_released().await;

            let _ = tokio::fs::remove_dir_all(path).await;
            self.removed.fetch_add(1, Ordering::SeqCst);
            self.removed_notify.notify_waiters();
        }

        fn destroy_slot(&self, slot: crate::cow_pool::PrewarmedSlot) {
            self.record(format!("destroy_slot:{}", slot.id));
            crate::cow_pool::destroy_slot(slot);
        }
    }

    #[async_trait]
    impl CreateRollbackCleanup for FailingNetworkReleaseCleanup {
        async fn destroy_cow_device(&self, _cow_device: PooledNbdCowDevice) -> bool {
            panic!("test cleanup should not receive a real COW device");
        }

        async fn release_network(&self, network: &mut Option<NetnsLease>) {
            self.record(format!(
                "release_network:{}",
                network.as_ref().expect("test network lease").name()
            ));
        }

        async fn remove_dir(&self, kind: &'static str, path: PathBuf) {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("<unknown>");
            self.record(format!("remove_dir:{kind}:{name}"));
        }

        fn destroy_slot(&self, slot: crate::cow_pool::PrewarmedSlot) {
            self.record(format!("destroy_slot:{}", slot.id));
            crate::cow_pool::destroy_slot(slot);
        }
    }

    #[async_trait]
    impl CreateRollbackCleanup for RecordingCreateRollbackCleanup {
        async fn destroy_cow_device(&self, _cow_device: PooledNbdCowDevice) -> bool {
            panic!("test cleanup should not receive a real COW device");
        }

        async fn release_network(&self, network: &mut Option<NetnsLease>) {
            let network = network.take().expect("test network lease");
            self.record(format!("release_network:{}", network.name()));
            let _ = network.into_info_for_test();
        }

        async fn remove_dir(&self, kind: &'static str, path: PathBuf) {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("<unknown>");
            self.record(format!("remove_dir:{kind}:{name}"));
            let _ = tokio::fs::remove_dir_all(path).await;
        }

        fn destroy_slot(&self, slot: crate::cow_pool::PrewarmedSlot) {
            self.record(format!("destroy_slot:{}", slot.id));
            crate::cow_pool::destroy_slot(slot);
        }
    }

    fn test_slot(id: &str, workspace: PathBuf) -> crate::cow_pool::PrewarmedSlot {
        crate::cow_pool::PrewarmedSlot {
            id: id.into(),
            workspace,
            drop_notify: None,
        }
    }

    fn test_leaked_resource(sandbox_id: &str) -> LeakedResources {
        LeakedResources {
            sandbox_id: sandbox_id.into(),
            cow_device: None,
            network: None,
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
            delete_workspace: true,
        }
    }

    #[tokio::test]
    async fn create_transaction_rollback_before_rename_destroys_slot_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let slot_workspace = tmp.path().join("slot-workspace");
        tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
        tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
            .await
            .unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.track_slot(test_slot("slot", slot_workspace.clone()));
        let cleanup = RecordingCreateRollbackCleanup::default();

        tx.rollback(&cleanup).await;

        assert!(!slot_workspace.exists());
        assert_eq!(cleanup.events(), vec!["destroy_slot:slot"]);
    }

    #[tokio::test]
    async fn create_transaction_rollback_after_rename_removes_target_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let slot_workspace = tmp.path().join("slot-workspace");
        let target_workspace = tmp.path().join("sandbox-workspace");
        tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
        tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
            .await
            .unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.track_slot(test_slot("slot", slot_workspace.clone()));
        let tracked_slot_workspace = tx.slot_workspace().unwrap();
        tokio::fs::rename(&tracked_slot_workspace, &target_workspace)
            .await
            .unwrap();
        tx.slot_renamed_to(target_workspace.clone());
        let cleanup = RecordingCreateRollbackCleanup::default();

        tx.rollback(&cleanup).await;

        assert!(!slot_workspace.exists());
        assert!(!target_workspace.exists());
        assert_eq!(
            cleanup.events(),
            vec!["remove_dir:workspace:sandbox-workspace"]
        );
    }

    #[tokio::test]
    async fn create_transaction_rollback_after_sock_dir_removes_sock_then_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(sock_dir.join("vsock"))
            .await
            .unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        let cleanup = RecordingCreateRollbackCleanup::default();

        tx.rollback(&cleanup).await;

        assert!(!workspace.exists());
        assert!(!sock_dir.exists());
        assert_eq!(
            cleanup.events(),
            vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
        );
    }

    #[tokio::test]
    async fn create_transaction_rollback_releases_network_before_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());
        let cleanup = RecordingCreateRollbackCleanup::default();

        tx.rollback(&cleanup).await;

        assert!(!workspace.exists());
        assert!(!sock_dir.exists());
        assert_eq!(
            cleanup.events(),
            vec![
                "release_network:test-ns",
                "remove_dir:sock:sock",
                "remove_dir:workspace:workspace"
            ]
        );
    }

    #[tokio::test]
    async fn create_transaction_rollback_keeps_dirs_when_network_release_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());
        let cleanup = FailingNetworkReleaseCleanup::default();

        tx.rollback(&cleanup).await;

        assert!(workspace.exists());
        assert!(sock_dir.exists());
        assert_eq!(cleanup.events(), vec!["release_network:test-ns"]);

        drop(tx);
        let mut leaked = leak_rx.recv().await.unwrap();
        let network = leaked.network.take().unwrap();
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();
        assert_eq!(leaked.sock_dir, sock_dir);
        assert_eq!(leaked.workspace, workspace);
    }

    #[tokio::test]
    async fn create_transaction_commit_disarms_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());

        let resources = tx.commit_without_cow_for_test().unwrap();
        drop(tx);

        assert_eq!(resources.sandbox_paths.workspace(), workspace.as_path());
        assert_eq!(resources.sock_paths.dir(), sock_dir.as_path());
        let network = resources.network;
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();
        assert!(workspace.exists());
        assert!(sock_dir.exists());
    }

    #[tokio::test]
    async fn create_transaction_drop_before_rename_destroys_slot_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let slot_workspace = tmp.path().join("slot-workspace");
        tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
        tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
            .await
            .unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.track_slot(test_slot("slot", slot_workspace.clone()));

        drop(tx);

        assert!(!slot_workspace.exists());
    }

    #[tokio::test]
    async fn create_transaction_drop_without_async_resources_removes_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());

        drop(tx);

        assert!(!workspace.exists());
        assert!(!sock_dir.exists());
    }

    #[tokio::test]
    async fn create_transaction_drop_with_closed_leak_channel_falls_back_to_sync_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        let (leak_tx, leak_rx) = tokio::sync::mpsc::unbounded_channel();
        drop(leak_rx);

        let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());

        assert!(!tx.send_async_leaked_resources());
        let network = tx.network.take().unwrap();
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();

        drop(tx);

        assert!(!workspace.exists());
        assert!(!sock_dir.exists());
    }

    #[tokio::test]
    async fn create_transaction_drop_sync_fallback_respects_workspace_preservation() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.delete_workspace_on_leak_cleanup = false;

        drop(tx);

        assert!(workspace.exists());
        assert!(!sock_dir.exists());
    }

    #[tokio::test]
    async fn create_transaction_drop_does_not_drop_queued_leak_cleanup_work() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
        leak_tx.send(test_leaked_resource("queued")).unwrap();

        let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());

        drop(tx);

        let queued = leak_rx.recv().await.unwrap();
        assert_eq!(queued.sandbox_id, "queued");
        assert!(queued.network.is_none());
        let mut leaked = leak_rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "sandbox");
        let network = leaked.network.take().unwrap();
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();
        assert_eq!(leaked.sock_dir, sock_dir);
        assert_eq!(leaked.workspace, workspace);
    }

    #[tokio::test]
    async fn create_transaction_drop_sends_async_resources_to_leak_cleaner() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();

        let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());

        drop(tx);

        let mut leaked = leak_rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "sandbox");
        assert!(leaked.cow_device.is_none());
        let network = leaked.network.take().unwrap();
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();
        assert_eq!(leaked.sock_dir, sock_dir);
        assert_eq!(leaked.workspace, workspace);
    }

    #[tokio::test]
    async fn create_transaction_rollback_continues_after_waiter_abort() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let mut tx = SandboxCreateTransaction::new("sandbox".into());
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());

        let cleanup = BlockingRemoveDirCleanup::default();
        let cleanup_group = Arc::new(FactoryCleanupGroup::new());
        let rollback_group = Arc::clone(&cleanup_group);
        let rollback_cleanup = cleanup.clone();
        let waiter = tokio::spawn(async move {
            rollback_create_transaction(tx, rollback_cleanup, &rollback_group).await;
        });

        tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered(1))
            .await
            .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());

        let shutdown_group = Arc::clone(&cleanup_group);
        let shutdown_task = tokio::spawn(async move {
            shutdown_group.shutdown().await;
        });
        tokio::task::yield_now().await;
        assert!(!shutdown_task.is_finished());

        cleanup.release();
        tokio::time::timeout(std::time::Duration::from_secs(1), shutdown_task)
            .await
            .unwrap()
            .unwrap();
        cleanup.wait_removed(2).await;

        assert!(!sock_dir.exists());
        assert!(!workspace.exists());
        assert_eq!(
            cleanup.events(),
            vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
        );
    }
}
