use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

#[cfg(test)]
use tokio::sync::Semaphore;
use tokio::sync::{Mutex, Notify, mpsc};
use tracing::warn;

use crate::ids::RunId;
use crate::network_log_drain::{NetworkLogDrainContext, NetworkLogDrainCoordinator};

const DEFAULT_WRITER_SHARDS: usize = 4;
const DEFAULT_SHARD_QUEUE_CAPACITY: usize = 1024;
const DEFAULT_MAX_BATCH_ROWS: usize = 256;
const DEFAULT_MAX_BATCH_BYTES: usize = 256 * 1024;

/// Coordinates Rust-side DNS/kmsg network log attribution and file writes.
///
/// Source-IP acceptance and pending-write registration happen under the same
/// lock, so `flush_path` cannot miss a row that was already accepted for that
/// path.
/// `NetworkLogSession::close_for_upload` first closes the source mapping, then
/// flushes the path so upload cannot miss a newly accepted row.
#[derive(Clone, Default)]
pub struct NetworkLogManager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    writers: Mutex<Option<WriterPool>>,
    writer_config: WriterConfig,
    #[cfg(test)]
    write_gate: Option<WriteGate>,
    #[cfg(test)]
    close_gate: Option<CloseGate>,
}

#[derive(Default)]
struct State {
    source_paths: HashMap<String, SourceState>,
    pending_paths: HashMap<PathBuf, PathState>,
    next_generation: u64,
}

enum SourceState {
    Active { path: PathBuf, generation: u64 },
    Draining { path: PathBuf, generation: u64 },
}

impl SourceState {
    fn path(&self) -> &PathBuf {
        match self {
            Self::Active { path, .. } | Self::Draining { path, .. } => path,
        }
    }

    fn generation(&self) -> u64 {
        match self {
            Self::Active { generation, .. } | Self::Draining { generation, .. } => *generation,
        }
    }

    fn matches(&self, path: &Path, generation: u64) -> bool {
        self.generation() == generation && self.path() == path
    }
}

struct PathState {
    pending: usize,
    notify: Arc<Notify>,
}

impl PathState {
    fn new() -> Self {
        Self {
            pending: 0,
            notify: Arc::new(Notify::new()),
        }
    }
}

#[derive(Clone, Copy)]
struct WriterConfig {
    shards: usize,
    queue_capacity: usize,
    max_batch_rows: usize,
    max_batch_bytes: usize,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            shards: DEFAULT_WRITER_SHARDS,
            queue_capacity: DEFAULT_SHARD_QUEUE_CAPACITY,
            max_batch_rows: DEFAULT_MAX_BATCH_ROWS,
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
        }
    }
}

#[derive(Clone)]
struct WriterPool {
    shards: Arc<Vec<mpsc::Sender<QueuedAppend>>>,
}

struct QueuedAppend {
    path: PathBuf,
    line: String,
}

struct PathWriteBatch {
    path: PathBuf,
    lines: Vec<String>,
}

struct SourceSnapshot {
    path: PathBuf,
    generation: u64,
}

#[cfg(test)]
#[derive(Clone)]
struct WriteGate {
    started: Arc<Notify>,
    release: Arc<Semaphore>,
}

#[cfg(test)]
#[derive(Clone)]
struct CloseGate {
    before_flush: Arc<Notify>,
    release: Arc<Semaphore>,
}

/// Owns a source-IP network-log attribution for one runner job.
///
/// Keep this value alive until the sandbox is parked or stopped, then call
/// [`NetworkLogSession::close_for_upload`] before reading/uploading the job's
/// network log. Dropping it is only a best-effort cleanup fallback.
#[must_use = "dropping a NetworkLogSession immediately closes network-log attribution"]
pub struct NetworkLogSession {
    manager: NetworkLogManager,
    source_ip: String,
    path: PathBuf,
    generation: u64,
    closed: bool,
}

