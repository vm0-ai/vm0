use std::time::Duration;

use ably_subscriber::protocol::{
    AblyMessage, ConnectionDetails, ErrorInfo, ProtocolMessage, action, decode_msg, encode_msg,
    error_code,
};
use ably_subscriber::{Event, SubscribeConfig, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use tokio::io::AsyncReadExt;
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

async fn expect_websocket_close_frame(ws: &mut WsStream) -> Result<(), Box<dyn std::error::Error>> {
    let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .map_err(|_| std::io::Error::other("timed out waiting for websocket close frame"))?
        .ok_or_else(|| std::io::Error::other("websocket closed before close frame"))??;
    if !matches!(frame, tungstenite::Message::Close(_)) {
        return Err(std::io::Error::other(format!(
            "expected websocket close frame, got {frame:?}"
        ))
        .into());
    }
    Ok(())
}

async fn expect_websocket_closed(ws: &mut WsStream) -> Result<(), Box<dyn std::error::Error>> {
    let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .map_err(|_| std::io::Error::other("timed out waiting for websocket to close"))?;
    match frame {
        None | Some(Err(_)) | Some(Ok(tungstenite::Message::Close(_))) => Ok(()),
        Some(Ok(frame)) => {
            Err(std::io::Error::other(format!("expected websocket close, got {frame:?}")).into())
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

async fn wait_for_test_observation(rx: tokio::sync::oneshot::Receiver<()>, context: &'static str) {
    let observed = tokio::time::timeout(Duration::from_secs(5), rx).await;
    assert!(
        matches!(observed, Ok(Ok(()))),
        "timed out or dropped observation signal for {context}: {observed:?}",
    );
}

// Negative waits still need a real observation window; keep them explicit so
// they are not confused with arbitrary synchronization delays.
async fn assert_value_stable_for<T>(
    window: Duration,
    mut current: impl FnMut() -> T,
    expected: T,
    context: &'static str,
) where
    T: std::fmt::Debug + PartialEq,
{
    tokio::time::sleep(window).await;
    assert_eq!(current(), expected, "{context}");
}

/// Register a mock that responds to POST /keys/{key_name}/requestToken.
/// httpmock mocks match unlimited times, so a single call handles both
/// the initial connect and any reconnects that require a new token.
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

fn test_config_with_pending_renewal(
    ws_port: u16,
    http_port: u16,
    channel: &str,
    renewal_started: tokio::sync::oneshot::Sender<()>,
) -> SubscribeConfig {
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{http_port}");
    let call_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let renewal_started = std::sync::Arc::new(std::sync::Mutex::new(Some(renewal_started)));
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let n = call_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let renewal_started = renewal_started.clone();
            Box::pin(async move {
                if n > 0 {
                    let tx = match renewal_started.lock() {
                        Ok(mut guard) => guard.take(),
                        Err(poisoned) => poisoned.into_inner().take(),
                    };
                    if let Some(tx) = tx {
                        let _ = tx.send(());
                    }
                    return std::future::pending::<
                        Result<ably_subscriber::TokenRequest, ably_subscriber::BoxError>,
                    >()
                    .await;
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
        channel.to_string(),
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
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
    let server_task = tokio::spawn(async move {
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

    server_task.await.unwrap();
}

#[tokio::test]
async fn message_without_channel_is_ignored() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let missing_channel = ProtocolMessage {
            action: action::MESSAGE,
            channel: None,
            channel_serial: Some("serial-missing-channel".into()),
            messages: Some(vec![AblyMessage {
                name: Some("wrong".into()),
                data: Some(serde_json::json!("ignored")),
                timestamp: Some(now_ms()),
                ..Default::default()
            }]),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&missing_channel).unwrap().into(),
        ))
        .await
        .unwrap();
        send_message(&mut conn, "ch", "expected", serde_json::json!("ok"))
            .await
            .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for matching-channel message")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("expected")),
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn zero_event_channel_capacity_uses_minimum_capacity() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "after-connect", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(message_seen_rx, "after-connect message").await;
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 0;
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-connect"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
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
    let server_task = tokio::spawn(async move {
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

    server_task.await.unwrap();
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
    let server_task = tokio::spawn(async move {
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

    server_task.await.unwrap();
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
    // renewal fires almost immediately).  Second token: 1 hour TTL, so
    // after renewal the subscriber should stop calling the endpoint.
    let short_body = serde_json::to_vec(&serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    }))
    .unwrap();
    let renewed_body = serde_json::to_vec(&serde_json::json!({
        "token": "renewed-token",
        "expires": now + 3_600_000,
        "issued": now,
    }))
    .unwrap();

    // Single mock with stateful response: first call returns the short
    // token, subsequent calls return the renewed long-lived token.  This
    // lets us assert via `calls()` that renewal stabilises at exactly 2
    // calls — any more means the subscriber ignored the new TTL and kept
    // renewing in a loop.
    let path = "/keys/testKey.testId/requestToken";
    let call_count = std::sync::Mutex::new(0u32);
    let token_mock = http.mock(|when, then| {
        when.method(POST).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            let mut n = call_count.lock().unwrap();
            let body = if *n == 0 { &short_body } else { &renewed_body };
            *n += 1;
            HttpMockResponse::builder()
                .status(201)
                .header("content-type", "application/json")
                .body(body.clone())
                .build()
        });
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

    assert_value_stable_for(
        Duration::from_millis(500),
        || token_mock.calls(),
        2,
        "subscriber should stop renewing after receiving the long-lived token",
    )
    .await;
}

#[tokio::test]
async fn close_during_pending_token_renewal_sends_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

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
    let (renewal_started_tx, renewal_started_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for CLOSE during renewal")
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config_with_pending_renewal(
        ws_port,
        http.port(),
        "ch",
        renewal_started_tx,
    ))
    .await
    .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    tokio::time::timeout(Duration::from_secs(5), renewal_started_rx)
        .await
        .expect("timed out waiting for token renewal to start")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for CLOSE during pending renewal")
        .unwrap();
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 9: reconnect after server drops connection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_after_server_drop() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (before_drop_seen_tx, before_drop_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_reconnect_seen_tx, after_reconnect_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        // First connection
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-drop", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(before_drop_seen_rx, "before-drop message").await;
        drop(conn);

        // Second connection (after reconnect)
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-reconnect", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_reconnect_seen_rx, "after-reconnect message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // First message
    match sub.next().await.unwrap() {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("before-drop"));
            before_drop_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Disconnected event
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            let reason = reason.expect("dropped stream should include a disconnect reason");
            assert!(
                reason.contains("websocket")
                    || reason.contains("connection")
                    || reason.contains("stream")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

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
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reconnect"));
            after_reconnect_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 9b: server sends WebSocket Close frame, client reconnects immediately
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_immediately_after_close_frame() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (before_close_seen_tx, before_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_close_seen_tx, after_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        // First connection — send a message then close with a reason
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-close", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(before_close_seen_rx, "before-close message").await;
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "server maintenance".into(),
        }))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        // Second connection after reconnect
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-close", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_close_seen_rx, "after-close message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    match sub.next().await.unwrap() {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("before-close"));
            before_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Disconnected event
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            let reason = reason.expect("close frame should include a disconnect reason");
            assert!(reason.contains("websocket closed code=1000"));
            assert!(reason.contains("server maintenance"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Should reconnect within 500ms (no backoff), NOT 1-2 seconds
    let event = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("reconnect took too long — backoff was not skipped")
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
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-close"));
            after_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 9c: server sends Close without a close frame, client reconnects immediately
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_immediately_after_close_frame_no_reason() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (before_close_seen_tx, before_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_close_seen_tx, after_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-close", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(before_close_seen_rx, "before-close message").await;
        // Close without reason
        conn.close(None).await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-close", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_close_seen_rx, "after-close message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    match sub.next().await.unwrap() {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("before-close"));
            before_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(
                reason.as_deref(),
                Some("websocket closed without close frame")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Should reconnect within 500ms (no backoff)
    let event = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("reconnect took too long — backoff was not skipped")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after reconnect")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-close"));
            after_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 9d: server sends Close frame with empty reason
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_after_close_frame_empty_reason_reports_code_only() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_close_seen_tx, after_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "".into(),
        }))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-close", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_close_seen_rx, "after-close message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("websocket closed code=1000"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    let event = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("reconnect took too long — backoff was not skipped")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after reconnect")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-close"));
            after_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 9e: repeated clean close frames are rate-limited
// ---------------------------------------------------------------------------

#[tokio::test]
async fn repeated_clean_close_reconnect_is_rate_limited() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_rate_limit_seen_tx, after_rate_limit_seen_rx) =
        tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "rotate".into(),
        }))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        conn2
            .close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "rotate-again".into(),
            }))
            .await
            .unwrap();
        expect_websocket_close_frame(&mut conn2).await.unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(250), ws.accept_raw())
                .await
                .is_err(),
            "third reconnect should wait for the minimum reconnect interval"
        );

        let mut conn3 = tokio::time::timeout(
            Duration::from_secs(5),
            ws.accept_and_handshake("ch", "conn-3"),
        )
        .await
        .expect("third reconnect did not happen")
        .unwrap();
        send_message(&mut conn3, "ch", "after-rate-limit", serde_json::json!(3))
            .await
            .unwrap();
        wait_for_test_observation(after_rate_limit_seen_rx, "after-rate-limit message").await;
    });

    let mut timing = TimingConfig::default();
    timing.min_reconnect_interval = Duration::from_secs(2);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    assert!(matches!(
        sub.next().await.unwrap(),
        Event::Disconnected { .. }
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), sub.next())
            .await
            .expect("first reconnect should not be rate-limited")
            .unwrap(),
        Event::Connected
    ));
    assert!(matches!(
        sub.next().await.unwrap(),
        Event::Disconnected { .. }
    ));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for rate-limited reconnect")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for post-reconnect message")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-rate-limit"));
            after_rate_limit_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 10: server sends DISCONNECTED, client reconnects
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_sends_disconnected() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
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

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after protocol DISCONNECTED")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );

        // Second connection
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "reconnected", serde_json::json!("ok"))
            .await
            .unwrap();
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
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("server going away"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

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

    server_task.await.unwrap();
}

