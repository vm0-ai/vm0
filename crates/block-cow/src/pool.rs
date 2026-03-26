use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

use crate::blockdev;
use crate::error::Result;
use crate::losetup::{self, LoopDevice};

/// A shared base loop device with reference count.
struct BaseEntry {
    /// The attached loop device (path + holder fd for GC protection).
    loop_dev: LoopDevice,
    /// Size of the base image in 512-byte sectors.
    sectors: u64,
    /// Number of active users (COW devices) sharing this loop.
    refcount: usize,
}

/// Handle returned by [`BaseImagePool::acquire`].
///
/// Contains everything a [`CowDevice`](crate::CowDevice) needs from the
/// base image without managing the loop device lifetime.
pub struct BaseHandle {
    /// Path to the read-only loop device for the base image.
    pub loop_path: PathBuf,
    /// Size of the base image in 512-byte sectors.
    pub sectors: u64,
    /// Key for releasing back to the pool (canonical base image path).
    base_key: PathBuf,
}

impl BaseHandle {
    /// The canonical base image path (used for pool release).
    pub fn base_key(&self) -> &Path {
        &self.base_key
    }
}

/// Pool of shared read-only loop devices for base images.
///
/// Multiple [`CowDevice`](crate::CowDevice)s backed by the same base image
/// share a single read-only loop device, reducing kernel resource usage by
/// half (no per-sandbox base loop or dm-linear origin).
///
/// # Async usage
///
/// All methods call synchronous subprocess commands (`losetup`, `blockdev`).
/// When used from an async context, wrap calls in `tokio::task::spawn_blocking`
/// to avoid blocking the runtime.
///
/// # Lifecycle
///
/// ```text
/// pool.acquire("/path/to/rootfs.ext4")
///   → first call: losetup --find --show --read-only
///   → subsequent: refcount++ and return existing loop path
///
/// pool.release("/path/to/rootfs.ext4")
///   → refcount-- ; if 0: losetup -d
///
/// pool.cleanup()
///   → detach ALL remaining loop devices (safety net on shutdown)
/// ```
pub struct BaseImagePool {
    entries: HashMap<PathBuf, BaseEntry>,
}

impl Default for BaseImagePool {
    fn default() -> Self {
        Self::new()
    }
}

impl BaseImagePool {
    /// Create an empty pool.
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Acquire a shared base loop device for the given image.
    ///
    /// If the image is already loaded, increments the reference count.
    /// Otherwise, attaches a new read-only loop device.
    pub fn acquire(&mut self, base_image: &Path) -> Result<BaseHandle> {
        // Canonicalize so the same file accessed via different paths
        // (symlinks, relative paths) maps to a single pool entry.
        let key = std::fs::canonicalize(base_image)?;

        if let Some(entry) = self.entries.get_mut(&key) {
            entry.refcount += 1;
            info!(
                base = %base_image.display(),
                loop_dev = %entry.loop_dev.path().display(),
                refcount = entry.refcount,
                "base image pool: reusing existing loop"
            );
            return Ok(BaseHandle {
                loop_path: entry.loop_dev.path().to_owned(),
                sectors: entry.sectors,
                base_key: key,
            });
        }

        // First user — attach a new read-only loop device.
        let mut loop_dev = losetup::attach(base_image, true)?;
        let sectors = match blockdev::get_size_sectors(loop_dev.path()) {
            Ok(s) => s,
            Err(e) => {
                let _ = loop_dev.detach();
                return Err(e);
            }
        };

        info!(
            base = %base_image.display(),
            loop_dev = %loop_dev.path().display(),
            sectors,
            "base image pool: attached new loop"
        );

        let handle = BaseHandle {
            loop_path: loop_dev.path().to_owned(),
            sectors,
            base_key: key.clone(),
        };

        self.entries.insert(
            key,
            BaseEntry {
                loop_dev,
                sectors,
                refcount: 1,
            },
        );

        Ok(handle)
    }

    /// Release a reference to a base image.
    ///
    /// When the last reference is released, the loop device is detached.
    pub fn release(&mut self, base_key: &Path) -> Result<()> {
        let key = base_key.to_path_buf();
        let entry = match self.entries.get_mut(&key) {
            Some(e) => e,
            None => {
                warn!(
                    base = %base_key.display(),
                    "base image pool: release called for unknown image"
                );
                return Ok(());
            }
        };

        if entry.refcount == 0 {
            // Retry detach for a previously failed release (detach returned
            // an error so the entry stayed in the map for cleanup).
            warn!(
                base = %base_key.display(),
                "base image pool: retrying detach for stuck entry (refcount=0)"
            );
            entry.loop_dev.detach()?;
            self.entries.remove(&key);
            return Ok(());
        }
        entry.refcount -= 1;
        if entry.refcount == 0 {
            info!(
                base = %base_key.display(),
                loop_dev = %entry.loop_dev.path().display(),
                "base image pool: detaching loop (refcount=0)"
            );
            // Detach first — if it fails, the entry stays in the map
            // so cleanup() or a subsequent release() can retry later.
            entry.loop_dev.detach()?;
            self.entries.remove(&key);
        } else {
            info!(
                base = %base_key.display(),
                refcount = entry.refcount,
                "base image pool: released reference"
            );
        }

        Ok(())
    }

    /// Best-effort cleanup: detach all remaining loop devices.
    ///
    /// Called during shutdown as a safety net. Logs warnings for failures
    /// but does not propagate errors.
    pub fn cleanup(&mut self) {
        for (key, mut entry) in self.entries.drain() {
            if let Err(e) = entry.loop_dev.detach() {
                warn!(
                    base = %key.display(),
                    loop_dev = %entry.loop_dev.path().display(),
                    error = %e,
                    "base image pool: cleanup failed to detach loop"
                );
            } else {
                info!(
                    base = %key.display(),
                    loop_dev = %entry.loop_dev.path().display(),
                    "base image pool: cleanup detached loop"
                );
            }
        }
    }
}

impl Drop for BaseImagePool {
    fn drop(&mut self) {
        if !self.entries.is_empty() {
            warn!(
                count = self.entries.len(),
                "BaseImagePool dropped with active entries — detaching loops"
            );
            self.cleanup();
        }
    }
}
