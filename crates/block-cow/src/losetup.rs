use std::fs;
use std::path::{Path, PathBuf};

use crate::command;
use crate::error::Result;

/// An attached loop device with a holder fd for GC protection.
///
/// The holder fd keeps the kernel open count > 0, which prevents
/// the loop device from being destroyed even if GC calls `losetup -d`.
/// Since Linux v3.7, `losetup -d` on a busy device does not return
/// EBUSY — it sets `LO_FLAGS_AUTOCLEAR` and returns success.  The
/// device is then automatically destroyed when the last reference
/// (fd or dm target) is released.  The holder fd thus delays that
/// automatic destruction.  When the runner process is killed (SIGKILL),
/// the kernel closes the fd and GC can reclaim the loop.
///
/// # Lifecycle
///
/// ```text
/// let dev = losetup::attach(path, ro)?;   // attach + open holder
/// dev.path()                               // use the loop device
/// dev.detach()?;                           // drop holder → losetup -d
/// ```
///
/// If dropped without calling [`detach`](Self::detach), the holder fd
/// is closed (allowing GC to reclaim) but the loop device is NOT
/// explicitly detached.  Callers must explicitly detach when done.
pub struct LoopDevice {
    /// The loop device path (e.g. `/dev/loop0`).
    path: PathBuf,
    /// Open fd — keeps the loop's kernel open count > 0.
    holder: Option<fs::File>,
}

impl LoopDevice {
    /// The loop device path (e.g. `/dev/loop0`).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Detach the loop device.
    ///
    /// Drops the holder fd first (so we don't hold a reference), then
    /// calls `losetup --detach`.  If the device is already gone (e.g.
    /// because GC's `losetup -d` set `LO_FLAGS_AUTOCLEAR` and dropping
    /// the holder fd triggered kernel auto-detach), the error is ignored.
    pub fn detach(&mut self) -> Result<()> {
        self.holder = None;
        match detach_by_path(&self.path) {
            Ok(()) => Ok(()),
            Err(e) => {
                // The device may have been auto-detached by the kernel via
                // LO_FLAGS_AUTOCLEAR (set by GC's `losetup -d`).  When the
                // last reference is released, the kernel detaches the loop
                // automatically.  Our subsequent `losetup --detach` then
                // fails with ENXIO ("No such device or address") because the
                // loop node exists but is no longer configured.  Checking
                // `!self.path.exists()` does NOT work — `/dev/loopN` device
                // nodes persist even after detach.
                if is_already_detached(&e) {
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }
}

/// Attach a file to a free loop device.
///
/// Opens a holder fd immediately after attach to prevent GC from
/// detaching the device before the caller can use it.
///
/// Uses `--direct-io=on` to avoid double page-cache buffering: without
/// it, data is cached both in the loop device's page cache (via the
/// backing file) and in the guest's own page cache, wasting host memory.
/// With direct-io, the loop driver uses O_DIRECT on the backing file,
/// bypassing the host page cache entirely.  The guest kernel still
/// maintains its own page cache for filesystem reads, so repeated
/// accesses are served from guest memory without hitting EBS.
pub fn attach(file_path: &Path, read_only: bool) -> Result<LoopDevice> {
    let file_str = file_path.to_string_lossy();
    let mut args = vec!["--find", "--show", "--direct-io=on"];
    if read_only {
        args.push("--read-only");
    }
    args.push(&file_str);

    let stdout = command::run("losetup", &args)?;
    let path = PathBuf::from(&stdout);

    // Open immediately so the loop's kernel open count is > 0 before
    // this function returns.  This closes the race window where GC
    // could detach the device between attach and the caller using it.
    let holder = match fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            // losetup succeeded but open failed — detach to avoid leaking.
            let _ = detach_by_path(&path);
            return Err(e.into());
        }
    };

    Ok(LoopDevice {
        path,
        holder: Some(holder),
    })
}

/// Detach a loop device by path (low-level helper).
fn detach_by_path(loop_device: &Path) -> Result<()> {
    let dev_str = loop_device.to_string_lossy();
    command::run("losetup", &["--detach", &dev_str])?;
    Ok(())
}

/// Check if a losetup error indicates the device was already detached.
///
/// ENXIO ("No such device or address") means the `/dev/loopN` node exists
/// but is not configured with a backing file — i.e. it was already detached
/// (typically by AUTOCLEAR).
fn is_already_detached(e: &crate::error::BlockCowError) -> bool {
    match e {
        crate::error::BlockCowError::CommandFailed { stderr, .. } => {
            stderr.contains("No such device or address")
        }
        _ => false,
    }
}
