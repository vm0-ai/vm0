//! Mitmdump stderr parsing and re-emission.

use tracing::{error, warn};

use crate::ids::RunId;

const ANTHROPIC_INCOMPLETE_ACCOUNTING_REASON: &str = "anthropic_sse_incomplete_compressed_body";
const ANTHROPIC_MESSAGES_SSE_PROTOCOL: &str = "anthropic_messages_sse";
const INCOMPLETE_COMPRESSED_BODY_REASON: &str = "incomplete_compressed_body";

#[derive(Debug, PartialEq, Eq)]
struct MitmdumpUsageUnderbillingStderr<'a> {
    reason: &'a str,
    underbilling_class: &'a str,
    component: &'a str,
    counter: Option<&'a str>,
    run_id: Option<&'a str>,
    usage_protocol: Option<&'a str>,
    decoder_reason: Option<&'a str>,
    accounting_status: Option<&'a str>,
}

fn canonical_run_id(value: &str) -> Option<&str> {
    let parsed = value.parse::<RunId>().ok()?;
    (parsed.to_string() == value).then_some(value)
}

fn anthropic_accounting_status(value: &str) -> Option<&str> {
    matches!(
        value,
        "no_recoverable_usage" | "recovered_partial" | "recovered_terminal"
    )
    .then_some(value)
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
    let mut counter = None;
    let mut run_id = None;
    let mut usage_protocol = None;
    let mut decoder_reason = None;
    let mut accounting_status = None;

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
            "counter" if !value.is_empty() => counter = Some(value),
            "run_id" => run_id = canonical_run_id(value),
            "usage_protocol" => {
                usage_protocol = (value == ANTHROPIC_MESSAGES_SSE_PROTOCOL).then_some(value);
            }
            "decoder_reason" => {
                decoder_reason = (value == INCOMPLETE_COMPRESSED_BODY_REASON).then_some(value);
            }
            "accounting_status" => {
                accounting_status = anthropic_accounting_status(value);
            }
            _ => {}
        }
    }

    Some(MitmdumpUsageUnderbillingStderr {
        reason: reason?,
        underbilling_class: underbilling_class?,
        component: component?,
        counter,
        run_id,
        usage_protocol,
        decoder_reason,
        accounting_status,
    })
}

