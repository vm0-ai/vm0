//! A large Claude stdin prompt must not block stdout processing.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn unread_claude_stdin_does_not_block_result_reap() -> Result<(), Box<dyn std::error::Error>>
{
    let tmp = tempfile::tempdir()?;
    let mock = tmp.path().join("unread-stdin-claude");
    std::fs::write(
        &mock,
        r#"#!/bin/sh
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":1}'
tail -f /dev/null
"#,
    )?;
    let mut permissions = std::fs::metadata(&mock)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&mock, permissions)?;

    let large_prompt = "x".repeat(2 * 1024 * 1024);
    unsafe {
        common::setup_env(&mock, tmp.path(), &large_prompt, 1, 1)?;
    }

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
    .expect("execute_cli should not block on unread stdin")?;

    assert_eq!(cli_result.exit_code, common::SIGTERM_EXIT);
    assert_eq!(
        cli_result.claude_result.and_then(|result| result.num_turns),
        Some(1)
    );
    Ok(())
}
