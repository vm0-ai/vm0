use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(test)]
use tokio::sync::Semaphore;
use tokio::sync::{Mutex, Notify};
use tracing::warn;

use crate::ids::RunId;
use crate::network_log_drain::{NetworkLogDrainContext, NetworkLogDrainCoordinator};

/// Coordinates Rust-side DNS/kmsg network log attribution and file writes.
///
/// Source-IP lookup and pending-write registration happen under the same lock,
/// so `flush_path` cannot miss a row that was already accepted for that path.
/// `NetworkLogSession::close_for_upload` first closes the source mapping, then
/// flushes the path so upload cannot miss a newly accepted row.
#[derive(Clone, Default)]
pub struct NetworkLogManager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
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
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                write_gate: Some(WriteGate { started, release }),
                close_gate: None,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_close_gate(
        before_flush: Arc<Notify>,
        close_release: Arc<Semaphore>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                write_gate: None,
                close_gate: Some(CloseGate {
                    before_flush,
                    release: close_release,
                }),
            }),
        }
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

        let path = {
            let mut state = self.inner.state.lock().await;
            let Some(path) = state
                .source_paths
                .get(source_ip)
                .map(SourceState::path)
                .cloned()
            else {
                return false;
            };
            let path_state = state
                .pending_paths
                .entry(path.clone())
                .or_insert_with(PathState::new);
            path_state.pending += 1;
            path
        };

        self.spawn_append(path, line);
        true
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
            notified.await;
        }
    }

    #[cfg(test)]
    async fn before_close_upload_flush_for_test(&self) {
        if let Some(gate) = self.inner.close_gate.as_ref() {
            gate.before_flush.notify_one();
            let _permit = gate.release.acquire().await.expect("close gate closed");
        }
    }

    fn spawn_append(&self, path: PathBuf, line: String) {
        let manager = self.clone();
        #[cfg(test)]
        let write_gate = self.inner.write_gate.clone();

        tokio::spawn(async move {
            #[cfg(test)]
            if let Some(gate) = write_gate {
                gate.started.notify_one();
                let _permit = gate.release.acquire().await.expect("write gate closed");
            }

            let write_path = path.clone();
            let result = tokio::task::spawn_blocking(move || append_line(&write_path, &line)).await;

            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    warn!(path = %path.display(), error = %e, "failed to write network log")
                }
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "network log writer task failed");
                }
            }

            manager.complete_path(path).await;
        });
    }

    async fn complete_path(&self, path: PathBuf) {
        let notify = {
            let mut state = self.inner.state.lock().await;
            let Some(path_state) = state.pending_paths.get_mut(&path) else {
                warn!(path = %path.display(), "network log write completed for unknown path");
                return;
            };

            if path_state.pending == 0 {
                warn!(path = %path.display(), "network log pending count already zero");
                return;
            }

            path_state.pending -= 1;
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

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o644)
        .open(path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
}

#[cfg(test)]
mod tests {
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use std::time::Duration;

    use serde_json::json;

    use crate::ids::RunId;
    use crate::network_log_drain::{NetworkLogDrainCoordinator, NetworkLogDrainProducer};

    use super::*;

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

        let second_started = started.notified();
        assert!(
            manager
                .append_for_ip("10.200.0.3", json!({"type":"dns","host":"second.test"}))
                .await
        );
        second_started.await;

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

        release.add_permits(1);
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
        let new_started = started.notified();
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );
        new_started.await;

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
