//! COW Device Pool for Firecracker VMs
//!
//! Pre-warms COW files in the background to reduce sandbox creation latency.
//! On acquire, only `DevicePoolHandle::create_cow_device()` remains on the hot path (~15ms,
//! netlink connect — no subprocess calls).
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

/// Maximum slots in the pool pipeline at any time (queue + pending + creating).
/// Prevents runaway NBD device consumption. In practice the pool stays near
/// `BUFFER_SIZE`; this is a safety ceiling.
const MAX_SLOTS: u32 = 256;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Configuration for creating a [`CowPool`].
#[derive(Clone)]
pub(crate) struct CowPoolConfig {
    /// Base directory for workspaces (e.g., `{base_dir}/workspaces`).
    pub workspaces_dir: PathBuf,
    /// Base image size in bytes (for creating sparse COW files in fresh mode).
    pub base_size: u64,
    /// Snapshot golden COW file path (`None` = fresh mode).
    pub golden_cow: Option<PathBuf>,
}

/// A pre-warmed slot: workspace directory + COW file created.
///
/// The caller must create the NBD device on acquire via
/// `DevicePoolHandle::create_cow_device()`.
pub(crate) struct PrewarmedSlot {
    /// Unique slot ID (UUID). Used as workspace directory name.
    pub id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    pub workspace: PathBuf,
}

impl PrewarmedSlot {
    /// Path to the COW file inside the workspace.
    #[cfg(test)]
    fn cow_file(&self) -> PathBuf {
        self.workspace.join("cow.img")
    }
}

impl std::fmt::Debug for PrewarmedSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrewarmedSlot")
            .field("id", &self.id)
            .field("workspace", &self.workspace)
            .finish_non_exhaustive()
    }
}

/// Pool error type.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CowPoolError {
    #[error("COW file creation failed: {0}")]
    CowFileCreation(String),
    #[error("slot limit reached (max {max})")]
    SlotLimitReached { max: u32 },
    #[error("pool is not active")]
    NotActive,
}

// ---------------------------------------------------------------------------
// CowPool
// ---------------------------------------------------------------------------

/// Pre-warming pool for COW file resources.
///
/// Maintains a buffer of pre-created COW files. On [`acquire`](Self::acquire),
/// pops a slot and the caller creates the NBD device with
/// `DevicePoolHandle::create_cow_device()`.
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
            self.next_slot_idx += 1;
            let config = self.config.clone();
            set.spawn_blocking(move || create_slot(&config));
        }
        while let Some(result) = set.join_next().await {
            match result {
                Ok(Ok(slot)) => self.queue.push_back(slot),
                Ok(Err(e)) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "pre-warm slot creation failed");
                }
                Err(e) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "pre-warm task panicked");
                }
            }
        }
        if self.queue.is_empty() {
            warn!(
                "COW pool warmup produced no ready slots — all acquire calls will use on-demand creation"
            );
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
            self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
            info!(id = %slot.id, remaining = self.queue.len(), "acquired COW slot from pool");
            self.maybe_replenish();
            return Ok(slot);
        }

        // Tier 2: await in-flight background task.
        while let Some(result) = self.pending.join_next().await {
            match result {
                Ok(Ok(slot)) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    info!(id = %slot.id, "acquired COW slot from pending");
                    self.maybe_replenish();
                    return Ok(slot);
                }
                Ok(Err(e)) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "pending slot creation failed");
                }
                Err(e) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "pending slot task panicked");
                }
            }
        }

        // Tier 3: create on-demand (blocking fallback).
        info!("COW pool exhausted, creating slot on-demand");
        if self.next_slot_idx >= MAX_SLOTS {
            return Err(CowPoolError::SlotLimitReached { max: MAX_SLOTS });
        }
        self.next_slot_idx += 1;
        let config = self.config.clone();
        match tokio::task::spawn_blocking(move || create_slot(&config)).await {
            Ok(Ok(slot)) => {
                self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                self.maybe_replenish();
                Ok(slot)
            }
            Ok(Err(e)) => {
                self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                Err(e)
            }
            Err(e) => {
                self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                Err(CowPoolError::CowFileCreation(format!("join: {e}")))
            }
        }
    }

    /// Shut down the pool: wait for pending tasks, destroy all queued slots.
    pub async fn cleanup(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;

        // Wait for in-flight spawn_blocking tasks to complete.
        // Unlike async tasks, spawn_blocking tasks cannot be cancelled —
        // abort_all would mark them as Cancelled, discarding the created
        // slot and leaking its COW file. So we wait instead.
        while let Some(result) = self.pending.join_next().await {
            match result {
                Ok(Ok(slot)) => self.queue.push_back(slot),
                Ok(Err(e)) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "pending slot creation failed during cleanup");
                }
                Err(e) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "pending task panicked during cleanup");
                }
            }
        }

        let count = self.queue.len();
        info!(count, "cleaning up COW pool");

        while let Some(slot) = self.queue.pop_front() {
            self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
            destroy_slot(slot);
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
                Ok(Err(e)) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "background slot creation failed");
                }
                Err(e) => {
                    self.next_slot_idx = self.next_slot_idx.saturating_sub(1);
                    error!(error = %e, "background slot creation panicked");
                }
            }
        }
    }

    /// Spawn one background replenishment task if the queue is below threshold.
    fn maybe_replenish(&mut self) {
        if self.queue.len() + self.pending.len() >= BUFFER_SIZE || self.next_slot_idx >= MAX_SLOTS {
            return;
        }
        self.next_slot_idx += 1;
        let config = self.config.clone();
        self.pending.spawn_blocking(move || create_slot(&config));
    }
}

