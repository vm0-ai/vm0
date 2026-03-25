use std::fs;
use std::path::{Path, PathBuf};

use crate::command;
use crate::error::Result;

/// An attached loop device with a holder fd for GC protection.
///
/// The holder fd keeps the kernel open count > 0, which causes
/// `losetup -d` (used by GC) to return EBUSY while the device is
/// in use.  When the runner process is killed (SIGKILL), the kernel
/// closes the fd and GC can reclaim the loop.
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
/// detached.  Callers must explicitly detach when done.
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
    /// Drops the holder fd first (so we don't EBUSY ourselves), then
    /// calls `losetup --detach`.  On failure the holder is already gone
    /// — GC or a subsequent retry can finish the detach.
    pub fn detach(&mut self) -> Result<()> {
        self.holder = None;
        detach_by_path(&self.path)
    }
}

/// Attach a file to a free loop device.
///
/// Opens a holder fd immediately after attach to prevent GC from
/// detaching the device before the caller can use it.
///
/// Attach without `--direct-io` so all I/O goes through the host page
/// cache.  This is critical on EBS-backed storage where direct IOPS are
/// limited (~3000 baseline for gp3).  Without page cache buffering:
///
/// - **Reads**: every guest read through dm-snapshot hits EBS; chromium
///   startup (~100K random 4KB reads) would take ~30s vs <1s from cache.
/// - **Writes**: every dm-snapshot COW operation (read original chunk +
///   write new chunk) hits EBS synchronously; chromium startup writes
///   ~46K chunks ≈ ~93K IOPS ≈ 30s.
///
/// The old overlay approach used regular file I/O (no loop device), so
/// reads and writes naturally went through page cache.  Omitting
/// `--direct-io` gives the same buffering behavior through the loop
/// device's block cache + backing file's page cache.
pub fn attach(file_path: &Path, read_only: bool) -> Result<LoopDevice> {
    let file_str = file_path.to_string_lossy();
    let mut args = vec!["--find", "--show"];
    if read_only {
        args.push("--read-only");
    }
    args.push(&file_str);

    let stdout = command::sudo("losetup", &args)?;
    let path = PathBuf::from(&stdout);

    // Loop devices are created by sudo losetup as root:disk 0660.
    // The runner process runs as a regular user (not in the disk group),
    // so we must chown the device to open it for the holder fd.
    let path_str = path.to_string_lossy();
    let uid = nix::unistd::getuid().as_raw();
    let gid = nix::unistd::getgid().as_raw();
    if let Err(e) = command::sudo("chown", &[&format!("{uid}:{gid}"), &path_str]) {
        let _ = detach_by_path(&path);
        return Err(e);
    }

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
    command::sudo("losetup", &["--detach", &dev_str])?;
    Ok(())
}
