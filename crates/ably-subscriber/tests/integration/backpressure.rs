use crate::support::*;
use ably_subscriber::protocol::{AblyMessage, ErrorInfo, ProtocolMessage, action, encode_msg};
use ably_subscriber::{Event, SubscribeConfig, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio_tungstenite::tungstenite;

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
    join_server_task(server_task, "mock server").await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 22: backpressure drops messages when channel is full
// ---------------------------------------------------------------------------

// current_thread runtime is a determinism requirement: we rely on the
// subscriber task's synchronous event-loop dispatch processes a batched
// ProtocolMessage's Vec<AblyMessage> with no await between try_send calls)
// being uninterruptible by the consumer task. On a multi_thread runtime,
// the consumer on another OS thread could drain the channel between two
// try_sends, freeing permits and causing more than CAP messages to arrive.

// current_thread runtime is a determinism requirement: we rely on the
// subscriber task's synchronous event-loop dispatch processes a batched
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

    expect_connected(&mut sub, "Connected event").await.unwrap();
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
        "batch of {BURST} into a cap-{CAP} channel should deliver exactly {CAP} and drop the rest, got {received} — if this regressed, check event-loop message dispatch is still synchronous (no .await between try_send calls)"
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
    join_server_task(server_task, "mock server").await.unwrap();
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
    join_server_task(server_task, "mock server").await.unwrap();
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
    join_server_task(server_task, "mock server").await.unwrap();
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
    join_server_task(server_task, "mock server").await.unwrap();
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

        let msg = expect_protocol_msg(&mut conn2, "CLOSE after connected-event backpressure")
            .await
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

    expect_connected(&mut sub, "Connected event").await.unwrap();
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
    join_server_task(server_task, "mock server").await.unwrap();
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
    join_server_task(server_task, "mock server").await.unwrap();
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
    join_server_task(server_task, "mock server").await.unwrap();
}

// ---------------------------------------------------------------------------
// Test 26: non-positive connection_state_ttl keeps the default resume window
// ---------------------------------------------------------------------------