#[tokio::test]
async fn server_sends_disconnected_without_message_reports_reason() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (reconnected_seen_tx, reconnected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let disconnected_without_error = ProtocolMessage {
            action: action::DISCONNECTED,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&disconnected_without_error).unwrap().into(),
        ))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        let disconnected_without_message = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: String::new(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&disconnected_without_message).unwrap().into(),
            ))
            .await
            .unwrap();
        expect_websocket_close_frame(&mut conn2).await.unwrap();

        let mut conn3 = ws.accept_and_handshake("ch", "conn-3").await.unwrap();
        send_message(&mut conn3, "ch", "reconnected", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(reconnected_seen_rx, "reconnected message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(
                reason.as_deref(),
                Some("server sent DISCONNECTED without error details")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(
                reason.as_deref(),
                Some("server sent DISCONNECTED code=80003 status=500")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("reconnected"));
            reconnected_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn disconnected_event_is_not_delayed_by_transport_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (event_seen_tx, event_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
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

        event_seen_rx.await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.close_timeout = Duration::from_secs(5);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_millis(250), sub.next())
        .await
        .expect("Disconnected should not wait for transport close")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );
    event_seen_tx.send(()).unwrap();
    sub.close();
    server_task.await.unwrap();
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
    let (after_reattach_seen_tx, after_reattach_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
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
        wait_for_test_observation(after_reattach_seen_rx, "after-reattach message").await;
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
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reattach"));
            after_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
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

    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Wait for Ably protocol CLOSE from client.
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for CLOSE")
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);

        // Then the websocket itself should be closed instead of relying on task
        // drop to release the socket.
        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );
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
    server_task.await.unwrap();
}

