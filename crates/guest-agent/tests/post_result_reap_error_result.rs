//! End-to-end: a Claude error `type=result` followed by cleanup termination
//! remains a semantic failure source instead of falling back to exit 143.

mod common;

use guest_agent::cli::ClaudeResultStatus;
use guest_contracts::diagnostics::{
    CliTerminationReason, CliTerminationSignal, FailureDetailSource,
};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_preserves_error_diagnostic() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@hang-after-error-result", 1, 1)?;
    }
    let _run_files = common::RunFilesGuard::new();

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::new().unwrap(),
        ),
    )
    .await
    .expect("execute_cli did not return within 8s");

    let result = result.expect("execute_cli returned Err");
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    assert_eq!(
        result.claude_result.map(|summary| summary.status),
        Some(ClaudeResultStatus::Error)
    );
    assert_eq!(
        result
            .post_result_cleanup_result
            .map(|summary| summary.status),
        Some(ClaudeResultStatus::Error)
    );

    let diagnostic = result
        .failure_diagnostic
        .expect("error result should attach CLI failure diagnostic");
    assert_eq!(diagnostic.message, "Mock Claude error.");
    assert_eq!(diagnostic.source, FailureDetailSource::ClaudeResult);

    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    Ok(())
}
