use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use crate::factory::cleanup_group::FactoryCleanupGroup;

struct SandboxCreateResourcesWithoutCow {
    sandbox_paths: SandboxPaths,
    sock_paths: SockPaths,
    network: NetnsLease,
}

impl SandboxCreateTransaction {
    fn new(id: String) -> Self {
        Self::new_with_leak_tx(id, None)
    }

    fn track_workspace_for_test(&mut self, workspace: PathBuf) -> sandbox::Result<()> {
        if !matches!(self.workspace, WorkspaceOwnership::None) {
            return Err(create_transaction_invalid_state(&format!(
                "cannot track workspace while workspace state is {}",
                self.workspace.state_name()
            )));
        }
        self.workspace = WorkspaceOwnership::Workspace(workspace);
        Ok(())
    }

    fn commit_without_cow_for_test(&mut self) -> sandbox::Result<SandboxCreateResourcesWithoutCow> {
        self.validate_base_resources("test commit")?;
        let (workspace, sock_dir, network) = self.take_base_resources_after_validation()?;

        Ok(SandboxCreateResourcesWithoutCow {
            sandbox_paths: SandboxPaths::new(workspace),
            sock_paths: SockPaths::new(sock_dir),
            network,
        })
    }
}

fn test_network() -> NetnsLease {
    NetnsLease::new_for_test("test-ns")
}

struct RollbackTaskDropSignal(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for RollbackTaskDropSignal {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
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

    fn record_filesystem_cleanup_step(&self, step: &CreateRollbackFilesystemCleanupStep) {
        match step {
            CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path } => {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("<unknown>");
                self.record(format!("remove_dir:{kind}:{name}"));
            }
            CreateRollbackFilesystemCleanupStep::DestroySlot(slot) => {
                self.record(format!("destroy_slot:{}", slot.id()));
            }
        }
    }

    fn run_filesystem_cleanup_step(&self, step: CreateRollbackFilesystemCleanupStep) {
        match step {
            CreateRollbackFilesystemCleanupStep::RemoveDir { path, .. } => {
                let _ = std::fs::remove_dir_all(path);
            }
            CreateRollbackFilesystemCleanupStep::DestroySlot(slot) => {
                crate::cow_pool::destroy_slot_sync(slot);
            }
        }
        self.removed.fetch_add(1, Ordering::SeqCst);
        self.removed_notify.notify_waiters();
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
    async fn destroy_cow_device(&self, _cow_device: PooledNbdCowDevice) -> CowCleanupOutcome {
        panic!("test cleanup should not receive a real COW device");
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let network = network.take().expect("test network lease");
        self.record(format!("release_network:{}", network.name()));
        let _ = network.into_info_for_test();
    }

    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        let runner = self.clone();
        let task = tokio::spawn(async move {
            let step_count = cleanup.steps.len();
            for step in &cleanup.steps {
                runner.record_filesystem_cleanup_step(step);
            }
            runner.entered.fetch_add(step_count, Ordering::SeqCst);
            runner.entered_notify.notify_waiters();

            runner.wait_until_released().await;

            for step in cleanup.steps {
                runner.run_filesystem_cleanup_step(step);
            }
        });
        CreateRollbackFilesystemCleanupWaiter::new(async move {
            let _ = task.await;
        })
    }
}

#[async_trait]
impl CreateRollbackCleanup for FailingNetworkReleaseCleanup {
    async fn destroy_cow_device(&self, _cow_device: PooledNbdCowDevice) -> CowCleanupOutcome {
        panic!("test cleanup should not receive a real COW device");
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        self.record(format!(
            "release_network:{}",
            network.as_ref().expect("test network lease").name()
        ));
    }

    fn start_filesystem_cleanup(
        &self,
        _cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        panic!("network release failure should keep filesystem cleanup in transaction");
    }
}

#[async_trait]
impl CreateRollbackCleanup for RecordingCreateRollbackCleanup {
    async fn destroy_cow_device(&self, _cow_device: PooledNbdCowDevice) -> CowCleanupOutcome {
        panic!("test cleanup should not receive a real COW device");
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let network = network.take().expect("test network lease");
        self.record(format!("release_network:{}", network.name()));
        let _ = network.into_info_for_test();
    }

    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        for step in cleanup.steps {
            match step {
                CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path } => {
                    let name = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("<unknown>");
                    self.record(format!("remove_dir:{kind}:{name}"));
                    remove_create_rollback_dir_sync("sandbox", kind, path);
                }
                CreateRollbackFilesystemCleanupStep::DestroySlot(slot) => {
                    self.record(format!("destroy_slot:{}", slot.id()));
                    crate::cow_pool::destroy_slot_sync(slot);
                }
            }
        }
        CreateRollbackFilesystemCleanupWaiter::ready()
    }
}

fn test_slot(id: &str, workspace: PathBuf) -> crate::cow_pool::PrewarmedSlot {
    crate::cow_pool::PrewarmedSlot::new(id.into(), workspace)
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
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!slot_workspace.exists());
    assert_eq!(cleanup.events(), vec!["destroy_slot:slot"]);
}

#[tokio::test]
async fn create_transaction_rollback_before_rename_waits_for_slot_teardown() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let cleanup = BlockingRemoveDirCleanup::default();
    let rollback_cleanup = cleanup.clone();
    let rollback = tokio::spawn(async move {
        let mut tx = tx;
        tx.rollback(&rollback_cleanup).await;
    });

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered(1))
        .await
        .unwrap();
    assert!(slot_workspace.exists());
    assert!(!rollback.is_finished());

    cleanup.release();
    rollback.await.unwrap();
    cleanup.wait_removed(1).await;

    assert!(!slot_workspace.exists());
    assert_eq!(cleanup.events(), vec!["destroy_slot:slot"]);
}

