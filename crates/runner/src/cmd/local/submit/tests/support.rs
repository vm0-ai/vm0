use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::super::{SubmitArgs, SubmitQueueEntry};
use crate::ids::RunId;
use crate::local_queue::{self, JobRequest, JobResponse};

pub(super) fn submit_queue_entry(group_dir: &Path, job_id: RunId) -> SubmitQueueEntry {
    SubmitQueueEntry::for_job(group_dir, crate::profile::DEFAULT_PROFILE, job_id).unwrap()
}

pub(super) fn write_queue_job_file(group_dir: &Path, profile: &str, job_id: RunId) -> PathBuf {
    let path = local_queue::job_path(group_dir, profile, job_id).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"{}").unwrap();
    path
}

pub(super) fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

pub(super) async fn wait_for_job_and_write_result(
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

pub(super) async fn wait_for_job_and_write_success(
    group_dir: std::path::PathBuf,
    profile: String,
) -> JobRequest {
    wait_for_job_and_write_result(group_dir, profile, 0, None).await
}

pub(super) fn submit_args_for_test() -> SubmitArgs {
    SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: None,
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec![],
        env: vec![],
        secret_env: vec![],
        timeout: 1,
        active_inputs: vec![],
    }
}
