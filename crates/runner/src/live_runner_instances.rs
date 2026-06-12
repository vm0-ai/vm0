use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use crate::process;
use crate::state_file::OwnerCheck;

const LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub(crate) struct LiveRunnerInstanceMetadata {
    pub config_path: PathBuf,
    pub base_dir: PathBuf,
    pub runner_name: String,
    pub runner_group: String,
    pub subcommand: String,
}

#[derive(Debug)]
pub(crate) struct LiveRunnerInstanceHandle {
    path: PathBuf,
    identity: ProcessIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LiveRunnerInstance {
    pub pid: u32,
    pub starttime: u64,
    pub config_path: PathBuf,
    pub base_dir: PathBuf,
    pub runner_name: String,
    pub runner_group: String,
    pub subcommand: String,
    pub started_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessIdentity {
    boot_id: String,
    pid: u32,
    starttime: u64,
    euid: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileProcessIdentity {
    pid: u32,
    starttime: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LiveRunnerInstanceRecord {
    boot_id: String,
    pid: u32,
    starttime: u64,
    euid: u32,
    config_path: PathBuf,
    base_dir: PathBuf,
    runner_name: String,
    runner_group: String,
    #[serde(default = "default_subcommand")]
    subcommand: String,
    started_at: String,
}

enum RecordForIdentity {
    Valid(LiveRunnerInstanceRecord),
    InvalidForLiveProcess,
    InvalidForStaleProcess,
}

enum RecordRead {
    Valid(LiveRunnerInstanceRecord),
    Missing,
    InvalidFile,
    NotLive,
}

pub(crate) async fn publish(
    home: &HomePaths,
    metadata: LiveRunnerInstanceMetadata,
) -> RunnerResult<LiveRunnerInstanceHandle> {
    let identity = current_process_identity().await?;
    let path = home.live_runner_instance_record_path(identity.pid, identity.starttime);
    let record = LiveRunnerInstanceRecord {
        boot_id: identity.boot_id.clone(),
        pid: identity.pid,
        starttime: identity.starttime,
        euid: identity.euid,
        config_path: metadata.config_path,
        base_dir: metadata.base_dir,
        runner_name: metadata.runner_name,
        runner_group: metadata.runner_group,
        subcommand: metadata.subcommand,
        started_at: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let content = serde_json::to_vec_pretty(&record)
        .map_err(|e| RunnerError::Internal(format!("serialize live runner instance: {e}")))?;

    crate::host_file::ensure_dir(
        &home.live_runner_instances_dir(),
        crate::host_file::DirMode::Private,
        "live runner instances",
    )
    .map_err(|e| {
        RunnerError::Internal(format!(
            "ensure live runner instances {}: {e}",
            home.live_runner_instances_dir().display()
        ))
    })?;
    remove_stale_records(home).await;
    crate::state_file::write_private_atomic(&path, &content).await?;

    Ok(LiveRunnerInstanceHandle { path, identity })
}

pub(crate) async fn try_list(home: &HomePaths) -> RunnerResult<Vec<LiveRunnerInstance>> {
    if !validate_existing_live_runner_instances_dir(home)? {
        return Ok(Vec::new());
    }
    remove_stale_records(home).await;

    let dir = home.live_runner_instances_dir();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "scan live runner instances {}: {e}",
                dir.display()
            )));
        }
    };

    let mut instances = Vec::new();
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "read live runner instance entry in {}: {e}",
                    dir.display()
                )));
            }
        };
        let Some(identity) = stable_record_identity_from_file_name(&entry.file_name()) else {
            continue;
        };
        let path = entry.path();
        let record = match read_record_for_identity(&path, identity).await? {
            RecordForIdentity::Valid(record) => record,
            RecordForIdentity::InvalidForStaleProcess => continue,
            RecordForIdentity::InvalidForLiveProcess => {
                return Err(RunnerError::Internal(format!(
                    "live runner instance record {} is invalid for a live process identity",
                    path.display()
                )));
            }
        };
        instances.push(LiveRunnerInstance {
            pid: record.pid,
            starttime: record.starttime,
            config_path: record.config_path,
            base_dir: record.base_dir,
            runner_name: record.runner_name,
            runner_group: record.runner_group,
            subcommand: record.subcommand,
            started_at: record.started_at,
        });
    }

    instances.sort_by(|left, right| {
        left.runner_name
            .cmp(&right.runner_name)
            .then_with(|| left.pid.cmp(&right.pid))
            .then_with(|| left.config_path.cmp(&right.config_path))
    });
    Ok(instances)
}