pub(super) fn log_mitmdump_stderr_line(line: &str) {
    if let Some(signal) = parse_mitmdump_usage_underbilling_stderr(line) {
        let anthropic_accounting_fields = (
            signal.reason == ANTHROPIC_INCOMPLETE_ACCOUNTING_REASON,
            signal.run_id,
            signal.usage_protocol,
            signal.decoder_reason,
            signal.accounting_status,
        );
        if let (true, Some(run_id), Some(usage_protocol), Some(decoder_reason), Some(status)) =
            anthropic_accounting_fields
        {
            if let Some(counter) = signal.counter {
                error!(
                    target: "mitmdump",
                    r#type = "usage_underbilling",
                    reason = signal.reason,
                    underbilling_class = signal.underbilling_class,
                    component = signal.component,
                    counter = counter,
                    run_id = run_id,
                    usage_protocol = usage_protocol,
                    decoder_reason = decoder_reason,
                    accounting_status = status,
                    mitmdump_stderr = %line,
                    "mitmdump usage underbilling signal"
                );
            } else {
                error!(
                    target: "mitmdump",
                    r#type = "usage_underbilling",
                    reason = signal.reason,
                    underbilling_class = signal.underbilling_class,
                    component = signal.component,
                    run_id = run_id,
                    usage_protocol = usage_protocol,
                    decoder_reason = decoder_reason,
                    accounting_status = status,
                    mitmdump_stderr = %line,
                    "mitmdump usage underbilling signal"
                );
            }
            return;
        }
        if let Some(counter) = signal.counter {
            error!(
                target: "mitmdump",
                r#type = "usage_underbilling",
                reason = signal.reason,
                underbilling_class = signal.underbilling_class,
                component = signal.component,
                counter = counter,
                mitmdump_stderr = %line,
                "mitmdump usage underbilling signal"
            );
        } else {
            error!(
                target: "mitmdump",
                r#type = "usage_underbilling",
                reason = signal.reason,
                underbilling_class = signal.underbilling_class,
                component = signal.component,
                mitmdump_stderr = %line,
                "mitmdump usage underbilling signal"
            );
        }
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
                counter: None,
                run_id: None,
                usage_protocol: None,
                decoder_reason: None,
                accounting_status: None,
            }
        );
    }

    #[test]
    fn parse_mitmdump_usage_underbilling_stderr_extracts_counter() {
        let signal = parse_mitmdump_usage_underbilling_stderr(
            "[error] type=usage_underbilling reason=usage_pending_counter_underflow \
             underbilling_class=risk component=mitm_addon counter=reports unmatched release",
        )
        .unwrap();

        assert_eq!(
            signal,
            MitmdumpUsageUnderbillingStderr {
                reason: "usage_pending_counter_underflow",
                underbilling_class: "risk",
                component: "mitm_addon",
                counter: Some("reports"),
                run_id: None,
                usage_protocol: None,
                decoder_reason: None,
                accounting_status: None,
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
                counter: None,
                run_id: None,
                usage_protocol: None,
                decoder_reason: None,
                accounting_status: None,
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
                counter: None,
                run_id: None,
                usage_protocol: None,
                decoder_reason: None,
                accounting_status: None,
            }
        );
    }

    #[test]
    fn parse_mitmdump_usage_underbilling_stderr_extracts_anthropic_accounting_fields() {
        let signal = parse_mitmdump_usage_underbilling_stderr(
            "[error] type=usage_underbilling \
             reason=anthropic_sse_incomplete_compressed_body underbilling_class=risk \
             component=mitm_addon accounting_status=recovered_partial \
             decoder_reason=incomplete_compressed_body \
             run_id=00000000-0000-0000-0000-000000025133 \
             usage_protocol=anthropic_messages_sse Incomplete Anthropic SSE accounting",
        )
        .unwrap();

        assert_eq!(
            signal,
            MitmdumpUsageUnderbillingStderr {
                reason: "anthropic_sse_incomplete_compressed_body",
                underbilling_class: "risk",
                component: "mitm_addon",
                counter: None,
                run_id: Some("00000000-0000-0000-0000-000000025133"),
                usage_protocol: Some("anthropic_messages_sse"),
                decoder_reason: Some("incomplete_compressed_body"),
                accounting_status: Some("recovered_partial"),
            }
        );
    }

    #[test]
    fn parse_mitmdump_usage_underbilling_stderr_rejects_unbounded_accounting_values() {
        let signal = parse_mitmdump_usage_underbilling_stderr(
            "type=usage_underbilling reason=anthropic_sse_incomplete_compressed_body \
             underbilling_class=risk component=mitm_addon \
             run_id=not-a-canonical-run-id usage_protocol=unknown \
             decoder_reason=provider-controlled accounting_status=almost-complete message",
        )
        .unwrap();

        assert_eq!(signal.run_id, None);
        assert_eq!(signal.usage_protocol, None);
        assert_eq!(signal.decoder_reason, None);
        assert_eq!(signal.accounting_status, None);
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
        assert!(
            !event.fields.contains_key("counter"),
            "unexpected counter field; event={event:#?}"
        );
        for field in [
            "run_id",
            "usage_protocol",
            "decoder_reason",
            "accounting_status",
        ] {
            assert!(
                !event.fields.contains_key(field),
                "unexpected {field} field; event={event:#?}"
            );
        }
    }

    #[test]
    fn mitmdump_underbilling_stderr_reemits_counter_when_present() {
        let line = "[error] type=usage_underbilling \
                    reason=usage_pending_counter_underflow underbilling_class=risk \
                    component=mitm_addon counter=reports unmatched release";

        let event = capture_mitmdump_stderr_log(line);

        assert_eq!(event.level, Level::ERROR);
        assert_event_field(&event, "message", "mitmdump usage underbilling signal");
        assert_event_field(&event, "type", "usage_underbilling");
        assert_event_field(&event, "reason", "usage_pending_counter_underflow");
        assert_event_field(&event, "underbilling_class", "risk");
        assert_event_field(&event, "component", "mitm_addon");
        assert_event_field(&event, "counter", "reports");
        assert_event_field(&event, "mitmdump_stderr", line);
    }

    #[test]
    fn mitmdump_underbilling_stderr_reemits_anthropic_accounting_fields() {
        let line = "[error] type=usage_underbilling \
                    reason=anthropic_sse_incomplete_compressed_body underbilling_class=risk \
                    component=mitm_addon accounting_status=recovered_terminal \
                    decoder_reason=incomplete_compressed_body \
                    run_id=00000000-0000-0000-0000-000000025133 \
                    usage_protocol=anthropic_messages_sse \
                    Incomplete Anthropic SSE accounting";

        let event = capture_mitmdump_stderr_log(line);

        assert_eq!(event.level, Level::ERROR);
        assert_event_field(&event, "message", "mitmdump usage underbilling signal");
        assert_event_field(&event, "reason", "anthropic_sse_incomplete_compressed_body");
        assert_event_field(&event, "run_id", "00000000-0000-0000-0000-000000025133");
        assert_event_field(&event, "usage_protocol", "anthropic_messages_sse");
        assert_event_field(&event, "decoder_reason", "incomplete_compressed_body");
        assert_event_field(&event, "accounting_status", "recovered_terminal");
        assert_event_field(&event, "mitmdump_stderr", line);
    }

    #[test]
    fn mitmdump_underbilling_stderr_does_not_promote_partial_accounting_fields() {
        let line = "type=usage_underbilling \
                    reason=anthropic_sse_incomplete_compressed_body underbilling_class=risk \
                    component=mitm_addon accounting_status=recovered_partial \
                    decoder_reason=incomplete_compressed_body \
                    usage_protocol=anthropic_messages_sse missing run id";

        let event = capture_mitmdump_stderr_log(line);

        for field in [
            "run_id",
            "usage_protocol",
            "decoder_reason",
            "accounting_status",
        ] {
            assert!(
                !event.fields.contains_key(field),
                "unexpected {field} field; event={event:#?}"
            );
        }
        assert_event_field(&event, "mitmdump_stderr", line);
    }
}
