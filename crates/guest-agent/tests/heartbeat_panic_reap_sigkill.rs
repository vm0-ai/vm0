//! End-to-end: heartbeat task panic must still reap a SIGTERM-deaf CLI
//! with SIGKILL before returning the panic error.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

mod common;

use guest_agent::error::AgentError;
use std::path::PathBuf;
use std::time::Duration;

async fn wait_for_marker(path: PathBuf) -> Result<(), AgentError> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if tokio::fs::metadata(&path).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| AgentError::Execution("mock did not ignore SIGTERM".to_string()))
}

#[tokio::test]
async fn heartbeat_panic_reap_escalates_to_sigkill_when_sigterm_ignored()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stuck-tool-deaf", 1, 1)?;
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let sigterm_ignored_marker = tmp.path().join(".vm0-mock-sigterm-ignored");
    let heartbeat = tokio::spawn(async move {
        wait_for_marker(sigterm_ignored_marker).await?;
        panic!("heartbeat panic for reap test")
    });

    // Budget: marker wait (up to 5s) + sigterm grace (1s, ignored)
    // + sigkill grace (1s, unignorable) + stdout drain (5s) + slack.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(&masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s - heartbeat panic reap likely broken");

    let err = match result {
        Ok(_) => return Err("heartbeat panic should fail the run".into()),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("heartbeat task panicked"),
        "expected heartbeat panic error, got {err}"
    );
    Ok(())
}
