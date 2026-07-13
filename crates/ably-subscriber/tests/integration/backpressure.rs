use crate::support::*;
use ably_subscriber::protocol::{AblyMessage, ErrorInfo, ProtocolMessage, action, encode_msg};
use ably_subscriber::{Event, SubscribeConfig, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio_tungstenite::tungstenite;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

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

// current_thread runtime is a determinism requirement: we rely on the
// subscriber task's synchronous event-loop dispatch processes a batched
// ProtocolMessage's Vec<AblyMessage> with no await between try_send calls)
// being uninterruptible by the consumer task. On a multi_thread runtime,
// the consumer on another OS thread could drain the channel between two
// try_sends, freeing permits and causing more than CAP messages to arrive.
#[tokio::test(flavor = "current_thread")]
async fn backpressure_counts_drops_and_bounds_warnings() {
    // Deterministically exercise the try_send backpressure path: pack N
    // messages into ONE ProtocolMessage frame. With channel capacity = 2
    // exactly the first 2 enqueue and the rest are dropped.
    //
    // Oneshot gates order the mock's sends:
    //   1. `batch_gate` — mock sends the burst only after the consumer has
    //      drained the Connected event, so the channel is empty when the
    //      burst arrives (otherwise Connected would occupy one of the two slots).
    //   2. `saturation_processed` — a DETACHED/ATTACH round trip proves the
    //      subscriber processed the burst and following single-message frames.
    //   3. `sentinel_gate` — after the burst drops, mock sends one more
    //      message. Receiving it proves the subscriber didn't stall — the
    //      real backpressure contract is "drop when slow, don't hang".
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    const BURST: usize = 20;
    const SINGLE_MESSAGE_FRAMES: usize = 5;
    const CAP: usize = 2;
    const REPORT_INTERVAL: Duration = Duration::from_secs(60);
    const EXPECTED_DROPPED: usize = BURST + SINGLE_MESSAGE_FRAMES - CAP;

    let ws_port = ws.port;
    let (batch_gate_tx, batch_gate_rx) = tokio::sync::oneshot::channel::<()>();
    let (saturation_processed_tx, saturation_processed_rx) = tokio::sync::oneshot::channel::<()>();
    let (sentinel_gate_tx, sentinel_gate_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 0,
                    ..Default::default()
                },
            )
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

        for i in 0..SINGLE_MESSAGE_FRAMES {
            let message = ProtocolMessage {
                action: action::MESSAGE,
                channel: Some("ch".into()),
                channel_serial: Some(format!("serial-extra-{i}")),
                messages: Some(vec![AblyMessage {
                    id: Some(format!("extra-{i}")),
                    name: Some(format!("extra-{i}")),
                    data: Some(serde_json::json!(i)),
                    timestamp: Some(now_ms()),
                    ..Default::default()
                }]),
                ..Default::default()
            };
            conn.send(tungstenite::Message::Binary(
                encode_msg(&message)
                    .expect("encode single-message frame failed")
                    .into(),
            ))
            .await
            .expect("send single-message frame failed");
        }

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached)
                .expect("encode DETACHED failed")
                .into(),
        ))
        .await
        .expect("send DETACHED failed");
        let attach = expect_protocol_msg(&mut conn, "client ATTACH after saturation")
            .await
            .expect("read client ATTACH after saturation");
        assert_eq!(attach.action, action::ATTACH);
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-attached".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached)
                .expect("encode ATTACHED failed")
                .into(),
        ))
        .await
        .expect("send ATTACHED failed");
        saturation_processed_tx
            .send(())
            .expect("saturation observer dropped");

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
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    batch_gate_tx
        .send(())
        .expect("subscription closed before burst");
    wait_for_test_observation(
        saturation_processed_rx,
        "subscriber processing saturated frames",
    )
    .await;
    tokio::time::pause();
    tokio::time::advance(REPORT_INTERVAL).await;
    tokio::time::resume();

    let expected_total = EXPECTED_DROPPED.to_string();
    let drop_warnings = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let warnings = captured
                .entries()
                .into_iter()
                .filter(|event| {
                    event
                        .fields
                        .get("message")
                        .is_some_and(|message| message == "event channel full, dropping message")
                })
                .collect::<Vec<_>>();
            if warnings.last().is_some_and(|warning| {
                warning
                    .fields
                    .get("total_dropped")
                    .is_some_and(|total| total == &expected_total)
            }) {
                break warnings;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("timed out waiting for exact deferred drop warning");

    let expected_since_last = (EXPECTED_DROPPED - 1).to_string();
    assert_eq!(
        drop_warnings.len(),
        2,
        "expected one immediate and one deferred drop warning: {drop_warnings:#?}"
    );
    assert_eq!(
        drop_warnings[0]
            .fields
            .get("dropped_since_last")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        drop_warnings[0]
            .fields
            .get("total_dropped")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        drop_warnings[1]
            .fields
            .get("dropped_since_last")
            .map(String::as_str),
        Some(expected_since_last.as_str())
    );
    assert_eq!(
        drop_warnings[1]
            .fields
            .get("total_dropped")
            .map(String::as_str),
        Some(expected_total.as_str())
    );

    let mut received = 0;
    for _ in 0..CAP {
        let event = tokio::time::timeout(Duration::from_secs(2), sub.next())
            .await
            .expect("timed out waiting for buffered message")
            .expect("subscription closed before buffered message");
        match event {
            Event::Message(_) => received += 1,
            other => panic!("expected buffered Message, got {other:?}"),
        }
    }
    assert_eq!(
        received, CAP,
        "{BURST} batched and {SINGLE_MESSAGE_FRAMES} single-frame messages into a cap-{CAP} channel should deliver exactly {CAP}, got {received}"
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
