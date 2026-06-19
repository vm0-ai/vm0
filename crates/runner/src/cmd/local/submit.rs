//! `runner local submit` — submit a job to locally running runners via file queue.
//!
//! Writes a `{job_id}.job` file into a profile-specific partition and polls
//! for a group-wide `{job_id}.result` file written by the runner that claimed
//! the job.

use std::collections::{HashMap, HashSet};
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

/// Default wait budget for a submitted local job to complete.
const DEFAULT_LOCAL_SUBMIT_TIMEOUT_SECS: u64 = 300;

/// Local submit is an interactive wait, not a long-term scheduling primitive.
const MAX_LOCAL_SUBMIT_TIMEOUT_SECS: u64 = 24 * 60 * 60;

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
    /// Ordinary environment variables to pass to the local job (KEY=VALUE)
    #[arg(long = "env")]
    env: Vec<String>,
    /// Local-only secret environment variables to pass and register for masking (KEY=VALUE)
    #[arg(long = "secret-env")]
    secret_env: Vec<String>,
    /// Timeout in seconds waiting for a runner to complete the job (max: 24 hours)
    #[arg(long, default_value_t = DEFAULT_LOCAL_SUBMIT_TIMEOUT_SECS)]
    timeout: u64,
    /// Delayed active input for local smoke tests (repeatable, format: after=1s,text=hello)
    #[arg(long = "active-input")]
    active_inputs: Vec<String>,
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
    match local_queue::read_private_file(result_path, "local result file") {
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

#[derive(Clone)]
struct SubmitQueueEntry {
    job_id: RunId,
    group_dir: PathBuf,
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
            group_dir: group_dir.to_path_buf(),
            job_dir: local_queue::profile_jobs_dir(group_dir, profile)?,
            job: local_queue::job_path(group_dir, profile, job_id)?,
            result: local_queue::result_path(group_dir, job_id),
            cancel: local_queue::cancel_path(group_dir, job_id),
            claim: local_queue::claim_path(group_dir, job_id),
        })
    }

    /// Clean up queue files after a completed job has produced a result.
    fn cleanup_completed(&self) {
        let jobs_removed = local_queue::LocalQueue::new(self.group_dir.clone())
            .remove_job_files_if_present(self.job_id);
        self.cleanup_active_inputs();
        let _ = remove_file_if_exists(&self.cancel);
        let _ = remove_file_if_exists(&self.claim);
        if jobs_removed {
            let _ = remove_file_if_exists(&self.result);
        }
    }

    /// Clean up submit-owned queue files after timing out while waiting for a result.
    fn cleanup_abandoned(&self, marker: Option<&PublishedMarker>) {
        let jobs_removed = local_queue::LocalQueue::new(self.group_dir.clone())
            .remove_job_files_if_present(self.job_id);
        let has_claim =
            local_queue::marker_file_exists(&self.claim, "local claim marker").unwrap_or(true);
        if jobs_removed && !has_claim {
            self.cleanup_active_inputs();
            let _ = remove_file_if_exists(&self.claim);
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

    fn cleanup_active_inputs(&self) {
        local_queue::LocalQueue::new(self.group_dir.clone())
            .cleanup_active_inputs_sync(self.job_id);
    }

    fn can_write_active_input(&self) -> bool {
        if local_queue::private_file_has_content(&self.result, "local result file").unwrap_or(false)
        {
            return false;
        }
        if local_queue::marker_path_occupied(&self.claim, "local claim marker").unwrap_or(false) {
            return true;
        }
        local_queue::marker_file_exists(&self.job, "local job file").unwrap_or(false)
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
    let group_dir = result_dir.parent()?;
    if local_queue::ensure_results_dir(group_dir).is_err() {
        return None;
    }

    let tmp_path = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
    let mut file = match local_queue::open_private_new_file(
        &tmp_path,
        "local abandoned result marker temporary file",
    ) {
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
    let is_file =
        local_queue::marker_file_exists(result_path, "local result file").unwrap_or(false);
    is_file
        && !local_queue::private_file_has_content(result_path, "local result file").unwrap_or(true)
}

fn remove_marker_if_unchanged(result_path: &std::path::Path, marker: Option<&PublishedMarker>) {
    let Some(marker) = marker else {
        return;
    };
    let Ok(metadata) = std::fs::symlink_metadata(result_path) else {
        return;
    };
    if !metadata.file_type().is_file() {
        return;
    }
    if metadata.dev() != marker.dev || metadata.ino() != marker.ino {
        return;
    }
    if local_queue::read_private_file(result_path, "local result file")
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
    active_inputs: Vec<DelayedActiveInput>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DelayedActiveInput {
    sequence: u64,
    message_id: String,
    after: Duration,
    text: String,
}

struct ActiveInputProducer {
    stop: tokio_util::sync::CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl ActiveInputProducer {
    fn start(queue: SubmitQueueEntry, inputs: Vec<DelayedActiveInput>) -> Option<Self> {
        if inputs.is_empty() {
            return None;
        }
        let stop = tokio_util::sync::CancellationToken::new();
        let mut tasks = Vec::with_capacity(inputs.len());
        for input in inputs {
            let queue = queue.clone();
            let stop = stop.clone();
            tasks.push(tokio::spawn(async move {
                tokio::select! {
                    () = stop.cancelled() => {}
                    () = tokio::time::sleep(input.after) => {
                        if !queue.can_write_active_input() {
                            return;
                        }
                        let entry = local_queue::ActiveInputEntry {
                            run_id: queue.job_id,
                            sequence: input.sequence,
                            message_id: input.message_id,
                            text: input.text,
                        };
                        let queue_state = local_queue::LocalQueue::new(queue.group_dir.clone());
                        if let Err(error) = tokio::task::spawn_blocking(move || {
                            queue_state.write_active_input_sync(&entry)
                        })
                        .await
                        .unwrap_or_else(|error| Err(std::io::Error::other(error.to_string())))
                            && error.kind() != std::io::ErrorKind::NotFound
                        {
                            eprintln!("warn: failed to write local active input: {error}");
                        }
                    }
                }
            }));
        }
        Some(Self { stop, tasks })
    }

    async fn stop(self) {
        self.stop.cancel();
        for task in self.tasks {
            if let Err(error) = task.await {
                eprintln!("warn: local active input producer task failed: {error}");
            }
        }
    }
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
            env,
            secret_env,
            timeout,
            active_inputs,
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
        let environment = Self::parse_env_entries("--env", &env, true)?;
        let secret_environment = Self::parse_env_entries("--secret-env", &secret_env, false)?;
        Self::validate_disjoint_env_keys(&environment, &secret_environment)?;
        let timeout = Self::validate_timeout(timeout)?;
        let group_dir = home.groups_dir().join(&group);
        local_queue::ensure_profile_jobs_dir(&group_dir, &profile).map_err(|e| {
            RunnerError::Config(format!("create job dir for profile {profile}: {e}"))
        })?;

        local_queue::ensure_results_dir(&group_dir)
            .map_err(|e| RunnerError::Config(format!("create results dir: {e}")))?;
        local_queue::ensure_cancels_dir(&group_dir)
            .map_err(|e| RunnerError::Config(format!("create cancels dir: {e}")))?;

        let job_id = RunId::new_v4();
        let active_inputs = Self::parse_active_inputs(&active_inputs, timeout, job_id)?;
        let request = JobRequest {
            job_id,
            prompt,
            cli_agent_type,
            vars: None,
            environment,
            secret_environment,
            user_timezone: detect_system_timezone(),
            profile: Some(profile.clone()),
            session_id,
            feature_flags,
            active_input: (!active_inputs.is_empty()).then_some(true),
        };

        let request_json = serde_json::to_vec(&request)
            .map_err(|e| RunnerError::Internal(format!("serialize request: {e}")))?;
        let queue = SubmitQueueEntry::for_job(&group_dir, &profile, job_id)?;

        Ok(Self {
            group,
            profile,
            queue,
            timeout,
            request_json,
            active_inputs,
        })
    }

    fn parse_active_inputs(
        values: &[String],
        timeout: Duration,
        job_id: RunId,
    ) -> RunnerResult<Vec<DelayedActiveInput>> {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                Self::parse_active_input(value, index as u64 + 1, timeout, job_id)
            })
            .collect()
    }

    fn parse_active_input(
        value: &str,
        sequence: u64,
        timeout: Duration,
        job_id: RunId,
    ) -> RunnerResult<DelayedActiveInput> {
        let rest = value.strip_prefix("after=").ok_or_else(|| {
            RunnerError::Config(
                "invalid --active-input value: expected after=<duration>,text=<text>".to_string(),
            )
        })?;
        let (after, text) = rest.split_once(",text=").ok_or_else(|| {
            RunnerError::Config(
                "invalid --active-input value: expected after=<duration>,text=<text>".to_string(),
            )
        })?;
        let after = Self::parse_active_input_delay(after)?;
        if after >= timeout {
            return Err(RunnerError::Config(format!(
                "invalid --active-input value: delay must be less than submit timeout ({timeout:?})"
            )));
        }
        if text.is_empty() {
            return Err(RunnerError::Config(
                "invalid --active-input value: text must not be empty".to_string(),
            ));
        }
        if text.contains('\0') {
            return Err(RunnerError::Config(
                "invalid --active-input value: text must not contain NUL characters".to_string(),
            ));
        }
        Ok(DelayedActiveInput {
            sequence,
            message_id: format!("local-active-input-{job_id}-{sequence}"),
            after,
            text: text.to_owned(),
        })
    }

    fn parse_active_input_delay(value: &str) -> RunnerResult<Duration> {
        let (digits, unit) = if let Some(digits) = value.strip_suffix("ms") {
            (digits, "ms")
        } else if let Some(digits) = value.strip_suffix('s') {
            (digits, "s")
        } else {
            return Err(RunnerError::Config(format!(
                "invalid --active-input duration '{value}': expected positive integer ms or s"
            )));
        };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(RunnerError::Config(format!(
                "invalid --active-input duration '{value}': expected positive integer"
            )));
        }
        let amount = digits.parse::<u64>().map_err(|_| {
            RunnerError::Config(format!(
                "invalid --active-input duration '{value}': out of range"
            ))
        })?;
        if amount == 0 {
            return Err(RunnerError::Config(format!(
                "invalid --active-input duration '{value}': must be greater than zero"
            )));
        }
        Ok(if unit == "ms" {
            Duration::from_millis(amount)
        } else {
            Duration::from_secs(amount)
        })
    }

    fn validate_timeout(timeout: u64) -> RunnerResult<Duration> {
        if timeout > MAX_LOCAL_SUBMIT_TIMEOUT_SECS {
            return Err(RunnerError::Config(format!(
                "invalid --timeout: must be <= {MAX_LOCAL_SUBMIT_TIMEOUT_SECS} seconds (got {timeout})"
            )));
        }
        Ok(Duration::from_secs(timeout))
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

    fn parse_env_entries(
        flag: &str,
        entries: &[String],
        allow_guest_agent_tuning_keys: bool,
    ) -> RunnerResult<Option<HashMap<String, String>>> {
        if entries.is_empty() {
            return Ok(None);
        }

        let mut map = HashMap::new();
        for entry in entries {
            if entry.contains('\0') {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} value: NUL characters are not allowed"
                )));
            }
            let Some(eq_pos) = entry.find('=') else {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} value: expected KEY=VALUE format"
                )));
            };
            if eq_pos == 0 {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} value: expected KEY=VALUE format"
                )));
            }

            let key = &entry[..eq_pos];
            let value = &entry[eq_pos + 1..];
            if !guest_contracts::env::is_shell_identifier_env_key(key) {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} key: expected [_A-Za-z][_A-Za-z0-9]*"
                )));
            }
            let is_guest_agent_tuning_key =
                guest_contracts::env::is_guest_agent_tuning_env_key(key);
            if is_guest_agent_tuning_key && !allow_guest_agent_tuning_keys {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} key '{key}': guest-agent tuning environment variables must be passed with --env"
                )));
            }
            if guest_contracts::env::is_runner_owned_env_key(key) && !is_guest_agent_tuning_key {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} key '{key}': runner-owned environment variables are not allowed"
                )));
            }
            if map.insert(key.to_owned(), value.to_owned()).is_some() {
                return Err(RunnerError::Config(format!("duplicate {flag} key '{key}'")));
            }
        }

        Ok(Some(map))
    }

    fn validate_disjoint_env_keys(
        environment: &Option<HashMap<String, String>>,
        secret_environment: &Option<HashMap<String, String>>,
    ) -> RunnerResult<()> {
        let (Some(environment), Some(secret_environment)) = (environment, secret_environment)
        else {
            return Ok(());
        };

        let secret_keys: HashSet<&str> = secret_environment.keys().map(String::as_str).collect();
        for key in environment.keys() {
            if secret_keys.contains(key.as_str()) {
                return Err(RunnerError::Config(format!(
                    "duplicate env key '{key}' across --env and --secret-env"
                )));
            }
        }
        Ok(())
    }

    fn write_job_file(&self) -> RunnerResult<()> {
        let tmp_path = self
            .queue
            .job_dir
            .join(format!("{}.job.tmp", self.queue.job_id));
        if let Err(e) = local_queue::write_private_file(
            &tmp_path,
            &self.request_json,
            "local job temporary file",
        ) {
            let _ = remove_file_if_exists(&tmp_path);
            return Err(RunnerError::Internal(format!("write job file: {e}")));
        }
        if let Err(e) = std::fs::rename(&tmp_path, &self.queue.job) {
            let _ = remove_file_if_exists(&tmp_path);
            return Err(RunnerError::Internal(format!("rename job file: {e}")));
        }
        Ok(())
    }

    fn start_active_input_producer(&self) -> Option<ActiveInputProducer> {
        ActiveInputProducer::start(self.queue.clone(), self.active_inputs.clone())
    }

    async fn wait_for_result(&self) -> RunnerResult<SubmitOutcome> {
        let started_at = tokio::time::Instant::now();

        loop {
            if let Some(buf) = try_read_result(&self.queue.result) {
                return Ok(SubmitOutcome::Completed(buf));
            }
            let elapsed = started_at.elapsed();
            if elapsed >= self.timeout {
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
            let remaining = self.timeout.saturating_sub(elapsed);
            tokio::select! {
                () = tokio::time::sleep(std::cmp::min(POLL_INTERVAL, remaining)) => {}
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("interrupted — requesting cancel for {}", self.queue.job_id);
                    let _ = local_queue::write_private_marker(&self.queue.cancel, "local cancel marker");
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
    let producer = plan.start_active_input_producer();
    let outcome = plan.wait_for_result().await;
    if let Some(producer) = producer {
        producer.stop().await;
    }
    if matches!(outcome, Err(_) | Ok(SubmitOutcome::Cancelled)) {
        plan.queue.cleanup_abandoned(None);
    }
    match outcome? {
        SubmitOutcome::Completed(buf) => plan.finish_completed(&buf),
        SubmitOutcome::Cancelled => Ok(ExitCode::FAILURE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::Mutex;

    /// Serialize tests that mutate environment variables to prevent UB.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());
    const TEST_QUEUE_WATCH_TIMEOUT: Duration = Duration::from_secs(5);
    const TEST_QUEUE_WATCH_INTERVAL: Duration = Duration::from_millis(1);

    fn submit_queue_entry(group_dir: &Path, job_id: RunId) -> SubmitQueueEntry {
        SubmitQueueEntry::for_job(group_dir, crate::profile::DEFAULT_PROFILE, job_id).unwrap()
    }

    fn write_queue_job_file(group_dir: &Path, profile: &str, job_id: RunId) -> PathBuf {
        let path = local_queue::job_path(group_dir, profile, job_id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{}").unwrap();
        path
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
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
    fn try_read_result_ignores_result_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let result_path = local_queue::result_path(group_dir, RunId::new_v4());
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-result");
        std::fs::write(&target, b"{\"exit_code\":0}").unwrap();
        symlink(&target, &result_path).unwrap();

        assert!(try_read_result(&result_path).is_none());
    }

    #[test]
    fn result_file_is_empty_ignores_result_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let result_path = local_queue::result_path(group_dir, RunId::new_v4());
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-result");
        std::fs::write(&target, b"").unwrap();
        symlink(&target, &result_path).unwrap();

        assert!(!result_file_is_empty(&result_path));
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
        assert_eq!(mode(&result_path), 0o600);
        let result_dir = local_queue::results_dir(group_dir);
        assert_eq!(mode(&result_dir), 0o700);
        let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
    }

    #[test]
    fn abandoned_marker_write_creates_missing_group_dir_as_shared_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("groups").join("org").join("group");
        let job_id = RunId::new_v4();
        let result_path = local_queue::result_path(&group_dir, job_id);

        let marker =
            write_abandoned_result_marker(&result_path, job_id, "local submit abandoned").unwrap();

        assert_eq!(std::fs::read(&result_path).unwrap(), marker.bytes);
        assert_eq!(mode(&group_dir), crate::host_file::SHARED_TRUSTED_DIR_MODE);
        assert_eq!(mode(&local_queue::results_dir(&group_dir)), 0o700);
        assert_eq!(mode(&result_path), 0o600);
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

    async fn wait_for_active_inputs_and_write_success(
        group_dir: std::path::PathBuf,
        profile: String,
        expected_inputs: usize,
    ) -> (JobRequest, Vec<local_queue::ActiveInputEntry>) {
        let job_dir = local_queue::profile_jobs_dir(&group_dir, &profile).unwrap();
        let queue = local_queue::LocalQueue::new(group_dir.clone());
        let deadline = tokio::time::Instant::now() + TEST_QUEUE_WATCH_TIMEOUT;
        let mut last_seen_inputs = 0;
        loop {
            if let Ok(entries) = std::fs::read_dir(&job_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let path = entry.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("job") {
                        continue;
                    }
                    let request: JobRequest =
                        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    let inputs = queue.read_active_input_entries_sync(request.job_id);
                    last_seen_inputs = last_seen_inputs.max(inputs.len());
                    if inputs.len() < expected_inputs {
                        continue;
                    }
                    let response = JobResponse {
                        run_id: request.job_id,
                        exit_code: 0,
                        error: None,
                    };
                    let result_path = local_queue::result_path(&group_dir, request.job_id);
                    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
                    std::fs::write(&result_path, serde_json::to_vec(&response).unwrap()).unwrap();
                    return (request, inputs);
                }
            }

            if tokio::time::Instant::now() >= deadline {
                panic!(
                    "timed out waiting for {expected_inputs} local active inputs in {} (last seen: {last_seen_inputs})",
                    job_dir.display()
                );
            }
            tokio::time::sleep(TEST_QUEUE_WATCH_INTERVAL).await;
        }
    }

    fn submit_args_for_test() -> SubmitArgs {
        SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 1,
            active_inputs: vec![],
        }
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
                env: vec![],
                secret_env: vec![],
                timeout: 5,
                active_inputs: vec![],
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
                env: vec![],
                secret_env: vec![],
                timeout: 5,
                active_inputs: vec![],
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
                env: vec![],
                secret_env: vec![],
                timeout: 5,
                active_inputs: vec![],
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
    fn parses_active_input_specs() {
        let job_id = RunId::nil();
        let parsed = SubmitPlan::parse_active_inputs(
            &[
                "after=1s,text=first".to_string(),
                "after=250ms,text=second,with,commas".to_string(),
            ],
            Duration::from_secs(5),
            job_id,
        )
        .unwrap();

        assert_eq!(
            parsed,
            vec![
                DelayedActiveInput {
                    sequence: 1,
                    message_id: format!("local-active-input-{job_id}-1"),
                    after: Duration::from_secs(1),
                    text: "first".to_string(),
                },
                DelayedActiveInput {
                    sequence: 2,
                    message_id: format!("local-active-input-{job_id}-2"),
                    after: Duration::from_millis(250),
                    text: "second,with,commas".to_string(),
                },
            ]
        );
    }

    #[test]
    fn rejects_invalid_active_input_specs() {
        let job_id = RunId::nil();
        for value in [
            "text=missing-after",
            "after=1m,text=bad-unit",
            "after=0s,text=zero",
            "after=1s,text=",
            "after=5s,text=timeout",
            "after=1s,text=bad\0nul",
        ] {
            let err = SubmitPlan::parse_active_inputs(
                &[value.to_string()],
                Duration::from_secs(5),
                job_id,
            )
            .unwrap_err();

            assert!(
                err.to_string().contains("active-input"),
                "value={value}, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn active_inputs_are_written_after_job_publication_and_cleaned_on_completion() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let watcher = tokio::spawn(wait_for_active_inputs_and_write_success(
            group_dir.clone(),
            crate::profile::DEFAULT_PROFILE.to_owned(),
            2,
        ));
        let mut args = submit_args_for_test();
        args.group = group.into();
        args.timeout = 5;
        args.active_inputs = vec![
            "after=1ms,text=first".to_string(),
            "after=2ms,text=second,with,comma".to_string(),
        ];

        let code = run_submit_with_home(args, home).await.unwrap();
        let (request, inputs) = watcher.await.unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(request.prompt, "hello");
        assert_eq!(request.active_input, Some(true));
        assert_eq!(
            inputs
                .iter()
                .map(|entry| (entry.sequence, entry.text.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "first"), (2, "second,with,comma")]
        );
        assert!(
            !local_queue::run_inputs_dir(&group_dir, request.job_id).exists(),
            "completed submit cleanup should remove local active-input files"
        );
    }

    #[tokio::test]
    async fn submit_serializes_env_and_secret_env() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let watcher = tokio::spawn(wait_for_job_and_write_success(
            group_dir,
            crate::profile::DEFAULT_PROFILE.to_owned(),
        ));

        let mut args = submit_args_for_test();
        args.group = group.into();
        args.timeout = 5;
        args.env = vec![
            "FOO=bar".into(),
            "URL=https://example.test/path?a=1&b=2".into(),
            "EMPTY=".into(),
            "MULTILINE=line1\nline2".into(),
            "VM0_STUCK_TOOL_TIMEOUT_SECS=3".into(),
        ];
        args.secret_env = vec![
            "ANTHROPIC_API_KEY=sk-ant-local-secret".into(),
            "PRIVATE_KEY=-----BEGIN KEY-----\r\nsecret\r\n-----END KEY-----".into(),
        ];

        let code = run_submit_with_home(args, home).await.unwrap();
        let request = watcher.await.unwrap();
        let environment = request.environment.as_ref().unwrap();
        let secret_environment = request.secret_environment.as_ref().unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(environment.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(
            environment.get("URL").map(String::as_str),
            Some("https://example.test/path?a=1&b=2")
        );
        assert_eq!(environment.get("EMPTY").map(String::as_str), Some(""));
        assert_eq!(
            environment.get("MULTILINE").map(String::as_str),
            Some("line1\nline2")
        );
        assert_eq!(
            environment
                .get("VM0_STUCK_TOOL_TIMEOUT_SECS")
                .map(String::as_str),
            Some("3")
        );
        assert_eq!(
            secret_environment
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("sk-ant-local-secret")
        );
        assert_eq!(
            secret_environment.get("PRIVATE_KEY").map(String::as_str),
            Some("-----BEGIN KEY-----\r\nsecret\r\n-----END KEY-----")
        );
    }

    #[tokio::test]
    async fn rejects_invalid_env_entries_before_submit() {
        let cases = vec![
            (vec!["FOO".to_string()], Vec::new(), "expected KEY=VALUE"),
            (vec!["=VALUE".to_string()], Vec::new(), "expected KEY=VALUE"),
            (
                vec!["BAD-KEY=value".to_string()],
                Vec::new(),
                "expected [_A-Za-z][_A-Za-z0-9]*",
            ),
            (
                vec!["1KEY=value".to_string()],
                Vec::new(),
                "expected [_A-Za-z][_A-Za-z0-9]*",
            ),
            (
                vec!["KEY SPACE=value".to_string()],
                Vec::new(),
                "expected [_A-Za-z][_A-Za-z0-9]*",
            ),
            (
                Vec::new(),
                vec!["ÅKEY=value".to_string()],
                "expected [_A-Za-z][_A-Za-z0-9]*",
            ),
            (
                Vec::new(),
                vec!["KEY=with\0nul".to_string()],
                "NUL characters",
            ),
            (
                vec!["VM0_PROMPT=value".to_string()],
                Vec::new(),
                "runner-owned environment variables",
            ),
            (
                Vec::new(),
                vec!["CLI_AGENT_TYPE=codex".to_string()],
                "runner-owned environment variables",
            ),
            (
                Vec::new(),
                vec!["VM0_STUCK_TOOL_TIMEOUT_SECS=3".to_string()],
                "must be passed with --env",
            ),
            (
                vec!["FOO=1".to_string(), "FOO=2".to_string()],
                Vec::new(),
                "duplicate --env key 'FOO'",
            ),
            (
                vec!["FOO=1".to_string()],
                vec!["FOO=2".to_string()],
                "across --env and --secret-env",
            ),
        ];

        for (env, secret_env, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let home = HomePaths::with_root(dir.path().to_path_buf());
            let mut args = submit_args_for_test();
            args.env = env;
            args.secret_env = secret_env;

            let err = run_submit_with_home(args, home).await.unwrap_err();

            assert!(err.to_string().contains(expected), "got: {err}");
        }
    }

    #[test]
    fn write_job_file_creates_private_job_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        let plan = SubmitPlan {
            group: "test/group".into(),
            profile: crate::profile::DEFAULT_PROFILE.to_owned(),
            queue,
            timeout: Duration::ZERO,
            request_json: br#"{"secretEnvironment":{"ANTHROPIC_API_KEY":"sk-local-secret"}}"#
                .to_vec(),
            active_inputs: vec![],
        };

        plan.write_job_file().unwrap();

        let mode = std::fs::metadata(&plan.queue.job)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, crate::host_file::PRIVATE_FILE_MODE);
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
            active_inputs: vec![],
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

    #[test]
    fn submit_plan_creates_private_queue_dirs_and_job_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let home = HomePaths::with_root(root.clone());
        let group = "test/group";
        let group_dir = root.join("groups").join(group);
        let plan = SubmitPlan::from_args(
            SubmitArgs {
                group: group.into(),
                prompt: "secret prompt".into(),
                cli_agent_type: "claude-code".into(),
                profile: None,
                session_id: Some("session-123".into()),
                feature_flags: vec![],
                env: vec![],
                secret_env: vec![],
                timeout: 5,
                active_inputs: vec![],
            },
            home,
        )
        .unwrap();

        plan.write_job_file().unwrap();

        assert_eq!(mode(&plan.queue.job_dir), 0o700);
        assert_eq!(mode(&local_queue::results_dir(&group_dir)), 0o700);
        assert_eq!(mode(&local_queue::cancels_dir(&group_dir)), 0o700);
        assert_eq!(mode(&plan.queue.job), 0o600);
    }

    #[test]
    fn submit_plan_tightens_existing_permissive_queue_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let home = HomePaths::with_root(root.clone());
        let group = "test/group";
        let group_dir = root.join("groups").join(group);
        let job_dir =
            local_queue::profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();
        let results_dir = local_queue::results_dir(&group_dir);
        let cancels_dir = local_queue::cancels_dir(&group_dir);
        for path in [&job_dir, &results_dir, &cancels_dir] {
            std::fs::create_dir_all(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let plan = SubmitPlan::from_args(
            SubmitArgs {
                group: group.into(),
                prompt: "secret prompt".into(),
                cli_agent_type: "claude-code".into(),
                profile: None,
                session_id: None,
                feature_flags: vec![],
                env: vec![],
                secret_env: vec![],
                timeout: 5,
                active_inputs: vec![],
            },
            home,
        )
        .unwrap();

        assert_eq!(mode(&plan.queue.job_dir), 0o700);
        assert_eq!(mode(&results_dir), 0o700);
        assert_eq!(mode(&cancels_dir), 0o700);
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
                env: vec![],
                secret_env: vec![],
                timeout: 5,
                active_inputs: vec![],
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
    fn completed_cleanup_removes_duplicate_job_files() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
        let large_job = write_queue_job_file(group_dir, "vm0/large", job_id);
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.cleanup_completed();

        assert!(!default_job.exists());
        assert!(!large_job.exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
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
    fn completed_cleanup_keeps_result_when_duplicate_job_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
        let blocked_job = local_queue::job_path(group_dir, "vm0/large", job_id).unwrap();
        std::fs::create_dir_all(&blocked_job).unwrap();
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.result, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        std::fs::write(&queue.claim, b"").unwrap();

        queue.cleanup_completed();

        assert!(!default_job.exists());
        assert!(blocked_job.exists());
        assert!(
            queue.result.exists(),
            "result must remain as the terminal marker if any duplicate job path was not removed"
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
        local_queue::LocalQueue::new(group_dir.to_path_buf())
            .write_active_input_sync(&local_queue::ActiveInputEntry {
                run_id: job_id,
                sequence: 1,
                message_id: "msg-1".to_string(),
                text: "one".to_string(),
            })
            .unwrap();

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
        assert!(
            local_queue::run_inputs_dir(group_dir, job_id).exists(),
            "abandoned cleanup must leave active inputs for claimed jobs"
        );
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
        local_queue::LocalQueue::new(group_dir.to_path_buf())
            .write_active_input_sync(&local_queue::ActiveInputEntry {
                run_id: job_id,
                sequence: 1,
                message_id: "msg-1".to_string(),
                text: "one".to_string(),
            })
            .unwrap();

        queue.abandon("timed out");

        assert!(!queue.job.exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(
            !queue.claim.exists(),
            "abandoned cleanup should not create a temporary claim"
        );
        assert!(
            !local_queue::run_inputs_dir(group_dir, job_id).exists(),
            "abandoned cleanup should remove active inputs for unclaimed jobs"
        );
    }

    #[test]
    fn abandoned_cleanup_ignores_claim_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        let target = dir.path().join("target-claim");
        std::fs::write(&target, b"").unwrap();
        symlink(&target, &queue.claim).unwrap();

        queue.abandon("timed out");

        assert!(!queue.job.exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_removes_duplicate_unclaimed_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
        let large_job = write_queue_job_file(group_dir, "vm0/large", job_id);
        std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");

        assert!(!default_job.exists());
        assert!(!large_job.exists());
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
    fn abandoned_cleanup_removes_unclaimed_active_inputs_when_job_already_absent() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();
        let marker =
            write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();
        local_queue::LocalQueue::new(group_dir.to_path_buf())
            .write_active_input_sync(&local_queue::ActiveInputEntry {
                run_id: job_id,
                sequence: 1,
                message_id: "msg-1".to_string(),
                text: "one".to_string(),
            })
            .unwrap();

        queue.cleanup_abandoned(Some(&marker));

        assert!(!local_queue::run_inputs_dir(group_dir, job_id).exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_removes_late_unclaimed_active_inputs_after_job_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
        std::fs::write(&queue.job, b"{}").unwrap();
        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");
        local_queue::LocalQueue::new(group_dir.to_path_buf())
            .write_active_input_sync(&local_queue::ActiveInputEntry {
                run_id: job_id,
                sequence: 1,
                message_id: "msg-1".to_string(),
                text: "late".to_string(),
            })
            .unwrap();

        queue.cleanup_abandoned(None);

        assert!(!local_queue::run_inputs_dir(group_dir, job_id).exists());
        assert!(!queue.result.exists());
        assert!(!queue.cancel.exists());
        assert!(!queue.claim.exists());
    }

    #[test]
    fn abandoned_cleanup_keeps_marker_when_duplicate_job_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let queue = submit_queue_entry(group_dir, job_id);
        let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
        let blocked_job = local_queue::job_path(group_dir, "vm0/large", job_id).unwrap();
        std::fs::create_dir_all(&blocked_job).unwrap();
        std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

        std::fs::write(&queue.cancel, b"").unwrap();

        queue.abandon("timed out");

        assert!(!default_job.exists());
        assert!(blocked_job.exists());
        assert!(
            queue.result.exists(),
            "terminal marker must remain if any duplicate job path could not be removed"
        );
        assert!(queue.cancel.exists());
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
            env: vec![],
            secret_env: vec![],
            timeout: 1,
            active_inputs: vec![],
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
            env: vec![],
            secret_env: vec![],
            timeout: 0,
            active_inputs: vec![],
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
            env: vec![],
            secret_env: vec![],
            timeout: 1,
            active_inputs: vec![],
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
            env: vec![],
            secret_env: vec![],
            timeout: 1,
            active_inputs: vec![],
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
            env: vec![],
            secret_env: vec![],
            timeout: 0,
            active_inputs: vec![],
        };

        let err = run_submit_with_home(args, home).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("group: test/group"), "got: {msg}");
        assert!(msg.contains("profile: vm0/large"), "got: {msg}");
        assert!(msg.contains("no local runner"), "got: {msg}");
        assert!(msg.contains("support this profile"), "got: {msg}");
    }

    #[tokio::test]
    async fn maximum_timeout_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let mut args = submit_args_for_test();
        args.group = group.into();
        args.timeout = MAX_LOCAL_SUBMIT_TIMEOUT_SECS;
        let watcher = tokio::spawn(wait_for_job_and_write_success(
            group_dir,
            crate::profile::DEFAULT_PROFILE.to_owned(),
        ));

        let code = run_submit_with_home(args, home).await.unwrap();
        let request = watcher.await.unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(request.prompt, "hello");
    }

    #[tokio::test]
    async fn oversized_timeouts_are_rejected_before_publishing_job() {
        for timeout in [MAX_LOCAL_SUBMIT_TIMEOUT_SECS + 1, u64::MAX] {
            let dir = tempfile::tempdir().unwrap();
            let home = HomePaths::with_root(dir.path().to_path_buf());
            let group = "test/group";
            let group_dir = home.groups_dir().join(group);
            let mut args = submit_args_for_test();
            args.group = group.into();
            args.timeout = timeout;

            let err = run_submit_with_home(args, home).await.unwrap_err();

            assert!(matches!(&err, RunnerError::Config(_)), "got: {err:?}");
            let msg = err.to_string();
            assert!(msg.contains("--timeout"), "got: {msg}");
            assert!(msg.contains("must be <="), "got: {msg}");
            assert!(msg.contains(&timeout.to_string()), "got: {msg}");
            assert!(
                !group_dir.exists(),
                "invalid timeout must not create a local queue group directory"
            );
        }
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
            env: vec![],
            secret_env: vec![],
            timeout: 0,
            active_inputs: vec![],
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
