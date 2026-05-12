//! CLI stderr diagnostics must preserve an exact-limit final line without `\n`.
//!
//! This test lives in its own binary because `guest_agent::env` and
//! `guest_agent::paths` cache values in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_keeps_exact_limit_stderr_without_newline()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let exact_limit_line = "x".repeat(common::CLI_STDERR_RESULT_MAX_LINE_BYTES);

    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            &format!("@fail-no-newline:{exact_limit_line}"),
            3,
            1,
        )?;
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
    assert_eq!(cli_result.stderr_lines, vec![exact_limit_line]);

    Ok(())
}
