use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use crate::process;
use crate::state_file::OwnerCheck;

const LIVE_RUNNER_RECORD_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub(crate) struct LiveRunnerRegistryMetadata {
    pub config_path: PathBuf,
    pub base_dir: PathBuf,
    pub runner_name: String,
    pub runner_group: String,
}

#[derive(Debug)]
pub(crate) struct LiveRunnerRegistryHandle {
    path: PathBuf,
    identity: ProcessIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessIdentity {
    pid: u32,
    starttime: u64,
    euid: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LiveRunnerRegistryRecord {
    pid: u32,
    starttime: u64,
    euid: u32,
    config_path: PathBuf,
    base_dir: PathBuf,
    runner_name: String,
    runner_group: String,
    started_at: String,
}

pub(crate) async fn publish(
    home: &HomePaths,
    metadata: LiveRunnerRegistryMetadata,
) -> RunnerResult<LiveRunnerRegistryHandle> {
    let identity = current_process_identity().await?;
    let path = home.live_runner_record_path(identity.pid, identity.starttime);
    let record = LiveRunnerRegistryRecord {
        pid: identity.pid,
        starttime: identity.starttime,
        euid: identity.euid,
        config_path: metadata.config_path,
        base_dir: metadata.base_dir,
        runner_name: metadata.runner_name,
        runner_group: metadata.runner_group,
        started_at: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let content = serde_json::to_vec_pretty(&record)
        .map_err(|e| RunnerError::Internal(format!("serialize live runner registry: {e}")))?;

    crate::host_file::ensure_dir(
        &home.live_runners_dir(),
        crate::host_file::DirMode::Private,
        "live runner registry",
    )
    .map_err(|e| {
        RunnerError::Internal(format!(
            "ensure live runner registry {}: {e}",
            home.live_runners_dir().display()
        ))
    })?;
    remove_stale_records(home).await;
    crate::state_file::write_private_atomic(&path, &content).await?;

    Ok(LiveRunnerRegistryHandle { path, identity })
}

impl LiveRunnerRegistryHandle {
    pub(crate) async fn remove_if_current(&self) -> RunnerResult<bool> {
        let Some(record) = read_valid_record(&self.path).await else {
            return Ok(false);
        };
        if record.pid != self.identity.pid
            || record.starttime != self.identity.starttime
            || record.euid != self.identity.euid
        {
            return Ok(false);
        }

        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(RunnerError::Internal(format!(
                "remove live runner registry record {}: {e}",
                self.path.display()
            ))),
        }
    }
}

async fn read_valid_record(path: &Path) -> Option<LiveRunnerRegistryRecord> {
    let content = match crate::state_file::read_to_string(
        path,
        LIVE_RUNNER_RECORD_MAX_BYTES,
        OwnerCheck::CurrentEuid,
    )
    .await
    {
        Ok(Some(content)) => content,
        Ok(None) => return None,
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "ignoring unreadable live runner registry record");
            return None;
        }
    };
    let record: LiveRunnerRegistryRecord = match serde_json::from_str(&content) {
        Ok(record) => record,
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "ignoring malformed live runner registry record");
            return None;
        }
    };
    if record_is_live(&record).await {
        Some(record)
    } else {
        None
    }
}

async fn remove_stale_records(home: &HomePaths) {
    let dir = home.live_runners_dir();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) => {
            tracing::debug!(path = %dir.display(), error = %e, "cannot scan live runner registry");
            return;
        }
    };

    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::debug!(path = %dir.display(), error = %e, "cannot read live runner registry entry");
                break;
            }
        };
        if !is_stable_record_file_name(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if read_valid_record(&path).await.is_some() {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                tracing::debug!(path = %path.display(), "removed stale live runner registry record");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::debug!(path = %path.display(), error = %e, "cannot remove stale live runner registry record");
            }
        }
    }
}

fn is_stable_record_file_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((pid, starttime)) = stem.split_once('-') else {
        return false;
    };
    [pid, starttime]
        .into_iter()
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

async fn record_is_live(record: &LiveRunnerRegistryRecord) -> bool {
    if record.euid != current_euid() {
        return false;
    }
    let Some(before) = process::read_process_stat(record.pid).await else {
        return false;
    };
    if !process::process_stat_is_live(&before) || before.starttime != record.starttime {
        return false;
    }
    let Some(euid) = read_process_euid(record.pid).await else {
        return false;
    };
    if euid != record.euid {
        return false;
    }
    let Some(after) = process::read_process_stat(record.pid).await else {
        return false;
    };
    process::process_stat_is_live(&after) && after.starttime == record.starttime
}

async fn current_process_identity() -> RunnerResult<ProcessIdentity> {
    let pid = std::process::id();
    let stat = process::read_process_stat(pid)
        .await
        .ok_or_else(|| RunnerError::Internal(format!("read current process stat for pid {pid}")))?;
    if !process::process_stat_is_live(&stat) {
        return Err(RunnerError::Internal(format!(
            "current process pid {pid} is not live"
        )));
    }
    Ok(ProcessIdentity {
        pid,
        starttime: stat.starttime,
        euid: current_euid(),
    })
}

async fn read_process_euid(pid: u32) -> Option<u32> {
    let path = format!("/proc/{pid}/status");
    let content = tokio::fs::read_to_string(path).await.ok()?;
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("Uid:") {
            let mut parts = value.split_whitespace();
            let _real_uid = parts.next()?;
            return parts.next()?.parse().ok();
        }
    }
    None
}

