//! Host-global NBD device index locks.
//!
//! These locks coordinate `/dev/nbdN` ownership across runner processes on the
//! same host. The kernel releases `flock` locks automatically when the owning
//! process exits.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

const LOCK_FILE_PREFIX: &str = "vm0-nbd";

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
    let file = open_lock_file(&path)?;
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(NbdDeviceClaim { index, _lock: lock })),
        Err((_file, errno)) if errno == nix::errno::Errno::EWOULDBLOCK => Ok(None),
        Err((_file, errno)) => Err(io::Error::from_raw_os_error(errno as i32)),
    }
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
}
