//! End-to-end: heartbeat failure must still reap a SIGTERM-deaf CLI
//! with SIGKILL before returning the heartbeat error.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

mod common;

use agent_diagnostics::{CliTerminationReason, CliTerminationSignal};
use guest_agent::error::AgentError;
use std::time::Duration;

#[tokio::test]
async fn heartbeat_failure_reap_escalates_to_sigkill_when_sigterm_ignored()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stuck-tool-deaf", 1, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let sigterm_ignored_marker = tmp.path().join(".vm0-mock-sigterm-ignored");
    let heartbeat = common::spawn_heartbeat_monitor(async move {
        common::wait_for_path(&sigterm_ignored_marker, Duration::from_secs(5))
            .await
            .map_err(|_| AgentError::Execution("mock did not ignore SIGTERM".to_string()))?;

        Err(AgentError::Execution(
            "heartbeat failed for reap test".to_string(),
        ))
    });

    // Budget: marker wait (up to 5s) + sigterm grace (1s, ignored)
    // + sigkill grace (1s, unignorable) + stdout drain (5s) + slack.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::new().unwrap(),
        ),
    )
    .await
    .expect("execute_cli did not return within 15s - heartbeat reap escalation likely broken");

    let result = result.expect("execute_cli returned Err before collecting controlled termination");
    let err = result
        .control_error
        .as_ref()
        .expect("heartbeat failure should preserve a controlled execution error");
    assert!(
        err.to_string().contains("heartbeat failed for reap test"),
        "expected heartbeat error, got {err}"
    );
    let termination = result
        .cli_termination
        .expect("heartbeat failure should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::HeartbeatError);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));
    Ok(())
}
