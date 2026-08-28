use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sandbox::SandboxId;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::lifecycle::RunnerMode;

const STATUS_PERSISTENCE_TIMEOUT: Duration = Duration::from_secs(5);

/// Failure to publish one whole runner status snapshot.
#[derive(Debug, thiserror::Error)]
pub enum StatusPersistenceError {
    #[error("serialize runner status for {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("write runner status {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: RunnerError,
    },
    #[error("runner status persistence for {path} timed out after {timeout:?}")]
    Timeout { path: PathBuf, timeout: Duration },
}

pub type StatusResult<T> = Result<T, StatusPersistenceError>;

/// Active run lifecycle phase serialized as `active_runs[*].phase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActiveRunPhase {
    /// The run is claimed and visible in `active_runs`, but sandbox activation
    /// has not committed. A fresh Firecracker process may not exist yet, while
    /// a reused process may still be parked.
    Preparing,
    /// The sandbox is prepared, and the run is expected to be associated with
    /// a Firecracker process.
    Running,
}

/// One active run entry serialized under `status.json` `active_runs`.
///
/// `run_id` is the user/control-plane visible run identity. `sandbox_id` is
/// the sandbox identity used by runner maintenance commands to correlate
/// Firecracker state. After sandbox reuse these can differ: the sandbox keeps its
/// original `sandbox_id`, while each successive job has a fresh `run_id`.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveRun {
    /// User/control-plane visible run id.
    pub run_id: RunId,
    /// Sandbox id assigned to this run.
    ///
    /// Runner doctor, kill, and exec use this as the join key when correlating
    /// status entries with Firecracker processes.
    pub sandbox_id: SandboxId,
    /// Current active-run phase serialized as `active_runs[*].phase`.
    pub phase: ActiveRunPhase,
    /// Timestamp when the current phase started.
    ///
    /// This is reset on `preparing -> running`; it is not the run creation
    /// timestamp.
    #[serde(serialize_with = "serialize_iso")]
    pub phase_started_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct ActiveRunState {
    sandbox_id: SandboxId,
    phase: ActiveRunPhase,
    phase_started_at: DateTime<Utc>,
}

/// One parked sandbox's reuse identity and Firecracker sandbox identity.
#[derive(Debug, Clone, Serialize)]
pub struct IdleSandbox {
    pub reuse_key: String,
    pub sandbox_id: SandboxId,
}

#[derive(Debug, Serialize)]
struct RunnerStatus {
    mode: RunnerMode,
    max_concurrent: usize,
    active_runs: Vec<ActiveRun>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    idle_sandboxes: Vec<IdleSandbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dns_port: Option<u16>,
    #[serde(serialize_with = "serialize_iso")]
    started_at: DateTime<Utc>,
    #[serde(serialize_with = "serialize_iso")]
    updated_at: DateTime<Utc>,
}

struct StatusSnapshot {
    generation: u64,
    status: RunnerStatus,
}

struct PersistenceState {
    published_generation: u64,
}

#[cfg(test)]
#[derive(Clone)]
struct StatusWriteGate {
    generation: u64,
    started: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
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
    persistence: Mutex<PersistenceState>,
    #[cfg(test)]
    write_gate: Option<StatusWriteGate>,
}

struct MutableState {
    /// Monotonic generation assigned to every requested whole-status write.
    generation: u64,
    mode: RunnerMode,
    /// Map of run_id → active run state for all active runs. Keyed by run_id so
    /// conditional active-run removal stays O(log n); the paired `sandbox_id`
    /// is the join key used by doctor and kill to find the FC process.
    ///
    /// BTreeMap (not HashMap) for deterministic iteration order — status.json
    /// output should be stable across runs for readability and diffing.
    active_runs: BTreeMap<RunId, ActiveRunState>,
    /// Monotonic idle pool mutation revision last reflected in `idle_sandboxes`.
    ///
    /// Idle pool callers snapshot under the pool lock, drop it, then write
    /// status asynchronously. The revision prevents an older delayed snapshot
    /// from overwriting a newer drain/evict state.
    idle_revision: u64,
    idle_sandboxes: Vec<IdleSandbox>,
}

