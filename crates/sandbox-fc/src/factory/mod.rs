mod cleanup_group;
mod cow_cleanup;
mod create_transaction;
mod invariant;
mod leak_cleaner;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use sandbox::{
    Sandbox, SandboxConfig, SandboxError, SandboxFactory, SandboxInitializationPhase,
    SandboxInvalidStateContext,
};
use tracing::{info, warn};

use crate::config::{FirecrackerConfig, FirecrackerDeviceRateLimits};
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
use crate::sandbox::{FirecrackerSandbox, FirecrackerSandboxInit};

pub(crate) use cow_cleanup::cow_destroy_retry_policy;
pub(crate) use invariant::InvariantConfig;
pub use invariant::{PREWARM_SCRIPT, config_hash};

pub(crate) struct FirecrackerFactory {
    config: FirecrackerConfig,
    factory_paths: FactoryPaths,
    runtime_paths: RuntimePaths,
    /// Shared NBD device pool for pre-validated device indices.
    device_pool: nbd_cow::pool::DevicePoolHandle,
    cleanup_group: FactoryCleanupGroup,
    resources: Option<StartedFactoryResources>,
    /// Best-effort release authority for sandboxes destroyed after shutdown.
    shutdown_netns_pool: Option<NetnsPoolHandle>,
}

struct StartedFactoryResources {
    netns_pool: NetnsPoolHandle,
    netns_ownership: NetnsPoolOwnership,
    base_image: BaseImageInfo,
    /// Bounded producer for one-shot COW slots.
    cow_pool: crate::cow_pool::CowPoolHandle,
    /// Owns the channel/task that drains leaked sandbox resources from Drop.
    leak_cleaner: LeakCleaner,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NetnsPoolOwnership {
    Owned,
    Shared,
}

struct BaseImageInfo {
    path: PathBuf,
    size: u64,
}

impl FirecrackerFactory {
    /// Create a fully initialized factory.
    ///
    /// When `netns_pool` is provided, the factory shares it instead of
    /// creating a new one (used for multi-profile runners).
    pub(crate) async fn start(
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
        let (netns_pool, netns_ownership) = match netns_pool {
            Some(netns_pool) => (netns_pool, NetnsPoolOwnership::Shared),
            None => {
                let t = std::time::Instant::now();
                let netns_config = NetnsPoolConfig {
                    proxy_port: config.proxy_port,
                    dns_port: config.dns_port,
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
                (netns_pool, NetnsPoolOwnership::Owned)
            }
        };

        let rootfs = config.rootfs_path.clone();
        let base_size = match tokio::fs::metadata(&rootfs).await {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                if netns_ownership == NetnsPoolOwnership::Owned
                    && let Err(cleanup_error) = netns_pool.cleanup().await
                {
                    warn!(
                        error = %cleanup_error,
                        "failed to cleanup owned netns pool after factory initialization failure"
                    );
                }
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::Factory,
                    message: format!("base image metadata: {error}"),
                });
            }
        };

        info!(
            rootfs = %rootfs.display(),
            base_size,
            "base image size determined"
        );

        let cow_pool_config = crate::cow_pool::CowPoolConfig {
            workspaces_dir: factory_paths.workspaces(),
            base_size,
            golden_cow: config.snapshot.as_ref().map(|s| s.cow_path.clone()),
        };
        let cow_pool = crate::cow_pool::CowPoolHandle::new(cow_pool_config);
        cow_pool.warmup().await;

        let leak_cleaner = LeakCleaner::spawn(netns_pool.clone());
        let cleanup_group = FactoryCleanupGroup::new();
        cleanup_group.start_accepting();

        let mode = if config.snapshot.is_some() {
            "snapshot"
        } else {
            "fresh"
        };
        info!(mode, "factory started");

