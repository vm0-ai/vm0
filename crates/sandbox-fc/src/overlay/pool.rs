use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tracing::{error, info, warn};

use super::error::{OverlayError, Result};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Size of each sparse overlay file (2 GiB).
const OVERLAY_SIZE: u64 = 2 * 1024 * 1024 * 1024;

/// File name prefix for overlay files.
const OVERLAY_PREFIX: &str = "overlay-";

/// File extension for overlay files.
const OVERLAY_EXT: &str = ".ext4";

// ---------------------------------------------------------------------------
// OverlayCreator trait
// ---------------------------------------------------------------------------

/// Creates overlay filesystem images.
///
/// Abstracted as a trait so tests can inject a lightweight creator instead
/// of calling `mkfs.ext4`.
#[async_trait]
pub trait OverlayCreator: Send + Sync {
    async fn create(&self, path: &Path) -> Result<()>;
}

/// Fresh-boot creator: sparse file + `mkfs.ext4`.
pub struct Ext4Creator;

#[async_trait]
impl OverlayCreator for Ext4Creator {
    async fn create(&self, path: &Path) -> Result<()> {
        let path_str = path.to_string_lossy();

        // Create a sparse file by writing nothing and truncating to size.
        tokio::fs::File::create(path)
            .await
            .map_err(|e| OverlayError::FileCreation(format!("{path_str}: {e}")))?
            .set_len(OVERLAY_SIZE)
            .await
            .map_err(|e| OverlayError::FileCreation(format!("truncate {path_str}: {e}")))?;

        // Use Command directly to avoid shell injection via path.
        let output = tokio::process::Command::new("mkfs.ext4")
            .args(["-F", "-q"])
            .arg(path)
            .output()
            .await
            .map_err(|e| OverlayError::FileCreation(format!("mkfs.ext4: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(OverlayError::FileCreation(format!(
                "mkfs.ext4 failed: {}",
                stderr.trim()
            )));
        }

        Ok(())
    }
}

/// Snapshot creator: sparse-copies the golden overlay so the VM resumes
/// with the disk state captured in the snapshot.
pub struct SnapshotCopyCreator {
    source: PathBuf,
}

impl SnapshotCopyCreator {
    pub fn new(source: PathBuf) -> Self {
        Self { source }
    }
}

