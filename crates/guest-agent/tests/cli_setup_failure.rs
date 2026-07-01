//! CLI setup should fail before spawning the agent when local log setup fails.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::error::AgentError;
use std::io::ErrorKind;
use std::time::Duration;

#[tokio::test]
async fn agent_log_open_failure_happens_before_cli_spawn() -> Result<(), Box<dyn std::error::Error>>
{
    let tmp = tempfile::tempdir()?;
    let run_id = format!("cli-log-parent-file-{}", std::process::id());
    let runtime_dir = tmp.path().join("guest-runtime");
    let log_parent = runtime_dir.join("logs");
    std::fs::create_dir_all(&runtime_dir)?;
    std::fs::write(&log_parent, b"not a directory")?;

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var("VM0_RUN_ID", &run_id);
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            runtime_dir.as_os_str(),
        );
        std::env::set_var("VM0_PROMPT", "@exit-after-result");
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var(
            "VM0_MOCK_CLAUDE_PATH",
            "/definitely/missing/guest-mock-claude",
        );
        std::env::set_var("HOME", tmp.path());
    }
    common::ensure_canonical_workspace_for_test()?;

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_heartbeat_monitor(async { Ok::<(), AgentError>(()) });

    let result = tokio::time::timeout(
        Duration::from_secs(1),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("log setup failure should return promptly");

    match result {
        Err(AgentError::Io(err)) => assert!(
            matches!(
                err.kind(),
                ErrorKind::AlreadyExists | ErrorKind::NotADirectory
            ),
            "unexpected IO error: {err:?}",
        ),
        Err(err) => return Err(format!("expected IO error from agent log setup, got {err}").into()),
        Ok(_) => return Err("expected execute_cli to fail before spawning CLI".into()),
    }

    Ok(())
}