fn validate_existing_live_runner_instances_dir(home: &HomePaths) -> RunnerResult<bool> {
    let dir = home.live_runner_instances_dir();
    match std::fs::symlink_metadata(&dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat live runner instances {}: {e}",
                dir.display()
            )));
        }
    }

    crate::host_file::validate_dir(
        &dir,
        crate::host_file::DirMode::Private,
        "live runner instances",
    )
    .map_err(|e| {
        RunnerError::Internal(format!(
            "validate live runner instances {}: {e}",
            dir.display()
        ))
    })?;
    Ok(true)
}

pub(crate) async fn is_current(
    home: &HomePaths,
    instance: &LiveRunnerInstance,
) -> RunnerResult<bool> {
    let identity = FileProcessIdentity {
        pid: instance.pid,
        starttime: instance.starttime,
    };
    let path = home.live_runner_instance_record_path(identity.pid, identity.starttime);
    let record = match read_record_for_identity(&path, identity).await? {
        RecordForIdentity::Valid(record) => record,
        RecordForIdentity::InvalidForStaleProcess => return Ok(false),
        RecordForIdentity::InvalidForLiveProcess => {
            return Err(RunnerError::Internal(format!(
                "live runner instance record {} is invalid for a live process identity",
                path.display()
            )));
        }
    };
    Ok(record.config_path == instance.config_path
        && record.base_dir == instance.base_dir
        && record.runner_name == instance.runner_name
        && record.runner_group == instance.runner_group
        && record.subcommand == instance.subcommand
        && record.started_at == instance.started_at)
}

impl LiveRunnerInstanceHandle {
    pub(crate) async fn remove_if_current(&self) -> RunnerResult<bool> {
        match read_record(&self.path).await? {
            RecordRead::Valid(record)
                if record.boot_id == self.identity.boot_id
                    && record.pid == self.identity.pid
                    && record.starttime == self.identity.starttime
                    && record.euid == self.identity.euid => {}
            RecordRead::InvalidFile => {}
            RecordRead::Missing | RecordRead::NotLive | RecordRead::Valid(_) => return Ok(false),
        }

        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(RunnerError::Internal(format!(
                "remove live runner instance record {}: {e}",
                self.path.display()
            ))),
        }
    }
}

#[cfg(test)]
async fn read_valid_record(path: &Path) -> Option<LiveRunnerInstanceRecord> {
    match read_record(path).await.expect("read live runner record") {
        RecordRead::Valid(record) => Some(record),
        RecordRead::Missing | RecordRead::InvalidFile | RecordRead::NotLive => None,
    }
}

async fn read_record(path: &Path) -> RunnerResult<RecordRead> {
    let content = match crate::state_file::read_to_string(
        path,
        LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES,
        OwnerCheck::CurrentEuid,
    )
    .await
    {
        Ok(Some(content)) => content,
        Ok(None) => return Ok(RecordRead::Missing),
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "ignoring unreadable live runner instance record");
            return Ok(RecordRead::InvalidFile);
        }
    };
    let record: LiveRunnerInstanceRecord = match serde_json::from_str(&content) {
        Ok(record) => record,
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "ignoring malformed live runner instance record");
            return Ok(RecordRead::InvalidFile);
        }
    };
    if record_is_live(&record).await? {
        Ok(RecordRead::Valid(record))
    } else {
        Ok(RecordRead::NotLive)
    }
}

fn default_subcommand() -> String {
    "start".into()
}

async fn remove_stale_records(home: &HomePaths) {
    let dir = home.live_runner_instances_dir();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) => {
            tracing::debug!(path = %dir.display(), error = %e, "cannot scan live runner instances");
            return;
        }
    };

    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::debug!(path = %dir.display(), error = %e, "cannot read live runner instance entry");
                break;
            }
        };
        let file_name = entry.file_name();
        let path = entry.path();
        if let Some(identity) = stable_record_identity_from_file_name(&file_name) {
            match read_record_for_identity(&path, identity).await {
                Err(e) => {
                    tracing::debug!(
                        path = %path.display(),
                        error = %e,
                        "preserving live runner instance record after liveness check failed"
                    );
                }
                Ok(RecordForIdentity::Valid(_)) | Ok(RecordForIdentity::InvalidForLiveProcess) => {}
                Ok(RecordForIdentity::InvalidForStaleProcess) => {
                    remove_stale_file(&path, "stale live runner instance record").await;
                }
            }
            continue;
        }
        let Some(identity) = atomic_tmp_record_identity_from_file_name(&file_name) else {
            continue;
        };
        match file_process_identity_is_live(identity).await {
            Ok(true) => {}
            Ok(false) => {
                remove_stale_file(&path, "stale live runner instance tmp file").await;
            }
            Err(e) => {
                tracing::debug!(
                    path = %path.display(),
                    error = %e,
                    "preserving live runner instance tmp file after liveness check failed"
                );
            }
        }
    }
}