#[cfg(unix)]
fn current_euid() -> u32 {
    nix::unistd::geteuid().as_raw()
}

#[cfg(not(unix))]
fn current_euid() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_metadata(root: &Path) -> LiveRunnerRegistryMetadata {
        LiveRunnerRegistryMetadata {
            config_path: root.join("runner.yaml"),
            base_dir: root.join("base"),
            runner_name: "test-runner".into(),
            runner_group: "vm0/test".into(),
        }
    }

    async fn write_record(path: &Path, record: &LiveRunnerRegistryRecord) {
        let content = serde_json::to_vec_pretty(record).unwrap();
        crate::state_file::write_private_atomic(path, &content)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn publish_writes_private_record_without_secret_fields() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));

        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        let content = tokio::fs::read_to_string(&handle.path).await.unwrap();
        assert!(!content.contains("server"));
        assert!(!content.contains("token"));
        assert!(!content.contains("api_url"));
        let record: LiveRunnerRegistryRecord = serde_json::from_str(&content).unwrap();
        assert_eq!(record.pid, std::process::id());
        assert_eq!(record.euid, current_euid());
        assert_eq!(record.base_dir, dir.path().join("base"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let metadata = std::fs::symlink_metadata(&handle.path).unwrap();
            assert!(metadata.file_type().is_file());
            assert!(!metadata.file_type().is_symlink());
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert_eq!(
                std::fs::metadata(home.live_runners_dir())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[tokio::test]
    async fn read_valid_record_accepts_matching_live_identity() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        let record = read_valid_record(&handle.path).await.unwrap();

        assert_eq!(record.pid, handle.identity.pid);
        assert_eq!(record.starttime, handle.identity.starttime);
    }

    #[tokio::test]
    async fn read_valid_record_ignores_stale_pid() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runners_dir(),
            crate::host_file::DirMode::Private,
            "live runner registry",
        )
        .unwrap();
        let record = LiveRunnerRegistryRecord {
            pid: u32::MAX,
            starttime: 1,
            euid: current_euid(),
            config_path: dir.path().join("runner.yaml"),
            base_dir: dir.path().join("base"),
            runner_name: "test-runner".into(),
            runner_group: "vm0/test".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let path = home.live_runner_record_path(record.pid, record.starttime);
        write_record(&path, &record).await;

        let result = read_valid_record(&path).await;

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_valid_record_ignores_starttime_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let mut record = read_valid_record(&handle.path).await.unwrap();
        record.starttime += 1;
        write_record(&handle.path, &record).await;

        let result = read_valid_record(&handle.path).await;

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_valid_record_ignores_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runners_dir(),
            crate::host_file::DirMode::Private,
            "live runner registry",
        )
        .unwrap();
        let path = home.live_runners_dir().join("malformed.json");
        crate::state_file::write_private_atomic(&path, b"{")
            .await
            .unwrap();

        let result = read_valid_record(&path).await;

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_valid_record_ignores_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runners_dir(),
            crate::host_file::DirMode::Private,
            "live runner registry",
        )
        .unwrap();
        let path = home.live_runners_dir().join("oversized.json");
        crate::state_file::write_private_atomic(
            &path,
            &vec![b'a'; (LIVE_RUNNER_RECORD_MAX_BYTES + 1) as usize],
        )
        .await
        .unwrap();

        let result = read_valid_record(&path).await;

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn publish_removes_stale_records() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runners_dir(),
            crate::host_file::DirMode::Private,
            "live runner registry",
        )
        .unwrap();
        let stale_record = LiveRunnerRegistryRecord {
            pid: u32::MAX,
            starttime: 1,
            euid: current_euid(),
            config_path: dir.path().join("stale-runner.yaml"),
            base_dir: dir.path().join("stale-base"),
            runner_name: "stale-runner".into(),
            runner_group: "vm0/test".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let stale_path = home.live_runner_record_path(stale_record.pid, stale_record.starttime);
        write_record(&stale_path, &stale_record).await;

        let _handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        assert!(!stale_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publish_keeps_other_live_runner_records() {
        struct ChildGuard(std::process::Child);

        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let child = ChildGuard(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap(),
        );
        let child_pid = child.0.id();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runners_dir(),
            crate::host_file::DirMode::Private,
            "live runner registry",
        )
        .unwrap();
        let child_stat = process::read_process_stat(child_pid).await.unwrap();
        let live_record = LiveRunnerRegistryRecord {
            pid: child_pid,
            starttime: child_stat.starttime,
            euid: current_euid(),
            config_path: dir.path().join("other-runner.yaml"),
            base_dir: dir.path().join("other-base"),
            runner_name: "other-runner".into(),
            runner_group: "vm0/test".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let live_path = home.live_runner_record_path(live_record.pid, live_record.starttime);
        write_record(&live_path, &live_record).await;

        let _handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        assert!(live_path.exists());
    }

    #[tokio::test]
    async fn remove_if_current_removes_matching_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        let removed = handle.remove_if_current().await.unwrap();

        assert!(removed);
        assert!(!handle.path.exists());
    }

    #[tokio::test]
    async fn remove_if_current_preserves_mismatched_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let mut record = read_valid_record(&handle.path).await.unwrap();
        record.starttime += 1;
        write_record(&handle.path, &record).await;

        let removed = handle.remove_if_current().await.unwrap();

        assert!(!removed);
        assert!(handle.path.exists());
    }
}
