//! [`JobProvider`] backed by a file queue in a shared group directory.
//!
//! `submit` writes a `{job_id}.job` file under the requested profile
//! partition. Runners poll only the profile partitions they support and race
//! to claim discovered jobs via group-wide `{job_id}.claim` files (O_EXCL).
//! The winning runner executes the job and writes a group-wide
//! `{job_id}.result` file that `submit` polls for.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{JobCandidate, JobProvider, local_queue};
use crate::ids::RunId;
use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};
use sandbox::SandboxId;

/// Poll interval for discovering new job files.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Job request written by `submit` as a `{job_id}.job` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobRequest {
    pub(crate) job_id: RunId,
    pub(crate) prompt: String,
    pub(crate) working_dir: String,
    pub(crate) cli_agent_type: String,
    #[serde(default)]
    pub(crate) vars: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) user_timezone: Option<String>,
    #[serde(default)]
    pub(crate) profile: Option<String>,
    /// Session ID for sandbox reuse across conversation turns.
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) feature_flags: Option<HashMap<String, bool>>,
}

/// Job response written by the runner as a `{job_id}.result` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobResponse {
    pub(crate) run_id: RunId,
    pub(crate) exit_code: i32,
    pub(crate) error: Option<String>,
}

/// [`JobProvider`] backed by a file queue in a shared group directory.
///
/// - `discover()` polls supported profile partitions under `jobs/`.
/// - `claim()` atomically creates `claims/{job_id}.claim` via `O_EXCL`.
/// - `complete()` writes `results/{job_id}.result`.
///
/// `discover()` also scans for `cancels/{run_id}.cancel` files and triggers the
/// corresponding cancellation token from the shared `cancel_tokens` map.
pub struct LocalProvider {
    group_dir: PathBuf,
    supported_profiles: Vec<String>,
    profile_cursor: AtomicUsize,
    cancel: CancellationToken,
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
}

impl LocalProvider {
    /// Create a new file-queue provider for the given group directory.
    pub fn new(
        group_dir: PathBuf,
        mut supported_profiles: Vec<String>,
        cancel: CancellationToken,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) -> Arc<Self> {
        supported_profiles.sort();
        supported_profiles.dedup();
        info!(
            path = %group_dir.display(),
            profiles = ?supported_profiles,
            "local provider watching"
        );
        Arc::new(Self {
            group_dir,
            supported_profiles,
            profile_cursor: AtomicUsize::new(0),
            cancel,
            cancel_tokens,
        })
    }