impl NetworkLogSession {
    /// Close local Rust-side network logs for this run before upload reads the file.
    ///
    /// The barrier only covers rows observable to the runner reader tasks. It
    /// cannot prove delivery for data still buffered inside dnsmasq, `dmesg`,
    /// or the kernel before those producers emit to their monitored streams.
    ///
    /// Once the producer barrier completes, this closes the source mapping
    /// before the final path flush. Rows accepted before finalization remain
    /// tracked by the path pending count; rows racing after finalization are
    /// rejected instead of being missed by upload.
    pub async fn close_for_upload(mut self, run_id: RunId, drain: &NetworkLogDrainCoordinator) {
        let current = self
            .manager
            .begin_session_drain(&self.source_ip, &self.path, self.generation)
            .await;
        if current {
            drain
                .drain(NetworkLogDrainContext {
                    run_id,
                    source_ip: &self.source_ip,
                    path: &self.path,
                    generation: self.generation,
                })
                .await;
        }
        self.manager
            .finalize_session(&self.source_ip, &self.path, self.generation)
            .await;
        #[cfg(test)]
        self.manager.before_close_upload_flush_for_test().await;
        self.manager.flush_path(&self.path).await;
        self.closed = true;
    }
}

impl Drop for NetworkLogSession {
    fn drop(&mut self) {
        if self.closed {
            return;
        }

        let manager = self.manager.clone();
        let source_ip = self.source_ip.clone();
        let path = self.path.clone();
        let generation = self.generation;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            std::mem::drop(handle.spawn(async move {
                manager
                    .finalize_session(&source_ip, &path, generation)
                    .await;
            }));
        }
    }
}

impl NetworkLogManager {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub(crate) fn new_with_write_gate(started: Arc<Notify>, release: Arc<Semaphore>) -> Self {
        Self::new_for_test(
            Some(WriteGate { started, release }),
            None,
            WriterConfig::default(),
        )
    }

    #[cfg(test)]
    fn new_with_write_gate_and_config(
        started: Arc<Notify>,
        release: Arc<Semaphore>,
        writer_config: WriterConfig,
    ) -> Self {
        Self::new_for_test(Some(WriteGate { started, release }), None, writer_config)
    }

    #[cfg(test)]
    fn new_for_test(
        write_gate: Option<WriteGate>,
        close_gate: Option<CloseGate>,
        writer_config: WriterConfig,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                writers: Mutex::new(None),
                writer_config,
                write_gate,
                close_gate,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_close_gate(
        before_flush: Arc<Notify>,
        close_release: Arc<Semaphore>,
    ) -> Self {
        Self::new_for_test(
            None,
            Some(CloseGate {
                before_flush,
                release: close_release,
            }),
            WriterConfig::default(),
        )
    }

    pub async fn register_source_ip(
        &self,
        source_ip: impl Into<String>,
        path: PathBuf,
    ) -> NetworkLogSession {
        let source_ip = source_ip.into();
        let mut state = self.inner.state.lock().await;
        state.next_generation += 1;
        let generation = state.next_generation;
        state.source_paths.insert(
            source_ip.clone(),
            SourceState::Active {
                path: path.clone(),
                generation,
            },
        );
        NetworkLogSession {
            manager: self.clone(),
            source_ip,
            path,
            generation,
            closed: false,
        }
    }

    /// Remove a source mapping immediately.
    #[cfg(test)]
    pub async fn unregister_source_ip(&self, source_ip: &str) {
        let mut state = self.inner.state.lock().await;
        state.source_paths.remove(source_ip);
    }

    /// Accept a JSON network-log row for a source IP.
    ///
    /// Returns `true` when the source IP was mapped and the write was accepted.
    /// The actual append is asynchronous; call `flush_path` before reading the
    /// file when a complete snapshot of already accepted writes is required.
    /// `flush_path` does not close source acceptance; use `NetworkLogSession`
    /// when preparing a per-run file for upload.
    pub async fn append_for_ip(&self, source_ip: &str, row: serde_json::Value) -> bool {
        let line = match serde_json::to_string(&row) {
            Ok(mut line) => {
                line.push('\n');
                line
            }
            Err(e) => {
                warn!(source_ip, error = %e, "failed to serialize network log row");
                return false;
            }
        };

        let Some(snapshot) = self.source_snapshot(source_ip).await else {
            return false;
        };
        let writer_pool = self.writer_pool().await;
        let Some(sender) = writer_pool.sender_for_path(&snapshot.path) else {
            warn!("network log writer pool has no shards");
            return false;
        };
        let permit = match sender.reserve_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                warn!(
                    path = %snapshot.path.display(),
                    "network log writer shard closed before append was accepted"
                );
                return false;
            }
        };

