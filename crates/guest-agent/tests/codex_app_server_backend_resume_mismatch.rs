//! Resume response validation for the disabled Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_mismatched_resume_thread_id()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let resume_thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";

    unsafe {
        setup_codex_app_server_env(&mock, tmp.path(), resume_thread_id)?;
    }
    let _run_files = common::RunFilesGuard::new();

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly");

    let error = result.expect_err("mismatched resume response should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("thread/resume returned a different thread id"),
        "unexpected error: {message}"
    );
    let session_id_path = guest_agent::paths::session_id_file();
    assert!(
        !std::path::Path::new(session_id_path).exists(),
        "mismatched resume response should not write a session id"
    );

    Ok(())
}

unsafe fn setup_codex_app_server_env(
    mock_path: &Path,
    home: &Path,
    resume_thread_id: &str,
) -> Result<(), String> {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var("VM0_CODEX_APP_SERVER_BACKEND", "1");
        std::env::set_var("VM0_MOCK_CODEX_PATH", mock_path);
        std::env::set_var("USE_MOCK_CODEX", "true");
        std::env::remove_var("MOCK_CODEX_FIXTURE");
        std::env::set_var(
            "MOCK_CODEX_APP_SERVER_SCENARIO",
            "resume-different-thread-id",
        );
        std::env::set_var("VM0_RESUME_SESSION_ID", resume_thread_id);
        std::env::set_var(
            "VM0_RUN_ID",
            "codex-app-server-backend-resume-mismatch-test",
        );
        std::env::set_var(
            "VM0_PROMPT",
            "drive the app-server backend resume mismatch path",
        );
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
