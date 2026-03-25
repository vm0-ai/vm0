use std::fs;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

use crate::dmsetup;
use crate::error::{BlockCowError, Result};
use crate::losetup::{self, LoopDevice};

/// Default dm-snapshot chunk size in 512-byte sectors.
/// 8 sectors = 4KB, matching the common filesystem block size.
const DEFAULT_CHUNK_SIZE: u32 = 8;

/// Configuration for creating a [`CowDevice`].
pub struct CowDeviceConfig {
    /// Directory for per-VM COW sparse files.
    pub cow_dir: PathBuf,
    /// dm-snapshot chunk size in 512-byte sectors (default: 8 = 4KB).
    pub chunk_size: Option<u32>,
}

/// A block-level copy-on-write device backed by Linux dm-snapshot.
///
/// Orchestrates a COW loop device and device mapper to present a single
/// writable block device where reads of unmodified blocks go to the shared
/// base image (via [`BaseImagePool`](crate::BaseImagePool)) and writes are
/// captured in a per-VM sparse COW file.
///
/// # Lifecycle
///
/// ```text
/// BaseImagePool::acquire(rootfs.ext4) → base_handle (shared loop device)
///
/// CowDevice::create(base_handle, config)
///   → cow-{id}.img ──losetup──→ /dev/loop1
///   → dmsetup create cow-{id}: snapshot <base_loop> /dev/loop1
///   → /dev/mapper/cow-{id}
///
/// CowDevice::destroy()
///   → dmsetup remove cow-{id}
///   → losetup -d /dev/loop1
///   → rm cow-{id}.img
///
/// BaseImagePool::release() → detaches base loop when refcount hits 0
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
    /// Create a new COW device backed by a shared base loop device.
    ///
    /// `base_loop` is the read-only loop device path from
    /// [`BaseImagePool::acquire`](crate::BaseImagePool::acquire).
    /// `sectors` is the base image size in 512-byte sectors.
    ///
    /// This creates a fresh sparse COW file in `config.cow_dir` and sets up
    /// a COW loop device and dm-snapshot target. The resulting block device at
    /// [`device_path`](Self::device_path) can be passed to Firecracker.
    pub fn create(base_loop: &Path, sectors: u64, config: &CowDeviceConfig) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        Self::setup(base_loop, sectors, config, &id, None)
    }

    /// Restore a COW device from a previously persisted COW file.
    ///
    /// Used for snapshot restore: reuses an existing COW file instead of
    /// creating a new one. The COW file retains all prior writes.
    ///
    /// On failure the caller retains ownership of `cow_file` and is
    /// responsible for cleanup.
    pub fn restore(
        base_loop: &Path,
        sectors: u64,
        config: &CowDeviceConfig,
        cow_file: PathBuf,
    ) -> Result<Self> {
        if !cow_file.is_file() {
            return Err(BlockCowError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("COW file not found: {}", cow_file.display()),
            )));
        }
        let id = uuid::Uuid::new_v4().to_string();
        Self::setup(base_loop, sectors, config, &id, Some(cow_file))
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

    fn setup(
        base_loop: &Path,
        sectors: u64,
        config: &CowDeviceConfig,
        id: &str,
        existing_cow: Option<PathBuf>,
    ) -> Result<Self> {
        let chunk_size = config.chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE);
        let cow_name = format!("cow-{id}");

        // 1. Create or reuse COW sparse file and attach to loop device.
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
                    let size_bytes = sectors.checked_mul(512).ok_or_else(|| {
                        BlockCowError::Io(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            format!("sector count overflow: {sectors} * 512"),
                        ))
                    })?;
                    f.set_len(size_bytes)?;
                    Ok(path)
                };
                create_cow()?
            }
        };

        let mut cow_loop = match losetup::attach(&cow_file, false) {
            Ok(l) => l,
            Err(e) => {
                if created_cow {
                    let _ = fs::remove_file(&cow_file);
                }
                return Err(e);
            }
        };
        info!(cow_loop = %cow_loop.path().display(), "attached COW file");

        // 2. Create dm-snapshot target directly on the shared base loop device.
        //
        //    No dm-linear origin needed — the base loop is read-only and shared
        //    across all COW devices via BaseImagePool.
        //
        //    dm devices default to root:disk 0660. We chown to the current user
        //    after creation so Firecracker (running as that user) can open the
        //    device via bind mount.  Note: dmsetup's --uid/--gid flags are NOT
        //    reliable — udev rules re-apply default ownership (root:disk) after
        //    device creation, racing with the flag-set values.
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
                if created_cow {
                    let _ = fs::remove_file(&cow_file);
                }
                return Err(e);
            }
        };

        // chown the device to the current user.  Must happen after dmsetup
        // create (not via --uid/--gid) because udev rules reset ownership.
        let uid = nix::unistd::getuid().as_raw();
        let gid = nix::unistd::getgid().as_raw();
        let device_str = device_path.to_string_lossy();
        if let Err(e) =
            crate::command::run("chown", &[&format!("{uid}:{gid}"), device_str.as_ref()])
        {
            let _ = dmsetup::remove(&cow_name);
            let _ = cow_loop.detach();
            if created_cow {
                let _ = fs::remove_file(&cow_file);
            }
            return Err(e);
        }

        // Hold the dm device open so its open count stays > 0.
        // This prevents concurrent GC from removing the target via
        // `dmsetup remove` (which returns EBUSY when openers exist).
        let device_holder = match fs::File::open(&device_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = dmsetup::remove(&cow_name);
                let _ = cow_loop.detach();
                if created_cow {
                    let _ = fs::remove_file(&cow_file);
                }
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
            cow_file,
            _device_holder: Some(device_holder),
            active: true,
        })
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
        self._device_holder = None;
        dmsetup::remove(&cow_name)?;

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
                warn!(id = self.id, error = %e, "best-effort teardown in Drop failed");
            }
        }
    }
}
