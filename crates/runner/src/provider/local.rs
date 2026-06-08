//! [`JobProvider`] backed by a file queue in a shared group directory.
//!
//! `submit` writes a `{job_id}.job` file under the requested profile
//! partition. Runners poll only the profile partitions they support and race
//! to claim discovered jobs via group-wide `{job_id}.claim` files (O_EXCL).
//! The winning runner executes the job and writes a group-wide
//! `{job_id}.result` file that `submit` polls for.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::local_cancel::{LocalCancelScanner, LocalCancelWatcher};
use super::{ClaimedJob, CompletionAuth, JobCandidate, JobProvider};
use crate::ids::RunId;
#[cfg(test)]
use crate::local_queue::{self, JobRequest, JobResponse};
use crate::local_queue::{LocalClaimResult, LocalDiscoveredJob, LocalQueue};
use crate::run_cancellation::SharedRunCancellationMap;
use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};
use sandbox::SandboxId;

/// Poll interval for discovering new job files and local cancel markers.
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// [`JobProvider`] backed by a file queue in a shared group directory.
///
/// - `discover()` polls supported profile partitions under `jobs/`.
/// - `claim()` atomically creates `claims/{job_id}.claim` via `O_EXCL`.
/// - `complete()` writes `results/{job_id}.result`.
///
/// A provider-owned watcher scans `cancels/{run_id}.cancel` independently from
/// discovery so active-job cancellation remains live while discovery is gated
/// by capacity or drain mode. `discover()` also performs the same scan as a
/// fast path, but correctness does not depend on discovery being polled.
pub struct LocalProvider {
    queue: LocalQueue,
    supported_profiles: Vec<String>,
    profile_cursor: AtomicUsize,
    cancel: CancellationToken,
    cancel_scanner: LocalCancelScanner,
    cancel_watcher: LocalCancelWatcher,
}

impl LocalProvider {
    /// Create a new file-queue provider for the given group directory.
    pub fn new(
        group_dir: PathBuf,
        supported_profiles: Vec<String>,
        cancel: CancellationToken,
        cancel_tokens: SharedRunCancellationMap,
    ) -> Arc<Self> {
        Self::new_inner(group_dir, supported_profiles, cancel, cancel_tokens, true)
    }

    fn new_inner(
        group_dir: PathBuf,
        mut supported_profiles: Vec<String>,
        cancel: CancellationToken,
        cancel_tokens: SharedRunCancellationMap,
        start_cancel_watcher: bool,
    ) -> Arc<Self> {
        supported_profiles.sort();
        supported_profiles.dedup();
        info!(
            path = %group_dir.display(),
            profiles = ?supported_profiles,
            "local provider watching"
        );
        let queue = LocalQueue::new(group_dir.clone());
        let owned_claims = Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        let cancel_scanner = LocalCancelScanner::new(queue.clone(), cancel_tokens, owned_claims);
        let cancel_watcher = if start_cancel_watcher {
            LocalCancelWatcher::start(cancel_scanner.clone())
        } else {
            LocalCancelWatcher::disabled()
        };
        Arc::new(Self {
            queue,
            supported_profiles,
            profile_cursor: AtomicUsize::new(0),
            cancel,
            cancel_scanner,
            cancel_watcher,
        })
    }

    #[cfg(test)]
    fn new_without_cancel_watcher(
        group_dir: PathBuf,
        supported_profiles: Vec<String>,
        cancel: CancellationToken,
        cancel_tokens: SharedRunCancellationMap,
    ) -> Arc<Self> {
        Self::new_inner(group_dir, supported_profiles, cancel, cancel_tokens, false)
    }
}

impl LocalProvider {
    /// Find the first unclaimed job in the supported profile partitions.
    #[cfg(test)]
    fn find_unclaimed_job(&self) -> Option<JobCandidate> {
        let start = self.profile_cursor.fetch_add(1, Ordering::Relaxed);
        self.queue
            .discover_candidate_sync(&self.supported_profiles, start)
            .map(job_candidate_from_discovered)
    }

