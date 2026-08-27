//! Pi CLI terminal results preserve error-message and aborted fallback
//! semantics through the guest's public event projection.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{AgentFramework, FailureDetailSource};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

async fn run_settlement_case(
    run_id: &str,
    assistant_message: &Value,
    expected_result: &str,
    base_path: &OsStr,
    original_directory: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let assistant_event_path = tmp.path().join("pi-assistant-event.jsonl");
    std::fs::write(
        &assistant_event_path,
        format!(
            "{}\n",
            serde_json::json!({
                "type": "message_end",
                "message": assistant_message,
            })
        ),
    )?;

    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":1,"sandboxEventSequenceStart":1}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111111\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}"
cat "$PI_ASSISTANT_EVENT_PATH"
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 23
fi
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
        std::env::set_var(guest_contracts::env::API_URL_ENV, &server.base_url);
        std::env::set_var(guest_contracts::env::API_TOKEN_ENV, "test-token");
        std::env::set_var(
            guest_contracts::env::SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV, "reused");
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir];
        paths.extend(std::env::split_paths(base_path));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "verify Pi terminal result".to_string(),
                pi_launch_config:
                    r#"{"schemaVersion":2,"apiFirstTurn":{"sandboxEventSequenceStart":1}}"#
                        .to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111111".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                (
                    "CLI_PKG_URL".to_string(),
                    "https://example.invalid/current-okou-cli.tgz".to_string(),
                ),
                (
                    "PI_ASSISTANT_EVENT_PATH".to_string(),
                    assistant_event_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = common::guest_runtime_from_process_env()?;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Pi CLI process timed out"))??;

    std::env::set_current_dir(original_directory)?;
    assert_eq!(result.exit_code, 1);
    assert_eq!(
        result.jsonl_result.map(|summary| summary.status),
        Some(guest_agent::cli::JsonlResultStatus::Error)
    );
    let terminal_failure = guest_agent::failure_diagnostics::cli_nonzero_failure_for_config(
        &runtime.config,
        None,
        &result,
    );
    assert_eq!(terminal_failure.diagnostic.framework, AgentFramework::Pi);
    assert_eq!(
        terminal_failure.diagnostic.failure_detail_source,
        Some(FailureDetailSource::PiResult)
    );
    assert_eq!(terminal_failure.diagnostic.claude_num_turns, None);
    assert_eq!(terminal_failure.diagnostic.failure_reason, None);

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    assert!(
        system_log.contains("Pi JSONL failure result"),
        "system log should attribute the result failure to Pi: {system_log}"
    );
    assert!(
        !system_log.contains("Claude JSONL failure result"),
        "system log should not attribute a Pi result failure to Claude: {system_log}"
    );

    let mut delivered_events = Vec::new();
    for request in server.requests()? {
        let body: Value = serde_json::from_str(&request.body)?;
        delivered_events.extend(
            body.get("events")
                .and_then(Value::as_array)
                .ok_or_else(|| std::io::Error::other("Pi event request omitted its events"))?
                .iter()
                .cloned(),
        );
    }
    let assistant = delivered_events
        .iter()
        .find(|event| event["type"] == "assistant")
        .ok_or_else(|| std::io::Error::other("assistant event was not delivered"))?;
    assert_eq!(
        assistant.pointer("/message/content/0/text"),
        Some(&Value::String("ignored assistant text".to_string()))
    );
    let terminal = delivered_events
        .iter()
        .find(|event| event["type"] == "result")
        .ok_or_else(|| std::io::Error::other("terminal result was not delivered"))?;
    assert_eq!(terminal["subtype"], "error_during_execution");
    assert_eq!(terminal["is_error"], true);
    assert_eq!(terminal["result"], expected_result);
    Ok(())
}

#[tokio::test]
async fn guest_preserves_pi_error_and_aborted_settlement_results()
-> Result<(), Box<dyn std::error::Error>> {
    let base_path = std::env::var_os("PATH").unwrap_or_default();
    let original_directory = std::env::current_dir()?;
    run_settlement_case(
        "00000000-0000-4000-8000-000000000124",
        &serde_json::json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "ignored assistant text" }],
            "model": "deepseek-v4-flash",
            "responseId": "response-error",
            "usage": {},
            "stopReason": "error",
            "errorMessage": "API Error: Overloaded",
            "timestamp": 1,
        }),
        "API Error: Overloaded",
        &base_path,
        &original_directory,
    )
    .await?;
    run_settlement_case(
        "00000000-0000-4000-8000-000000000125",
        &serde_json::json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "ignored assistant text" }],
            "model": "deepseek-v4-flash",
            "responseId": "response-aborted",
            "usage": {},
            "stopReason": "aborted",
            "errorMessage": "",
            "timestamp": 1,
        }),
        "Pi model turn aborted",
        &base_path,
        &original_directory,
    )
    .await?;
    Ok(())
}
