//! Claude failures before stdin is read should preserve CLI stderr/exit status.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn claude_exit_before_stdin_read_preserves_stderr() -> Result<(), Box<dyn std::error::Error>>
{
    let tmp = tempfile::tempdir()?;
    let mock = tmp.path().join("early-exit-claude");
    std::fs::write(
        &mock,
        "#!/bin/sh\necho 'claude auth failed before stdin' >&2\nexit 7\n",
    )?;
    let mut permissions = std::fs::metadata(&mock)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&mock, permissions)?;

    unsafe {
        common::setup_env(&mock, tmp.path(), "prompt written through stdin", 3, 1)?;
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
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, 7);
    assert_eq!(
        cli_result.stderr_lines,
        vec!["claude auth failed before stdin"]
    );
    Ok(())
}
