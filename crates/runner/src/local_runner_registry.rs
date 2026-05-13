use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const RUNNER_REGISTRY_TTL: Duration = Duration::from_secs(30);

const RUNNERS_DIR: &str = ".runners";

#[derive(Clone, Debug)]
pub(crate) struct LocalRunnerRegistration {
    registry: LocalRunnerRegistry,
    runner_id: String,
    name: String,
    profiles: Vec<String>,
}

impl LocalRunnerRegistration {
    pub(crate) fn new(
        registry: LocalRunnerRegistry,
        runner_id: String,
        name: String,
        profiles: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            registry,
            runner_id,
            name,
            profiles: normalize_profiles(profiles),
        }
    }

    pub(crate) fn refresh(&self) -> RunnerResult<()> {
        self.registry
            .write_record(&self.runner_id, &self.name, self.profiles.clone())
    }

    pub(crate) fn remove(&self) -> RunnerResult<()> {
        self.registry.remove_record(&self.runner_id)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LocalRunnerRegistry {
    group_dir: PathBuf,
}

impl LocalRunnerRegistry {
    pub(crate) fn new(group_dir: PathBuf) -> Self {
        Self { group_dir }
    }

    pub(crate) fn live_profiles(&self) -> RunnerResult<BTreeSet<String>> {
        Ok(self
            .live_records_at(now_ms(), RUNNER_REGISTRY_TTL)?
            .into_iter()
            .flat_map(|record| record.profiles)
            .collect())
    }

    pub(crate) fn live_profiles_for_runner(&self, name: &str) -> RunnerResult<BTreeSet<String>> {
        Ok(self
            .live_records_at(now_ms(), RUNNER_REGISTRY_TTL)?
            .into_iter()
            .filter(|record| record.name == name)
            .flat_map(|record| record.profiles)
            .collect())
    }

    pub(crate) fn write_record(
        &self,
        runner_id: &str,
        name: &str,
        profiles: Vec<String>,
    ) -> RunnerResult<()> {
        self.write_record_at(runner_id, name, profiles, now_ms())
    }

    pub(crate) fn remove_record(&self, runner_id: &str) -> RunnerResult<()> {
        let path = self.record_path(runner_id, std::process::id());
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(RunnerError::Internal(format!(
                "remove local runner registry record {}: {e}",
                path.display()
            ))),
        }
    }

    fn write_record_at(
        &self,
        runner_id: &str,
        name: &str,
        profiles: Vec<String>,
        updated_at_ms: u64,
    ) -> RunnerResult<()> {
        let runners_dir = self.runners_dir();
        std::fs::create_dir_all(&runners_dir).map_err(|e| {
            RunnerError::Internal(format!(
                "create local runner registry dir {}: {e}",
                runners_dir.display()
            ))
        })?;

        let record = LocalRunnerRecord {
            runner_id: runner_id.to_owned(),
            name: name.to_owned(),
            profiles: normalize_profiles(profiles),
            updated_at_ms,
            pid: Some(std::process::id()),
        };
        let json = serde_json::to_vec(&record)
            .map_err(|e| RunnerError::Internal(format!("serialize local runner registry: {e}")))?;
        let pid = std::process::id();
        let tmp_path = runners_dir.join(format!("{runner_id}.{pid}.tmp"));
        let record_path = self.record_path(runner_id, pid);
        std::fs::write(&tmp_path, json).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            RunnerError::Internal(format!(
                "write local runner registry temp file {}: {e}",
                tmp_path.display()
            ))
        })?;
        std::fs::rename(&tmp_path, &record_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            RunnerError::Internal(format!(
                "publish local runner registry record {}: {e}",
                record_path.display()
            ))
        })?;
        Ok(())
    }

    fn live_records_at(&self, now_ms: u64, ttl: Duration) -> RunnerResult<Vec<LocalRunnerRecord>> {
        let runners_dir = self.runners_dir();
        let entries = match std::fs::read_dir(&runners_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "read local runner registry dir {}: {e}",
                    runners_dir.display()
                )));
            }
        };
        let ttl_ms = duration_millis_u64(ttl);
        let mut records = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "local: failed to read runner registry record");
                    continue;
                }
            };
            let record: LocalRunnerRecord = match serde_json::from_slice(&bytes) {
                Ok(record) => record,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "local: invalid runner registry record");
                    continue;
                }
            };
            if now_ms.saturating_sub(record.updated_at_ms) > ttl_ms {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if let Some(pid) = record.pid
                && !process_is_running(pid)
            {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            records.push(record);
        }
        Ok(records)
    }

    fn runners_dir(&self) -> PathBuf {
        self.group_dir.join(RUNNERS_DIR)
    }

    fn record_path(&self, runner_id: &str, pid: u32) -> PathBuf {
        self.runners_dir().join(format!("{runner_id}-{pid}.json"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LocalRunnerRecord {
    runner_id: String,
    name: String,
    profiles: Vec<String>,
    updated_at_ms: u64,
    #[serde(default)]
    pid: Option<u32>,
}

fn normalize_profiles(profiles: impl IntoIterator<Item = String>) -> Vec<String> {
    profiles
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn now_ms() -> u64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    duration_millis_u64(duration)
}

fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(target_os = "linux")]
fn process_is_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, after_comm)) = stat.rsplit_once(") ") else {
        return false;
    };
    !after_comm.starts_with('Z')
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_is_running(pid: u32) -> bool {
    let Ok(raw_pid) = i32::try_from(pid) else {
        return false;
    };
    let pid = nix::unistd::Pid::from_raw(raw_pid);
    match nix::sys::signal::kill(pid, None) {
        Ok(()) => true,
        Err(nix::errno::Errno::ESRCH) => false,
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn process_is_running(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn registry(dir: &Path) -> LocalRunnerRegistry {
        LocalRunnerRegistry::new(dir.to_path_buf())
    }

    #[test]
    fn writes_and_reads_live_runner_record() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record_at(
                "runner-1",
                "local-a",
                vec!["vm0/default".into(), "vm0/large".into()],
                1_000,
            )
            .unwrap();

        let records = registry
            .live_records_at(1_000, Duration::from_secs(30))
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].runner_id, "runner-1");
        assert_eq!(records[0].name, "local-a");
        assert_eq!(records[0].profiles, vec!["vm0/default", "vm0/large"]);
        assert_eq!(records[0].updated_at_ms, 1_000);
        assert_eq!(records[0].pid, Some(std::process::id()));
    }

    #[test]
    fn aggregates_profiles_from_live_runner_records() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record("runner-a", "a", vec!["vm0/default".into()])
            .unwrap();
        registry
            .write_record("runner-b", "b", vec!["vm0/large".into()])
            .unwrap();

        let profiles = registry.live_profiles().unwrap();
        assert!(profiles.contains("vm0/default"));
        assert!(profiles.contains("vm0/large"));
    }

    #[test]
    fn filters_profiles_by_runner_name() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record("runner-a", "local-a", vec!["vm0/default".into()])
            .unwrap();
        registry
            .write_record("runner-b", "local-b", vec!["vm0/large".into()])
            .unwrap();

        let profiles = registry.live_profiles_for_runner("local-a").unwrap();
        assert!(profiles.contains("vm0/default"));
        assert!(!profiles.contains("vm0/large"));
    }

    #[test]
    fn ignores_and_removes_stale_runner_records() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record_at("runner-1", "local-a", vec!["vm0/default".into()], 1_000)
            .unwrap();

        let records = registry
            .live_records_at(32_000, Duration::from_secs(30))
            .unwrap();
        assert!(records.is_empty());
        assert!(
            !registry
                .record_path("runner-1", std::process::id())
                .exists()
        );
    }

    #[test]
    fn ignores_corrupt_runner_records() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        let runners_dir = registry.runners_dir();
        std::fs::create_dir_all(&runners_dir).unwrap();
        std::fs::write(runners_dir.join("bad.json"), b"not json").unwrap();

        let records = registry
            .live_records_at(1_000, Duration::from_secs(30))
            .unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn ignores_and_removes_dead_runner_records() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        let runners_dir = registry.runners_dir();
        std::fs::create_dir_all(&runners_dir).unwrap();
        let dead_pid = u32::MAX;
        let path = registry.record_path("runner-1", dead_pid);

        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "runner_id": "runner-1",
                "name": "local-a",
                "profiles": ["vm0/default"],
                "updated_at_ms": 1_000,
                "pid": dead_pid,
            }))
            .unwrap(),
        )
        .unwrap();

        let records = registry
            .live_records_at(1_000, Duration::from_secs(30))
            .unwrap();
        assert!(records.is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn normalizes_profiles_in_registry_record() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record_at(
                "runner-1",
                "local-a",
                vec![
                    "vm0/large".into(),
                    "vm0/default".into(),
                    "vm0/default".into(),
                ],
                1_000,
            )
            .unwrap();

        let records = registry
            .live_records_at(1_000, Duration::from_secs(30))
            .unwrap();
        assert_eq!(records[0].profiles, vec!["vm0/default", "vm0/large"]);
    }

    #[test]
    fn remove_record_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record_at("runner-1", "local-a", vec!["vm0/default".into()], 1_000)
            .unwrap();
        registry.remove_record("runner-1").unwrap();
        registry.remove_record("runner-1").unwrap();

        assert!(
            !registry
                .record_path("runner-1", std::process::id())
                .exists()
        );
    }

    #[test]
    fn registration_refresh_and_remove_manage_current_runner_record() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        let registration = LocalRunnerRegistration::new(
            registry.clone(),
            "runner-1".into(),
            "local-a".into(),
            ["vm0/default".to_string()],
        );

        registration.refresh().unwrap();
        let records = registry.live_profiles().unwrap();
        assert!(records.contains("vm0/default"));

        registration.remove().unwrap();
        assert!(registry.live_profiles().unwrap().is_empty());
    }

    #[test]
    fn remove_record_preserves_other_process_record_for_same_runner_id() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());

        registry
            .write_record_at("runner-1", "local-a", vec!["vm0/default".into()], 1_000)
            .unwrap();
        let other_pid = std::process::id().wrapping_add(1);
        let other_path = registry.record_path("runner-1", other_pid);
        std::fs::write(
            &other_path,
            serde_json::to_vec(&serde_json::json!({
                "runner_id": "runner-1",
                "name": "local-b",
                "profiles": ["vm0/large"],
                "updated_at_ms": 1_000,
                "pid": other_pid,
            }))
            .unwrap(),
        )
        .unwrap();

        registry.remove_record("runner-1").unwrap();

        assert!(
            !registry
                .record_path("runner-1", std::process::id())
                .exists()
        );
        assert!(other_path.exists());
    }
}
