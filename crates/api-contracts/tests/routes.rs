use api_contracts::{Method, generated::routes};

#[test]
fn exposes_generated_webhook_route_constants() {
    let route = routes::webhooks::agent_events::SEND;

    assert_eq!(route.method, Method::Post);
    assert_eq!(route.method.as_str(), "POST");
    assert_eq!(route.path, "/api/webhooks/agent/events");
}