    #[cfg(test)]
    fn write_result(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool {
        self.queue.write_result_sync(run_id, exit_code, error)
    }

    async fn find_unclaimed_job_blocking(&self) -> Option<JobCandidate> {
        let start = self.profile_cursor.fetch_add(1, Ordering::Relaxed);
        let queue = self.queue.clone();
        let supported_profiles = self.supported_profiles.clone();
        match tokio::task::spawn_blocking(move || {
            queue.discover_candidate_sync(&supported_profiles, start)
        })
        .await
        {
            Ok(discovered) => discovered.map(job_candidate_from_discovered),
            Err(e) => {
                warn!(error = %e, "local: blocking job discovery failed");
                None
            }
        }
    }
}

fn job_candidate_from_discovered(discovered: LocalDiscoveredJob) -> JobCandidate {
    JobCandidate::local(
        discovered.run_id,
        discovered.profile_name,
        discovered.job_path,
    )
}

#[async_trait::async_trait]
impl JobProvider for LocalProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        loop {
            if self.cancel.is_cancelled() {
                return None;
            }
            // Check for cancel requests before looking for new jobs.
            self.cancel_scanner.scan_cancel_files().await;
            if let Some(candidate) = self.find_unclaimed_job_blocking().await {
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

    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        let run_id = candidate.run_id();
        let partition_profile = candidate.profile_name().to_owned();
        let Some(job_file) = candidate.local_job_path().map(std::path::Path::to_path_buf) else {
            warn!(run_id = %run_id, "local: claim candidate missing job path");
            return None;
        };

        let queue = self.queue.clone();
        let job_file_for_claim = job_file.clone();
        let claim_result = tokio::task::spawn_blocking(move || {
            queue.claim_job_sync(run_id, &partition_profile, &job_file_for_claim)
        })
        .await;
        let (req, request_profile) = match claim_result {
            Ok(LocalClaimResult::Claimed {
                request,
                request_profile,
            }) => (*request, request_profile),
            Ok(LocalClaimResult::NotClaimed) => return None,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: blocking claim failed");
                return None;
            }
        };

        let context = ExecutionContext {
            run_id,
            prompt: req.prompt,
            append_system_prompt: None,
            _agent_compose_version_id: None,
            vars: req.vars,
            checkpoint_id: None,
            sandbox_token: String::new(),
            storage_manifest: None,
            environment: req.environment,
            resume_session: req
                .session_id
                .as_ref()
                .map(|id| crate::types::ResumeSession {
                    session_id: id.clone(),
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
        };
        match ClaimedJob::local(run_id, context) {
            Ok(claimed) => {
                self.cancel_scanner.mark_owned_claim(run_id).await;
                info!(run_id = %run_id, "local: job claimed");
                Some(claimed)
            }
            Err(err) => {
                let error = format!(
                    "claimed job run_id mismatch: expected={}, context={}",
                    err.expected_run_id, err.context_run_id
                );
                warn!(run_id = %run_id, error = %error, "local: claimed job invariant violation");
                let queue = self.queue.clone();
                if let Err(e) = tokio::task::spawn_blocking(move || {
                    queue.fail_claimed_job_sync(run_id, &job_file, error);
                })
                .await
                {
                    warn!(run_id = %run_id, error = %e, "local: blocking claimed-job failure cleanup failed");
                }
                None
            }
        }
    }

    async fn complete(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        _sandbox_id: Option<SandboxId>,
        _reuse_result: Option<SandboxReuseResult>,
        _completion_auth: CompletionAuth,
    ) {
        self.cancel_scanner.remove_owned_claim(run_id).await;
        let queue = self.queue.clone();
        let error = error.map(str::to_owned);
        if let Err(e) =
            tokio::task::spawn_blocking(move || queue.complete_job_sync(run_id, exit_code, error))
                .await
        {
            warn!(run_id = %run_id, error = %e, "local: blocking completion failed");
        }
    }

    async fn heartbeat(&self, _state: &HeartbeatState) {}

    async fn shutdown(&self) {
        self.cancel_watcher.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_cancellation::RunCancellationHandle;
    use std::collections::HashMap;

    /// Create a default empty cancel_tokens map for tests.
    fn empty_cancel_tokens() -> SharedRunCancellationMap {
        Arc::new(tokio::sync::Mutex::new(HashMap::new()))
    }

    async fn insert_cancel_handle(
        tokens: &SharedRunCancellationMap,
        run_id: RunId,
    ) -> CancellationToken {
        let handle = RunCancellationHandle::new();
        let token = handle.token();
        tokens.lock().await.insert(run_id, handle);
        token
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
        tokens: SharedRunCancellationMap,
    ) -> Arc<LocalProvider> {
        LocalProvider::new_without_cancel_watcher(
            dir.to_path_buf(),
            default_profiles(),
            cancel,
            tokens,
        )
    }

    fn provider_with_profiles(
        dir: &std::path::Path,
        supported_profiles: &[&str],
        cancel: CancellationToken,
        tokens: SharedRunCancellationMap,
    ) -> Arc<LocalProvider> {
        LocalProvider::new_without_cancel_watcher(
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

        let claimed = provider.claim(candidate).await.unwrap();
        let ctx = claimed.context();
        assert_eq!(ctx.run_id, job_id);
        assert_eq!(ctx.prompt, "hello world");

        provider
            .complete(job_id, 0, None, None, None, CompletionAuth::local())
            .await;

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

    #[test]
    fn ignores_tmp_and_invalid_job_files() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

        let profile_dir =
            local_queue::profile_jobs_dir(dir.path(), crate::profile::DEFAULT_PROFILE).unwrap();
        std::fs::create_dir_all(&profile_dir).unwrap();
        std::fs::write(
            profile_dir.join(format!("{}.job.tmp", RunId::new_v4())),
            b"{}",
        )
        .unwrap();
        std::fs::write(profile_dir.join("not-a-run-id.job"), b"{}").unwrap();

        assert!(
            provider.find_unclaimed_job().is_none(),
            "tmp and invalid job files must not be discovered"
        );
    }

    #[tokio::test]
    async fn empty_result_does_not_hide_retryable_job() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "retry me");
        let result_path = local_queue::result_path(dir.path(), job_id);
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        std::fs::write(&result_path, b"").unwrap();

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), job_id);
        let claimed = provider.claim(candidate).await.unwrap();
        let ctx = claimed.context();
        assert_eq!(ctx.prompt, "retry me");

