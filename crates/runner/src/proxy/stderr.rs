//! Addon process-event parsing and mitmdump stderr re-emission.

use serde_json::{Map, Value};
use tracing::{error, warn};

const ADDON_PROCESS_EVENT_PREFIX: &str = "VM0_ADDON_EVENT ";
const ADDON_PROCESS_EVENT_VERSION: u8 = 1;
const MAX_ADDON_PROCESS_EVENT_BYTES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
enum AddonProcessEventLevel {
    Warn,
    Error,
}

#[derive(Debug, PartialEq, Eq)]
struct AddonProcessEvent {
    level: AddonProcessEventLevel,
    fields: Map<String, Value>,
}

fn parse_addon_process_event(line: &str) -> Option<AddonProcessEvent> {
    if line.len() > MAX_ADDON_PROCESS_EVENT_BYTES {
        return None;
    }
    let payload = line.strip_prefix(ADDON_PROCESS_EVENT_PREFIX)?;
    let mut fields = serde_json::from_str::<Map<String, Value>>(payload).ok()?;
    let version = fields.remove("version")?.as_u64()?;
    if version != u64::from(ADDON_PROCESS_EVENT_VERSION) {
        return None;
    }

    let level = match fields.get("level")?.as_str()? {
        "warn" => AddonProcessEventLevel::Warn,
        "error" => AddonProcessEventLevel::Error,
        _ => return None,
    };
    fields.get("message")?.as_str()?;
    Some(AddonProcessEvent { level, fields })
}

fn log_addon_process_event(event: AddonProcessEvent) {
    let encoded = Value::Object(event.fields).to_string();
    match event.level {
        AddonProcessEventLevel::Warn => warn!(
            target: "mitmdump_addon",
            message = encoded.as_str(),
        ),
        AddonProcessEventLevel::Error => error!(
            target: "mitmdump_addon",
            message = encoded.as_str(),
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

    fn emitted_log(event: &CapturedEvent) -> Value {
        let encoded = event
            .fields
            .get("message")
            .unwrap_or_else(|| panic!("missing message; event={event:#?}"));
        serde_json::from_str(encoded).expect("emitted log should be valid JSON")
    }

    #[test]
    fn parses_versioned_error_event() {
        let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"error","message":"Failed to write pending count","type":"usage_underbilling","reason":"pending_snapshot_write_failed","underbilling_class":"risk","retry_count":2,"retryable":true,"diagnostic":{"phase":"flush"},"future.field-name":["value",3]}"#,
        )
        .unwrap();

        assert_eq!(event.level, AddonProcessEventLevel::Error);
        assert_eq!(
            Value::Object(event.fields),
            serde_json::json!({
                "level": "error",
                "message": "Failed to write pending count",
                "type": "usage_underbilling",
                "reason": "pending_snapshot_write_failed",
                "underbilling_class": "risk",
                "retry_count": 2,
                "retryable": true,
                "diagnostic": {"phase": "flush"},
                "future.field-name": ["value", 3],
            })
        );
    }

    #[test]
    fn parses_versioned_warn_event() {
        let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"write failed"}"#,
        )
        .unwrap();

        assert_eq!(event.level, AddonProcessEventLevel::Warn);
        assert_eq!(event.fields["message"], serde_json::json!("write failed"));
    }

    #[test]
    fn rejects_unowned_or_invalid_envelopes() {
        for line in [
            "ordinary mitmdump warning",
            r#"prefix VM0_ADDON_EVENT {"version":1}"#,
            r#"VM0_ADDON_EVENT {"version":2,"level":"warn","message":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"info","message":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":42}"#,
            &format!(
                "VM0_ADDON_EVENT {{\"version\":1,\"level\":\"warn\",\"message\":\"{}\"}}",
                "x".repeat(MAX_ADDON_PROCESS_EVENT_BYTES)
            ),
        ] {
            assert!(
                parse_addon_process_event(line).is_none(),
                "unexpectedly parsed: {line}"
            );
        }
    }

    #[test]
    fn reemits_addon_error_with_opaque_log_record() {
        let message = "Failed to write pending count";
        let event = capture_mitmdump_stderr_log(
            r#"VM0_ADDON_EVENT {"version":1,"level":"error","message":"Failed to write pending count","type":"usage_underbilling","reason":"pending_snapshot_write_failed","underbilling_class":"risk","retry_count":2,"retryable":true,"diagnostic":{"phase":"flush"},"future.field-name":["value",3]}"#,
        );

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            emitted_log(&event),
            serde_json::json!({
                "level": "error",
                "message": message,
                "type": "usage_underbilling",
                "reason": "pending_snapshot_write_failed",
                "underbilling_class": "risk",
                "retry_count": 2,
                "retryable": true,
                "diagnostic": {"phase": "flush"},
                "future.field-name": ["value", 3],
            })
        );
        assert_eq!(event.fields.len(), 1, "unexpected fields: {event:#?}");
    }

    #[test]
    fn reemits_addon_warning_with_opaque_log_record() {
        let event = capture_mitmdump_stderr_log(
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"write failed"}"#,
        );

        assert_eq!(event.level, Level::WARN);
        assert_eq!(
            emitted_log(&event),
            serde_json::json!({"level": "warn", "message": "write failed"})
        );
        assert_eq!(event.fields.len(), 1, "unexpected fields: {event:#?}");
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
