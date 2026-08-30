//! Bootstrap alias source evidence is persisted only after runtime sink setup.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CHILD_TEST: &str = "bootstrap_alias_source_events_isolated_child";
const CHILD_GUARD: &str = "OKOU_BOOTSTRAP_ALIAS_SOURCE_EVENTS_CHILD";
const CHILD_GUARD_VALUE: &str = "1";
const CHILD_MARKER: &str = "bootstrap-alias-source-events-child-complete";
const CHILD_TIMEOUT: Duration = Duration::from_secs(15);

const API_URL_VALUE: &str = "http://api-url-value-must-not-leak.example.test";
const API_TOKEN_VALUE: &str = "api-token-value-must-not-leak";
const SANDBOX_ID_VALUE: &str = "sandbox-id-value-must-not-leak";
const SANDBOX_REUSE_VALUE: &str = "sandbox-reuse-value-must-not-leak";
const WORKSPACE_REUSE_VALUE: &str = "workspace-reuse-value-must-not-leak";
const RESUME_SESSION_VALUE: &str = "resume-session-value-must-not-leak";
const API_START_TIME_VALUE: &str = "api-start-time-value-must-not-leak";

const SOURCE_EVENT_FAMILIES: [&str; 5] = [
    "api_url_env_source",
    "private_payload_file_env_source",
    "api_token_env_source",
    "agent_execution_timeout_env_source",
    "guest_agent_tuning_env_source",
];

const SOURCE_EVENTS: [(&str, &str); 9] = [
    (
        "api_url_env_source",
        guest_contracts::env::CANONICAL_API_URL_ENV,
    ),
    (
        "guest_agent_tuning_env_source",
        guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
    ),
    (
        "guest_agent_tuning_env_source",
        guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
    ),
    (
        "guest_agent_tuning_env_source",
        guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
    ),
    (
        "guest_agent_tuning_env_source",
        guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
    ),
    (
        "private_payload_file_env_source",
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
    ),
    (
        "private_payload_file_env_source",
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
    ),
    (
        "api_token_env_source",
        guest_contracts::env::CANONICAL_API_TOKEN_ENV,
    ),
    (
        "agent_execution_timeout_env_source",
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
    ),
];

struct PrivateFiles {
    user_env_path: PathBuf,
    run_payload_path: PathBuf,
}

fn write_private_files(runtime_dir: &Path) -> TestResult<PrivateFiles> {
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(&user_env_path, b"{}")?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;
    Ok(PrivateFiles {
        user_env_path,
        run_payload_path,
    })
}

fn source_messages(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .filter(|message| {
            SOURCE_EVENT_FAMILIES.iter().any(|family| {
                message
                    .strip_prefix(family)
                    .is_some_and(|suffix| suffix.starts_with(" key="))
            })
        })
        .collect()
}

fn expected_source_messages() -> Vec<String> {
    SOURCE_EVENTS
        .iter()
        .map(|(family, key)| format!("{family} key={key} source=canonical-only"))
        .collect()
}

fn assert_value_free(text: &str, runtime_dir: &Path) {
    for value in [
        API_URL_VALUE,
        API_TOKEN_VALUE,
        SANDBOX_ID_VALUE,
        SANDBOX_REUSE_VALUE,
        WORKSPACE_REUSE_VALUE,
        RESUME_SESSION_VALUE,
        API_START_TIME_VALUE,
    ] {
        assert!(!text.contains(value), "source evidence exposed {value}");
    }
    assert!(
        !text.contains(runtime_dir.to_string_lossy().as_ref()),
        "source evidence exposed the runtime or private-file path"
    );
}

#[tokio::test]
async fn runtime_bootstrap_persists_each_fixed_source_event_once() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime-path-value-must-not-leak");
    let private_files = write_private_files(&runtime_dir)?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--exact")
        .arg(CHILD_TEST)
        .arg("--ignored")
        .arg("--nocapture")
        .env_clear()
        .env(CHILD_GUARD, CHILD_GUARD_VALUE)
        .env(guest_contracts::env::RUN_ID_ENV, "bootstrap-source-run")
        .env("HOME", tmp.path().join("home"))
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        )
        .env(guest_contracts::env::CANONICAL_API_URL_ENV, API_URL_VALUE)
        .env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &private_files.user_env_path,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &private_files.run_payload_path,
        )
        .env(
            guest_contracts::env::CANONICAL_API_TOKEN_ENV,
            API_TOKEN_VALUE,
        )
        .env(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "37",
        )
        .env(
            guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            "38",
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "39",
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "40",
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "41",
        )
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            SANDBOX_ID_VALUE,
        )
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            SANDBOX_REUSE_VALUE,
        )
        .env(
            guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            WORKSPACE_REUSE_VALUE,
        )
        .env(
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
            RESUME_SESSION_VALUE,
        )
        .env(
            guest_contracts::env::CANONICAL_API_START_TIME_ENV,
            API_START_TIME_VALUE,
        );
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    let output = common::command_output_with_timeout(
        &mut command,
        CHILD_TIMEOUT,
        "isolated bootstrap source-event test did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated bootstrap failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(stdout.contains(CHILD_MARKER), "stdout:\n{stdout}");

    let system_log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
        &runtime_dir,
    ))?;
    let expected = expected_source_messages();
    let expected = expected.iter().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(source_messages(&stderr), expected, "stderr source events");
    assert_eq!(
        source_messages(&system_log),
        expected,
        "system-log source events"
    );
    assert_value_free(&stderr, &runtime_dir);
    assert_value_free(&system_log, &runtime_dir);
    assert!(!stderr.contains("run_metadata_env_source"));
    assert!(!system_log.contains("run_metadata_env_source"));
    assert!(!private_files.user_env_path.exists());
    assert!(!private_files.run_payload_path.exists());
    Ok(())
}

#[test]
#[ignore = "spawned exactly by the bootstrap source-event parent test"]
fn bootstrap_alias_source_events_isolated_child() -> TestResult {
    if std::env::var(CHILD_GUARD).ok().as_deref() != Some(CHILD_GUARD_VALUE) {
        return Ok(());
    }

    let runtime = guest_agent::run_context::GuestRuntime::from_process_env()
        .map_err(std::io::Error::other)?;
    assert!(runtime.config.user_env.is_empty());
    assert_eq!(runtime.config.api_url, API_URL_VALUE);
    assert_eq!(runtime.config.api_token, API_TOKEN_VALUE);
    assert_eq!(runtime.config.sandbox_id, SANDBOX_ID_VALUE);
    assert_eq!(runtime.config.sandbox_reuse_result, SANDBOX_REUSE_VALUE);
    assert_eq!(runtime.config.workspace_reuse_result, WORKSPACE_REUSE_VALUE);
    assert_eq!(runtime.config.resume_session_id, RESUME_SESSION_VALUE);
    assert_eq!(runtime.config.api_start_time, API_START_TIME_VALUE);
    println!("{CHILD_MARKER}");
    Ok(())
}
