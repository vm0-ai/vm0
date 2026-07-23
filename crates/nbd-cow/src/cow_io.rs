//! Async boundary for synchronous COW storage operations.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Semaphore;

use crate::cow::CowLayer;
use crate::error::{NbdCowError, Result};

/// Async handle for serialized COW storage operations.
///
/// `CowLayer` performs synchronous positioned file I/O. `CowIo` keeps that
/// blocking work out of async dispatch tasks while preserving one active COW
/// operation per device.
#[derive(Clone)]
pub struct CowIo {
    inner: Arc<CowIoInner>,
}

struct CowIoInner {
    cow: Mutex<CowLayer>,
    operation_slot: Arc<Semaphore>,
}

/// Snapshot of COW state counters used for diagnostics and tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CowIoStatus {
    /// Blocks already materialized in the sparse COW file.
    pub dirty_blocks: usize,
    /// Blocks currently buffered in memory and not yet flushed.
    pub buffered_blocks: usize,
    /// Approximate memory used by the write buffer.
    pub buffer_bytes: usize,
}

impl CowIo {
    /// Create a new async COW I/O boundary around a synchronous COW layer.
    pub fn new(cow: CowLayer) -> Self {
        Self {
            inner: Arc::new(CowIoInner {
                cow: Mutex::new(cow),
                operation_slot: Arc::new(Semaphore::new(1)),
            }),
        }
    }

    /// Read data at `offset` into the provided buffer and return it.
    pub async fn read(&self, offset: u64, mut data: Vec<u8>) -> Result<Vec<u8>> {
        self.run("read", move |cow| {
            cow.read(offset, &mut data)?;
            Ok(data)
        })
        .await
    }

    /// Write `data` at `offset`, flushing buffered data when the threshold is reached.
    pub async fn write(&self, offset: u64, data: Vec<u8>) -> Result<Vec<u8>> {
        self.run("write", move |cow| {
            let needs_flush = cow.write(offset, &data)?;
            if needs_flush {
                cow.flush()?;
            }
            Ok(data)
        })
        .await
    }

    /// Flush pending data and sync the COW file when it exists.
    pub async fn sync(&self) -> Result<()> {
        self.run("sync", CowLayer::sync).await
    }

    pub(crate) async fn save_bitmap(&self, path: PathBuf) -> Result<()> {
        self.run("save bitmap", move |cow| {
            cow.sync()?;
            cow.save_bitmap(&path)
        })
        .await
    }

    /// Return a consistent snapshot of COW counters.
    pub async fn status(&self) -> Result<CowIoStatus> {
        self.run("status", |cow| {
            Ok(CowIoStatus {
                dirty_blocks: cow.dirty_block_count(),
                buffered_blocks: cow.buffered_block_count(),
                buffer_bytes: cow.buffer_bytes(),
            })
        })
        .await
    }

    pub(crate) fn relocate_cow_file_after_rename(&self, cow_file: PathBuf) -> Result<()> {
        let mut cow = match self.inner.cow.try_lock() {
            Ok(cow) => cow,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(NbdCowError::Io(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "COW layer busy during backing-file relocation",
                )));
            }
            Err(std::sync::TryLockError::Poisoned(error)) => {
                return Err(NbdCowError::Io(std::io::Error::other(format!(
                    "COW layer mutex poisoned during backing-file relocation: {error}"
                ))));
            }
        };
        cow.relocate_cow_file_after_rename(cow_file);
        Ok(())
    }

    async fn run<T>(
        &self,
        operation: &'static str,
        f: impl FnOnce(&mut CowLayer) -> Result<T> + Send + 'static,
    ) -> Result<T>
    where
        T: Send + 'static,
    {
        let permit = self
            .inner
            .operation_slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed_error(operation))?;
        let inner = self.inner.clone();

        match tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut cow = lock_cow(&inner, operation)?;
            f(&mut cow)
        })
        .await
        {
            Ok(result) => result,
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(e) => Err(NbdCowError::Io(std::io::Error::other(format!(
                "COW I/O {operation} task was cancelled: {e}",
            )))),
        }
    }
}

fn lock_cow<'a>(inner: &'a CowIoInner, operation: &str) -> Result<MutexGuard<'a, CowLayer>> {
    inner.cow.lock().map_err(|_| {
        NbdCowError::Io(std::io::Error::other(format!(
            "COW layer mutex poisoned during {operation}",
        )))
    })
}

fn closed_error(operation: &str) -> NbdCowError {
    NbdCowError::Io(std::io::Error::other(format!(
        "COW I/O operation slot closed before {operation}",
    )))
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use tempfile::NamedTempFile;

    use super::*;
    use crate::{BLOCK_SIZE, cow::bitmap_path_for};

    #[tokio::test]
    async fn save_bitmap_flushes_buffered_writes() {
        let mut base = NamedTempFile::new().unwrap();
        base.write_all(&vec![0x11; BLOCK_SIZE]).unwrap();
        base.flush().unwrap();
        let cow_file = NamedTempFile::new().unwrap();
        let cow = CowLayer::new(
            base.path(),
            cow_file.path(),
            BLOCK_SIZE as u64,
            BLOCK_SIZE,
            BLOCK_SIZE * 4,
        )
        .unwrap();
        let cow = CowIo::new(cow);

        let write_data = vec![0x22; BLOCK_SIZE];
        cow.write(0, write_data.clone()).await.unwrap();
        assert_eq!(
            cow.status().await.unwrap(),
            CowIoStatus {
                dirty_blocks: 0,
                buffered_blocks: 1,
                buffer_bytes: BLOCK_SIZE,
            }
        );

        cow.save_bitmap(bitmap_path_for(cow_file.path()))
            .await
            .unwrap();

        assert_eq!(
            cow.status().await.unwrap(),
            CowIoStatus {
                dirty_blocks: 1,
                buffered_blocks: 0,
                buffer_bytes: 0,
            }
        );
        let restored = CowLayer::new(
            base.path(),
            cow_file.path(),
            BLOCK_SIZE as u64,
            BLOCK_SIZE,
            BLOCK_SIZE * 4,
        )
        .unwrap();
        let mut restored_data = vec![0; BLOCK_SIZE];
        restored.read(0, &mut restored_data).unwrap();
        assert_eq!(restored_data, write_data);
    }

    #[tokio::test]
    async fn relocated_path_controls_lazy_cow_file_open() {
        let mut base = NamedTempFile::new().unwrap();
        base.write_all(&vec![0x11; BLOCK_SIZE]).unwrap();
        base.flush().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let source_dir = tmp.path().join("slot");
        let target_dir = tmp.path().join("sandbox");
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::create_dir(&target_dir).unwrap();
        let source_cow = source_dir.join("cow.img");
        let target_cow = target_dir.join("cow.img");
        std::fs::File::create(&source_cow)
            .unwrap()
            .set_len(BLOCK_SIZE as u64)
            .unwrap();
        let cow = CowLayer::new(
            base.path(),
            &source_cow,
            BLOCK_SIZE as u64,
            BLOCK_SIZE,
            BLOCK_SIZE * 4,
        )
        .unwrap();
        let cow = CowIo::new(cow);

        std::fs::rename(&source_cow, &target_cow).unwrap();
        cow.relocate_cow_file_after_rename(target_cow.clone())
            .unwrap();
        let write_data = vec![0x22; BLOCK_SIZE];
        cow.write(0, write_data.clone()).await.unwrap();
        cow.sync().await.unwrap();

        assert!(!source_cow.exists());
        assert_eq!(std::fs::read(target_cow).unwrap(), write_data);
    }
}
