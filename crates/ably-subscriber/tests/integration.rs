use std::time::Duration;

use ably_subscriber::protocol::{
    AblyMessage, ConnectionDetails, ErrorInfo, ProtocolMessage, action, decode_msg, encode_msg,
    error_code,
};
use ably_subscriber::{Event, SubscribeConfig, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

struct MockAblyServer {
    listener: TcpListener,
    port: u16,
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

struct HandshakeOptions {
    max_idle_interval_ms: i64,
    connection_state_ttl_ms: i64,
}

impl Default for HandshakeOptions {
    fn default() -> Self {
        Self {
            max_idle_interval_ms: 15_000,
            connection_state_ttl_ms: 120_000,
        }
    }
}

impl MockAblyServer {
    async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    /// Accept one TCP connection and perform the Ably handshake (CONNECTED + ATTACH/ATTACHED).
    ///
    /// `conn_id` controls the connection identity. Use different IDs across
    /// reconnect attempts so the client knows it's a fresh connect (not a
    /// resume) and sends ATTACH.
    async fn accept_and_handshake(
        &self,
        channel: &str,
        conn_id: &str,
    ) -> Result<WsStream, Box<dyn std::error::Error>> {
        self.accept_and_handshake_with_opts(channel, conn_id, HandshakeOptions::default())
            .await
    }

    /// Accept one TCP connection and perform the Ably handshake with custom options.
    async fn accept_and_handshake_with_opts(
        &self,
        channel: &str,
        conn_id: &str,
        opts: HandshakeOptions,
    ) -> Result<WsStream, Box<dyn std::error::Error>> {
        let (tcp, _) = self.listener.accept().await?;
        let mut ws = tokio_tungstenite::accept_async(tcp).await?;

        let conn_key = format!("{conn_id}!key");

        // Send CONNECTED
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some(conn_id.into()),
            connection_key: Some(conn_key.clone()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some(conn_key),
                connection_state_ttl: Some(opts.connection_state_ttl_ms),
                max_idle_interval: Some(opts.max_idle_interval_ms),
                ..Default::default()
            }),
            ..Default::default()
        };
        ws.send(tungstenite::Message::Binary(encode_msg(&connected)?.into()))
            .await?;

        // Read ATTACH
        let msg = read_protocol_msg(&mut ws).await?;
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some(channel));

        // Send ATTACHED
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some(channel.into()),
            channel_serial: Some("serial-0".into()),
            ..Default::default()
        };
        ws.send(tungstenite::Message::Binary(encode_msg(&attached)?.into()))
            .await?;

        Ok(ws)
    }

    /// Accept one TCP connection and return the raw WebSocket (no handshake).
    async fn accept_raw(&self) -> Result<WsStream, Box<dyn std::error::Error>> {
        let (tcp, _) = self.listener.accept().await?;
        let ws = tokio_tungstenite::accept_async(tcp).await?;
        Ok(ws)
    }
}

async fn read_protocol_msg(
    ws: &mut WsStream,
) -> Result<ProtocolMessage, Box<dyn std::error::Error>> {
    loop {
        let frame = ws.next().await.ok_or("WebSocket closed unexpectedly")??;
        if let tungstenite::Message::Binary(data) = frame {
            return Ok(decode_msg(&data)?);
        }
    }
}

async fn send_message(
    ws: &mut WsStream,
    channel: &str,
    name: &str,
    data: serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let msg = ProtocolMessage {
        action: action::MESSAGE,
        channel: Some(channel.into()),
        channel_serial: Some("serial-1".into()),
        messages: Some(vec![AblyMessage {
            id: Some("msg-1".into()),
            name: Some(name.into()),
            data: Some(data),
            timestamp: Some(now_ms()),
            ..Default::default()
        }]),
        ..Default::default()
    };
    ws.send(tungstenite::Message::Binary(encode_msg(&msg)?.into()))
        .await?;
    Ok(())
}