#[async_trait]
impl OverlayCreator for SnapshotCopyCreator {
    async fn create(&self, path: &Path) -> Result<()> {
        let output = tokio::process::Command::new("cp")
            .arg("--sparse=always")
            .arg(&self.source)
            .arg(path)
            .output()
            .await
            .map_err(|e| OverlayError::FileCreation(format!("cp: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(OverlayError::FileCreation(format!(
                "cp failed: {}",
                stderr.trim()
            )));
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Generate a unique overlay file name: `overlay-{UUID}.ext4`.
fn generate_file_name() -> String {
    let id = uuid::Uuid::new_v4();
    format!("{OVERLAY_PREFIX}{id}{OVERLAY_EXT}")
}

/// Check whether a file name matches the overlay naming convention.
fn is_overlay_file(name: &str) -> bool {
    name.starts_with(OVERLAY_PREFIX) && name.ends_with(OVERLAY_EXT)
}

/// Remove all overlay files from a directory (best-effort).
async fn clean_stale_files(dir: &Path) {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if is_overlay_file(&name.to_string_lossy())
            && let Err(e) = tokio::fs::remove_file(entry.path()).await
        {
            warn!(path = %entry.path().display(), error = %e, "failed to remove stale overlay");
        }
    }
}

// ---------------------------------------------------------------------------
// OverlayPoolConfig
// ---------------------------------------------------------------------------

/// Configuration for creating an [`OverlayPool`].
pub struct OverlayPoolConfig {
    /// Number of overlay files to pre-create.
    pub size: usize,
    /// Start replenishment when available count drops below this.
    pub replenish_threshold: usize,
    /// Directory in which overlay files are stored.
    pub pool_dir: PathBuf,
    /// Strategy for creating overlay files.
    pub creator: Box<dyn OverlayCreator>,
}

// ---------------------------------------------------------------------------
// OverlayPool
// ---------------------------------------------------------------------------

/// Pre-warmed pool of overlay filesystem images for Firecracker VMs.
///
/// Maintains a two-tier buffer:
/// - `queue`: ready-to-use files (pre-warmed), returned instantly
/// - `pending`: in-flight background creation tasks
///
/// [`acquire`](Self::acquire) pops from `queue` first, then awaits
/// `pending` results, and falls back to on-demand creation as a last
/// resort. Spawned tasks are pure functions — they never touch pool
/// state directly.
pub struct OverlayPool {
    active: bool,
    queue: VecDeque<PathBuf>,
    /// In-flight overlay creation tasks. Spawned tasks return their
    /// result via the [`JoinSet`](tokio::task::JoinSet) and never
    /// access pool state directly.
    pending: tokio::task::JoinSet<Result<PathBuf>>,
    pool_dir: PathBuf,
    size: usize,
    replenish_threshold: usize,
    creator: Arc<dyn OverlayCreator>,
}

impl OverlayPool {
    /// Create a new pool, pre-warming `config.size` overlay files.
    ///
    /// Creates the pool directory if it doesn't exist, removes stale files
    /// from previous runs, and pre-creates overlay files in parallel.
    pub async fn create(config: OverlayPoolConfig) -> Result<Self> {
        info!(
            size = config.size,
            threshold = config.replenish_threshold,
            dir = %config.pool_dir.display(),
            "initializing overlay pool"
        );

        tokio::fs::create_dir_all(&config.pool_dir)
            .await
            .map_err(|e| OverlayError::FileCreation(format!("mkdir: {e}")))?;

        clean_stale_files(&config.pool_dir).await;

        let creator: Arc<dyn OverlayCreator> = Arc::from(config.creator);
        let mut queue = VecDeque::with_capacity(config.size);

        // Pre-warm via JoinSet
        if config.size > 0 {
            let mut join_set = tokio::task::JoinSet::new();
            for _ in 0..config.size {
                let dir = config.pool_dir.clone();
                let c = Arc::clone(&creator);
                join_set.spawn(async move {
                    let path = dir.join(generate_file_name());
                    c.create(&path).await.map(|()| path)
                });
            }
            while let Some(result) = join_set.join_next().await {
                match result {
                    Ok(Ok(path)) => queue.push_back(path),
                    Ok(Err(e)) => error!(error = %e, "failed to create overlay file"),
                    Err(e) => error!(error = %e, "overlay creation task panicked"),
                }
            }
        }

        let available = queue.len();
        if available < config.size {
            warn!(
                requested = config.size,
                created = available,
                "overlay pool initialized with fewer files than requested"
            );
        }
        info!(available, "overlay pool initialized");

        Ok(Self {
            active: true,
            queue,
            pending: tokio::task::JoinSet::new(),
            pool_dir: config.pool_dir,
            size: config.size,
            replenish_threshold: config.replenish_threshold,
            creator,
        })
    }

    /// Acquire an overlay file from the pool.
    ///
    /// Returns the file path. The caller owns the file and is responsible
    /// for deleting it when the VM stops.
    ///
    /// Tries three tiers in order:
    /// 1. Pop a ready file from the pre-warmed queue (instant)
    /// 2. Await the next in-flight background creation
    /// 3. Create on-demand as a last resort
    pub async fn acquire(&mut self) -> Result<PathBuf> {
        if !self.active {
            return Err(OverlayError::NotInitialized);
        }

        // Tier 1: pre-warmed queue.
        if let Some(path) = self.queue.pop_front() {
            info!(remaining = self.queue.len(), "acquired overlay from pool");
            self.maybe_replenish();
            return Ok(path);
        }

        // Tier 2: wait for a pending background task.
        while let Some(result) = self.pending.join_next().await {
            match result {
                Ok(Ok(path)) => {
                    info!("acquired overlay from pending task");
                    self.maybe_replenish();
                    return Ok(path);
                }
                Ok(Err(e)) => error!(error = %e, "replenish: failed to create overlay"),
                Err(e) => error!(error = %e, "replenish: task panicked"),
            }
        }

        // Tier 3: on-demand.
        info!("pool exhausted, creating overlay on-demand");
        let path = self.pool_dir.join(generate_file_name());
        self.creator.create(&path).await?;
        self.maybe_replenish();
        Ok(path)
    }

