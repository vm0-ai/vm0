//! End-to-end: CLI hangs after `type=result` AND ignores SIGTERM, so
//! the reap FSM must escalate to SIGKILL. Exercises Idle → SigtermPending
//! → SigkillPending → Done, which the main `post_result_reap` test
//! never reaches (default SIGTERM handler terminates its mock).
//!
//! This is the only coverage for the SigkillPending match arm and the
//! `libc::kill(-pid, SIGKILL)` call in `cli.rs`.
//!
//! See: https://github.com/vm0-ai/vm0/issues/10879

mod common;

use std::time::Duration;

#[tokio::test]
async fn post_result_reap_escalates_to_sigkill_when_sigterm_ignored()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // 1s sigterm (ignored by mock) + 1s sigkill (unignorable) → ~2s total.
        common::setup_env(&mock, tmp.path(), "@hang-after-result-deaf", 1, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Budget: sigterm (1s, ignored) + sigkill (1s, unignorable) +
    // stdout drain (5s) + slack = 15s.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(&masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s — sigkill escalation likely broken");

    let (exit_code, _stderr) = result.expect("execute_cli returned Err");

    // SIGKILL (9) → 128 + 9 = 137. SIGTERM is SIG_IGN'd in the mock,
    // so 143 here would mean our SIGTERM somehow won a race it can't
    // — or the mock isn't actually ignoring it (harness regression).
    assert_eq!(
        exit_code,
        common::SIGKILL_EXIT,
        "expected SIGKILL exit ({}), got {exit_code} — SigkillPending escalation path is not firing",
        common::SIGKILL_EXIT
    );
    Ok(())
}
