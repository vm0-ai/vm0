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

/// Maximum time to wait for leaked-resource cleanup during normal shutdown.
///
/// Shutdown is the graceful path, so already-queued leak reports should drain
/// before the pool Arcs are unwrapped. If cleanup gets stuck, fall back to
/// aborting and let the next `runner gc` clean leftovers.
const LEAK_CLEANUP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Resources that require async cleanup when a sandbox is dropped without
/// going through `factory.destroy()` or when create is dropped mid-allocation.
///
/// Drop impls send these to a cleanup channel owned by the factory, which
/// drains them asynchronously.
pub(crate) struct LeakedResources {
    pub(crate) sandbox_id: String,
    pub(crate) device_index: Option<u32>,
    pub(crate) cow_device: Option<NbdCowDevice>,
    pub(crate) network: Option<PooledNetns>,
    pub(crate) sock_dir: PathBuf,
    pub(crate) workspace: PathBuf,
}

/// Owns the leaked-resource cleanup channel and its background drain task.
///
/// Normal factory shutdown signals the drain task to close the receiver, drain
/// already-queued resources, and finish. `Drop` cannot await, so it aborts as a
/// best-effort fallback.
struct LeakCleaner {
    tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl LeakCleaner {
    fn spawn(
        device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
        netns_pool: std::sync::Arc<tokio::sync::Mutex<NetnsPool>>,
    ) -> Self {
        // Drop cannot await, and losing a leak report can strand host resources.
        // Keep this unbounded: reports only come from exceptional cleanup paths,
        // with runner GC as the final backstop if the cleaner stalls.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
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

    fn sender(&self) -> Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>> {
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

#[async_trait]
trait CreateRollbackCleanup {
    async fn destroy_cow_device(&self, cow_device: NbdCowDevice) -> bool;
    async fn release_network(&self, network: PooledNetns);
    async fn remove_dir(&self, kind: &'static str, path: PathBuf);
    fn destroy_slot(&self, slot: crate::cow_pool::PrewarmedSlot);
}

struct FactoryCreateRollbackCleanup {
    id: String,
    device_pool: std::sync::Arc<tokio::sync::Mutex<nbd_cow::pool::DevicePool>>,
    netns_pool: std::sync::Arc<tokio::sync::Mutex<NetnsPool>>,
}

#[async_trait]
impl CreateRollbackCleanup for FactoryCreateRollbackCleanup {
    async fn destroy_cow_device(&self, mut cow_device: NbdCowDevice) -> bool {
        let device_index = cow_device.device_index();
        let cow_destroyed = destroy_cow_device_with_retries(&self.id, &mut cow_device).await;
        self.device_pool.lock().await.release(device_index);
        cow_destroyed
    }

    async fn release_network(&self, network: PooledNetns) {
        let mut netns_pool = self.netns_pool.lock().await;
        if let Err(e) = netns_pool.release(network).await {
            warn!(id = %self.id, error = %e, "failed to release netns during rollback");
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

struct SandboxCreateResources {
    sandbox_paths: SandboxPaths,
    sock_paths: SockPaths,
    network: PooledNetns,
    cow_device: NbdCowDevice,
}

#[cfg(test)]
struct SandboxCreateResourcesWithoutCow {
    sandbox_paths: SandboxPaths,
    sock_paths: SockPaths,
    network: PooledNetns,
}

struct SandboxCreateTransaction {
    id: String,
    slot: Option<crate::cow_pool::PrewarmedSlot>,
    workspace: Option<PathBuf>,
    sock_dir: Option<PathBuf>,
    network: Option<PooledNetns>,
    cow_device: Option<NbdCowDevice>,
    leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
}

impl SandboxCreateTransaction {
    #[cfg(test)]
    fn new(id: String) -> Self {
        Self::new_with_leak_tx(id, None)
    }

    fn new_with_leak_tx(
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
        }
    }

    fn track_slot(&mut self, slot: crate::cow_pool::PrewarmedSlot) {
        self.slot = Some(slot);
    }

    fn slot_workspace(&self) -> sandbox::Result<PathBuf> {
        self.slot
            .as_ref()
            .map(|slot| slot.workspace.clone())
            .ok_or_else(|| create_transaction_invalid_state("missing COW slot before rename"))
    }

    fn slot_renamed_to(&mut self, workspace: PathBuf) {
        self.slot.take();
        self.workspace = Some(workspace);
    }

    fn track_sock_dir(&mut self, sock_dir: PathBuf) {
        self.sock_dir = Some(sock_dir);
    }

    fn track_network(&mut self, network: PooledNetns) {
        self.network = Some(network);
    }

    fn track_cow_device(&mut self, cow_device: NbdCowDevice) {
        self.cow_device = Some(cow_device);
    }

    fn commit(&mut self) -> sandbox::Result<SandboxCreateResources> {
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
    ) -> sandbox::Result<(PathBuf, PathBuf, PooledNetns)> {
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
            !cleanup.destroy_cow_device(cow_device).await
        } else {
            false
        };
        if let Some(network) = self.network.take() {
            cleanup.release_network(network).await;
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
            device_index: None,
            cow_device: self.cow_device.take(),
            network: self.network.take(),
            sock_dir,
            workspace,
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
            let _ = std::fs::remove_dir_all(workspace);
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

async fn rollback_create_transaction<C>(tx: SandboxCreateTransaction, cleanup: C)
where
    C: CreateRollbackCleanup + Send + Sync + 'static,
{
    let rollback_id = tx.id.clone();
    let rollback_task = tokio::spawn(async move {
        let mut tx = tx;
        tx.rollback(&cleanup).await;
    });
    if let Err(rollback_err) = rollback_task.await {
        warn!(
            id = %rollback_id,
            error = %rollback_err,
            "sandbox create rollback task failed"
        );
    }
}

async fn destroy_cow_device_with_retries(id: &str, cow_device: &mut NbdCowDevice) -> bool {
    for attempt in 0..DESTROY_RETRIES {
        match cow_device.destroy().await {
            Ok(()) => return true,
            Err(e) => {
                if attempt + 1 < DESTROY_RETRIES {
                    tokio::time::sleep(DESTROY_RETRY_DELAY).await;
                } else {
                    // Last resort: abandon the device. It persists in
                    // the kernel until `runner gc` cleans it up.
                    warn!(id = %id, error = %e, "destroy failed after retries — abandoning");
                    cow_device.abandon();
                }
            }
        }
    }
    false
}

/// Background task that receives leaked sandbox resources from `Drop`
/// impls and releases them asynchronously (pool indices, namespaces, dirs).
async fn drain_leaked_resources(
    rx: tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
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
    mut rx: tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
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
        device_index = ?leaked.device_index,
        has_cow_device = leaked.cow_device.is_some(),
        has_network = leaked.network.is_some(),
        "cleaning up leaked sandbox resources"
    );

    let mut cow_destroyed = true;
    if let Some(mut cow_device) = leaked.cow_device {
        let device_index = cow_device.device_index();
        cow_destroyed = destroy_cow_device_with_retries(&leaked.sandbox_id, &mut cow_device).await;
        device_pool.lock().await.release(device_index);
    } else if let Some(device_index) = leaked.device_index {
        device_pool.lock().await.release(device_index);
    }

    if let Some(network) = leaked.network {
        let mut pool = netns_pool.lock().await;
        if let Err(e) = pool.release(network).await {
            warn!(id = %leaked.sandbox_id, error = %e, "failed to release leaked netns");
        }
    }
    if let Err(e) = tokio::fs::remove_dir_all(&leaked.sock_dir).await {
        warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked sock dir");
    }
    if cow_destroyed && let Err(e) = tokio::fs::remove_dir_all(&leaked.workspace).await {
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
/// - `codex --help`: codex ships as a Node.js CLI (npm `@openai/codex`); the
///   `--help` path exits cleanly without credentials yet `require`s the full
///   module graph and triggers V8 JIT compilation, so the resolved-and-parsed
///   bytecode is captured in the snapshot. Each warmup is wrapped in its own
///   `(... || true)` sub-shell so a failure on one framework does not block
///   the other from warming.
pub const PREWARM_SCRIPT: &str = "\
    (claude --print --verbose --output-format stream-json hi 2>/dev/null || true); \
    (codex --help >/dev/null 2>&1 || true)";

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
        let rollback_cleanup = FactoryCreateRollbackCleanup {
            id: id.clone(),
            device_pool: std::sync::Arc::clone(&self.device_pool),
            netns_pool: std::sync::Arc::clone(self.netns_pool()),
        };
        let mut tx = SandboxCreateTransaction::new_with_leak_tx(
            id.clone(),
            self.leak_cleaner.as_ref().and_then(LeakCleaner::sender),
        );

        let create_result: sandbox::Result<SandboxCreateResources> = async {
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
            let network = self
                .netns_pool()
                .lock()
                .await
                .acquire()
                .await
                .map_err(|e| SandboxError::Initialization {
                    phase: SandboxInitializationPhase::SandboxAllocation,
                    message: format!("acquire netns: {e}"),
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
            let cow_device = NbdCowDevice::create(
                base_image,
                &cow_file,
                self.base_image_size,
                &self.device_pool,
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
                rollback_create_transaction(tx, rollback_cleanup).await;
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
        let cow_destroyed =
            destroy_cow_device_with_retries(&sandbox_id, &mut sandbox.cow_device).await;
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
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    #[test]
    fn config_hash_is_deterministic() {
        let h1 = config_hash();
        let h2 = config_hash();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    /// Both supported framework CLIs must be warmed during snapshot creation.
    /// Dropping either one would silently regress cold-start latency for that
    /// framework's agents — see #11416 / epic #11386.
    #[test]
    fn prewarm_script_warms_both_frameworks() {
        assert!(
            PREWARM_SCRIPT.contains("claude"),
            "PREWARM_SCRIPT must warm the claude CLI"
        );
        assert!(
            PREWARM_SCRIPT.contains("codex"),
            "PREWARM_SCRIPT must warm the codex CLI"
        );
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
        async fn destroy_cow_device(&self, _cow_device: NbdCowDevice) -> bool {
            panic!("test cleanup should not receive a real COW device");
        }

        async fn release_network(&self, network: PooledNetns) {
            self.record(format!("release_network:{}", network.name));
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
    impl CreateRollbackCleanup for RecordingCreateRollbackCleanup {
        async fn destroy_cow_device(&self, _cow_device: NbdCowDevice) -> bool {
            panic!("test cleanup should not receive a real COW device");
        }

        async fn release_network(&self, network: PooledNetns) {
            self.record(format!("release_network:{}", network.name));
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
        }
    }

    fn test_leaked_resource(sandbox_id: &str, device_index: u32) -> LeakedResources {
        LeakedResources {
            sandbox_id: sandbox_id.into(),
            device_index: Some(device_index),
            cow_device: None,
            network: Some(test_network()),
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
        assert_eq!(resources.network.name, "test-ns");
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

        drop(tx);

        assert!(!workspace.exists());
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
        leak_tx.send(test_leaked_resource("queued", 7)).unwrap();

        let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
        tx.slot_renamed_to(workspace.clone());
        tx.track_sock_dir(sock_dir.clone());
        tx.track_network(test_network());

        drop(tx);

        assert_eq!(leak_rx.recv().await.unwrap().sandbox_id, "queued");
        let leaked = leak_rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "sandbox");
        assert_eq!(leaked.network.unwrap().name, "test-ns");
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

        let leaked = leak_rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "sandbox");
        assert_eq!(leaked.device_index, None);
        assert!(leaked.cow_device.is_none());
        assert_eq!(leaked.network.unwrap().name, "test-ns");
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
        let waiter = tokio::spawn(rollback_create_transaction(tx, cleanup.clone()));

        tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered(1))
            .await
            .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());

        cleanup.release();
        tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_removed(2))
            .await
            .unwrap();

        assert!(!sock_dir.exists());
        assert!(!workspace.exists());
        assert_eq!(
            cleanup.events(),
            vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
        );
    }

    #[tokio::test]
    async fn leaked_resources_channel_receives_on_send() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        tx.send(LeakedResources {
            sandbox_id: "test-sandbox".into(),
            device_index: Some(42),
            cow_device: None,
            network: Some(test_network()),
            sock_dir: PathBuf::from("/tmp/nonexistent-sock"),
            workspace: PathBuf::from("/tmp/nonexistent-ws"),
        })
        .unwrap();

        let leaked = rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "test-sandbox");
        assert_eq!(leaked.device_index, Some(42));
    }

    #[test]
    fn leaked_resources_send_does_not_panic_on_closed_channel() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        drop(rx);

        let resources = LeakedResources {
            sandbox_id: "test".into(),
            device_index: Some(0),
            cow_device: None,
            network: Some(test_network()),
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
        };

        // Should not panic — just returns Err.
        assert!(tx.send(resources).is_err());
    }

    #[test]
    fn leaked_resources_unbounded_send_accepts_burst() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();

        for index in 0..64 {
            tx.send(test_leaked_resource(&format!("leaked-{index}"), index))
                .unwrap();
        }

        for index in 0..64 {
            assert_eq!(rx.try_recv().unwrap().sandbox_id, format!("leaked-{index}"));
        }
    }

    #[tokio::test]
    async fn drain_leaked_resources_shutdown_closes_receiver_and_drains_buffer() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        for index in 0..64 {
            tx.send(test_leaked_resource(&format!("leaked-{index}"), index))
                .unwrap();
        }

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

        let expected: Vec<String> = (0..64).map(|index| format!("leaked-{index}")).collect();
        assert_eq!(*cleaned.lock().await, expected);
        assert!(matches!(
            live_sender_clone.send(test_leaked_resource("late", 2)),
            Err(tokio::sync::mpsc::error::SendError(_))
        ));
    }

    #[tokio::test]
    async fn drain_leaked_resources_exits_after_sender_close() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        tx.send(test_leaked_resource("first", 0)).unwrap();
        tx.send(test_leaked_resource("second", 1)).unwrap();
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
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
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

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
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

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
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
