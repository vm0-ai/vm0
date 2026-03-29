//! COW Device Pool for Firecracker VMs
//!
//! Pre-warms COW files and loop devices in the background to reduce
//! sandbox creation latency. On acquire, only `dmsetup create` remains
//! on the hot path (~10-50ms, 1 sudo call).
//!
//! Follows the [`NetnsPool`](crate::network::NetnsPool) pattern:
//! - Fixed buffer of pre-warmed slots
//! - Three-tier acquire: queue → pending → on-demand
//! - Background replenishment after each acquire
//! - No recycling (COW files have dirty data after VM use)

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use tracing::{error, info, warn};

/// Number of pre-warmed COW slots to maintain in the queue.
const BUFFER_SIZE: usize = 4;

/// Maximum slots a single pool can allocate (prevents runaway loop device
/// consumption). Matches [`NetnsPool`]'s `MAX_NAMESPACES`.
const MAX_SLOTS: u32 = 256;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Configuration for creating a [`CowPool`].
#[derive(Clone)]
pub(crate) struct CowPoolConfig {
    /// Base directory for workspaces (e.g., `{base_dir}/workspaces`).
    pub workspaces_dir: PathBuf,
    /// Base image size in 512-byte sectors (for `init_cow_file` in fresh mode).
    pub base_sectors: u64,
    /// Snapshot golden COW file path (`None` = fresh mode).
    pub golden_cow: Option<PathBuf>,
}

/// A pre-warmed slot: COW file created + loop device attached.
///
/// The caller must create the dm-snapshot target on acquire
/// via [`CowDevice::create_from_loop`](block_cow::CowDevice::create_from_loop).
pub(crate) struct PrewarmedSlot {
    /// Unique slot ID (UUID). Used as workspace directory name.
    pub id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    pub workspace: PathBuf,
    /// The attached loop device. Ownership transfers to `CowDevice` on acquire.
    pub loop_device: block_cow::LoopDevice,
}

/// Pool error type.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CowPoolError {
    #[error("COW file creation failed: {0}")]
    CowFileCreation(String),
    #[error("loop device attach failed: {0}")]
    LoopAttach(String),
    #[error("slot limit reached (max {max})")]
    SlotLimitReached { max: u32 },
    #[error("pool is not active")]
    NotActive,
}

// ---------------------------------------------------------------------------
// CowPool
// ---------------------------------------------------------------------------

/// Pre-warming pool for COW device resources.
///
/// Maintains a buffer of pre-created COW files with attached loop devices.
/// On [`acquire`](Self::acquire), pops a slot and the caller creates the
/// dm-snapshot target with the correct `cow-{sandbox_id}` name.
pub(crate) struct CowPool {
    active: bool,
    queue: VecDeque<PrewarmedSlot>,
    pending: tokio::task::JoinSet<Result<PrewarmedSlot, CowPoolError>>,
    next_slot_idx: u32,
    config: CowPoolConfig,
}

impl CowPool {
    /// Create a new pool without allocating resources.
    ///
    /// Call [`warmup`](Self::warmup) to pre-warm the initial buffer.
    pub fn new(config: CowPoolConfig) -> Self {
        Self {
            active: true,
            queue: VecDeque::with_capacity(BUFFER_SIZE),
            pending: tokio::task::JoinSet::new(),
            next_slot_idx: 0,
            config,
        }
    }

    /// Pre-warm the initial buffer of slots in parallel.
    ///
    /// Called from `factory.startup()`. Errors during pre-warm are logged
    /// but do not prevent the pool from operating (acquire falls back to
    /// on-demand creation).
    pub async fn warmup(&mut self) {
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..BUFFER_SIZE {
            if self.next_slot_idx >= MAX_SLOTS {
                break;
            }
            let idx = self.next_slot_idx;
            self.next_slot_idx += 1;
            let config = self.config.clone();
            set.spawn_blocking(move || create_slot(idx, &config));
        }
        while let Some(result) = set.join_next().await {
            match result {
                Ok(Ok(slot)) => self.queue.push_back(slot),
                Ok(Err(e)) => error!(error = %e, "pre-warm slot creation failed"),
                Err(e) => error!(error = %e, "pre-warm task panicked"),
            }
        }
        info!(
            ready = self.queue.len(),
            buffer = BUFFER_SIZE,
            "COW pool warmed up"
        );
    }

