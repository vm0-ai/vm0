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
    pending_paths: HashMap<Arc<Path>, PathState>,
    next_generation: u64,
}

enum SourceState {
    Active {
        path: Arc<Path>,
        generation: u64,
        writer_backpressure_observed: bool,
    },
    Draining {
        path: Arc<Path>,
        generation: u64,
        writer_backpressure_observed: bool,
    },
}

impl SourceState {
    fn path(&self) -> &Arc<Path> {
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
        self.generation() == generation && self.path().as_ref() == path
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
    pub(super) path: Arc<Path>,
    pub(super) generation: u64,
}

pub(super) struct SourceSnapshot {
    pub(super) path: Arc<Path>,
    generation: u64,
}

pub(super) struct AcceptedAppend {
    path: Arc<Path>,
    line: String,
}

impl AcceptedAppend {
    pub(super) fn line_len(&self) -> usize {
        self.line.len()
    }

    pub(super) fn into_parts(self) -> (Arc<Path>, String) {
        (self.path, self.line)
    }
}

#[derive(Clone)]
pub(super) struct PendingWriteCompletion {
    state: Weak<NetworkLogState>,
}

impl PendingWriteCompletion {
    pub(super) async fn complete_path(&self, path: Arc<Path>, count: usize) {
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
        let path: Arc<Path> = path.into();
        state.source_paths.insert(
            source_ip.clone(),
            SourceState::Active {
                path: Arc::clone(&path),
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

    #[cfg(test)]
    pub(super) async fn source_and_pending_path_share_identity(
        &self,
        source_ip: &str,
        path: &Path,
    ) -> bool {
        let state = self.state.lock().await;
        let Some(source) = state.source_paths.get(source_ip) else {
            return false;
        };
        let Some((pending_path, _)) = state.pending_paths.get_key_value(path) else {
            return false;
        };
        Arc::ptr_eq(source.path(), pending_path)
    }

    pub(super) async fn source_snapshot(&self, source_ip: &str) -> Option<SourceSnapshot> {
        let state = self.state.lock().await;
        state
            .source_paths
            .get(source_ip)
            .map(|source| SourceSnapshot {
                path: Arc::clone(source.path()),
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
        if !source_state.matches(snapshot.path.as_ref(), snapshot.generation) {
            return None;
        }
        let path_state = state
            .pending_paths
            .entry(Arc::clone(&snapshot.path))
            .or_insert_with(PathState::new);
        path_state.pending += 1;
        Some(AcceptedAppend {
            path: Arc::clone(&snapshot.path),
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
        if !source_state.matches(snapshot.path.as_ref(), snapshot.generation) {
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
        let path = Arc::clone(source_state.path());
        let writer_backpressure_observed = source_state.writer_backpressure_observed();
        state.source_paths.insert(
            source_ip.to_string(),
            SourceState::Draining {
                path,
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

    async fn complete_path(&self, path: Arc<Path>, count: usize) {
        if count == 0 {
            return;
        }
        let notify = {
            let mut state = self.state.lock().await;
            let Some(path_state) = state.pending_paths.get_mut(path.as_ref()) else {
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
                state
                    .pending_paths
                    .remove(path.as_ref())
                    .map(|state| state.notify)
            } else {
                None
            }
        };

        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }
}