#[tokio::test]
async fn drop_subscription_sends_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for CLOSE after drop")
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after drop")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    drop(sub);

    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for server to confirm drop close")
        .unwrap();
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 13: non-retriable DISCONNECTED still triggers reconnect
// ---------------------------------------------------------------------------

/// ably-js always reconnects on mid-session DISCONNECTED regardless of
/// retriability — the server may send 429 or 401 but still expect the
/// client to backoff-and-retry. Only connection-level ERROR is fatal.
#[tokio::test]
async fn non_retriable_disconnected_triggers_reconnect() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_reconnect_seen_tx, after_reconnect_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
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
        expect_websocket_close_frame(&mut conn).await.unwrap();

        // Client should reconnect (fresh connect with new token)
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-non-retriable-disconnect",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(
            after_reconnect_seen_rx,
            "after-non-retriable-disconnect message",
        )
        .await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Should get Disconnected (not Error)
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("Token expired"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Should reconnect
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect proves subscription is alive
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-non-retriable-disconnect"));
            after_reconnect_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
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
    let server_task = tokio::spawn(async move {
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
        expect_websocket_closed(&mut conn).await.unwrap();
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
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 15: DETACHED with a client error still follows ably-js re-attach flow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn detached_with_client_error_reattaches() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_detached_seen_tx, after_detached_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // ably-js does not gate DETACHED handling on error retriability:
        // attached channels request ATTACH again regardless of the reason.
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

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for ATTACH after DETACHED")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

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
        send_message(
            &mut conn,
            "ch",
            "after-client-detached",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(after_detached_seen_rx, "after-client-detached message").await;
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
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-client-detached"));
            after_detached_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
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
    let server_task = tokio::spawn(async move {
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
        expect_websocket_closed(&mut conn).await.unwrap();
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
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 17: server-initiated AUTH (action 17) → client renews token
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_initiated_auth() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_auth_seen_tx, after_auth_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
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
        wait_for_test_observation(after_auth_seen_rx, "after-server-auth message").await;
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
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-server-auth"));
            after_auth_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn close_during_server_requested_pending_token_renewal_sends_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (renewal_started_tx, renewal_started_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let auth_request = ProtocolMessage {
            action: action::AUTH,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&auth_request).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for CLOSE during server-requested renewal")
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config_with_pending_renewal(
        ws_port,
        http.port(),
        "ch",
        renewal_started_tx,
    ))
    .await
    .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    tokio::time::timeout(Duration::from_secs(5), renewal_started_rx)
        .await
        .expect("timed out waiting for server-requested token renewal to start")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for CLOSE during pending server-requested renewal")
        .unwrap();
    server_task.await.unwrap();
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

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        // First connection: tiny max_idle_interval, then silence (no heartbeats)
        let mut conn = ws
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

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after heartbeat timeout")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );

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
    });

    let mut timing = TimingConfig::default();
    timing.heartbeat_margin = Duration::from_millis(50);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
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

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 20: retry continues indefinitely and enters suspended after TTL expiry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn retry_enters_suspended_after_connection_state_ttl() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // First connection: handshake then drop
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 20,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        drop(conn);
        // Drop the server so the port is unbound — reconnects fail with
        // "connection refused" immediately instead of hanging on the listener.
        drop(ws);
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
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

    // ably-js does not exhaust reconnect attempts. Once the connection state
    // TTL expires, it moves to suspended retry and keeps trying fresh connects.
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
            .await
            .expect("timed out waiting for suspended transition")
            .unwrap();
        match event {
            Event::Disconnected { reason }
                if reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("connection state expired")) =>
            {
                break;
            }
            Event::Disconnected { .. } => {}
            other => panic!("expected Disconnected while retrying, got {other:?}"),
        }
    }
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
        let _conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        // Keep the socket open; the subscriber should close itself after
        // fatal token-renewal failures.
        std::future::pending::<()>().await;
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

#[tokio::test]
async fn token_renewal_error_backpressure_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

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
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

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
        t.event_channel_capacity = 1;
        t.max_token_renewal_failures = 1;
        t
    });
    let sub = subscribe(config).await.unwrap();

    // Do not consume the initial Connected event. With capacity=1, the fatal
    // renewal Error is backpressured, but the socket must close anyway.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for socket close before subscription close")
        .unwrap();
    sub.close();
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 22: backpressure drops messages when channel is full
// ---------------------------------------------------------------------------

