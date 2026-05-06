//! End-to-end: heartbeat failure must still reap a SIGTERM-deaf CLI
//! with SIGKILL before returning the heartbeat error.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

mod common;

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
    let heartbeat = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if tokio::fs::metadata(&sigterm_ignored_marker).await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
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
        guest_agent::cli::execute_cli(&masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s - heartbeat reap escalation likely broken");

    let err = match result {
        Ok(_) => return Err("heartbeat failure should fail the run".into()),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("heartbeat failed for reap test"),
        "expected heartbeat error, got {err}"
    );
    Ok(())
}