// ---------------------------------------------------------------------------
// Slot creation / destruction (runs in spawn_blocking)
// ---------------------------------------------------------------------------

/// Create a pre-warmed slot: workspace directory + COW file.
fn create_slot(config: &CowPoolConfig) -> Result<PrewarmedSlot, CowPoolError> {
    let id = uuid::Uuid::new_v4().to_string();
    let workspace = config.workspaces_dir.join(&id);
    let cow_file = workspace.join("cow.img");

    if let Err(e) = create_cow_file(config, &workspace, &cow_file) {
        // Best-effort cleanup: remove any partially-created workspace.
        let _ = std::fs::remove_dir_all(&workspace);
        return Err(e);
    }

    Ok(PrewarmedSlot { id, workspace })
}

/// Create the COW file: sparse-copy from golden image or allocate fresh.
fn create_cow_file(
    config: &CowPoolConfig,
    workspace: &Path,
    cow_file: &Path,
) -> Result<(), CowPoolError> {
    std::fs::create_dir_all(workspace).map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    match &config.golden_cow {
        Some(golden) => {
            sparse_copy(golden, cow_file)?;
            // Also copy the bitmap sidecar if it exists (for snapshot restore).
            let golden_bitmap = PathBuf::from(format!("{}.bitmap", golden.display()));
            if golden_bitmap.exists() {
                let cow_bitmap = PathBuf::from(format!("{}.bitmap", cow_file.display()));
                sparse_copy(&golden_bitmap, &cow_bitmap)?;
            }
        }
        None => {
            let f = std::fs::File::create(cow_file)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
            f.set_len(config.base_size)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
        }
    }
    Ok(())
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
/// Removes the workspace directory (which contains the COW file).
pub(crate) fn destroy_slot(slot: PrewarmedSlot) {
    if let Err(e) = std::fs::remove_dir_all(&slot.workspace) {
        warn!(id = %slot.id, error = %e, "failed to delete pool workspace dir");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(dir: &Path) -> CowPoolConfig {
        CowPoolConfig {
            workspaces_dir: dir.to_owned(),
            base_size: 64 * 1024 * 1024, // 64 MiB
            golden_cow: None,
        }
    }

    // -- State machine tests (no root required) --------------------------------

    #[tokio::test]
    async fn acquire_not_active_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mut pool = CowPool::new(test_config(tmp.path()));
        pool.active = false;
        let err = pool.acquire().await.unwrap_err();
        assert!(
            matches!(err, CowPoolError::NotActive),
            "expected NotActive, got {err}"
        );
    }

    #[tokio::test]
    async fn cleanup_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let mut pool = CowPool::new(test_config(tmp.path()));
        pool.cleanup().await;
        assert!(!pool.active);
        // Second cleanup is a no-op (no panic).
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn warmup_with_bad_config_does_not_panic() {
        // Point to a nonexistent golden COW file — all pre-warm tasks will
        // fail, but warmup must handle errors gracefully.
        let tmp = tempfile::tempdir().unwrap();
        let config = CowPoolConfig {
            workspaces_dir: tmp.path().to_owned(),
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
        };
        let mut pool = CowPool::new(config);
        pool.warmup().await;
        // Queue should be empty (all tasks failed).
        assert_eq!(pool.queue.len(), 0);
        // next_slot_idx should be reclaimed after failures.
        assert_eq!(pool.next_slot_idx, 0);
    }

    #[tokio::test]
    async fn acquire_exhausted_with_bad_config_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let config = CowPoolConfig {
            workspaces_dir: tmp.path().to_owned(),
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
        };
        let mut pool = CowPool::new(config);
        // Don't warmup — go straight to acquire.
        let result = pool.acquire().await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn slot_limit_enforced() {
        let tmp = tempfile::tempdir().unwrap();
        let mut pool = CowPool::new(test_config(tmp.path()));
        pool.next_slot_idx = MAX_SLOTS;
        let err = pool.acquire().await.unwrap_err();
        assert!(
            matches!(err, CowPoolError::SlotLimitReached { max: MAX_SLOTS }),
            "expected SlotLimitReached, got {err}"
        );
    }

    #[test]
    fn create_slot_with_nonexistent_golden_cow_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let config = CowPoolConfig {
            workspaces_dir: tmp.path().to_owned(),
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
        };
        let err = create_slot(&config).unwrap_err();
        assert!(
            matches!(err, CowPoolError::CowFileCreation(_)),
            "expected CowFileCreation, got {err}"
        );
        // Workspace dir should be cleaned up after cow file creation failure.
        let entries: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().collect();
        assert_eq!(
            entries.len(),
            0,
            "workspace dir should be cleaned up on cow file creation failure"
        );
    }

    #[test]
    fn create_slot_fresh_mode_creates_cow_file() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path());
        let slot = create_slot(&config).unwrap();
        let cow_file = slot.cow_file();
        assert!(cow_file.exists(), "COW file should be created");
        let meta = std::fs::metadata(&cow_file).unwrap();
        assert_eq!(meta.len(), 64 * 1024 * 1024, "COW file should be 64 MiB");
        // Cleanup
        destroy_slot(slot);
    }

    #[test]
    fn destroy_slot_removes_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path());
        let slot = create_slot(&config).unwrap();
        let ws = slot.workspace.clone();
        assert!(ws.exists());
        destroy_slot(slot);
        assert!(!ws.exists(), "workspace should be removed");
    }
}