// current_thread runtime is a determinism requirement: we rely on the
// subscriber task's synchronous inner loop (connection.rs processes a batched
// ProtocolMessage's Vec<AblyMessage> with no await between try_send calls)
// being uninterruptible by the consumer task. On a multi_thread runtime,
// the consumer on another OS thread could drain the channel between two
// try_sends, freeing permits and causing more than CAP messages to arrive.
#[tokio::test(flavor = "current_thread")]
async fn backpressure_drops_messages() {
    // Deterministically exercise the try_send backpressure path: pack N
    // messages into ONE ProtocolMessage frame. With channel capacity = 2
    // exactly the first 2 enqueue and the rest are dropped.
    //
    // Two oneshot gates order the mock's sends:
    //   1. `batch_gate` — mock sends the burst only after the consumer has
    //      drained the Connected event, so the channel is empty when the
    //      burst arrives (otherwise Connected would occupy one of the two slots).
    //   2. `sentinel_gate` — after the burst drops, mock sends one more
    //      message. Receiving it proves the subscriber didn't stall — the
    //      real backpressure contract is "drop when slow, don't hang".
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    const BURST: usize = 20;
    const CAP: usize = 2;

    let ws_port = ws.port;
    let (batch_gate_tx, batch_gate_rx) = tokio::sync::oneshot::channel::<()>();
    let (sentinel_gate_tx, sentinel_gate_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake("ch", "conn-1")
            .await
            .expect("mock handshake failed");

        batch_gate_rx.await.expect("batch gate sender dropped");
        let burst = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some("serial-1".into()),
            messages: Some(
                (0..BURST)
                    .map(|i| AblyMessage {
                        id: Some(format!("msg-{i}")),
                        name: Some(format!("msg-{i}")),
                        data: Some(serde_json::json!(i)),
                        timestamp: Some(now_ms()),
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&burst).expect("encode burst failed").into(),
        ))
        .await
        .expect("send burst failed");

        sentinel_gate_rx
            .await
            .expect("sentinel gate sender dropped");
        let sentinel = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            messages: Some(vec![AblyMessage {
                id: Some("sentinel".into()),
                name: Some("sentinel".into()),
                data: Some(serde_json::json!("alive")),
                timestamp: Some(now_ms()),
                ..Default::default()
            }]),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&sentinel)
                .expect("encode sentinel failed")
                .into(),
        ))
        .await
        .expect("send sentinel failed");

        std::future::pending::<()>().await;
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = CAP;
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    batch_gate_tx
        .send(())
        .expect("subscription closed before burst");

    let mut received = 0;
    while let Ok(Some(Event::Message(_))) =
        tokio::time::timeout(Duration::from_secs(2), sub.next()).await
    {
        received += 1;
    }
    assert_eq!(
        received, CAP,
        "batch of {BURST} into a cap-{CAP} channel should deliver exactly {CAP} and drop the rest, got {received} — if this regressed, check connection.rs message-dispatch loop is still synchronous (no .await between try_send calls)"
    );

    sentinel_gate_tx
        .send(())
        .expect("subscription closed before sentinel");
    let next = tokio::time::timeout(Duration::from_secs(2), sub.next())
        .await
        .expect("subscriber stalled after drops — backpressure recovery broken")
        .expect("subscription closed unexpectedly");
    match next {
        Event::Message(m) => assert_eq!(m.name.as_deref(), Some("sentinel")),
        other => panic!("expected sentinel Message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test 23: DETACHED while attaching suspends channel and retries ATTACH
// ---------------------------------------------------------------------------

#[tokio::test]
async fn detached_while_attaching_suspends_and_retries_attach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
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

        // First DETACHED while attached → client sends ATTACH immediately.
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

        // Second DETACHED before ATTACHED means the channel is currently
        // attaching. ably-js moves it to suspended and retries ATTACH on the
        // same active transport after channelRetryTimeout.
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn))
            .await
            .expect("timed out waiting for retry ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

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
        send_message(
            &mut conn,
            "ch",
            "after-channel-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.channel_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Message after the channel retry proves the websocket stayed active and
    // no full reconnect was required.
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-channel-retry")),
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
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
        // Accept TCP but never complete the WebSocket handshake.
        let (tcp, _) = ws.listener.accept().await.unwrap();
        let _hold = tcp; // keep socket open
        std::future::pending::<()>().await;
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
// Test 25: reconnect_timeout retries until connection state becomes suspended
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_timeout_retries_until_suspended() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        // First connection succeeds, then drop
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 250,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        drop(conn);

        // For reconnect attempts: accept TCP but never complete WebSocket
        // handshake — forces reconnect_timeout to fire (not "connection refused").
        while let Ok((tcp, _)) = ws.listener.accept().await {
            tokio::spawn(async move {
                let _hold = tcp;
                // Keep the TCP connection open without completing the
                // WebSocket handshake so reconnect_timeout fires.
                std::future::pending::<()>().await;
            });
        }
    });

    let mut timing = TimingConfig::default();
    timing.reconnect_timeout = Duration::from_millis(100);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
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

    // Each reconnect attempt hangs → reconnect_timeout fires → retry. Matching
    // ably-js, retries do not exhaust; once connection_state_ttl expires, the
    // connection enters suspended retry.
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
            .await
            .expect("timed out waiting for suspended transition")
            .unwrap();
        match event {
            Event::Disconnected { reason }
                if reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("connection state expired")) =>
            {
                break;
            }
            Event::Disconnected { .. } => {}
            other => panic!("expected Disconnected while retrying, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn close_during_hanging_reconnect_attempt_closes_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (mut tcp, _) = ws.listener.accept().await.unwrap();
        accepted_tx.send(()).unwrap();

        let mut buf = Vec::new();
        let _ = tcp.read_to_end(&mut buf).await;
        let _ = closed_tx.send(());
    });

    let mut timing = TimingConfig::default();
    timing.reconnect_timeout = Duration::from_secs(30);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    tokio::time::timeout(Duration::from_secs(5), accepted_rx)
        .await
        .expect("timed out waiting for hanging reconnect attempt")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(1), closed_rx)
        .await
        .expect("hanging reconnect socket was not closed after subscription close")
        .unwrap();

    server_task.await.unwrap();
}

