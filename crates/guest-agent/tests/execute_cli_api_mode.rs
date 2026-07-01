//! API-enabled `execute_cli` should capture session metadata from stdout events
//! while still delivering webhook events.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use httpmock::prelude::*;
use std::path::Path;
use std::time::Duration;

struct RunFilesGuard {
    paths: GuestPaths,
}

impl RunFilesGuard {
    fn new(paths: &GuestPaths) -> Self {
        cleanup_run_files(paths);
        Self {
            paths: paths.clone(),
        }
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files(&self.paths);
    }
}

fn cleanup_run_files(paths: &GuestPaths) {
    let _ = std::fs::remove_file(paths.agent_log_file());
    let _ = std::fs::remove_file(paths.event_error_flag());
    let _ = std::fs::remove_file(paths.session_id_file());
    let _ = std::fs::remove_file(paths.session_history_path_file());
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
}

unsafe fn setup_api_env(
    mock_path: &Path,
    workdir: &Path,
    api_url: &str,
    prompt: &str,
) -> Result<(), String> {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("VM0_MOCK_CLAUDE_PATH", mock_path);
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var("VM0_POST_RESULT_SIGTERM_GRACE_SECS", "3");
        std::env::set_var("VM0_POST_RESULT_SIGKILL_GRACE_SECS", "1");
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "execute-cli-api-mode-test".to_string());
        std::env::set_var("VM0_RUN_ID", run_id);
        std::env::set_var("VM0_PROMPT", prompt);
        std::env::set_var("VM0_API_URL", api_url);
        std::env::set_var("VM0_API_TOKEN", "test-token");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", workdir);
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}

#[tokio::test]
async fn api_mode_execute_cli_captures_session_metadata_and_sends_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();
    let session_id = "preview-filtered-user";
    let prompt = [
        "@ECHO@",
        r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"preview-filtered-user","tools":["Bash"],"model":"mock-claude"}"#,
        r#"{"type":"user","session_id":"preview-filtered-user","uuid":"unknown-user-replay","message":{"role":"user","content":"should-not-upload"},"parent_tool_use_id":null}"#,
        r#"{"type":"result","subtype":"success","session_id":"preview-filtered-user","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#,
        "",
    ]
    .join("\n");

    unsafe {
        setup_api_env(&mock_cli, tmp.path(), &server.base_url(), &prompt)?;
    }
    let runtime = GuestRuntime::from_process_env()?;
    let _run_files = RunFilesGuard::new(&runtime.paths);
    let expected_run_id = runtime.config.run_id.clone();
    unsafe {
        std::env::set_var("VM0_RUN_ID", "stale-run-id-after-runtime-construction");
    }

    let init_event = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(format!(r#""runId":"{expected_run_id}""#))
            .body_includes(r#""subtype":"init""#)
            .body_includes(r#""session_id":"***"#);
        then.status(200);
    });
    let result_event = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""type":"result""#);
        then.status(200);
    });
    let replayed_user_event = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""type":"user""#)
            .body_includes("should-not-upload");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        true,
        &runtime.config.prompt,
    );
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &masker,
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result.last_event_sequence,
        Some(1),
        "API mode should acknowledge the init and result events"
    );
    init_event.assert_calls_async(1).await;
    result_event.assert_calls_async(1).await;
    replayed_user_event.assert_calls_async(0).await;

    let captured_session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert_eq!(captured_session_id, session_id);
    let history_path = std::fs::read_to_string(runtime.paths.session_history_path_file())?;
    assert!(
        history_path.contains(session_id),
        "history path should contain the captured session id, got {history_path}"
    );

    Ok(())
}
