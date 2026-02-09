use async_trait::async_trait;
use sandbox::{Sandbox, SandboxConfig, SandboxError, SandboxFactory};
use tracing::{info, warn};

use crate::config::FirecrackerConfig;
use crate::network::{NetnsPool, NetnsPoolConfig};
use crate::overlay::{
    Ext4Creator, OverlayCreator, OverlayPool, OverlayPoolConfig, SnapshotCopyCreator,
};
use crate::paths::{FactoryPaths, SandboxPaths};
use crate::sandbox::FirecrackerSandbox;

pub struct FirecrackerFactory {
    config: FirecrackerConfig,
    paths: FactoryPaths,
    netns_pool: tokio::sync::Mutex<NetnsPool>,
    overlay_pool: tokio::sync::Mutex<OverlayPool>,
}

impl FirecrackerFactory {
    /// Create a new factory, pre-warming the network namespace and overlay pools.
    pub async fn new(config: FirecrackerConfig) -> Result<Self, SandboxError> {
        crate::prerequisites::check_prerequisites(&config)?;

        let concurrency = config.concurrency.max(1);
        let paths = FactoryPaths::new(config.base_dir.clone());

        let mut netns_pool = NetnsPool::create(NetnsPoolConfig {
            index: config.instance_index,
            size: concurrency,
            proxy_port: config.proxy_port,
        })
        .await
        .map_err(|e| SandboxError::CreationFailed(format!("netns pool: {e}")))?;

        let overlay_creator: Box<dyn OverlayCreator> = match &config.snapshot {
            Some(snapshot) => Box::new(SnapshotCopyCreator::new(snapshot.overlay_path.clone())),
            None => Box::new(Ext4Creator),
        };

        let overlay_pool = match OverlayPool::create(OverlayPoolConfig {
            size: concurrency,
            replenish_threshold: (concurrency / 2).max(1),
            pool_dir: paths.overlays(),
            creator: overlay_creator,
        })
        .await
        {
            Ok(pool) => pool,
            Err(e) => {
                if let Err(cleanup_err) = netns_pool.cleanup().await {
                    warn!(error = %cleanup_err, "failed to cleanup netns pool during rollback");
                }
                return Err(SandboxError::CreationFailed(format!("overlay pool: {e}")));
            }
        };

        let mode = if config.snapshot.is_some() {
            "snapshot"
        } else {
            "fresh"
        };
        info!(concurrency, mode, "factory initialized");

        Ok(Self {
            config,
            paths,
            netns_pool: tokio::sync::Mutex::new(netns_pool),
            overlay_pool: tokio::sync::Mutex::new(overlay_pool),
        })
    }

    /// Clean up all factory-level resources (pools).
    pub async fn cleanup(&self) {
        let mut netns_pool = self.netns_pool.lock().await;
        if let Err(e) = netns_pool.cleanup().await {
            warn!(error = %e, "failed to cleanup netns pool");
        }
        drop(netns_pool);

        let mut overlay_pool = self.overlay_pool.lock().await;
        overlay_pool.cleanup().await;
        drop(overlay_pool);

        info!("factory cleanup complete");
    }
}

#[async_trait]
impl SandboxFactory for FirecrackerFactory {
    fn name(&self) -> &str {
        "firecracker"
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        let id = config.id.to_string();
        let sandbox_paths = SandboxPaths::new(self.paths.workspace(&id));

        // Create workspace and vsock subdirectory.
        tokio::fs::create_dir_all(sandbox_paths.vsock_dir())
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("mkdir workspace: {e}")))?;

        // Acquire a network namespace from the pool.
        let network = self
            .netns_pool
            .lock()
            .await
            .acquire()
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("acquire netns: {e}")))?;

        // Acquire an overlay file from the pool.
        let overlay = match self.overlay_pool.lock().await.acquire().await {
            Ok(overlay) => overlay,
            Err(e) => {
                // Roll back: return netns to pool before propagating error.
                let mut netns_pool = self.netns_pool.lock().await;
                if let Err(rel_err) = netns_pool.release(network).await {
                    warn!(error = %rel_err, "failed to release netns during rollback");
                }
                return Err(SandboxError::CreationFailed(format!(
                    "acquire overlay: {e}"
                )));
            }
        };

        info!(id = %id, "sandbox created");

        let sandbox =
            FirecrackerSandbox::new(config, self.config.clone(), sandbox_paths, network, overlay);

        Ok(Box::new(sandbox))
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        let mut sandbox = match (sandbox as Box<dyn std::any::Any>).downcast::<FirecrackerSandbox>()
        {
            Ok(s) => *s,
            Err(_) => {
                warn!("destroy called with non-firecracker sandbox, ignoring");
                return;
            }
        };

        // Ensure the sandbox is killed before releasing pool resources.
        let _ = sandbox.kill().await;

        let sandbox_id = sandbox.id;

        // Return the network namespace to the pool.
        let mut netns_pool = self.netns_pool.lock().await;
        if let Err(e) = netns_pool.release(sandbox.network).await {
            warn!(id = %sandbox_id, error = %e, "failed to release netns");
        }
        drop(netns_pool);

        // Delete the overlay file.
        let mut overlay_pool = self.overlay_pool.lock().await;
        overlay_pool.release(sandbox.overlay).await;
        drop(overlay_pool);

        // Delete the workspace directory.
        if let Err(e) = tokio::fs::remove_dir_all(sandbox.paths.workspace()).await {
            warn!(id = %sandbox_id, error = %e, "failed to delete workspace");
        }

        info!(id = %sandbox_id, "sandbox destroyed");
    }
}