async fn read_record_for_identity(
    path: &Path,
    identity: FileProcessIdentity,
) -> RunnerResult<RecordForIdentity> {
    let record = match read_record(path).await? {
        RecordRead::Valid(record) => record,
        RecordRead::Missing => return Ok(RecordForIdentity::InvalidForStaleProcess),
        RecordRead::InvalidFile | RecordRead::NotLive => {
            return invalid_record_for_identity(identity).await;
        }
    };
    if record.pid == identity.pid && record.starttime == identity.starttime {
        Ok(RecordForIdentity::Valid(record))
    } else {
        tracing::debug!(
            path = %path.display(),
            record_pid = record.pid,
            record_starttime = record.starttime,
            file_pid = identity.pid,
            file_starttime = identity.starttime,
            "ignoring live runner instance record whose contents do not match file name"
        );
        invalid_record_for_identity(identity).await
    }
}

async fn invalid_record_for_identity(
    identity: FileProcessIdentity,
) -> RunnerResult<RecordForIdentity> {
    if file_process_identity_is_live(identity).await? {
        Ok(RecordForIdentity::InvalidForLiveProcess)
    } else {
        Ok(RecordForIdentity::InvalidForStaleProcess)
    }
}

async fn remove_stale_file(path: &Path, reason: &'static str) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {
            tracing::debug!(path = %path.display(), reason, "removed stale live runner instance file");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::debug!(path = %path.display(), reason, error = %e, "cannot remove stale live runner instance file");
        }
    }
}

fn stable_record_identity_from_file_name(name: &OsStr) -> Option<FileProcessIdentity> {
    stable_record_identity_from_str(name.to_str()?)
}

fn stable_record_identity_from_str(name: &str) -> Option<FileProcessIdentity> {
    let stem = name.strip_suffix(".json")?;
    let (pid, starttime) = stem.split_once('-')?;
    Some(FileProcessIdentity {
        pid: pid.parse().ok()?,
        starttime: starttime.parse().ok()?,
    })
}

fn atomic_tmp_record_identity_from_file_name(name: &OsStr) -> Option<FileProcessIdentity> {
    let name = name.to_str()?;
    let tmp_body = name.strip_prefix('.')?.strip_suffix(".tmp")?;
    let (stable_name, _tmp_id) = tmp_body.rsplit_once('.')?;
    stable_record_identity_from_str(stable_name)
}

async fn record_is_live(record: &LiveRunnerInstanceRecord) -> RunnerResult<bool> {
    process_identity_is_live(ProcessIdentity {
        boot_id: record.boot_id.clone(),
        pid: record.pid,
        starttime: record.starttime,
        euid: record.euid,
    })
    .await
}

async fn file_process_identity_is_live(identity: FileProcessIdentity) -> RunnerResult<bool> {
    let boot_id = current_boot_id().await?;
    let identity = ProcessIdentity {
        boot_id: boot_id.clone(),
        pid: identity.pid,
        starttime: identity.starttime,
        euid: current_euid(),
    };
    Ok(process_identity_is_live_for_boot(&identity, &boot_id).await)
}

async fn process_identity_is_live(identity: ProcessIdentity) -> RunnerResult<bool> {
    let boot_id = current_boot_id().await?;
    Ok(process_identity_is_live_for_boot(&identity, &boot_id).await)
}

async fn process_identity_is_live_for_boot(identity: &ProcessIdentity, boot_id: &str) -> bool {
    if identity.boot_id != boot_id {
        return false;
    }
    if identity.euid != current_euid() {
        return false;
    }
    let Some(before) = process::read_process_stat(identity.pid).await else {
        return false;
    };
    if !process::process_stat_is_live(&before) || before.starttime != identity.starttime {
        return false;
    }
    let Some(euid) = read_process_euid(identity.pid).await else {
        return false;
    };
    if euid != identity.euid {
        return false;
    }
    let Some(after) = process::read_process_stat(identity.pid).await else {
        return false;
    };
    process::process_stat_is_live(&after) && after.starttime == identity.starttime
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
        boot_id: current_boot_id().await?,
        pid,
        starttime: stat.starttime,
        euid: current_euid(),
    })
}

