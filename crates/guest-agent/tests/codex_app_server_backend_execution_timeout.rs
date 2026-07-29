//! The runner-owned execution deadline must interrupt and explicitly terminate
//! a hung Codex app-server request.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationReason};
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_execution_timeout_interrupts_hung_turn_start()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-execution-timeout-test",
                prompt: "drive the app-server execution timeout path",
                scenario: Some("hang-on-turn-start"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV, "1");
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execution deadline did not interrupt the app-server request")?;

    assert_eq!(result.exit_code, AGENT_EXECUTION_TIMEOUT_EXIT_CODE);
    let error = result
        .control_error
        .as_ref()
        .expect("execution timeout should preserve a controlled error");
    assert!(
        error
            .to_string()
            .contains("Agent execution timed out after 1 seconds"),
        "unexpected timeout error: {error}"
    );
    assert_eq!(
        result
            .cli_termination
            .expect("execution timeout should attach termination diagnostics")
            .reason,
        CliTerminationReason::ExecutionTimeout
    );

    Ok(())
}
