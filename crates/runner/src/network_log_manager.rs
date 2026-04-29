use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(test)]
use tokio::sync::Semaphore;
use tokio::sync::{Mutex, Notify};
use tracing::{debug, warn};

/// Coordinates Rust-side DNS/kmsg network log attribution and file writes.
///
/// Source-IP lookup and pending-write registration happen under the same lock,
/// so `flush_path` cannot miss a row that was already accepted for that path.
#[derive(Clone, Default)]
pub struct NetworkLogManager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    #[cfg(test)]
    write_gate: Option<WriteGate>,
}

#[derive(Default)]
struct State {
    source_paths: HashMap<String, PathBuf>,
    pending_paths: HashMap<PathBuf, PathState>,
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
            }),
        }
    }

    pub async fn register_source_ip(&self, source_ip: impl Into<String>, path: PathBuf) {
        let mut state = self.inner.state.lock().await;
        state.source_paths.insert(source_ip.into(), path);
    }

    pub async fn unregister_source_ip(&self, source_ip: &str) {
        let mut state = self.inner.state.lock().await;
        state.source_paths.remove(source_ip);
    }

    /// Accept a JSON network-log row for a source IP.
    ///
    /// Returns `true` when the source IP was mapped and the write was accepted.
    /// The actual append is asynchronous; call `flush_path` before reading the
    /// file when a complete snapshot is required.
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
            let Some(path) = state.source_paths.get(source_ip).cloned() else {
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
                    debug!(path = %path.display(), error = %e, "failed to write network log");
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
                debug!(path = %path.display(), "network log write completed for unknown path");
                return;
            };

            if path_state.pending == 0 {
                debug!(path = %path.display(), "network log pending count already zero");
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

    use serde_json::json;

    use super::*;

    fn read_json_lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn append_for_ip_writes_json_line_to_registered_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        manager.register_source_ip("10.200.0.2", path.clone()).await;
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

        manager.register_source_ip("10.200.0.2", path.clone()).await;
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

        manager.register_source_ip("10.200.0.2", path.clone()).await;
        manager.register_source_ip("10.200.0.3", path.clone()).await;

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

        manager.register_source_ip("10.200.0.2", path.clone()).await;
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

        manager.register_source_ip("10.200.0.2", path.clone()).await;
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

        manager.register_source_ip("10.200.0.2", path.clone()).await;
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

        manager
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
        manager
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

        manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;
        manager.unregister_source_ip("10.200.0.2").await;
        manager
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
}