async fn current_boot_id() -> RunnerResult<String> {
    let content = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .await
        .map_err(|e| RunnerError::Internal(format!("read boot id: {e}")))?;
    let boot_id = content.trim();
    if boot_id.is_empty() || !boot_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(RunnerError::Internal("read boot id: invalid format".into()));
    }
    Ok(boot_id.to_owned())
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

    fn test_metadata(root: &Path) -> LiveRunnerInstanceMetadata {
        LiveRunnerInstanceMetadata {
            config_path: root.join("runner.yaml"),
            base_dir: root.join("base"),
            runner_name: "test-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
        }
    }

    async fn write_record(path: &Path, record: &LiveRunnerInstanceRecord) {
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
        let record: LiveRunnerInstanceRecord = serde_json::from_str(&content).unwrap();
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
                std::fs::metadata(home.live_runner_instances_dir())
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

        assert_eq!(record.boot_id, handle.identity.boot_id);
        assert_eq!(record.pid, handle.identity.pid);
        assert_eq!(record.starttime, handle.identity.starttime);
    }

    #[tokio::test]
    async fn try_list_returns_empty_when_registry_dir_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));

        let instances = try_list(&home).await.unwrap();

        assert!(instances.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn try_list_rejects_symlinked_registry_dir() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        std::fs::create_dir_all(dir.path().join("target")).unwrap();
        std::fs::create_dir_all(dir.path().join("vm0-runner")).unwrap();
        symlink(dir.path().join("target"), home.live_runner_instances_dir()).unwrap();

        let error = match try_list(&home).await {
            Ok(_) => panic!("expected symlinked registry dir to fail"),
            Err(error) => error,
        };

        assert!(
            error.to_string().contains("validate live runner instances"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn try_list_returns_valid_live_instance_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        let instances = try_list(&home).await.unwrap();

        assert_eq!(instances.len(), 1);
        let instance = &instances[0];
        assert_eq!(instance.pid, handle.identity.pid);
        assert_eq!(instance.starttime, handle.identity.starttime);
        assert_eq!(instance.config_path, dir.path().join("runner.yaml"));
        assert_eq!(instance.base_dir, dir.path().join("base"));
        assert_eq!(instance.runner_name, "test-runner");
        assert_eq!(instance.runner_group, "vm0/test");
        assert_eq!(instance.subcommand, "start");
        assert!(!instance.started_at.is_empty());
    }

    #[tokio::test]
    async fn try_list_defaults_legacy_records_to_start_subcommand() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let content = tokio::fs::read_to_string(&handle.path).await.unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&content).unwrap();
        value.as_object_mut().unwrap().remove("subcommand").unwrap();
        crate::state_file::write_private_atomic(
            &handle.path,
            &serde_json::to_vec_pretty(&value).unwrap(),
        )
        .await
        .unwrap();

        let instances = try_list(&home).await.unwrap();

        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].subcommand, "start");
    }

    #[tokio::test]
    async fn try_list_ignores_invalid_records_for_stale_file_identities() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let stale_record = LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid: u32::MAX,
            starttime: 1,
            euid: current_euid(),
            config_path: dir.path().join("stale-runner.yaml"),
            base_dir: dir.path().join("stale-base"),
            runner_name: "stale-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        write_record(
            &home.live_runner_instance_record_path(stale_record.pid, stale_record.starttime),
            &stale_record,
        )
        .await;
        crate::state_file::write_private_atomic(&home.live_runner_instance_record_path(1, 1), b"{")
            .await
            .unwrap();
        crate::state_file::write_private_atomic(
            &home.live_runner_instance_record_path(2, 2),
            &vec![b'a'; (LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES + 1) as usize],
        )
        .await
        .unwrap();
        crate::state_file::write_private_atomic(
            &home.live_runner_instances_dir().join("not-a-record.json"),
            b"{}",
        )
        .await
        .unwrap();

        let instances = try_list(&home).await.unwrap();

        assert!(instances.is_empty());
    }

    #[tokio::test]
    async fn try_list_fails_closed_for_invalid_record_with_live_file_identity() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        crate::state_file::write_private_atomic(&handle.path, b"{")
            .await
            .unwrap();

        let error = match try_list(&home).await {
            Ok(_) => panic!("expected invalid live record to fail"),
            Err(error) => error,
        };

        assert!(
            error.to_string().contains("live process identity"),
            "{error}"
        );
        assert!(handle.path.exists());
    }

    #[tokio::test]
    async fn try_list_ignores_records_with_mismatched_stale_file_identity() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let record = read_valid_record(&handle.path).await.unwrap();
        tokio::fs::remove_file(&handle.path).await.unwrap();
        write_record(
            &home.live_runner_instance_record_path(record.pid, record.starttime + 1),
            &record,
        )
        .await;

        let instances = try_list(&home).await.unwrap();

        assert!(instances.is_empty());
    }

    #[tokio::test]
    async fn is_current_tracks_the_exact_registry_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let instance = try_list(&home).await.unwrap().into_iter().next().unwrap();

        assert!(is_current(&home, &instance).await.unwrap());

        tokio::fs::remove_file(&handle.path).await.unwrap();

        assert!(!is_current(&home, &instance).await.unwrap());
    }

    #[tokio::test]
    async fn read_valid_record_ignores_stale_pid() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let record = LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid: u32::MAX,
            starttime: 1,
            euid: current_euid(),
            config_path: dir.path().join("runner.yaml"),
            base_dir: dir.path().join("base"),
            runner_name: "test-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let path = home.live_runner_instance_record_path(record.pid, record.starttime);
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
    async fn read_valid_record_ignores_boot_id_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let mut record = read_valid_record(&handle.path).await.unwrap();
        record.boot_id = "00000000-0000-0000-0000-000000000000".into();
        write_record(&handle.path, &record).await;

        let result = read_valid_record(&handle.path).await;

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_valid_record_ignores_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let path = home.live_runner_instances_dir().join("malformed.json");
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
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let path = home.live_runner_instances_dir().join("oversized.json");
        crate::state_file::write_private_atomic(
            &path,
            &vec![b'a'; (LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES + 1) as usize],
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
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let stale_record = LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid: u32::MAX,
            starttime: 1,
            euid: current_euid(),
            config_path: dir.path().join("stale-runner.yaml"),
            base_dir: dir.path().join("stale-base"),
            runner_name: "stale-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let stale_path =
            home.live_runner_instance_record_path(stale_record.pid, stale_record.starttime);
        write_record(&stale_path, &stale_record).await;
        let stale_tmp_path = home
            .live_runner_instances_dir()
            .join(".4294967295-1.json.test.tmp");
        tokio::fs::write(&stale_tmp_path, b"partial").await.unwrap();

        let _handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        assert!(!stale_path.exists());
        assert!(!stale_tmp_path.exists());
    }

    #[tokio::test]
    async fn try_list_removes_stale_records() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        crate::host_file::ensure_dir(
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let stale_record = LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid: u32::MAX,
            starttime: 1,
            euid: current_euid(),
            config_path: dir.path().join("stale-runner.yaml"),
            base_dir: dir.path().join("stale-base"),
            runner_name: "stale-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let stale_path =
            home.live_runner_instance_record_path(stale_record.pid, stale_record.starttime);
        write_record(&stale_path, &stale_record).await;
        let stale_tmp_path = home
            .live_runner_instances_dir()
            .join(".4294967295-1.json.test.tmp");
        tokio::fs::write(&stale_tmp_path, b"partial").await.unwrap();

        let instances = try_list(&home).await.unwrap();

        assert!(instances.is_empty());
        assert!(!stale_path.exists());
        assert!(!stale_tmp_path.exists());
    }

    #[tokio::test]
    async fn publish_removes_records_with_mismatched_file_identity() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        let record = read_valid_record(&handle.path).await.unwrap();
        tokio::fs::remove_file(&handle.path).await.unwrap();
        let mismatched_path =
            home.live_runner_instance_record_path(record.pid, record.starttime + 1);
        write_record(&mismatched_path, &record).await;

        let _handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        assert!(!mismatched_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publish_keeps_other_live_runner_instance_records() {
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
            &home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
        let child_stat = process::read_process_stat(child_pid).await.unwrap();
        let live_record = LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid: child_pid,
            starttime: child_stat.starttime,
            euid: current_euid(),
            config_path: dir.path().join("other-runner.yaml"),
            base_dir: dir.path().join("other-base"),
            runner_name: "other-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let live_path =
            home.live_runner_instance_record_path(live_record.pid, live_record.starttime);
        let live_tmp_path = home.live_runner_instances_dir().join(format!(
            ".{}-{}.json.test.tmp",
            child_pid, child_stat.starttime
        ));
        write_record(&live_path, &live_record).await;
        tokio::fs::write(&live_tmp_path, b"partial").await.unwrap();

        let _handle = publish(&home, test_metadata(dir.path())).await.unwrap();

        assert!(live_path.exists());
        assert!(live_tmp_path.exists());
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

    #[tokio::test]
    async fn remove_if_current_removes_invalid_current_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = publish(&home, test_metadata(dir.path())).await.unwrap();
        crate::state_file::write_private_atomic(&handle.path, b"{")
            .await
            .unwrap();

        let removed = handle.remove_if_current().await.unwrap();

        assert!(removed);
        assert!(!handle.path.exists());
    }
}
