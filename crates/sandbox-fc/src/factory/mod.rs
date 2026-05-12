mod cleanup_group;
mod cow_cleanup;
mod create_transaction;
mod invariant;
mod leak_cleaner;

use async_trait::async_trait;
use sandbox::{
    Sandbox, SandboxConfig, SandboxError, SandboxFactory, SandboxInitializationPhase,
    SandboxInvalidStateContext,
};
use tracing::{info, warn};

use crate::config::FirecrackerConfig;
use crate::factory::cleanup_group::{FactoryCleanupGroup, FactoryCleanupTaskKind};
use crate::factory::cow_cleanup::destroy_cow_device_with_retries;
use crate::factory::create_transaction::{
    FactoryCreateRollbackCleanup, SandboxCreateResources, SandboxCreateTransaction,
    rollback_create_transaction,
};
use crate::factory::leak_cleaner::LeakCleaner;
use crate::network::{NetnsPoolConfig, NetnsPoolHandle};
use crate::paths::{FactoryPaths, RuntimePaths, SockPaths};
use crate::prerequisites;
use crate::sandbox::FirecrackerSandbox;

pub(crate) use cow_cleanup::cow_destroy_retry_policy;
pub(crate) use invariant::InvariantConfig;
pub use invariant::{PREWARM_SCRIPT, config_hash};

pub struct FirecrackerFactory {
    config: FirecrackerConfig,
    factory_paths: FactoryPaths,
    runtime_paths: RuntimePaths,
    netns_pool: Option<NetnsPoolHandle>,
    owns_netns_pool: bool,
    /// Shared NBD device pool for pre-validated device indices.
    device_pool: nbd_cow::pool::DevicePoolHandle,
    /// Base image path and size (bytes), populated during startup.
    base_image_path: Option<std::path::PathBuf>,
    base_image_size: u64,
    /// Pre-warming pool for COW files.
    cow_pool: Option<tokio::sync::Mutex<crate::cow_pool::CowPool>>,
    started: bool,
    cleanup_group: FactoryCleanupGroup,
    /// Owns the channel/task that drains leaked sandbox resources from Drop.
    leak_cleaner: Option<LeakCleaner>,
}

impl FirecrackerFactory {
    /// Create a new factory without allocating system resources.
    /// Call `startup()` to initialize pools before use.
    ///
    /// When `netns_pool` is provided, the factory shares it instead of
    /// creating a new one in `startup()` (used for multi-profile runners).
    pub async fn new(
        config: FirecrackerConfig,
        netns_pool: Option<NetnsPoolHandle>,
        device_pool: nbd_cow::pool::DevicePoolHandle,
    ) -> Result<Self, SandboxError> {
        let t = std::time::Instant::now();
        let mode = match config.snapshot.as_ref() {
            Some(snapshot) => prerequisites::PrerequisiteMode::FactorySnapshotRestore { snapshot },
            None => prerequisites::PrerequisiteMode::FactoryFresh,
        };
        prerequisites::check_prerequisites(&prerequisites::PrerequisiteConfig {
            binary_path: &config.binary_path,
            kernel_path: &config.kernel_path,
            rootfs_path: &config.rootfs_path,
            mode,
        })
        .await?;
        info!(
            elapsed_ms = t.elapsed().as_millis() as u64,
            "prerequisites checked"
        );

        let factory_paths = FactoryPaths::new(config.base_dir.clone());
        let runtime_paths = RuntimePaths::new();
        let owns_netns_pool = netns_pool.is_none();

        Ok(Self {
            config,
            factory_paths,
            runtime_paths,
            netns_pool,
            owns_netns_pool,
            device_pool,
            base_image_path: None,
            base_image_size: 0,
            cow_pool: None,
            started: false,
            cleanup_group: FactoryCleanupGroup::new(),
            leak_cleaner: None,
        })
    }

