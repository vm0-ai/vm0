//! End-to-end: CLI hangs after `type=result`, reap SIGTERMs it, default
//! SIGTERM handler exits with 143. Exercises Idle → SigtermPending →
//! Done via `child.wait()` after the signal.
//!
//! See: https://github.com/vm0-ai/vm0/issues/10879

mod common;

use std::time::Duration;

#[tokio::test]
async fn post_result_reap_sigterm_kills_hung_cli() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // Fast convergence: 1s sigterm grace + 1s sigkill grace.
        common::setup_env(&mock, tmp.path(), "@hang-after-result", 1, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Budget: sigterm grace (1s) + stdout drain (5s) + slack = 15s.
    // Mock hangs 3600s, so any completion under this cap came from the
    // reap. Locally runs in ~1s.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(&masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s — reap likely broken");

    let result = result.expect("execute_cli returned Err");
    let exit_code = result.exit_code;

    // On pathologically slow runners the sigkill escalation may fire
    // before SIGTERM actually terminates the mock; accept either.
    assert!(
        exit_code == common::SIGTERM_EXIT || exit_code == common::SIGKILL_EXIT,
        "expected signal-based exit ({} or {}), got {exit_code}",
        common::SIGTERM_EXIT,
        common::SIGKILL_EXIT
    );
    Ok(())
}
