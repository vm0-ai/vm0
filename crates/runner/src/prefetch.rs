use std::io::Read;
use std::path::{Path, PathBuf};

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const MEMORY_PREFETCH_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
enum PrefetchOutcome {
    Complete { bytes: u64 },
    Cancelled { bytes: u64 },
    ReadFailed { bytes: u64, error: std::io::Error },
}

pub(crate) struct MemoryPrefetchTasks {
    cancel: CancellationToken,
    handles: Vec<JoinHandle<()>>,
}

impl MemoryPrefetchTasks {
    pub(crate) fn spawn(paths: impl IntoIterator<Item = PathBuf>) -> Self {
        let cancel = CancellationToken::new();
        let mut unique_paths = Vec::new();
        for path in paths {
            if !unique_paths.contains(&path) {
                unique_paths.push(path);
            }
        }

        let handles = unique_paths
            .into_iter()
            .map(|path| {
                let cancel = cancel.clone();
                tokio::task::spawn_blocking(move || prefetch_memory_with_cancel(&path, &cancel))
            })
            .collect();

        Self { cancel, handles }
    }

    #[cfg(test)]
    pub(crate) fn empty() -> Self {
        Self {
            cancel: CancellationToken::new(),
            handles: Vec::new(),
        }
    }

    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
    }

    pub(crate) async fn drain(&mut self) {
        for handle in self.handles.drain(..) {
            if let Err(error) = handle.await {
                warn!(error = %error, "memory prefetch task failed");
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn task_count(&self) -> usize {
        self.handles.len()
    }

    #[cfg(test)]
    pub(crate) fn from_test_handle(cancel: CancellationToken, handle: JoinHandle<()>) -> Self {
        Self {
            cancel,
            handles: vec![handle],
        }
    }
}

impl Drop for MemoryPrefetchTasks {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Read a file sequentially to populate the host page cache.
///
/// Firecracker mmaps `memory.bin` on snapshot restore; without the file in
/// page cache, guest memory accesses trigger host-side demand paging.
/// This performs blocking I/O — callers should use `spawn_blocking`.
pub fn prefetch_memory(path: &Path) {
    prefetch_memory_with_cancel(path, &CancellationToken::new());
}

fn prefetch_memory_with_cancel(path: &Path, cancel: &CancellationToken) {
    if cancel.is_cancelled() {
        info!(bytes = 0_u64, path = %path.display(), "memory prefetch cancelled");
        return;
    }

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "memory prefetch: open failed");
            return;
        }
    };

    match prefetch_reader(&mut file, cancel) {
        PrefetchOutcome::Complete { bytes } => {
            info!(bytes, path = %path.display(), "memory prefetch complete");
        }
        PrefetchOutcome::Cancelled { bytes } => {
            info!(bytes, path = %path.display(), "memory prefetch cancelled");
        }
        PrefetchOutcome::ReadFailed { bytes, error } => {
            warn!(error = %error, bytes, path = %path.display(), "memory prefetch: read failed");
        }
    }
}

fn prefetch_reader<R: Read>(reader: &mut R, cancel: &CancellationToken) -> PrefetchOutcome {
    let mut buf = vec![0u8; MEMORY_PREFETCH_CHUNK_BYTES];
    let mut total: u64 = 0;
    loop {
        if cancel.is_cancelled() {
            return PrefetchOutcome::Cancelled { bytes: total };
        }

        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(error) => {
                return PrefetchOutcome::ReadFailed {
                    bytes: total,
                    error,
                };
            }
        };
        if n == 0 {
            return PrefetchOutcome::Complete { bytes: total };
        }
        total += n as u64;

        if cancel.is_cancelled() {
            return PrefetchOutcome::Cancelled { bytes: total };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[test]
    fn prefetch_memory_reads_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.bin");
        std::fs::write(&path, vec![0u8; 4096]).unwrap();
        // Should not panic
        prefetch_memory(&path);
    }

    #[test]
    fn prefetch_memory_missing_file_does_not_panic() {
        prefetch_memory(Path::new("/nonexistent/memory.bin"));
    }

    #[test]
    fn prefetch_memory_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        prefetch_memory(&path);
    }

    #[test]
    fn prefetch_reader_stops_before_read_when_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut reader = TestReader::new(3, None, cancel.clone());

        let outcome = prefetch_reader(&mut reader, &cancel);

        assert!(matches!(outcome, PrefetchOutcome::Cancelled { bytes: 0 }));
        assert_eq!(reader.reads, 0);
    }

    #[test]
    fn prefetch_reader_stops_between_chunks_when_cancelled() {
        let cancel = CancellationToken::new();
        let mut reader = TestReader::new(3, Some(1), cancel.clone());

        let outcome = prefetch_reader(&mut reader, &cancel);

        assert!(matches!(outcome, PrefetchOutcome::Cancelled { bytes: 1 }));
        assert_eq!(reader.reads, 1);
    }

    #[test]
    fn prefetch_reader_reports_bytes_read_before_failure() {
        let cancel = CancellationToken::new();
        let mut reader = FailingReader { reads: 0 };

        let outcome = prefetch_reader(&mut reader, &cancel);

        assert!(matches!(
            outcome,
            PrefetchOutcome::ReadFailed { bytes: 1, .. }
        ));
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_deduplicate_paths() {
        let path = PathBuf::from("/nonexistent/memory.bin");
        let mut tasks = MemoryPrefetchTasks::spawn([path.clone(), path]);

        assert_eq!(tasks.task_count(), 1);

        tasks.drain().await;
        assert_eq!(tasks.task_count(), 0);
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_cancel_and_drain() {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            task_cancel.cancelled().await;
            let _ = cancelled_tx.send(());
            let _ = release_rx.await;
        });
        let mut tasks = MemoryPrefetchTasks::from_test_handle(cancel, handle);

        tasks.cancel();
        tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
            .await
            .expect("prefetch task should observe cancellation")
            .expect("prefetch task should report cancellation");
        release_tx
            .send(())
            .expect("prefetch task should wait for release");
        tasks.drain().await;

        assert_eq!(tasks.task_count(), 0);
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_drop_cancels() {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            task_cancel.cancelled().await;
            let _ = cancelled_tx.send(());
        });

        let tasks = MemoryPrefetchTasks::from_test_handle(cancel, handle);
        drop(tasks);

        tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
            .await
            .expect("dropped prefetch owner should cancel task")
            .expect("prefetch task should report cancellation");
    }

    struct TestReader {
        remaining_reads: usize,
        cancel_after_read: Option<usize>,
        cancel: CancellationToken,
        reads: usize,
    }

    impl TestReader {
        fn new(
            remaining_reads: usize,
            cancel_after_read: Option<usize>,
            cancel: CancellationToken,
        ) -> Self {
            Self {
                remaining_reads,
                cancel_after_read,
                cancel,
                reads: 0,
            }
        }
    }

    impl Read for TestReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining_reads == 0 {
                return Ok(0);
            }

            self.remaining_reads -= 1;
            self.reads += 1;
            buf[0] = 0;

            if self.cancel_after_read == Some(self.reads) {
                self.cancel.cancel();
            }

            Ok(1)
        }
    }

    struct FailingReader {
        reads: usize,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.reads == 1 {
                return Err(std::io::Error::other("boom"));
            }
            self.reads += 1;
            buf[0] = 0;
            Ok(1)
        }
    }
}
