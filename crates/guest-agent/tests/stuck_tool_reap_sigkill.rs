//! End-to-end: stuck network tool watchdog must escalate from SIGTERM
//! to SIGKILL when the CLI ignores SIGTERM.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

mod common;

use std::time::Duration;

#[tokio::test]
async fn stuck_tool_reap_escalates_to_sigkill_when_sigterm_ignored()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        std::env::set_var("VM0_STUCK_TOOL_TIMEOUT_SECS", "1");
        common::setup_env(&mock, tmp.path(), "@stuck-tool-deaf", 1, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Budget: stuck-tool check interval (5s) + sigterm grace (1s,
    // ignored) + sigkill grace (1s, unignorable) + stdout drain (5s)
    // + slack.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(&masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s - forced SIGKILL escalation likely broken");

    assert!(
        tmp.path().join(".vm0-mock-sigterm-ignored").exists(),
        "mock did not install SIGTERM ignore marker"
    );

    let err = match result {
        Ok(_) => return Err("stuck tool timeout should fail the run".into()),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("Tool timeout: WebFetch"),
        "expected stuck tool timeout error, got {err}"
    );
    Ok(())
}
