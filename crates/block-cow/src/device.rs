use std::fs;
use std::path::{Path, PathBuf};

use tracing::{info, trace, warn};

use crate::dmsetup;
use crate::error::{BlockCowError, Result};
use crate::losetup::{self, LoopDevice};

/// Linux sector size in bytes.
const SECTOR_SIZE: u64 = 512;

/// Default dm-snapshot chunk size in sectors.
/// 8 sectors × 512 bytes = 4KB, matching the common filesystem block size.
const DEFAULT_CHUNK_SIZE: u32 = 4096 / SECTOR_SIZE as u32;

/// Create an empty sparse COW file sized to match the base image.
///
/// The file is sparse: logical size equals `sectors * SECTOR_SIZE` but actual
/// disk usage starts at 0. Creates parent directories if needed.
pub fn init_cow_file(path: &Path, sectors: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let f = fs::File::create(path)?;
    let size_bytes = sectors.checked_mul(SECTOR_SIZE).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sector count overflow: {sectors} * {SECTOR_SIZE}"),
        )
    })?;
    f.set_len(size_bytes)?;
    Ok(())
}

/// Configuration for creating a [`CowDevice`].
pub struct CowDeviceConfig {
    /// Path to the COW file (e.g. `{workspace}/cow.img`).
    /// Must already exist — use [`init_cow_file`] or `cp --sparse=always`
    /// to prepare it before calling [`CowDevice::create`].
    pub cow_file: PathBuf,
}

/// A block-level copy-on-write device backed by Linux dm-snapshot.
///
/// Orchestrates a COW loop device and device mapper to present a single
/// writable block device where reads of unmodified blocks go to the shared
/// base image (via [`BaseLoopCache`](crate::BaseLoopCache)) and writes are
/// captured in a per-VM sparse COW file.
///
/// # Lifecycle
///
/// ```text
/// BaseLoopCache::acquire(rootfs.ext4) → base_handle (shared loop device)
///
/// // Fresh boot — caller creates empty sparse file:
/// init_cow_file("cow.img", sectors)?;
/// // Snapshot restore — caller copies golden COW:
/// cp --sparse=always golden.img cow.img
///
/// CowDevice::create(base_handle, config)
///   → cow.img ──losetup──→ /dev/loop1
///   → dmsetup create cow-{id}: snapshot <base_loop> /dev/loop1
///   → /dev/mapper/cow-{id}
///
/// CowDevice::destroy()
///   → dmsetup remove cow-{id}
///   → losetup -d /dev/loop1
///   → rm cow.img
///
/// BaseLoopCache::release() → detaches base loop when refcount hits 0
/// ```
pub struct CowDevice {
    /// Unique identifier for this device (used in dm target names).
    id: String,
    /// The block device path for Firecracker: `/dev/mapper/cow-{id}`.
    device_path: PathBuf,
    /// Loop device for the COW sparse file (path + holder fd).
    cow_loop: LoopDevice,
    /// Path to the COW sparse file on disk.
    cow_file: PathBuf,
    /// Open fd on the dm device — keeps open count > 0 so that
    /// `dmsetup remove` from GC returns EBUSY for active devices.
    _device_holder: Option<fs::File>, // None only after teardown drops it
    /// Whether the device is currently active.
    active: bool,
}

impl CowDevice {
    /// Create a COW device from an existing COW file.
    ///
    /// `base_loop` is the read-only loop device path from
    /// [`BaseLoopCache::acquire`](crate::BaseLoopCache::acquire).
    /// `sectors` is the base image size in 512-byte sectors.
    ///
    /// The COW file at `config.cow_file` must already exist — either
    /// freshly created via [`init_cow_file`] or copied from a snapshot's
    /// golden COW file.
    ///
    /// On failure the COW file is left on disk for the caller to clean up.
    pub fn create(base_loop: &Path, sectors: u64, config: &CowDeviceConfig) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let chunk_size = DEFAULT_CHUNK_SIZE;
        let cow_name = format!("cow-{id}");
        let cow_file = &config.cow_file;

        // 1. Attach COW file to a loop device.
        let mut cow_loop = losetup::attach(cow_file, false)?;
        info!(cow_loop = %cow_loop.path().display(), "attached COW file");

        // 2. Create dm-snapshot target directly on the shared base loop device.
        //
        //    No dm-linear origin needed — the base loop is read-only and shared
        //    across all COW devices via BaseLoopCache.
        //
        //    dm devices default to root:disk 0660.  The runner user must be in
        //    the `disk` group to open the device.
        let base_loop_str = base_loop.to_string_lossy();
        let cow_loop_str = cow_loop.path().to_string_lossy().into_owned();
        let device_path = match dmsetup::create_snapshot(
            &cow_name,
            &base_loop_str,
            &cow_loop_str,
            sectors,
            chunk_size,
        ) {
            Ok(p) => p,
            Err(e) => {
                let _ = cow_loop.detach();
                return Err(e);
            }
        };

