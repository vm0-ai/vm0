//! CLI stderr diagnostics must bound lossy UTF-8 expansion.
//!
//! This test lives in its own binary because `guest_agent::env` and
//! `guest_agent::paths` cache values in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_omits_invalid_stderr_when_lossy_decode_exceeds_limit()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_env(&mock, tmp.path(), "@fail-invalid-utf8-long", 3, 1)?;
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
    assert_eq!(
        cli_result.stderr_lines,
        vec![common::CLI_STDERR_OMITTED_LONG_LINE]
    );

    Ok(())
}