    /// Scan for `.cancel` files and trigger the corresponding cancel tokens.
    ///
    /// Only deletes a `.cancel` file after successfully triggering its token.
    /// Files whose `run_id` has no token yet (job not yet claimed) are left in
    /// place so the next scan can retry — this avoids a race where the cancel
    /// file arrives between `discover()` returning the job and the main loop
    /// inserting the token.
    ///
    /// Uses `try_lock()` to avoid both async cancellation hazards and
    /// blocking the tokio runtime.  If the lock is contended (rare — only
    /// held briefly by the main loop when inserting/removing tokens), the
    /// scan is silently skipped and retried on the next 100 ms poll.
    fn scan_cancel_files(&self) {
        let cancel_dir = local_queue::cancels_dir(&self.group_dir);
        let entries = match std::fs::read_dir(&cancel_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                warn!(path = %cancel_dir.display(), error = %e, "local: cannot read cancel dir");
                return;
            }
        };
        // Collect cancel run_ids first, then lock once to process them all.
        let mut cancel_ids = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("cancel") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(run_id) = stem.parse::<RunId>() else {
                continue;
            };
            cancel_ids.push(run_id);
        }
        if cancel_ids.is_empty() {
            return;
        }
        let Ok(tokens) = self.cancel_tokens.try_lock() else {
            // Lock contended — skip this scan, retry next poll iteration.
            return;
        };
        for run_id in &cancel_ids {
            if let Some(token) = tokens.get(run_id) {
                info!(run_id = %run_id, "local: cancel file detected, cancelling job");
                token.cancel();
                // Only delete after successful trigger — crash-safe.
                let _ = std::fs::remove_file(local_queue::cancel_path(&self.group_dir, *run_id));
            }
            // No token yet → leave file for next scan (job may not be claimed yet).
        }
    }

    /// Find the first unclaimed job in the supported profile partitions.
    fn find_unclaimed_job(&self) -> Option<JobCandidate> {
        if self.supported_profiles.is_empty() {
            return None;
        }

        let start = self.profile_cursor.fetch_add(1, Ordering::Relaxed);
        let profile_count = self.supported_profiles.len();
        for offset in 0..profile_count {
            let Some(profile) = self
                .supported_profiles
                .get(start.wrapping_add(offset) % profile_count)
            else {
                continue;
            };
            let profile_dir = match local_queue::profile_jobs_dir(&self.group_dir, profile) {
                Ok(dir) => dir,
                Err(e) => {
                    warn!(profile, error = %e, "local: invalid supported profile");
                    continue;
                }
            };
            let entries = match std::fs::read_dir(&profile_dir) {
                Ok(e) => e,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warn!(path = %profile_dir.display(), error = %e, "local: cannot read profile job dir");
                    continue;
                }
            };

            let mut job_paths: Vec<_> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("job"))
                .collect();
            job_paths.sort();

            for path in job_paths {
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Ok(job_id) = stem.parse::<RunId>() else {
                    continue;
                };
                let claim_path = local_queue::claim_path(&self.group_dir, job_id);
                if claim_path.exists() {
                    continue;
                }
                let result_path = local_queue::result_path(&self.group_dir, job_id);
                if result_path.exists() {
                    continue;
                }
                return Some(JobCandidate::local(job_id, profile.clone(), path));
            }
        }
        None
    }

    fn write_result(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool {
        let response = JobResponse {
            run_id,
            exit_code,
            error: error.map(String::from),
        };
        let json = match serde_json::to_vec(&response) {
            Ok(j) => j,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to serialize result");
                return false;
            }
        };

        let result_dir = local_queue::results_dir(&self.group_dir);
        if let Err(e) = std::fs::create_dir_all(&result_dir) {
            warn!(path = %result_dir.display(), error = %e, "local: failed to create result dir");
            return false;
        }

        // Atomic write: tmp then rename, so submit never reads a partial file.
        let tmp_file = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
        let result_file = local_queue::result_path(&self.group_dir, run_id);
        if let Err(e) = std::fs::write(&tmp_file, &json) {
            warn!(run_id = %run_id, error = %e, "local: failed to write result file");
            return false;
        }
        if let Err(e) = std::fs::rename(&tmp_file, &result_file) {
            warn!(run_id = %run_id, error = %e, "local: failed to rename result file");
            let _ = std::fs::remove_file(&tmp_file);
            return false;
        }
        true
    }

    async fn fail_claimed_job(
        &self,
        run_id: RunId,
        claim_file: &std::path::Path,
        job_file: &std::path::Path,
        error: String,
    ) {
        if self.write_result(run_id, 1, Some(&error)) {
            let _ = std::fs::remove_file(job_file);
        }
        let _ = std::fs::remove_file(claim_file);
    }
}

