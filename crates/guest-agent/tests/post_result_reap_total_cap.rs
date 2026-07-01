//! End-to-end: periodic meaningful JSONL events after `type=result` refresh the
//! quiet deadline but cannot refresh the absolute post-result total cap.

mod common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_total_cap_bounds_periodic_meaningful_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            "@hang-after-result-periodic-events",
            2,
            1,
        )?;
        std::env::set_var("VM0_POST_RESULT_TOTAL_CAP_SECS", "3");
    }
    let _run_files = common::RunFilesGuard::new();

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 8s");

    let result = result.expect("execute_cli returned Err");
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));

    let ops = std::fs::read_to_string(guest_common::telemetry::sandbox_ops_log())?;
    let cleanup_line = ops
        .lines()
        .find(|line| line.contains("post_result_cleanup_terminated"))
        .expect("post-result cleanup telemetry should be recorded");
    assert!(cleanup_line.contains("trigger=total_cap"), "{ops}");
    assert!(!cleanup_line.contains("meaningful_events=0"), "{ops}");
    Ok(())
}
