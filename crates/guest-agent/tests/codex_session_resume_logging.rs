//! Codex session-resume marker logging should not expose session identifiers.
//!
//! This test lives in its own binary because `SystemLogOverrideGuard` configures
//! a process-global system log sink.

mod common;

use common::SystemLogOverrideGuard;
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::path::PathBuf;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct CodexResumeLogFixture {
    home: tempfile::TempDir,
    run_id: String,
    runtime_dir: PathBuf,
    paths: guest_agent::paths::GuestPaths,
}

impl CodexResumeLogFixture {
    fn new() -> TestResult<Self> {
        let home = tempfile::Builder::new()
            .prefix("codex-resume-log-home-")
            .tempdir()?;
        let home_name = home
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "unknown".to_string());
        let run_id_suffix = home_name
            .strip_prefix("codex-resume-log-home-")
            .unwrap_or(&home_name);
        let run_id = format!("codex-resume-log-{run_id_suffix}");
        let runtime_dir = home
            .path()
            .join(".vm0")
            .join("guest-agent")
            .join("runs")
            .join(&run_id);
        let paths = guest_agent::paths::GuestPaths::from_runtime_dir(&runtime_dir);

        Ok(Self {
            home,
            run_id,
            runtime_dir,
            paths,
        })
    }

    fn config(&self) -> TestResult<guest_agent::env::GuestConfig> {
        let run_payload_file = common::write_run_payload_file_for_test(
            &self.runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "test prompt".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )
        .map_err(std::io::Error::other)?;
        let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
            run_id: self.run_id.clone(),
            api_url: "http://127.0.0.1:1".to_string(),
            api_token: "".to_string(),
            sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
            sandbox_reuse_result: "reused".to_string(),
            cli_agent_type: "codex".to_string(),
            home: Some(self.home.path().to_string_lossy().into_owned()),
            run_payload_file: run_payload_file.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(self.runtime_dir.clone()),
            ..Default::default()
        })
        .map_err(std::io::Error::other)?;
        Ok(config)
    }

    fn send_event(&self, event: serde_json::Value, masker: &SecretMasker) -> TestResult {
        let config = self.config()?;
        let http = guest_agent::http::HttpClient::for_config(&config)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(guest_agent::events::send_event_for_config(
            &http,
            event,
            1,
            masker,
            &config,
            &self.paths,
        ))?;
        Ok(())
    }
}

#[test]
fn codex_session_marker_log_does_not_leak_thread_id_or_marker_payload() -> TestResult {
    let fixture = CodexResumeLogFixture::new()?;
    let log_dir = tempfile::tempdir()?;
    let system_log_path = log_dir.path().join("system.log");
    let system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": thread_id
    });

    fixture.send_event(event, &masker)?;

    let marker = std::fs::read_to_string(fixture.paths.session_history_path_file())?;
    drop(system_log_guard);
    let system_log = std::fs::read_to_string(&system_log_path)?;
    assert!(
        system_log.contains("Session history marker written to"),
        "system log should confirm marker creation, got: {system_log}"
    );
    assert!(
        !system_log.contains(thread_id),
        "system log must not contain the raw thread id, got: {system_log}"
    );
    assert!(
        !system_log.contains("CODEX_SEARCH"),
        "system log must not contain the codex marker payload, got: {system_log}"
    );
    assert!(
        !system_log.contains(&marker),
        "system log must not contain the full marker payload, got: {system_log}"
    );
    Ok(())
}