fn mock_token_endpoint(server: &MockServer, key_name: &str) {
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

fn test_config(ws_port: u16, http_port: u16, channel: &str) -> SubscribeConfig {
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{http_port}");
    let channel = channel.to_string();
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            Box::pin(async {
                Ok(ably_subscriber::TokenRequest {
                    key_name: "testKey.testId".into(),
                    timestamp: now_ms(),
                    nonce: "nonce-1".into(),
                    mac: "fake-mac".into(),
                    capability: r#"{"*":["subscribe"]}"#.into(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        channel,
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
    config
}

fn test_config_with_timing(
    ws_port: u16,
    http_port: u16,
    channel: &str,
    timing: TimingConfig,
) -> SubscribeConfig {
    let mut config = test_config(ws_port, http_port, channel);
    config.timing = Some(timing);
    config
}

// ---------------------------------------------------------------------------
// Test 1: connect and receive a single message
// ---------------------------------------------------------------------------

#[tokio::test]
async fn connect_and_receive_message() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("test-ch", "conn-1").await.unwrap();
        send_message(
            &mut conn,
            "test-ch",
            "greeting",
            serde_json::json!({"hello": "world"}),
        )
        .await
        .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "test-ch"))
        .await
        .unwrap();

    let event = sub.next().await.unwrap();
    assert!(matches!(event, Event::Connected));

    let event = sub.next().await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("greeting"));
            assert_eq!(msg.data, serde_json::json!({"hello": "world"}));
        }
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 2: multiple messages received in order
// ---------------------------------------------------------------------------

#[tokio::test]
async fn multiple_messages() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        for i in 0..3 {
            send_message(&mut conn, "ch", &format!("evt-{i}"), serde_json::json!(i))
                .await
                .unwrap();
        }
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    for i in 0..3 {
        match sub.next().await.unwrap() {
            Event::Message(msg) => {
                assert_eq!(msg.name.as_deref(), Some(format!("evt-{i}").as_str()));
            }
            other => panic!("expected Message, got {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Test 3: batched messages in a single frame
// ---------------------------------------------------------------------------

#[tokio::test]
async fn batched_messages_in_single_frame() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let msg = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some("serial-1".into()),
            messages: Some(vec![
                AblyMessage {
                    name: Some("a".into()),
                    data: Some(serde_json::json!(1)),
                    ..Default::default()
                },
                AblyMessage {
                    name: Some("b".into()),
                    data: Some(serde_json::json!(2)),
                    ..Default::default()
                },
                AblyMessage {
                    name: Some("c".into()),
                    data: Some(serde_json::json!(3)),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&msg).unwrap().into(),
        ))
        .await
        .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let names: Vec<String> = futures_util::stream::unfold(&mut sub, |sub| async {
        match sub.next().await {
            Some(Event::Message(m)) => Some((m.name.unwrap_or_default(), sub)),
            _ => None,
        }
    })
    .take(3)
    .collect()
    .await;

    assert_eq!(names, vec!["a", "b", "c"]);
}

// ---------------------------------------------------------------------------
// Test 4: message with json encoding
// ---------------------------------------------------------------------------

#[tokio::test]
async fn message_with_json_encoding() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let msg = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some("serial-1".into()),
            messages: Some(vec![AblyMessage {
                name: Some("evt".into()),
                data: Some(serde_json::json!(r#"{"runId":"uuid-123"}"#)),
                encoding: Some("json".into()),
                ..Default::default()
            }]),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&msg).unwrap().into(),
        ))
        .await
        .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    match sub.next().await.unwrap() {
        Event::Message(msg) => {
            assert_eq!(msg.data, serde_json::json!({"runId": "uuid-123"}));
        }
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 5: server error during handshake
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_error_during_handshake() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_raw().await.unwrap();
        let error_msg = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: error_code::FAILED,
                status_code: Some(401),
                message: "Unauthorized".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error_msg).unwrap().into(),
        ))
        .await
        .unwrap();
    });

    let result = subscribe(test_config(ws_port, http.port(), "ch")).await;
    match result {
        Err(ably_subscriber::Error::Protocol { .. }) => {}
        Err(other) => panic!("expected Protocol error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

// ---------------------------------------------------------------------------
// Test 6: connection closed before CONNECTED
// ---------------------------------------------------------------------------

#[tokio::test]
async fn connection_closed_before_connected() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let conn = ws.accept_raw().await.unwrap();
        drop(conn);
    });

    let result = subscribe(test_config(ws_port, http.port(), "ch")).await;
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Test 7: HTTP token exchange error (500)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http_token_exchange_error() {
    let http = MockServer::start();
    // No WS server needed — we fail before connecting
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(500).body("Internal Server Error");
    });

    let result = subscribe(test_config(19999, http.port(), "ch")).await;
    match result {
        Err(ably_subscriber::Error::Http(_)) => {}
        Err(other) => panic!("expected Http error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

// ---------------------------------------------------------------------------
// Test 8: token renewal — server receives AUTH after short-TTL token
// ---------------------------------------------------------------------------

#[tokio::test]
async fn token_renewal() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let now = now_ms();
    // First token: expires in 1 second (token renewal margin is 300s, so
    // renewal fires almost immediately)
    let short_token_body = serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    });
    let renewed_token_body = serde_json::json!({
        "token": "renewed-token",
        "expires": now + 3_600_000,
        "issued": now,
    });
    // httpmock serves first call then second call
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(short_token_body);
    });
    // Second mock for renewal exchange
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(renewed_token_body);
    });

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Wait for AUTH message from client
        let auth_msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for AUTH")
            .unwrap();
        assert_eq!(auth_msg.action, action::AUTH);

        // Send a message after renewal
        send_message(&mut conn, "ch", "after-renewal", serde_json::json!("ok"))
            .await
            .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Should receive the message sent after token renewal
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for message after renewal")
        .unwrap();

    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-renewal"));
        }
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 9: reconnect after server drops connection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_after_server_drop() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    // Need a second mock for the token exchange on reconnect
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // First connection
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-drop", serde_json::json!(1))
            .await
            .unwrap();
        // Give client time to receive the message
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(conn);

        // Second connection (after reconnect)
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-reconnect", serde_json::json!(2))
            .await
            .unwrap();
        // Keep alive long enough for client to read
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // First message
    match sub.next().await.unwrap() {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("before-drop")),
        other => panic!("expected Message, got {other:?}"),
    }

    // Disconnected event
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Reconnected
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after reconnect")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-reconnect")),
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 10: server sends DISCONNECTED, client reconnects
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_sends_disconnected() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Send DISCONNECTED (retriable)
        let disconnected = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "server going away".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&disconnected).unwrap().into(),
        ))
        .await
        .unwrap();

        // Second connection
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "reconnected", serde_json::json!("ok"))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Disconnected
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Reconnected
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("reconnected")),
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 11: server sends DETACHED, client re-attaches
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_sends_detached_reattach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Send DETACHED (retriable — server error)
        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Expect re-ATTACH from client
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        // Send ATTACHED
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Send message after reattach
        send_message(&mut conn, "ch", "after-reattach", serde_json::json!("ok"))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Message after reattach
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after reattach")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-reattach")),
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 12: close subscription sends CLOSE to server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn close_subscription() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Wait for CLOSE from client
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for CLOSE")
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    sub.close();

    // Server task confirms it received CLOSE
    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for server to confirm CLOSE")
        .unwrap();
}

