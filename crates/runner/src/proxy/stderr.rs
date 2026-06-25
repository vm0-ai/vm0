//! Mitmdump stderr parsing and re-emission.

use tracing::{error, warn};

#[derive(Debug, PartialEq, Eq)]
struct MitmdumpUsageUnderbillingStderr<'a> {
    reason: &'a str,
    underbilling_class: &'a str,
    component: &'a str,
}

fn mitmdump_underbilling_fields(line: &str) -> Option<&str> {
    let mut rest = line.trim_start();

    while let Some(after_open) = rest.strip_prefix('[') {
        let Some(end) = after_open.find(']') else {
            break;
        };
        rest = after_open[end + 1..].trim_start();
    }

    for prefix in ["Addon error:", "error:", "ERROR:"] {
        if let Some(after_prefix) = rest.strip_prefix(prefix) {
            rest = after_prefix.trim_start();
            break;
        }
    }

    if rest.starts_with("type=") {
        Some(rest)
    } else {
        None
    }
}

fn parse_mitmdump_usage_underbilling_stderr(
    line: &str,
) -> Option<MitmdumpUsageUnderbillingStderr<'_>> {
    let fields = mitmdump_underbilling_fields(line)?;
    let mut tokens = fields.split_whitespace();
    let (key, value) = tokens.next()?.split_once('=')?;
    if key != "type" || value.trim_end_matches([',', ';']) != "usage_underbilling" {
        return None;
    }

    let mut reason = None;
    let mut underbilling_class = None;
    let mut component = None;

    for token in tokens {
        let Some((key, value)) = token.split_once('=') else {
            break;
        };
        let value = value.trim_end_matches([',', ';']);
        match key {
            "reason" => reason = Some(value),
            "underbilling_class" if value == "confirmed" || value == "risk" => {
                underbilling_class = Some(value);
            }
            "component" if !value.is_empty() => component = Some(value),
            _ => {}
        }
    }

    Some(MitmdumpUsageUnderbillingStderr {
        reason: reason?,
        underbilling_class: underbilling_class?,
        component: component?,
    })
}

pub(super) fn log_mitmdump_stderr_line(line: &str) {
    if let Some(signal) = parse_mitmdump_usage_underbilling_stderr(line) {
        error!(
            target: "mitmdump",
            r#type = "usage_underbilling",
            reason = signal.reason,
            underbilling_class = signal.underbilling_class,
            component = signal.component,
            mitmdump_stderr = %line,
            "mitmdump usage underbilling signal"
        );
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
    fn parse_mitmdump_usage_underbilling_stderr_extracts_fields() {
        let signal = parse_mitmdump_usage_underbilling_stderr(
            "[error] type=usage_underbilling reason=pending_snapshot_write_failed \
             underbilling_class=risk component=mitm_addon Failed to write pending count",
        )
        .unwrap();

        assert_eq!(
            signal,
            MitmdumpUsageUnderbillingStderr {
                reason: "pending_snapshot_write_failed",
                underbilling_class: "risk",
                component: "mitm_addon",
            }
        );
    }

    #[test]
    fn parse_mitmdump_usage_underbilling_stderr_allows_timestamped_error_prefix() {
        let signal = parse_mitmdump_usage_underbilling_stderr(
            "[12:34:56.789] [error] type=usage_underbilling \
             reason=pending_snapshot_write_failed underbilling_class=risk \
             component=mitm_addon Failed to write pending count",
        )
        .unwrap();

        assert_eq!(
            signal,
            MitmdumpUsageUnderbillingStderr {
                reason: "pending_snapshot_write_failed",
                underbilling_class: "risk",
                component: "mitm_addon",
            }
        );
    }

    #[test]
    fn parse_mitmdump_usage_underbilling_stderr_allows_mitmproxy_timestamp_prefix() {
        let signal = parse_mitmdump_usage_underbilling_stderr(
            "[12:34:56.789] type=usage_underbilling \
             reason=pending_snapshot_write_failed underbilling_class=risk \
             component=mitm_addon Failed to write pending count",
        )
        .unwrap();

        assert_eq!(
            signal,
            MitmdumpUsageUnderbillingStderr {
                reason: "pending_snapshot_write_failed",
                underbilling_class: "risk",
                component: "mitm_addon",
            }
        );
    }

    #[test]
    fn parse_mitmdump_usage_underbilling_stderr_ignores_regular_stderr() {
        assert!(parse_mitmdump_usage_underbilling_stderr("ordinary mitmdump warning").is_none());
        assert!(
            parse_mitmdump_usage_underbilling_stderr(
                "type=usage_underbilling reason=missing_fields"
            )
            .is_none()
        );
        assert!(
            parse_mitmdump_usage_underbilling_stderr(
                "ordinary stderr type=usage_underbilling reason=pending_snapshot_write_failed \
                 underbilling_class=risk component=mitm_addon"
            )
            .is_none()
        );
        assert!(
            parse_mitmdump_usage_underbilling_stderr(
                "url=https://example.test/?type=usage_underbilling \
                 reason=pending_snapshot_write_failed underbilling_class=risk component=mitm_addon"
            )
            .is_none()
        );
    }

    #[test]
    fn mitmdump_underbilling_stderr_reemits_structured_error() {
        let line = "[error] type=usage_underbilling reason=pending_snapshot_write_failed \
                    underbilling_class=risk component=mitm_addon Failed to write pending count";

        let event = capture_mitmdump_stderr_log(line);

        assert_eq!(event.level, Level::ERROR);
        assert_event_field(&event, "message", "mitmdump usage underbilling signal");
        assert_event_field(&event, "type", "usage_underbilling");
        assert_event_field(&event, "reason", "pending_snapshot_write_failed");
        assert_event_field(&event, "underbilling_class", "risk");
        assert_event_field(&event, "component", "mitm_addon");
        assert_event_field(&event, "mitmdump_stderr", line);
    }
}
