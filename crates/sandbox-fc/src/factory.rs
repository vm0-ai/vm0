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

/// Maximum time to wait for leaked-resource cleanup during normal shutdown.
///
/// Shutdown is the graceful path, so already-queued leak reports should drain
/// before the pool Arcs are unwrapped. If cleanup gets stuck, fall back to
/// aborting and let the next `runner gc` clean leftovers.
const LEAK_CLEANUP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

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

/// Owns the leaked-resource cleanup channel and its background drain task.
///
/// Normal factory shutdown signals the drain task to close the receiver, drain
/// already-queued resources, and finish. `Drop` cannot await, so it aborts as a
/// best-effort fallback.
struct LeakCleaner {
    tx: Option<tokio::sync::mpsc::Sender<LeakedResources>>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl LeakCleaner {
    fn spawn(
        device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
        netns_pool: std::sync::Arc<tokio::sync::Mutex<NetnsPool>>,
    ) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(LEAK_CHANNEL_CAPACITY);
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(drain_leaked_resources(
            rx,
            shutdown_rx,
            device_pool,
            netns_pool,
        ));
        Self {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        }
    }

    fn sender(&self) -> Option<tokio::sync::mpsc::Sender<LeakedResources>> {
        self.tx.clone()
    }

    async fn shutdown(mut self) {
        self.tx.take();
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        let Some(mut handle) = self.handle.take() else {
            return;
        };

        tokio::select! {
            result = &mut handle => {
                if let Err(e) = result {
                    warn!(error = %e, "leak cleanup task exited unexpectedly");
                }
            }
            () = tokio::time::sleep(LEAK_CLEANUP_SHUTDOWN_TIMEOUT) => {
                warn!(
                    timeout_ms = LEAK_CLEANUP_SHUTDOWN_TIMEOUT.as_millis() as u64,
                    "timed out waiting for leak cleanup task; aborting"
                );
                handle.abort();
                if let Err(e) = handle.await
                    && !e.is_cancelled()
                {
                    warn!(error = %e, "leak cleanup task failed after abort");
                }
            }
        }
    }

    fn abort(&mut self) {
        // Drop handles first, then abort immediately as a synchronous Drop backstop.
        self.tx.take();
        self.shutdown_tx.take();
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

impl Drop for LeakCleaner {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Background task that receives leaked sandbox resources from `Drop`
/// impls and releases them asynchronously (pool indices, namespaces, dirs).
async fn drain_leaked_resources(
    rx: tokio::sync::mpsc::Receiver<LeakedResources>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
    netns_pool: std::sync::Arc<tokio::sync::Mutex<NetnsPool>>,
) {
    drain_leaked_resources_with_cleanup(rx, shutdown_rx, move |leaked| {
        let device_pool = std::sync::Arc::clone(&device_pool);
        let netns_pool = std::sync::Arc::clone(&netns_pool);
        async move {
            cleanup_leaked_resource(leaked, &device_pool, &netns_pool).await;
        }
    })
    .await;
}

async fn drain_leaked_resources_with_cleanup<C, Fut>(
    mut rx: tokio::sync::mpsc::Receiver<LeakedResources>,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    mut cleanup: C,
) where
    C: FnMut(LeakedResources) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => {
                rx.close();
                while let Some(leaked) = rx.recv().await {
                    cleanup(leaked).await;
                }
                break;
            }
            maybe_leaked = rx.recv() => {
                let Some(leaked) = maybe_leaked else {
                    break;
                };
                cleanup(leaked).await;
            }
        }
    }
}