        if !self.try_accept_snapshot(source_ip, &snapshot).await {
            return false;
        }
        permit.send(QueuedAppend {
            path: snapshot.path,
            line,
        });
        true
    }

    async fn source_snapshot(&self, source_ip: &str) -> Option<SourceSnapshot> {
        let state = self.inner.state.lock().await;
        state
            .source_paths
            .get(source_ip)
            .map(|source| SourceSnapshot {
                path: source.path().clone(),
                generation: source.generation(),
            })
    }

    async fn try_accept_snapshot(&self, source_ip: &str, snapshot: &SourceSnapshot) -> bool {
        let mut state = self.inner.state.lock().await;
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return false;
        };
        if !source_state.matches(&snapshot.path, snapshot.generation) {
            return false;
        }
        let path_state = state
            .pending_paths
            .entry(snapshot.path.clone())
            .or_insert_with(PathState::new);
        path_state.pending += 1;
        true
    }

    async fn writer_pool(&self) -> WriterPool {
        let mut writers = self.inner.writers.lock().await;
        if let Some(pool) = writers.as_ref() {
            return pool.clone();
        }
        let pool = WriterPool::start(
            Arc::downgrade(&self.inner),
            self.inner.writer_config.normalized(),
            #[cfg(test)]
            self.inner.write_gate.clone(),
        );
        *writers = Some(pool.clone());
        pool
    }

    async fn begin_session_drain(&self, source_ip: &str, path: &Path, generation: u64) -> bool {
        let mut state = self.inner.state.lock().await;
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return false;
        };
        if !source_state.matches(path, generation) {
            return false;
        }
        state.source_paths.insert(
            source_ip.to_string(),
            SourceState::Draining {
                path: path.to_path_buf(),
                generation,
            },
        );
        true
    }

    async fn finalize_session(&self, source_ip: &str, path: &Path, generation: u64) {
        let mut state = self.inner.state.lock().await;
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return;
        };
        if source_state.matches(path, generation) {
            state.source_paths.remove(source_ip);
        }
    }

    /// Wait until all currently accepted Rust-side writes for `path` finish.
    pub async fn flush_path(&self, path: &Path) {
        loop {
            let notified = {
                let state = self.inner.state.lock().await;
                let Some(path_state) = state.pending_paths.get(path) else {
                    return;
                };
                path_state.notify.clone().notified_owned()
            };

            tokio::pin!(notified);
            // Register before rechecking pending state so a concurrent final
            // completion cannot notify between the check and the await.
            notified.as_mut().enable();

            {
                let state = self.inner.state.lock().await;
                if !state.pending_paths.contains_key(path) {
                    return;
                }
            }

            notified.as_mut().await;
        }
    }

    #[cfg(test)]
    async fn before_close_upload_flush_for_test(&self) {
        if let Some(gate) = self.inner.close_gate.as_ref() {
            gate.before_flush.notify_one();
            let permit = gate.release.acquire().await.expect("close gate closed");
            permit.forget();
        }
    }
}