    /// Whether this factory uses snapshot restore (vs fresh boot).
    pub fn has_snapshot(&self) -> bool {
        self.config.snapshot.is_some()
    }

    /// # Panics
    /// Panics if called before `startup()` — this is a programming error.
    #[allow(clippy::expect_used)]
    fn netns_pool(&self) -> &NetnsPoolHandle {
        self.netns_pool.as_ref().expect("factory not started")
    }

    /// # Panics
    /// Panics if called before `startup()` — this is a programming error.
    #[allow(clippy::expect_used)]
    fn cow_pool(&self) -> &tokio::sync::Mutex<crate::cow_pool::CowPool> {
        self.cow_pool.as_ref().expect("factory not started")
    }
}

#[async_trait]
impl SandboxFactory for FirecrackerFactory {
    fn name(&self) -> &str {
        "firecracker"
    }

    fn config_hash(&self) -> String {
        config_hash()
    }

    async fn startup(&mut self) -> sandbox::Result<()> {
        if self.started {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Factory,
                state: "started".into(),
                message: "factory already started".into(),
            });
        }
        self.cleanup_group.start_accepting();

        // Create netns pool only if not provided externally (shared pool case).
        if self.netns_pool.is_none() {
            self.owns_netns_pool = true;
            let t = std::time::Instant::now();
            let netns_config = NetnsPoolConfig {
                proxy_port: self.config.proxy_port,
                dns_port: self.config.dns_port,
            }
            .into_checked()?;
            let netns_pool = NetnsPoolHandle::create_checked(netns_config)
                .await
                .map_err(|e| SandboxError::Initialization {
                    phase: SandboxInitializationPhase::Factory,
                    message: format!("netns pool: {e}"),
                })?;
            info!(
                elapsed_ms = t.elapsed().as_millis() as u64,
                "netns pool created"
            );
            self.netns_pool = Some(netns_pool);
        }

        // Determine base image size from file metadata.
        let rootfs = &self.config.rootfs_path;
        let base_size = tokio::fs::metadata(rootfs)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::Factory,
                message: format!("base image metadata: {e}"),
            })?
            .len();

        info!(
            rootfs = %rootfs.display(),
            base_size,
            "base image size determined"
        );

        self.base_image_path = Some(rootfs.clone());
        self.base_image_size = base_size;

        // Initialize COW pool with base image info.
        let cow_pool_config = crate::cow_pool::CowPoolConfig {
            workspaces_dir: self.factory_paths.workspaces(),
            base_size,
            golden_cow: self.config.snapshot.as_ref().map(|s| s.cow_path.clone()),
        };
        let mut cow_pool = crate::cow_pool::CowPool::new(cow_pool_config);
        cow_pool.warmup().await;
        self.cow_pool = Some(tokio::sync::Mutex::new(cow_pool));

        // Spawn background task to clean up resources leaked by sandbox Drop
        // impls that fire without going through factory.destroy().
        self.leak_cleaner = Some(LeakCleaner::spawn(self.netns_pool().clone()));

        self.started = true;

        let mode = if self.config.snapshot.is_some() {
            "snapshot"
        } else {
            "fresh"
        };
        info!(mode, "factory started");

        Ok(())
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        if !self.started {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Factory,
                state: "not started".into(),
                message: "factory not started".into(),
            });
        }

        let id = config.id.to_string();
        let rollback_cleanup = FactoryCreateRollbackCleanup {
            id: id.clone(),
            netns_pool: self.netns_pool().clone(),
        };
        let mut tx = SandboxCreateTransaction::new_with_leak_tx(
            id.clone(),
            self.leak_cleaner.as_ref().and_then(LeakCleaner::sender),
        );

        let create_result: sandbox::Result<SandboxCreateResources> =
            async {
                // Acquire a pre-warmed COW slot from the pool.
                // The slot provides: workspace dir (already created) and cow file.
                let slot = self.cow_pool().lock().await.acquire().await.map_err(|e| {
                    SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("acquire COW slot: {e}"),
                    }
                })?;
                tx.track_slot(slot);

                // The slot workspace is {workspaces_dir}/{slot_uuid}/.
                // Rename to {workspaces_dir}/{sandbox_id}/ for doctor correlation.
                let target_workspace = self.factory_paths.workspace(&id);
                if target_workspace.exists()
                    && let Err(e) = tokio::fs::remove_dir_all(&target_workspace).await
                {
                    warn!(id = %id, error = %e, "failed to clean stale workspace dir");
                }
                let slot_workspace = tx.slot_workspace()?;
                if let Err(e) = tokio::fs::rename(&slot_workspace, &target_workspace).await {
                    return Err(SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("rename workspace: {e}"),
                    });
                }
                tx.slot_renamed_to(target_workspace.clone());

                // Recompute cow_file path after rename (the slot path no longer exists).
                let cow_file = target_workspace.join("cow.img");

                // Clean stale sock dir and create vsock directory.
                let sock_paths = SockPaths::new(self.runtime_paths.sock_dir(&id));
                if sock_paths.dir().exists()
                    && let Err(e) = tokio::fs::remove_dir_all(sock_paths.dir()).await
                {
                    warn!(id = %id, error = %e, "failed to clean stale sock dir");
                }
                tx.track_sock_dir(sock_paths.dir().to_owned());
                if let Err(e) = tokio::fs::create_dir_all(sock_paths.vsock_dir()).await {
                    return Err(SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("mkdir vsock dir: {e}"),
                    });
                }

                // Acquire a network namespace from the pool.
                let network = self.netns_pool().acquire().await.map_err(|e| {
                    SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("acquire netns: {e}"),
                    }
                })?;
                tx.track_network(network);

                // Create NBD COW device (~15ms via netlink, no subprocess).
                let base_image =
                    self.base_image_path
                        .as_ref()
                        .ok_or_else(|| SandboxError::InvalidState {
                            context: SandboxInvalidStateContext::Factory,
                            state: "started without base image".into(),
                            message: "factory base image path missing".into(),
                        })?;
                let cow_device = self
                    .device_pool
                    .create_cow_device(base_image, &cow_file, self.base_image_size)
                    .await
                    .map_err(|e| SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("create NBD COW device: {e}"),
                    })?;
                tx.track_cow_device(cow_device);

                tx.commit()
            }
            .await;

        let resources = match create_result {
            Ok(resources) => resources,
            Err(e) => {
                rollback_create_transaction(tx, rollback_cleanup, &self.cleanup_group).await;
                return Err(e);
            }
        };
        let SandboxCreateResources {
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
        } = resources;

        info!(id = %id, device = %cow_device.device_path().display(), "sandbox created");

        let sandbox = FirecrackerSandbox::new(
            config,
            self.config.clone(),
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
            self.leak_cleaner.as_ref().and_then(LeakCleaner::sender),
        );

        Ok(Box::new(sandbox))
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        let sandbox = match (sandbox as Box<dyn std::any::Any>).downcast::<FirecrackerSandbox>() {
            Ok(s) => *s,
            Err(_) => {
                warn!("destroy called with non-firecracker sandbox, ignoring");
                return;
            }
        };
        let netns_pool = self.netns_pool().clone();
        let sandbox_id = sandbox.id.clone();

        // Move all cleanup-owned resources into a task before the first await.
        // If the caller drops this destroy future mid-cleanup, the task keeps
        // running instead of letting FirecrackerSandbox::Drop race the COW
        // finalizer and directory cleanup.
        let waiter = self.cleanup_group.spawn(
            FactoryCleanupTaskKind::Destroy,
            sandbox_id,
            destroy_firecracker_sandbox(sandbox, netns_pool),
        );
        waiter.wait_propagating_panic().await;
    }

    async fn shutdown(&mut self) {
        self.cleanup_group.shutdown().await;

        // Close the leak channel and let the drain task finish queued cleanup
        // before we unwrap the shared pool Arcs below.
        if let Some(cleaner) = self.leak_cleaner.take() {
            cleaner.shutdown().await;
        }

        // Clean up COW pool (delete pre-warmed COW files).
        if let Some(pool_mutex) = self.cow_pool.take() {
            let mut pool = pool_mutex.into_inner();
            pool.cleanup().await;
        }

        self.base_image_path = None;

        // Direct factories own their netns pool and must clean it up even when
        // detached destroy tasks still hold Arc clones. Shared runtime pools are
        // cleaned up by FirecrackerRuntime::shutdown().
        if self.owns_netns_pool
            && let Some(netns_pool) = self.netns_pool.take()
            && let Err(e) = netns_pool.cleanup().await
        {
            warn!(error = %e, "failed to cleanup owned netns pool");
        }

        self.started = false;
        info!("factory shutdown complete");
    }
}