async fn cleanup_leaked_resource(
    leaked: LeakedResources,
    device_pool: &tokio::sync::Mutex<nbd_cow::pool::DevicePool>,
    netns_pool: &tokio::sync::Mutex<NetnsPool>,
) {
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
    fn netns_pool(&self) -> &std::sync::Arc<tokio::sync::Mutex<NetnsPool>> {
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
        self.leak_cleaner = Some(LeakCleaner::spawn(
            std::sync::Arc::clone(&self.device_pool),
            self.netns_pool().clone(),
        ));

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
            self.leak_cleaner.as_ref().and_then(LeakCleaner::sender),
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

        // Mark as destroyed only after all explicit cleanup steps complete.
        // Until this point, `FirecrackerSandbox::Drop` remains armed as a
        // panic fallback and sends pool resources to the leak-cleanup task.
        sandbox.destroyed = true;
        drop(sandbox);

        info!(id = %sandbox_id, "sandbox destroyed");
    }

    async fn shutdown(&mut self) {
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
    fn drop(&mut self) {
        // Safety net for abnormal paths (e.g. panic before shutdown()).
        self.leak_cleaner.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

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

    fn test_leaked_resource(sandbox_id: &str, device_index: u32) -> LeakedResources {
        LeakedResources {
            sandbox_id: sandbox_id.into(),
            device_index,
            network: test_network(),
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
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
        tx.try_send(test_leaked_resource("first", 0)).unwrap();

        // Second send should fail gracefully.
        let result = tx.try_send(test_leaked_resource("second", 1));
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn drain_leaked_resources_shutdown_closes_receiver_and_drains_buffer() {
        let (tx, rx) = tokio::sync::mpsc::channel::<LeakedResources>(4);
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        tx.send(test_leaked_resource("first", 0)).await.unwrap();
        tx.send(test_leaked_resource("second", 1)).await.unwrap();

        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            },
        ));

        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            *cleaned.lock().await,
            vec!["first".to_string(), "second".to_string()]
        );
        assert!(matches!(
            live_sender_clone.try_send(test_leaked_resource("late", 2)),
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_))
        ));
    }

    #[tokio::test]
    async fn drain_leaked_resources_exits_after_sender_close() {
        let (tx, rx) = tokio::sync::mpsc::channel::<LeakedResources>(4);
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        tx.send(test_leaked_resource("first", 0)).await.unwrap();
        tx.send(test_leaked_resource("second", 1)).await.unwrap();
        drop(tx);

        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        drain_leaked_resources_with_cleanup(rx, shutdown_rx, move |leaked| {
            let cleaned = Arc::clone(&cleaned_clone);
            async move {
                cleaned.lock().await.push(leaked.sandbox_id);
            }
        })
        .await;

        assert_eq!(
            *cleaned.lock().await,
            vec!["first".to_string(), "second".to_string()]
        );
    }

    #[tokio::test]
    async fn leak_cleaner_shutdown_signals_drain_with_live_sender_clone() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<LeakedResources>(1);
        let _live_sender_clone = tx.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let drained = Arc::new(AtomicBool::new(false));
        let drained_clone = Arc::clone(&drained);
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    rx.close();
                    while rx.recv().await.is_some() {}
                    drained_clone.store(true, Ordering::SeqCst);
                }
                _ = rx.recv() => {
                    panic!("leak cleaner did not signal shutdown before receiver completion");
                }
            }
        });

        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };
        cleaner.shutdown().await;

        assert!(drained.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn leak_cleaner_shutdown_aborts_after_timeout() {
        struct AbortFlag(Arc<AtomicBool>);

        impl Drop for AbortFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let (tx, _rx) = tokio::sync::mpsc::channel::<LeakedResources>(1);
        let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };

        started_rx.await.unwrap();
        let shutdown = cleaner.shutdown();
        tokio::pin!(shutdown);
        tokio::task::yield_now().await;
        tokio::time::advance(LEAK_CLEANUP_SHUTDOWN_TIMEOUT).await;
        shutdown.await;

        assert!(aborted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn leak_cleaner_abort_closes_sender_and_aborts_task() {
        struct AbortFlag(Arc<AtomicBool>);

        impl Drop for AbortFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let (tx, _rx) = tokio::sync::mpsc::channel::<LeakedResources>(1);
        let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let mut cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };

        started_rx.await.unwrap();
        cleaner.abort();

        assert!(cleaner.tx.is_none());
        assert!(cleaner.shutdown_tx.is_none());
        assert!(cleaner.handle.is_none());
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !aborted.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
