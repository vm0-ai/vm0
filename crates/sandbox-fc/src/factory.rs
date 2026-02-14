use async_trait::async_trait;
use sandbox::{Sandbox, SandboxConfig, SandboxError, SandboxFactory};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::config::FirecrackerConfig;
use crate::network::{GUEST_NETWORK, NetnsPool, NetnsPoolConfig, generate_boot_args};
use crate::overlay::{
    Ext4Creator, OverlayCreator, OverlayPool, OverlayPoolConfig, SnapshotCopyCreator,
};
use crate::paths::{FactoryPaths, RuntimePaths, SandboxPaths, SockPaths};
use crate::sandbox::FirecrackerSandbox;

/// Shell command executed during snapshot creation to pre-warm guest caches.
/// Changing this invalidates all cached snapshots (included in [`config_hash`]).
pub const PREWARM_SCRIPT: &str = "su - user -c true";

/// SHA-256 fingerprint of all sandbox-fc internal configuration that affects
/// snapshot output (boot args, guest network, pre-warm script, etc.).
///
/// This is the backing implementation for [`SandboxFactory::config_hash`].
/// It is also available as a free function so callers that don't have a
/// factory instance (e.g. the snapshot subcommand) can compute the hash.
pub fn config_hash() -> String {
    let boot_args = generate_boot_args();
    let mut hasher = Sha256::new();
    // boot_args already contains guest_ip, gateway_ip, netmask via
    // generate_guest_network_boot_args(). Only guest_mac and tap_name
    // need to be hashed separately (used by configure_network_interface).
    hasher.update(b"boot_args:");
    hasher.update(boot_args.as_bytes());
    hasher.update(b"guest_mac:");
    hasher.update(GUEST_NETWORK.guest_mac.as_bytes());
    hasher.update(b"tap_name:");
    hasher.update(GUEST_NETWORK.tap_name.as_bytes());
    hasher.update(b"prewarm:");
    hasher.update(PREWARM_SCRIPT.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub struct FirecrackerFactory {
    config: FirecrackerConfig,
    factory_paths: FactoryPaths,
    runtime_paths: RuntimePaths,
    netns_pool: Option<tokio::sync::Mutex<NetnsPool>>,
    overlay_pool: Option<tokio::sync::Mutex<OverlayPool>>,
}

impl FirecrackerFactory {
    /// Create a new factory without allocating system resources.
    /// Call `startup()` to initialize pools before use.
    pub async fn new(config: FirecrackerConfig) -> Result<Self, SandboxError> {
        crate::prerequisites::check_prerequisites(&crate::prerequisites::PrerequisiteConfig {
            binary_path: &config.binary_path,
            kernel_path: &config.kernel_path,
            rootfs_path: &config.rootfs_path,
            snapshot: config.snapshot.as_ref(),
        })
        .await?;

        let factory_paths = FactoryPaths::new(config.base_dir.clone());
        let runtime_paths = RuntimePaths::new();

        Ok(Self {
            config,
            factory_paths,
            runtime_paths,
            netns_pool: None,
            overlay_pool: None,
        })
    }

    /// # Panics
    /// Panics if called before `startup()` — this is a programming error.
    #[allow(clippy::expect_used)]
    fn netns_pool(&self) -> &tokio::sync::Mutex<NetnsPool> {
        self.netns_pool.as_ref().expect("factory not started")
    }

    /// # Panics
    /// Panics if called before `startup()` — this is a programming error.
    #[allow(clippy::expect_used)]
    fn overlay_pool(&self) -> &tokio::sync::Mutex<OverlayPool> {
        self.overlay_pool.as_ref().expect("factory not started")
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
        // Both pools are always set together, so checking one is sufficient.
        if self.netns_pool.is_some() {
            return Err(SandboxError::CreationFailed(
                "factory already started".into(),
            ));
        }

        let concurrency = self.config.concurrency.max(1);

        let mut netns_pool = NetnsPool::create(NetnsPoolConfig {
            size: concurrency,
            proxy_port: self.config.proxy_port,
        })
        .await
        .map_err(|e| SandboxError::CreationFailed(format!("netns pool: {e}")))?;

        let overlay_creator: Box<dyn OverlayCreator> = match &self.config.snapshot {
            Some(snapshot) => Box::new(SnapshotCopyCreator::new(snapshot.overlay_path.clone())),
            None => Box::new(Ext4Creator),
        };

        let overlay_pool = match OverlayPool::create(OverlayPoolConfig {
            size: concurrency,
            replenish_threshold: (concurrency / 2).max(1),
            pool_dir: self.factory_paths.overlays(),
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

        self.netns_pool = Some(tokio::sync::Mutex::new(netns_pool));
        self.overlay_pool = Some(tokio::sync::Mutex::new(overlay_pool));

        let mode = if self.config.snapshot.is_some() {
            "snapshot"
        } else {
            "fresh"
        };
        info!(concurrency, mode, "factory started");

        Ok(())
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        let id = config.id.to_string();
        let sandbox_paths = SandboxPaths::new(self.factory_paths.workspace(&id));
        let sock_paths = SockPaths::new(self.runtime_paths.sock_dir(&id));

        // Clean stale socket directory from a previous crashed sandbox.
        if sock_paths.dir().exists()
            && let Err(e) = tokio::fs::remove_dir_all(sock_paths.dir()).await
        {
            warn!(id = %id, error = %e, "failed to clean stale sock dir");
        }

        // Create workspace and socket directories.
        tokio::fs::create_dir_all(sandbox_paths.workspace())
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("mkdir workspace: {e}")))?;
        tokio::fs::create_dir_all(sock_paths.vsock_dir())
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("mkdir vsock dir: {e}")))?;

        // Acquire a network namespace from the pool.
        let network = self
            .netns_pool()
            .lock()
            .await
            .acquire(config.use_proxy)
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("acquire netns: {e}")))?;

        // Acquire an overlay file from the pool.
        let overlay = match self.overlay_pool().lock().await.acquire().await {
            Ok(overlay) => overlay,
            Err(e) => {
                // Roll back: return netns to pool before propagating error.
                let mut netns_pool = self.netns_pool().lock().await;
                if let Err(rel_err) = netns_pool.release(network, config.use_proxy).await {
                    warn!(error = %rel_err, "failed to release netns during rollback");
                }
                return Err(SandboxError::CreationFailed(format!(
                    "acquire overlay: {e}"
                )));
            }
        };

        info!(id = %id, "sandbox created");

        let sandbox = FirecrackerSandbox::new(
            config,
            self.config.clone(),
            sandbox_paths,
            sock_paths,
            network,
            overlay,
        );

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
        let mut netns_pool = self.netns_pool().lock().await;
        if let Err(e) = netns_pool
            .release(sandbox.network, sandbox.config.use_proxy)
            .await
        {
            warn!(id = %sandbox_id, error = %e, "failed to release netns");
        }
        drop(netns_pool);

        // Delete the overlay file.
        let mut overlay_pool = self.overlay_pool().lock().await;
        overlay_pool.release(sandbox.overlay).await;
        drop(overlay_pool);

        // Delete the socket directory.
        if let Err(e) = tokio::fs::remove_dir_all(sandbox.sock_paths.dir()).await {
            warn!(id = %sandbox_id, error = %e, "failed to delete sock dir");
        }

        // Delete the workspace directory.
        if let Err(e) = tokio::fs::remove_dir_all(sandbox.sandbox_paths.workspace()).await {
            warn!(id = %sandbox_id, error = %e, "failed to delete workspace");
        }

        info!(id = %sandbox_id, "sandbox destroyed");
    }

    async fn shutdown(&mut self) {
        if let Some(netns_pool) = self.netns_pool.take() {
            let mut pool = netns_pool.into_inner();
            if let Err(e) = pool.cleanup().await {
                warn!(error = %e, "failed to cleanup netns pool");
            }
        }

        if let Some(overlay_pool) = self.overlay_pool.take() {
            let mut pool = overlay_pool.into_inner();
            pool.cleanup().await;
        }

        info!("factory shutdown complete");
    }
}
