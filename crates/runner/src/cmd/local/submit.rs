//! `runner local submit` — submit a job to locally running runners via file queue.
//!
//! Writes a `{job_id}.job` file into a profile-specific partition and polls
//! for a group-wide `{job_id}.result` file written by the runner that claimed
//! the job.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{self, JobRequest, JobResponse};
use crate::paths::HomePaths;

/// Poll interval for checking the result file.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Grace period after Ctrl+C to wait for the runner to write a `.result` file.
const CANCEL_GRACE: Duration = Duration::from_secs(10);

#[derive(Args)]
pub struct SubmitArgs {
    /// Runner group name (writes job to the group's local queue)
    #[arg(long)]
    group: String,
    /// Job prompt
    #[arg(long)]
    prompt: String,
    /// Agent type
    #[arg(long, default_value = "claude-code")]
    cli_agent_type: String,
    /// VM profile to use (e.g. "vm0/default")
    #[arg(long)]
    profile: Option<String>,
    /// Session ID for sandbox reuse across conversation turns
    #[arg(long)]
    session_id: Option<String>,
    /// Feature flags (repeatable, format: key=value, e.g. --feature-flag myFlag=true)
    #[arg(long = "feature-flag")]
    feature_flags: Vec<String>,
    /// Timeout in seconds waiting for a runner to complete the job
    #[arg(long, default_value_t = 300)]
    timeout: u64,
}