#[tokio::test]
async fn close_during_protocol_disconnected_reconnect_attempt_closes_sockets() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
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

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after protocol DISCONNECTED")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );

        let (mut tcp, _) = ws.listener.accept().await.unwrap();
        accepted_tx.send(()).unwrap();

        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut buf))
            .await
            .expect("hanging reconnect socket was not closed after subscription close")
            .unwrap();

        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::ZERO;
    timing.reconnect_timeout = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for protocol DISCONNECTED")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    tokio::time::timeout(Duration::from_secs(5), accepted_rx)
        .await
        .expect("timed out waiting for reconnect attempt")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for reconnect-attempt close check")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn close_during_reconnect_backoff_stops_before_next_attempt() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (checked_tx, checked_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        assert!(
            tokio::time::timeout(Duration::from_millis(1500), ws.accept_raw())
                .await
                .is_err(),
            "subscription close during reconnect backoff should stop before the next attempt"
        );
        checked_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(250);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    sub.close();

    tokio::time::timeout(Duration::from_secs(3), checked_rx)
        .await
        .expect("timed out waiting for reconnect suppression check")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn close_during_protocol_disconnected_reconnect_backoff_closes_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
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

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close during protocol DISCONNECTED backoff")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );

        assert!(
            tokio::time::timeout(Duration::from_millis(500), ws.accept_raw())
                .await
                .is_err(),
            "subscription close should stop before reconnecting after protocol DISCONNECTED"
        );
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_secs(5);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for protocol DISCONNECTED")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for protocol DISCONNECTED backoff close check")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn close_while_disconnected_event_send_is_backpressured_stops_without_reconnect() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_sent_tx, close_sent_rx) = tokio::sync::oneshot::channel::<()>();
    let (checked_tx, checked_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "rotate".into(),
        }))
        .await
        .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(250), ws.accept_raw())
                .await
                .is_err(),
            "full event channel should backpressure Disconnected before reconnect"
        );
        blocked_tx.send(()).unwrap();
        close_sent_rx.await.unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(500), ws.accept_raw())
                .await
                .is_err(),
            "subscription close should stop the backpressured event loop before reconnect"
        );
        checked_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Do not consume the initial Connected event. With capacity=1, the next
    // status event blocks until close drops the receiver.
    tokio::time::timeout(Duration::from_secs(5), blocked_rx)
        .await
        .expect("timed out waiting for status-event backpressure")
        .unwrap();

    sub.close();
    close_sent_tx.send(()).unwrap();

    tokio::time::timeout(Duration::from_secs(5), checked_rx)
        .await
        .expect("timed out waiting for reconnect suppression after close")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn close_while_protocol_disconnected_backpressure_closes_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_sent_tx, close_sent_rx) = tokio::sync::oneshot::channel::<()>();
    let (checked_tx, checked_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
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

        expect_websocket_close_frame(&mut conn).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), ws.accept_raw())
                .await
                .is_err(),
            "full event channel should backpressure protocol DISCONNECTED before reconnect"
        );
        closed_tx.send(()).unwrap();
        close_sent_rx.await.unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(500), ws.accept_raw())
                .await
                .is_err(),
            "subscription close should stop before reconnecting after protocol DISCONNECTED"
        );
        checked_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Do not consume the initial Connected event. With capacity=1, the
    // protocol DISCONNECTED status event is backpressured, but the socket must
    // close before the subscription is explicitly closed.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for protocol DISCONNECTED socket close")
        .unwrap();

    sub.close();
    close_sent_tx.send(()).unwrap();

    tokio::time::timeout(Duration::from_secs(5), checked_rx)
        .await
        .expect("timed out waiting for protocol DISCONNECTED close check")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn drop_while_protocol_disconnected_backpressure_closes_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel::<()>();
    let (checked_tx, checked_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
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

        expect_websocket_close_frame(&mut conn).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), ws.accept_raw())
                .await
                .is_err(),
            "full event channel should backpressure protocol DISCONNECTED before reconnect"
        );
        closed_tx.send(()).unwrap();
        dropped_rx.await.unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(500), ws.accept_raw())
                .await
                .is_err(),
            "subscription drop should stop before reconnecting after protocol DISCONNECTED"
        );
        checked_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Do not consume the initial Connected event. With capacity=1, the
    // protocol DISCONNECTED status event is backpressured, but the socket must
    // close before the subscription is dropped.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for protocol DISCONNECTED socket close")
        .unwrap();

    drop(sub);
    dropped_tx.send(()).unwrap();

    tokio::time::timeout(Duration::from_secs(5), checked_rx)
        .await
        .expect("timed out waiting for protocol DISCONNECTED drop check")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn heartbeat_backpressure_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 25,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    timing.heartbeat_margin = Duration::from_millis(25);
    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Do not consume the initial Connected event. The heartbeat Disconnected
    // status event is backpressured, but the stale socket must still close.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for heartbeat socket close")
        .unwrap();
    sub.close();
    server_task.await.unwrap();
}