async fn destroy_firecracker_sandbox(mut sandbox: FirecrackerSandbox, netns_pool: NetnsPoolHandle) {
    // Ensure the sandbox is killed before releasing pool resources.
    // After kill(), `sandbox.process` is `None`, so the Drop impl's
    // killpg becomes a no-op when `sandbox` is dropped below.
    let _ = sandbox.kill().await;

    // Clone lightweight handles before dropping sandbox.
    let sandbox_id = sandbox.id.clone();
    let sock_dir = sandbox.sock_paths.dir().to_owned();
    let workspace = sandbox.sandbox_paths.workspace().to_owned();

    // Log NBD COW stats before teardown for performance debugging.
    if let Some(cow_device) = sandbox.cow_device.as_ref() {
        cow_device.log_status().await;
    }

    // Destroy the NBD COW device (flushes data, disconnects, removes COW file).
    //
    // After kill_process_group + child.wait(), the kernel may still be
    // releasing file descriptors (particularly the NBD device fd).
    // Retry a few times to let it finish.
    let cow_destroyed = match sandbox.cow_device.take() {
        Some(cow_device) => {
            // If shutdown aborts this task while the COW finalizer is running,
            // Drop-based leak cleanup must not delete the backing workspace.
            sandbox.preserve_workspace_on_leak_cleanup();
            let cow_destroyed = destroy_cow_device_with_retries(&sandbox_id, cow_device).await;
            if cow_destroyed {
                sandbox.allow_workspace_delete_on_leak_cleanup();
            }
            cow_destroyed
        }
        None => true,
    };

    // Return the network namespace to the pool.
    let outcome = netns_pool.release(sandbox.network.lease_mut()).await;
    if let Some(message) = outcome.invalid_message() {
        warn!(id = %sandbox_id, error = %message, "failed to release netns");
    }

    // Delete the socket directory.
    if let Err(e) = tokio::fs::remove_dir_all(&sock_dir).await {
        warn!(id = %sandbox_id, error = %e, "failed to delete sock dir");
    }

    // Delete the workspace directory only if the COW device was fully torn
    // down.  When destroy() failed, the NBD device may still reference
    // the COW file — keep the workspace intact for debugging.
    if cow_destroyed && let Err(e) = tokio::fs::remove_dir_all(&workspace).await {
        warn!(id = %sandbox_id, error = %e, "failed to delete workspace");
    }

    // Mark as destroyed only after all explicit cleanup steps complete.
    // Until this point, `FirecrackerSandbox::Drop` remains armed as a
    // panic fallback and sends pool resources to the leak-cleanup task.
    if !sandbox.network.has_lease() {
        sandbox.destroyed = true;
    }
    drop(sandbox);

    info!(id = %sandbox_id, "sandbox destroyed");
}

