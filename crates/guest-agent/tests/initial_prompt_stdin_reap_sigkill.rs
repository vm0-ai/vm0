//! Initial prompt stdin failures should preserve controlled termination context.

mod common;

use agent_diagnostics::{CliTerminationReason, CliTerminationSignal};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn initial_prompt_stdin_failure_reap_escalates_to_sigkill()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let mock = tmp.path().join("closed-stdin-claude");
    std::fs::write(
        &mock,
        r#"#!/bin/sh
exec 0<&-
trap '' TERM
tail -f /dev/null
"#,
    )?;
    let mut permissions = std::fs::metadata(&mock)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&mock, permissions)?;

    let large_prompt = "x".repeat(2 * 1024 * 1024);
    unsafe {
        common::setup_env(&mock, tmp.path(), &large_prompt, 3, 1)?;
    }

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli did not return within 15s - stdin failure reap likely broken");

    let result = result.expect("execute_cli returned Err before collecting controlled termination");
    let err = result
        .control_error
        .as_ref()
        .expect("stdin writer failure should preserve a controlled execution error");
    assert!(
        err.to_string().contains("Broken pipe"),
        "expected broken pipe stdin error, got {err}"
    );
    let termination = result
        .cli_termination
        .expect("stdin writer failure should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::InitialPromptStdin);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));

    Ok(())
}
