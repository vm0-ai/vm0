use api_contracts::{Method, generated::routes};

#[test]
fn exposes_generated_webhook_route_constants() {
    let route = routes::webhooks::agent::events::SEND;

    assert_eq!(route.method, Method::Post);
    assert_eq!(route.method.as_str(), "POST");
    assert_eq!(route.path, "/api/webhooks/agent/events");
}

#[test]
fn exposes_nested_generated_webhook_route_constants() {
    let checkpoint = routes::webhooks::agent::checkpoints::CREATE;
    let prepare_history = routes::webhooks::agent::checkpoints::prepare_history::PREPARE;

    assert_eq!(checkpoint.method, Method::Post);
    assert_eq!(checkpoint.path, "/api/webhooks/agent/checkpoints");
    assert_eq!(prepare_history.method, Method::Post);
    assert_eq!(
        prepare_history.path,
        "/api/webhooks/agent/checkpoints/prepare-history"
    );
}

#[test]
fn generated_routes_build_urls_from_base_api_url() {
    let route = routes::webhooks::agent::telemetry::SEND;

    assert_eq!(
        route.url("https://api.vm0.dev"),
        "https://api.vm0.dev/api/webhooks/agent/telemetry"
    );
    assert_eq!(
        route.url("https://api.vm0.dev/"),
        "https://api.vm0.dev/api/webhooks/agent/telemetry"
    );
    assert_eq!(
        route.url(""),
        "/api/webhooks/agent/telemetry",
        "empty base URL must preserve the old relative-path behavior"
    );
}
