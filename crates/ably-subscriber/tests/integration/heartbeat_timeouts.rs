use crate::support::*;
use ably_subscriber::protocol::{ErrorInfo, ProtocolMessage, action, encode_msg};
use ably_subscriber::{Event, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

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

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Disconnected from heartbeat timeout
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Reconnected
    let event = expect_event(&mut sub, "Connected").await.unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect
    let event = expect_event(&mut sub, "message").await.unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-hb-timeout")),
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn inbound_activity_refreshes_heartbeat_deadline() {
    const MAX_IDLE_INTERVAL_MS: i64 = 20_000;
    const HEARTBEAT_MARGIN: Duration = Duration::from_secs(10);
    const ACTIVITY_DELAY: Duration = Duration::from_secs(10);
    const FRAME_DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
    const ORIGINAL_DEADLINE_OBSERVATION: Duration = Duration::from_secs(21);

    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let (step_tx, mut step_rx) = tokio::sync::mpsc::channel(1);
    let (activity_sent_tx, activity_sent_rx) = tokio::sync::oneshot::channel();
    let (sentinel_sent_tx, sentinel_sent_rx) = tokio::sync::oneshot::channel();
    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: MAX_IDLE_INTERVAL_MS,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        step_rx.recv().await.expect("activity step was dropped");
        tokio::time::sleep(ACTIVITY_DELAY).await;
        send_message(
            &mut conn,
            "ch",
            "activity-before-original-deadline",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        activity_sent_tx.send(()).unwrap();

        step_rx.recv().await.expect("sentinel step was dropped");
        send_message(
            &mut conn,
            "ch",
            "after-original-deadline",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        sentinel_sent_tx.send(()).unwrap();

        let msg = expect_protocol_msg(&mut conn, "CLOSE after sentinel")
            .await
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);
        expect_websocket_close_frame(&mut conn).await.unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.heartbeat_margin = HEARTBEAT_MARGIN;
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    tokio::time::pause();

    step_tx.send(()).await.unwrap();
    activity_sent_rx.await.unwrap();
    // Real loopback I/O needs resumed time so Tokio does not advance directly
    // from the virtual activity delay to the next heartbeat timer.
    tokio::time::resume();
    let event = expect_event_with_timeout(
        &mut sub,
        FRAME_DELIVERY_TIMEOUT,
        "activity before original heartbeat deadline",
    )
    .await
    .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(
                msg.name.as_deref(),
                Some("activity-before-original-deadline")
            );
        }
        other => panic!("expected activity Message, got {other:?}"),
    }
    tokio::time::pause();

    // The original deadline is 30s. Activity arrives by 15s, so this quiet
    // window crosses the original deadline but stays inside the refreshed one.
    let event_before_sentinel =
        tokio::time::timeout(ORIGINAL_DEADLINE_OBSERVATION, sub.next()).await;
    assert!(
        event_before_sentinel.is_err(),
        "expected no event after the original deadline, got {event_before_sentinel:?}"
    );

    step_tx.send(()).await.unwrap();
    sentinel_sent_rx.await.unwrap();
    tokio::time::resume();
    let event = expect_event_with_timeout(
        &mut sub,
        FRAME_DELIVERY_TIMEOUT,
        "sentinel after original heartbeat deadline",
    )
    .await
    .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-original-deadline"));
        }
        other => panic!("expected sentinel Message, got {other:?}"),
    }

    sub.close_and_wait().await.unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn zero_max_idle_interval_disables_heartbeat_timeout() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let (advance_tx, advance_rx) = tokio::sync::oneshot::channel();
    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
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
            .unwrap();

        // Old behavior treated maxIdleInterval=0 as heartbeat_margin and
        // disconnected before this message. Ably semantics disable the idle
        // timeout when no maximum idle interval is promised.
        advance_rx.await.unwrap();
        tokio::time::advance(Duration::from_secs(2)).await;
        send_message(&mut conn, "ch", "after-zero-idle", serde_json::json!("ok"))
            .await
            .unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.heartbeat_margin = Duration::from_secs(1);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    tokio::time::pause();
    let _ = advance_tx.send(());

    let event = expect_event(&mut sub, "message after zero idle interval")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-zero-idle")),
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn channel_retry_timers_do_not_extend_heartbeat_deadline() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 80,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

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

        let msg = expect_protocol_msg(&mut conn, "reattach").await.unwrap();
        assert_eq!(msg.action, action::ATTACH);

        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "retry attach")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);

        expect_websocket_close_frame_while_ignoring_attach(&mut conn)
            .await
            .unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-channel-retry-heartbeat",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.heartbeat_margin = Duration::from_millis(40);
    timing.realtime_request_timeout = Duration::from_millis(30);
    timing.channel_retry_timeout = Duration::from_millis(30);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = expect_event(&mut sub, "Connected after heartbeat reconnect")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after heartbeat reconnect, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after heartbeat reconnect")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-channel-retry-heartbeat"));
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

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

#[tokio::test]
async fn reconnect_timeout_retries_until_suspended() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
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
        let mut held_connection = None;
        loop {
            let (tcp, _) = ws.listener.accept().await.unwrap();
            drop(held_connection.replace(tcp));
        }
    });

    let mut timing = TimingConfig::default();
    timing.reconnect_timeout = Duration::from_millis(100);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Disconnected
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    // Each reconnect attempt hangs → reconnect_timeout fires → retry. Matching
    // ably-js, retries do not exhaust; once connection_state_ttl expires, the
    // connection enters suspended retry.
    let suspended_transition = expect_event_matching_before(
        async || sub.next().await,
        Instant::now() + RECONNECT_EVENT_TIMEOUT,
        "Disconnected reason containing connection state expired",
        |event| match event {
            Event::Disconnected { reason }
                if reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("connection state expired")) =>
            {
                Ok(true)
            }
            Event::Disconnected { .. } => Ok(false),
            other => Err(format!(
                "expected Disconnected while retrying, got {other:?}"
            )),
        },
    )
    .await;
    sub.close();
    let cleanup = abort_server_task(server_task, "mock server").await;

    match (suspended_transition, cleanup) {
        (Ok(_), Ok(())) => {}
        (Ok(_), Err(cleanup_error)) => panic!("{cleanup_error}"),
        (Err(error), Ok(())) => panic!("{error}"),
        (Err(error), Err(cleanup_error)) => {
            panic!("{error}; cleanup failed: {cleanup_error}")
        }
    }
}
