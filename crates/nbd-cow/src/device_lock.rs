//! Host-global NBD device index locks.
//!
//! These locks coordinate `/dev/nbdN` ownership across runner processes on the
//! same host. The kernel releases `flock` locks automatically when the owning
//! process exits.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

const LOCK_FILE_PREFIX: &str = "vm0-nbd";
const MAX_STALE_INODE_RETRIES: usize = 16;

/// Owned host-global claim for one NBD device index.
///
/// Dropping this value releases the corresponding per-index `flock`.
#[derive(Debug)]
pub struct NbdDeviceClaim {
    index: u32,
    _lock: Flock<File>,
}

impl NbdDeviceClaim {
    /// NBD device index (N in `/dev/nbdN`).
    pub fn index(&self) -> u32 {
        self.index
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(index: u32, lock_dir: &Path) -> Self {
        try_acquire_device_claim_in(index, lock_dir)
            .expect("test lock acquisition should not fail")
            .expect("test lock should be free")
    }
}

/// Default NBD lock directory.
pub fn default_lock_dir() -> PathBuf {
    PathBuf::from("/var/lock")
}

/// Lock file path for a device index under the default lock directory.
pub fn device_lock_path(index: u32) -> PathBuf {
    device_lock_path_in(index, &default_lock_dir())
}

fn device_lock_path_in(index: u32, lock_dir: &Path) -> PathBuf {
    lock_dir.join(format!("{LOCK_FILE_PREFIX}-{index}.lock"))
}

/// Try to acquire a host-global claim for an NBD device index.
///
/// Returns `Ok(None)` when another process holds the per-index lock.
pub fn try_acquire_device_claim(index: u32) -> io::Result<Option<NbdDeviceClaim>> {
    try_acquire_device_claim_in(index, &default_lock_dir())
}

/// Try to acquire a host-global claim in a custom lock directory.
pub fn try_acquire_device_claim_in(
    index: u32,
    lock_dir: &Path,
) -> io::Result<Option<NbdDeviceClaim>> {
    let path = device_lock_path_in(index, lock_dir);
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = open_lock_file(&path)?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                if lock_inode_is_current(&lock, &path)? {
                    return Ok(Some(NbdDeviceClaim { index, _lock: lock }));
                }
            }
            Err((file, errno)) if errno == nix::errno::Errno::EWOULDBLOCK => {
                if file_inode_is_current(&file, &path)? {
                    return Ok(None);
                }
            }
            Err((_file, errno)) => return Err(io::Error::from_raw_os_error(errno as i32)),
        }
    }

    Err(io::Error::other(format!(
        "lock path {} changed during NBD claim",
        path.display()
    )))
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    open_existing_lock_file(path).or_else(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            create_lock_file(path)
        } else {
            Err(e)
        }
    })
}

fn base_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).custom_flags(libc::O_NOFOLLOW);
    options
}

fn open_existing_lock_file(path: &Path) -> io::Result<File> {
    base_open_options().open(path)
}

fn create_lock_file(path: &Path) -> io::Result<File> {
    let mut options = base_open_options();
    options.create(true).truncate(false).open(path)
}

fn metadata_inode_is_current(lock_meta: std::fs::Metadata, path: &Path) -> io::Result<bool> {
    let path_meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    Ok(lock_meta.ino() == path_meta.ino())
}

fn lock_inode_is_current(lock: &Flock<File>, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(lock.metadata()?, path)
}

fn file_inode_is_current(file: &File, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(file.metadata()?, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_claim_for_same_index_reports_busy_until_first_drops() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = try_acquire_device_claim_in(7, dir.path())
            .expect("first lock")
            .expect("first claim");

        assert!(
            try_acquire_device_claim_in(7, dir.path())
                .expect("second lock attempt")
                .is_none()
        );

        drop(first);

        assert!(
            try_acquire_device_claim_in(7, dir.path())
                .expect("third lock")
                .is_some()
        );
    }

    #[test]
    fn held_claim_detects_replaced_lock_file_inode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let claim = try_acquire_device_claim_in(7, dir.path())
            .expect("lock")
            .expect("claim");

        std::fs::remove_file(&path).expect("remove lock path");
        drop(create_lock_file(&path).expect("recreate lock path"));

        assert!(
            !lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
            "held claim should detect that the path was replaced"
        );
    }
}