        Ok(Self {
            config,
            factory_paths,
            runtime_paths,
            device_pool,
            cleanup_group,
            resources: Some(StartedFactoryResources {
                netns_pool,
                netns_ownership,
                base_image: BaseImageInfo {
                    path: rootfs,
                    size: base_size,
                },
                cow_pool,
                leak_cleaner,
            }),
            shutdown_netns_pool: None,
        })
    }

    fn resources(&self) -> sandbox::Result<&StartedFactoryResources> {
        self.resources
            .as_ref()
            .ok_or_else(|| SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Factory,
                state: "shutdown".into(),
                message: "factory shut down".into(),
            })
    }

    fn netns_pool_for_destroy(&self, sandbox_id: &str) -> Option<NetnsPoolHandle> {
        match self.resources.as_ref() {
            Some(resources) => Some(resources.netns_pool.clone()),
            None => match self.shutdown_netns_pool.clone() {
                Some(netns_pool) => {
                    warn!(
                        id = %sandbox_id,
                        "destroy called after factory shutdown; running best-effort cleanup"
                    );
                    Some(netns_pool)
                }
                None => {
                    warn!(id = %sandbox_id, "destroy called after factory shutdown");
                    None
                }
            },
        }
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

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        let resources = self.resources()?;
        let device_rate_limits = convert_device_rate_limits(config.device_rate_limits.as_ref())?;
        let leak_tx = resources.leak_cleaner.sender();
        let id = config.id.to_string();
        let rollback_cleanup = FactoryCreateRollbackCleanup {
            id: id.clone(),
            netns_pool: resources.netns_pool.clone(),
        };
        let mut tx = SandboxCreateTransaction::new_with_leak_tx(id.clone(), leak_tx.clone());

        let create_result: sandbox::Result<SandboxCreateResources> =
            async {
                // Acquire a pre-warmed COW slot from the pool.
                // The slot provides: workspace dir (already created) and cow file.
                let slot = resources.cow_pool.acquire().await.map_err(|e| {
                    SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("acquire COW slot: {e}"),
                    }
                })?;
                tx.track_slot(slot)?;

                // The slot workspace is {workspaces_dir}/{slot_uuid}/.
                // Rename to {workspaces_dir}/{sandbox_id}/ for doctor correlation.
                let target_workspace = self.factory_paths.workspace(&id);
                clean_stale_workspace_dir(&id, &target_workspace)?;
                let slot_workspace = tx.begin_workspace_rename(target_workspace.clone())?;
                // Keep rename cancellation-safe: tokio::fs::rename may keep
                // running on the blocking pool after its future is dropped.
                if let Err(e) = std::fs::rename(&slot_workspace, &target_workspace) {
                    tx.abort_workspace_rename_after_error()?;
                    return Err(SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("rename workspace: {e}"),
                    });
                }
                tx.finish_workspace_rename()?;

                // Recompute cow_file path after rename (the slot path no longer exists).
                let cow_file = target_workspace.join("cow.img");

                // Clean stale sock dir and create vsock directory.
                let sock_paths = SockPaths::new(self.runtime_paths.sock_dir(&id));
                clean_stale_sock_dir(&id, sock_paths.dir())?;
                tx.track_sock_dir(sock_paths.dir().to_owned());
                if let Err(e) = tokio::fs::create_dir_all(sock_paths.vsock_dir()).await {
                    return Err(SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("mkdir vsock dir: {e}"),
                    });
                }

                // Acquire a network namespace from the pool.
                let network = resources.netns_pool.acquire().await.map_err(|e| {
                    SandboxError::Initialization {
                        phase: SandboxInitializationPhase::SandboxAllocation,
                        message: format!("acquire netns: {e}"),
                    }
                })?;
                tx.track_network(network);

                // Create NBD COW device (~15ms via netlink, no subprocess).
                let cow_device = self
                    .device_pool
                    .create_cow_device(
                        &resources.base_image.path,
                        &cow_file,
                        resources.base_image.size,
                    )
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

        let sandbox = FirecrackerSandbox::new(FirecrackerSandboxInit {
            config,
            factory_config: self.config.clone(),
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
            device_rate_limits,
            leak_tx,
        });

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
        let Some(netns_pool) = self.netns_pool_for_destroy(&sandbox.id) else {
            return;
        };
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

        let Some(resources) = self.resources.take() else {
            info!("factory shutdown complete");
            return;
        };
        let StartedFactoryResources {
            netns_pool,
            netns_ownership,
            cow_pool,
            leak_cleaner,
            ..
        } = resources;
        self.shutdown_netns_pool = Some(netns_pool.clone());

        // Close the leak channel and let the drain task finish queued cleanup
        // before we unwrap the shared pool Arcs below.
        leak_cleaner.shutdown().await;

        // Clean up COW pool (delete pre-warmed COW files).
        cow_pool.cleanup().await;

        // Direct factories own their netns pool and must clean it up even when
        // detached destroy tasks still hold Arc clones. Shared runtime pools are
        // cleaned up by FirecrackerRuntime::shutdown().
        if netns_ownership == NetnsPoolOwnership::Owned
            && let Err(e) = netns_pool.cleanup().await
        {
            warn!(error = %e, "failed to cleanup owned netns pool");
        }

        info!("factory shutdown complete");
    }
}

fn convert_device_rate_limits(
    limits: Option<&sandbox::DeviceRateLimits>,
) -> sandbox::Result<Option<FirecrackerDeviceRateLimits>> {
    limits
        .map(FirecrackerDeviceRateLimits::try_from)
        .transpose()
        .map_err(|message| SandboxError::Configuration {
            message: format!("device_rate_limits: {message}"),
        })
}

