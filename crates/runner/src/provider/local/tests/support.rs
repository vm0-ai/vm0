use std::sync::atomic::Ordering;

pub(super) use std::collections::HashMap;
pub(super) use std::sync::Arc;
pub(super) use std::time::Duration;

pub(super) use super::super::LocalProvider;
use super::super::job_candidate_from_discovered;
pub(super) use crate::ids::RunId;
pub(super) use crate::local_queue;
use crate::local_queue::JobRequest;
pub(super) use crate::local_queue::JobResponse;
pub(super) use crate::provider::{CompletionAuth, JobCandidate, JobProvider};
use crate::run_cancellation::{RunCancellationHandle, SharedRunCancellationMap};
pub(super) use tokio_util::sync::CancellationToken;

pub(super) trait LocalProviderTestExt {
    fn find_unclaimed_job(&self) -> Option<JobCandidate>;
    fn write_result(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool;
}

impl LocalProviderTestExt for LocalProvider {
    fn find_unclaimed_job(&self) -> Option<JobCandidate> {
        let start = self.profile_cursor.fetch_add(1, Ordering::Relaxed);
        self.queue
            .discover_candidate_sync(&self.supported_profiles, start)
            .map(job_candidate_from_discovered)
    }

    fn write_result(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool {
        self.queue.write_result_sync(run_id, exit_code, error)
    }
}

pub(super) fn empty_cancel_tokens() -> SharedRunCancellationMap {
    Arc::new(tokio::sync::Mutex::new(HashMap::new()))
}

pub(super) async fn insert_cancel_handle(
    tokens: &SharedRunCancellationMap,
    run_id: RunId,
) -> CancellationToken {
    let handle = RunCancellationHandle::new();
    let token = handle.token();
    tokens.lock().await.insert(run_id, handle);
    token
}

pub(super) fn profiles(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}

pub(super) fn default_profiles() -> Vec<String> {
    profiles(&[crate::profile::DEFAULT_PROFILE])
}

pub(super) fn default_provider(
    dir: &std::path::Path,
    cancel: CancellationToken,
    tokens: SharedRunCancellationMap,
) -> Arc<LocalProvider> {
    LocalProvider::new_inner(dir.to_path_buf(), default_profiles(), cancel, tokens, false)
}

pub(super) fn provider_with_profiles(
    dir: &std::path::Path,
    supported_profiles: &[&str],
    cancel: CancellationToken,
    tokens: SharedRunCancellationMap,
) -> Arc<LocalProvider> {
    LocalProvider::new_inner(
        dir.to_path_buf(),
        profiles(supported_profiles),
        cancel,
        tokens,
        false,
    )
}

pub(super) fn write_job(dir: &std::path::Path, job_id: RunId, prompt: &str) {
    write_job_in_partition(
        dir,
        crate::profile::DEFAULT_PROFILE,
        job_id,
        prompt,
        Some(crate::profile::DEFAULT_PROFILE),
    );
}

pub(super) fn write_job_with_profile(
    dir: &std::path::Path,
    job_id: RunId,
    prompt: &str,
    profile: Option<&str>,
) {
    let partition = profile.unwrap_or(crate::profile::DEFAULT_PROFILE);
    write_job_in_partition(dir, partition, job_id, prompt, profile);
}

pub(super) fn write_job_with_active_input(dir: &std::path::Path, job_id: RunId, prompt: &str) {
    write_job_in_partition_with_active_input(
        dir,
        crate::profile::DEFAULT_PROFILE,
        job_id,
        prompt,
        Some(crate::profile::DEFAULT_PROFILE),
        Some(true),
    );
}

pub(super) fn write_job_in_partition(
    dir: &std::path::Path,
    partition_profile: &str,
    job_id: RunId,
    prompt: &str,
    json_profile: Option<&str>,
) {
    write_job_in_partition_with_active_input(
        dir,
        partition_profile,
        job_id,
        prompt,
        json_profile,
        None,
    );
}

fn write_job_in_partition_with_active_input(
    dir: &std::path::Path,
    partition_profile: &str,
    job_id: RunId,
    prompt: &str,
    json_profile: Option<&str>,
    active_input: Option<bool>,
) {
    let req = JobRequest {
        job_id,
        prompt: prompt.into(),
        cli_agent_type: "claude-code".into(),
        vars: None,
        environment: None,
        secret_environment: None,
        user_timezone: None,
        profile: json_profile.map(String::from),
        session_id: None,
        feature_flags: None,
        active_input,
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

pub(super) fn write_job_with_environments(
    dir: &std::path::Path,
    job_id: RunId,
    environment: Option<HashMap<String, String>>,
    secret_environment: Option<HashMap<String, String>>,
) {
    let req = JobRequest {
        job_id,
        prompt: "hello with env".into(),
        cli_agent_type: "claude-code".into(),
        vars: None,
        environment,
        secret_environment,
        user_timezone: None,
        profile: Some(crate::profile::DEFAULT_PROFILE.into()),
        session_id: None,
        feature_flags: None,
        active_input: None,
    };
    let json = serde_json::to_vec(&req).unwrap();
    let job_dir = local_queue::profile_jobs_dir(dir, crate::profile::DEFAULT_PROFILE).unwrap();
    std::fs::create_dir_all(&job_dir).unwrap();
    std::fs::write(
        local_queue::job_path(dir, crate::profile::DEFAULT_PROFILE, job_id).unwrap(),
        &json,
    )
    .unwrap();
}

pub(super) fn read_result(dir: &std::path::Path, job_id: RunId) -> JobResponse {
    let path = local_queue::result_path(dir, job_id);
    let buf = std::fs::read(path).unwrap();
    serde_json::from_slice(&buf).unwrap()
}