#[tokio::test]
async fn close_while_connected_event_send_is_backpressured_closes_reconnected_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (reconnected_tx, reconnected_rx) = tokio::sync::oneshot::channel::<()>();
    let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_sent_tx, close_sent_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        reconnected_tx.send(()).unwrap();

        match tokio::time::timeout(Duration::from_millis(250), conn2.next()).await {
            Err(_) => {}
            Ok(frame) => {
                panic!(
                    "queued Disconnected event should backpressure the post-reconnect Connected event, got {frame:?}"
                );
            }
        }
        blocked_tx.send(()).unwrap();
        close_sent_rx.await.unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for CLOSE after connected-event backpressure")
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);

        let frame = tokio::time::timeout(Duration::from_secs(5), conn2.next())
            .await
            .expect("timed out waiting for websocket close after connected-event backpressure")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    tokio::time::timeout(Duration::from_secs(5), reconnected_rx)
        .await
        .expect("timed out waiting for reconnect")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), blocked_rx)
        .await
        .expect("timed out waiting for connected-event backpressure")
        .unwrap();

    sub.close();
    close_sent_tx.send(()).unwrap();

    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for reconnected socket close")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn error_event_backpressure_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let error = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 40000,
                status_code: Some(400),
                message: "bad request".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error).unwrap().into(),
        ))
        .await
        .unwrap();

        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Do not consume the initial Connected event. With capacity=1, the fatal
    // Error status event is backpressured, but the socket must close anyway.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for socket close before subscription close")
        .unwrap();
    sub.close();
    server_task.await.unwrap();
}