    /// Release an overlay file back to the pool by deleting it.
    ///
    /// Unlike network namespaces, overlay files are not reusable — each VM
    /// writes unique data. This simply removes the file from disk.
    pub async fn release(&mut self, path: PathBuf) {
        if let Err(e) = tokio::fs::remove_file(&path).await {
            warn!(path = %path.display(), error = %e, "failed to delete overlay");
        }
    }

    /// Delete all queued overlay files and cancel in-flight creations.
    pub async fn cleanup(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;

        // Cancel all in-flight creation tasks.
        self.pending.abort_all();

        // Wait for cancelled/completed tasks and delete their files.
        while let Some(result) = self.pending.join_next().await {
            if let Ok(Ok(path)) = result {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }

        info!(count = self.queue.len(), "cleaning up overlay pool");

        // Delete queued files.
        for path in self.queue.drain(..) {
            if let Err(e) = tokio::fs::remove_file(&path).await {
                warn!(path = %path.display(), error = %e, "failed to delete queued overlay");
            }
        }

        // Remove any orphaned files (e.g., partially created by aborted tasks).
        clean_stale_files(&self.pool_dir).await;

        info!("overlay pool cleanup complete");
    }

    /// Number of overlay files ready for immediate use.
    #[cfg(test)]
    pub fn available_count(&self) -> usize {
        self.queue.len()
    }

    /// Spawn background creation tasks if the pool is running low.
    fn maybe_replenish(&mut self) {
        let total = self.queue.len() + self.pending.len();
        if total >= self.replenish_threshold {
            return;
        }
        let needed = self.size.saturating_sub(total);
        for _ in 0..needed {
            let dir = self.pool_dir.clone();
            let c = Arc::clone(&self.creator);
            self.pending.spawn(async move {
                let path = dir.join(generate_file_name());
                c.create(&path).await.map(|()| path)
            });
        }
        if needed > 0 {
            info!(needed, "spawned overlay replenish tasks");
        }
    }
}

impl Drop for OverlayPool {
    fn drop(&mut self) {
        if self.active {
            warn!(
                queued = self.queue.len(),
                pending = self.pending.len(),
                "OverlayPool dropped without calling cleanup()"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Lightweight test creator — writes a tiny file instead of calling mkfs.ext4.
    struct TestCreator;

    #[async_trait]
    impl OverlayCreator for TestCreator {
        async fn create(&self, path: &Path) -> Result<()> {
            tokio::fs::write(path, b"test-overlay")
                .await
                .map_err(|e| OverlayError::FileCreation(e.to_string()))?;
            Ok(())
        }
    }

    /// Creator that always fails — for testing pre-warm failure degradation.
    struct FailingCreator;

    #[async_trait]
    impl OverlayCreator for FailingCreator {
        async fn create(&self, _path: &Path) -> Result<()> {
            Err(OverlayError::FileCreation("intentional failure".into()))
        }
    }

    fn test_config(dir: &Path, size: usize, threshold: usize) -> OverlayPoolConfig {
        OverlayPoolConfig {
            size,
            replenish_threshold: threshold,
            pool_dir: dir.to_path_buf(),
            creator: Box::new(TestCreator),
        }
    }

    #[test]
    fn generate_file_name_format() {
        let name = generate_file_name();
        assert!(name.starts_with(OVERLAY_PREFIX));
        assert!(name.ends_with(OVERLAY_EXT));
        // overlay- (8) + uuid (36) + .ext4 (5) = 49
        assert_eq!(name.len(), 49);
    }

    #[test]
    fn is_overlay_file_matches() {
        assert!(is_overlay_file(
            "overlay-550e8400-e29b-41d4-a716-446655440000.ext4"
        ));
        assert!(is_overlay_file("overlay-anything.ext4"));
    }

    #[test]
    fn is_overlay_file_rejects() {
        assert!(!is_overlay_file("rootfs.ext4"));
        assert!(!is_overlay_file("overlay-.img"));
        assert!(!is_overlay_file("something-overlay-.ext4"));
        assert!(!is_overlay_file("overlay-test.ext3"));
        assert!(!is_overlay_file(""));
    }

    #[tokio::test]
    async fn create_prewarms_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 3, 1))
            .await
            .expect("create");

        assert_eq!(pool.available_count(), 3);

        let entries: Vec<_> = std::fs::read_dir(tmp.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 3);
        for entry in &entries {
            assert!(is_overlay_file(&entry.file_name().to_string_lossy()));
        }

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn create_cleans_stale_files() {
        let tmp = tempfile::tempdir().expect("tempdir");

        // Plant stale files.
        let stale = tmp.path().join("overlay-stale-id.ext4");
        std::fs::write(&stale, b"stale").expect("write");
        assert!(stale.exists());

        let mut pool = OverlayPool::create(test_config(tmp.path(), 1, 1))
            .await
            .expect("create");

        // Stale file should be gone; only the newly created one remains.
        assert_eq!(pool.available_count(), 1);
        assert!(!stale.exists());

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn acquire_returns_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 2, 1))
            .await
            .expect("create");

