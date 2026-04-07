use std::collections::BTreeSet;
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
    max_concurrent: usize,
    active_runs: usize,
    active_run_ids: Vec<Uuid>,
    idle_vms: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    idle_sessions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dns_port: Option<u16>,
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
    max_concurrent: usize,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    path: PathBuf,
    state: Mutex<MutableState>,
}

struct MutableState {
    mode: RunnerMode,
    active_run_ids: BTreeSet<Uuid>,
    idle_vms: usize,
    idle_sessions: Vec<String>,
}

impl StatusTracker {
    pub fn new(path: PathBuf, max_concurrent: usize) -> Self {
        Self {
            started_at: Utc::now(),
            max_concurrent,
            proxy_port: None,
            dns_port: None,
            path,
            state: Mutex::new(MutableState {
                mode: RunnerMode::Running,
                active_run_ids: BTreeSet::new(),
                idle_vms: 0,
                idle_sessions: Vec::new(),
            }),
        }
    }

    pub async fn set_proxy_port(&mut self, port: u16) {
        self.proxy_port = Some(port);
        let state = self.state.lock().await;
        self.write_status(&state).await;
    }

    pub async fn set_dns_port(&mut self, port: u16) {
        self.dns_port = Some(port);
        let state = self.state.lock().await;
        self.write_status(&state).await;
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

    /// Update idle VM count and session list in the status file.
    pub async fn set_idle_info(&self, idle_vms: usize, idle_sessions: Vec<String>) {
        let mut state = self.state.lock().await;
        state.idle_vms = idle_vms;
        state.idle_sessions = idle_sessions;
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
            max_concurrent: self.max_concurrent,
            active_runs: state.active_run_ids.len(),
            active_run_ids: state.active_run_ids.iter().copied().collect(),
            idle_vms: state.idle_vms,
            idle_sessions: state.idle_sessions.clone(),
            proxy_port: self.proxy_port,
            dns_port: self.dns_port,
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
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.write_initial().await;

        let status = read_status(&path);
        assert_eq!(status["mode"], "running");
        assert_eq!(status["max_concurrent"], 4);
        assert_eq!(status["active_runs"], 0);
        assert!(status["active_run_ids"].as_array().unwrap().is_empty());
        assert!(status["started_at"].as_str().is_some());
        assert!(status["updated_at"].as_str().is_some());
    }

    #[tokio::test]
    async fn set_mode_updates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.write_initial().await;
        tracker.set_mode(RunnerMode::Draining).await;

        let status = read_status(&path);
        assert_eq!(status["mode"], "draining");
    }

    #[tokio::test]
    async fn add_and_remove_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

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
    async fn proxy_port_in_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let mut tracker = StatusTracker::new(path.clone(), 4);
        tracker.set_proxy_port(8080).await;

        let status = read_status(&path);
        assert_eq!(status["proxy_port"], 8080);
    }

    #[tokio::test]
    async fn proxy_port_absent_when_not_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.write_initial().await;

        let status = read_status(&path);
        assert!(status.get("proxy_port").is_none());
    }

    #[tokio::test]
    async fn timestamps_are_iso8601() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.write_initial().await;

        let status = read_status(&path);
        let started = status["started_at"].as_str().unwrap();
        // ISO 8601 format: YYYY-MM-DDTHH:MM:SS.mmmZ
        assert!(started.ends_with('Z'));
        assert!(started.contains('T'));
        assert_eq!(started.len(), 24); // "2026-02-10T12:34:56.789Z"
    }

    #[tokio::test]
    async fn set_idle_info_updates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.write_initial().await;

        let status = read_status(&path);
        assert_eq!(status["idle_vms"], 0);
        assert!(status.get("idle_sessions").is_none()); // empty vec omitted

        tracker
            .set_idle_info(2, vec!["sess-1".into(), "sess-2".into()])
            .await;

        let status = read_status(&path);
        assert_eq!(status["idle_vms"], 2);
        let sessions: Vec<String> = status["idle_sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(sessions, vec!["sess-1", "sess-2"]);
    }

    #[tokio::test]
    async fn set_idle_info_empty_sessions_omitted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.set_idle_info(0, vec![]).await;

        let status = read_status(&path);
        assert_eq!(status["idle_vms"], 0);
        assert!(
            status.get("idle_sessions").is_none(),
            "empty idle_sessions should be omitted from JSON"
        );
    }
}