        // 3. Hold the dm device open so its open count stays > 0.
        //    This prevents concurrent GC from removing the target via
        //    `dmsetup remove` (which returns EBUSY when openers exist).
        let device_holder = match fs::File::open(&device_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = dmsetup::remove(&cow_name);
                let _ = cow_loop.detach();
                return Err(BlockCowError::Io(e));
            }
        };

        info!(
            device = %device_path.display(),
            id,
            sectors,
            chunk_size,
            "COW device created"
        );

        Ok(Self {
            id: id.to_owned(),
            device_path,
            cow_loop,
            cow_file: cow_file.to_owned(),
            _device_holder: Some(device_holder),
            active: true,
        })
    }

    /// Create a COW device from a pre-attached loop device.
    ///
    /// Used by the COW pool which pre-warms loop devices in the background.
    /// Only performs: `dmsetup create` + open holder fd.
    ///
    /// `id` is the caller-provided identifier (typically the sandbox ID)
    /// used in the dm target name (`cow-{id}`).
    /// `cow_loop` is the pre-attached loop device (with holder fd).
    /// `cow_file` is the path to the COW file on disk.
    /// `base_loop` is the shared read-only base loop device path.
    /// `sectors` is the base image size in 512-byte sectors.
    ///
    /// On failure the loop device is detached (best-effort) since the
    /// caller has given up ownership by passing it by value.
    pub fn create_from_loop(
        id: String,
        mut cow_loop: LoopDevice,
        cow_file: PathBuf,
        base_loop: &Path,
        sectors: u64,
    ) -> Result<Self> {
        let chunk_size = DEFAULT_CHUNK_SIZE;
        let cow_name = format!("cow-{id}");

        let base_loop_str = base_loop.to_string_lossy();
        let cow_loop_str = cow_loop.path().to_string_lossy().into_owned();
        let device_path = match dmsetup::create_snapshot(
            &cow_name,
            &base_loop_str,
            &cow_loop_str,
            sectors,
            chunk_size,
        ) {
            Ok(p) => p,
            Err(e) => {
                let _ = cow_loop.detach();
                return Err(e);
            }
        };

        let device_holder = match fs::File::open(&device_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = dmsetup::remove(&cow_name);
                let _ = cow_loop.detach();
                return Err(BlockCowError::Io(e));
            }
        };

        info!(
            device = %device_path.display(),
            id,
            sectors,
            chunk_size,
            "COW device created from pre-warmed loop"
        );

        Ok(Self {
            id,
            device_path,
            cow_loop,
            cow_file,
            _device_holder: Some(device_holder),
            active: true,
        })
    }

    /// Path to the block device (e.g. `/dev/mapper/cow-{id}`).
    ///
    /// Pass this to Firecracker as `path_on_host` for the rootfs drive.
    pub fn device_path(&self) -> &Path {
        &self.device_path
    }

    /// Path to the COW sparse file on disk.
    ///
    /// Use this to persist the COW state for snapshot support (e.g. copy
    /// the file before calling [`destroy`](Self::destroy)).
    pub fn cow_file(&self) -> &Path {
        &self.cow_file
    }

    /// Log dm-snapshot status (COW allocation) for debugging.
    pub fn log_status(&self) {
        let cow_name = format!("cow-{}", self.id);
        match dmsetup::status(&cow_name) {
            Ok(s) => info!(id = self.id, status = %s, "dm-snapshot status"),
            Err(e) => warn!(id = self.id, error = %e, "dm-snapshot status query failed"),
        }
    }

    /// Tear down: remove dm target, detach COW loop device, delete COW file.
    ///
    /// Takes `&mut self` so the caller can retry on failure. On success the
    /// device is marked inactive and [`Drop`] becomes a no-op.
    pub fn destroy(&mut self) -> Result<()> {
        self.teardown(true)
    }

    /// Tear down but keep the COW file for snapshot preservation.
    ///
    /// Takes `&mut self` so the caller can retry on failure.
    pub fn destroy_keep_cow(&mut self) -> Result<()> {
        self.teardown(false)
    }

    /// Schedule deferred removal: remove dm target, detach COW loop, delete COW file.
    ///
    /// Uses `dmsetup remove --force` (`DM_DEFERRED_REMOVE`) so the kernel
    /// removes the target when all openers release their file descriptors.
    /// Use as a last resort after [`destroy`] retries are exhausted.
    pub fn destroy_deferred(&mut self) -> Result<()> {
        self.teardown_deferred(true)
    }

    /// Schedule deferred removal but keep the COW file for snapshot preservation.
    ///
    /// Uses `dmsetup remove --force` (`DM_DEFERRED_REMOVE`).
    /// Use as a last resort after [`destroy_keep_cow`] retries are exhausted.
    pub fn destroy_deferred_keep_cow(&mut self) -> Result<()> {
        self.teardown_deferred(false)
    }

    /// Mark the device as inactive without performing cleanup.
    ///
    /// Use this after exhausting retries on [`destroy`] — the caller has
    /// given up and will rely on GC to clean up the orphaned dm targets.
    /// Prevents [`Drop`] from logging a redundant warning.
    pub fn abandon(&mut self) {
        warn!(
            id = self.id,
            "COW device abandoned — relying on GC for cleanup"
        );
        self.active = false;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Best-effort deferred teardown.
    ///
    /// Unlike [`teardown`], this does NOT require `active == true`.
    /// It can clean up abandoned devices where the dm target and loop
    /// device were leaked.  All steps are best-effort; only the
    /// `dmsetup remove --force` result is propagated.
    fn teardown_deferred(&mut self, delete_cow_file: bool) -> Result<()> {
        let cow_name = format!("cow-{}", self.id);

        // Drop our dm holder fd so we don't contribute to the open count.
        self._device_holder = None;
        dmsetup::remove_deferred(&cow_name)?;

        // Past the point of no return — the kernel will remove the target
        // when the last opener (Firecracker) releases its fd.
        self.active = false;

        // Best-effort: `losetup -d` on a busy loop device sets AUTOCLEAR
        // and returns success.  The kernel auto-detaches the loop when dm
        // releases its reference.
        let _ = self.cow_loop.detach();

        if delete_cow_file {
            let _ = fs::remove_file(&self.cow_file);
        }

        info!(
            id = self.id,
            keep_cow = !delete_cow_file,
            "COW device scheduled for deferred removal"
        );

        Ok(())
    }

    fn teardown(&mut self, delete_cow_file: bool) -> Result<()> {
        if !self.active {
            return Err(BlockCowError::NotActive(self.id.clone()));
        }

        let cow_name = format!("cow-{}", self.id);

        // Teardown dependency chain:
        //   dm-snapshot → cow_loop → cow_file
        //
        // If snapshot removal fails (device busy), the cow loop device is
        // still in use — attempting to detach it would also fail. So we
        // bail early and let the caller retry later.
        //
        // Once the snapshot is removed, everything else is independent
        // and proceeds best-effort.

        // Step 1: remove the snapshot target. Drop our dm holder fd first
        // so we don't contribute to the open count.  Firecracker may still
        // have the device open — if so, dmsetup remove fails with EBUSY
        // and we bail to let the caller retry.
        //
        // After dropping the holder fd, udev may briefly open the device to
        // rescan metadata. Retry a few times with a short sleep to let
        // transient openers (udev) release their references.
        self._device_holder = None;
        for attempt in 0..3u32 {
            match dmsetup::remove(&cow_name) {
                Ok(()) => break,
                Err(e) if attempt < 2 => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    trace!(id = self.id, attempt, error = %e, "dmsetup remove busy, retrying");
                }
                Err(e) => return Err(e),
            }
        }

        // Snapshot is gone — past the point of no return. Mark inactive
        // so Drop won't retry the (already succeeded) snapshot removal.
        // Everything below is best-effort.
        self.active = false;

        let mut first_error: Option<BlockCowError> = None;
        let mut record = |result: Result<()>, context: &str| {
            if let Err(e) = result {
                warn!(id = %self.id, context, error = %e, "teardown step failed");
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        };

        record(self.cow_loop.detach(), "detach COW loop");

        if delete_cow_file {
            record(
                fs::remove_file(&self.cow_file).map_err(Into::into),
                "delete COW file",
            );
        }

        info!(
            id = self.id,
            keep_cow = !delete_cow_file,
            "COW device torn down"
        );

        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

impl Drop for CowDevice {
    fn drop(&mut self) {
        if self.active {
            warn!(
                id = self.id,
                "CowDevice dropped without calling destroy() — attempting best-effort cleanup"
            );
            if let Err(e) = self.teardown(true) {
                warn!(id = self.id, error = %e, "best-effort teardown failed, trying deferred removal");
                if let Err(e) = self.teardown_deferred(true) {
                    warn!(id = self.id, error = %e, "deferred removal also failed");
                }
            }
        }
    }
}
