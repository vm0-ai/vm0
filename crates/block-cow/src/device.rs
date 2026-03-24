use std::fs;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

use crate::error::{BlockCowError, Result};
use crate::{blockdev, dmsetup, losetup};

/// Default dm-snapshot chunk size in 512-byte sectors.
/// 8 sectors = 4KB, matching the common filesystem block size.
const DEFAULT_CHUNK_SIZE: u32 = 8;

/// Configuration for creating a [`CowDevice`].
pub struct CowDeviceConfig {
    /// Path to the base ext4 image (read-only, shared across VMs).
    pub base_image: PathBuf,
    /// Directory for per-VM COW sparse files.
    pub cow_dir: PathBuf,
    /// dm-snapshot chunk size in 512-byte sectors (default: 8 = 4KB).
    pub chunk_size: Option<u32>,
}

/// A block-level copy-on-write device backed by Linux dm-snapshot.
///
/// Orchestrates loop devices and device mapper to present a single writable
/// block device where reads of unmodified blocks go to the base image and
/// writes are captured in a per-VM sparse COW file.
///
/// # Lifecycle
///
/// ```text
/// CowDevice::create(config)
///   → base.ext4 ──losetup──→ /dev/loop0 (read-only)
///   → cow-{id}.img ──losetup──→ /dev/loop1
///   → dmsetup create origin-{id}: linear /dev/loop0
///   → dmsetup create cow-{id}: snapshot origin-{id} /dev/loop1
///   → /dev/mapper/cow-{id}
///
/// CowDevice::destroy()
///   → dmsetup remove cow-{id}
///   → dmsetup remove origin-{id}
///   → losetup -d /dev/loop1
///   → losetup -d /dev/loop0
///   → rm cow-{id}.img
/// ```
pub struct CowDevice {
    /// Unique identifier for this device (used in dm target names).
    id: String,
    /// The block device path for Firecracker: `/dev/mapper/cow-{id}`.
    device_path: PathBuf,
    /// Loop device for the base image.
    base_loop: PathBuf,
    /// Loop device for the COW sparse file.
    cow_loop: PathBuf,
    /// Path to the COW sparse file on disk.
    cow_file: PathBuf,
    /// Whether the device is currently active.
    active: bool,
}

impl CowDevice {
    /// Create a new COW device backed by the given base image.
    ///
    /// This creates a fresh sparse COW file in `config.cow_dir` and sets up
    /// loop devices and dm-snapshot targets. The resulting block device at
    /// [`device_path`](Self::device_path) can be passed to Firecracker.
    pub fn create(config: &CowDeviceConfig) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        Self::setup(config, &id, None)
    }

    /// Restore a COW device from a previously persisted COW file.
    ///
    /// Used for snapshot restore: reuses an existing COW file instead of
    /// creating a new one. The COW file retains all prior writes.
    ///
    /// On failure the caller retains ownership of `cow_file` and is
    /// responsible for cleanup.
    pub fn restore(config: &CowDeviceConfig, cow_file: PathBuf) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        Self::setup(config, &id, Some(cow_file))
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

    /// Tear down: remove dm targets, detach loop devices, delete COW file.
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

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn setup(config: &CowDeviceConfig, id: &str, existing_cow: Option<PathBuf>) -> Result<Self> {
        let chunk_size = config.chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE);
        let origin_name = format!("origin-{id}");
        let cow_name = format!("cow-{id}");

        // 1. Attach base image to a read-only loop device.
        let base_loop = losetup::attach(&config.base_image, true)?;
        info!(base_loop = %base_loop.display(), "attached base image");

        // 2. Get the base image size in sectors.
        let sectors = match blockdev::get_size_sectors(&base_loop) {
            Ok(s) => s,
            Err(e) => {
                let _ = losetup::detach(&base_loop);
                return Err(e);
            }
        };

        // 3. Create or reuse COW sparse file and attach to loop device.
        let created_cow = existing_cow.is_none();
        let cow_file = match existing_cow {
            Some(path) => path,
            None => {
                let create_cow = || -> Result<PathBuf> {
                    fs::create_dir_all(&config.cow_dir)?;
                    let path = config.cow_dir.join(format!("cow-{id}.img"));
                    let f = fs::File::create(&path)?;
                    // Sparse file: same size as base so dm-snapshot has room
                    // for a full overwrite. Actual disk usage starts at 0.
                    f.set_len(sectors * 512)?;
                    Ok(path)
                };
                match create_cow() {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = losetup::detach(&base_loop);
                        return Err(e);
                    }
                }
            }
        };

        let cow_loop = match losetup::attach(&cow_file, false) {
            Ok(l) => l,
            Err(e) => {
                if created_cow {
                    let _ = fs::remove_file(&cow_file);
                }
                let _ = losetup::detach(&base_loop);
                return Err(e);
            }
        };
        info!(cow_loop = %cow_loop.display(), "attached COW file");

        // 4. Create dm-linear origin target.
        let base_loop_str = base_loop.to_string_lossy();
        if let Err(e) = dmsetup::create_linear(&origin_name, &base_loop_str, sectors) {
            let _ = losetup::detach(&cow_loop);
            let _ = losetup::detach(&base_loop);
            if created_cow {
                let _ = fs::remove_file(&cow_file);
            }
            return Err(e);
        }

        // 5. Create dm-snapshot target.
        let origin_path = format!("/dev/mapper/{origin_name}");
        let cow_loop_str = cow_loop.to_string_lossy();
        let device_path = match dmsetup::create_snapshot(
            &cow_name,
            &origin_path,
            &cow_loop_str,
            sectors,
            chunk_size,
        ) {
            Ok(p) => p,
            Err(e) => {
                let _ = dmsetup::remove(&origin_name);
                let _ = losetup::detach(&cow_loop);
                let _ = losetup::detach(&base_loop);
                if created_cow {
                    let _ = fs::remove_file(&cow_file);
                }
                return Err(e);
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
            base_loop,
            cow_loop,
            cow_file,
            active: true,
        })
    }

    fn teardown(&mut self, delete_cow_file: bool) -> Result<()> {
        if !self.active {
            return Err(BlockCowError::NotActive(self.id.clone()));
        }

        let cow_name = format!("cow-{}", self.id);
        let origin_name = format!("origin-{}", self.id);

        // Teardown respects the dependency chain:
        //   snapshot → origin → (cow_loop, base_loop) → cow_file
        //
        // If snapshot removal fails (device busy), the origin and loop
        // devices are still in use — attempting to remove them would also
        // fail. So we bail early and let the caller retry later.
        //
        // Once the snapshot is removed, everything else is independent
        // and proceeds best-effort.

        // Step 1: remove the snapshot target. This is the only step that
        // can legitimately fail due to "device busy" (Firecracker still
        // has the device open). If it fails, bail — nothing else can be
        // cleaned up yet.
        if let Err(e) = dmsetup::remove(&cow_name) {
            warn!(name = cow_name, error = %e, "failed to remove snapshot target — device may be in use");
            return Err(e);
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

        record(dmsetup::remove(&origin_name), "remove origin target");
        record(losetup::detach(&self.cow_loop), "detach COW loop");
        record(losetup::detach(&self.base_loop), "detach base loop");

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
            // Best-effort: try to tear down, ignore errors.
            let _ = self.teardown(true);
        }
    }
}