#[tokio::test]
async fn channel_error_backpressure_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let error = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 40001,
                status_code: Some(400),
                message: "channel failed".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error).unwrap().into(),
        ))
        .await
        .unwrap();

        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Do not consume the initial Connected event. The channel-scoped fatal
    // Error status event is backpressured, but the socket must close anyway.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for channel error socket close")
        .unwrap();
    sub.close();
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 26: expired connection_state_ttl skips resume (fresh connect)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn expired_ttl_skips_resume() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (resume_tx, resume_rx) = tokio::sync::oneshot::channel::<bool>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = tokio::spawn(async move {
        // First connection with an already-expired connection_state_ttl.
        // The server-provided TTL overrides the TimingConfig default, so we
        // set it here to ensure can_resume() is false on reconnect.
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 0,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
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
        wait_for_test_observation(message_seen_rx, "after-fresh-connect message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
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

    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
            .await
            .expect("timed out waiting for Connected")
            .unwrap();
        match event {
            Event::Connected => break,
            Event::Disconnected { .. } => {}
            other => panic!("expected Connected, got {other:?}"),
        }
    }

    // Message after fresh connect
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-fresh-connect"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Verify server saw ATTACH (meaning client did NOT resume)
    let did_attach = resume_rx.await.expect("server task panicked");
    assert!(did_attach, "client should have sent ATTACH (no resume)");
    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 27: resumed connection still re-attaches channel
// ---------------------------------------------------------------------------

/// Regression test: when the server returns the same connection_id (resume),
/// the client must still send ATTACH. Before the fix, resumed connections
/// skipped ATTACH entirely, creating "zombie subscriptions" where the channel
/// silently lost state and messages stopped being delivered.
#[tokio::test]
async fn resumed_connection_reattaches_channel() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (attach_tx, attach_rx) = tokio::sync::oneshot::channel::<bool>();
    let (connected_seen_tx, connected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = tokio::spawn(async move {
        // First connection
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        wait_for_test_observation(connected_seen_rx, "initial Connected event").await;
        drop(conn);

        // Second connection — use the SAME conn_id to simulate a successful resume.
        // The client should still send ATTACH despite the resume.
        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut ws_stream = tokio_tungstenite::accept_async(tcp).await.unwrap();

        // Send CONNECTED with the same connection_id → client sees this as resume
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-1".into()),
            connection_key: Some("conn-1!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-1!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        ws_stream
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        // Client should send ATTACH even though connection was resumed.
        let msg = read_protocol_msg(&mut ws_stream).await.unwrap();
        assert_eq!(
            msg.action,
            action::ATTACH,
            "client must send ATTACH on resume"
        );
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        let _ = attach_tx.send(true);

        // Send ATTACHED
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-resumed".into()),
            ..Default::default()
        };
        ws_stream
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();

        // Send a message to prove the subscription is alive
        send_message(
            &mut ws_stream,
            "ch",
            "after-resume",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-resume message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));
    connected_seen_tx.send(()).unwrap();

    // Wait for disconnect → reconnect cycle
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

    // Message after resumed reconnect proves subscription is alive
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after resume")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-resume"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Verify server saw ATTACH (meaning client re-attached despite resume)
    let did_attach = attach_rx.await.expect("server task panicked");
    assert!(
        did_attach,
        "client must send ATTACH even on resumed connection"
    );
    server_task.await.unwrap();
}

#[tokio::test]
async fn detached_during_reconnect_attach_retries_channel_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "attach rejected temporarily".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for channel retry ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-retry".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-reconnect-channel-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-reconnect-channel-retry message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.channel_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected after channel retry")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after channel retry, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after channel retry")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reconnect-channel-retry"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn superseded_error_during_reconnect_attach_retries_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let superseded = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&superseded).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for retry ATTACH after 80016")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-retry".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-superseded-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-superseded-retry message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected after retry ATTACH")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after retry ATTACH, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after retry ATTACH")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-superseded-retry"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn other_channel_error_during_reconnect_attach_is_ignored() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let other_channel_error = ProtocolMessage {
            action: action::ERROR,
            channel: Some("other-channel".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&other_channel_error).unwrap().into(),
            ))
            .await
            .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(250), conn2.next())
                .await
                .is_err(),
            "other-channel ERROR should not close the socket or trigger another ATTACH"
        );

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-ok".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-other-channel-error",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-other-channel-error message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-other-channel-error"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn disconnected_during_reconnect_attach_retries_with_new_connection() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let disconnected = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "server disconnected during attach".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&disconnected).unwrap().into(),
            ))
            .await
            .unwrap();

        let mut conn3 = tokio::time::timeout(
            Duration::from_secs(5),
            ws.accept_and_handshake("ch", "conn-3"),
        )
        .await
        .expect("timed out waiting for reconnect after DISCONNECTED during attach")
        .unwrap();
        send_message(
            &mut conn3,
            "ch",
            "after-disconnected-during-attach",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected after reconnect attach DISCONNECTED")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after reconnect attach DISCONNECTED, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after reconnect attach DISCONNECTED")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(
                msg.name.as_deref(),
                Some("after-disconnected-during-attach")
            );
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn closed_during_reconnect_attach_stops_subscription() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let closed = ProtocolMessage {
            action: action::CLOSED,
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&closed).unwrap().into(),
            ))
            .await
            .unwrap();
        expect_websocket_closed(&mut conn2).await.unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for subscription to end after CLOSED during attach");
    assert!(
        event.is_none(),
        "expected stream end after CLOSED, got {event:?}"
    );

    server_task.await.unwrap();
}

