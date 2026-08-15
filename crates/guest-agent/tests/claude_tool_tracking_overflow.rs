//! Claude tool tracking must terminate a stream that exceeds the bounded
//! watchdog state instead of retaining unmatched calls until run completion.

mod common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use serde_json::json;
use std::time::Duration;

// Keep this one above MAX_TRACKED_STUCK_TOOLS in cli::claude.rs. The stream is
// intentionally made of supported network tools so the tracker, rather than
// event delivery or the stuck-tool timeout, is the terminating condition.
const TRACKED_TOOL_CAPACITY_PLUS_ONE: usize = 257;

#[tokio::test]
async fn claude_tool_tracking_overflow_terminates_promptly()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut prompt_lines = vec!["@ECHO-HANG@".to_string()];
    prompt_lines.extend((0..TRACKED_TOOL_CAPACITY_PLUS_ONE).map(|index| {
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": format!("tracking-overflow-{index}"),
                    "name": "WebFetch",
                    "input": {}
                }]
            }
        })
        .to_string()
    }));

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt_lines.join("\n"), 1, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("tool tracking overflow should terminate promptly")?;

    let result = execution;
    let error = result
        .control_error
        .expect("tool tracking overflow should preserve a control error")
        .to_string();
    assert!(
        error.contains("Claude tool tracking capacity exceeded"),
        "unexpected tracking overflow error: {error}"
    );
    let termination = result
        .cli_termination
        .expect("tool tracking overflow should record process termination");
    assert_eq!(termination.reason, CliTerminationReason::StdoutIngestion);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));

    Ok(())
}
