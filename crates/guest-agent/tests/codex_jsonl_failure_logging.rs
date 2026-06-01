//! Codex stdout JSONL failure events should be visible in the system log.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide `LazyLock`s.

mod common;

use agent_diagnostics::{FailureDetailSource, FailureReason};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::path::{Path, PathBuf};
use std::time::Duration;

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &Path) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

#[tokio::test]
async fn codex_jsonl_failure_events_are_reported() -> Result<(), Box<dyn std::error::Error>> {
    let mock = build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let system_log_path = tmp.path().join("system.log");

    unsafe {
        setup_codex_env(&mock, tmp.path(), "error-event")?;
    }

    let _system_log = SystemLogOverrideGuard::set(&system_log_path);
    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result
            .failure_diagnostic
            .as_ref()
            .map(|diagnostic| diagnostic.message.as_str()),
        Some("Mock error event for fixture testing")
    );
    assert_eq!(
        cli_result
            .failure_diagnostic
            .as_ref()
            .map(|diagnostic| diagnostic.source),
        Some(FailureDetailSource::CodexJsonl)
    );
    let system_log = std::fs::read_to_string(&system_log_path)?;
    assert!(
        system_log.contains(
            "Codex JSONL failure event seq=1 type=error: Mock error event for fixture testing"
        ),
        "system log should include Codex JSONL failure reason: {system_log}"
    );

    unsafe {
        std::env::set_var("MOCK_CODEX_FIXTURE", "invalid-api-key");
    }

    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    let diagnostic = cli_result
        .failure_diagnostic
        .as_ref()
        .expect("invalid API key JSONL error should produce a diagnostic");
    assert_eq!(diagnostic.message, "Incorrect API key provided");
    assert_eq!(diagnostic.source, FailureDetailSource::CodexJsonl);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::InvalidApiKey)
    );

    Ok(())
}

fn build_and_locate_mock_codex() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let target_profile_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "target/<profile> dir".to_string())?;
    let target_dir = target_profile_dir
        .parent()
        .ok_or_else(|| "target dir".to_string())?;
    let profile_dir_name = target_profile_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "profile dir name".to_string())?;

    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "-p", "guest-mock-codex", "--quiet"])
        .arg("--target-dir")
        .arg(target_dir);
    match profile_dir_name {
        "debug" => {}
        "release" => {
            cmd.arg("--release");
        }
        other => {
            cmd.args(["--profile", other]);
        }
    }

    let status = cmd
        .status()
        .map_err(|e| format!("invoke cargo build: {e}"))?;
    if !status.success() {
        return Err("cargo build -p guest-mock-codex failed".into());
    }

    let mock = target_profile_dir.join("guest-mock-codex");
    if !mock.exists() {
        return Err(format!("mock binary not found at {}", mock.display()));
    }
    Ok(mock)
}

unsafe fn setup_codex_env(
    mock_path: &Path,
    workdir: &Path,
    fixture_name: &str,
) -> Result<(), String> {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var("VM0_MOCK_CODEX_PATH", mock_path);
        std::env::set_var("USE_MOCK_CODEX", "true");
        std::env::set_var("MOCK_CODEX_FIXTURE", fixture_name);
        std::env::set_var("VM0_POST_RESULT_SIGTERM_GRACE_SECS", "3");
        std::env::set_var("VM0_POST_RESULT_SIGKILL_GRACE_SECS", "1");
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "codex-jsonl-failure-logging-test".to_string());
        std::env::set_var("VM0_RUN_ID", run_id);
        std::env::set_var("VM0_PROMPT", "drive the codex error fixture");
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", workdir);
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}