#[tokio::test]
async fn superseded_reconnect_attach_timeout_retries_channel_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let superseded = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&superseded).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for retry ATTACH after 80016")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for channel retry ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-after-timeout".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-superseded-timeout",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-superseded-timeout message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.channel_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_millis(20);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected after channel retry")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after channel retry, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after channel retry")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-superseded-timeout"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

#[tokio::test]
async fn close_during_reconnect_attach_wait_closes_temporary_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (attach_sent_tx, attach_sent_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        attach_sent_tx.send(()).unwrap();

        expect_websocket_closed(&mut conn2).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    tokio::time::timeout(Duration::from_secs(5), attach_sent_rx)
        .await
        .expect("timed out waiting for reconnect ATTACH")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for reconnect attach socket close")
        .unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn reconnect_attach_timeout_retries_channel_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for reconnect ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        // Do not answer the first ATTACH. The client should treat this as a
        // channel attach timeout, keep conn-2 connected, and retry ATTACH on
        // the same websocket instead of opening conn-3.
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for channel retry ATTACH")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-retry".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-reconnect-attach-timeout",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-reconnect-attach-timeout message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.channel_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_millis(20);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for Connected after channel retry")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after channel retry, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message after channel retry")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reconnect-attach-timeout"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 28: detach after reconnect reattaches on the active transport
// ---------------------------------------------------------------------------

/// Sequence: DETACH → send ATTACH → connection drops → reconnect succeeds →
/// DETACH on new connection → client should send ATTACH (not open conn-3).
#[tokio::test]
async fn detach_after_reconnect_reattaches_not_full_reconnect() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn1 = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

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

        // DETACH while attached → client sends ATTACH.
        conn1
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn1))
            .await
            .expect("timed out waiting for ATTACH on conn-1")
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);

        // Drop connection before sending ATTACHED — simulates connection loss
        drop(conn1);

        // Client reconnects (conn-2)
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();

        // Send DETACH on the new connection. ably-js re-attaches on the active
        // transport instead of forcing a full reconnect.
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        // Client should send ATTACH (re-attach), NOT open a third connection
        let msg = tokio::time::timeout(Duration::from_secs(5), read_protocol_msg(&mut conn2))
            .await
            .expect("timed out waiting for ATTACH on conn-2 (got full reconnect instead?)")
            .unwrap();
        assert_eq!(
            msg.action,
            action::ATTACH,
            "expected re-attach on conn-2, not full reconnect"
        );

        // Complete the re-attach
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();

        send_message(&mut conn2, "ch", "after-reattach", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(message_seen_rx, "after-reattach message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    assert!(matches!(sub.next().await.unwrap(), Event::Connected));

    // Disconnected → reconnect → Connected
    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Disconnected")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("timed out waiting for Connected")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after re-attach on conn-2 proves we didn't do a full reconnect
    let event = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("timed out waiting for message")
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reattach"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    server_task.await.unwrap();
}
