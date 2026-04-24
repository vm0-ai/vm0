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

use std::time::{Duration, Instant};

#[tokio::test]
async fn post_result_reap_stays_silent_on_clean_exit() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // 3s sigterm grace gives cold-CI fork+exec jitter a wide
        // buffer below the 1s elapsed bound asserted below. sigkill
        // grace is unused on this path (reap never fires at all).
        common::setup_env(&mock, tmp.path(), "@exit-after-result", 3, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Happy path completes in milliseconds (mock exits immediately
    // after emitting result). A generous 15s cap ensures flakes on
    // loaded CI still flag as "took too long", distinguishing from
    // "did not return at all".
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(&masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s on the happy path");
    let elapsed = started.elapsed();

    let (exit_code, _stderr) = result.expect("execute_cli returned Err");

    // Clean exit(0) — if this is SIGTERM_EXIT / SIGKILL_EXIT, the
    // reap fired against a healthy CLI, which is a correctness bug.
    assert_eq!(
        exit_code,
        common::CLEAN_EXIT,
        "expected clean exit, got {exit_code} — reap may have killed a healthy CLI"
    );
    // With sigterm grace = 3s, a reap that mistakenly fires would
    // push elapsed to ≥3s. Any value well under that proves the
    // deadline branch didn't execute. 1s cap gives two seconds of
    // headroom over the tightest imaginable signal path while still
    // easily accommodating a cold fork+exec on slow CI.
    assert!(
        elapsed < Duration::from_secs(1),
        "happy path took {elapsed:?}; reap deadline may have fired"
    );
    Ok(())
}