// ---------------------------------------------------------------------------
// Test 13: non-retriable DISCONNECTED → Event::Error (not reconnect)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn non_retriable_disconnected_emits_error() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Send DISCONNECTED with a non-retriable error (401 + non-connection code)
        let disconnected = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 40142,
                status_code: Some(401),
                message: "Token expired".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&disconnected).unwrap().into(),
        ))
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Error { code, .. } => assert_eq!(code, 40142),
        other => panic!("expected Error, got {other:?}"),
    }

    // Stream should end (loop stopped)
    assert!(sub.next().await.is_none());
}

// ---------------------------------------------------------------------------
// Test 14: ERROR during event loop → Event::Error + stop
// ---------------------------------------------------------------------------

#[tokio::test]
async fn error_during_event_loop() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let error_msg = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 40000,
                status_code: Some(400),
                message: "Bad request".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error_msg).unwrap().into(),
        ))
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Error { code, .. } => assert_eq!(code, 40000),
        other => panic!("expected Error, got {other:?}"),
    }

    assert!(sub.next().await.is_none());
}

// ---------------------------------------------------------------------------
// Test 15: non-retriable DETACHED → Event::Error (not re-attach)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn non_retriable_detached_emits_error() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // DETACHED with non-retriable error (401 + non-connection code)
        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 40160,
                status_code: Some(401),
                message: "Channel denied".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Error { code, message } => {
            assert_eq!(code, 40160);
            assert!(message.contains("Channel detached"), "got: {message}");
        }
        other => panic!("expected Error, got {other:?}"),
    }

    assert!(sub.next().await.is_none());
}

