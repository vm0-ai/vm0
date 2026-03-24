use async_trait::async_trait;
use sandbox::{Sandbox, SandboxConfig, SandboxError, SandboxFactory};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use block_cow::{CowDevice, CowDeviceConfig};

use crate::config::FirecrackerConfig;
use crate::network::{GUEST_NETWORK, NetnsPool, NetnsPoolConfig, generate_boot_args};
use crate::paths::{FactoryPaths, RuntimePaths, SandboxPaths, SockPaths};
use crate::prerequisites;
use crate::sandbox::FirecrackerSandbox;

/// Shell command executed during snapshot creation to pre-warm guest state.
/// Changing this invalidates all cached snapshots (included in [`config_hash`]).
///
/// **Note:** Do NOT wrap this in `su - user -c '...'` — the vsock-guest exec
/// handler already wraps commands with `su - user -c` in release builds.
/// Double-wrapping creates nested sessions where inner processes escape the
/// process group, surviving SIGKILL on timeout as orphans frozen into the
/// snapshot.
///
/// - `claude --print --verbose --output-format stream-json hi`:
///   exercises the full CLI initialization path matching the real guest-agent
///   invocation (module loading, config parsing, API client setup) so all
///   relevant memory pages are captured in the snapshot. Fails with
///   "Invalid API key" but still loads the complete module graph. The claude
///   binary is a Bun-compiled executable (not Node.js), so
///   `NODE_COMPILE_CACHE` has no effect.
pub const PREWARM_SCRIPT: &str = "\
    (claude --print --verbose --output-format stream-json hi 2>/dev/null || true)";

/// Balloon device configuration (invariant across all sandboxes).
#[derive(serde::Serialize)]
pub struct BalloonConfig {
    pub amount_mib: u32,
    pub deflate_on_oom: bool,
    pub stats_polling_interval_s: u32,
}

/// Invariant configuration shared by all sandboxes.
///
/// These parameters affect snapshot output and are used by:
/// - [`config_hash`] — deterministic fingerprint for snapshot cache invalidation
/// - [`super::sandbox::FirecrackerSandbox::build_config`] — fresh boot JSON configuration
/// - Snapshot creation API calls in `snapshot.rs`
///
/// Adding a field here automatically changes the config hash (via `Serialize`)
/// and makes it available to all consumers.
///
/// **Important:** `serde_json` serializes struct fields in declaration order.
/// Reordering fields changes the hash and invalidates all cached snapshots.
#[derive(serde::Serialize)]
pub struct InvariantConfig {
    pub boot_args: String,
    pub guest_mac: &'static str,
    pub tap_name: &'static str,
    /// TAP MAC used in netns setup for ARP. Not in the Firecracker config JSON,
    /// but affects snapshot behavior (guest ARP cache is baked into the snapshot).
    pub tap_mac: &'static str,
    pub iface_id: &'static str,
    pub guest_cid: u32,
    pub balloon: BalloonConfig,
    pub prewarm_script: &'static str,
}

impl InvariantConfig {
    pub fn new() -> Self {
        Self {
            boot_args: generate_boot_args(),
            guest_mac: GUEST_NETWORK.guest_mac,
            tap_name: GUEST_NETWORK.tap_name,
            tap_mac: GUEST_NETWORK.tap_mac,
            iface_id: "eth0",
            guest_cid: 3,
            balloon: BalloonConfig {
                amount_mib: 0,
                deflate_on_oom: true,
                stats_polling_interval_s: 5,
            },
            prewarm_script: PREWARM_SCRIPT,
        }
    }
}

/// SHA-256 fingerprint of all sandbox-fc internal configuration that affects
/// snapshot output.
///
/// Derived from [`InvariantConfig`] serialization — adding a field to that
/// struct automatically changes this hash.
///
/// This is the backing implementation for [`SandboxFactory::config_hash`].
/// It is also available as a free function so callers that don't have a
/// factory instance (e.g. the snapshot subcommand) can compute the hash.
/// # Panics
/// Cannot panic — `InvariantConfig` contains only primitives and `String`.
#[allow(clippy::expect_used)]
pub fn config_hash() -> String {
    let config = InvariantConfig::new();
    let json = serde_json::to_string(&config).expect("serialize invariant config");
    hex::encode(Sha256::digest(json.as_bytes()))
}