        let path = pool.acquire().await.expect("acquire");
        assert!(path.exists());
        assert!(is_overlay_file(
            path.file_name().expect("file_name").to_str().expect("str")
        ));

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn acquire_returns_unique_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 3, 1))
            .await
            .expect("create");

        let a = pool.acquire().await.expect("acquire 1");
        let b = pool.acquire().await.expect("acquire 2");
        let c = pool.acquire().await.expect("acquire 3");

        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn acquire_when_queue_exhausted() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 1, 1))
            .await
            .expect("create");

        let _first = pool.acquire().await.expect("acquire pooled");
        assert_eq!(pool.available_count(), 0);

        // Queue is empty but maybe_replenish spawned a pending task,
        // so the second acquire comes from Tier 2 (pending).
        let second = pool.acquire().await.expect("acquire from pending");
        assert!(second.exists());

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn acquire_from_replenished_pending() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // size=2, threshold=2: acquiring the first file triggers replenishment,
        // so the second acquire should come from a pending task (Tier 2).
        let mut pool = OverlayPool::create(test_config(tmp.path(), 2, 2))
            .await
            .expect("create");

        let first = pool.acquire().await.expect("acquire 1 (pooled)");
        assert!(first.exists());

        // Queue is now empty, but maybe_replenish() should have spawned tasks.
        // The second acquire hits Tier 2 (pending JoinSet).
        let second = pool.acquire().await.expect("acquire 2 (replenished)");
        assert!(second.exists());
        assert_ne!(first, second);

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn create_with_size_zero() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 0, 0))
            .await
            .expect("create");

        assert_eq!(pool.available_count(), 0);

        // acquire still works via on-demand (Tier 3).
        let path = pool.acquire().await.expect("acquire on-demand");
        assert!(path.exists());

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn create_succeeds_when_all_prewarm_fail() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config = OverlayPoolConfig {
            size: 3,
            replenish_threshold: 1,
            pool_dir: tmp.path().to_path_buf(),
            creator: Box::new(FailingCreator),
        };
        let mut pool = OverlayPool::create(config).await.expect("create");

        // Pool created successfully but with zero pre-warmed files.
        assert_eq!(pool.available_count(), 0);

        pool.cleanup().await;
    }

    #[tokio::test]
    async fn cleanup_deletes_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 3, 1))
            .await
            .expect("create");

        pool.cleanup().await;

        let entries: Vec<_> = std::fs::read_dir(tmp.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| is_overlay_file(&e.file_name().to_string_lossy()))
            .collect();
        assert_eq!(entries.len(), 0);
        assert_eq!(pool.available_count(), 0);
    }

    #[tokio::test]
    async fn cleanup_noop_after_cleanup() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 2, 1))
            .await
            .expect("create");

        pool.cleanup().await;
        // Second cleanup should be a no-op, not panic.
        pool.cleanup().await;
        assert_eq!(pool.available_count(), 0);
    }

    #[tokio::test]
    async fn acquire_after_cleanup_errors() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut pool = OverlayPool::create(test_config(tmp.path(), 2, 1))
            .await
            .expect("create");

        pool.cleanup().await;

        let result = pool.acquire().await;
        assert!(result.is_err());
        assert!(
            matches!(result, Err(OverlayError::NotInitialized)),
            "expected NotInitialized, got {result:?}"
        );
    }
}