impl StatusTracker {
    /// Build a tracker that will persist status to `path`. The file is
    /// not touched until [`write_initial`](Self::write_initial) — or any
    /// mutator — is called.
    ///
    /// `max_concurrent` is the cap reported in the status file (not
    /// enforced here). `proxy_port` / `dns_port` are set-once
    /// initialization values captured from the MITM proxy and DNS
    /// resolver before the tracker is shared via `Arc`.
    pub fn new(
        path: PathBuf,
        max_concurrent: usize,
        proxy_port: Option<u16>,
        dns_port: Option<u16>,
    ) -> Self {
        Self {
            started_at: Utc::now(),
            max_concurrent,
            proxy_port,
            dns_port,
            path,
            state: Mutex::new(MutableState {
                generation: 0,
                mode: RunnerMode::Starting,
                active_runs: BTreeMap::new(),
                idle_revision: 0,
                idle_sandboxes: Vec::new(),
            }),
            persistence: Mutex::new(PersistenceState {
                published_generation: 0,
            }),
            #[cfg(test)]
            write_gate: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_write_gate(
        path: PathBuf,
        generation: u64,
        started: std::sync::Arc<tokio::sync::Notify>,
        release: std::sync::Arc<tokio::sync::Semaphore>,
    ) -> Self {
        let mut tracker = Self::new(path, 4, None, None);
        tracker.write_gate = Some(StatusWriteGate {
            generation,
            started,
            release,
        });
        tracker
    }

    /// Transition the reported lifecycle mode and flush the status file.
    pub async fn set_mode(&self, mode: RunnerMode) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            state.mode = mode;
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    /// Register an active run as running and flush the status file.
    ///
    /// This preserves the old helper semantics for tests and cleanup fixtures.
    /// Freshly claimed new-sandbox jobs should use [`add_preparing_run`].
    #[cfg(test)]
    pub async fn add_run(&self, run_id: RunId, sandbox_id: SandboxId) -> StatusResult<()> {
        self.add_running_run(run_id, sandbox_id).await
    }

    /// Register an active run whose sandbox has not committed running ownership.
    /// Its Firecracker process may not exist yet or may still be parked.
    pub async fn add_preparing_run(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> StatusResult<()> {
        self.add_run_with_phase(run_id, sandbox_id, ActiveRunPhase::Preparing)
            .await
    }

    /// Register an active run whose Firecracker VM should already exist.
    #[cfg(test)]
    pub async fn add_running_run(&self, run_id: RunId, sandbox_id: SandboxId) -> StatusResult<()> {
        self.add_run_with_phase(run_id, sandbox_id, ActiveRunPhase::Running)
            .await
    }

    async fn add_run_with_phase(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        phase: ActiveRunPhase,
    ) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            state.active_runs.insert(
                run_id,
                ActiveRunState {
                    sandbox_id,
                    phase,
                    phase_started_at: Utc::now(),
                },
            );
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    /// Register a running active run and replace the idle sandbox list in the same
    /// status write if the idle snapshot is current.
    pub async fn add_running_run_with_idle_info_at_revision(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        revision: u64,
        idle_sandboxes: Vec<IdleSandbox>,
    ) -> StatusResult<bool> {
        self.add_run_with_idle_info_at_revision(
            run_id,
            sandbox_id,
            ActiveRunPhase::Running,
            revision,
            idle_sandboxes,
        )
        .await
    }

    /// Register a preparing active run and replace the idle sandbox list in the
    /// same status write if the idle snapshot is current.
    pub async fn add_preparing_run_with_idle_info_at_revision(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        revision: u64,
        idle_sandboxes: Vec<IdleSandbox>,
    ) -> StatusResult<bool> {
        self.add_run_with_idle_info_at_revision(
            run_id,
            sandbox_id,
            ActiveRunPhase::Preparing,
            revision,
            idle_sandboxes,
        )
        .await
    }

    async fn add_run_with_idle_info_at_revision(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        phase: ActiveRunPhase,
        revision: u64,
        idle_sandboxes: Vec<IdleSandbox>,
    ) -> StatusResult<bool> {
        let (applied, snapshot) = {
            let mut state = self.state.lock().await;
            state.active_runs.insert(
                run_id,
                ActiveRunState {
                    sandbox_id,
                    phase,
                    phase_started_at: Utc::now(),
                },
            );
            let applied = apply_idle_info_at_revision(&mut state, revision, idle_sandboxes);
            let snapshot = self.capture_changed_snapshot(&mut state);
            (applied, snapshot)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(applied)
    }

    /// Transition a preparing active run to running only if it still points at
    /// the expected sandbox.
    pub async fn mark_run_running_if_matching(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> StatusResult<bool> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(current) = state.active_runs.get_mut(&run_id) else {
                return Ok(false);
            };
            if current.sandbox_id != sandbox_id {
                return Ok(false);
            }
            current.phase = ActiveRunPhase::Running;
            current.phase_started_at = Utc::now();
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Drop an active run only if it still points at the expected sandbox.
    ///
    /// Returns `false` if another task already removed the run or reused the
    /// `run_id` with a different sandbox.
    pub async fn remove_run_if_matching(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> StatusResult<bool> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let removed = matches!(state.active_runs.get(&run_id), Some(current) if current.sandbox_id == sandbox_id);
            if !removed {
                return Ok(false);
            }
            state.active_runs.remove(&run_id);
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Replace the idle sandbox list only if the snapshot is at least as new as the
    /// last applied idle-pool mutation revision.
    ///
    /// Returns `false` when a stale async writer lost the race to a newer
    /// snapshot and was intentionally ignored.
    pub async fn set_idle_info_at_revision(
        &self,
        revision: u64,
        idle_sandboxes: Vec<IdleSandbox>,
    ) -> StatusResult<bool> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let applied = apply_idle_info_at_revision(&mut state, revision, idle_sandboxes);
            if !applied {
                return Ok(false);
            }
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Write the initial status file.
    pub async fn write_initial(&self) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    fn capture_changed_snapshot(&self, state: &mut MutableState) -> StatusSnapshot {
        state.generation += 1;
        let active_runs: Vec<ActiveRun> = state
            .active_runs
            .iter()
            .map(|(run_id, active)| ActiveRun {
                run_id: *run_id,
                sandbox_id: active.sandbox_id,
                phase: active.phase,
                phase_started_at: active.phase_started_at,
            })
            .collect();

        let status = RunnerStatus {
            mode: state.mode,
            max_concurrent: self.max_concurrent,
            active_runs,
            idle_sandboxes: state.idle_sandboxes.clone(),
            proxy_port: self.proxy_port,
            dns_port: self.dns_port,
            started_at: self.started_at,
            updated_at: Utc::now(),
        };

        StatusSnapshot {
            generation: state.generation,
            status,
        }
    }

    /// Publish an owned snapshot through same-directory atomic replacement.
    async fn persist_snapshot(&self, snapshot: StatusSnapshot) -> StatusResult<()> {
        let path = self.path.clone();
        let persist = async {
            let json = serde_json::to_string_pretty(&snapshot.status).map_err(|source| {
                StatusPersistenceError::Serialize {
                    path: path.clone(),
                    source,
                }
            })?;

            let mut persistence = self.persistence.lock().await;
            if persistence.published_generation >= snapshot.generation {
                return Ok(());
            }

            #[cfg(test)]
            if let Some(gate) = &self.write_gate
                && gate.generation == snapshot.generation
            {
                gate.started.notify_one();
                let permit = gate
                    .release
                    .acquire()
                    .await
                    .expect("status write gate closed");
                permit.forget();
            }

            crate::private_fs::write_private_file(&path, json.as_bytes())
                .await
                .map_err(|source| StatusPersistenceError::Write {
                    path: path.clone(),
                    source,
                })?;
            persistence.published_generation = snapshot.generation;
            Ok(())
        };

        tokio::time::timeout(STATUS_PERSISTENCE_TIMEOUT, persist)
            .await
            .map_err(|_| StatusPersistenceError::Timeout {
                path: self.path.clone(),
                timeout: STATUS_PERSISTENCE_TIMEOUT,
            })?
    }
}

/// Remove a status file from a previous runner process, if present.
///
/// Called only after the new process owns the runner base-dir lock. This clears
/// stale live snapshots before startup has published this process's state.
pub async fn remove_stale_status_file(path: &Path) -> RunnerResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Config(format!(
            "remove stale status file {}: {e}",
            path.display()
        ))),
    }
}

fn apply_idle_info_at_revision(
    state: &mut MutableState,
    revision: u64,
    idle_sandboxes: Vec<IdleSandbox>,
) -> bool {
    if revision < state.idle_revision {
        return false;
    }
    state.idle_revision = revision;
    state.idle_sandboxes = idle_sandboxes;
    true
}

#[cfg(test)]
mod tests {
    use std::future::{Future, poll_fn};
    use std::sync::Arc;
    use std::task::Poll;

    use super::*;
    use tokio::sync::{Notify, Semaphore};

    fn read_status(path: &std::path::Path) -> serde_json::Value {
        let content = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&content).unwrap()
    }

    #[tokio::test]
    async fn write_initial_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        tracker.write_initial().await.unwrap();

        let status = read_status(&path);
        assert_eq!(status["mode"], "starting");
        assert_eq!(status["max_concurrent"], 4);
        assert!(status["active_runs"].as_array().unwrap().is_empty());
        assert!(status["started_at"].as_str().is_some());
        assert!(status["updated_at"].as_str().is_some());
    }

    #[tokio::test]
    async fn blocked_status_write_releases_state_for_new_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let tracker = Arc::new(StatusTracker::new_with_write_gate(
            path.clone(),
            1,
            Arc::clone(&started),
            Arc::clone(&release),
        ));
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let first_write_started = started.notified();
        let first_tracker = Arc::clone(&tracker);
        let first = tokio::spawn(async move {
            first_tracker
                .add_preparing_run(run_id, sandbox_id)
                .await
                .unwrap();
        });
        first_write_started.await;

        let mut second = Box::pin(tracker.set_mode(RunnerMode::Draining));
        let second_is_pending =
            poll_fn(|cx| Poll::Ready(matches!(second.as_mut().poll(cx), Poll::Pending))).await;
        assert!(
            second_is_pending,
            "second transition should wait for ordered persistence"
        );

        {
            let state = tracker
                .state
                .try_lock()
                .expect("state lock should be released before persistence");
            assert_eq!(state.generation, 2);
            assert_eq!(state.mode, RunnerMode::Draining);
            let active = state.active_runs.get(&run_id).unwrap();
            assert_eq!(active.sandbox_id, sandbox_id);
            assert_eq!(active.phase, ActiveRunPhase::Preparing);
        }

        release.add_permits(2);
        first.await.unwrap();
        second.await.unwrap();

        let status = read_status(&path);
        assert_eq!(status["mode"], "draining");
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
        assert_eq!(runs[0]["phase"], "preparing");
    }