pub struct FirecrackerFactory {
    config: FirecrackerConfig,
    factory_paths: FactoryPaths,
    runtime_paths: RuntimePaths,
    netns_pool: Option<std::sync::Arc<tokio::sync::Mutex<NetnsPool>>>,
    started: bool,
}

impl FirecrackerFactory {
    /// Create a new factory without allocating system resources.
    /// Call `startup()` to initialize pools before use.
    ///
    /// When `netns_pool` is provided, the factory shares it instead of
    /// creating a new one in `startup()` (used for multi-profile runners).
    pub async fn new(
        config: FirecrackerConfig,
        netns_pool: Option<std::sync::Arc<tokio::sync::Mutex<NetnsPool>>>,
    ) -> Result<Self, SandboxError> {
        let t = std::time::Instant::now();
        prerequisites::check_prerequisites(&prerequisites::PrerequisiteConfig {
            binary_path: &config.binary_path,
            kernel_path: &config.kernel_path,
            rootfs_path: &config.rootfs_path,
            snapshot: config.snapshot.as_ref(),
        })
        .await?;
        info!(
            elapsed_ms = t.elapsed().as_millis() as u64,
            "prerequisites checked"
        );

        let factory_paths = FactoryPaths::new(config.base_dir.clone());
        let runtime_paths = RuntimePaths::new();

        Ok(Self {
            config,
            factory_paths,
            runtime_paths,
            netns_pool,
            started: false,
        })
    }

    /// Whether this factory uses snapshot restore (vs fresh boot).
    pub fn has_snapshot(&self) -> bool {
        self.config.snapshot.is_some()
    }

    /// # Panics
    /// Panics if called before `startup()` — this is a programming error.
    #[allow(clippy::expect_used)]
    fn netns_pool(&self) -> &std::sync::Arc<tokio::sync::Mutex<NetnsPool>> {
        self.netns_pool.as_ref().expect("factory not started")
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
            return Err(SandboxError::CreationFailed(
                "factory already started".into(),
            ));
        }

