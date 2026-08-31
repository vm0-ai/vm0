use super::super::*;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

const EVENT_MESSAGE: &str = "runner operator environment alias states";

fn capture_validation(
    server: config::ServerConfig,
) -> (RunnerResult<config::ServerConfig>, Vec<CapturedEvent>) {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    captured.clear();

    let result = validate_server_config_for_start(server);
    (result, captured.entries())
}

fn alias_state_events(events: &[CapturedEvent]) -> Vec<&CapturedEvent> {
    events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == EVENT_MESSAGE)
        })
        .collect()
}

#[test]
fn successful_server_validation_emits_one_value_free_alias_state_event() {
    const URL: &str = "https://Operator-URL.Example.Test/base/";

    let (result, events) = capture_validation(config::ServerConfig {
        url: URL.to_string(),
        token: "present".to_string(),
    });
    let server = result.expect("valid server configuration should resolve");
    assert_eq!(server.url, "https://operator-url.example.test/base");

    let alias_events = alias_state_events(&events);
    assert_eq!(alias_events.len(), 1, "captured events: {events:#?}");
    let event = alias_events[0];
    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.keys().map(String::as_str).collect::<Vec<_>>(),
        ["api_url_alias_state", "message", "runner_token_alias_state",],
        "alias-state event must contain only fixed fields: {event:#?}",
    );
    assert!(
        [
            "absent",
            "canonical_only",
            "legacy_only",
            "equal_dual",
            "conflicting_dual",
        ]
        .contains(
            &event
                .fields
                .get("api_url_alias_state")
                .unwrap_or_else(|| panic!("missing API URL state: {event:#?}"))
                .as_str(),
        ),
        "unexpected API URL state: {event:#?}",
    );
    assert!(
        ["absent", "canonical_only", "legacy_only", "dual_present",].contains(
            &event
                .fields
                .get("runner_token_alias_state")
                .unwrap_or_else(|| panic!("missing Runner token state: {event:#?}"))
                .as_str(),
        ),
        "unexpected Runner token state: {event:#?}",
    );
}

#[test]
fn invalid_server_configuration_emits_no_alias_state_event() {
    for server in [
        config::ServerConfig {
            url: "not-an-absolute-url".to_string(),
            token: "present".to_string(),
        },
        config::ServerConfig {
            url: "https://api.example.test".to_string(),
            token: String::new(),
        },
    ] {
        let (result, events) = capture_validation(server);
        assert!(result.is_err());
        assert!(
            alias_state_events(&events).is_empty(),
            "validation failure emitted an alias-state event: {events:#?}",
        );
    }
}
