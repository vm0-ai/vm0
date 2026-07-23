use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use tokio::sync::{Mutex, Notify};
use tracing::warn;

#[derive(Default)]
pub(super) struct NetworkLogState {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    source_paths: HashMap<String, SourceState>,
    pending_paths: HashMap<PathBuf, PathState>,
    next_generation: u64,
}

enum SourceState {
    Active {
        path: PathBuf,
        generation: u64,
        writer_backpressure_observed: bool,
    },
    Draining {
        path: PathBuf,
        generation: u64,
        writer_backpressure_observed: bool,
    },
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

    fn writer_backpressure_observed(&self) -> bool {
        match self {
            Self::Active {
                writer_backpressure_observed,
                ..
            }
            | Self::Draining {
                writer_backpressure_observed,
                ..
            } => *writer_backpressure_observed,
        }
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

pub(super) struct SourceRegistration {
    pub(super) source_ip: String,
    pub(super) path: PathBuf,
    pub(super) generation: u64,
}

pub(super) struct SourceSnapshot {
    pub(super) path: PathBuf,
    generation: u64,
}

pub(super) struct AcceptedAppend {
    path: PathBuf,
    line: String,
}

impl AcceptedAppend {
    pub(super) fn line_len(&self) -> usize {
        self.line.len()
    }

    pub(super) fn into_parts(self) -> (PathBuf, String) {
        (self.path, self.line)
    }
}

#[derive(Clone)]
pub(super) struct PendingWriteCompletion {
    state: Weak<NetworkLogState>,
}

impl PendingWriteCompletion {
    pub(super) async fn complete_path(&self, path: PathBuf, count: usize) {
        if let Some(state) = self.state.upgrade() {
            state.complete_path(path, count).await;
        }
    }
}

impl NetworkLogState {
    pub(super) fn completion_handle(self: &Arc<Self>) -> PendingWriteCompletion {
        PendingWriteCompletion {
            state: Arc::downgrade(self),
        }
    }

    pub(super) async fn register_source_ip(
        &self,
        source_ip: String,
        path: PathBuf,
    ) -> SourceRegistration {
        let mut state = self.state.lock().await;
        state.next_generation += 1;
        let generation = state.next_generation;
        state.source_paths.insert(
            source_ip.clone(),
            SourceState::Active {
                path: path.clone(),
                generation,
                writer_backpressure_observed: false,
            },
        );
        SourceRegistration {
            source_ip,
            path,
            generation,
        }
    }

    #[cfg(test)]
    pub(super) async fn unregister_source_ip(&self, source_ip: &str) {
        let mut state = self.state.lock().await;
        state.source_paths.remove(source_ip);
    }

    #[cfg(test)]
    pub(super) async fn source_ip_registered(&self, source_ip: &str) -> bool {
        self.state.lock().await.source_paths.contains_key(source_ip)
    }

    pub(super) async fn source_snapshot(&self, source_ip: &str) -> Option<SourceSnapshot> {
        let state = self.state.lock().await;
        state
            .source_paths
            .get(source_ip)
            .map(|source| SourceSnapshot {
                path: source.path().clone(),
                generation: source.generation(),
            })
    }

    pub(super) async fn try_accept_snapshot(
        &self,
        source_ip: &str,
        snapshot: &SourceSnapshot,
        line: String,
    ) -> Option<AcceptedAppend> {
        let mut state = self.state.lock().await;
        let source_state = state.source_paths.get(source_ip)?;
        if !source_state.matches(&snapshot.path, snapshot.generation) {
            return None;
        }
        let path_state = state
            .pending_paths
            .entry(snapshot.path.clone())
            .or_insert_with(PathState::new);
        path_state.pending += 1;
        Some(AcceptedAppend {
            path: snapshot.path.clone(),
            line,
        })
    }

    pub(super) async fn mark_writer_backpressure(
        &self,
        source_ip: &str,
        snapshot: &SourceSnapshot,
    ) {
        let mut state = self.state.lock().await;
        let Some(source_state) = state.source_paths.get_mut(source_ip) else {
            return;
        };
        if !source_state.matches(&snapshot.path, snapshot.generation) {
            return;
        }
        match source_state {
            SourceState::Active {
                writer_backpressure_observed,
                ..
            }
            | SourceState::Draining {
                writer_backpressure_observed,
                ..
            } => *writer_backpressure_observed = true,
        }
    }

    pub(super) async fn begin_session_drain(
        &self,
        source_ip: &str,
        path: &Path,
        generation: u64,
    ) -> bool {
        let mut state = self.state.lock().await;
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return false;
        };
        if !source_state.matches(path, generation) {
            return false;
        }
        let writer_backpressure_observed = source_state.writer_backpressure_observed();
        state.source_paths.insert(
            source_ip.to_string(),
            SourceState::Draining {
                path: path.to_path_buf(),
                generation,
                writer_backpressure_observed,
            },
        );
        true
    }

    pub(super) async fn finalize_session(
        &self,
        source_ip: &str,
        path: &Path,
        generation: u64,
    ) -> bool {
        let mut state = self.state.lock().await;
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return false;
        };
        if !source_state.matches(path, generation) {
            return false;
        }
        let writer_backpressure_observed = source_state.writer_backpressure_observed();
        state.source_paths.remove(source_ip);
        writer_backpressure_observed
    }

    pub(super) async fn flush_path(&self, path: &Path) {
        loop {
            let notified = {
                let state = self.state.lock().await;
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
                let state = self.state.lock().await;
                if !state.pending_paths.contains_key(path) {
                    return;
                }
            }

            notified.as_mut().await;
        }
    }

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
