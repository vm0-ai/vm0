//! Addon process-event parsing and mitmdump stderr re-emission.

use serde::Deserialize;
use tracing::{error, warn};

const ADDON_PROCESS_EVENT_PREFIX: &str = "VM0_ADDON_EVENT ";
const ADDON_PROCESS_EVENT_VERSION: u8 = 1;

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
    message: String,
}

fn parse_addon_process_event(line: &str) -> Option<AddonProcessEvent> {
    let payload = line.strip_prefix(ADDON_PROCESS_EVENT_PREFIX)?;
    let event: AddonProcessEvent = serde_json::from_str(payload).ok()?;
    if event.version != ADDON_PROCESS_EVENT_VERSION {
        return None;
    }

    Some(event)
}

fn log_addon_process_event(event: AddonProcessEvent) {
    match event.level {
        AddonProcessEventLevel::Warn => warn!(
            target: "mitmdump_addon",
            message = event.message.as_str(),
        ),
        AddonProcessEventLevel::Error => error!(
            target: "mitmdump_addon",
            message = event.message.as_str(),
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

    #[test]
    fn parses_versioned_error_event() {
        let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"error","message":"Failed to write pending count"}"#,
        )
        .unwrap();

        assert_eq!(
            event,
            AddonProcessEvent {
                version: 1,
                level: AddonProcessEventLevel::Error,
                message: "Failed to write pending count".to_string(),
            }
        );
    }

    #[test]
    fn parses_versioned_warn_event() {
        let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"write failed"}"#,
        )
        .unwrap();

        assert_eq!(event.level, AddonProcessEventLevel::Warn);
        assert_eq!(event.message, "write failed");
    }

    #[test]
    fn rejects_unowned_or_invalid_envelopes() {
        for line in [
            "ordinary mitmdump warning",
            r#"prefix VM0_ADDON_EVENT {"version":1}"#,
            r#"VM0_ADDON_EVENT {"version":2,"level":"warn","message":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"info","message":"failed"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn"}"#,
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"failed","extra":"unexpected"}"#,
        ] {
            assert!(
                parse_addon_process_event(line).is_none(),
                "unexpectedly parsed: {line}"
            );
        }
    }

    #[test]
    fn reemits_addon_error_without_adding_fields() {
        let message = "type=usage_underbilling reason=pending_snapshot_write_failed \
                       underbilling_class=risk component=mitm_addon Failed to write pending count";
        let event = capture_mitmdump_stderr_log(&format!(
            r#"VM0_ADDON_EVENT {{"version":1,"level":"error","message":"{message}"}}"#
        ));

        assert_eq!(event.level, Level::ERROR);
        assert_event_field(&event, "message", message);
        assert_eq!(event.fields.len(), 1, "unexpected fields: {event:#?}");
    }

    #[test]
    fn reemits_addon_warning_without_adding_fields() {
        let event = capture_mitmdump_stderr_log(
            r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"write failed"}"#,
        );

        assert_eq!(event.level, Level::WARN);
        assert_event_field(&event, "message", "write failed");
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
