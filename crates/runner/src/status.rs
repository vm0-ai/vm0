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
        self.write_status(&state).await;
    }

    pub async fn add_run(&self, run_id: Uuid) {
        let mut state = self.state.lock().await;
        state.active_run_ids.insert(run_id);
        self.write_status(&state).await;
    }

    pub async fn remove_run(&self, run_id: Uuid) {
        let mut state = self.state.lock().await;
        state.active_run_ids.remove(&run_id);
        self.write_status(&state).await;
    }

    /// Write the initial status file.
    pub async fn write_initial(&self) {
        let state = self.state.lock().await;
        self.write_status(&state).await;
    }

    /// Atomic write: write to a temp file in the same directory, then rename.
    async fn write_status(&self, state: &MutableState) {
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
        if let Err(e) = tokio::fs::write(&tmp, json.as_bytes()).await {
            warn!(error = %e, path = %tmp.display(), "failed to write status temp file");
            return;
        }
        if let Err(e) = tokio::fs::rename(&tmp, &self.path).await {
            warn!(error = %e, "failed to rename status file");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_status(path: &std::path::Path) -> serde_json::Value {
        let content = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&content).unwrap()
    }

    #[tokio::test]
    async fn write_initial_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone());

        tracker.write_initial().await;

        let status = read_status(&path);
        assert_eq!(status["mode"], "running");
        assert_eq!(status["active_runs"], 0);
        assert!(status["active_run_ids"].as_array().unwrap().is_empty());
        assert!(status["started_at"].as_str().is_some());
        assert!(status["updated_at"].as_str().is_some());
    }

    #[tokio::test]
    async fn set_mode_updates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone());

        tracker.write_initial().await;
        tracker.set_mode(RunnerMode::Draining).await;

        let status = read_status(&path);
        assert_eq!(status["mode"], "draining");
    }

    #[tokio::test]
    async fn add_and_remove_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone());

        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();

        tracker.write_initial().await;
        tracker.add_run(id1).await;
        tracker.add_run(id2).await;

        let status = read_status(&path);
        assert_eq!(status["active_runs"], 2);
        assert_eq!(status["active_run_ids"].as_array().unwrap().len(), 2);

        tracker.remove_run(id1).await;

        let status = read_status(&path);
        assert_eq!(status["active_runs"], 1);

        let ids: Vec<String> = status["active_run_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(ids.contains(&id2.to_string()));
        assert!(!ids.contains(&id1.to_string()));
    }

    #[tokio::test]
    async fn timestamps_are_iso8601() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone());

        tracker.write_initial().await;

        let status = read_status(&path);
        let started = status["started_at"].as_str().unwrap();
        // ISO 8601 format: YYYY-MM-DDTHH:MM:SS.mmmZ
        assert!(started.ends_with('Z'));
        assert!(started.contains('T'));
        assert_eq!(started.len(), 24); // "2026-02-10T12:34:56.789Z"
    }
}