impl Drop for FirecrackerFactory {
    fn drop(&mut self) {
        // Safety net for abnormal paths (e.g. panic before shutdown()).
        self.leak_cleaner.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::factory::leak_cleaner::LeakCleaner;
    use crate::leaked_resources::LeakedResources;
    use crate::network::NetnsPool;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn shutdown_cleans_owned_netns_pool_with_extra_arc_refs() {
        let pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());
        let _destroy_task_clone = pool.clone();
        let mut factory = test_factory(true);
        factory.netns_pool = Some(pool);
        factory.owns_netns_pool = true;

        factory.shutdown().await;

        assert!(factory.netns_pool.is_none());
    }

    #[tokio::test]
    async fn shutdown_keeps_shared_netns_pool_for_runtime_shutdown() {
        let pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());
        let mut factory = test_factory(true);
        factory.netns_pool = Some(pool.clone());
        factory.owns_netns_pool = false;

        factory.shutdown().await;

        assert!(factory.netns_pool.is_some());
        assert_eq!(
            factory.netns_pool.as_ref().unwrap().strong_count_for_test(),
            2
        );
    }

    fn test_config(base_dir: PathBuf) -> FirecrackerConfig {
        FirecrackerConfig {
            binary_path: PathBuf::from("/tmp/firecracker"),
            kernel_path: PathBuf::from("/tmp/vmlinux"),
            rootfs_path: PathBuf::from("/tmp/rootfs.ext4"),
            base_dir,
            profile: "vm0/default".into(),
            proxy_port: None,
            dns_port: None,
            snapshot: None,
        }
    }

    fn test_factory(started: bool) -> FirecrackerFactory {
        FirecrackerFactory {
            config: test_config(PathBuf::from("/tmp/factory-test-base")),
            factory_paths: FactoryPaths::new(PathBuf::from("/tmp/factory-test")),
            runtime_paths: RuntimePaths::new(),
            netns_pool: None,
            owns_netns_pool: true,
            device_pool: nbd_cow::pool::DevicePoolHandle::new(
                nbd_cow::pool::DevicePoolConfig::default(),
            ),
            base_image_path: None,
            base_image_size: 0,
            cow_pool: None,
            started,
            cleanup_group: FactoryCleanupGroup::new(),
            leak_cleaner: None,
        }
    }

    fn assert_factory_invalid_state(
        err: SandboxError,
        expected_state: &str,
        expected_message: &str,
    ) {
        match err {
            SandboxError::InvalidState {
                context,
                state,
                message,
            } => {
                assert_eq!(context, SandboxInvalidStateContext::Factory);
                assert_eq!(state, expected_state);
                assert_eq!(message, expected_message);
            }
            other => panic!("expected factory invalid-state error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn startup_rejects_already_started_factory() {
        let mut factory = test_factory(true);

        let err = factory.startup().await.unwrap_err();

        assert_factory_invalid_state(err, "started", "factory already started");
    }

    #[tokio::test]
    async fn create_rejects_not_started_factory() {
        let factory = test_factory(false);
        let config = sandbox::SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 1,
                memory_mb: 512,
            },
        };

        let err = match factory.create(config).await {
            Ok(_) => panic!("create should fail before startup"),
            Err(err) => err,
        };

        assert_factory_invalid_state(err, "not started", "factory not started");
    }

    #[tokio::test]
    async fn factory_shutdown_drains_cleanup_group_before_leak_cleaner() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let cleanup_events = Arc::clone(&events);
        let leak_events = Arc::clone(&events);
        let mut factory = test_factory(true);

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = shutdown_rx.await;
            leak_events.lock().unwrap().push("leak_cleaner");
        });
        factory.leak_cleaner = Some(LeakCleaner::from_parts_for_test(tx, shutdown_tx, handle));

        let waiter =
            factory
                .cleanup_group
                .spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
                    cleanup_events.lock().unwrap().push("cleanup_group");
                });
        drop(waiter);

        factory.shutdown().await;

        assert_eq!(
            *events.lock().unwrap(),
            vec!["cleanup_group", "leak_cleaner"]
        );
    }
}
