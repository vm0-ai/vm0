//! Oversized Codex app-server events must retain a bounded webhook
//! representation without changing the complete local normalized event.

mod common;

use base64::Engine as _;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-oversized-event-delivery-test";
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const SECRET: &str = "delivery-secret-value";
const DELIVERY_MARKER: &str = "bytes truncated for delivery";
const FALLBACK_MARKER: &str = "[event content truncated for delivery]";

#[tokio::test]
async fn codex_app_server_reduces_oversized_events_before_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: RUN_ID,
                prompt: "drive oversized app-server event delivery",
                scenario: Some("runtime-oversized-delivery"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var("VM0_API_BACKEND_URL", &server.base_url);
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        RUN_ID,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let _system_log = common::SystemLogOverrideGuard::set(runtime.paths.system_log_file());
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(SECRET);
    let masker = SecretMasker::from_raw(&encoded_secret);

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("oversized Codex delivery should finish promptly")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert_eq!(result.last_event_sequence, Some(11));

    server
        .wait_for_quiet(Duration::from_millis(50), Duration::from_secs(5))
        .await?;
    let requests = server
        .requests()?
        .into_iter()
        .filter(|request| request.path == "/api/webhooks/agent/events")
        .collect::<Vec<_>>();
    assert!(!requests.is_empty());
    assert!(
        requests
            .iter()
            .all(|request| request.body.len() <= MAX_REQUEST_BYTES)
    );

    let delivered = requests
        .iter()
        .map(|request| serde_json::from_str::<Value>(&request.body))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flat_map(|payload| {
            payload
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 12);
    assert!(
        delivered
            .iter()
            .all(|event| event.get("vm0_delivery").is_none())
    );
    assert!(
        requests
            .iter()
            .all(|request| !request.body.contains("[vm0:")
                && !request.body.contains("\"delivery_notice\""))
    );
    assert_eq!(
        delivered
            .iter()
            .map(|event| event["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        (0..12).map(Some).collect::<Vec<_>>()
    );

    for item_id in [
        "oversized-agent-message",
        "oversized-reasoning",
        "oversized-plan",
        "oversized-command",
        "oversized-file-change",
        "oversized-multi-change",
    ] {
        let event = delivered_item(&delivered, item_id)?;
        assert_eq!(event["item"]["id"], item_id);
        assert_eq!(event["type"], "item.completed");
    }

    let agent_message = delivered_item(&delivered, "oversized-agent-message")?;
    let agent_text = agent_message["item"]["text"]
        .as_str()
        .ok_or("reduced agent message omitted text")?;
    assert!(agent_text.starts_with("agent-head-***-"));
    assert!(agent_text.ends_with("-agent-tail"));
    assert!(agent_text.contains(DELIVERY_MARKER));
    assert!(!agent_text.contains(SECRET));
    assert_eq!(agent_message["item"]["type"], "agent_message");

    let reasoning = delivered_item(&delivered, "oversized-reasoning")?;
    assert_eq!(reasoning["item"]["type"], "reasoning");
    assert!(reasoning["item"]["text"].as_str().is_some_and(|text| {
        text.starts_with("reasoning-head-")
            && text.ends_with("-reasoning-tail")
            && text.contains(DELIVERY_MARKER)
    }));

    let plan = delivered_item(&delivered, "oversized-plan")?;
    assert_eq!(plan["item"]["type"], "plan");
    assert!(
        plan["item"]["text"]
            .as_str()
            .is_some_and(|text| text.starts_with("plan-head-")
                && text.ends_with("-plan-tail")
                && text.contains(DELIVERY_MARKER))
    );

    let command = delivered_item(&delivered, "oversized-command")?;
    assert_eq!(command["item"]["type"], "command_execution");
    assert_eq!(command["item"]["status"], "completed");
    assert_eq!(command["item"]["exit_code"], 0);
    assert!(command["item"]["command"].as_str().is_some_and(|text| {
        text.starts_with("command-head-***-")
            && text.ends_with("-command-tail")
            && text.contains(DELIVERY_MARKER)
    }));
    assert!(
        !command["item"]["command"]
            .as_str()
            .is_some_and(|text| text.contains("guest-tool-exec") || text.contains("vm0.command"))
    );
    assert!(
        command["item"]["aggregated_output"]
            .as_str()
            .is_some_and(|text| text.starts_with("output-head-***-")
                && text.ends_with("-output-tail")
                && text.contains(DELIVERY_MARKER))
    );
    let file_change = delivered_item(&delivered, "oversized-file-change")?;
    assert_eq!(file_change["item"]["type"], "file_change");
    assert_eq!(file_change["item"]["status"], "completed");
    assert_eq!(file_change["item"]["changes"][0]["path"], "large.txt");
    assert!(
        file_change["item"]["changes"][0]["diff"]
            .as_str()
            .is_some_and(|text| text.starts_with("diff-head-***-")
                && text.ends_with("-diff-tail")
                && text.contains(DELIVERY_MARKER))
    );

    let fallback_plan = delivered
        .iter()
        .find(|event| event["type"] == "turn.plan.updated")
        .ok_or("oversized plan update was not delivered")?;
    assert_eq!(fallback_plan["sequenceNumber"], 7);
    assert_eq!(
        fallback_plan["plan"],
        serde_json::json!([{
            "step": FALLBACK_MARKER,
            "status": "pending",
        }])
    );
    assert_eq!(fallback_plan["explanation"], FALLBACK_MARKER);

    let multi_change = delivered_items(&delivered, "oversized-multi-change");
    assert_eq!(multi_change.len(), 2);
    assert_eq!(
        multi_change
            .iter()
            .map(|event| event["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        vec![Some(8), Some(9)]
    );
    assert_eq!(
        multi_change
            .iter()
            .map(|event| event["item"]["changes"][0]["path"].as_str())
            .collect::<Vec<_>>(),
        vec![Some("structure-a.txt"), Some("structure-b.txt")]
    );
    for (event, (head, tail)) in multi_change.iter().zip([
        ("structure-a-head-***-", "-structure-a-tail"),
        ("structure-b-head-***-", "-structure-b-tail"),
    ]) {
        assert_eq!(event["item"]["type"], "file_change");
        assert_eq!(event["item"]["status"], "completed");
        assert_eq!(event["item"]["changes"].as_array().map(Vec::len), Some(1));
        assert_eq!(event["item"]["changes"][0]["kind"], "modify");
        assert!(
            event["item"]["changes"][0]["diff"]
                .as_str()
                .is_some_and(|text| text.starts_with(head)
                    && text.ends_with(tail)
                    && text.contains(DELIVERY_MARKER))
        );
    }

    let warning = delivered
        .iter()
        .find(|event| event["type"] == "warning")
        .ok_or("normal warning was not delivered")?;
    assert_eq!(warning["message"], "guest-mock-codex warning 999");
    assert!(warning.get("vm0_delivery").is_none());

    let local_events = read_jsonl(runtime.paths.agent_log_file())?;
    let local_agent = delivered_item(&local_events, "oversized-agent-message")?;
    let local_text = local_agent["item"]["text"]
        .as_str()
        .ok_or("local agent message omitted text")?;
    assert!(local_text.len() > MAX_REQUEST_BYTES);
    assert!(local_text.contains(SECRET));
    assert!(!local_text.contains(DELIVERY_MARKER));
    assert!(local_agent.get("vm0_delivery").is_none());
    let local_plan = local_events
        .iter()
        .find(|event| event["type"] == "turn.plan.updated")
        .ok_or("local oversized plan update was not recorded")?;
    assert_eq!(local_plan["plan"].as_array().map(Vec::len), Some(75_000));
    assert!(!serde_json::to_string(local_plan)?.contains(FALLBACK_MARKER));
    let local_multi_change = delivered_item(&local_events, "oversized-multi-change")?;
    assert_eq!(
        local_multi_change["item"]["changes"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    assert!(
        local_multi_change["item"]["changes"]
            .as_array()
            .is_some_and(|changes| changes.iter().all(|change| {
                change["diff"]
                    .as_str()
                    .is_some_and(|diff| diff.contains(SECRET) && !diff.contains(DELIVERY_MARKER))
            }))
    );

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    assert_eq!(
        system_log
            .matches("Codex event reduced for delivery")
            .count(),
        8
    );
    assert!(system_log.contains("event_type=turn.plan.updated"));
    assert!(system_log.contains("fallback=true"));
    assert!(!system_log.contains(SECRET));
    assert!(!system_log.contains("agent-head"));
    assert!(!system_log.contains("large.txt"));

    Ok(())
}

fn delivered_item<'a>(events: &'a [Value], item_id: &str) -> Result<&'a Value, String> {
    events
        .iter()
        .find(|event| event.pointer("/item/id").and_then(Value::as_str) == Some(item_id))
        .ok_or_else(|| format!("missing item {item_id}"))
}

fn delivered_items<'a>(events: &'a [Value], item_id: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event.pointer("/item/id").and_then(Value::as_str) == Some(item_id))
        .collect()
}

fn read_jsonl(path: &str) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    std::fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
