use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use sandbox::SandboxId;
use serde::Serialize;
use tokio::sync::Mutex;
use tracing::warn;

use crate::ids::RunId;

/// Runner lifecycle state.
///
/// - `Running`: normal operation — discover and claim new jobs.
/// - `Draining`: soft drain. No new jobs claimed; in-flight jobs keep
///   running; idle pool destroyed. **Resumable** via SIGUSR2.
/// - `Stopping`: irreversible teardown in progress — discovery released,
///   per-job tokens cancelled, factories/proxy/kmsg/dns shutting down.
///   Reached via SIGTERM/SIGINT, or automatically from `Draining` once
///   `jobs.is_empty()`.
/// - `Stopped`: teardown complete. The process exits immediately after
///   writing this state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunnerMode {
    Running,
    Draining,
    Stopping,
    Stopped,
}

/// One active run's identity: the `run_id` the user sees and the `sandbox_id`
/// that identifies the Firecracker VM hosting it. After sandbox reuse these
/// differ: the VM keeps its original `sandbox_id` while each successive job
/// has a fresh `run_id`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ActiveRun {
    pub run_id: RunId,
    pub sandbox_id: SandboxId,
}

/// One parked (idle) sandbox's identity: the `session_id` it's keyed by in
/// the idle pool and the `sandbox_id` of the Firecracker VM kept alive for
/// reuse. Pairing these as a struct (rather than parallel arrays) matches
/// `ActiveRun` and avoids the "indexed-by-position" bug class.
#[derive(Debug, Clone, Serialize)]
pub struct IdleVm {
    pub session_id: String,
    pub sandbox_id: SandboxId,
}

#[derive(Debug, Serialize)]
struct RunnerStatus {
    mode: RunnerMode,
    max_concurrent: usize,
    active_runs: Vec<ActiveRun>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    idle_vms: Vec<IdleVm>,
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
    /// Map of run_id → sandbox_id for all active runs. Keyed by run_id so
    /// `remove_run(run_id)` stays O(log n); the paired `sandbox_id` is the
    /// join key used by doctor and kill to find the FC process.
    ///
    /// BTreeMap (not HashMap) for deterministic iteration order — status.json
    /// output should be stable across runs for readability and diffing.
    active_runs: BTreeMap<RunId, SandboxId>,
    idle_vms: Vec<IdleVm>,
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
                active_runs: BTreeMap::new(),
                idle_vms: Vec::new(),
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

    pub async fn add_run(&self, run_id: RunId, sandbox_id: SandboxId) {
        let mut state = self.state.lock().await;
        state.active_runs.insert(run_id, sandbox_id);
        self.write_status(&state).await;
    }

    pub async fn remove_run(&self, run_id: RunId) {
        let mut state = self.state.lock().await;
        state.active_runs.remove(&run_id);
        self.write_status(&state).await;
    }

    /// Replace the idle VM list in the status file with `idle_vms`.
    pub async fn set_idle_info(&self, idle_vms: Vec<IdleVm>) {
        let mut state = self.state.lock().await;
        state.idle_vms = idle_vms;
        self.write_status(&state).await;
    }

    /// Write the initial status file.
    pub async fn write_initial(&self) {
        let state = self.state.lock().await;
        self.write_status(&state).await;
    }

    /// Atomic write: write to a temp file in the same directory, then rename.
    async fn write_status(&self, state: &MutableState) {
        let active_runs: Vec<ActiveRun> = state
            .active_runs
            .iter()
            .map(|(rid, sid)| ActiveRun {
                run_id: *rid,
                sandbox_id: *sid,
            })
            .collect();

        let status = RunnerStatus {
            mode: state.mode,
            max_concurrent: self.max_concurrent,
            active_runs,
            idle_vms: state.idle_vms.clone(),
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
        assert!(status["active_runs"].as_array().unwrap().is_empty());
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
    async fn add_run_records_sandbox_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        tracker.write_initial().await;
        tracker.add_run(run_id, sandbox_id).await;

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
    }

    #[tokio::test]
    async fn add_and_remove_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        let run1 = RunId::new_v4();
        let sb1 = SandboxId::new_v4();
        let run2 = RunId::new_v4();
        let sb2 = SandboxId::new_v4();

        tracker.write_initial().await;
        tracker.add_run(run1, sb1).await;
        tracker.add_run(run2, sb2).await;

        let status = read_status(&path);
        assert_eq!(status["active_runs"].as_array().unwrap().len(), 2);

        tracker.remove_run(run1).await;

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run2.to_string());
        assert_eq!(runs[0]["sandbox_id"], sb2.to_string());
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
    async fn set_idle_info_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.write_initial().await;

        let status = read_status(&path);
        assert!(status.get("idle_vms").is_none()); // empty vec omitted

        let sb1 = SandboxId::new_v4();
        let sb2 = SandboxId::new_v4();
        tracker
            .set_idle_info(vec![
                IdleVm {
                    session_id: "sess-1".into(),
                    sandbox_id: sb1,
                },
                IdleVm {
                    session_id: "sess-2".into(),
                    sandbox_id: sb2,
                },
            ])
            .await;

        let status = read_status(&path);
        let vms = status["idle_vms"].as_array().unwrap();
        assert_eq!(vms.len(), 2);
        assert_eq!(vms[0]["session_id"], "sess-1");
        assert_eq!(vms[0]["sandbox_id"], sb1.to_string());
        assert_eq!(vms[1]["session_id"], "sess-2");
        assert_eq!(vms[1]["sandbox_id"], sb2.to_string());
    }

    #[tokio::test]
    async fn set_idle_info_empty_omitted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4);

        tracker.set_idle_info(vec![]).await;

        let status = read_status(&path);
        assert!(
            status.get("idle_vms").is_none(),
            "empty idle_vms should be omitted from JSON"
        );
    }
}