#[tokio::test]
async fn create_transaction_rollback_during_rename_removes_slot_source() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let tracked_slot_workspace = tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    assert_eq!(tracked_slot_workspace, slot_workspace);
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!slot_workspace.exists());
    assert!(!target_workspace.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "remove_dir:workspace:sandbox-workspace",
            "destroy_slot:slot"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_during_rename_removes_target_after_move() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let tracked_slot_workspace = tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    tokio::fs::rename(&tracked_slot_workspace, &target_workspace)
        .await
        .unwrap();
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!slot_workspace.exists());
    assert!(!target_workspace.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "remove_dir:workspace:sandbox-workspace",
            "destroy_slot:slot"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_after_rename_error_preserves_target() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();
    tokio::fs::create_dir_all(&target_workspace).await.unwrap();
    tokio::fs::write(target_workspace.join("owner.txt"), b"other")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    tx.abort_workspace_rename_after_error().unwrap();
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!slot_workspace.exists());
    assert!(target_workspace.join("owner.txt").exists());
    assert_eq!(cleanup.events(), vec!["destroy_slot:slot"]);
}

#[tokio::test]
async fn create_transaction_drop_after_rename_error_preserves_target() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();
    tokio::fs::create_dir_all(&target_workspace).await.unwrap();
    tokio::fs::write(target_workspace.join("owner.txt"), b"other")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    tx.abort_workspace_rename_after_error().unwrap();

    drop(tx);

    assert!(!slot_workspace.exists());
    assert!(target_workspace.join("owner.txt").exists());
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
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let tracked_slot_workspace = tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    tokio::fs::rename(&tracked_slot_workspace, &target_workspace)
        .await
        .unwrap();
    tx.finish_workspace_rename().unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
async fn create_transaction_rollback_missing_dirs_are_best_effort() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("missing-workspace");
    let sock_dir = tmp.path().join("missing-sock");

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_workspace_for_test(workspace.clone()).unwrap();
    tx.track_sock_dir(sock_dir.clone());
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!workspace.exists());
    assert!(!sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "remove_dir:sock:missing-sock",
            "remove_dir:workspace:missing-workspace"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_remove_dir_error_is_best_effort() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let sock_file = tmp.path().join("sock-file");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::write(&sock_file, b"not a dir").await.unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_workspace_for_test(workspace.clone()).unwrap();
    tx.track_sock_dir(sock_file.clone());
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(sock_file.exists());
    assert!(!workspace.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "remove_dir:sock:sock-file",
            "remove_dir:workspace:workspace"
        ]
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();

    drop(tx);

    assert!(!slot_workspace.exists());
}

#[tokio::test]
async fn create_transaction_drop_during_rename_removes_slot_source() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let tracked_slot_workspace = tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    assert_eq!(tracked_slot_workspace, slot_workspace);

    drop(tx);

    assert!(!slot_workspace.exists());
    assert!(!target_workspace.exists());
}

#[tokio::test]
async fn create_transaction_drop_during_rename_removes_target_after_move() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();
    tokio::fs::write(slot_workspace.join("cow.img"), b"cow")
        .await
        .unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    let tracked_slot_workspace = tx.begin_workspace_rename(target_workspace.clone()).unwrap();
    tokio::fs::rename(&tracked_slot_workspace, &target_workspace)
        .await
        .unwrap();

    drop(tx);

    assert!(!slot_workspace.exists());
    assert!(!target_workspace.exists());
}

#[tokio::test]
async fn create_transaction_commit_rejects_pending_workspace_rename() {
    let tmp = tempfile::tempdir().unwrap();
    let slot_workspace = tmp.path().join("slot-workspace");
    let target_workspace = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(&slot_workspace).await.unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_slot(test_slot("slot", slot_workspace.clone()))
        .unwrap();
    tx.begin_workspace_rename(target_workspace.clone()).unwrap();

    assert!(tx.commit_without_cow_for_test().is_err());

    drop(tx);
    assert!(!slot_workspace.exists());
    assert!(!target_workspace.exists());
}

#[tokio::test]
async fn create_transaction_drop_without_async_resources_removes_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let sock_dir = tmp.path().join("sock");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::create_dir_all(&sock_dir).await.unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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
    tx.track_workspace_for_test(workspace.clone()).unwrap();
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

#[tokio::test]
async fn create_transaction_rollback_filesystem_cleanup_survives_task_abort() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let sock_dir = tmp.path().join("sock");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::create_dir_all(&sock_dir).await.unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_workspace_for_test(workspace.clone()).unwrap();
    tx.track_sock_dir(sock_dir.clone());

    let cleanup = BlockingRemoveDirCleanup::default();
    let cleanup_group = FactoryCleanupGroup::new();
    let rollback_cleanup = cleanup.clone();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
    let rollback_waiter =
        cleanup_group.spawn(FactoryCleanupTaskKind::Rollback, "sandbox", async move {
            let _drop_signal = RollbackTaskDropSignal(Some(dropped_tx));
            let mut tx = tx;
            tx.rollback(&rollback_cleanup).await;
        });
    drop(rollback_waiter);

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered(2))
        .await
        .unwrap();
    assert!(workspace.exists());
    assert!(sock_dir.exists());

    drop(cleanup_group);
    tokio::time::timeout(std::time::Duration::from_secs(1), dropped_rx)
        .await
        .unwrap()
        .unwrap();

    assert!(workspace.exists());
    assert!(sock_dir.exists());

    cleanup.release();
    cleanup.wait_removed(2).await;

    assert!(!workspace.exists());
    assert!(!sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
    );
}
