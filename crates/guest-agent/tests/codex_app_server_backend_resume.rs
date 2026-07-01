//! Resume-path integration coverage for the experimental Codex app-server backend.
//!
//! This is separate from `codex_app_server_backend.rs` because `guest_agent::env`
//! caches `VM0_RESUME_SESSION_ID` in a process-wide `LazyLock`.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_resumes_existing_thread_id()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let resume_thread_id = "0193ABCDEF01723489ABCDEF01234567";
    let canonical_resume_thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";

    unsafe {
        setup_codex_app_server_env(
            &mock,
            tmp.path(),
            "codex-app-server-backend-resume-test",
            "runtime-turn-complete",
            resume_thread_id,
        )?;
    }
    let _run_files = common::RunFilesGuard::new();

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
    assert!(cli_result.failure_diagnostic.is_none());

    let events = read_agent_log_events()?;
    assert_eq!(
        events[0].get("type").and_then(Value::as_str),
        Some("thread.started")
    );
    assert_eq!(
        events[0].get("thread_id").and_then(Value::as_str),
        Some(canonical_resume_thread_id)
    );

    let stored_id = std::fs::read_to_string(guest_agent::paths::session_id_file())?;
    assert_eq!(stored_id, canonical_resume_thread_id);
    let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())?;
    assert!(marker.ends_with(&format!(":{canonical_resume_thread_id}")));

    Ok(())
}

fn read_agent_log_events() -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(guest_agent::paths::agent_log_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

unsafe fn setup_codex_app_server_env(
    mock_path: &Path,
    home: &Path,
    run_id: &str,
    scenario: &str,
    resume_session_id: &str,
) -> Result<(), String> {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var("VM0_CODEX_APP_SERVER_BACKEND", "1");
        std::env::set_var("VM0_MOCK_CODEX_PATH", mock_path);
        std::env::set_var("USE_MOCK_CODEX", "true");
        std::env::remove_var("MOCK_CODEX_FIXTURE");
        std::env::set_var("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
        std::env::set_var("VM0_RESUME_SESSION_ID", resume_session_id);
        std::env::set_var("VM0_RUN_ID", run_id);
        std::env::set_var("VM0_PROMPT", "drive the app-server resume backend");
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", home);
    }
    std::fs::create_dir_all(home).map_err(|error| format!("create home: {error}"))?;
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(home).map_err(|error| format!("set_current_dir: {error}"))?;
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
