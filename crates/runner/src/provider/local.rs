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
use uuid::Uuid;

use super::JobProvider;
use crate::types::ExecutionContext;

/// Poll interval for discovering new job files.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Job request written by `submit` as a `{job_id}.job` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobRequest {
    pub(crate) job_id: Uuid,
    pub(crate) prompt: String,
    pub(crate) working_dir: String,
    pub(crate) cli_agent_type: String,
    #[serde(default)]
    pub(crate) vars: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) user_timezone: Option<String>,
}

/// Job response written by the runner as a `{job_id}.result` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobResponse {
    pub(crate) run_id: Uuid,
    pub(crate) exit_code: i32,
    pub(crate) error: Option<String>,
}

/// [`JobProvider`] backed by a file queue in a shared group directory.
///
/// - `discover()` polls `{group_dir}/*.job` for files without a `.claim`.
/// - `claim()` atomically creates `{job_id}.claim` via `O_EXCL`.
/// - `complete()` writes `{job_id}.result`.
pub struct LocalProvider {
    group_dir: PathBuf,
    cancel: CancellationToken,
}

impl LocalProvider {
    /// Create a new file-queue provider for the given group directory.
    pub fn new(group_dir: PathBuf, cancel: CancellationToken) -> Arc<Self> {
        info!(path = %group_dir.display(), "local provider watching");
        Arc::new(Self { group_dir, cancel })
    }

    /// Find the first `.job` file that has no corresponding `.claim` file.
    fn find_unclaimed_job(&self) -> Option<Uuid> {
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
            let Ok(job_id) = stem.parse::<Uuid>() else {
                continue;
            };
            let claim_path = self.group_dir.join(format!("{job_id}.claim"));
            if !claim_path.exists() {
                return Some(job_id);
            }
        }
        None
    }
}

#[async_trait::async_trait]
impl JobProvider for LocalProvider {
    async fn discover(&self) -> Option<Uuid> {
        loop {
            if self.cancel.is_cancelled() {
                return None;
            }
            if let Some(job_id) = self.find_unclaimed_job() {
                info!(run_id = %job_id, "local: job discovered");
                return Some(job_id);
            }
            tokio::select! {
                () = self.cancel.cancelled() => return None,
                () = tokio::time::sleep(POLL_INTERVAL) => {}
            }
        }
    }

    async fn claim(&self, run_id: Uuid) -> Option<ExecutionContext> {
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
                return None;
            }
        };
        let req: JobRequest = match serde_json::from_slice(&buf) {
            Ok(r) => r,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: invalid job JSON");
                return None;
            }
        };

        info!(run_id = %run_id, "local: job claimed");
        Some(ExecutionContext {
            run_id,
            prompt: req.prompt,
            agent_compose_version_id: None,
            vars: req.vars,
            checkpoint_id: None,
            sandbox_token: String::new(),
            working_dir: req.working_dir,
            storage_manifest: None,
            environment: req.environment,
            resume_session: None,
            secret_values: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            cli_agent_type: req.cli_agent_type,
            debug_no_mock_claude: None,
            api_start_time: None,
            user_timezone: req.user_timezone,
            agent_name: None,
            agent_org_slug: None,
            memory_name: None,
            experimental_firewall: None,
        })
    }

    async fn complete(&self, run_id: Uuid, exit_code: i32, error: Option<&str>) {
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
    }

    async fn shutdown(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a job file into the group directory.
    fn write_job(dir: &std::path::Path, job_id: Uuid, prompt: &str) {
        let req = JobRequest {
            job_id,
            prompt: prompt.into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            vars: None,
            environment: None,
            user_timezone: None,
        };
        let json = serde_json::to_vec(&req).unwrap();
        std::fs::write(dir.join(format!("{job_id}.job")), &json).unwrap();
    }

    /// Read a result file from the group directory.
    fn read_result(dir: &std::path::Path, job_id: Uuid) -> JobResponse {
        let path = dir.join(format!("{job_id}.result"));
        let buf = std::fs::read(path).unwrap();
        serde_json::from_slice(&buf).unwrap()
    }

    #[tokio::test]
    async fn discover_claim_complete() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel);

        let job_id = Uuid::new_v4();
        write_job(dir.path(), job_id, "hello world");

        let run_id = provider.discover().await.unwrap();
        assert_eq!(run_id, job_id);

        let ctx = provider.claim(run_id).await.unwrap();
        assert_eq!(ctx.run_id, run_id);
        assert_eq!(ctx.prompt, "hello world");

        provider.complete(run_id, 0, None).await;

        let resp = read_result(dir.path(), job_id);
        assert_eq!(resp.exit_code, 0);
        assert!(resp.error.is_none());
    }

    #[tokio::test]
    async fn shutdown_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel.clone());

        cancel.cancel();
        assert!(provider.discover().await.is_none());
    }

    #[tokio::test]
    async fn skips_already_claimed_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel);

        // Write two jobs, pre-claim the first
        let job1 = Uuid::new_v4();
        let job2 = Uuid::new_v4();
        write_job(dir.path(), job1, "claimed");
        write_job(dir.path(), job2, "available");
        std::fs::write(dir.path().join(format!("{job1}.claim")), b"").unwrap();

        let run_id = provider.discover().await.unwrap();
        assert_eq!(run_id, job2);
    }

    #[tokio::test]
    async fn concurrent_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(dir.path().to_path_buf(), cancel);

        let job1 = Uuid::new_v4();
        let job2 = Uuid::new_v4();
        write_job(dir.path(), job1, "job1");

        let run_id1 = provider.discover().await.unwrap();
        let ctx1 = provider.claim(run_id1).await.unwrap();
        assert_eq!(ctx1.prompt, "job1");

        write_job(dir.path(), job2, "job2");

        let run_id2 = provider.discover().await.unwrap();
        let ctx2 = provider.claim(run_id2).await.unwrap();
        assert_eq!(ctx2.prompt, "job2");
        assert_ne!(run_id1, run_id2);

        provider.complete(run_id1, 0, None).await;
        provider.complete(run_id2, 1, Some("test error")).await;

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

        let provider_a = LocalProvider::new(dir.path().to_path_buf(), cancel.clone());
        let provider_b = LocalProvider::new(dir.path().to_path_buf(), cancel);

        let job_id = Uuid::new_v4();
        write_job(dir.path(), job_id, "shared");

        let id_a = provider_a.discover().await.unwrap();
        let id_b = provider_b.discover().await.unwrap();
        assert_eq!(id_a, job_id);
        assert_eq!(id_b, job_id);

        let claim_a = provider_a.claim(id_a).await;
        let claim_b = provider_b.claim(id_b).await;

        assert!(
            claim_a.is_some() ^ claim_b.is_some(),
            "exactly one runner should win the claim"
        );
    }
}
