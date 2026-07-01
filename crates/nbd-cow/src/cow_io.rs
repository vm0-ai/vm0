//! Async boundary for synchronous COW storage operations.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Semaphore;

use crate::cow::CowLayer;
use crate::error::{NbdCowError, Result};

#[derive(Clone)]
pub struct CowIo {
    inner: Arc<CowIoInner>,
}

struct CowIoInner {
    cow: Mutex<CowLayer>,
    operation_slot: Arc<Semaphore>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CowIoStatus {
    pub dirty_blocks: usize,
    pub buffered_blocks: usize,
    pub buffer_bytes: usize,
}

impl CowIo {
    pub fn new(cow: CowLayer) -> Self {
        Self {
            inner: Arc::new(CowIoInner {
                cow: Mutex::new(cow),
                operation_slot: Arc::new(Semaphore::new(1)),
            }),
        }
    }

    pub async fn read(&self, offset: u64, mut data: Vec<u8>) -> Result<Vec<u8>> {
        self.run("read", move |cow| {
            cow.read(offset, &mut data)?;
            Ok(data)
        })
        .await
    }

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

    pub async fn sync(&self) -> Result<()> {
        self.run("sync", CowLayer::sync).await
    }

    pub async fn save_bitmap(&self, path: PathBuf) -> Result<()> {
        self.run("save bitmap", move |cow| cow.save_bitmap(&path))
            .await
    }

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
