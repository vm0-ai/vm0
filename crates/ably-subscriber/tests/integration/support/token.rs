use httpmock::prelude::*;

use super::now_ms;

pub(crate) fn mock_token_endpoint(server: &MockServer, key_name: &str) {
    let path = format!("/keys/{key_name}/requestToken");
    let now = now_ms();
    let body = serde_json::json!({
        "token": "mock-token-abc",
        "expires": now + 3_600_000,
        "issued": now,
        "capability": "{\"*\":[\"*\"]}",
    });
    server.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(body);
    });
}
