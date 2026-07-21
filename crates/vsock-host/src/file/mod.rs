mod copy;
mod read;
mod write;

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use shell_quote::quote_shell_arg;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::exec_operation;

pub use copy::{CopyFileOptions, CopyFileResult};
pub use write::WriteFileEntry;

const MISSING_FILE_EXIT_CODE: i32 = 66;

#[derive(Default)]
pub(crate) struct FileWritePathLocks {
    entries: Mutex<HashMap<PathBuf, FileWritePathLockEntry>>,
}

struct FileWritePathLockEntry {
    lock: Weak<RwLock<()>>,
    users: usize,
}

struct FileWritePathLockReservation<'a> {
    owner: &'a FileWritePathLocks,
    path: PathBuf,
    lock: Arc<RwLock<()>>,
}

enum FileWritePathGuardKind {
    Shared(OwnedRwLockReadGuard<()>),
    Exclusive(OwnedRwLockWriteGuard<()>),
}

struct FileWritePathGuard<'a> {
    guard: Option<FileWritePathGuardKind>,
    reservation: Option<FileWritePathLockReservation<'a>>,
}

impl FileWritePathLocks {
    async fn acquire_shared(&self, path: &str) -> FileWritePathGuard<'_> {
        let reservation = self.reserve(PathBuf::from(path));
        let guard = Arc::clone(&reservation.lock).read_owned().await;
        FileWritePathGuard::new(FileWritePathGuardKind::Shared(guard), reservation)
    }

    async fn acquire_shared_many<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Vec<FileWritePathGuard<'_>> {
        let reservations = paths
            .into_iter()
            .map(PathBuf::from)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|path| self.reserve(path))
            .collect::<Vec<_>>();
        let mut guards = Vec::with_capacity(reservations.len());
        for reservation in reservations {
            let guard = Arc::clone(&reservation.lock).read_owned().await;
            guards.push(FileWritePathGuard::new(
                FileWritePathGuardKind::Shared(guard),
                reservation,
            ));
        }
        guards
    }

    async fn acquire_exclusive(&self, path: &str) -> FileWritePathGuard<'_> {
        let reservation = self.reserve(PathBuf::from(path));
        let guard = Arc::clone(&reservation.lock).write_owned().await;
        FileWritePathGuard::new(FileWritePathGuardKind::Exclusive(guard), reservation)
    }

    fn reserve(&self, path: PathBuf) -> FileWritePathLockReservation<'_> {
        let mut entries = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let lock = entries.get_mut(&path).and_then(|entry| {
            entry.lock.upgrade().inspect(|_| {
                assert_ne!(entry.users, usize::MAX);
                entry.users += 1;
            })
        });
        let lock = if let Some(lock) = lock {
            lock
        } else {
            let lock = Arc::new(RwLock::new(()));
            entries.insert(
                path.clone(),
                FileWritePathLockEntry {
                    lock: Arc::downgrade(&lock),
                    users: 1,
                },
            );
            lock
        };
        FileWritePathLockReservation {
            owner: self,
            path,
            lock,
        }
    }
}

impl<'a> FileWritePathGuard<'a> {
    fn new(
        guard: FileWritePathGuardKind,
        reservation: FileWritePathLockReservation<'a>,
    ) -> FileWritePathGuard<'a> {
        FileWritePathGuard {
            guard: Some(guard),
            reservation: Some(reservation),
        }
    }
}

impl Drop for FileWritePathGuard<'_> {
    fn drop(&mut self) {
        match self.guard.take() {
            Some(FileWritePathGuardKind::Shared(guard)) => drop(guard),
            Some(FileWritePathGuardKind::Exclusive(guard)) => drop(guard),
            None => {}
        }
        drop(self.reservation.take());
    }
}

impl Drop for FileWritePathLockReservation<'_> {
    fn drop(&mut self) {
        let mut entries = self
            .owner
            .entries
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let reservation_lock = Arc::downgrade(&self.lock);
        let remove = if let Some(entry) = entries.get_mut(&self.path)
            && Weak::ptr_eq(&entry.lock, &reservation_lock)
        {
            assert!(entry.users > 0);
            entry.users -= 1;
            entry.users == 0
        } else {
            false
        };
        if remove {
            entries.remove(&self.path);
        }
    }
}

fn validate_guest_file_path(path: &str) -> io::Result<()> {
    if path.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest file path must not be empty",
        ));
    }
    if path.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest file path contains NUL bytes",
        ));
    }
    Ok(())
}

fn read_regular_file_command(path: &str, missing_file_exit_code: i32) -> String {
    let path = quote_shell_arg(path);
    format!(
        "if test -f {path}; then cat 2>/dev/null < {path} || {{ test -f {path} || exit {missing_file_exit_code}; printf '%s\\n' 'failed to read file' >&2; exit 1; }}; else exit {missing_file_exit_code}; fi"
    )
}

fn normalize_file_exec_stderr(mut stderr: Vec<u8>, stderr_truncated: bool) -> Vec<u8> {
    if stderr_truncated {
        exec_operation::append_diagnostic(&mut stderr, "stderr truncated");
    }
    stderr
}

fn file_operation_error_is_terminal(error: &io::Error) -> bool {
    !matches!(
        error.kind(),
        io::ErrorKind::TimedOut
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::InvalidData
    )
}

#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = super::copy::COPY_FILE_STREAM_CHUNK_LIMIT;
    pub(crate) const COPY_FILE_STREAM_MAX_BYTES: u64 = super::copy::COPY_FILE_STREAM_MAX_BYTES;
    pub(crate) const WRITE_FILE_CHUNK_LIMIT: usize = super::write::WRITE_FILE_CHUNK_LIMIT;
    pub(crate) const WRITE_FILES_BATCH_CONTENT_LIMIT: usize =
        super::write::WRITE_FILES_BATCH_CONTENT_LIMIT;
    pub(crate) const WRITE_FILES_BATCH_FILE_LIMIT: usize =
        super::write::WRITE_FILES_BATCH_FILE_LIMIT;
}