/// Detect the system timezone from the `TZ` env var or `/etc/timezone`.
fn detect_system_timezone() -> Option<String> {
    if let Ok(tz) = std::env::var("TZ")
        && !tz.is_empty()
    {
        return Some(tz);
    }
    std::fs::read_to_string("/etc/timezone")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Try to read a non-empty result file.  Returns `None` if the file does
/// not exist, is empty, or cannot be read.
fn try_read_result(result_path: &std::path::Path) -> Option<Vec<u8>> {
    match std::fs::read(result_path) {
        Ok(b) if !b.is_empty() => Some(b),
        _ => None,
    }
}

fn remove_file_if_exists(path: &std::path::Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

struct PublishedMarker {
    bytes: Vec<u8>,
    dev: u64,
    ino: u64,
}

struct SubmitQueueEntry {
    job_id: RunId,
    job_dir: PathBuf,
    job: PathBuf,
    result: PathBuf,
    cancel: PathBuf,
    claim: PathBuf,
}

impl SubmitQueueEntry {
    fn for_job(group_dir: &Path, profile: &str, job_id: RunId) -> RunnerResult<Self> {
        Ok(Self {
            job_id,
            job_dir: local_queue::profile_jobs_dir(group_dir, profile)?,
            job: local_queue::job_path(group_dir, profile, job_id)?,
            result: local_queue::result_path(group_dir, job_id),
            cancel: local_queue::cancel_path(group_dir, job_id),
            claim: local_queue::claim_path(group_dir, job_id),
        })
    }

    /// Clean up queue files after a completed job has produced a result.
    fn cleanup_completed(&self) {
        let job_removed = remove_file_if_exists(&self.job);
        let _ = remove_file_if_exists(&self.cancel);
        let _ = remove_file_if_exists(&self.claim);
        if job_removed {
            let _ = remove_file_if_exists(&self.result);
        }
    }

    /// Clean up submit-owned queue files after timing out while waiting for a result.
    fn cleanup_abandoned(&self, marker: Option<&PublishedMarker>) {
        if remove_file_if_exists(&self.job) && !self.claim.exists() {
            let _ = remove_file_if_exists(&self.cancel);
            if marker.is_some() {
                remove_marker_if_unchanged(&self.result, marker);
            } else if result_file_is_empty(&self.result) {
                let _ = remove_file_if_exists(&self.result);
            }
        }
    }

    fn abandon(&self, error: &str) {
        let marker = write_abandoned_result_marker(&self.result, self.job_id, error);
        self.cleanup_abandoned(marker.as_ref());
    }
}

fn write_abandoned_result_marker(
    result_path: &std::path::Path,
    run_id: RunId,
    error: &str,
) -> Option<PublishedMarker> {
    // The result file is the durable terminal marker observed by local
    // runners.  Use it to prevent an abandoned job from being rediscovered
    // without creating a fake claim that could strand the job if submit exits.
    if try_read_result(result_path).is_some() {
        return None;
    }

    let response = JobResponse {
        run_id,
        exit_code: 1,
        error: Some(error.to_owned()),
    };
    let Ok(json) = serde_json::to_vec(&response) else {
        return None;
    };
    let result_dir = result_path.parent()?;
    if std::fs::create_dir_all(result_dir).is_err() {
        return None;
    }

    let tmp_path = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
    {
        Ok(file) => file,
        Err(_) => return None,
    };
    if std::io::Write::write_all(&mut file, &json).is_err() {
        let _ = remove_file_if_exists(&tmp_path);
        return None;
    }
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => {
            let _ = remove_file_if_exists(&tmp_path);
            return None;
        }
    };
    drop(file);

    // Publish with a no-clobber hard link so a runner result that wins the
    // race is never overwritten, and crashes before publish cannot leave a
    // partial terminal marker at the final result path.
    if std::fs::hard_link(&tmp_path, result_path).is_err() {
        let _ = remove_file_if_exists(&tmp_path);
        return None;
    }
    let _ = remove_file_if_exists(&tmp_path);
    Some(PublishedMarker {
        bytes: json,
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

fn result_file_is_empty(result_path: &std::path::Path) -> bool {
    std::fs::metadata(result_path)
        .map(|metadata| metadata.is_file() && metadata.len() == 0)
        .unwrap_or(false)
}

fn remove_marker_if_unchanged(result_path: &std::path::Path, marker: Option<&PublishedMarker>) {
    let Some(marker) = marker else {
        return;
    };
    let Ok(metadata) = std::fs::metadata(result_path) else {
        return;
    };
    if metadata.dev() != marker.dev || metadata.ino() != marker.ino {
        return;
    }
    if std::fs::read(result_path)
        .map(|current| current == marker.bytes)
        .unwrap_or(false)
    {
        let _ = remove_file_if_exists(result_path);
    }
}

struct SubmitPlan {
    group: String,
    profile: String,
    queue: SubmitQueueEntry,
    timeout: Duration,
    request_json: Vec<u8>,
}

enum SubmitOutcome {
    Completed(Vec<u8>),
    Cancelled,
}

impl SubmitPlan {
    fn from_args(args: SubmitArgs, home: HomePaths) -> RunnerResult<Self> {
        let SubmitArgs {
            group,
            prompt,
            cli_agent_type,
            profile,
            session_id,
            feature_flags,
            timeout,
        } = args;

        crate::group::validate_or_err(&group)?;

        let profile = match profile {
            Some(profile) => {
                crate::profile::validate_or_err(&profile)?;
                profile
            }
            None => crate::profile::DEFAULT_PROFILE.to_owned(),
        };

        let feature_flags = Self::parse_feature_flags(&feature_flags)?;
        let group_dir = home.groups_dir().join(&group);
        let job_dir = local_queue::profile_jobs_dir(&group_dir, &profile)?;

        std::fs::create_dir_all(&job_dir).map_err(|e| {
            RunnerError::Config(format!("create job dir {}: {e}", job_dir.display()))
        })?;
        std::fs::create_dir_all(local_queue::results_dir(&group_dir))
            .map_err(|e| RunnerError::Config(format!("create results dir: {e}")))?;
        std::fs::create_dir_all(local_queue::cancels_dir(&group_dir))
            .map_err(|e| RunnerError::Config(format!("create cancels dir: {e}")))?;

        let job_id = RunId::new_v4();
        let request = JobRequest {
            job_id,
            prompt,
            cli_agent_type,
            vars: None,
            environment: None,
            user_timezone: detect_system_timezone(),
            profile: Some(profile.clone()),
            session_id,
            feature_flags,
        };

        let request_json = serde_json::to_vec(&request)
            .map_err(|e| RunnerError::Internal(format!("serialize request: {e}")))?;
        let queue = SubmitQueueEntry::for_job(&group_dir, &profile, job_id)?;

        Ok(Self {
            group,
            profile,
            queue,
            timeout: Duration::from_secs(timeout),
            request_json,
        })
    }

    fn parse_feature_flags(flags: &[String]) -> RunnerResult<Option<HashMap<String, bool>>> {
        if flags.is_empty() {
            return Ok(None);
        }

        let mut map = HashMap::new();
        for flag in flags {
            let (key, value) = flag.split_once('=').ok_or_else(|| {
                RunnerError::Config(format!("invalid feature flag (expected key=value): {flag}"))
            })?;
            let bool_val = value.parse::<bool>().map_err(|_| {
                RunnerError::Config(format!(
                    "invalid feature flag value (expected true/false): {flag}"
                ))
            })?;
            map.insert(key.to_string(), bool_val);
        }
        Ok(Some(map))
    }

    fn write_job_file(&self) -> RunnerResult<()> {
        let tmp_path = self
            .queue
            .job_dir
            .join(format!("{}.job.tmp", self.queue.job_id));
        if let Err(e) = std::fs::write(&tmp_path, &self.request_json) {
            let _ = remove_file_if_exists(&tmp_path);
            return Err(RunnerError::Internal(format!("write job file: {e}")));
        }
        if let Err(e) = std::fs::rename(&tmp_path, &self.queue.job) {
            let _ = remove_file_if_exists(&tmp_path);
            return Err(RunnerError::Internal(format!("rename job file: {e}")));
        }
        Ok(())
    }

    async fn wait_for_result(&self) -> RunnerResult<SubmitOutcome> {
        let deadline = tokio::time::Instant::now() + self.timeout;

        loop {
            if let Some(buf) = try_read_result(&self.queue.result) {
                return Ok(SubmitOutcome::Completed(buf));
            }
            if tokio::time::Instant::now() >= deadline {
                if let Some(buf) = try_read_result(&self.queue.result) {
                    return Ok(SubmitOutcome::Completed(buf));
                }
                let error = format!(
                    "timeout waiting for local result after {:?} (group: {}, profile: {}). no local runner may be running for this group, or no runner in the group may support this profile",
                    self.timeout, self.group, self.profile
                );
                self.abandon(&error);
                return Err(RunnerError::Internal(error));
            }
            tokio::select! {
                () = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("interrupted — requesting cancel for {}", self.queue.job_id);
                    let _ = std::fs::write(&self.queue.cancel, b"");
                    return Ok(self.wait_for_cancel_grace().await);
                }
            }
        }
    }

    async fn wait_for_cancel_grace(&self) -> SubmitOutcome {
        let grace = tokio::time::Instant::now() + CANCEL_GRACE;
        loop {
            if let Some(buf) = try_read_result(&self.queue.result) {
                return SubmitOutcome::Completed(buf);
            }
            if tokio::time::Instant::now() >= grace {
                eprintln!("grace period expired, exiting");
                // Leave .cancel for the runner to process — don't delete it here
                // or the cancel request may be lost.
                self.abandon("local submit cancelled before job completed");
                return SubmitOutcome::Cancelled;
            }
            tokio::select! {
                () = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("second interrupt, exiting immediately");
                    self.abandon("local submit interrupted before job completed");
                    return SubmitOutcome::Cancelled;
                }
            }
        }
    }

    fn abandon(&self, error: &str) {
        self.queue.abandon(error);
    }

    fn finish_completed(&self, buf: &[u8]) -> RunnerResult<ExitCode> {
        let response: JobResponse = serde_json::from_slice(buf)
            .map_err(|e| RunnerError::Internal(format!("parse result: {e}")))?;

        self.queue.cleanup_completed();

        std::io::stdout().write_all(buf).ok();
        std::io::stdout().write_all(b"\n").ok();

        if response.exit_code == 0 {
            Ok(ExitCode::SUCCESS)
        } else {
            Ok(ExitCode::FAILURE)
        }
    }
}

pub async fn run_submit(args: SubmitArgs) -> RunnerResult<ExitCode> {
    run_submit_with_home(args, HomePaths::new()?).await
}

async fn run_submit_with_home(args: SubmitArgs, home: HomePaths) -> RunnerResult<ExitCode> {
    let plan = SubmitPlan::from_args(args, home)?;
    plan.write_job_file()?;
    match plan.wait_for_result().await? {
        SubmitOutcome::Completed(buf) => plan.finish_completed(&buf),
        SubmitOutcome::Cancelled => Ok(ExitCode::FAILURE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialize tests that mutate environment variables to prevent UB.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    fn submit_queue_entry(group_dir: &Path, job_id: RunId) -> SubmitQueueEntry {
        SubmitQueueEntry::for_job(group_dir, crate::profile::DEFAULT_PROFILE, job_id).unwrap()
    }

    #[test]
    fn detect_system_timezone_from_env() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let original = std::env::var("TZ").ok();
        // SAFETY: ENV_MUTEX ensures no other test mutates env concurrently.
        unsafe { std::env::set_var("TZ", "America/New_York") };
        let tz = detect_system_timezone();
        match original {
            Some(orig) => unsafe { std::env::set_var("TZ", orig) },
            None => unsafe { std::env::remove_var("TZ") },
        }
        assert_eq!(tz, Some("America/New_York".to_string()));
    }

    #[test]
    fn detect_system_timezone_empty_env() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let original = std::env::var("TZ").ok();
        // SAFETY: ENV_MUTEX ensures no other test mutates env concurrently.
        unsafe { std::env::set_var("TZ", "") };
        let tz = detect_system_timezone();
        match original {
            Some(orig) => unsafe { std::env::set_var("TZ", orig) },
            None => unsafe { std::env::remove_var("TZ") },
        }
        // Empty TZ falls through to /etc/timezone
        assert_ne!(tz, Some("".to_string()));
    }

    #[test]
    fn try_read_result_nonexistent_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.result");
        assert!(try_read_result(&path).is_none());
    }

    #[test]
    fn try_read_result_empty_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.result");
        std::fs::write(&path, b"").unwrap();
        assert!(try_read_result(&path).is_none());
    }

    #[test]
    fn try_read_result_with_content_returns_some() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("valid.result");
        std::fs::write(&path, b"{\"exit_code\":0}").unwrap();
        let result = try_read_result(&path).unwrap();
        assert_eq!(result, b"{\"exit_code\":0}");
    }

    #[test]
    fn abandoned_marker_write_publishes_without_tmp_residue() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let result_path = local_queue::result_path(group_dir, job_id);

        let marker =
            write_abandoned_result_marker(&result_path, job_id, "local submit abandoned").unwrap();

        assert_eq!(std::fs::read(&result_path).unwrap(), marker.bytes);
        let result_dir = local_queue::results_dir(group_dir);
        let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
    }

    #[test]
    fn abandoned_marker_write_cleans_tmp_when_publish_fails() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let result_path = local_queue::result_path(group_dir, job_id);
        std::fs::create_dir_all(&result_path).unwrap();

        let marker = write_abandoned_result_marker(&result_path, job_id, "local submit abandoned");

        assert!(marker.is_none());
        assert!(result_path.is_dir());
        let result_dir = local_queue::results_dir(group_dir);
        let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
    }

    #[test]
    fn abandoned_marker_write_preserves_existing_empty_result() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let result_path = local_queue::result_path(group_dir, job_id);
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        std::fs::write(&result_path, b"").unwrap();

        let marker = write_abandoned_result_marker(&result_path, job_id, "local submit abandoned");

        assert!(marker.is_none());
        assert!(result_file_is_empty(&result_path));
        let result_dir = local_queue::results_dir(group_dir);
        let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
    }

    #[test]
    fn abandoned_cleanup_keeps_replaced_result_with_same_content() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        let marker =
            write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();
        let replacement_path = queue.result.with_extension("replacement");
        std::fs::write(&replacement_path, &marker.bytes).unwrap();
        std::fs::rename(&replacement_path, &queue.result).unwrap();

        queue.cleanup_abandoned(Some(&marker));

        assert!(
            queue.result.exists(),
            "cleanup must not remove a result that replaced the submit marker"
        );
    }

    #[test]
    fn abandoned_cleanup_keeps_mutated_result_with_same_marker_inode() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        let marker =
            write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();
        let marker_metadata = std::fs::metadata(&queue.result).unwrap();
        let runner_result = b"runner result";
        let mut result_file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&queue.result)
            .unwrap();
        std::io::Write::write_all(&mut result_file, runner_result).unwrap();
        drop(result_file);
        let current_metadata = std::fs::metadata(&queue.result).unwrap();
        assert_eq!(marker_metadata.dev(), current_metadata.dev());
        assert_eq!(marker_metadata.ino(), current_metadata.ino());

        queue.cleanup_abandoned(Some(&marker));

        assert!(!queue.job.exists());
        assert_eq!(std::fs::read(&queue.result).unwrap(), runner_result);
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    async fn wait_for_job_and_write_result(
        group_dir: std::path::PathBuf,
        profile: String,
        exit_code: i32,
        error: Option<String>,
    ) -> JobRequest {
        let job_dir = local_queue::profile_jobs_dir(&group_dir, &profile).unwrap();
        loop {
            if let Ok(entries) = std::fs::read_dir(&job_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let path = entry.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("job") {
                        continue;
                    }
                    let request: JobRequest =
                        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    let response = JobResponse {
                        run_id: request.job_id,
                        exit_code,
                        error: error.clone(),
                    };
                    let result_path = local_queue::result_path(&group_dir, request.job_id);
                    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
                    std::fs::write(&result_path, serde_json::to_vec(&response).unwrap()).unwrap();
                    return request;
                }
            }

            tokio::task::yield_now().await;
        }
    }

    async fn wait_for_job_and_write_success(
        group_dir: std::path::PathBuf,
        profile: String,
    ) -> JobRequest {
        wait_for_job_and_write_result(group_dir, profile, 0, None).await
    }

    #[tokio::test]
    async fn submit_defaults_profile_and_writes_default_partition() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let watcher = tokio::spawn(wait_for_job_and_write_success(
            group_dir,
            crate::profile::DEFAULT_PROFILE.to_owned(),
        ));

        let code = run_submit_with_home(
            SubmitArgs {
                group: group.into(),
                prompt: "hello".into(),
                cli_agent_type: "claude-code".into(),
                profile: None,
                session_id: None,
                feature_flags: vec![],
                timeout: 5,
            },
            home,
        )
        .await
        .unwrap();
        let request = watcher.await.unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(request.prompt, "hello");
        assert_eq!(request.cli_agent_type, "claude-code");
        assert_eq!(
            request.profile.as_deref(),
            Some(crate::profile::DEFAULT_PROFILE)
        );
    }

    #[tokio::test]
    async fn submit_writes_non_default_profile_partition() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let profile = "vm0/large";
        let group_dir = home.groups_dir().join(group);
        let watcher = tokio::spawn(wait_for_job_and_write_success(
            group_dir,
            profile.to_owned(),
        ));

        let code = run_submit_with_home(
            SubmitArgs {
                group: group.into(),
                prompt: "hello".into(),
                cli_agent_type: "claude-code".into(),
                profile: Some(profile.into()),
                session_id: None,
                feature_flags: vec![],
                timeout: 5,
            },
            home,
        )
        .await
        .unwrap();
        let request = watcher.await.unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(request.profile.as_deref(), Some(profile));
    }

    #[tokio::test]
    async fn submit_serializes_feature_flags() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let watcher = tokio::spawn(wait_for_job_and_write_success(
            group_dir,
            crate::profile::DEFAULT_PROFILE.to_owned(),
        ));

        let code = run_submit_with_home(
            SubmitArgs {
                group: group.into(),
                prompt: "hello".into(),
                cli_agent_type: "codex".into(),
                profile: None,
                session_id: Some("sess-123".into()),
                feature_flags: vec!["alpha=true".into(), "beta=false".into()],
                timeout: 5,
            },
            home,
        )
        .await
        .unwrap();
        let request = watcher.await.unwrap();
        let flags = request.feature_flags.as_ref().unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(request.prompt, "hello");
        assert_eq!(request.cli_agent_type, "codex");
        assert_eq!(request.session_id.as_deref(), Some("sess-123"));
        assert_eq!(flags.get("alpha"), Some(&true));
        assert_eq!(flags.get("beta"), Some(&false));
    }

    #[test]
    fn write_job_file_removes_tmp_when_publish_fails() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&queue.job).unwrap();
        let plan = SubmitPlan {
            group: "test/group".into(),
            profile: crate::profile::DEFAULT_PROFILE.to_owned(),
            queue,
            timeout: Duration::ZERO,
            request_json: b"{}".to_vec(),
        };

        let err = plan.write_job_file().unwrap_err();

        assert!(err.to_string().contains("rename job file"), "got: {err}");
        assert!(plan.queue.job.is_dir());
        let tmp_files: Vec<_> = std::fs::read_dir(&plan.queue.job_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
    }

    #[tokio::test]
    async fn submit_returns_failure_for_nonzero_job_response() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let watcher = tokio::spawn(wait_for_job_and_write_result(
            group_dir.clone(),
            crate::profile::DEFAULT_PROFILE.to_owned(),
            42,
            Some("agent failed".into()),
        ));

        let code = run_submit_with_home(
            SubmitArgs {
                group: group.into(),
                prompt: "hello".into(),
                cli_agent_type: "claude-code".into(),
                profile: None,
                session_id: None,
                feature_flags: vec![],
                timeout: 5,
            },
            home,
        )
        .await
        .unwrap();
        let request = watcher.await.unwrap();
        let result_path = local_queue::result_path(&group_dir, request.job_id);

        assert_eq!(code, ExitCode::FAILURE);
        assert!(
            !result_path.exists(),
            "completed cleanup should remove nonzero result files"
        );
    }

    #[test]
    fn cleanup_completed_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        // Create some files
        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        // First cleanup
        queue.cleanup_completed();
        assert!(!queue.job.exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(
            !queue.claim.exists(),
            "completed-result cleanup should remove stale claims left after result write"
        );

        // Second cleanup (idempotent — no panic on missing files)
        queue.cleanup_completed();
    }

    #[test]
    fn completed_cleanup_keeps_result_when_job_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(&queue.job).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.cleanup_completed();

        assert!(
            queue.result.exists(),
            "result must remain as the terminal marker if the job path was not removed"
        );
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn completed_cleanup_removes_result_when_job_already_absent() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.cleanup_completed();

        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_preserves_active_claim_state() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.abandon("timed out");
        let response: JobResponse =
            serde_json::from_slice(&std::fs::read(&queue.result).unwrap()).unwrap();

        assert_eq!(response.run_id, queue.job_id);
        assert!(!queue.job.exists());
        assert!(
            queue.result.exists(),
            "abandoned cleanup must keep a terminal marker while a runner owns the claim"
        );
        assert!(
            queue.cancel.exists(),
            "abandoned cleanup must not delete files while a runner owns the claim"
        );
        assert!(queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_removes_unclaimed_job_without_claim_marker() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");

        assert!(!queue.job.exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(
            !queue.claim.exists(),
            "abandoned cleanup should not create a temporary claim"
        );
    }

    #[test]
    fn abandoned_cleanup_removes_marker_when_job_already_absent() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.cancel, b"").unwrap();
        let marker =
            write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();

        queue.cleanup_abandoned(Some(&marker));

        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_keeps_marker_when_job_already_absent_but_claimed() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.abandon("timed out");

        assert!(queue.result.exists());
        assert!(queue.cancel.exists());
        assert!(queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_removes_stale_empty_result_after_unclaimed_job() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.result, b"").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");

        assert!(!queue.job.exists());
        assert!(
            !queue.result.exists(),
            "empty stale result should not strand an unclaimed abandoned job"
        );
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_keeps_runner_result_published_over_empty_result() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.result, b"").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        let marker = write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned");
        assert!(marker.is_none());

        let runner_queue = local_queue::LocalQueue::new(group_dir.to_path_buf());
        assert!(runner_queue.write_result_sync(job_id, 0, None));

        queue.cleanup_abandoned(None);

        assert!(!queue.job.exists());
        let response: JobResponse =
            serde_json::from_slice(&std::fs::read(&queue.result).unwrap()).unwrap();
        assert_eq!(response.run_id, job_id);
        assert_eq!(response.exit_code, 0);
        assert!(response.error.is_none());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_removes_unclaimed_job_when_marker_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        let result_dir = local_queue::results_dir(group_dir);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&result_dir, b"not a directory").unwrap();

        queue.abandon("timed out");

        assert!(
            !queue.job.exists(),
            "timed-out unclaimed job should not remain executable after marker write failure"
        );
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
        assert!(result_dir.is_file());
    }

    #[test]
    fn abandoned_cleanup_keeps_completed_result() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");

        assert!(!queue.job.exists());
        assert!(
            queue.result.exists(),
            "abandoned cleanup must not delete a non-empty result written by a runner"
        );
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_keeps_completed_result_when_claimed() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.abandon("timed out");

        assert!(!queue.job.exists());
        assert!(queue.result.exists());
        assert!(queue.cancel.exists());
        assert!(queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_keeps_marker_when_job_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(&queue.job).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");

        assert!(
            queue.result.exists(),
            "terminal marker must remain if the stale job path could not be removed"
        );
        assert!(queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[tokio::test]
    async fn rejects_invalid_profile_name() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some("bad-name".into()),
            session_id: None,
            feature_flags: vec![],
            timeout: 1,
        };
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let err = run_submit_with_home(args, home).await.unwrap_err();
        assert!(
            err.to_string().contains("invalid profile name"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn accepts_valid_profile_name() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some("vm0/default".into()),
            session_id: None,
            feature_flags: vec![],
            timeout: 0,
        };
        // Should pass validation and fail later (HomePaths or timeout), not on profile.
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let result = run_submit_with_home(args, home).await;
        if let Err(e) = &result {
            assert!(!e.to_string().contains("invalid profile name"), "got: {e}");
        }
    }

    #[tokio::test]
    async fn rejects_feature_flag_missing_equals() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            session_id: None,
            feature_flags: vec!["myFlag".into()],
            timeout: 1,
        };
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let err = run_submit_with_home(args, home).await.unwrap_err();
        assert!(err.to_string().contains("expected key=value"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_feature_flag_non_boolean() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            session_id: None,
            feature_flags: vec!["myFlag=yes".into()],
            timeout: 1,
        };
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let err = run_submit_with_home(args, home).await.unwrap_err();
        assert!(
            err.to_string().contains("expected true/false"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn timeout_message_includes_group_and_profile() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some("vm0/large".into()),
            session_id: None,
            feature_flags: vec![],
            timeout: 0,
        };

        let err = run_submit_with_home(args, home).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("group: test/group"), "got: {msg}");
        assert!(msg.contains("profile: vm0/large"), "got: {msg}");
        assert!(msg.contains("no local runner"), "got: {msg}");
        assert!(msg.contains("support this profile"), "got: {msg}");
    }

    #[tokio::test]
    async fn timeout_removes_unclaimed_job_from_queue() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let args = SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            session_id: None,
            feature_flags: vec![],
            timeout: 0,
        };

        let err = run_submit_with_home(args, home).await.unwrap_err();

        let job_dir =
            local_queue::profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();
        let job_files: Vec<_> = std::fs::read_dir(&job_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("job"))
            .collect();
        let result_files: Vec<_> = std::fs::read_dir(local_queue::results_dir(&group_dir))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("result"))
            .collect();

        assert!(err.to_string().contains("timeout waiting for local result"));
        assert!(job_files.is_empty(), "job files left behind: {job_files:?}");
        assert!(
            result_files.is_empty(),
            "result files left behind: {result_files:?}"
        );
    }
}
