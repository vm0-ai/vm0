use async_trait::async_trait;
use tracing::{info, warn};

use sandbox::{
    FactoryConfig, RuntimeProvider, SandboxError, SandboxFactory, SandboxInitializationPhase,
    SandboxRuntime, SnapshotRef,
};

use nbd_cow::pool::{DevicePoolConfig, DevicePoolHandle};

use crate::config::{FirecrackerConfig, SnapshotConfig};
use crate::factory::FirecrackerFactory;
use crate::network::{NetnsPoolConfig, NetnsPoolHandle};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};

/// Firecracker-backed sandbox runtime.
///
/// Manages shared network namespace and device pools, then creates
/// sandbox factories that share those resources.
pub struct FirecrackerRuntime {
    netns_pool: NetnsPoolHandle,
    device_pool: DevicePoolHandle,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
}

impl FirecrackerRuntime {
    /// Create a new runtime with shared resources.
    ///
    /// This allocates a network namespace pool and an empty base loop cache.
    /// All factories created via [`SandboxRuntime::create_factory`] share these
    /// resources.
    pub async fn new(config: sandbox::RuntimeConfig) -> Result<Self, SandboxError> {
        let t = std::time::Instant::now();
        let netns_config = NetnsPoolConfig {
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
        }
        .into_checked()?;
        let netns_pool = NetnsPoolHandle::create_checked(netns_config)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::Runtime,
                message: format!("netns pool: {e}"),
            })?;
        info!(
            elapsed_ms = t.elapsed().as_millis() as u64,
            "runtime netns pool created"
        );

        let t = std::time::Instant::now();
        let device_pool = DevicePoolHandle::new(DevicePoolConfig::default());
        info!(
            elapsed_ms = t.elapsed().as_millis() as u64,
            "runtime device pool created"
        );

        Ok(Self {
            netns_pool,
            device_pool,
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
        })
    }

    fn to_firecracker_config(&self, config: FactoryConfig) -> FirecrackerConfig {
        let snapshot = config.snapshot.map(|s| Self::resolve_snapshot(&s));
        FirecrackerConfig {
            binary_path: config.binary_path,
            kernel_path: config.kernel_path,
            rootfs_path: config.rootfs_path,
            base_dir: config.base_dir,
            profile: config.profile,
            proxy_port: self.proxy_port,
            dns_port: self.dns_port,
            snapshot,
        }
    }

    fn resolve_snapshot(snapshot_ref: &SnapshotRef) -> SnapshotConfig {
        let output = SnapshotOutputPaths::new(snapshot_ref.output_dir.clone());
        let work = SandboxPaths::new(output.work_dir());
        let runtime = RuntimePaths::new();
        let sock = SockPaths::new(runtime.sock_dir(&snapshot_ref.hash));
        SnapshotConfig {
            snapshot_path: output.snapshot(),
            memory_path: output.memory(),
            cow_path: output.cow(),
            drive_bind_path: work.cow_device_bind(),
            vsock_bind_dir: sock.vsock_dir(),
        }
    }
}

#[async_trait]
impl SandboxRuntime for FirecrackerRuntime {
    async fn create_factory(
        &self,
        config: FactoryConfig,
    ) -> sandbox::Result<Box<dyn SandboxFactory>> {
        let fc_config = self.to_firecracker_config(config);
        let mut factory = FirecrackerFactory::new(
            fc_config,
            Some(self.netns_pool.clone()),
            self.device_pool.clone(),
        )
        .await?;
        factory.startup().await?;
        Ok(Box::new(factory))
    }

    async fn shutdown(&mut self) {
        // Clean up shared netns pool.
        if let Err(e) = self.netns_pool.cleanup().await {
            warn!(error = %e, "failed to cleanup shared netns pool");
        }

        // Clean up shared device pool.
        self.device_pool.cleanup().await;

        info!("runtime shutdown complete");
    }
}

/// Factory for creating [`FirecrackerRuntime`] instances.
pub struct FirecrackerRuntimeProvider;

#[async_trait]
impl RuntimeProvider for FirecrackerRuntimeProvider {
    async fn create_runtime(
        &self,
        config: sandbox::RuntimeConfig,
    ) -> sandbox::Result<Box<dyn SandboxRuntime>> {
        Ok(Box::new(FirecrackerRuntime::new(config).await?))
    }
}