impl Inner {
    async fn complete_path(&self, path: PathBuf, count: usize) {
        if count == 0 {
            return;
        }
        let notify = {
            let mut state = self.state.lock().await;
            let Some(path_state) = state.pending_paths.get_mut(&path) else {
                warn!(path = %path.display(), "network log write completed for unknown path");
                return;
            };

            if path_state.pending < count {
                warn!(
                    path = %path.display(),
                    pending = path_state.pending,
                    completed = count,
                    "network log pending count below completed count"
                );
                path_state.pending = 0;
            } else {
                path_state.pending -= count;
            }

            if path_state.pending == 0 {
                state.pending_paths.remove(&path).map(|state| state.notify)
            } else {
                None
            }
        };

        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }
}

impl WriterConfig {
    fn normalized(self) -> Self {
        Self {
            shards: self.shards.max(1),
            queue_capacity: self.queue_capacity.max(1),
            max_batch_rows: self.max_batch_rows.max(1),
            max_batch_bytes: self.max_batch_bytes.max(1),
        }
    }
}

impl WriterPool {
    fn start(
        inner: Weak<Inner>,
        config: WriterConfig,
        #[cfg(test)] write_gate: Option<WriteGate>,
    ) -> Self {
        let mut shards = Vec::with_capacity(config.shards);
        for _ in 0..config.shards {
            let (tx, rx) = mpsc::channel(config.queue_capacity);
            shards.push(tx);
            std::mem::drop(tokio::spawn(run_writer_shard(
                inner.clone(),
                rx,
                config,
                #[cfg(test)]
                write_gate.clone(),
            )));
        }
        Self {
            shards: Arc::new(shards),
        }
    }

    fn sender_for_path(&self, path: &Path) -> Option<mpsc::Sender<QueuedAppend>> {
        let shard_count = self.shards.len();
        if shard_count == 0 {
            return None;
        }
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        let index = (hasher.finish() as usize) % shard_count;
        self.shards.get(index).cloned()
    }
}

async fn run_writer_shard(
    inner: Weak<Inner>,
    mut rx: mpsc::Receiver<QueuedAppend>,
    config: WriterConfig,
    #[cfg(test)] write_gate: Option<WriteGate>,
) {
    let mut next_item = None;
    loop {
        let first = match next_item.take() {
            Some(item) => item,
            None => match rx.recv().await {
                Some(item) => item,
                None => return,
            },
        };
        let mut batches = Vec::new();
        let mut row_count = 0;
        let mut byte_count = 0;
        push_queued_append(&mut batches, first, &mut row_count, &mut byte_count);

        while row_count < config.max_batch_rows {
            let item = match rx.try_recv() {
                Ok(item) => item,
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            };
            let item_bytes = item.line.len();
            if byte_count > 0 && byte_count + item_bytes > config.max_batch_bytes {
                next_item = Some(item);
                break;
            }
            push_queued_append(&mut batches, item, &mut row_count, &mut byte_count);
        }

        for batch in batches {
            write_path_batch(
                inner.clone(),
                batch,
                #[cfg(test)]
                write_gate.clone(),
            )
            .await;
        }
    }
}

fn push_queued_append(
    batches: &mut Vec<PathWriteBatch>,
    item: QueuedAppend,
    row_count: &mut usize,
    byte_count: &mut usize,
) {
    *row_count += 1;
    *byte_count += item.line.len();
    if let Some(batch) = batches.iter_mut().find(|batch| batch.path == item.path) {
        batch.lines.push(item.line);
    } else {
        batches.push(PathWriteBatch {
            path: item.path,
            lines: vec![item.line],
        });
    }
}

async fn write_path_batch(
    inner: Weak<Inner>,
    batch: PathWriteBatch,
    #[cfg(test)] write_gate: Option<WriteGate>,
) {
    #[cfg(test)]
    if let Some(gate) = write_gate {
        gate.started.notify_one();
        let permit = gate.release.acquire().await.expect("write gate closed");
        permit.forget();
    }

    let path = batch.path;
    let count = batch.lines.len();
    let write_path = path.clone();
    let result = tokio::task::spawn_blocking(move || append_lines(&write_path, &batch.lines)).await;

    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            warn!(path = %path.display(), error = %e, "failed to write network log")
        }
        Err(e) => {
            warn!(path = %path.display(), error = %e, "network log writer task failed");
        }
    }

    if let Some(inner) = inner.upgrade() {
        inner.complete_path(path, count).await;
    }
}