fn clean_stale_workspace_dir(id: &str, target_workspace: &Path) -> sandbox::Result<()> {
    clean_stale_create_dir(id, "target workspace", target_workspace)
}

fn clean_stale_sock_dir(id: &str, sock_dir: &Path) -> sandbox::Result<()> {
    clean_stale_create_dir(id, "sock dir", sock_dir)
}

fn clean_stale_create_dir(id: &str, kind: &'static str, path: &Path) -> sandbox::Result<()> {
    // Keep cleanup cancellation-safe for same-id retries. tokio::fs deletion
    // can keep running on the blocking pool after its future is dropped.
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("clean stale {kind} {} for {id}: {e}", path.display()),
        }),
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
        self.resources.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::factory::leak_cleaner::LeakCleaner;
    use crate::leaked_resources::LeakedResources;
    use crate::network::{NetnsLease, NetnsPool};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn shutdown_cleans_owned_netns_pool_with_extra_arc_refs() {
        let (pool, mut lease) = test_pool_with_lease("owned-test-ns");
        let _destroy_task_clone = pool.clone();
        let mut factory = test_factory_with_resources(
            pool.clone(),
            NetnsPoolOwnership::Owned,
            test_leak_cleaner(),
        );

        factory.shutdown().await;

        assert!(factory.resources.is_none());
        let retained = factory
            .shutdown_netns_pool
            .as_ref()
            .expect("shutdown factory should retain netns release authority");
        let _ = retained.release(&mut lease).await;
        assert!(lease.is_none());
    }

    #[tokio::test]
    async fn shutdown_keeps_shared_netns_pool_for_runtime_shutdown() {
        let (pool, mut lease) = test_pool_with_lease("shared-test-ns");
        let mut factory = test_factory_with_resources(
            pool.clone(),
            NetnsPoolOwnership::Shared,
            test_leak_cleaner(),
        );

        factory.shutdown().await;

        assert!(factory.resources.is_none());
        assert!(factory.shutdown_netns_pool.is_some());
        let _ = pool.release(&mut lease).await;
        assert!(lease.is_none());
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

    fn test_factory_without_resources() -> FirecrackerFactory {
        FirecrackerFactory {
            config: test_config(PathBuf::from("/tmp/factory-test-base")),
            factory_paths: FactoryPaths::new(PathBuf::from("/tmp/factory-test")),
            runtime_paths: RuntimePaths::new(),
            device_pool: nbd_cow::pool::DevicePoolHandle::new(
                nbd_cow::pool::DevicePoolConfig::default(),
            ),
            cleanup_group: FactoryCleanupGroup::new(),
            resources: None,
            shutdown_netns_pool: None,
        }
    }

    fn test_pool_with_lease(name: &str) -> (NetnsPoolHandle, Option<NetnsLease>) {
        let mut raw_pool = NetnsPool::inactive_for_test();
        let lease = Some(raw_pool.lease_for_test(name));
        raw_pool.track_lease_for_test(lease.as_ref().unwrap());
        (NetnsPoolHandle::new_for_test(raw_pool), lease)
    }

    fn test_factory_with_resources(
        netns_pool: NetnsPoolHandle,
        netns_ownership: NetnsPoolOwnership,
        leak_cleaner: LeakCleaner,
    ) -> FirecrackerFactory {
        let factory_paths = FactoryPaths::new(PathBuf::from("/tmp/factory-test"));
        let cow_pool = crate::cow_pool::CowPoolHandle::new(crate::cow_pool::CowPoolConfig {
            workspaces_dir: factory_paths.workspaces(),
            base_size: 0,
            golden_cow: None,
        });
        let cleanup_group = FactoryCleanupGroup::new();
        cleanup_group.start_accepting();
        FirecrackerFactory {
            config: test_config(PathBuf::from("/tmp/factory-test-base")),
            factory_paths,
            runtime_paths: RuntimePaths::new(),
            device_pool: nbd_cow::pool::DevicePoolHandle::new(
                nbd_cow::pool::DevicePoolConfig::default(),
            ),
            cleanup_group,
            resources: Some(StartedFactoryResources {
                netns_pool,
                netns_ownership,
                base_image: BaseImageInfo {
                    path: PathBuf::from("/tmp/rootfs.ext4"),
                    size: 0,
                },
                cow_pool,
                leak_cleaner,
            }),
            shutdown_netns_pool: None,
        }
    }

    fn test_leak_cleaner() -> LeakCleaner {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = shutdown_rx.await;
        });
        LeakCleaner::from_parts_for_test(tx, shutdown_tx, handle)
    }

    fn assert_factory_invalid_state(err: SandboxError, expected_state: &str) {
        match err {
            SandboxError::InvalidState {
                context,
                state,
                message: _,
            } => {
                assert_eq!(context, SandboxInvalidStateContext::Factory);
                assert_eq!(state, expected_state);
            }
            other => panic!("expected factory invalid-state error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn clean_stale_workspace_dir_allows_absent_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("sandbox-workspace");

        clean_stale_workspace_dir("sandbox", &target).unwrap();

        assert!(!target.exists());
    }

    #[tokio::test]
    async fn clean_stale_workspace_dir_removes_existing_target_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("sandbox-workspace");
        tokio::fs::create_dir_all(target.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(target.join("nested").join("stale.txt"), b"stale")
            .await
            .unwrap();

        clean_stale_workspace_dir("sandbox", &target).unwrap();

        assert!(!target.exists());
    }

    #[tokio::test]
    async fn clean_stale_workspace_dir_errors_for_unclaimed_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("sandbox-workspace");
        tokio::fs::write(&target, b"not a directory").await.unwrap();

        let err = clean_stale_workspace_dir("sandbox", &target).unwrap_err();

        match err {
            SandboxError::Initialization { phase, message } => {
                assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
                assert!(message.contains("clean stale target workspace"));
            }
            other => panic!("expected initialization error, got {other:?}"),
        }
        assert!(target.exists());
    }

    #[tokio::test]
    async fn clean_stale_sock_dir_removes_existing_target_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("sandbox-sock");
        tokio::fs::create_dir_all(target.join("vsock"))
            .await
            .unwrap();
        tokio::fs::write(target.join("vsock").join("stale.sock"), b"stale")
            .await
            .unwrap();

        clean_stale_sock_dir("sandbox", &target).unwrap();

        assert!(!target.exists());
    }

    #[tokio::test]
    async fn create_rejects_shutdown_factory() {
        let factory = test_factory_without_resources();
        let config = sandbox::SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 1,
                memory_mb: 512,
            },
            device_rate_limits: None,
        };

        let err = match factory.create(config).await {
            Ok(_) => panic!("create should fail without factory resources"),
            Err(err) => err,
        };

        assert_factory_invalid_state(err, "shutdown");
    }

    #[tokio::test]
    async fn destroy_without_resources_or_retained_pool_has_no_release_authority() {
        let factory = test_factory_without_resources();

        assert!(factory.netns_pool_for_destroy("sandbox").is_none());
    }

    #[tokio::test]
    async fn create_rejects_factory_after_shutdown_even_with_retained_destroy_pool() {
        let mut factory = test_factory_with_resources(
            NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
            NetnsPoolOwnership::Shared,
            test_leak_cleaner(),
        );
        factory.shutdown().await;

        let config = sandbox::SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 1,
                memory_mb: 512,
            },
            device_rate_limits: None,
        };
        let err = match factory.create(config).await {
            Ok(_) => panic!("create should fail after shutdown"),
            Err(err) => err,
        };

        assert_factory_invalid_state(err, "shutdown");
    }

    #[tokio::test]
    async fn shutdown_is_idempotent_after_resources_are_taken() {
        let mut factory = test_factory_with_resources(
            NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
            NetnsPoolOwnership::Shared,
            test_leak_cleaner(),
        );

        factory.shutdown().await;
        factory.shutdown().await;

        assert!(factory.resources.is_none());
        assert!(factory.shutdown_netns_pool.is_some());
    }

    #[tokio::test]
    async fn destroy_uses_retained_netns_pool_after_shutdown() {
        let (pool, mut lease) = test_pool_with_lease("test-ns");
        let mut factory = test_factory_with_resources(
            pool.clone(),
            NetnsPoolOwnership::Shared,
            test_leak_cleaner(),
        );
        factory.shutdown().await;

        let selected = factory
            .netns_pool_for_destroy("sandbox")
            .expect("shutdown factory should retain destroy netns pool");

        let _ = selected.release(&mut lease).await;

        assert!(lease.is_none());
    }

    #[tokio::test]
    async fn factory_shutdown_drains_cleanup_group_before_leak_cleaner() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let cleanup_events = Arc::clone(&events);
        let leak_events = Arc::clone(&events);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = shutdown_rx.await;
            leak_events.lock().unwrap().push("leak_cleaner");
        });
        let mut factory = test_factory_with_resources(
            NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
            NetnsPoolOwnership::Owned,
            LeakCleaner::from_parts_for_test(tx, shutdown_tx, handle),
        );

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
