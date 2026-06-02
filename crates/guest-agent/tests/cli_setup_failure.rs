//! CLI setup should fail before spawning the agent when local log setup fails.
//!
//! This test lives in its own binary because `guest_agent::env` and
//! `guest_agent::paths` cache values in process-wide `LazyLock`s.

mod common;

use guest_agent::error::AgentError;
use std::io::ErrorKind;
use std::time::Duration;

#[tokio::test]
async fn agent_log_open_failure_happens_before_cli_spawn() -> Result<(), Box<dyn std::error::Error>>
{
    let tmp = tempfile::tempdir()?;
    let run_prefix = format!("cli-log-parent-file-{}", std::process::id());
    let parent_file = std::env::temp_dir().join(format!("vm0-agent-{run_prefix}"));
    std::fs::write(&parent_file, b"not a directory")?;

    unsafe {
        std::env::set_var("VM0_RUN_ID", format!("{run_prefix}/child"));
        std::env::set_var("VM0_PROMPT", "@exit-after-result");
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var(
            "VM0_MOCK_CLAUDE_PATH",
            "/definitely/missing/guest-mock-claude",
        );
        std::env::set_var("HOME", tmp.path());
    }
    common::ensure_canonical_workspace_for_test()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = tokio::spawn(async { Ok(()) });

    let result = tokio::time::timeout(
        Duration::from_secs(1),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("log setup failure should return promptly");

    match result {
        Err(AgentError::Io(err)) => assert_eq!(err.kind(), ErrorKind::NotADirectory),
        Err(err) => return Err(format!("expected IO error from agent log setup, got {err}").into()),
        Ok(_) => return Err("expected execute_cli to fail before spawning CLI".into()),
    }

    let _ = std::fs::remove_file(parent_file);
    Ok(())
}
