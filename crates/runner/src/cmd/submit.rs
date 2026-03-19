//! `runner submit` — submit a job to locally running runners via file queue.
//!
//! Writes a `{job_id}.job` file into the group directory and polls for a
//! `{job_id}.result` file written by the runner that claimed the job.

use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use crate::provider::{JobRequest, JobResponse};

/// Poll interval for checking the result file.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Args)]
pub struct SubmitArgs {
    /// Runner group name (writes job to ~/.vm0-runner/groups/{group}/)
    #[arg(long)]
    group: String,
    /// Job prompt
    #[arg(long)]
    prompt: String,
    /// Working directory inside the VM
    #[arg(long, default_value = "/home/user/workspace")]
    working_dir: String,
    /// Agent type
    #[arg(long, default_value = "claude-code")]
    cli_agent_type: String,
    /// VM profile to use (e.g. "vm0/default")
    #[arg(long)]
    profile: Option<String>,
    /// Timeout in seconds waiting for a runner to complete the job
    #[arg(long, default_value_t = 300)]
    timeout: u64,
}

pub async fn run_submit(args: SubmitArgs) -> RunnerResult<ExitCode> {
    if let Some(ref profile) = args.profile
        && !crate::profile::validate_name(profile)
    {
        return Err(RunnerError::Config(format!(
            "invalid profile name: {profile} (must be org/name format, lowercase alphanumeric + hyphens)"
        )));
    }

    let home = HomePaths::new()?;
    let group_dir = home.groups_dir().join(&args.group);

    std::fs::create_dir_all(&group_dir).map_err(|e| {
        RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
    })?;

    let job_id = Uuid::new_v4();
    let request = JobRequest {
        job_id,
        prompt: args.prompt,
        working_dir: args.working_dir,
        cli_agent_type: args.cli_agent_type,
        vars: None,
        environment: None,
        user_timezone: None,
        profile: args.profile,
    };

    let json = serde_json::to_vec(&request)
        .map_err(|e| RunnerError::Internal(format!("serialize request: {e}")))?;

    // Write atomically: tmp file then rename.
    let tmp_path = group_dir.join(format!("{job_id}.job.tmp"));
    let job_path = group_dir.join(format!("{job_id}.job"));
    std::fs::write(&tmp_path, &json)
        .map_err(|e| RunnerError::Internal(format!("write job file: {e}")))?;
    std::fs::rename(&tmp_path, &job_path)
        .map_err(|e| RunnerError::Internal(format!("rename job file: {e}")))?;

    // Poll for result.
    let result_path = group_dir.join(format!("{job_id}.result"));
    let timeout = Duration::from_secs(args.timeout);
    let deadline = tokio::time::Instant::now() + timeout;

    let buf = loop {
        if result_path.exists() {
            match std::fs::read(&result_path) {
                Ok(b) if !b.is_empty() => break b,
                _ => {}
            }
        }
        if tokio::time::Instant::now() >= deadline {
            // Clean up queue files on timeout.
            let _ = std::fs::remove_file(&job_path);
            let _ = std::fs::remove_file(group_dir.join(format!("{job_id}.claim")));
            return Err(RunnerError::Internal(format!(
                "timeout waiting for result after {timeout:?}"
            )));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };

    let response: JobResponse = serde_json::from_slice(&buf)
        .map_err(|e| RunnerError::Internal(format!("parse result: {e}")))?;

    // Clean up queue files.
    let _ = std::fs::remove_file(&job_path);
    let _ = std::fs::remove_file(&result_path);
    let _ = std::fs::remove_file(group_dir.join(format!("{job_id}.claim")));

    use std::io::Write;
    std::io::stdout().write_all(&buf).ok();
    std::io::stdout().write_all(b"\n").ok();

    if response.exit_code == 0 {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::FAILURE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_invalid_profile_name() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some("bad-name".into()),
            timeout: 1,
        };
        let err = run_submit(args).await.unwrap_err();
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
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some("vm0/default".into()),
            timeout: 1,
        };
        // Should pass validation and fail later (HomePaths or timeout), not on profile.
        let result = run_submit(args).await;
        if let Err(e) = &result {
            assert!(!e.to_string().contains("invalid profile name"), "got: {e}");
        }
    }
}
