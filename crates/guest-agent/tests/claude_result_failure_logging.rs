//! Claude terminal result failures should be visible as bounded CLI diagnostics.
//!
//! This test lives in its own binary because `guest_agent::env` and
//! `guest_agent::paths` cache values in process-wide `LazyLock`s.

mod common;

use agent_diagnostics::FailureDetailSource;
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::path::Path;
use std::time::Duration;

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &Path) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

#[tokio::test]
async fn claude_error_result_is_written_to_system_log() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let system_log_path = tmp.path().join("system.log");
    let failure_reason = "permission denied while running command";

    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            &format!("printf '{failure_reason}'; exit 2"),
            3,
            1,
        )?;
    }

    let _system_log = SystemLogOverrideGuard::set(&system_log_path);
    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, 2);
    assert!(cli_result.stderr_lines.is_empty());
    assert_eq!(
        cli_result
            .failure_diagnostic
            .as_ref()
            .map(|diagnostic| diagnostic.message.as_str()),
        Some(failure_reason)
    );
    assert_eq!(
        cli_result
            .failure_diagnostic
            .as_ref()
            .map(|diagnostic| diagnostic.source),
        Some(FailureDetailSource::ClaudeResult)
    );

    let system_log = std::fs::read_to_string(&system_log_path)?;
    assert!(
        system_log.contains(
            "Claude JSONL failure result seq=4 subtype=error: permission denied while running command"
        ),
        "system log should include Claude JSONL failure reason: {system_log}"
    );

    Ok(())
}