fn append_lines(path: &Path, lines: &[String]) -> std::io::Result<()> {
    let mut file = crate::log_file::open_append(path, false)?;
    for line in lines {
        file.write_all(line.as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::{Future, poll_fn};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::Path;
    use std::task::Poll;
    use std::time::Duration;

    use serde_json::json;

    use crate::ids::RunId;
    use crate::network_log_drain::{NetworkLogDrainCoordinator, NetworkLogDrainProducer};

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn read_json_lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn source_ip_registered(manager: &NetworkLogManager, source_ip: &str) -> bool {
        manager
            .inner
            .state
            .lock()
            .await
            .source_paths
            .contains_key(source_ip)
    }

    async fn wait_source_ip_unregistered(manager: &NetworkLogManager, source_ip: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if !source_ip_registered(manager, source_ip).await {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "source IP {source_ip} stayed registered after session drop",
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn append_for_ip_writes_json_line_to_registered_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"example.com","port":53}),
                )
                .await
        );

        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], "dns");
        assert_eq!(lines[0]["host"], "example.com");
        assert_eq!(lines[0]["port"], 53);
        assert_eq!(mode(&path), 0o600);
    }

    #[tokio::test]
    async fn append_for_ip_flushes_after_rejecting_unsafe_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.jsonl");
        let path = dir.path().join("network.jsonl");
        symlink(&target, &path).unwrap();
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"example.com","port":53}),
                )
                .await
        );

        manager.flush_path(&path).await;

        assert!(!target.exists());
    }

    #[tokio::test]
    async fn flush_path_waits_for_accepted_pending_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"held.test"}))
                .await
        );
        started.notified().await;

        let mut flush = std::pin::pin!(manager.flush_path(&path));
        let pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await;
        assert!(
            pending,
            "flush should wait while the accepted write is pending"
        );

        release.add_permits(1);
        flush.await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "held.test");
    }

    #[tokio::test]
    async fn flush_path_waits_for_all_pending_writes_for_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _session_a = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let _session_b = manager.register_source_ip("10.200.0.3", path.clone()).await;

        let first_started = started.notified();
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
                .await
        );
        first_started.await;

        assert!(
            manager
                .append_for_ip("10.200.0.3", json!({"type":"dns","host":"second.test"}))
                .await
        );

        let mut flush = std::pin::pin!(manager.flush_path(&path));
        let pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await;
        assert!(
            pending,
            "flush should wait while both accepted writes are pending"
        );

        let second_started = started.notified();
        release.add_permits(1);
        second_started.await;
        let still_pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await;
        assert!(
            still_pending,
            "flush should still wait after only one pending write is released"
        );

        release.add_permits(1);
        flush.await;

        let lines = read_json_lines(&path);
        let hosts: std::collections::HashSet<String> = lines
            .iter()
            .map(|line| line["host"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            hosts,
            ["first.test", "second.test"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
    }

    #[tokio::test]
    async fn append_failure_decrements_pending_and_flush_completes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"bad-path.test"}))
                .await
        );

        manager.flush_path(&path).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn append_for_ip_preserves_same_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        for index in 0..20 {
            assert!(
                manager
                    .append_for_ip("10.200.0.2", json!({"type":"dns","index":index}))
                    .await
            );
        }

        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        let indices: Vec<u64> = lines
            .iter()
            .map(|line| line["index"].as_u64().unwrap())
            .collect();
        assert_eq!(indices, (0_u64..20).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn append_after_unregister_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        manager.unregister_source_ip("10.200.0.2").await;

        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old.test"}))
                .await
        );
        manager.flush_path(&path).await;

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn accepted_write_lands_after_unregister() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"accepted.test"}))
                .await
        );
        started.notified().await;

        manager.unregister_source_ip("10.200.0.2").await;
        release.add_permits(1);
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "accepted.test");
    }

    #[tokio::test]
    async fn pending_old_write_stays_on_old_path_after_reregister() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = dir.path().join("new.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _old_session = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;
        let old_started = started.notified();
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old.test"}))
                .await
        );
        old_started.await;

        manager.unregister_source_ip("10.200.0.2").await;
        let _new_session = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );

        release.add_permits(2);
        manager.flush_path(&old_path).await;
        manager.flush_path(&new_path).await;

        let old_lines = read_json_lines(&old_path);
        assert_eq!(old_lines.len(), 1);
        assert_eq!(old_lines[0]["host"], "old.test");

        let new_lines = read_json_lines(&new_path);
        assert_eq!(new_lines.len(), 1);
        assert_eq!(new_lines[0]["host"], "new.test");
    }

    #[tokio::test]
    async fn queue_full_waits_without_accepting_row_before_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            started.clone(),
            release.clone(),
            WriterConfig {
                shards: 1,
                queue_capacity: 1,
                max_batch_rows: 1,
                max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            },
        );

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
                .await
        );
        started.notified().await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"second.test"}))
                .await
        );

        let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","host":"third.test"}));
        let mut third = std::pin::pin!(third);
        let pending = poll_fn(|cx| match third.as_mut().poll(cx) {
            Poll::Ready(accepted) => Poll::Ready(Some(accepted)),
            Poll::Pending => Poll::Ready(None),
        })
        .await;
        assert_eq!(
            pending, None,
            "third append should wait for bounded queue capacity"
        );

        manager.unregister_source_ip("10.200.0.2").await;
        release.add_permits(2);
        assert!(
            !third.await,
            "append waiting for capacity must re-check source mapping before acceptance"
        );
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        let hosts: Vec<&str> = lines
            .iter()
            .map(|line| line["host"].as_str().unwrap())
            .collect();
        assert_eq!(hosts, ["first.test", "second.test"]);
    }

    #[tokio::test]
    async fn queue_full_rejects_row_after_source_reregister_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            started.clone(),
            release.clone(),
            WriterConfig {
                shards: 1,
                queue_capacity: 1,
                max_batch_rows: 1,
                max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            },
        );

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
                .await
        );
        started.notified().await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"second.test"}))
                .await
        );

        let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","host":"third.test"}));
        let mut third = std::pin::pin!(third);
        let pending = poll_fn(|cx| match third.as_mut().poll(cx) {
            Poll::Ready(accepted) => Poll::Ready(Some(accepted)),
            Poll::Pending => Poll::Ready(None),
        })
        .await;
        assert_eq!(
            pending, None,
            "third append should wait for bounded queue capacity"
        );

        manager.unregister_source_ip("10.200.0.2").await;
        let _new_session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        release.add_permits(2);
        assert!(
            !third.await,
            "append waiting for capacity must not cross source generations"
        );
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        let hosts: Vec<&str> = lines
            .iter()
            .map(|line| line["host"].as_str().unwrap())
            .collect();
        assert_eq!(hosts, ["first.test", "second.test"]);
    }

    #[tokio::test]
    async fn reregistered_source_ip_routes_to_new_path_only() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = dir.path().join("new.jsonl");
        let manager = NetworkLogManager::new();

        let _old_session = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;
        manager.unregister_source_ip("10.200.0.2").await;
        let _new_session = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;

        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );
        manager.flush_path(&new_path).await;

        assert!(!old_path.exists());
        let lines = read_json_lines(&new_path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "new.test");
    }

    #[tokio::test]
    async fn draining_session_accepts_late_rows_until_finalized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;

        manager
            .begin_session_drain(&session.source_ip, &session.path, session.generation)
            .await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"late.test"}))
                .await
        );
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "late.test");

        manager
            .finalize_session(&session.source_ip, &session.path, session.generation)
            .await;
        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"closed.test"}))
                .await
        );
    }

    #[tokio::test]
    async fn old_session_finalize_does_not_remove_new_registration() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = dir.path().join("new.jsonl");
        let manager = NetworkLogManager::new();
        let old = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;

        manager
            .begin_session_drain(&old.source_ip, &old.path, old.generation)
            .await;
        let _new_session = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;
        manager
            .finalize_session(&old.source_ip, &old.path, old.generation)
            .await;

        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );
        manager.flush_path(&new_path).await;

        assert!(!old_path.exists());
        let lines = read_json_lines(&new_path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "new.test");
    }

    #[tokio::test]
    async fn dropped_unclosed_session_finalizes_mapping() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(source_ip_registered(&manager, "10.200.0.2").await);

        drop(session);
        wait_source_ip_unregistered(&manager, "10.200.0.2").await;

        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"after-drop.test"}))
                .await
        );
        manager.flush_path(&path).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn close_for_upload_waits_for_barrier_and_flushes_late_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("test");
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);

        let manager_for_barrier = manager.clone();
        let barrier = tokio::spawn(async move {
            let request = drain_rx.recv().await.expect("drain request");
            assert!(
                manager_for_barrier
                    .append_for_ip(
                        "10.200.0.2",
                        json!({"type":"dns","host":"during-drain.test"}),
                    )
                    .await
            );
            request.ack();
        });

        session.close_for_upload(RunId::nil(), &drain).await;
        barrier.await.unwrap();

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "during-drain.test");
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-close.test"})
                )
                .await
        );
    }

    #[tokio::test]
    async fn close_for_upload_closes_source_before_final_flush() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let before_flush = Arc::new(Notify::new());
        let close_release = Arc::new(Semaphore::new(0));
        let manager =
            NetworkLogManager::new_with_close_gate(before_flush.clone(), close_release.clone());
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let drain = NetworkLogDrainCoordinator::noop();

        let close = tokio::spawn(async move {
            session.close_for_upload(RunId::nil(), &drain).await;
        });
        // Pause at the upload-flush boundary and verify the mapping is already
        // closed, so no row can be accepted after the final flush begins.
        before_flush.notified().await;

        let registered_before_flush = source_ip_registered(&manager, "10.200.0.2").await;
        let accepted_after_close = manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"after-close-before-flush.test"}),
            )
            .await;

        close_release.add_permits(1);
        close.await.unwrap();

        assert!(
            !registered_before_flush,
            "source mapping must be closed before the upload flush begins"
        );
        assert!(
            !accepted_after_close,
            "append_for_ip must reject rows once close_for_upload reaches the final flush"
        );
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn close_for_upload_with_unavailable_producer_finalizes_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let (producer, drain_rx) = NetworkLogDrainProducer::channel("closed");
        drop(drain_rx);
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);

        session.close_for_upload(RunId::nil(), &drain).await;

        assert!(!source_ip_registered(&manager, "10.200.0.2").await);
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-close.test"})
                )
                .await
        );
    }

    #[tokio::test]
    async fn close_for_upload_with_dropped_ack_finalizes_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("dropped-ack");
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);
        let receiver = tokio::spawn(async move {
            let request = drain_rx.recv().await.expect("drain request");
            drop(request);
        });

        session.close_for_upload(RunId::nil(), &drain).await;
        receiver.await.unwrap();

        assert!(!source_ip_registered(&manager, "10.200.0.2").await);
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-close.test"})
                )
                .await
        );
    }

    #[tokio::test]
    async fn close_for_upload_timeout_still_flushes_accepted_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"accepted.test"}),)
                .await
        );
        let (producer, _drain_rx) = NetworkLogDrainProducer::channel("held");
        let drain = NetworkLogDrainCoordinator::new_with_timeout_for_test(
            vec![producer],
            Duration::from_millis(1),
        );

        session.close_for_upload(RunId::nil(), &drain).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "accepted.test");
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-timeout.test"})
                )
                .await
        );
    }
}