        provider
            .complete(job_id, 0, None, None, None, CompletionAuth::local())
            .await;
        let resp = read_result(dir.path(), job_id);
        assert_eq!(resp.exit_code, 0);
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
        let claimed1 = provider.claim(candidate1).await.unwrap();
        let ctx1 = claimed1.context();
        assert_eq!(ctx1.prompt, "job1");

        write_job(dir.path(), job2, "job2");

        let candidate2 = provider.discover().await.unwrap();
        let run_id2 = candidate2.run_id();
        let claimed2 = provider.claim(candidate2).await.unwrap();
        let ctx2 = claimed2.context();
        assert_eq!(ctx2.prompt, "job2");
        assert_ne!(run_id1, run_id2);

        provider
            .complete(run_id1, 0, None, None, None, CompletionAuth::local())
            .await;
        provider
            .complete(
                run_id2,
                1,
                Some("test error"),
                None,
                None,
                CompletionAuth::local(),
            )
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

        let claimed = provider.claim(candidate).await.unwrap();
        let ctx = claimed.context();
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
        let claimed = provider.claim(candidate).await.unwrap();
        let ctx = claimed.context();
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
        let job_token = insert_cancel_handle(&tokens, run_id).await;

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
    async fn owned_cancel_file_is_deleted_after_provider_claim() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = insert_cancel_handle(&tokens, run_id).await;
        let provider = default_provider(dir.path(), CancellationToken::new(), tokens);
        write_job(dir.path(), run_id, "owned");
        let candidate = provider.discover().await.unwrap();
        provider.claim(candidate).await.unwrap();

        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        let other_job = RunId::new_v4();
        write_job(dir.path(), other_job, "next");

        let candidate = provider.discover().await.unwrap();

        assert_eq!(candidate.run_id(), other_job);
        assert!(job_token.is_cancelled(), "cancel token should be triggered");
        assert!(
            !cancel_path.exists(),
            "owned cancel file should be deleted after triggering the token"
        );
    }

    #[tokio::test]
    async fn stale_cancel_file_is_deleted_before_provider_discovers_next_job() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
        let stale_id = RunId::new_v4();
        let cancel_path = local_queue::cancel_path(dir.path(), stale_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "still works");

        let candidate = provider.discover().await.unwrap();

