//! End-to-end: a meaningful JSONL event after `type=result` refreshes the
//! post-result quiet deadline before the hung CLI is reaped.

mod common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_refreshes_quiet_deadline_on_meaningful_event()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@hang-after-result-then-event", 2, 1)?;
        std::env::set_var("VM0_POST_RESULT_TOTAL_CAP_SECS", "10");
    }
    let _run_files = common::RunFilesGuard::new();

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(12),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::new().unwrap(),
        ),
    )
    .await
    .expect("execute_cli did not return within 12s");

    let result = result.expect("execute_cli returned Err");
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));

    let ops = std::fs::read_to_string(guest_common::telemetry::sandbox_ops_log())?;
    assert!(ops.contains("trigger=quiet_timeout"), "{ops}");
    assert!(ops.contains("meaningful_events=1"), "{ops}");
    Ok(())
}
