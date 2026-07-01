//! Heartbeat race coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use std::path::PathBuf;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_heartbeat_interrupts_hung_turn_start()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-heartbeat-test",
                prompt: "drive the app-server backend heartbeat path",
                scenario: Some("hang-on-turn-start"),
                resume_session_id: None,
            },
        )?;
    }
    let _run_files = common::RunFilesGuard::new();
    let runtime = common::guest_runtime_from_process_env()?;
    let session_id_path = PathBuf::from(runtime.paths.session_id_file());
    if let Some(parent) = session_id_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let heartbeat = common::spawn_heartbeat_monitor(async move {
        common::wait_for_path(&session_id_path, Duration::from_secs(5))
            .await
            .map_err(|error| {
                AgentError::Execution(format!("wait for app-server thread start: {error}"))
            })?;
        Err(AgentError::Execution(
            "heartbeat failed during app-server turn/start".to_string(),
        ))
    });

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_millis(1500),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli should return promptly");

    let error = result.expect_err("heartbeat failure should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("heartbeat failed during app-server turn/start"),
        "unexpected error: {message}"
    );

    Ok(())
}
