use std::collections::HashSet;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::Mutex;
use tracing::warn;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunnerMode {
    Running,
    Draining,
    Stopping,
    Stopped,
}

#[derive(Debug, Serialize)]
struct RunnerStatus {
    mode: RunnerMode,
    active_runs: usize,
    active_run_ids: Vec<Uuid>,
    #[serde(serialize_with = "serialize_iso")]
    started_at: DateTime<Utc>,
    #[serde(serialize_with = "serialize_iso")]
    updated_at: DateTime<Utc>,
}

/// Serialize as ISO 8601 with millisecond precision, matching JS `Date.toISOString()`.
fn serialize_iso<S: serde::Serializer>(dt: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Thread-safe status tracker that persists state to a JSON file atomically.
///
/// Share via `Arc<StatusTracker>` — immutable fields live outside the mutex.
pub struct StatusTracker {
    started_at: DateTime<Utc>,
    path: PathBuf,
    state: Mutex<MutableState>,
}

struct MutableState {
    mode: RunnerMode,
    active_run_ids: HashSet<Uuid>,
}

impl StatusTracker {
    pub fn new(path: PathBuf) -> Self {
        Self {
            started_at: Utc::now(),
            path,
            state: Mutex::new(MutableState {
                mode: RunnerMode::Running,
                active_run_ids: HashSet::new(),
            }),
        }
    }

    pub async fn set_mode(&self, mode: RunnerMode) {
        let mut state = self.state.lock().await;
        state.mode = mode;
        self.write_status(&state);
    }

    pub async fn add_run(&self, run_id: Uuid) {
        let mut state = self.state.lock().await;
        state.active_run_ids.insert(run_id);
        self.write_status(&state);
    }

    pub async fn remove_run(&self, run_id: Uuid) {
        let mut state = self.state.lock().await;
        state.active_run_ids.remove(&run_id);
        self.write_status(&state);
    }

    /// Write the initial status file.
    pub async fn write_initial(&self) {
        let state = self.state.lock().await;
        self.write_status(&state);
    }

    /// Atomic write: write to a temp file in the same directory, then rename.
    fn write_status(&self, state: &MutableState) {
        let status = RunnerStatus {
            mode: state.mode,
            active_runs: state.active_run_ids.len(),
            active_run_ids: state.active_run_ids.iter().copied().collect(),
            started_at: self.started_at,
            updated_at: Utc::now(),
        };

        let json = match serde_json::to_string_pretty(&status) {
            Ok(j) => j,
            Err(e) => {
                warn!(error = %e, "failed to serialize status");
                return;
            }
        };

        let tmp = self.path.with_extension("tmp");
        if let Err(e) = std::fs::write(&tmp, json.as_bytes()) {
            warn!(error = %e, path = %tmp.display(), "failed to write status temp file");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &self.path) {
            warn!(error = %e, "failed to rename status file");
        }
    }
}
