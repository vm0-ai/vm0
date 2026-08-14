//! Pi RPC extension failures must fail closed before buffered model events reach
//! the public webhook projection.

mod common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn checkpoint_failure_discards_buffered_public_events()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000456:pi:get-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"11111111-1111-4111-8111-111111111456"}}'
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000456:pi:initial-prompt","type":"response","command":"prompt","success":true}'
printf '%s\n' \
  '{"type":"extension_error","extensionPath":"vm0-runtime","event":"message_end","error":"forced SQLite checkpoint failure"}' \
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"uncheckpointed answer must stay private"}],"model":"deepseek-v4-flash","responseId":"response-uncheckpointed","usage":{"input":5,"output":3,"cacheRead":0,"cacheWrite":0},"stopReason":"stop","timestamp":1}}' \
  '{"type":"agent_settled"}'
# Keep the child alive while guest-agent drains the already-buffered records.
# The test shortens the normal termination grace, and guest-agent reaps this
# stopped process group with SIGKILL.
kill -STOP $$
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let run_id = "00000000-0000-4000-8000-000000000456";
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
        std::env::set_var(
            guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        );
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "force the Pi checkpoint failure".to_string(),
                pi_launch_config: r#"{"schemaVersion":1,"agentName":"Okou"}"#.to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111456".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([(
                "CLI_PKG_URL".to_string(),
                "https://example.invalid/current-okou-cli.tgz".to_string(),
            )]),
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
    .expect("Pi checkpoint failure should terminate promptly")?;
    assert!(result.control_error.as_ref().is_some_and(|error| {
        error
            .to_string()
            .contains("forced SQLite checkpoint failure")
    }));

    let agent_log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    assert!(agent_log.contains("forced SQLite checkpoint failure"));
    assert!(agent_log.contains("uncheckpointed answer must stay private"));
    assert!(agent_log.contains("agent_settled"));

    let mut delivered_events = Vec::new();
    for request in server.requests()? {
        let body: Value = serde_json::from_str(&request.body)?;
        delivered_events.extend(
            body.get("events")
                .and_then(Value::as_array)
                .expect("Pi event request should contain an events array")
                .iter()
                .cloned(),
        );
    }
    assert!(delivered_events.iter().all(|event| {
        !matches!(
            event.get("type").and_then(Value::as_str),
            Some("assistant" | "result")
        )
    }));
    assert!(
        delivered_events
            .iter()
            .all(|event| !event.to_string().contains("uncheckpointed answer"))
    );
    Ok(())
}
