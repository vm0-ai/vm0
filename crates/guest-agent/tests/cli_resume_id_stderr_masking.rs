//! Resume session IDs must be masked even when the CLI fails before emitting JSONL.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_masks_resume_session_id_in_stderr() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let resume_id = "resume-secret-123";

    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            &format!("@fail-no-newline:resume failed for {resume_id}"),
            3,
            1,
        )?;
        std::env::set_var("VM0_RESUME_SESSION_ID", resume_id);
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

    assert_eq!(cli_result.exit_code, 1);
    let stderr = cli_result.stderr_lines.join("\n");
    assert!(
        stderr.contains("resume failed for ***"),
        "stderr should mask resume session id, got: {stderr}"
    );
    assert!(
        !stderr.contains(resume_id),
        "stderr leaked resume session id: {stderr}"
    );

    Ok(())
}
