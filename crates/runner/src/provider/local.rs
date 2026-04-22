//! [`JobProvider`] backed by a file queue in a shared group directory.
//!
//! `submit` writes a `{job_id}.job` file. Runners poll the directory for new
//! `.job` files and race to claim them via `{job_id}.claim` (O_EXCL). The
//! winning runner executes the job and writes a `{job_id}.result` file that
//! `submit` polls for.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::JobProvider;
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
/// - `discover()` polls `{group_dir}/*.job` for files without a `.claim`.
/// - `claim()` atomically creates `{job_id}.claim` via `O_EXCL`.
/// - `complete()` writes `{job_id}.result`.
///
/// `discover()` also scans for `{run_id}.cancel` files and triggers the
/// corresponding cancellation token from the shared `cancel_tokens` map.
pub struct LocalProvider {
    group_dir: PathBuf,
    cancel: CancellationToken,
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
}

impl LocalProvider {
    /// Create a new file-queue provider for the given group directory.
    pub fn new(
        group_dir: PathBuf,
        cancel: CancellationToken,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) -> Arc<Self> {
        info!(path = %group_dir.display(), "local provider watching");
        Arc::new(Self {
            group_dir,
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
        let entries = match std::fs::read_dir(&self.group_dir) {
            Ok(e) => e,
            Err(e) => {
                warn!(path = %self.group_dir.display(), error = %e, "local: cannot read group dir for cancel scan");
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
                let _ = std::fs::remove_file(self.group_dir.join(format!("{run_id}.cancel")));
            }
            // No token yet → leave file for next scan (job may not be claimed yet).
        }
    }

    /// Find the first `.job` file that has no corresponding `.claim` file.
    /// Reads the job file to extract the profile (defaults to `DEFAULT_PROFILE`).
    fn find_unclaimed_job(&self) -> Option<(RunId, String)> {
        let entries = match std::fs::read_dir(&self.group_dir) {
            Ok(e) => e,
            Err(e) => {
                warn!(path = %self.group_dir.display(), error = %e, "local: cannot read group dir");
                return None;
            }
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("job") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(job_id) = stem.parse::<RunId>() else {
                continue;
            };
            let claim_path = self.group_dir.join(format!("{job_id}.claim"));
            if !claim_path.exists() {
                // Silent fallback to default profile — claim() is the single
                // source of truth for logging and poison handling, so errors
                // here are intentionally swallowed to avoid duplicate warns.
                let profile = std::fs::read(&path)
                    .ok()
                    .and_then(|buf| serde_json::from_slice::<JobRequest>(&buf).ok())
                    .and_then(|req| req.profile)
                    .unwrap_or_else(|| crate::profile::DEFAULT_PROFILE.to_owned());
                return Some((job_id, profile));
            }
        }
        None
    }
}

#[async_trait::async_trait]
impl JobProvider for LocalProvider {
    async fn discover(&self) -> Option<(RunId, String)> {
        loop {
            if self.cancel.is_cancelled() {
                return None;
            }
            // Check for cancel requests before looking for new jobs.
            self.scan_cancel_files();
            if let Some((job_id, profile)) = self.find_unclaimed_job() {
                info!(run_id = %job_id, %profile, "local: job discovered");
                return Some((job_id, profile));
            }
            tokio::select! {
                () = self.cancel.cancelled() => return None,
                () = tokio::time::sleep(POLL_INTERVAL) => {}
            }
        }
    }

    async fn claim(&self, run_id: RunId) -> Option<ExecutionContext> {
        // Atomic claim via O_EXCL — only the first runner to create the file wins.
        let claim_file = self.group_dir.join(format!("{run_id}.claim"));
        if std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&claim_file)
            .is_err()
        {
            return None;
        }

        // Read the job request.
        let job_file = self.group_dir.join(format!("{run_id}.job"));
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
                // spin. Ordering below is chosen so a failure inside complete()
                // leaves the job retryable instead of stranded:
                //   1. remove .claim — lets another runner (or the next poll)
                //      rediscover the job if complete() below fails;
                //   2. write .result via complete() — notifies the submitter;
                //   3. remove .job — only after the submitter has a result, so
                //      a complete() failure keeps .job around for retry.
                //
                // Retry is safe: complete() uses tmp + rename, so a partial
                // first attempt leaves no observable .result, and a later
                // attempt atomically replaces whatever is there. Multi-runner
                // race (A and B both handle the same poison) is benign for the
                // same reason — both write the same parse error, last rename
                // wins, submitter sees one consistent result.
                let _ = std::fs::remove_file(&claim_file);
                self.complete(
                    run_id,
                    1,
                    Some(&format!("invalid job JSON: {e}")),
                    None,
                    None,
                )
                .await;
                let _ = std::fs::remove_file(&job_file);
                return None;
            }
        };

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
            cli_agent_type: req.cli_agent_type,
            debug_no_mock_claude: None,
            api_start_time: None,
            user_timezone: req.user_timezone,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            disallowed_tools: None,
            tools: None,
            settings: None,
            experimental_profile: req.profile,
            feature_flags: req.feature_flags,
            billable_firewalls: vec![],
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
        let response = JobResponse {
            run_id,
            exit_code,
            error: error.map(String::from),
        };
        let json = match serde_json::to_vec(&response) {
            Ok(j) => j,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to serialize result");
                return;
            }
        };

        // Atomic write: tmp then rename, so submit never reads a partial file.
        let tmp_file = self.group_dir.join(format!("{run_id}.result.tmp"));
        let result_file = self.group_dir.join(format!("{run_id}.result"));
        if let Err(e) = std::fs::write(&tmp_file, &json) {
            warn!(run_id = %run_id, error = %e, "local: failed to write result file");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp_file, &result_file) {
            warn!(run_id = %run_id, error = %e, "local: failed to rename result file");
        }
        // Best-effort cleanup of cancel file (may have been written after the
        // last discover() scan but before the job actually finished).
        let _ = std::fs::remove_file(self.group_dir.join(format!("{run_id}.cancel")));
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

    /// Write a job file into the group directory.
    fn write_job(dir: &std::path::Path, job_id: RunId, prompt: &str) {
        write_job_with_profile(dir, job_id, prompt, None);
    }

    /// Write a job file with an optional profile.
    fn write_job_with_profile(
        dir: &std::path::Path,
        job_id: RunId,
        prompt: &str,
        profile: Option<&str>,
    ) {
        let req = JobRequest {
            job_id,
            prompt: prompt.into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            vars: None,
            environment: None,
            user_timezone: None,
            profile: profile.map(String::from),
            session_id: None,
            feature_flags: None,
        };
        let json = serde_json::to_vec(&req).unwrap();
        std::fs::write(dir.join(format!("{job_id}.job")), &json).unwrap();
    }

    /// Read a result file from the group directory.
    fn read_result(dir: &std::path::Path, job_id: RunId) -> JobResponse {
        let path = dir.join(format!("{job_id}.result"));
        let buf = std::fs::read(path).unwrap();
        serde_json::from_slice(&buf).unwrap()
    }

    #[tokio::test]
    async fn discover_claim_complete() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "hello world");

        let (run_id, profile) = provider.discover().await.unwrap();
        assert_eq!(run_id, job_id);
        assert_eq!(profile, crate::profile::DEFAULT_PROFILE);

        let ctx = provider.claim(run_id).await.unwrap();
        assert_eq!(ctx.run_id, run_id);
        assert_eq!(ctx.prompt, "hello world");

        provider.complete(run_id, 0, None, None, None).await;

        let resp = read_result(dir.path(), job_id);
        assert_eq!(resp.exit_code, 0);
        assert!(resp.error.is_none());
    }

    #[tokio::test]
    async fn shutdown_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(
            dir.path().to_path_buf(),
            cancel.clone(),
            empty_cancel_tokens(),
        );

        cancel.cancel();
        assert!(provider.discover().await.is_none());
    }

    #[tokio::test]
    async fn skips_already_claimed_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        // Write two jobs, pre-claim the first
        let job1 = RunId::new_v4();
        let job2 = RunId::new_v4();
        write_job(dir.path(), job1, "claimed");
        write_job(dir.path(), job2, "available");
        std::fs::write(dir.path().join(format!("{job1}.claim")), b"").unwrap();

        let (run_id, _) = provider.discover().await.unwrap();
        assert_eq!(run_id, job2);
    }

    #[tokio::test]
    async fn concurrent_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let job1 = RunId::new_v4();
        let job2 = RunId::new_v4();
        write_job(dir.path(), job1, "job1");

        let (run_id1, _) = provider.discover().await.unwrap();
        let ctx1 = provider.claim(run_id1).await.unwrap();
        assert_eq!(ctx1.prompt, "job1");

        write_job(dir.path(), job2, "job2");

        let (run_id2, _) = provider.discover().await.unwrap();
        let ctx2 = provider.claim(run_id2).await.unwrap();
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
        let provider_a = LocalProvider::new(
            dir.path().to_path_buf(),
            cancel.clone(),
            Arc::clone(&tokens),
        );
        let provider_b = LocalProvider::new(dir.path().to_path_buf(), cancel, tokens);

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "shared");

        let (id_a, _) = provider_a.discover().await.unwrap();
        let (id_b, _) = provider_b.discover().await.unwrap();
        assert_eq!(id_a, job_id);
        assert_eq!(id_b, job_id);

        let claim_a = provider_a.claim(id_a).await;
        let claim_b = provider_b.claim(id_b).await;

        assert!(
            claim_a.is_some() ^ claim_b.is_some(),
            "exactly one runner should win the claim"
        );
    }

    #[tokio::test]
    async fn discover_returns_profile_from_job() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job_with_profile(dir.path(), job_id, "profiled job", Some("vm0/default"));

        let (run_id, profile) = provider.discover().await.unwrap();
        assert_eq!(run_id, job_id);
        assert_eq!(profile, "vm0/default");

        let ctx = provider.claim(run_id).await.unwrap();
        assert_eq!(ctx.experimental_profile.as_deref(), Some("vm0/default"));
    }

    #[tokio::test]
    async fn discover_defaults_profile_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "default job");

        let (run_id, profile) = provider.discover().await.unwrap();
        assert_eq!(run_id, job_id);
        assert_eq!(profile, crate::profile::DEFAULT_PROFILE);
    }

    #[tokio::test]
    async fn cancel_file_triggers_token() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let tokens = empty_cancel_tokens();

        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());

        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, tokens);

        // Write a .cancel file and a dummy .job so discover returns.
        std::fs::write(dir.path().join(format!("{run_id}.cancel")), b"").unwrap();
        let other_job = RunId::new_v4();
        write_job(dir.path(), other_job, "keep going");

        // discover() should scan cancel files then find the unclaimed job.
        let (found_id, _) = provider.discover().await.unwrap();
        assert_eq!(found_id, other_job);
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

        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, tokens);

        let cancel_path = dir.path().join(format!("{run_id}.cancel"));
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
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, tokens);

        // Write cancel file for a run_id that has no token.
        let unknown_id = RunId::new_v4();
        let cancel_path = dir.path().join(format!("{unknown_id}.cancel"));
        std::fs::write(&cancel_path, b"").unwrap();

        let job_id = RunId::new_v4();
        write_job(dir.path(), job_id, "still works");

        // Should not panic. Cancel file is kept (no matching token yet).
        let (found_id, _) = provider.discover().await.unwrap();
        assert_eq!(found_id, job_id);
        assert!(
            cancel_path.exists(),
            "cancel file should be kept when no token matches"
        );
    }

    #[tokio::test]
    async fn complete_cleans_up_cancel_file() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let cancel_path = dir.path().join(format!("{run_id}.cancel"));
        std::fs::write(&cancel_path, b"").unwrap();

        provider.complete(run_id, 0, None, None, None).await;

        assert!(
            !cancel_path.exists(),
            "complete() should clean up cancel file"
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
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, Arc::clone(&tokens));

        let run_id = RunId::new_v4();
        let cancel_path = dir.path().join(format!("{run_id}.cancel"));
        std::fs::write(&cancel_path, b"").unwrap();

        // Write a job so discover returns.
        write_job(dir.path(), run_id, "will be cancelled");

        // First discover: no token yet → cancel file kept, job returned.
        let (found_id, _) = provider.discover().await.unwrap();
        assert_eq!(found_id, run_id);
        assert!(
            cancel_path.exists(),
            "cancel file should survive (no token yet)"
        );

        // Simulate main loop inserting token after discover returns.
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());

        // Claim the job so it's no longer discoverable, then write another
        // job to let discover() return.
        provider.claim(run_id).await.unwrap();
        let other_job = RunId::new_v4();
        write_job(dir.path(), other_job, "next job");

        // Second discover: token exists now → cancel triggered and file deleted.
        let (found_id2, _) = provider.discover().await.unwrap();
        assert_eq!(found_id2, other_job);
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
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let claim_path = dir.path().join(format!("{run_id}.claim"));

        // No .job file — claim() should fail at the read step.
        assert!(provider.claim(run_id).await.is_none());
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
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel, empty_cancel_tokens());

        let run_id = RunId::new_v4();
        let claim_path = dir.path().join(format!("{run_id}.claim"));
        let job_path = dir.path().join(format!("{run_id}.job"));
        let result_path = dir.path().join(format!("{run_id}.result"));
        std::fs::write(&job_path, b"not json").unwrap();

        assert!(provider.claim(run_id).await.is_none());

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
}