        assert_eq!(candidate.run_id(), job_id);
        assert!(
            !cancel_path.exists(),
            "stale cancel file should be deleted when no token, claim, or job remains"
        );
    }

    #[tokio::test]
    async fn cancel_file_before_token_survives_until_provider_claim_token_exists() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let provider = default_provider(dir.path(), CancellationToken::new(), Arc::clone(&tokens));
        let run_id = RunId::new_v4();
        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        write_job(dir.path(), run_id, "will be cancelled");

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), run_id);
        assert!(
            cancel_path.exists(),
            "cancel file should survive before the token is inserted"
        );

        let job_token = insert_cancel_handle(&tokens, run_id).await;
        provider.claim(candidate).await.unwrap();
        let other_job = RunId::new_v4();
        write_job(dir.path(), other_job, "next job");

        let candidate = provider.discover().await.unwrap();

        assert_eq!(candidate.run_id(), other_job);
        assert!(
            job_token.is_cancelled(),
            "token should be cancelled on the next provider scan"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after this provider owns the claim"
        );
    }

    #[tokio::test]
    async fn provider_cancel_watcher_triggers_owned_token_without_discover() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let provider = LocalProvider::new(
            dir.path().to_path_buf(),
            default_profiles(),
            CancellationToken::new(),
            Arc::clone(&tokens),
        );
        let run_id = RunId::new_v4();
        let job_token = insert_cancel_handle(&tokens, run_id).await;
        write_job(dir.path(), run_id, "owned");
        let candidate = provider.discover().await.unwrap();
        provider.claim(candidate).await.unwrap();

        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();

        tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
            .await
            .expect("provider cancel watcher should trigger token");
        provider.shutdown().await;
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

        provider
            .complete(run_id, 0, None, None, None, CompletionAuth::local())
            .await;

        assert!(
            !cancel_path.exists(),
            "complete() should clean up cancel file"
        );
        assert!(
            !claim_path.exists(),
            "complete() should clean up claim file"
        );
    }

    #[tokio::test]
    async fn complete_result_failure_removes_job_before_claim() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let job_path =
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        let claim_path = local_queue::claim_path(dir.path(), run_id);
        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        let result_dir = local_queue::results_dir(dir.path());
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();

        std::fs::write(&job_path, b"{}").unwrap();
        std::fs::write(&claim_path, b"").unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        std::fs::write(&result_dir, b"not a directory").unwrap();

        provider
            .complete(run_id, 0, None, None, None, CompletionAuth::local())
            .await;

        assert!(
            !job_path.exists(),
            "job must be removed before releasing claim when result write fails"
        );
        assert!(
            !claim_path.exists(),
            "claim can be released after the job is no longer retryable"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should not be stranded after terminal cleanup"
        );
    }

    #[tokio::test]
    async fn complete_result_failure_keeps_state_when_job_scan_fails() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let claim_path = local_queue::claim_path(dir.path(), run_id);
        let cancel_path = local_queue::cancel_path(dir.path(), run_id);
        let result_dir = local_queue::results_dir(dir.path());
        std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();

        std::fs::write(&claim_path, b"").unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        std::fs::write(&result_dir, b"not a directory").unwrap();
        std::fs::write(local_queue::jobs_dir(dir.path()), b"not a directory").unwrap();

        provider
            .complete(run_id, 0, None, None, None, CompletionAuth::local())
            .await;

        assert!(
            claim_path.exists(),
            "claim should stay when job-file cleanup cannot verify retry state"
        );
        assert!(
            cancel_path.exists(),
            "cancel file should stay when job-file cleanup cannot verify retry state"
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

    #[tokio::test]
    async fn claim_marks_unreadable_job_path_failed() {
        let dir = tempfile::tempdir().unwrap();
        let provider =
            default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let claim_path = local_queue::claim_path(dir.path(), run_id);
        let job_path =
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        let result_path = local_queue::result_path(dir.path(), run_id);
        std::fs::create_dir_all(&job_path).unwrap();
        let candidate = JobCandidate::local(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_owned(),
            job_path.clone(),
        );

        assert!(provider.claim(candidate).await.is_none());

        assert!(!claim_path.exists(), "claim file must be removed");
        assert!(
            result_path.exists(),
            "unreadable job path should produce a terminal result"
        );
        let result = read_result(dir.path(), run_id);
        assert_ne!(result.exit_code, 0);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|e| e.contains("failed to read job file"))
        );
        assert!(
            provider.find_unclaimed_job().is_none(),
            "terminal result should stop rediscovery of the unreadable path"
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
    async fn claim_rejects_job_id_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

        let filename_id = RunId::new_v4();
        let request_id = RunId::new_v4();
        write_job_in_partition(
            dir.path(),
            crate::profile::DEFAULT_PROFILE,
            request_id,
            "mismatch",
            Some(crate::profile::DEFAULT_PROFILE),
        );
        let request_path =
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, request_id).unwrap();
        let job_path =
            local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, filename_id)
                .unwrap();
        std::fs::rename(&request_path, &job_path).unwrap();

        let candidate = provider.discover().await.unwrap();
        assert_eq!(candidate.run_id(), filename_id);
        assert!(provider.claim(candidate).await.is_none());

        assert!(
            !local_queue::claim_path(dir.path(), filename_id).exists(),
            "claim file must be removed after rejecting mismatched job"
        );
        assert!(
            !job_path.exists(),
            "mismatched job file must be removed after terminal result"
        );
        let result = read_result(dir.path(), filename_id);
        assert_ne!(result.exit_code, 0);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|e| e.contains("job id mismatch"))
        );
        assert!(
            !local_queue::result_path(dir.path(), request_id).exists(),
            "the embedded request id must not receive the result"
        );
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
