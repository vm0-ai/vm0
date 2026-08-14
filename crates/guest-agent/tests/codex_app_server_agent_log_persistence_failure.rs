//! Post-open Codex agent-log failures must terminate the app-server child.

mod common;

use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn first_agent_log_write_failure_fails_codex_execution_promptly()
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
        .expect("agent-log persistence failure should terminate Codex promptly");
    limit_guard.restore()?;
    let error = outcome.expect_err("Codex execution must not succeed without its local event log");

    match error {
        AgentError::Io(error) => assert_eq!(error.raw_os_error(), Some(libc::EFBIG)),
        other => {
            return Err(format!("expected EFBIG from Codex agent-log write, got {other}").into());
        }
    }
    assert_eq!(std::fs::metadata(runtime.paths.agent_log_file())?.len(), 0);

    Ok(())
}