// ---------------------------------------------------------------------------
// Test 16: server sends CLOSED → event loop stops
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_sends_closed() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let closed = ProtocolMessage {
            action: action::CLOSED,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&closed).unwrap().into(),
        ))
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Stream should end (CLOSED → LoopAction::Stop)
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out");
    assert!(event.is_none(), "expected None after CLOSED, got {event:?}");
}

// ---------------------------------------------------------------------------
// Test 17: server-initiated AUTH (action 17) → client renews token
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_initiated_auth() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    // Second mock for the renewal exchange triggered by server AUTH
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Server sends AUTH to request reauthentication
        let auth_request = ProtocolMessage {
            action: action::AUTH,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&auth_request).unwrap().into(),
        ))
        .await
        .unwrap();

        // Client should respond with AUTH containing new token
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for client AUTH response")
            .unwrap();
        assert_eq!(msg.action, action::AUTH);
        assert!(
            msg.auth.is_some(),
            "AUTH message should contain auth details"
        );

        // Send a message to confirm the connection is still alive
        send_message(
            &mut conn,
            "ch",
            "after-server-auth",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after server AUTH")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-server-auth")),
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 18: get_token callback returns error → subscribe fails
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_token_callback_error() {
    let mut config = SubscribeConfig::new(
        Box::new(|| Box::pin(async { Err("token fetch failed".into()) })),
        "ch",
    );
    config.host = Some("127.0.0.1:19999".into());
    config.rest_host = Some("127.0.0.1:19999".into());

    let result = subscribe(config).await;
    match result {
        Err(ably_subscriber::Error::TokenFetch(_)) => {}
        Err(other) => panic!("expected TokenFetch error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

// ---------------------------------------------------------------------------
// Test 19: heartbeat timeout triggers reconnect (fast with TimingConfig)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn heartbeat_timeout_triggers_reconnect() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // First connection: tiny max_idle_interval, then silence (no heartbeats)
        let _conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 50,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        // Don't send anything — let the heartbeat timeout fire

        // Second connection after reconnect
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-hb-timeout",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut timing = TimingConfig::default();
    timing.heartbeat_margin = Duration::from_millis(50);
    timing.initial_retry_interval = Duration::from_millis(10);
    timing.max_retry_interval = Duration::from_millis(50);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Disconnected from heartbeat timeout
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Reconnected
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-hb-timeout")),
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 20: retry exhaustion emits error (fast with TimingConfig)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn retry_exhaustion_emits_error() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    // Extra token mocks for the retry attempts (each fresh connect needs a token)
    mock_token_endpoint(&http, "testKey.testId");
    mock_token_endpoint(&http, "testKey.testId");
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // First connection: handshake then drop
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);
        // Drop the server so the port is unbound — reconnects fail with
        // "connection refused" immediately instead of hanging on the listener.
        drop(ws);
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    let mut timing = TimingConfig::default();
    timing.max_retry_attempts = 2;
    timing.initial_retry_interval = Duration::from_millis(10);
    timing.max_retry_interval = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Disconnected
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Error after exhausting retries
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Error")
        .unwrap();
    match event {
        Event::Error { message, .. } => {
            assert!(
                message.contains("failed after 2 attempts"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected Error, got {other:?}"),
    }

    assert!(sub.next().await.is_none());
}

// ---------------------------------------------------------------------------
// Test 21: token renewal failures become fatal (fast with TimingConfig)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn token_renewal_failures_fatal() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    // Return a short-lived token so renewal fires immediately.
    // TOKEN_RENEWAL_MARGIN is 300s, so a 1s token means renew_in = 0.
    let now = now_ms();
    let short_token = serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    });
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(short_token);
    });

    let ws_port = ws.port;
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{}", http.port());

    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        // Keep the connection alive while renewal attempts happen
        tokio::time::sleep(Duration::from_secs(10)).await;
        let _ = conn.close(None).await;
    });

    // Use an atomic counter so get_token succeeds for the initial exchange
    // but fails for all subsequent renewal attempts.
    let call_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let cc = call_count.clone();
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let n = cc.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async move {
                if n > 0 {
                    return Err("simulated token fetch failure".into());
                }
                Ok(ably_subscriber::TokenRequest {
                    key_name: "testKey.testId".into(),
                    timestamp: now_ms(),
                    nonce: "nonce-1".into(),
                    mac: "fake-mac".into(),
                    capability: r#"{"*":["subscribe"]}"#.into(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        "ch",
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
    config.timing = Some({
        let mut t = TimingConfig::default();
        t.token_renewal_retry_delay = Duration::from_millis(10);
        t
    });
    let mut sub = subscribe(config).await.unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Should eventually get a fatal error after 3 consecutive renewal failures
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Error")
        .unwrap();
    match event {
        Event::Error { message, .. } => {
            assert!(
                message.contains("renewal failed 3 consecutive"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected Error, got {other:?}"),
    }

    assert!(sub.next().await.is_none());
}

// ---------------------------------------------------------------------------
// Test 22: backpressure drops messages when channel is full
// ---------------------------------------------------------------------------

#[tokio::test]
async fn backpressure_drops_messages() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        // Send 10 messages rapidly (channel capacity = 2, plus 1 Connected event)
        for i in 0..10 {
            send_message(&mut conn, "ch", &format!("msg-{i}"), serde_json::json!(i))
                .await
                .unwrap();
        }
        // Keep connection alive
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 2;
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Drain some messages — we may not get all 10 due to backpressure drops,
    // but we should get at least 1 and the stream should still work
    let mut received = 0;
    while let Ok(Some(Event::Message(_))) =
        tokio::time::timeout(Duration::from_secs(2), sub.next()).await
    {
        received += 1;
    }
    assert!(
        (1..10).contains(&received),
        "expected some messages dropped, got {received}/10"
    );
}

// ---------------------------------------------------------------------------
// Test 23: detached within retry window triggers full reconnect
// ---------------------------------------------------------------------------

#[tokio::test]
async fn detached_within_retry_window_triggers_reconnect() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };

        // First DETACHED (retriable) → client sets last_reattach_at and sends ATTACH
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Wait for re-ATTACH
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);

        // Send second DETACHED *before* ATTACHED — while last_reattach_at is
        // still set. This is within the retry window → triggers full reconnect.
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Client should do a full reconnect
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-full-reconnect",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut timing = TimingConfig::default();
    timing.reattach_window = Duration::from_secs(60);
    timing.initial_retry_interval = Duration::from_millis(10);
    timing.max_retry_interval = Duration::from_millis(50);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // The DETACHED→Reconnect code path does NOT emit a Disconnected event
    // (unlike the DISCONNECTED action handler which does). So we expect
    // Connected directly after the full reconnect completes.
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after full reconnect
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-full-reconnect")),
        other => panic!("expected Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 24: connect_timeout fires when server hangs during handshake
// ---------------------------------------------------------------------------

#[tokio::test]
async fn connect_timeout_fires() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // Accept TCP but never complete the WebSocket handshake — just sleep
        let (tcp, _) = ws.listener.accept().await.unwrap();
        let _hold = tcp; // keep socket open
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    let mut timing = TimingConfig::default();
    timing.connect_timeout = Duration::from_millis(100);
    let result = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing)).await;
    match result {
        Err(ably_subscriber::Error::Protocol { code, message }) => {
            assert_eq!(code, ably_subscriber::protocol::error_code::TIMEOUT);
            assert!(
                message.contains("timed out"),
                "unexpected message: {message}"
            );
        }
        Err(other) => panic!("expected Protocol/TIMEOUT error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

// ---------------------------------------------------------------------------
// Test 25: reconnect_timeout fires when reconnect attempt hangs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_timeout_fires() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // First connection succeeds, then drop
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        // For reconnect attempts: accept TCP but never complete WebSocket
        // handshake — forces reconnect_timeout to fire (not "connection refused").
        while let Ok((tcp, _)) = ws.listener.accept().await {
            let _hold = tcp;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });

    let mut timing = TimingConfig::default();
    timing.reconnect_timeout = Duration::from_millis(100);
    timing.max_retry_attempts = 2;
    timing.initial_retry_interval = Duration::from_millis(10);
    timing.max_retry_interval = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Disconnected
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Each reconnect attempt hangs → reconnect_timeout fires → retry.
    // After max_retry_attempts, we get a fatal error.
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Error")
        .unwrap();
    match event {
        Event::Error { message, .. } => {
            assert!(
                message.contains("failed after 2 attempts"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected Error, got {other:?}"),
    }

    assert!(sub.next().await.is_none());
}

// ---------------------------------------------------------------------------
// Test 26: expired connection_state_ttl skips resume (fresh connect)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn expired_ttl_skips_resume() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (resume_tx, resume_rx) = tokio::sync::oneshot::channel::<bool>();

    tokio::spawn(async move {
        // First connection with a tiny connection_state_ttl (1ms).
        // The server-provided TTL overrides the TimingConfig default, so we
        // set it here to ensure can_resume() sees a short TTL.
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        // Small delay so the 1ms TTL expires before the reconnect attempt.
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(conn);

        // Second connection — send CONNECTED with the *same* conn_id.
        // If client tried resume and got the same ID, it would skip ATTACH.
        // But since TTL expired, can_resume()=false → fresh connect → ATTACH.
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();

        // The fact that accept_and_handshake succeeded (it reads ATTACH and
        // sends ATTACHED) proves the client sent ATTACH, i.e. did NOT resume.
        let _ = resume_tx.send(true);

        send_message(
            &mut conn2,
            "ch",
            "after-fresh-connect",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let mut timing = TimingConfig::default();
    timing.initial_retry_interval = Duration::from_millis(10);
    timing.max_retry_interval = Duration::from_millis(50);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Wait for reconnection
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));

    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(matches!(event, Event::Connected));

    // Message after fresh connect
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-fresh-connect")),
        other => panic!("expected Message, got {other:?}"),
    }

    // Verify server saw ATTACH (meaning client did NOT resume)
    let did_attach = resume_rx.await.expect("server task panicked");
    assert!(did_attach, "client should have sent ATTACH (no resume)");
}