#[async_trait::async_trait]
impl JobProvider for LocalProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        loop {
            if self.cancel.is_cancelled() {
                return None;
            }
            // Check for cancel requests before looking for new jobs.
            self.scan_cancel_files();
            if let Some(candidate) = self.find_unclaimed_job() {
                info!(
                    run_id = %candidate.run_id(),
                    profile = %candidate.profile_name(),
                    "local: job discovered"
                );
                return Some(candidate);
            }
            tokio::select! {
                () = self.cancel.cancelled() => return None,
                () = tokio::time::sleep(POLL_INTERVAL) => {}
            }
        }
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ExecutionContext> {
        let run_id = candidate.run_id();
        let partition_profile = candidate.profile_name().to_owned();
        let Some(job_file) = candidate.local_job_path().map(std::path::Path::to_path_buf) else {
            warn!(run_id = %run_id, "local: claim candidate missing job path");
            return None;
        };

        // Atomic claim via O_EXCL — only the first runner to create the file wins.
        let claim_dir = local_queue::claims_dir(&self.group_dir);
        if let Err(e) = std::fs::create_dir_all(&claim_dir) {
            warn!(path = %claim_dir.display(), error = %e, "local: failed to create claim dir");
            return None;
        }
        let claim_file = local_queue::claim_path(&self.group_dir, run_id);
        if std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&claim_file)
            .is_err()
        {
            return None;
        }
        if local_queue::result_path(&self.group_dir, run_id).exists() {
            info!(run_id = %run_id, "local: job already has result, skipping claim");
            let _ = std::fs::remove_file(&claim_file);
            return None;
        }

        // Read the job request.
        let buf = match std::fs::read(&job_file) {
            Ok(b) => b,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to read job file");
                let _ = std::fs::remove_file(&claim_file);
                return None;
            }
        };
        let req: JobRequest = match serde_json::from_slice(&buf) {
            Ok(r) => r,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: invalid job JSON, marking job as failed");
                // Submit writes .job atomically (tmp + rename), so a malformed
                // .job is a permanent error — retrying the parse will just
                // spin. Keep the claim until after the result attempt so other
                // local runners do not repeatedly process the same poison job.
                // If the result write fails, the claim is released and the job
                // remains retryable. If it succeeds, the result becomes the
                // durable terminal marker before the bad job is removed.
                self.fail_claimed_job(
                    run_id,
                    &claim_file,
                    &job_file,
                    format!("invalid job JSON: {e}"),
                )
                .await;
                return None;
            }
        };

        let request_profile = match req.profile.clone() {
            Some(profile) => profile,
            None if partition_profile == crate::profile::DEFAULT_PROFILE => {
                crate::profile::DEFAULT_PROFILE.to_owned()
            }
            None => {
                let error =
                    format!("missing job profile in non-default partition: {partition_profile}");
                warn!(run_id = %run_id, error = %error, "local: invalid job profile");
                self.fail_claimed_job(run_id, &claim_file, &job_file, error)
                    .await;
                return None;
            }
        };
        if request_profile != partition_profile {
            let error = format!(
                "job profile mismatch: request={request_profile}, partition={partition_profile}"
            );
            warn!(run_id = %run_id, error = %error, "local: invalid job profile");
            self.fail_claimed_job(run_id, &claim_file, &job_file, error)
                .await;
            return None;
        }

        info!(run_id = %run_id, "local: job claimed");
        Some(ExecutionContext {
            run_id,
            prompt: req.prompt,
            append_system_prompt: None,
            _agent_compose_version_id: None,
            vars: req.vars,
            checkpoint_id: None,
            sandbox_token: String::new(),
            working_dir: req.working_dir,
            storage_manifest: None,
            environment: req.environment,
            resume_session: req.session_id.map(|id| crate::types::ResumeSession {
                session_id: id,
                session_history: String::new(),
            }),
            secret_values: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            cli_agent_type: req.cli_agent_type,
            debug_no_mock_claude: None,
            debug_no_mock_codex: None,
            api_start_time: None,
            user_timezone: req.user_timezone,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            disallowed_tools: None,
            tools: None,
            settings: None,
            experimental_profile: Some(request_profile),
            feature_flags: req.feature_flags,
            billable_firewalls: vec![],
            model_usage_provider: None,
        })
    }

    async fn complete(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        _sandbox_id: Option<SandboxId>,
        _reuse_result: Option<SandboxReuseResult>,
    ) {
        if !self.write_result(run_id, exit_code, error) {
            return;
        }
        // Best-effort cleanup of cancel file (may have been written after the
        // last discover() scan but before the job actually finished).
        let _ = std::fs::remove_file(local_queue::cancel_path(&self.group_dir, run_id));
        let _ = std::fs::remove_file(local_queue::claim_path(&self.group_dir, run_id));
    }

    async fn heartbeat(&self, _state: &HeartbeatState) {}

    async fn shutdown(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a default empty cancel_tokens map for tests.
    fn empty_cancel_tokens() -> Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> {
        Arc::new(tokio::sync::Mutex::new(HashMap::new()))
    }

    fn profiles(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn default_profiles() -> Vec<String> {
        profiles(&[crate::profile::DEFAULT_PROFILE])
    }

    fn default_provider(
        dir: &std::path::Path,
        cancel: CancellationToken,
        tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) -> Arc<LocalProvider> {
        LocalProvider::new(dir.to_path_buf(), default_profiles(), cancel, tokens)
    }

    fn provider_with_profiles(
        dir: &std::path::Path,
        supported_profiles: &[&str],
        cancel: CancellationToken,
        tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) -> Arc<LocalProvider> {
        LocalProvider::new(
            dir.to_path_buf(),
            profiles(supported_profiles),
            cancel,
            tokens,
        )
    }

    /// Write a job file into the default profile partition.
    fn write_job(dir: &std::path::Path, job_id: RunId, prompt: &str) {
        write_job_in_partition(
            dir,
            crate::profile::DEFAULT_PROFILE,
            job_id,
            prompt,
            Some(crate::profile::DEFAULT_PROFILE),
        );
    }

    /// Write a job file with an optional profile.
    fn write_job_with_profile(
        dir: &std::path::Path,
        job_id: RunId,
        prompt: &str,
        profile: Option<&str>,
    ) {
        let partition = profile.unwrap_or(crate::profile::DEFAULT_PROFILE);
        write_job_in_partition(dir, partition, job_id, prompt, profile);
    }

    fn write_job_in_partition(
        dir: &std::path::Path,
        partition_profile: &str,
        job_id: RunId,
        prompt: &str,
        json_profile: Option<&str>,
    ) {
        let req = JobRequest {
            job_id,
            prompt: prompt.into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            vars: None,
            environment: None,
            user_timezone: None,
            profile: json_profile.map(String::from),
            session_id: None,
            feature_flags: None,
        };
        let json = serde_json::to_vec(&req).unwrap();
        let job_dir = local_queue::profile_jobs_dir(dir, partition_profile).unwrap();
        std::fs::create_dir_all(&job_dir).unwrap();
        std::fs::write(
            local_queue::job_path(dir, partition_profile, job_id).unwrap(),
            &json,
        )
        .unwrap();
    }

    /// Read a result file from the group directory.
    fn read_result(dir: &std::path::Path, job_id: RunId) -> JobResponse {
        let path = local_queue::result_path(dir, job_id);
        let buf = std::fs::read(path).unwrap();
        serde_json::from_slice(&buf).unwrap()
    }

    #[tokio::test]
    async fn discover_claim_complete() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "hello world");

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job_id);
        assert_eq!(candidate.profile_name(), crate::profile::DEFAULT_PROFILE);

        let ctx = provider.claim(candidate).await.unwrap();
        assert_eq!(ctx.run_id, job_id);
        assert_eq!(ctx.prompt, "hello world");

        provider.complete(job_id, 0, None, None, None).await;

        let resp = read_result(dir.path(), job_id);
        assert_eq!(resp.exit_code, 0);
        assert!(resp.error.is_none());
    }

    #[tokio::test]
    async fn shutdown_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel.clone(), empty_cancel_tokens());

        cancel.cancel();
        assert!(provider.discover().await.is_none());
    }

    #[tokio::test]
    async fn skips_already_claimed_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        // Write two jobs, pre-claim the first
        let job1 = RunId::new_v4();
        let job2 = RunId::new_v4();
        write_job(dir.path(), job1, "claimed");
        write_job(dir.path(), job2, "available");
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), job1), b"").unwrap();

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job2);
    }

    #[test]
    fn skips_jobs_with_existing_result() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "already done");
        assert!(provider.write_result(job_id, 0, None));

        assert!(
            provider.find_unclaimed_job().is_none(),
            "a durable result should prevent a completed job from being rediscovered"
        );
    }

    #[tokio::test]
    async fn claim_releases_claim_when_result_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "already done");
        let candidate = JobCandidate::local(
            job_id,
            crate::profile::DEFAULT_PROFILE.to_owned(),
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, job_id).unwrap(),
        );
        assert!(provider.write_result(job_id, 0, None));

        assert!(provider.claim(candidate).await.is_none());
        assert!(
            !local_queue::claim_path(dir.path(), job_id).exists(),
            "claim attempt on an already-completed job must not strand a claim"
        );
    }

    #[tokio::test]
    async fn concurrent_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let job1 = RunId::new_v4();
        let job2 = RunId::new_v4();
        write_job(dir.path(), job1, "job1");

        let candidate1 = provider.discover().await.unwrap();
        let run_id1 = candidate1.run_id();
        let ctx1 = provider.claim(candidate1).await.unwrap();
        assert_eq!(ctx1.prompt, "job1");

        write_job(dir.path(), job2, "job2");

        let candidate2 = provider.discover().await.unwrap();
        let run_id2 = candidate2.run_id();
        let ctx2 = provider.claim(candidate2).await.unwrap();
        assert_eq!(ctx2.prompt, "job2");
        assert_ne!(run_id1, run_id2);

        provider.complete(run_id1, 0, None, None, None).await;
        provider
            .complete(run_id2, 1, Some("test error"), None, None)
            .await;

        let resp1 = read_result(dir.path(), job1);
        assert_eq!(resp1.exit_code, 0);
        assert!(resp1.error.is_none());

        let resp2 = read_result(dir.path(), job2);
        assert_eq!(resp2.exit_code, 1);
        assert_eq!(resp2.error.as_deref(), Some("test error"));
    }

    #[tokio::test]
    async fn group_claim_only_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();

        let tokens = empty_cancel_tokens();
        let provider_a = default_provider(dir.path(), cancel.clone(), Arc::clone(&tokens));
        let provider_b = default_provider(dir.path(), cancel, tokens);

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "shared");

        let candidate_a = provider_a.discover().await.unwrap();
        let candidate_b = provider_b.discover().await.unwrap();
        assert_eq!(candidate_a.run_id(), job_id);
        assert_eq!(candidate_b.run_id(), job_id);

        let claim_a = provider_a.claim(candidate_a).await;
        let claim_b = provider_b.claim(candidate_b).await;

        assert!(
            claim_a.is_some() ^ claim_b.is_some(),
            "exactly one runner should win the claim"
        );
    }

    #[tokio::test]
    async fn discover_returns_profile_from_job() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job_with_profile(dir.path(), job_id, "profiled job", Some("vm0/default"));

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job_id);
        assert_eq!(candidate.profile_name(), "vm0/default");

        let ctx = provider.claim(candidate).await.unwrap();
        assert_eq!(ctx.experimental_profile.as_deref(), Some("vm0/default"));
    }

    #[tokio::test]
    async fn discover_defaults_profile_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job_in_partition(
            dir.path(),
            crate::profile::DEFAULT_PROFILE,
            job_id,
            "default job",
            None,
        );

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job_id);
        assert_eq!(candidate.profile_name(), crate::profile::DEFAULT_PROFILE);
        let ctx = provider.claim(candidate).await.unwrap();
        assert_eq!(
            ctx.experimental_profile.as_deref(),
            Some(crate::profile::DEFAULT_PROFILE)
        );
    }

    #[tokio::test]
    async fn unsupported_profile_partition_is_not_discovered_or_claimed() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

        let unsupported = RunId::new_v4();
        let supported = RunId::new_v4();
        write_job_with_profile(dir.path(), unsupported, "large", Some("vm0/large"));
        write_job(dir.path(), supported, "default");

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), supported);
        assert!(!local_queue::claim_path(dir.path(), unsupported).exists());
        assert!(!local_queue::result_path(dir.path(), unsupported).exists());
    }

    #[tokio::test]
    async fn provider_for_non_default_profile_discovers_that_partition() {
        let dir = tempfile::tempdir().unwrap();
        let provider = provider_with_profiles(
            dir.path(),
            &["vm0/large"],
            CancellationToken::new(),
            empty_cancel_tokens(),
        );

        let job_id = RunId::new_v4();
        write_job_with_profile(dir.path(), job_id, "large", Some("vm0/large"));

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job_id);
        assert_eq!(candidate.profile_name(), "vm0/large");
    }

    #[tokio::test]
    async fn cancel_file_triggers_token() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let tokens = empty_cancel_tokens();

        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());

        let provider = default_provider(dir.path(), cancel, tokens);

        // Write a .cancel file and a dummy .job so discover returns.
        std::fs::create_dir_all(local_queue::cancels_dir(dir.path())).unwrap();
        std::fs::write(local_queue::cancel_path(dir.path(), run_id), b"").unwrap();
        let other_job = RunId::new_v4();
        write_job(dir.path(), other_job, "keep going");

        // discover() should scan cancel files then find the unclaimed job.
        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), other_job);
        assert!(job_token.is_cancelled(), "cancel token should be triggered");
    }

    #[tokio::test]
    async fn cancel_file_deleted_after_trigger() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let tokens = empty_cancel_tokens();

        // Insert a token so the cancel file can be matched and deleted.
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token);

        let provider = default_provider(dir.path(), cancel, tokens);

        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();

        // Write a dummy job so discover() returns instead of looping.
        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "dummy");

        let _ = provider.discover().await;
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after triggering token"
        );
    }

    #[tokio::test]
    async fn cancel_file_unknown_run_id_no_panic() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let tokens = empty_cancel_tokens();
        let provider = default_provider(dir.path(), cancel, tokens);

        // Write cancel file for a run_id that has no token.
        let unknown_id = RunId::new_v4();
        let cancel_path = local_queue::cancel_path(dir.path(), unknown_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "still works");

        // Should not panic. Cancel file is kept (no matching token yet).
        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job_id);
        assert!(
            cancel_path.exists(),
            "cancel file should be kept when no token matches"
        );
    }

    #[tokio::test]
    async fn complete_cleans_up_cancel_file() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        let claim_path = local_queue::claim_path(dir.path(), run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        std::fs::write(&claim_path, b"").unwrap();

        provider.complete(run_id, 0, None, None, None).await;

        assert!(
            !cancel_path.exists(),
            "complete() should clean up cancel file"
        );
        assert!(
            !claim_path.exists(),
            "complete() should clean up claim file"
        );
    }

    /// Cancel file written before token is inserted (race between submit
    /// cancel and runner claim). The file should survive until the token
    /// appears, then be processed on a subsequent scan.
    #[tokio::test]
    async fn cancel_file_before_token_survives_until_token_inserted() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let tokens = empty_cancel_tokens();
        let provider = default_provider(dir.path(), cancel, Arc::clone(&tokens));

        let run_id = RunId::new_v4();
        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();

        // Write a job so discover returns.
        write_job(dir.path(), run_id, "will be cancelled");

        // First discover: no token yet → cancel file kept, job returned.
        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), run_id);
        assert!(
            cancel_path.exists(),
            "cancel file should survive (no token yet)"
        );

        // Simulate main loop inserting token after discover returns.
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());

        // Claim the job so it's no longer discoverable, then write another
        // job to let discover() return.
        provider.claim(candidate).await.unwrap();
        let other_job = RunId::new_v4();
        write_job(dir.path(), other_job, "next job");

        // Second discover: token exists now → cancel triggered and file deleted.
        let candidate2 = provider.discover().await.unwrap();
        assert_eq!(candidate2.run_id(), other_job);
        assert!(
            job_token.is_cancelled(),
            "token should be cancelled on second scan"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after trigger"
        );
    }

    /// Regression: if the job file is missing when claim() reads it, the
    /// .claim file must be removed so the job doesn't get stranded forever.
    #[tokio::test]
    async fn claim_cleans_up_on_missing_job_file() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let claim_path = local_queue::claim_path(dir.path(), run_id);
        let job_path =
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        let candidate =
            JobCandidate::local(run_id, crate::profile::DEFAULT_PROFILE.to_owned(), job_path);

        // No .job file — claim() should fail at the read step.
        assert!(provider.claim(candidate).await.is_none());
        assert!(
            !claim_path.exists(),
            "claim file must be removed when job read fails"
        );
    }

    /// Malformed .job is a permanent error (submit writes atomically, so it
    /// can't be "half-written"). claim() must delete the .job + .claim and
    /// write a .result so the submitter unblocks and discover stops returning
    /// the poisoned job on every poll.
    #[tokio::test]
    async fn claim_handles_poison_job_json() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let claim_path = local_queue::claim_path(dir.path(), run_id);
        let job_path =
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        let result_path = local_queue::result_path(dir.path(), run_id);
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        std::fs::write(&job_path, b"not json").unwrap();
        let candidate = JobCandidate::local(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_owned(),
            job_path.clone(),
        );

        assert!(provider.claim(candidate).await.is_none());

        assert!(!claim_path.exists(), "claim file must be removed");
        assert!(!job_path.exists(), "poison job file must be removed");
        assert!(
            result_path.exists(),
            ".result must be written for submitter"
        );

        let buf = std::fs::read(&result_path).unwrap();
        let resp: JobResponse = serde_json::from_slice(&buf).unwrap();
        assert_eq!(resp.run_id, run_id);
        assert_ne!(resp.exit_code, 0, "poison must report non-zero exit");
        assert!(
            resp.error
                .as_deref()
                .is_some_and(|e| e.contains("invalid job JSON")),
            "error must mention invalid JSON, got: {:?}",
            resp.error
        );

        // Next discover() scan must not re-surface the job.
        assert!(provider.find_unclaimed_job().is_none());
    }

    #[tokio::test]
    async fn claim_rejects_missing_profile_in_non_default_partition() {
        let dir = tempfile::tempdir().unwrap();
        let provider = provider_with_profiles(
            dir.path(),
            &["vm0/large"],
            CancellationToken::new(),
            empty_cancel_tokens(),
        );

        let run_id = RunId::new_v4();
        write_job_in_partition(dir.path(), "vm0/large", run_id, "missing", None);

        let candidate = provider.discover().await.unwrap();
        assert!(provider.claim(candidate).await.is_none());
        let result = read_result(dir.path(), run_id);
        assert_ne!(result.exit_code, 0);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|e| e.contains("missing job profile"))
        );
    }

    #[tokio::test]
    async fn claim_rejects_profile_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let provider = provider_with_profiles(
            dir.path(),
            &["vm0/large"],
            CancellationToken::new(),
            empty_cancel_tokens(),
        );

        let run_id = RunId::new_v4();
        write_job_in_partition(
            dir.path(),
            "vm0/large",
            run_id,
            "mismatch",
            Some(crate::profile::DEFAULT_PROFILE),
        );

        let candidate = provider.discover().await.unwrap();
        assert!(provider.claim(candidate).await.is_none());
        let result = read_result(dir.path(), run_id);
        assert_ne!(result.exit_code, 0);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|e| e.contains("job profile mismatch"))
        );
    }

    #[test]
    fn multi_profile_scan_rotates_start_profile() {
        let dir = tempfile::tempdir().unwrap();
        let provider = provider_with_profiles(
            dir.path(),
            &[crate::profile::DEFAULT_PROFILE, "vm0/large"],
            CancellationToken::new(),
            empty_cancel_tokens(),
        );

        let default_id = RunId::new_v4();
        let large_id = RunId::new_v4();
        write_job(dir.path(), default_id, "default");
        write_job_with_profile(dir.path(), large_id, "large", Some("vm0/large"));

        let first = provider.find_unclaimed_job().unwrap();
        let second = provider.find_unclaimed_job().unwrap();
        assert_eq!(first.run_id(), default_id);
        assert_eq!(second.run_id(), large_id);
    }
}
