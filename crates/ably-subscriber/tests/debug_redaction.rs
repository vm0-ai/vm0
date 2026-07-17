use ably_subscriber::{
    TokenDetails, TokenRequest,
    protocol::{AuthDetails, ConnectionDetails, ErrorInfo, ProtocolMessage, action},
};

#[test]
fn token_debug_redacts_credentials_and_preserves_metadata() {
    let request_mac = "token-request-mac-secret";
    let request = TokenRequest {
        key_name: "public-key-name".to_string(),
        timestamp: 1_700_000_000_000,
        nonce: "diagnostic-nonce".to_string(),
        mac: request_mac.to_string(),
        capability: r#"{"runner-group:*":["subscribe"]}"#.to_string(),
        ttl: Some(3_600_000),
        client_id: Some("runner-client".to_string()),
    };

    let request_debug = format!("{request:?}");
    assert!(request_debug.contains("TokenRequest"));
    assert!(request_debug.contains("mac: \"[redacted]\""));
    assert!(request_debug.contains("key_name: \"public-key-name\""));
    assert!(request_debug.contains("runner-group:*"));
    assert!(!request_debug.contains(request_mac));

    let bearer_token = "token-details-bearer-secret";
    let details = TokenDetails {
        token: bearer_token.to_string(),
        expires: 1_700_003_600_000,
        issued: 1_700_000_000_000,
        capability: Some(r#"{"runner-group:*":["subscribe"]}"#.to_string()),
        client_id: Some("runner-client".to_string()),
    };

    let details_debug = format!("{details:?}");
    assert!(details_debug.contains("TokenDetails"));
    assert!(details_debug.contains("token: \"[redacted]\""));
    assert!(details_debug.contains("expires: 1700003600000"));
    assert!(details_debug.contains("client_id: Some(\"runner-client\")"));
    assert!(!details_debug.contains(bearer_token));
}

#[test]
fn auth_debug_redacts_access_token_directly_and_when_nested() {
    let access_token = "auth-details-access-token-secret";
    let auth = AuthDetails {
        access_token: access_token.to_string(),
    };

    let auth_debug = format!("{auth:?}");
    assert!(auth_debug.contains("AuthDetails"));
    assert!(auth_debug.contains("access_token: \"[redacted]\""));
    assert!(!auth_debug.contains(access_token));

    let message = ProtocolMessage {
        action: action::AUTH,
        auth: Some(auth),
        channel: Some("runner-group:diagnostic".to_string()),
        ..Default::default()
    };

    let message_debug = format!("{message:?}");
    assert!(message_debug.contains("ProtocolMessage"));
    assert!(message_debug.contains("auth: Some(AuthDetails"));
    assert!(message_debug.contains("access_token: \"[redacted]\""));
    assert!(message_debug.contains("runner-group:diagnostic"));
    assert!(!message_debug.contains(access_token));
}

#[test]
fn protocol_error_debug_redacts_access_token_directly_and_when_nested() {
    let access_token = "protocol-error-access-token-secret";
    let error = ErrorInfo {
        code: 80_003,
        status_code: Some(401),
        message: format!(
            "failed wss://realtime.ably.io/?access_token={access_token}&format=msgpack"
        ),
    };

    let error_debug = format!("{error:?}");
    assert!(error_debug.contains("ErrorInfo"));
    assert!(error_debug.contains("code: 80003"));
    assert!(error_debug.contains("access_token=<redacted>"));
    assert!(!error_debug.contains(access_token));

    let message = ProtocolMessage {
        action: action::ERROR,
        error: Some(error),
        ..Default::default()
    };

    let message_debug = format!("{message:?}");
    assert!(message_debug.contains("error: Some(ErrorInfo"));
    assert!(message_debug.contains("access_token=<redacted>"));
    assert!(!message_debug.contains(access_token));
}

#[test]
fn connection_debug_redacts_top_level_and_nested_keys() {
    let nested_connection_key = "nested-connection-key-secret";
    let details = ConnectionDetails {
        client_id: Some("runner-client".to_string()),
        connection_key: Some(nested_connection_key.to_string()),
        connection_state_ttl: Some(120_000),
        max_idle_interval: Some(15_000),
        max_message_size: Some(65_536),
        max_frame_size: Some(65_536),
        server_id: Some("server-a".to_string()),
    };

    let details_debug = format!("{details:?}");
    assert!(details_debug.contains("ConnectionDetails"));
    assert!(details_debug.contains("connection_key: Some(\"[redacted]\")"));
    assert!(details_debug.contains("server_id: Some(\"server-a\")"));
    assert!(!details_debug.contains(nested_connection_key));

    let top_level_connection_key = "top-level-connection-key-secret";
    let message = ProtocolMessage {
        action: action::CONNECTED,
        connection_id: Some("public-connection-id".to_string()),
        connection_key: Some(top_level_connection_key.to_string()),
        connection_details: Some(details),
        ..Default::default()
    };

    let message_debug = format!("{message:?}");
    assert!(message_debug.contains("ProtocolMessage"));
    assert_eq!(
        message_debug
            .matches("connection_key: Some(\"[redacted]\")")
            .count(),
        2
    );
    assert!(message_debug.contains("connection_id: Some(\"public-connection-id\")"));
    assert!(message_debug.contains("client_id: Some(\"runner-client\")"));
    assert!(!message_debug.contains(top_level_connection_key));
    assert!(!message_debug.contains(nested_connection_key));
}
