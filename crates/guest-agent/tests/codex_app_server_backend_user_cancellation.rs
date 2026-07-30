//! Explicit user cancellation must terminate a hung Codex app-server request.

mod common;

use std::time::Duration;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn codex_app_server_user_cancellation_interrupts_hung_turn_start()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-user-cancellation-test",
                prompt: "drive the app-server user cancellation path",
                scenario: Some("hang-on-turn-start"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_with_cancellation_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            cancellation,
        ),
    )
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "user cancellation did not interrupt the app-server request",
        )
    })??;

    assert_eq!(result.exit_code, 1);
    let error = result
        .control_error
        .as_ref()
        .ok_or_else(|| std::io::Error::other("user cancellation omitted its controlled error"))?;
    assert!(
        error.to_string().contains("Run cancelled by user"),
        "unexpected cancellation error: {error}"
    );
    let cli_termination = result.cli_termination.ok_or_else(|| {
        std::io::Error::other("user cancellation omitted its termination diagnostic")
    })?;
    assert_eq!(
        cli_termination.reason,
        CliTerminationReason::UserCancellation
    );

    Ok(())
}
