use base64::Engine;
use guest_agent::{events::prepare_event_payload_for_run_id, masker::SecretMasker};
use serde_json::{Map, Value, json};
use std::{error::Error, time::Duration};

type TestResult = Result<(), Box<dyn Error>>;

fn masker_for(secrets: &[String]) -> SecretMasker {
    let raw = secrets
        .iter()
        .map(|secret| base64::engine::general_purpose::STANDARD.encode(secret))
        .collect::<Vec<_>>()
        .join(",");
    SecretMasker::from_raw(&raw)
}

fn blocked_decimal_secrets() -> Vec<String> {
    let mut secrets = vec!["token-alpha".to_string(), "token-bravo".to_string()];
    secrets.extend((1..=9).map(|digit| format!("***#{digit}")));
    secrets
}

async fn in_child_process(test_name: &str, check: impl FnOnce()) -> TestResult {
    const CHILD_CASE: &str = "GUEST_AGENT_MASKED_KEY_COLLISION_CASE";
    if std::env::var(CHILD_CASE).as_deref() == Ok(test_name) {
        check();
        return Ok(());
    }

    // Masking is synchronous: only a separate process can interrupt a stuck call.
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .args(["--exact", test_name, "--nocapture"])
        .env(CHILD_CASE, test_name)
        .kill_on_drop(true)
        .spawn()?;
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => assert!(status?.success(), "collision regression child failed"),
        Err(_) => {
            child.kill().await?;
            child.wait().await?;
            return Err("event preparation did not finish within the subprocess watchdog".into());
        }
    }
    Ok(())
}

#[tokio::test]
async fn event_preparation_finishes_when_every_decimal_suffix_is_secret() -> TestResult {
    in_child_process(
        "event_preparation_finishes_when_every_decimal_suffix_is_secret",
        || {
            let masker = masker_for(&blocked_decimal_secrets());
            let event = json!({
                "type": "assistant",
                "tool_input": {"token-alpha": "first value", "token-bravo": "second value"}
            });
            let payload = prepare_event_payload_for_run_id(event.clone(), 7, &masker, "test-run");

            assert_eq!(payload["runId"], "test-run");
            assert_eq!(payload["events"].as_array().unwrap().len(), 1);
            assert_eq!(payload["events"][0]["type"], "assistant");
            assert_eq!(payload["events"][0]["sequenceNumber"], 7);
            let input = payload["events"][0]["tool_input"].as_object().unwrap();
            assert_eq!(input.len(), 2);
            assert_eq!(input["***"], "first value");
            assert!(input.values().any(|value| value == "second value"));
            for key in input.keys() {
                assert_eq!(masker.mask_string(key), *key);
            }
            let mut reordered_secrets = blocked_decimal_secrets();
            reordered_secrets.reverse();
            let rebuilt_masker = masker_for(&reordered_secrets);
            assert_eq!(
                payload,
                prepare_event_payload_for_run_id(event, 7, &rebuilt_masker, "test-run")
            );
            let serialized = serde_json::to_string(&payload).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&serialized).unwrap(), payload);
        },
    )
    .await
}

#[tokio::test]
async fn event_preparation_preserves_reserved_fallback_keys_and_nested_values() -> TestResult {
    in_child_process(
        "event_preparation_preserves_reserved_fallback_keys_and_nested_values",
        || {
            let mut secrets = blocked_decimal_secrets();
            // Challenge both directions of the initially preferred Unicode transitions.
            secrets.extend([
                "\u{10000}\u{10001}".to_string(),
                "\u{10002}\u{10000}".to_string(),
                "sequenceNumber".to_string(),
            ]);
            secrets.extend((0..64).map(|index| format!("token-{index}")));
            let masker = masker_for(&secrets);
            let probe = prepare_event_payload_for_run_id(
                json!({
                    "type": "assistant",
                    "tool_input": {"token-alpha": 1, "token-bravo": 2}
                }),
                1,
                &masker,
                "test-run",
            );
            // Reserve actual generated keys as ordinary input to the next event.
            let mut reserved = Map::new();
            for key in probe["events"][0]["tool_input"].as_object().unwrap().keys() {
                assert_eq!(masker.mask_string(key), *key);
                reserved.insert(key.clone(), json!("reserved opaque key"));
            }
            reserved.insert("".to_string(), json!("reserved empty key"));
            reserved.insert("***#0".to_string(), json!("reserved numeric key"));
            let mut input = reserved.clone();
            for index in 0..64 {
                input.insert(format!("token-{index}"), json!(index));
            }
            input.insert(
                "nested".to_string(),
                json!([{
                    "token-alpha": "contains token-bravo here",
                    "token-bravo": {"sequenceNumber": "event-controlled"}
                }]),
            );
            let entry_count = input.len();
            let event = json!({"type": "assistant", "tool_input": input});
            let payload = prepare_event_payload_for_run_id(event.clone(), 42, &masker, "test-run");
            let masked_input = payload["events"][0]["tool_input"].as_object().unwrap();

            assert_eq!(masked_input.len(), entry_count);
            for (key, value) in reserved {
                assert_eq!(masked_input[&key], value);
            }
            let mut numbers = masked_input
                .values()
                .filter_map(Value::as_u64)
                .collect::<Vec<_>>();
            numbers.sort_unstable();
            assert_eq!(numbers, (0..64).collect::<Vec<_>>());
            for key in masked_input.keys() {
                assert_eq!(masker.mask_string(key), *key);
            }
            let nested = masked_input["nested"][0].as_object().unwrap();
            assert_eq!(nested.len(), 2);
            assert!(nested.values().any(|value| value == "contains *** here"));
            assert!(
                nested
                    .values()
                    .any(|value| value == &json!({"***": "event-controlled"}))
            );
            for key in nested.keys() {
                assert_eq!(masker.mask_string(key), *key);
            }
            assert_eq!(payload["events"][0]["sequenceNumber"], 42);
            assert_eq!(payload["runId"], "test-run");
            assert_eq!(
                payload,
                prepare_event_payload_for_run_id(event, 42, &masker, "test-run")
            );
        },
    )
    .await
}

#[tokio::test]
async fn event_preparation_keeps_ordinary_collision_suffixes() -> TestResult {
    in_child_process(
        "event_preparation_keeps_ordinary_collision_suffixes",
        || {
            let masker = masker_for(&["token-alpha".to_string(), "token-bravo".to_string()]);
            let payload = prepare_event_payload_for_run_id(
                json!({
                    "type": "assistant",
                    "tool_input": {
                        "***": "reserved base",
                        "***#2": "reserved suffix",
                        "token-alpha": {"token-bravo": "first"},
                        "token-bravo": "second"
                    }
                }),
                7,
                &masker,
                "test-run",
            );
            assert_eq!(
                payload,
                json!({
                    "runId": "test-run",
                    "events": [{
                        "type": "assistant",
                        "sequenceNumber": 7,
                        "tool_input": {
                            "***": "reserved base",
                            "***#2": "reserved suffix",
                            "***#3": {"***": "first"},
                            "***#4": "second"
                        }
                    }]
                })
            );
        },
    )
    .await
}
