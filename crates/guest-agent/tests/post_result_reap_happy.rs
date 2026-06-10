//! End-to-end: CLI cleanly exits on its own after `type=result`. The
//! reap FSM gets armed (Idle → SigtermPending) but `child.wait()`
//! fires before any grace elapses, transitioning straight to Done.
//! Neither SIGTERM nor SIGKILL is sent.
//!
//! Guards against the regression "reap accidentally kills healthy CLIs"
//! — if a future change widens the arming guard or shortens grace to
//! zero, this test catches it via the exit-code check.
//!
//! See: https://github.com/vm0-ai/vm0/issues/10879

mod common;

use std::time::Duration;

#[tokio::test]
async fn post_result_reap_stays_silent_on_clean_exit() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // Keep post-result reap outside the 15s test timeout. If this
        // happy path returns successfully, it returned before the reap
        // deadline could fire. sigkill grace is unused on this path.
        common::setup_env(&mock, tmp.path(), "@exit-after-result", 60, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Happy path completes before the configured 60s post-result reap
    // grace. The 15s cap is only a hang guard, not a performance
    // assertion on fork/exec or async scheduling.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::new().unwrap(),
        ),
    )
    .await
    .expect("execute_cli did not return within 15s on the happy path");

    let result = result.expect("execute_cli returned Err");
    let exit_code = result.exit_code;

    // Clean exit(0) — if this is SIGTERM_EXIT / SIGKILL_EXIT, the
    // reap fired against a healthy CLI, which is a correctness bug.
    assert_eq!(
        exit_code,
        common::CLEAN_EXIT,
        "expected clean exit, got {exit_code} — reap may have killed a healthy CLI"
    );
    Ok(())
}