    /// Acquire a pre-warmed slot.
    ///
    /// Three-tier strategy (same as `NetnsPool`):
    /// 1. Pop from ready queue (instant)
    /// 2. Await in-flight background task
    /// 3. Create on-demand (blocking fallback)
    pub async fn acquire(&mut self) -> Result<PrewarmedSlot, CowPoolError> {
        if !self.active {
            return Err(CowPoolError::NotActive);
        }
        self.drain_completed();

        // Tier 1: pop from queue.
        if let Some(slot) = self.queue.pop_front() {
            info!(id = %slot.id, remaining = self.queue.len(), "acquired COW slot from pool");
            self.maybe_replenish();
            return Ok(slot);
        }

        // Tier 2: await in-flight background task.
        while let Some(result) = self.pending.join_next().await {
            match result {
                Ok(Ok(slot)) => {
                    info!(id = %slot.id, "acquired COW slot from pending");
                    self.maybe_replenish();
                    return Ok(slot);
                }
                Ok(Err(e)) => error!(error = %e, "pending slot creation failed"),
                Err(e) => error!(error = %e, "pending slot task panicked"),
            }
        }

        // Tier 3: create on-demand (blocking fallback).
        info!("COW pool exhausted, creating slot on-demand");
        if self.next_slot_idx >= MAX_SLOTS {
            return Err(CowPoolError::SlotLimitReached { max: MAX_SLOTS });
        }
        let idx = self.next_slot_idx;
        self.next_slot_idx += 1;
        let config = self.config.clone();
        let slot = tokio::task::spawn_blocking(move || create_slot(idx, &config))
            .await
            .map_err(|e| CowPoolError::CowFileCreation(format!("join: {e}")))??;
        self.maybe_replenish();
        Ok(slot)
    }

    /// Shut down the pool: abort pending tasks, destroy all queued slots.
    pub async fn cleanup(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;

        // Abort pending and collect any that completed.
        self.pending.abort_all();
        while let Some(result) = self.pending.join_next().await {
            if let Ok(Ok(slot)) = result {
                self.queue.push_back(slot);
            }
        }

        let count = self.queue.len();
        info!(count, "cleaning up COW pool");

        let mut teardown = tokio::task::JoinSet::new();
        while let Some(slot) = self.queue.pop_front() {
            teardown.spawn_blocking(move || destroy_slot(slot));
        }
        while let Some(result) = teardown.join_next().await {
            if let Err(e) = result {
                error!(error = %e, "slot teardown panicked");
            }
        }
        info!("COW pool cleanup complete");
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Drain completed background tasks into the queue.
    fn drain_completed(&mut self) {
        while let Some(result) = self.pending.try_join_next() {
            match result {
                Ok(Ok(slot)) => self.queue.push_back(slot),
                Ok(Err(e)) => error!(error = %e, "background slot creation failed"),
                Err(e) => error!(error = %e, "background slot creation panicked"),
            }
        }
    }

    /// Spawn one background replenishment task if the queue is below threshold.
    fn maybe_replenish(&mut self) {
        if self.queue.len() + self.pending.len() >= BUFFER_SIZE
            || !self.pending.is_empty()
            || self.next_slot_idx >= MAX_SLOTS
        {
            return;
        }
        let idx = self.next_slot_idx;
        self.next_slot_idx += 1;
        let config = self.config.clone();
        self.pending
            .spawn_blocking(move || create_slot(idx, &config));
    }
}

// ---------------------------------------------------------------------------
// Slot creation / destruction (runs in spawn_blocking)
// ---------------------------------------------------------------------------

/// Create a pre-warmed slot: COW file + loop device.
fn create_slot(_idx: u32, config: &CowPoolConfig) -> Result<PrewarmedSlot, CowPoolError> {
    let id = uuid::Uuid::new_v4().to_string();
    let workspace = config.workspaces_dir.join(&id);
    let cow_file = workspace.join("cow.img");

    // 1. Create COW file.
    match &config.golden_cow {
        Some(golden) => {
            std::fs::create_dir_all(&workspace)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
            sparse_copy(golden, &cow_file)?;
        }
        None => {
            block_cow::init_cow_file(&cow_file, config.base_sectors)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
        }
    }

    // 2. Attach loop device.
    let loop_device = match block_cow::losetup_attach(&cow_file, false) {
        Ok(ld) => ld,
        Err(e) => {
            let _ = std::fs::remove_file(&cow_file);
            let _ = std::fs::remove_dir_all(&workspace);
            return Err(CowPoolError::LoopAttach(e.to_string()));
        }
    };

    Ok(PrewarmedSlot {
        id,
        workspace,
        loop_device,
    })
}

/// Synchronous sparse copy via `cp --sparse=always`.
fn sparse_copy(src: &Path, dst: &Path) -> Result<(), CowPoolError> {
    let output = std::process::Command::new("cp")
        .arg("--sparse=always")
        .arg(src)
        .arg(dst)
        .output()
        .map_err(|e| CowPoolError::CowFileCreation(format!("exec cp: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CowPoolError::CowFileCreation(format!(
            "cp --sparse=always failed: {stderr}"
        )));
    }
    Ok(())
}

/// Best-effort teardown of a pre-warmed slot.
///
/// Detaches the loop device first (so the backing file is released), then
/// removes the workspace directory (which contains the cow file).
pub(crate) fn destroy_slot(mut slot: PrewarmedSlot) {
    if let Err(e) = slot.loop_device.detach() {
        warn!(id = %slot.id, error = %e, "failed to detach pool loop device");
    }
    if let Err(e) = std::fs::remove_dir_all(&slot.workspace) {
        warn!(id = %slot.id, error = %e, "failed to delete pool workspace dir");
    }
}
