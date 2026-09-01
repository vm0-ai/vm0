use super::super::*;

#[test]
fn valid_server_config_normalizes_url_and_preserves_token() {
    const TOKEN: &str = "  exact runner token bytes  ";

    let server = validate_server_config_for_start(config::ServerConfig {
        url: "https://Operator-URL.Example.Test/base/".to_string(),
        token: TOKEN.to_string(),
    })
    .expect("valid server configuration should resolve");

    assert_eq!(server.url, "https://operator-url.example.test/base");
    assert_eq!(server.token, TOKEN);
}

#[test]
fn missing_server_sources_report_canonical_operator_inputs() {
    for (server, expected) in [
        (
            config::ServerConfig {
                url: String::new(),
                token: "present".to_string(),
            },
            "server.url is required (set in config or via --api-url / OKOU_API_BACKEND_URL)",
        ),
        (
            config::ServerConfig {
                url: "https://api.example.test".to_string(),
                token: String::new(),
            },
            "server.token is required (set in config or via --token / OKOU_RUNNER_TOKEN)",
        ),
    ] {
        let error = validate_server_config_for_start(server)
            .expect_err("missing server source should fail validation");
        assert_eq!(error.to_string(), format!("config error: {expected}"));
    }
}
