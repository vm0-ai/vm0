//! End-to-end: stdout EOF before process exit must not bypass stuck-tool
//! forced termination.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

mod common;

use agent_diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn stuck_tool_reap_survives_stdout_eof_before_child_exit()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        std::env::set_var("VM0_STUCK_TOOL_TIMEOUT_SECS", "1");
        common::setup_env(&mock, tmp.path(), "@stuck-tool-closed-stdout-deaf", 1, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Budget: stdout EOF after tool_use + stuck-tool check interval (5s)
    // + sigkill grace (1s, unignorable) + slack.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::new().unwrap(),
        ),
    )
    .await
    .expect("execute_cli did not return within 15s - stdout EOF forced reap likely broken");

    assert!(
        tmp.path().join(".vm0-mock-sigterm-ignored").exists(),
        "mock did not install SIGTERM ignore marker"
    );

    let result = result.expect("execute_cli returned Err before collecting controlled termination");
    let err = result
        .control_error
        .as_ref()
        .expect("stuck tool timeout should preserve a controlled execution error");
    assert!(
        err.to_string().contains("Tool timeout: WebFetch"),
        "expected stuck tool timeout error, got {err}"
    );
    let termination = result
        .cli_termination
        .expect("stuck tool timeout should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::StuckToolWatchdog);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));
    Ok(())
}
