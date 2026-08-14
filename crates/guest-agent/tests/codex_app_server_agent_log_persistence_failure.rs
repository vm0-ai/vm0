//! Post-open Codex agent-log failures must not fail an otherwise healthy run.

mod common;

use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn first_agent_log_write_failure_keeps_codex_run_successful()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let (mut gate, gated_mock) = common::PostOpenMockGate::create(tmp.path(), &mock)?;
    unsafe {
        common::setup_codex_app_server_env(
            &gated_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-agent-log-persistence-failure-test",
                prompt: "fail the first local event write",
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);

    tokio::select! {
        outcome = &mut execution => {
            return Err(format!("Codex execution completed before the mock gate opened: {outcome:?}").into());
        }
        ready = gate.wait_until_ready(Duration::from_secs(5)) => ready?,
    }

    let limit_guard = common::set_soft_file_size_limit(0)?;
    gate.release()?;
    let outcome = tokio::time::timeout(Duration::from_secs(5), &mut execution)
        .await
        .expect("Codex run should complete promptly after agent-log failure");
    limit_guard.restore()?;
    let execution = outcome?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());
    assert_eq!(std::fs::metadata(runtime.paths.agent_log_file())?.len(), 0);

    Ok(())
}
