//! `runner local submit` — submit a job to locally running runners via file queue.
//!
//! Writes a `{job_id}.job` file into the group directory and polls for a
//! `{job_id}.result` file written by the runner that claimed the job.

use std::process::ExitCode;
use std::time::Duration;

use clap::Args;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_runner_registry::LocalRunnerRegistry;
use crate::paths::HomePaths;
use crate::provider::{JobRequest, JobResponse};

/// Poll interval for checking the result file.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Grace period after Ctrl+C to wait for the runner to write a `.result` file.
const CANCEL_GRACE: Duration = Duration::from_secs(10);

#[derive(Args)]
pub struct SubmitArgs {
    /// Runner group name (writes job to /var/lib/vm0-runner/groups/{group}/)
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

/// Clean up all queue files for a job.
fn cleanup_files(
    job_path: &std::path::Path,
    result_path: &std::path::Path,
    cancel_path: &std::path::Path,
    group_dir: &std::path::Path,
    job_id: RunId,
) {
    let _ = std::fs::remove_file(job_path);
    let _ = std::fs::remove_file(result_path);
    let _ = std::fs::remove_file(cancel_path);
    let _ = std::fs::remove_file(group_dir.join(format!("{job_id}.claim")));
}

fn ensure_live_runner_supports_profile(
    group_dir: &std::path::Path,
    group: &str,
    profile: &str,
) -> RunnerResult<()> {
    let live_profiles = LocalRunnerRegistry::new(group_dir.to_path_buf()).live_profiles()?;
    if live_profiles.contains(profile) {
        return Ok(());
    }

    let available = if live_profiles.is_empty() {
        "none".to_string()
    } else {
        live_profiles.into_iter().collect::<Vec<_>>().join(", ")
    };
    Err(RunnerError::Config(format!(
        "no live local runner in group {group} supports profile {profile}; live profiles: {available}; start a local runner with this profile or choose a supported profile"
    )))
}

pub async fn run_submit(args: SubmitArgs) -> RunnerResult<ExitCode> {
    crate::group::validate_or_err(&args.group)?;

    if let Some(ref profile) = args.profile {
        crate::profile::validate_or_err(profile)?;
    }

    let feature_flags = if args.feature_flags.is_empty() {
        None
    } else {
        let mut map = std::collections::HashMap::new();
        for flag in &args.feature_flags {
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
        Some(map)
    };

    let home = HomePaths::new()?;
    let group_dir = home.groups_dir().join(&args.group);
    let requested_profile = args
        .profile
        .clone()
        .unwrap_or_else(|| crate::profile::DEFAULT_PROFILE.to_owned());

    std::fs::create_dir_all(&group_dir).map_err(|e| {
        RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
    })?;
    ensure_live_runner_supports_profile(&group_dir, &args.group, &requested_profile)?;

    let job_id = RunId::new_v4();
    let request = JobRequest {
        job_id,
        prompt: args.prompt,
        working_dir: args.working_dir,
        cli_agent_type: args.cli_agent_type,
        vars: None,
        environment: None,
        user_timezone: detect_system_timezone(),
        profile: args.profile,
        session_id: args.session_id,
        feature_flags,
    };

    let json = serde_json::to_vec(&request)
        .map_err(|e| RunnerError::Internal(format!("serialize request: {e}")))?;

    // Write atomically: tmp file then rename.
    let tmp_path = group_dir.join(format!("{job_id}.job.tmp"));
    let job_path = group_dir.join(format!("{job_id}.job"));
    std::fs::write(&tmp_path, &json).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        RunnerError::Internal(format!("write job file: {e}"))
    })?;
    std::fs::rename(&tmp_path, &job_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        RunnerError::Internal(format!("rename job file: {e}"))
    })?;

    // Poll for result, listening for Ctrl+C to cancel.
    let result_path = group_dir.join(format!("{job_id}.result"));
    let cancel_path = group_dir.join(format!("{job_id}.cancel"));
    let timeout = Duration::from_secs(args.timeout);
    let deadline = tokio::time::Instant::now() + timeout;

    let buf = loop {
        if let Some(b) = try_read_result(&result_path) {
            break b;
        }
        if tokio::time::Instant::now() >= deadline {
            cleanup_files(&job_path, &result_path, &cancel_path, &group_dir, job_id);
            return Err(RunnerError::Internal(format!(
                "timeout waiting for result after {timeout:?}"
            )));
        }
        tokio::select! {
            () = tokio::time::sleep(POLL_INTERVAL) => {}
            _ = tokio::signal::ctrl_c() => {
                eprintln!("interrupted — requesting cancel for {job_id}");
                let _ = std::fs::write(&cancel_path, b"");
                // Give the runner a short window to finish and write .result.
                // A second Ctrl+C exits immediately.
                let grace = tokio::time::Instant::now() + CANCEL_GRACE;
                let cancelled_buf = loop {
                    if let Some(b) = try_read_result(&result_path) {
                        break b;
                    }
                    if tokio::time::Instant::now() >= grace {
                        eprintln!("grace period expired, exiting");
                        // Leave .cancel for the runner to process — don't
                        // delete it here or the cancel request may be lost.
                        let _ = std::fs::remove_file(&job_path);
                        return Ok(ExitCode::FAILURE);
                    }
                    tokio::select! {
                        () = tokio::time::sleep(POLL_INTERVAL) => {}
                        _ = tokio::signal::ctrl_c() => {
                            eprintln!("second interrupt, exiting immediately");
                            let _ = std::fs::remove_file(&job_path);
                            return Ok(ExitCode::FAILURE);
                        }
                    }
                };
                break cancelled_buf;
            }
        }
    };

    let response: JobResponse = serde_json::from_slice(&buf)
        .map_err(|e| RunnerError::Internal(format!("parse result: {e}")))?;

    // Clean up queue files.
    cleanup_files(&job_path, &result_path, &cancel_path, &group_dir, job_id);

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
    use std::sync::Mutex;

    /// Serialize tests that mutate environment variables to prevent UB.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

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
    fn cleanup_files_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let job_id = RunId::new_v4();
        let job_path = group_dir.join(format!("{job_id}.job"));
        let result_path = group_dir.join(format!("{job_id}.result"));
        let cancel_path = group_dir.join(format!("{job_id}.cancel"));

        // Create some files
        std::fs::write(&job_path, b"{}").unwrap();
        std::fs::write(&result_path, b"{}").unwrap();

        // First cleanup
        cleanup_files(&job_path, &result_path, &cancel_path, group_dir, job_id);
        assert!(!job_path.exists());
        assert!(!result_path.exists());

        // Second cleanup (idempotent — no panic on missing files)
        cleanup_files(&job_path, &result_path, &cancel_path, group_dir, job_id);
    }

    #[test]
    fn preflight_rejects_profile_without_live_runner() {
        let dir = tempfile::tempdir().unwrap();

        let err = ensure_live_runner_supports_profile(dir.path(), "test/group", "vm0/default")
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("no live local runner in group test/group supports profile vm0/default"),
            "got: {err}"
        );
        assert!(
            !dir.path().read_dir().unwrap().any(|entry| entry
                .unwrap()
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                == Some("job")),
            "preflight must not create job files"
        );
    }

    #[test]
    fn preflight_accepts_profile_from_live_runner() {
        let dir = tempfile::tempdir().unwrap();
        LocalRunnerRegistry::new(dir.path().to_path_buf())
            .write_record("runner-1", "local", vec!["vm0/default".into()])
            .unwrap();

        ensure_live_runner_supports_profile(dir.path(), "test/group", "vm0/default").unwrap();
    }

    #[test]
    fn preflight_accepts_profile_from_any_live_runner() {
        let dir = tempfile::tempdir().unwrap();
        let registry = LocalRunnerRegistry::new(dir.path().to_path_buf());
        registry
            .write_record("runner-1", "local-a", vec!["vm0/default".into()])
            .unwrap();
        registry
            .write_record("runner-2", "local-b", vec!["vm0/large".into()])
            .unwrap();

        ensure_live_runner_supports_profile(dir.path(), "test/group", "vm0/large").unwrap();
    }

    #[test]
    fn preflight_ignores_stale_runner_records() {
        let dir = tempfile::tempdir().unwrap();
        let runners_dir = dir.path().join(".runners");
        std::fs::create_dir_all(&runners_dir).unwrap();
        let json = serde_json::to_vec(&serde_json::json!({
            "runner_id": "runner-1",
            "name": "local",
            "profiles": ["vm0/default"],
            "updated_at_ms": 1,
            "pid": std::process::id(),
        }))
        .unwrap();
        std::fs::write(runners_dir.join("runner-1.json"), json).unwrap();

        let err = ensure_live_runner_supports_profile(dir.path(), "test/group", "vm0/default")
            .unwrap_err();

        assert!(
            err.to_string().contains("live profiles: none"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_invalid_profile_name() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some("bad-name".into()),
            session_id: None,
            feature_flags: vec![],
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
            session_id: None,
            feature_flags: vec![],
            timeout: 1,
        };
        // Should pass validation and fail later (HomePaths or timeout), not on profile.
        let result = run_submit(args).await;
        if let Err(e) = &result {
            assert!(!e.to_string().contains("invalid profile name"), "got: {e}");
        }
    }

    #[tokio::test]
    async fn rejects_feature_flag_missing_equals() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            session_id: None,
            feature_flags: vec!["myFlag".into()],
            timeout: 1,
        };
        let err = run_submit(args).await.unwrap_err();
        assert!(err.to_string().contains("expected key=value"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_feature_flag_non_boolean() {
        let args = SubmitArgs {
            group: "test/group".into(),
            prompt: "hello".into(),
            working_dir: "/workspace".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            session_id: None,
            feature_flags: vec!["myFlag=yes".into()],
            timeout: 1,
        };
        let err = run_submit(args).await.unwrap_err();
        assert!(
            err.to_string().contains("expected true/false"),
            "got: {err}"
        );
    }
}
