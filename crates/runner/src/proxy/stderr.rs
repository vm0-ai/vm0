//! Addon process-event parsing and mitmdump stderr re-emission.

use serde::Deserialize;
use std::collections::BTreeMap;
use tracing::{error, warn};

const ADDON_PROCESS_EVENT_PREFIX: &str = "VM0_ADDON_EVENT ";
const ADDON_PROCESS_EVENT_VERSION: u8 = 1;
const MAX_ADDON_PROCESS_EVENT_FIELDS: usize = 16;
const MAX_ADDON_PROCESS_EVENT_FIELD_VALUE_CHARS: usize = 256;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AddonProcessEventLevel {
    Warn,
    Error,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AddonProcessEvent {
    version: u8,
    level: AddonProcessEventLevel,
    #[serde(rename = "type")]
    event_type: String,
    reason: String,
    component: String,
    fields: BTreeMap<String, String>,
    detail: String,
}

fn is_event_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && value.len() <= 80
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn parse_addon_process_event(line: &str) -> Option<AddonProcessEvent> {
    let payload = line.strip_prefix(ADDON_PROCESS_EVENT_PREFIX)?;
    let event: AddonProcessEvent = serde_json::from_str(payload).ok()?;
    if event.version != ADDON_PROCESS_EVENT_VERSION
        || event.component != "mitm_addon"
        || !is_event_name(&event.event_type)
        || !is_event_name(&event.reason)
        || event.fields.len() > MAX_ADDON_PROCESS_EVENT_FIELDS
        || event.fields.iter().any(|(name, value)| {
            !is_event_name(name)
                || value.chars().count() > MAX_ADDON_PROCESS_EVENT_FIELD_VALUE_CHARS
        })
    {
        return None;
    }

    Some(event)
}

fn log_addon_process_event(event: AddonProcessEvent) {
    let axiom_fields = serde_json::Value::Object(
        event
            .fields
            .into_iter()
            .map(|(name, value)| (name, serde_json::Value::String(value)))
            .collect(),
    )
    .to_string();
    match event.level {
        AddonProcessEventLevel::Warn => warn!(
            target: "mitmdump_addon",
            r#type = event.event_type,
            reason = event.reason,
            component = event.component,
            axiom_fields = axiom_fields.as_str(),
            addon_detail = event.detail,
            "mitmdump addon process event"
        ),
        AddonProcessEventLevel::Error => error!(
            target: "mitmdump_addon",
            r#type = event.event_type,
            reason = event.reason,
            component = event.component,
            axiom_fields = axiom_fields.as_str(),
            addon_detail = event.detail,
            "mitmdump addon process event"
        ),
    }
}

pub(super) fn log_mitmdump_stderr_line(line: &str) {
    if let Some(event) = parse_addon_process_event(line) {
        log_addon_process_event(event);
        return;
    }

    warn!(target: "mitmdump", "stderr: {line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    fn capture_mitmdump_stderr_log(line: &str) -> CapturedEvent {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            log_mitmdump_stderr_line(line);
        });
        let events = captured.entries();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        events[0].clone()
    }

    fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
    }

    fn assert_axiom_fields(event: &CapturedEvent, expected: BTreeMap<String, String>) {
        let encoded = event
            .fields
            .get("axiom_fields")
            .unwrap_or_else(|| panic!("missing axiom_fields; event={event:#?}"));
        let actual: BTreeMap<String, String> =
            serde_json::from_str(encoded).expect("axiom_fields should be valid JSON");
        assert_eq!(actual, expected);
    }

    #[test]
    fn parses_versioned_underbilling_event() {
        let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"error","type":"usage_underbilling","reason":"pending_snapshot_write_failed","component":"mitm_addon","fields":{"underbilling_class":"risk","counter":"reports"},"detail":"Failed to write pending count"}"#,
        )
        .unwrap();

        assert_eq!(
            event,
            AddonProcessEvent {
                version: 1,
                level: AddonProcessEventLevel::Error,
                event_type: "usage_underbilling".to_string(),
                reason: "pending_snapshot_write_failed".to_string(),
                component: "mitm_addon".to_string(),
                fields: BTreeMap::from([
                    ("counter".to_string(), "reports".to_string()),
                    ("underbilling_class".to_string(), "risk".to_string()),
                ]),
                detail: "Failed to write pending count".to_string(),
            }
        );
    }

    #[test]
    fn parses_process_integrity_event() {
        let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","type":"addon_process_integrity","reason":"jsonl_writer_append_failed","component":"mitm_addon","fields":{},"detail":"write failed"}"#,
        )
        .unwrap();

        assert_eq!(event.level, AddonProcessEventLevel::Warn);
        assert_eq!(event.event_type, "addon_process_integrity");
        assert_eq!(event.reason, "jsonl_writer_append_failed");
        assert_eq!(event.detail, "write failed");
    }

    #[test]
    fn rejects_unowned_or_invalid_envelopes() {
        for line in [
            "ordinary mitmdump warning",
            r#"prefix VM0_ADDON_EVENT {"version":1}"#,
            r#"VM0_ADDON_EVENT {"version":2,"level":"warn","type":"addon_process_integrity","reason":"test_failure","component":"mitm_addon","fields":{},"detail":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","type":"addon_process_integrity","reason":"test_failure","component":"other","fields":{},"detail":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","type":"bad type","reason":"test_failure","component":"mitm_addon","fields":{},"detail":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","type":"addon_process_integrity","reason":"test_failure","component":"mitm_addon","fields":{"bad field":"value"},"detail":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","type":"addon_process_integrity","reason":"test_failure","component":"mitm_addon","fields":{},"extra":"unexpected","detail":"failed"}"#,
        ] {
            assert!(
                parse_addon_process_event(line).is_none(),
                "unexpectedly parsed: {line}"
            );
        }
    }

    #[test]
    fn reemits_underbilling_as_structured_error() {
        let event = capture_mitmdump_stderr_log(
            r#"VM0_ADDON_EVENT {"version":1,"level":"error","type":"usage_underbilling","reason":"pending_snapshot_write_failed","component":"mitm_addon","fields":{"underbilling_class":"risk"},"detail":"Failed to write pending count"}"#,
        );

        assert_eq!(event.level, Level::ERROR);
        assert_event_field(&event, "message", "mitmdump addon process event");
        assert_event_field(&event, "type", "usage_underbilling");
        assert_event_field(&event, "reason", "pending_snapshot_write_failed");
        assert_event_field(&event, "component", "mitm_addon");
        assert_event_field(&event, "addon_detail", "Failed to write pending count");
        assert_axiom_fields(
            &event,
            BTreeMap::from([("underbilling_class".to_string(), "risk".to_string())]),
        );
    }

    #[test]
    fn reemits_process_integrity_as_structured_warn() {
        let event = capture_mitmdump_stderr_log(
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","type":"addon_process_integrity","reason":"jsonl_writer_append_failed","component":"mitm_addon","fields":{},"detail":"write failed"}"#,
        );

        assert_eq!(event.level, Level::WARN);
        assert_event_field(&event, "type", "addon_process_integrity");
        assert_event_field(&event, "reason", "jsonl_writer_append_failed");
        assert_event_field(&event, "component", "mitm_addon");
        assert_event_field(&event, "addon_detail", "write failed");
        assert_axiom_fields(&event, BTreeMap::new());
    }

    #[test]
    fn malformed_envelope_uses_ordinary_stderr_path() {
        let line = "VM0_ADDON_EVENT not-json";
        let event = capture_mitmdump_stderr_log(line);

        assert_eq!(event.level, Level::WARN);
        assert_event_field(&event, "message", &format!("stderr: {line}"));
        assert!(!event.fields.contains_key("type"));
    }
}