        // Create netns pool only if not provided externally (shared pool case).
        if self.netns_pool.is_none() {
            let t = std::time::Instant::now();
            let netns_pool = NetnsPool::create(NetnsPoolConfig {
                proxy_port: self.config.proxy_port,
            })
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("netns pool: {e}")))?;
            info!(
                elapsed_ms = t.elapsed().as_millis() as u64,
                "netns pool created"
            );
            self.netns_pool = Some(std::sync::Arc::new(tokio::sync::Mutex::new(netns_pool)));
        }

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
        let id = config.id.to_string();
        let sandbox_paths = SandboxPaths::new(self.factory_paths.workspace(&id));
        let sock_paths = SockPaths::new(self.runtime_paths.sock_dir(&id));

        // Clean stale directories from a previous crashed sandbox whose
        // destroy() failed (e.g., COW device still busy → workspace kept).
        if sandbox_paths.workspace().exists()
            && let Err(e) = tokio::fs::remove_dir_all(sandbox_paths.workspace()).await
        {
            warn!(id = %id, error = %e, "failed to clean stale workspace dir");
        }
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
            .acquire()
            .await
            .map_err(|e| SandboxError::CreationFailed(format!("acquire netns: {e}")))?;

        // Create a dm-snapshot COW device backed by the rootfs.
        // For snapshot restore, sparse-copy the golden COW file first.
        //
        // Failures must release the network namespace back to the pool
        // (netns has no Drop-based return), handled by the match below.
        let cow_config = CowDeviceConfig {
            base_image: self.config.rootfs_path.clone(),
            cow_dir: sandbox_paths.workspace().join("cow"),
            chunk_size: None,
        };
        // CowDevice::create/restore call synchronous subprocess commands
        // (losetup, dmsetup, blockdev). Use spawn_blocking to avoid stalling
        // the tokio runtime when multiple sandboxes are created concurrently.
        let cow_result = match &self.config.snapshot {
            Some(snapshot) => {
                let vm_cow = sandbox_paths.workspace().join("cow.img");
                let r = sparse_copy(&snapshot.cow_path, &vm_cow).await;
                match r {
                    Ok(()) => {
                        tokio::task::spawn_blocking(move || CowDevice::restore(&cow_config, vm_cow))
                            .await
                            .map_err(|e| SandboxError::CreationFailed(format!("join: {e}")))?
                            .map_err(|e| {
                                SandboxError::CreationFailed(format!("restore COW device: {e}"))
                            })
                    }
                    Err(e) => Err(e),
                }
            }
            None => tokio::task::spawn_blocking(move || CowDevice::create(&cow_config))
                .await
                .map_err(|e| SandboxError::CreationFailed(format!("join: {e}")))?
                .map_err(|e| SandboxError::CreationFailed(format!("create COW device: {e}"))),
        };

        let cow_device = match cow_result {
            Ok(d) => d,
            Err(e) => {
                // Roll back: return netns to pool and clean up directories.
                let mut netns_pool = self.netns_pool().lock().await;
                if let Err(rel_err) = netns_pool.release(network).await {
                    warn!(error = %rel_err, "failed to release netns during rollback");
                }
                let _ = tokio::fs::remove_dir_all(sandbox_paths.workspace()).await;
                let _ = tokio::fs::remove_dir_all(sock_paths.dir()).await;
                return Err(e);
            }
        };

        info!(id = %id, device = %cow_device.device_path().display(), "sandbox created");

        let sandbox = FirecrackerSandbox::new(
            config,
            self.config.clone(),
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
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
        // After kill(), `sandbox.process` is `None`, so the Drop impl's
        // killpg becomes a no-op when `sandbox` is dropped below.
        let _ = sandbox.kill().await;

        // Clone lightweight handles before dropping sandbox — Drop requires
        // all fields intact, so we cannot move them out.
        let sandbox_id = sandbox.id.clone();
        let network = sandbox.network.clone();
        let sock_dir = sandbox.sock_paths.dir().to_owned();
        let workspace = sandbox.sandbox_paths.workspace().to_owned();

        // Destroy the COW device (removes dm targets, detaches loops, deletes COW file).
        let cow_destroyed = sandbox.cow_device.destroy().is_ok();
        if !cow_destroyed {
            warn!(id = %sandbox_id, "failed to destroy COW device — skipping workspace cleanup (dm targets still reference files inside it)");
        }
        drop(sandbox);

        // Return the network namespace to the pool.
        let mut netns_pool = self.netns_pool().lock().await;
        if let Err(e) = netns_pool.release(network).await {
            warn!(id = %sandbox_id, error = %e, "failed to release netns");
        }
        drop(netns_pool);

        // Delete the socket directory.
        if let Err(e) = tokio::fs::remove_dir_all(&sock_dir).await {
            warn!(id = %sandbox_id, error = %e, "failed to delete sock dir");
        }

        // Delete the workspace directory only if the COW device was fully torn
        // down.  When destroy() failed, the dm-snapshot target still references
        // the COW file inside the workspace via a loop device — deleting the
        // workspace would remove the backing file from the directory tree while
        // the kernel still has it open (safe on Linux, but makes debugging and
        // GC harder).
        if cow_destroyed && let Err(e) = tokio::fs::remove_dir_all(&workspace).await {
            warn!(id = %sandbox_id, error = %e, "failed to delete workspace");
        }

        info!(id = %sandbox_id, "sandbox destroyed");
    }

    async fn shutdown(&mut self) {
        // Clean up netns pool only if we hold the last reference.
        // When shared across multiple factories, the caller manages cleanup.
        if let Some(Ok(mutex)) = self.netns_pool.take().map(std::sync::Arc::try_unwrap) {
            let mut pool = mutex.into_inner();
            if let Err(e) = pool.cleanup().await {
                warn!(error = %e, "failed to cleanup netns pool");
            }
        }

        self.started = false;
        info!("factory shutdown complete");
    }
}

/// Sparse-copy a file using `cp --sparse=always`.
async fn sparse_copy(src: &std::path::Path, dst: &std::path::Path) -> Result<(), SandboxError> {
    let output = tokio::process::Command::new("cp")
        .arg("--sparse=always")
        .arg(src)
        .arg(dst)
        .output()
        .await
        .map_err(|e| SandboxError::CreationFailed(format!("exec cp: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SandboxError::CreationFailed(format!(
            "cp --sparse=always failed: {stderr}"
        )));
    }
    Ok(())
}
