//! Post-open Claude agent-log failures must terminate and reap the live child.

mod common;

use guest_agent::error::AgentError;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

const RAW_RECORD: &str = r#"{"type":"test"}"#;

#[tokio::test]
async fn agent_log_delimiter_failure_terminates_live_claude_process()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let (mut gate, gated_mock) = common::PostOpenMockGate::create(tmp.path(), &mock)?;
    let prompt = format!("@ECHO-HANG@\n{RAW_RECORD}\n{RAW_RECORD}");
    unsafe {
        common::setup_env(&gated_mock, tmp.path(), &prompt, 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);

    tokio::select! {
        outcome = &mut execution => {
            return Err(format!("CLI execution completed before the mock gate opened: {outcome:?}").into());
        }
        ready = gate.wait_until_ready(Duration::from_secs(5)) => ready?,
    }

    let limit = u64::try_from(RAW_RECORD.len())?;
    let limit_guard = common::set_soft_file_size_limit(limit)?;
    gate.release()?;
    let outcome = match tokio::time::timeout(Duration::from_secs(5), &mut execution).await {
        Ok(outcome) => outcome,
        Err(_) => {
            let log = std::fs::read(runtime.paths.agent_log_file())?;
            return Err(format!(
                "agent-log persistence failure did not terminate promptly; log_len={} log={:?}",
                log.len(),
                String::from_utf8_lossy(&log)
            )
            .into());
        }
    };
    limit_guard.restore()?;
    let execution = outcome?;

    match execution.control_error.as_ref() {
        Some(AgentError::Io(error)) => {
            assert_eq!(error.raw_os_error(), Some(libc::EFBIG));
        }
        other => return Err(format!("expected controlled EFBIG error, got {other:?}").into()),
    }
    let termination = execution
        .cli_termination
        .as_ref()
        .ok_or("agent-log failure omitted termination diagnostics")?;
    assert_eq!(termination.reason, CliTerminationReason::StdoutIngestion);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));
    assert_eq!(execution.last_event_sequence, None);
    assert_eq!(
        std::fs::read(runtime.paths.agent_log_file())?,
        RAW_RECORD.as_bytes()
    );

    Ok(())
}