    #[tokio::test(start_paused = true)]
    async fn blocked_status_write_times_out_and_releases_persistence_ordering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let tracker = Arc::new(StatusTracker::new_with_write_gate(
            path.clone(),
            1,
            Arc::clone(&started),
            release,
        ));

        let write_started = started.notified();
        let write_tracker = Arc::clone(&tracker);
        let write = tokio::spawn(async move { write_tracker.write_initial().await });
        write_started.await;
        tokio::time::advance(STATUS_PERSISTENCE_TIMEOUT).await;

        let error = write.await.unwrap().unwrap_err();
        assert!(matches!(error, StatusPersistenceError::Timeout { .. }));

        tracker.set_mode(RunnerMode::Running).await.unwrap();
        let status = read_status(&path);
        assert_eq!(status["mode"], "running");
    }

    #[tokio::test]
    async fn failed_status_write_is_reported_and_newer_generation_can_publish() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("missing");
        let path = parent.join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let error = tracker.write_initial().await.unwrap_err();
        assert!(matches!(error, StatusPersistenceError::Write { .. }));

        tokio::fs::create_dir(&parent).await.unwrap();
        tracker.set_mode(RunnerMode::Running).await.unwrap();
        let status = read_status(&path);
        assert_eq!(status["mode"], "running");
    }

    #[tokio::test]
    async fn older_snapshot_does_not_replace_newer_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let (older, newer) = {
            let mut state = tracker.state.lock().await;
            state.mode = RunnerMode::Running;
            let older = tracker.capture_changed_snapshot(&mut state);
            state.mode = RunnerMode::Draining;
            let newer = tracker.capture_changed_snapshot(&mut state);
            (older, newer)
        };

        tracker.persist_snapshot(newer).await.unwrap();
        tracker.persist_snapshot(older).await.unwrap();

        let status = read_status(&path);
        assert_eq!(status["mode"], "draining");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_initial_does_not_follow_stale_status_temp_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let stale_target = dir.path().join("outside-status-target");
        let stale_tmp = dir.path().join("status.tmp");
        std::fs::write(&stale_target, b"do not overwrite").unwrap();
        std::os::unix::fs::symlink(&stale_target, &stale_tmp).unwrap();
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        tracker.write_initial().await.unwrap();

        assert_eq!(std::fs::read(&stale_target).unwrap(), b"do not overwrite");
        assert!(
            std::fs::symlink_metadata(&stale_tmp)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let status = read_status(&path);
        assert_eq!(status["mode"], "starting");
    }

    #[tokio::test]
    async fn remove_stale_status_file_ignores_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");

        remove_stale_status_file(&path).await.unwrap();

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn remove_stale_status_file_removes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        std::fs::write(&path, r#"{"mode":"running"}"#).unwrap();

        remove_stale_status_file(&path).await.unwrap();

        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remove_stale_status_file_removes_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let target = dir.path().join("target-status");
        std::fs::write(&target, b"keep me").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        remove_stale_status_file(&path).await.unwrap();

        assert!(!path.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
    }

    #[tokio::test]
    async fn set_mode_updates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        tracker.write_initial().await.unwrap();
        tracker.set_mode(RunnerMode::Draining).await.unwrap();

        let status = read_status(&path);
        assert_eq!(status["mode"], "draining");
    }

    #[tokio::test]
    async fn add_run_records_sandbox_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        tracker.add_run(run_id, sandbox_id).await.unwrap();

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
        assert_eq!(runs[0]["phase"], "running");
        assert!(runs[0]["phase_started_at"].as_str().is_some());
    }

    #[tokio::test]
    async fn add_preparing_run_records_phase_and_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        tracker.add_preparing_run(run_id, sandbox_id).await.unwrap();

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
        assert_eq!(runs[0]["phase"], "preparing");
        let phase_started_at = runs[0]["phase_started_at"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(phase_started_at).is_ok());
    }

    #[tokio::test]
    async fn mark_run_running_if_matching_updates_only_matching_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        tracker
            .add_preparing_run(run_id, stale_sandbox_id)
            .await
            .unwrap();
        tracker
            .add_preparing_run(run_id, current_sandbox_id)
            .await
            .unwrap();

        assert!(
            !tracker
                .mark_run_running_if_matching(run_id, stale_sandbox_id)
                .await
                .unwrap()
        );
        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());
        assert_eq!(runs[0]["phase"], "preparing");

        assert!(
            tracker
                .mark_run_running_if_matching(run_id, current_sandbox_id)
                .await
                .unwrap()
        );
        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());
        assert_eq!(runs[0]["phase"], "running");
    }

    #[tokio::test]
    async fn add_and_remove_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let run1 = RunId::new_v4();
        let sb1 = SandboxId::new_v4();
        let run2 = RunId::new_v4();
        let sb2 = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        tracker.add_run(run1, sb1).await.unwrap();
        tracker.add_run(run2, sb2).await.unwrap();

        let status = read_status(&path);
        assert_eq!(status["active_runs"].as_array().unwrap().len(), 2);

        assert!(tracker.remove_run_if_matching(run1, sb1).await.unwrap());

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run2.to_string());
        assert_eq!(runs[0]["sandbox_id"], sb2.to_string());
    }

    #[tokio::test]
    async fn remove_run_if_matching_preserves_replaced_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        let run_id = RunId::new_v4();
        let old_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        tracker.add_run(run_id, old_sandbox_id).await.unwrap();
        tracker.add_run(run_id, current_sandbox_id).await.unwrap();

        assert!(
            !tracker
                .remove_run_if_matching(run_id, old_sandbox_id)
                .await
                .unwrap()
        );

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());

        assert!(
            tracker
                .remove_run_if_matching(run_id, current_sandbox_id)
                .await
                .unwrap()
        );

        let status = read_status(&path);
        assert!(status["active_runs"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn proxy_port_in_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, Some(8080), None);
        tracker.write_initial().await.unwrap();

        let status = read_status(&path);
        assert_eq!(status["proxy_port"], 8080);
    }

    #[tokio::test]
    async fn proxy_port_absent_when_not_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        tracker.write_initial().await.unwrap();

        let status = read_status(&path);
        assert!(status.get("proxy_port").is_none());
    }

    #[tokio::test]
    async fn timestamps_are_iso8601() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        tracker.write_initial().await.unwrap();

        let status = read_status(&path);
        let started = status["started_at"].as_str().unwrap();
        // ISO 8601 format: YYYY-MM-DDTHH:MM:SS.mmmZ
        assert!(started.ends_with('Z'));
        assert!(started.contains('T'));
        assert_eq!(started.len(), 24); // "2026-02-10T12:34:56.789Z"
    }

    #[tokio::test]
    async fn set_idle_info_at_revision_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        tracker.write_initial().await.unwrap();

        let status = read_status(&path);
        assert!(status.get("idle_sandboxes").is_none());
        assert!(status.get("idle_vms").is_none());

        let sb1 = SandboxId::new_v4();
        let sb2 = SandboxId::new_v4();
        assert!(
            tracker
                .set_idle_info_at_revision(
                    1,
                    vec![
                        IdleSandbox {
                            reuse_key: "sess-1".into(),
                            sandbox_id: sb1,
                        },
                        IdleSandbox {
                            reuse_key: "sess-2".into(),
                            sandbox_id: sb2,
                        },
                    ],
                )
                .await
                .unwrap()
        );

        let status = read_status(&path);
        assert!(status.get("idle_vms").is_none());
        let sandboxes = status["idle_sandboxes"].as_array().unwrap();
        assert_eq!(sandboxes.len(), 2);
        assert_eq!(sandboxes[0]["reuse_key"], "sess-1");
        assert_eq!(sandboxes[0]["sandbox_id"], sb1.to_string());
        assert_eq!(sandboxes[1]["reuse_key"], "sess-2");
        assert_eq!(sandboxes[1]["sandbox_id"], sb2.to_string());
    }

    #[tokio::test]
    async fn stale_idle_info_revision_does_not_overwrite_newer_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);
        let stale_id = SandboxId::new_v4();
        let fresh_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        assert!(
            tracker
                .set_idle_info_at_revision(
                    2,
                    vec![IdleSandbox {
                        reuse_key: "fresh".into(),
                        sandbox_id: fresh_id,
                    }],
                )
                .await
                .unwrap()
        );
        assert!(
            !tracker
                .set_idle_info_at_revision(
                    1,
                    vec![IdleSandbox {
                        reuse_key: "stale".into(),
                        sandbox_id: stale_id,
                    }],
                )
                .await
                .unwrap()
        );

        let status = read_status(&path);
        let sandboxes = status["idle_sandboxes"].as_array().unwrap();
        assert_eq!(sandboxes.len(), 1);
        assert_eq!(sandboxes[0]["reuse_key"], "fresh");
        assert_eq!(sandboxes[0]["sandbox_id"], fresh_id.to_string());
    }

    #[tokio::test]
    async fn delayed_cleanup_snapshot_does_not_overwrite_newer_replacement_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);
        let original_id = SandboxId::new_v4();
        let replacement_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        assert!(
            tracker
                .set_idle_info_at_revision(
                    1,
                    vec![IdleSandbox {
                        reuse_key: "sess-replaced".into(),
                        sandbox_id: original_id,
                    }],
                )
                .await
                .unwrap()
        );

        // A cleanup/pressure eviction path captured this empty snapshot after
        // removing the original sandbox, then got delayed before publishing it.
        let delayed_cleanup_revision = 2;
        let delayed_cleanup_snapshot = Vec::new();

        // Meanwhile the same reuse key is parked again with a newer sandbox.
        assert!(
            tracker
                .set_idle_info_at_revision(
                    3,
                    vec![IdleSandbox {
                        reuse_key: "sess-replaced".into(),
                        sandbox_id: replacement_id,
                    }],
                )
                .await
                .unwrap()
        );

        assert!(
            !tracker
                .set_idle_info_at_revision(delayed_cleanup_revision, delayed_cleanup_snapshot)
                .await
                .unwrap()
        );

        let status = read_status(&path);
        let sandboxes = status["idle_sandboxes"].as_array().unwrap();
        assert_eq!(sandboxes.len(), 1);
        assert_eq!(sandboxes[0]["reuse_key"], "sess-replaced");
        assert_eq!(sandboxes[0]["sandbox_id"], replacement_id.to_string());
    }

    #[tokio::test]
    async fn add_run_with_idle_info_revision_preserves_newer_idle_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);
        let idle_id = SandboxId::new_v4();
        let stale_id = SandboxId::new_v4();
        let run_id = RunId::new_v4();
        let active_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        assert!(
            tracker
                .set_idle_info_at_revision(
                    2,
                    vec![IdleSandbox {
                        reuse_key: "fresh".into(),
                        sandbox_id: idle_id,
                    }],
                )
                .await
                .unwrap()
        );
        assert!(
            !tracker
                .add_running_run_with_idle_info_at_revision(
                    run_id,
                    active_id,
                    1,
                    vec![IdleSandbox {
                        reuse_key: "stale".into(),
                        sandbox_id: stale_id,
                    }],
                )
                .await
                .unwrap()
        );

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], active_id.to_string());
        assert_eq!(runs[0]["phase"], "running");
        let sandboxes = status["idle_sandboxes"].as_array().unwrap();
        assert_eq!(sandboxes.len(), 1);
        assert_eq!(sandboxes[0]["reuse_key"], "fresh");
        assert_eq!(sandboxes[0]["sandbox_id"], idle_id.to_string());
    }

    #[tokio::test]
    async fn add_preparing_run_with_idle_info_revision_records_preparing_phase() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);
        let idle_id = SandboxId::new_v4();
        let run_id = RunId::new_v4();
        let active_id = SandboxId::new_v4();

        tracker.write_initial().await.unwrap();
        assert!(
            tracker
                .add_preparing_run_with_idle_info_at_revision(
                    run_id,
                    active_id,
                    1,
                    vec![IdleSandbox {
                        reuse_key: "fresh-create-after-reuse-miss".into(),
                        sandbox_id: idle_id,
                    }],
                )
                .await
                .unwrap()
        );

        let status = read_status(&path);
        let runs = status["active_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run_id"], run_id.to_string());
        assert_eq!(runs[0]["sandbox_id"], active_id.to_string());
        assert_eq!(runs[0]["phase"], "preparing");
        let sandboxes = status["idle_sandboxes"].as_array().unwrap();
        assert_eq!(sandboxes.len(), 1);
        assert_eq!(sandboxes[0]["reuse_key"], "fresh-create-after-reuse-miss");
        assert_eq!(sandboxes[0]["sandbox_id"], idle_id.to_string());
    }

    #[tokio::test]
    async fn set_idle_info_at_revision_empty_omitted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let tracker = StatusTracker::new(path.clone(), 4, None, None);

        assert!(tracker.set_idle_info_at_revision(1, vec![]).await.unwrap());

        let status = read_status(&path);
        assert!(
            status.get("idle_sandboxes").is_none(),
            "empty idle_sandboxes should be omitted from JSON"
        );
    }
}
