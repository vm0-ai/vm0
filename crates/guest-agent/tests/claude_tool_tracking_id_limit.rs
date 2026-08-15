//! Claude tool tracking must reject an oversized supported tool-use ID before
//! retaining it in the watchdog state.

mod common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use serde_json::json;
use std::time::Duration;

const OVERSIZED_TOOL_ID_BYTES: usize = 1025;

#[tokio::test]
async fn oversized_watchdog_tool_id_terminates_promptly() -> Result<(), Box<dyn std::error::Error>>
{
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let prompt = [
        "@ECHO-HANG@".to_string(),
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "x".repeat(OVERSIZED_TOOL_ID_BYTES),
                    "name": "WebFetch",
                    "input": {}
                }]
            }
        })
        .to_string(),
    ]
    .join("\n");

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 1, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("oversized tool-use ID should terminate promptly")?;

    let error = execution
        .control_error
        .expect("oversized tool-use ID should preserve a control error")
        .to_string();
    assert!(
        error.contains("Claude tool tracking rejected a tool-use ID larger than 1024 bytes"),
        "unexpected tool ID limit error: {error}"
    );
    let termination = execution
        .cli_termination
        .expect("oversized tool-use ID should record process termination");
    assert_eq!(termination.reason, CliTerminationReason::StdoutIngestion);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));

    Ok(())
}
