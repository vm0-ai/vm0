use std::path::PathBuf;

use async_trait::async_trait;
use sandbox::{
    Sandbox, SandboxConfig, SandboxError, SandboxFactory, SandboxInitializationPhase,
    SandboxInvalidStateContext,
};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use nbd_cow::NbdCowDevice;

use crate::config::FirecrackerConfig;
use crate::network::{GUEST_NETWORK, NetnsPool, NetnsPoolConfig, PooledNetns, generate_boot_args};
use crate::paths::{FactoryPaths, RuntimePaths, SandboxPaths, SockPaths};
use crate::prerequisites;
use crate::sandbox::FirecrackerSandbox;

/// Maximum attempts to destroy a COW device after killing Firecracker.
/// After kill_process_group + child.wait(), the kernel may still be
/// releasing file descriptors (particularly the NBD device fd).
pub(crate) const DESTROY_RETRIES: u32 = 5;

/// Delay between COW device destroy retries.
pub(crate) const DESTROY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// Channel capacity for leaked sandbox resource cleanup.
/// 32 is generous — the channel only receives messages when an executor task
/// panics after sandbox creation, which is an exceptional path.
const LEAK_CHANNEL_CAPACITY: usize = 32;

/// Resources that require async cleanup when a sandbox is dropped without
/// going through `factory.destroy()` (e.g. executor task panic).
///
/// The `FirecrackerSandbox::Drop` impl sends these to a cleanup channel
/// owned by the factory, which drains them asynchronously.
pub(crate) struct LeakedResources {
    pub(crate) sandbox_id: String,
    pub(crate) device_index: u32,
    pub(crate) network: PooledNetns,
    pub(crate) sock_dir: PathBuf,
    pub(crate) workspace: PathBuf,
}

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
    /// Drive layout identifier. Changing the number or type of drives
    /// requires a new snapshot — bump this constant to invalidate the
    /// config hash and force re-creation.
    pub drive_layout: &'static str,
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
            drive_layout: "nbd-cow-v1",
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
    /// Shared NBD device pool for pre-validated device indices.
    device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
    /// Base image path and size (bytes), populated during startup.
    base_image_path: Option<std::path::PathBuf>,
    base_image_size: u64,
    /// Pre-warming pool for COW files.
    cow_pool: Option<tokio::sync::Mutex<crate::cow_pool::CowPool>>,
    started: bool,
    /// Channel for receiving leaked sandbox resources from `Drop` impls.
    /// Created during `startup()`, cloned into each sandbox at `create()`.
    leak_tx: Option<tokio::sync::mpsc::Sender<LeakedResources>>,
    /// Background task that drains `leak_tx` and releases pool resources.
    leak_cleanup_handle: Option<tokio::task::JoinHandle<()>>,
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
        device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
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

        Ok(Self {
            config,
            factory_paths,
            runtime_paths,
            netns_pool,
            device_pool,
            base_image_path: None,
            base_image_size: 0,
            cow_pool: None,
            started: false,
            leak_tx: None,
            leak_cleanup_handle: None,
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

    /// # Panics
    /// Panics if called before `startup()` — this is a programming error.
    #[allow(clippy::expect_used)]
    fn cow_pool(&self) -> &tokio::sync::Mutex<crate::cow_pool::CowPool> {
        self.cow_pool.as_ref().expect("factory not started")
    }

    /// Background task that receives leaked sandbox resources from `Drop`
    /// impls and releases them asynchronously (pool indices, namespaces, dirs).
    async fn drain_leaked_resources(
        mut rx: tokio::sync::mpsc::Receiver<LeakedResources>,
        device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
        netns_pool: std::sync::Arc<tokio::sync::Mutex<NetnsPool>>,
    ) {
        while let Some(leaked) = rx.recv().await {
            warn!(
                id = %leaked.sandbox_id,
                device_index = leaked.device_index,
                "cleaning up leaked sandbox resources"
            );
            device_pool.lock().await.release(leaked.device_index);
            {
                let mut pool = netns_pool.lock().await;
                if let Err(e) = pool.release(leaked.network).await {
                    warn!(id = %leaked.sandbox_id, error = %e, "failed to release leaked netns");
                }
            }
            if let Err(e) = tokio::fs::remove_dir_all(&leaked.sock_dir).await {
                warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked sock dir");
            }
            if let Err(e) = tokio::fs::remove_dir_all(&leaked.workspace).await {
                warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked workspace");
            }
            info!(id = %leaked.sandbox_id, "leaked sandbox resources cleaned up");
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

    async fn startup(&mut self) -> sandbox::Result<()> {
        if self.started {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Factory,
                state: "started".into(),
                message: "factory already started".into(),
            });
        }

        // Create netns pool only if not provided externally (shared pool case).
        if self.netns_pool.is_none() {
            let t = std::time::Instant::now();
            let netns_config = NetnsPoolConfig {
                proxy_port: self.config.proxy_port,
                dns_port: self.config.dns_port,
            }
            .into_checked()?;
            let netns_pool = NetnsPool::create_checked(netns_config).await.map_err(|e| {
                SandboxError::Initialization {
                    phase: SandboxInitializationPhase::Factory,
                    message: format!("netns pool: {e}"),
                }
            })?;
            info!(
                elapsed_ms = t.elapsed().as_millis() as u64,
                "netns pool created"
            );
            self.netns_pool = Some(std::sync::Arc::new(tokio::sync::Mutex::new(netns_pool)));
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
        let (leak_tx, leak_rx) = tokio::sync::mpsc::channel(LEAK_CHANNEL_CAPACITY);
        self.leak_tx = Some(leak_tx);
        self.leak_cleanup_handle = Some(tokio::spawn(Self::drain_leaked_resources(
            leak_rx,
            std::sync::Arc::clone(&self.device_pool),
            self.netns_pool().clone(),
        )));

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
        let sock_paths = SockPaths::new(self.runtime_paths.sock_dir(&id));

        // Acquire a pre-warmed COW slot from the pool.
        // The slot provides: workspace dir (already created) and cow file.
        let slot = self.cow_pool().lock().await.acquire().await.map_err(|e| {
            SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("acquire COW slot: {e}"),
            }
        })?;

        // The slot workspace is {workspaces_dir}/{slot_uuid}/.
        // Rename to {workspaces_dir}/{sandbox_id}/ for doctor correlation.
        let target_workspace = self.factory_paths.workspace(&id);
        if target_workspace.exists()
            && let Err(e) = tokio::fs::remove_dir_all(&target_workspace).await
        {
            warn!(id = %id, error = %e, "failed to clean stale workspace dir");
        }
        if let Err(e) = tokio::fs::rename(&slot.workspace, &target_workspace).await {
            // Rollback: remove the slot workspace and COW file.
            crate::cow_pool::destroy_slot(slot);
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("rename workspace: {e}"),
            });
        }

        let sandbox_paths = SandboxPaths::new(target_workspace);
        // Recompute cow_file path after rename (slot.cow_file points to the old location).
        let cow_file = sandbox_paths.workspace().join("cow.img");

        // Clean stale sock dir and create vsock directory.
        if sock_paths.dir().exists()
            && let Err(e) = tokio::fs::remove_dir_all(sock_paths.dir()).await
        {
            warn!(id = %id, error = %e, "failed to clean stale sock dir");
        }
        if let Err(e) = tokio::fs::create_dir_all(sock_paths.vsock_dir()).await {
            let ws = sandbox_paths.workspace().to_owned();
            let sd = sock_paths.dir().to_owned();
            let _ = tokio::fs::remove_dir_all(&ws).await;
            let _ = tokio::fs::remove_dir_all(&sd).await;
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("mkdir vsock dir: {e}"),
            });
        }

        // Acquire a network namespace from the pool.
        let network = match self.netns_pool().lock().await.acquire().await {
            Ok(n) => n,
            Err(e) => {
                let ws = sandbox_paths.workspace().to_owned();
                let sd = sock_paths.dir().to_owned();
                let _ = tokio::fs::remove_dir_all(&ws).await;
                let _ = tokio::fs::remove_dir_all(&sd).await;
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::SandboxAllocation,
                    message: format!("acquire netns: {e}"),
                });
            }
        };

        // Create NBD COW device (~15ms via netlink, no subprocess).
        let base_image =
            self.base_image_path
                .as_ref()
                .ok_or_else(|| SandboxError::InvalidState {
                    context: SandboxInvalidStateContext::Factory,
                    state: "started without base image".into(),
                    message: "factory base image path missing".into(),
                })?;
        let cow_device = match NbdCowDevice::create(
            base_image,
            &cow_file,
            self.base_image_size,
            &self.device_pool,
        )
        .await
        {
            Ok(d) => d,
            Err(e) => {
                // Roll back: return netns to pool and clean up directories.
                let mut netns_pool = self.netns_pool().lock().await;
                if let Err(rel_err) = netns_pool.release(network).await {
                    warn!(error = %rel_err, "failed to release netns during rollback");
                }
                let _ = tokio::fs::remove_dir_all(sandbox_paths.workspace()).await;
                let _ = tokio::fs::remove_dir_all(sock_paths.dir()).await;
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::SandboxAllocation,
                    message: format!("create NBD COW device: {e}"),
                });
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
            self.leak_tx.clone(),
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

        // Mark as destroyed so Drop doesn't send to leak cleanup channel.
        sandbox.destroyed = true;

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

        // Log NBD COW stats before teardown for performance debugging.
        sandbox.cow_device.log_status().await;

        // Destroy the NBD COW device (flushes data, disconnects, removes COW file).
        //
        // After kill_process_group + child.wait(), the kernel may still be
        // releasing file descriptors (particularly the NBD device fd).
        // Retry a few times to let it finish.
        let device_index = sandbox.cow_device.device_index();
        let mut cow_destroyed = false;
        for attempt in 0..DESTROY_RETRIES {
            match sandbox.cow_device.destroy().await {
                Ok(()) => {
                    cow_destroyed = true;
                    break;
                }
                Err(e) => {
                    if attempt + 1 < DESTROY_RETRIES {
                        tokio::time::sleep(DESTROY_RETRY_DELAY).await;
                    } else {
                        // Last resort: abandon the device. It persists in
                        // the kernel until `runner gc` cleans it up.
                        warn!(id = %sandbox_id, error = %e, "destroy failed after retries — abandoning");
                        sandbox.cow_device.abandon();
                    }
                }
            }
        }
        drop(sandbox);

        // Release device index back to pool with cooldown.
        self.device_pool.lock().await.release(device_index);

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
        // down.  When destroy() failed, the NBD device may still reference
        // the COW file — keep the workspace intact for debugging.
        if cow_destroyed && let Err(e) = tokio::fs::remove_dir_all(&workspace).await {
            warn!(id = %sandbox_id, error = %e, "failed to delete workspace");
        }

        info!(id = %sandbox_id, "sandbox destroyed");
    }

    async fn shutdown(&mut self) {
        // Close the leak channel and abort the drain task.  Any in-flight
        // leaked resources will be cleaned by `runner gc` on the next start.
        // We abort (rather than await) so the task immediately releases its
        // Arc refs to the pools — required for Arc::try_unwrap below.
        self.leak_tx.take();
        if let Some(h) = self.leak_cleanup_handle.take() {
            h.abort();
        }

        // Clean up COW pool (delete pre-warmed COW files).
        if let Some(pool_mutex) = self.cow_pool.take() {
            let mut pool = pool_mutex.into_inner();
            pool.cleanup().await;
        }

        self.base_image_path = None;

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

impl Drop for FirecrackerFactory {
    /// Abort the leak cleanup task if `shutdown()` was never called.
    ///
    /// Safety net for abnormal paths (e.g., panic during startup).
    /// Harmless if `shutdown()` already ran — the handle is `None`.
    fn drop(&mut self) {
        // Mirror shutdown(): close the sender first so the drain task's
        // rx.recv() returns None, then abort as the immediate backstop.
        self.leak_tx.take();
        if let Some(h) = self.leak_cleanup_handle.take() {
            h.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_hash_is_deterministic() {
        let h1 = config_hash();
        let h2 = config_hash();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn invariant_config_has_all_expected_fields() {
        let config = InvariantConfig::new();
        let json = serde_json::to_value(&config).unwrap();
        let obj = json.as_object().unwrap();

        // Guard against accidental field additions/removals that would
        // silently change the config hash and invalidate all snapshots.
        let expected_fields = [
            "boot_args",
            "guest_mac",
            "tap_name",
            "tap_mac",
            "iface_id",
            "guest_cid",
            "balloon",
            "prewarm_script",
            "drive_layout",
        ];
        for field in &expected_fields {
            assert!(obj.contains_key(*field), "missing field: {field}");
        }
        assert_eq!(
            obj.len(),
            expected_fields.len(),
            "unexpected field count — adding/removing fields changes the config hash"
        );
    }

    #[test]
    fn config_hash_matches_snapshot_provider_trait() {
        let provider = crate::FirecrackerSnapshotProvider;
        let trait_hash = sandbox::SnapshotProvider::config_hash(&provider);
        let direct_hash = config_hash();
        assert_eq!(trait_hash, direct_hash);
    }

    fn test_network() -> PooledNetns {
        PooledNetns {
            name: "test-ns".into(),
            host_device: "test-ve".into(),
            peer_ip: "10.200.0.2".into(),
        }
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
            device_pool: std::sync::Arc::new(tokio::sync::Mutex::new(
                nbd_cow::pool::DevicePool::new(nbd_cow::pool::DevicePoolConfig::default()),
            )),
            base_image_path: None,
            base_image_size: 0,
            cow_pool: None,
            started,
            leak_tx: None,
            leak_cleanup_handle: None,
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
    async fn leaked_resources_channel_receives_on_send() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);

        tx.send(LeakedResources {
            sandbox_id: "test-sandbox".into(),
            device_index: 42,
            network: test_network(),
            sock_dir: PathBuf::from("/tmp/nonexistent-sock"),
            workspace: PathBuf::from("/tmp/nonexistent-ws"),
        })
        .await
        .unwrap();

        let leaked = rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "test-sandbox");
        assert_eq!(leaked.device_index, 42);
    }

    #[test]
    fn leaked_resources_try_send_does_not_panic_on_closed_channel() {
        let (tx, rx) = tokio::sync::mpsc::channel::<LeakedResources>(1);
        drop(rx);

        let resources = LeakedResources {
            sandbox_id: "test".into(),
            device_index: 0,
            network: test_network(),
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
        };

        // Should not panic — just returns Err.
        assert!(tx.try_send(resources).is_err());
    }

    #[test]
    fn leaked_resources_try_send_does_not_panic_on_full_channel() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<LeakedResources>(1);

        // Fill the channel.
        tx.try_send(LeakedResources {
            sandbox_id: "first".into(),
            device_index: 0,
            network: test_network(),
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
        })
        .unwrap();

        // Second send should fail gracefully.
        let result = tx.try_send(LeakedResources {
            sandbox_id: "second".into(),
            device_index: 1,
            network: test_network(),
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
        });
        assert!(result.is_err());
    }
}
