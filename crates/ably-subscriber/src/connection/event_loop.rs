//! Event loop, reconnection, and token renewal.

use std::{collections::HashMap, time::Duration};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

use super::auth::exchange_token;
use super::endpoint::build_ws_url;
use super::errors::{
    channel_detached_message, error_or_unknown, protocol_disconnect_reason, protocol_error_message,
};
use super::handshake::{
    AttachOutcome, encode_attach_for_channel, wait_for_attach_outcome, wait_for_connected,
};
use super::message::{decode_data, message_targets_channel};
use super::state::{
    ChannelLifecycleState, ConnState, ConnectionLifecycleState, RealtimeStateMachine,
    checked_deadline_after, checked_deadline_from, idle_deadline, reconnect_spacing_delay,
    retry_delay,
};
use super::transport::{
    WsTransport, connect_and_split, websocket_close_frame_reason, websocket_close_reason,
    websocket_error_reason,
};
use crate::Error;
use crate::protocol::{
    AuthDetails, ProtocolMessage, action, decode_msg, encode_msg, error_code, flags,
};
use crate::types::{Event, Message, TimingConfig, TokenFuture};

pub(crate) struct EventLoopState {
    pub transport: Option<WsTransport>,
    pub event_tx: mpsc::Sender<Event>,
    pub conn_state: ConnState,
    pub lifecycle: RealtimeStateMachine,
    pub channel: String,
    pub channel_params: Option<HashMap<String, String>>,
    pub realtime_host: String,
    pub rest_host: String,
    pub http: reqwest::Client,
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    pub timing: TimingConfig,
    pub token_renewal_failures: u32,
    pub dropped_messages: u64,
    pub channel_retry_at: Option<Instant>,
    pub channel_retry_count: u32,
    pub channel_operation_deadline: Option<Instant>,
    pub connected_event_pending: bool,
}

async fn sleep_until_optional(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn request_channel_attach(p: &mut EventLoopState) -> bool {
    p.lifecycle.request_channel_attaching();
    if p.lifecycle.channel != ChannelLifecycleState::Attaching
        || !p.lifecycle.connection.send_events()
    {
        return false;
    }

    p.channel_retry_at = None;
    p.channel_operation_deadline = checked_deadline_after(p.timing.realtime_request_timeout);
    true
}

fn schedule_channel_retry(p: &mut EventLoopState) {
    p.channel_operation_deadline = None;
    if p.lifecycle.channel == ChannelLifecycleState::Suspended
        && p.lifecycle.connection.send_events()
    {
        p.channel_retry_count += 1;
        p.channel_retry_at = checked_deadline_after(retry_delay(
            p.timing.channel_retry_timeout,
            p.channel_retry_count,
        ));
    } else {
        p.channel_retry_at = None;
    }
}

fn notify_channel_suspended(p: &mut EventLoopState) {
    p.conn_state.channel_serial = None;
    p.lifecycle.notify_channel_suspended();
    schedule_channel_retry(p);
}

fn notify_channel_attached(p: &mut EventLoopState) {
    p.lifecycle.notify_channel_attached();
    p.channel_retry_at = None;
    p.channel_retry_count = 0;
    p.channel_operation_deadline = None;
}

fn notify_channel_failed(p: &mut EventLoopState) {
    p.conn_state.channel_serial = None;
    p.lifecycle.notify_channel_failed();
    p.channel_retry_at = None;
    p.channel_operation_deadline = None;
    p.connected_event_pending = false;
}

fn suspend_deadline(p: &EventLoopState) -> Option<Instant> {
    if p.lifecycle.connection == ConnectionLifecycleState::Suspended
        || p.conn_state.connection_key.is_none()
    {
        return None;
    }
    p.conn_state.disconnected_at.and_then(|disconnected_at| {
        checked_deadline_from(disconnected_at, p.conn_state.connection_state_ttl)
    })
}

fn should_enter_suspended_retry(p: &EventLoopState) -> bool {
    p.lifecycle.connection != ConnectionLifecycleState::Suspended
        && p.conn_state.disconnected_at.is_some()
        && !p.conn_state.can_resume()
}

async fn enter_suspended_retry(
    p: &mut EventLoopState,
    close_rx: &mut oneshot::Receiver<()>,
) -> bool {
    p.conn_state.clear_resume_state();
    p.lifecycle.notify_suspended();
    p.conn_state.channel_serial = None;
    p.channel_retry_at = None;
    p.channel_operation_deadline = None;
    p.connected_event_pending = false;
    let event = Event::Disconnected {
        reason: Some("connection state expired; entering suspended retry".to_string()),
    };
    send_status_event(p, close_rx, event, "suspended").await
}

// Caller-requested shutdown should send Ably CLOSE before closing the WebSocket
// so the connection state is explicitly terminated.
async fn send_close_message(p: &mut EventLoopState) {
    p.lifecycle.request_closing();
    let Some(transport) = p.transport.take() else {
        p.lifecycle.notify_closed();
        return;
    };
    let WsTransport {
        ws_read: _ws_read,
        mut ws_write,
    } = transport;
    let close_timeout = p.timing.close_timeout;
    let result = tokio::time::timeout(close_timeout, async move {
        let close_msg = ProtocolMessage {
            action: action::CLOSE,
            ..Default::default()
        };
        if let Ok(data) = encode_msg(&close_msg) {
            let _ = ws_write
                .send(tungstenite::Message::Binary(data.into()))
                .await;
        }
        let _ = ws_write.close().await;
    })
    .await;
    if result.is_err() {
        tracing::warn!(
            timeout_ms = close_timeout.as_millis(),
            "Timed out while closing websocket"
        );
    }
    p.lifecycle.notify_closed();
}

// Reconnect paths should only close the current WebSocket transport. Sending
// Ably CLOSE here would terminate the resumable connection state on the server.
//
// The transport is detached synchronously so status events and reconnects are
// not delayed by a slow close handshake. The bounded background close still
// releases the socket without keeping it in `EventLoopState`.
fn close_websocket_transport(p: &mut EventLoopState) {
    let Some(transport) = p.transport.take() else {
        return;
    };
    let WsTransport {
        ws_read: _ws_read,
        mut ws_write,
    } = transport;
    let close_timeout = p.timing.close_timeout;
    let close_task = tokio::spawn(async move {
        let result = tokio::time::timeout(close_timeout, async move {
            let _ = ws_write.close().await;
        })
        .await;
        if result.is_err() {
            tracing::warn!(
                timeout_ms = close_timeout.as_millis(),
                "Timed out while closing websocket transport"
            );
        }
    });
    drop(close_task);
}

async fn send_status_event(
    p: &mut EventLoopState,
    close_rx: &mut oneshot::Receiver<()>,
    event: Event,
    status_event: &'static str,
) -> bool {
    tokio::select! {
        biased;
        _ = &mut *close_rx => {
            tracing::info!(status_event, "Close requested while sending status event");
            send_close_message(p).await;
            false
        }
        result = p.event_tx.send(event) => result.is_ok(),
    }
}

async fn send_terminal_status_event(
    p: &mut EventLoopState,
    close_rx: &mut oneshot::Receiver<()>,
    event: Event,
    status_event: &'static str,
) -> bool {
    // Terminal status events can be backpressured by a slow consumer. Release
    // the socket first so an unpolled Subscription cannot keep it alive.
    close_websocket_transport(p);
    send_status_event(p, close_rx, event, status_event).await
}

pub(crate) async fn run_event_loop(mut p: EventLoopState, mut close_rx: oneshot::Receiver<()>) {
    let mut last_reconnect_attempt: Option<Instant> = None;

    'outer: loop {
        let mut disconnected_sent = false;
        let mut immediate_retry = false;
        let mut disconnect_reason = None;
        let mut close_before_reconnect = false;
        // Main message processing loop
        loop {
            if p.channel_operation_deadline
                .is_some_and(|deadline| deadline <= Instant::now())
            {
                p.channel_operation_deadline = None;
                if p.lifecycle.channel == ChannelLifecycleState::Attaching {
                    tracing::warn!(
                        timeout_ms = p.timing.realtime_request_timeout.as_millis(),
                        "Channel attach timed out, entering suspended channel retry"
                    );
                    notify_channel_suspended(&mut p);
                }
                continue;
            }

            if p.channel_retry_at
                .is_some_and(|deadline| deadline <= Instant::now())
            {
                p.channel_retry_at = None;
                if p.lifecycle.channel == ChannelLifecycleState::Suspended
                    && request_channel_attach(&mut p)
                {
                    match send_attach(&mut p, &mut close_rx).await {
                        LoopAction::Stop => return,
                        LoopAction::Reconnect { disconnected_event } => {
                            record_reconnect_disconnected_event(
                                &mut disconnected_sent,
                                disconnected_event,
                            );
                            immediate_retry = true;
                            break;
                        }
                        LoopAction::Continue => {}
                    }
                }
                continue;
            }

            let Some(transport) = p.transport.as_mut() else {
                tracing::warn!("WebSocket transport missing before receive loop");
                break;
            };
            let idle_deadline =
                idle_deadline(p.conn_state.max_idle_interval, p.timing.heartbeat_margin);

            tokio::select! {
                biased;

                _ = &mut close_rx => {
                    tracing::info!("Close requested");
                    send_close_message(&mut p).await;
                    return;
                }

                _ = sleep_until_optional(p.conn_state.token_renewal_at), if p.conn_state.token_renewal_at.is_some() => {
                    let connect_timeout = p.timing.connect_timeout;
                    let result = tokio::select! {
                        biased;
                        _ = &mut close_rx => {
                            tracing::info!("Close requested during token renewal");
                            send_close_message(&mut p).await;
                            return;
                        }
                        result = tokio::time::timeout(connect_timeout, renew_token(&mut p)) => result,
                    };
                    if handle_renewal_result(&mut p, &mut close_rx, result).await {
                        return;
                    }
                }

                _ = sleep_until_optional(p.channel_operation_deadline), if p.channel_operation_deadline.is_some() => {}

                _ = sleep_until_optional(p.channel_retry_at), if p.channel_retry_at.is_some() => {}

                frame = transport.ws_read.next() => {
                    match frame {
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            match decode_msg(&data) {
                                Ok(msg) => {
                                    match handle_message(&mut p, msg, &mut close_rx).await {
                                        LoopAction::Stop => return,
                                        LoopAction::Reconnect {
                                            disconnected_event,
                                        } => {
                                            record_reconnect_disconnected_event(
                                                &mut disconnected_sent,
                                                disconnected_event,
                                            );
                                            immediate_retry = true;
                                            break;
                                        }
                                        LoopAction::Continue => {}
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("Failed to decode message: {e}");
                                }
                            }
                        }
                        Some(Ok(tungstenite::Message::Close(frame))) => {
                            let reason = websocket_close_reason(frame.as_ref());
                            if let Some(ref f) = frame {
                                let close_reason = websocket_close_frame_reason(f);
                                tracing::info!(
                                    code = %f.code,
                                    reason = %close_reason,
                                    "WebSocket Close frame received",
                                );
                            } else {
                                tracing::info!("WebSocket Close frame received without close frame");
                            }
                            disconnect_reason = Some(reason);
                            immediate_retry = true;
                            close_before_reconnect = true;
                            break; // → reconnect
                        }
                        Some(Ok(_)) => {
                            // Ignore text, ping, pong frames
                        }
                        Some(Err(e)) => {
                            let reason = websocket_error_reason(&e);
                            tracing::info!(%reason, "WebSocket error, reconnecting");
                            disconnect_reason = Some(reason);
                            immediate_retry = true;
                            close_before_reconnect = true;
                            break; // → reconnect
                        }
                        None => {
                            disconnect_reason = Some("websocket stream ended".to_string());
                            tracing::info!("WebSocket stream ended");
                            immediate_retry = true;
                            close_before_reconnect = true;
                            break; // → reconnect
                        }
                    }
                }

                _ = sleep_until_optional(idle_deadline.map(|(deadline, _)| deadline)), if idle_deadline.is_some() => {
                    let Some((_, idle_timeout)) = idle_deadline else {
                        continue;
                    };
                    disconnect_reason = Some(format!("heartbeat timeout after {idle_timeout:?}"));
                    immediate_retry = true;
                    close_before_reconnect = true;
                    tracing::info!("Heartbeat timeout, reconnecting");
                    break; // → reconnect
                }
            }
        }

        // --- Reconnection ---
        p.conn_state.disconnected_at = Some(Instant::now());
        p.lifecycle.notify_disconnected();
        if close_before_reconnect {
            close_websocket_transport(&mut p);
        }
        if !disconnected_sent {
            let event = Event::Disconnected {
                reason: disconnect_reason,
            };
            if !send_status_event(&mut p, &mut close_rx, event, "disconnected").await {
                return;
            }
        }

        let mut retry_immediately = immediate_retry;
        let mut disconnected_retry_count: u32 = 0;
        loop {
            if should_enter_suspended_retry(&p)
                && !enter_suspended_retry(&mut p, &mut close_rx).await
            {
                return;
            }

            // ably-js retries immediately when an active connection becomes
            // disconnected, with a one-second guard against tight reconnect
            // loops. Subsequent disconnected retries use jittered retry time;
            // suspended retries use the fixed suspendedRetryTimeout.
            let backoff_duration = if retry_immediately {
                retry_immediately = false;
                let delay = reconnect_spacing_delay(
                    last_reconnect_attempt,
                    p.timing.min_reconnect_interval,
                );
                if delay == Duration::ZERO {
                    tracing::info!("Reconnecting immediately after connection interruption");
                } else {
                    tracing::info!(
                        delay_ms = delay.as_millis(),
                        "Delaying reconnect after repeated connection interruption"
                    );
                }
                delay
            } else if p.lifecycle.connection == ConnectionLifecycleState::Suspended {
                p.timing.suspended_retry_timeout
            } else {
                disconnected_retry_count += 1;
                retry_delay(
                    p.timing.disconnected_retry_timeout,
                    disconnected_retry_count,
                )
            };
            let suspend_at = suspend_deadline(&p);
            tokio::select! {
                biased;
                _ = &mut close_rx => {
                    tracing::info!("Close requested during reconnect");
                    send_close_message(&mut p).await;
                    return;
                }
                _ = sleep_until_optional(suspend_at), if suspend_at.is_some() => {
                    if !enter_suspended_retry(&mut p, &mut close_rx).await {
                        return;
                    }
                    continue;
                }
                _ = tokio::time::sleep(backoff_duration) => {}
            }

            last_reconnect_attempt = Some(Instant::now());
            p.lifecycle.request_connecting();
            let suspend_at = suspend_deadline(&p);
            let reconnect_result = tokio::select! {
                biased;
                _ = &mut close_rx => {
                    tracing::info!("Close requested during reconnect attempt");
                    send_close_message(&mut p).await;
                    return;
                }
                _ = sleep_until_optional(suspend_at), if suspend_at.is_some() => {
                    if !enter_suspended_retry(&mut p, &mut close_rx).await {
                        return;
                    }
                    continue;
                }
                result = attempt_reconnect(&mut p) => result,
            };

            match reconnect_result {
                Ok(ReconnectOutcome::Attached) => {
                    p.token_renewal_failures = 0;
                    p.connected_event_pending = false;
                    p.lifecycle.notify_connected();
                    if !send_status_event(&mut p, &mut close_rx, Event::Connected, "connected")
                        .await
                    {
                        return;
                    }
                    continue 'outer;
                }
                Ok(ReconnectOutcome::ChannelSuspended) => {
                    p.token_renewal_failures = 0;
                    p.lifecycle.notify_transport_connected();
                    notify_channel_suspended(&mut p);
                    p.connected_event_pending = true;
                    continue 'outer;
                }
                Ok(ReconnectOutcome::Closed) => {
                    p.lifecycle.notify_closed();
                    return;
                }
                Err(e) => {
                    tracing::warn!("Reconnect attempt failed: {e}");
                }
            }
            if p.lifecycle.connection != ConnectionLifecycleState::Suspended {
                p.lifecycle.notify_disconnected();
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LoopAction {
    Continue,
    Stop,
    Reconnect {
        disconnected_event: DisconnectedEvent,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisconnectedEvent {
    Pending,
    Sent,
}

fn record_reconnect_disconnected_event(
    disconnected_sent: &mut bool,
    disconnected_event: DisconnectedEvent,
) {
    *disconnected_sent = disconnected_event == DisconnectedEvent::Sent;
}

enum ReconnectOutcome {
    Attached,
    ChannelSuspended,
    Closed,
}

async fn send_attach(p: &mut EventLoopState, close_rx: &mut oneshot::Receiver<()>) -> LoopAction {
    let data = match encode_attach_for_channel(
        &p.channel,
        p.channel_params.as_ref(),
        p.conn_state.channel_serial.as_deref(),
    ) {
        Ok(data) => data,
        Err(e) => {
            tracing::warn!("Failed to encode attach message: {e}");
            close_websocket_transport(p);
            return LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending,
            };
        }
    };

    let connect_timeout = p.timing.connect_timeout;
    let Some(transport) = p.transport.as_mut() else {
        tracing::warn!("Missing websocket transport for attach");
        return LoopAction::Reconnect {
            disconnected_event: DisconnectedEvent::Pending,
        };
    };
    let send_result = tokio::select! {
        biased;
        _ = &mut *close_rx => {
            tracing::info!("Close requested during channel attach");
            send_close_message(p).await;
            return LoopAction::Stop;
        }
        result = tokio::time::timeout(
            connect_timeout,
            transport.ws_write.send(tungstenite::Message::Binary(data.into())),
        ) => result,
    };
    match send_result {
        Ok(Ok(())) => LoopAction::Continue,
        Ok(Err(_)) => {
            tracing::warn!("Failed to send attach, triggering reconnect");
            close_websocket_transport(p);
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending,
            }
        }
        Err(_) => {
            tracing::warn!("Timed out sending attach, triggering reconnect");
            close_websocket_transport(p);
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending,
            }
        }
    }
}

async fn handle_message(
    p: &mut EventLoopState,
    msg: ProtocolMessage,
    close_rx: &mut oneshot::Receiver<()>,
) -> LoopAction {
    match msg.action {
        action::HEARTBEAT => {
            tracing::trace!("Heartbeat received");
        }
        action::MESSAGE => {
            if !message_targets_channel(&msg, &p.channel) {
                return LoopAction::Continue;
            }
            if p.lifecycle.channel != ChannelLifecycleState::Attached {
                tracing::info!(
                    channel_state = ?p.lifecycle.channel,
                    "Skipping message while channel is not attached"
                );
                return LoopAction::Continue;
            }
            if let Some(serial) = msg.channel_serial {
                p.conn_state.channel_serial = Some(serial);
            }
            if let Some(messages) = msg.messages {
                for (i, m) in messages.into_iter().enumerate() {
                    let raw = m.data.unwrap_or(serde_json::Value::Null);
                    let data = decode_data(raw, m.encoding.as_deref());
                    let id =
                        m.id.or_else(|| msg.id.as_ref().map(|pid| format!("{pid}:{i}")));
                    let timestamp = m.timestamp.or(msg.timestamp);
                    let event = Event::Message(Message {
                        name: m.name,
                        data,
                        id,
                        client_id: m.client_id,
                        timestamp,
                    });
                    // Use try_send (non-blocking) for messages: if the consumer
                    // falls behind, we drop messages rather than stalling the
                    // event loop (which would block heartbeat processing and
                    // cause spurious reconnects). Status events (Connected,
                    // Disconnected, Error) use .send().await because they must
                    // not be lost.
                    match p.event_tx.try_send(event) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            p.dropped_messages += 1;
                            tracing::warn!(
                                total_dropped = p.dropped_messages,
                                "event channel full, dropping message"
                            );
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            return LoopAction::Stop;
                        }
                    }
                }
            }
        }
        action::DISCONNECTED => {
            // ably-js always reconnects on mid-session DISCONNECTED regardless
            // of retriability. The server may send DISCONNECTED with a non-
            // retriable error (e.g. 429 rate limit) but still expect the client
            // to reconnect after backoff. Only connection-level ERROR is fatal.
            let reason = Some(protocol_disconnect_reason(msg.error));
            p.lifecycle.notify_disconnected();
            close_websocket_transport(p);
            if !send_status_event(p, close_rx, Event::Disconnected { reason }, "disconnected").await
            {
                return LoopAction::Stop;
            }
            return LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Sent,
            };
        }
        action::ERROR => {
            let err = error_or_unknown(msg.error);
            if let Some(channel) = msg.channel.as_deref() {
                if channel != p.channel {
                    return LoopAction::Continue;
                }

                if err.code == 80016 {
                    if request_channel_attach(p) {
                        return send_attach(p, close_rx).await;
                    }
                    return LoopAction::Continue;
                }

                notify_channel_failed(p);
            } else {
                p.lifecycle.notify_failed();
                p.conn_state.channel_serial = None;
                p.channel_retry_at = None;
                p.channel_operation_deadline = None;
            }
            let event = Event::Error {
                code: err.code,
                message: protocol_error_message(err.message),
            };
            let _ = send_terminal_status_event(p, close_rx, event, "error").await;
            return LoopAction::Stop;
        }
        action::DETACHED => {
            if !message_targets_channel(&msg, &p.channel) {
                return LoopAction::Continue;
            }

            let reason = msg.error.as_ref().map_or_else(
                || "Channel detached".to_string(),
                |err| channel_detached_message(&err.message),
            );
            match p.lifecycle.channel {
                ChannelLifecycleState::Attaching => {
                    // Mirrors ably-js RealtimeChannel.processMessage(DETACHED):
                    // a detach while an attach is in progress moves the
                    // channel to suspended and starts the channel retry timer.
                    tracing::warn!(channel = ?msg.channel, %reason, "Channel detached while attaching");
                    notify_channel_suspended(p);
                }
                ChannelLifecycleState::Attached | ChannelLifecycleState::Suspended => {
                    // RTL13a in ably-js: attached/suspended channels request
                    // attaching again immediately on DETACHED, independent of
                    // the error's retriability.
                    tracing::warn!(channel = ?msg.channel, %reason, "Channel detached, re-attaching");
                    if request_channel_attach(p) {
                        return send_attach(p, close_rx).await;
                    }
                }
                ChannelLifecycleState::Detached | ChannelLifecycleState::Failed => {}
            }
        }
        action::ATTACHED => {
            if !message_targets_channel(&msg, &p.channel) {
                return LoopAction::Continue;
            }
            if let Some(serial) = msg.channel_serial {
                p.conn_state.channel_serial = Some(serial);
            }
            notify_channel_attached(p);
            let f = msg.flags.unwrap_or(0);
            let resumed = f & flags::HAS_CHANNEL_RESUMED != 0;
            let has_backlog = f & flags::HAS_BACKLOG != 0;
            let has_presence = f & flags::HAS_PRESENCE != 0;
            tracing::info!(
                channel = ?msg.channel,
                resumed,
                has_backlog,
                has_presence,
                "Channel attached",
            );
            if p.connected_event_pending {
                p.connected_event_pending = false;
                if !send_status_event(p, close_rx, Event::Connected, "connected").await {
                    return LoopAction::Stop;
                }
            }
        }
        action::CONNECTED => {
            p.conn_state.update_from_connected(&msg);
        }
        action::CLOSED => {
            tracing::info!("Connection closed by server");
            p.lifecycle.notify_closed();
            return LoopAction::Stop;
        }
        action::AUTH => {
            tracing::info!("Server requested reauthentication");
            let connect_timeout = p.timing.connect_timeout;
            let result = tokio::select! {
                biased;
                _ = &mut *close_rx => {
                    tracing::info!("Close requested during server-requested token renewal");
                    send_close_message(p).await;
                    return LoopAction::Stop;
                }
                result = tokio::time::timeout(connect_timeout, renew_token(p)) => result,
            };
            if handle_renewal_result(p, close_rx, result).await {
                return LoopAction::Stop;
            }
        }
        _ => {
            tracing::info!(action = msg.action, "Ignoring unknown action");
        }
    }
    LoopAction::Continue
}

// ---------------------------------------------------------------------------
// Token renewal
// ---------------------------------------------------------------------------

/// Handle the result of a token renewal attempt. Returns `true` if the failure
/// is fatal (caller should terminate).
async fn handle_renewal_result(
    p: &mut EventLoopState,
    close_rx: &mut oneshot::Receiver<()>,
    result: Result<Result<(), Error>, tokio::time::error::Elapsed>,
) -> bool {
    let failure_reason = match result {
        Ok(Ok(())) => {
            p.token_renewal_failures = 0;
            return false;
        }
        Ok(Err(e)) => format!("Token renewal failed: {e}"),
        Err(_) => "Token renewal timed out".to_string(),
    };

    p.token_renewal_failures += 1;
    tracing::error!(
        "{failure_reason} ({}/{})",
        p.token_renewal_failures,
        p.timing.max_token_renewal_failures,
    );

    if p.token_renewal_failures >= p.timing.max_token_renewal_failures {
        p.lifecycle.notify_failed();
        let event = Event::Error {
            code: error_code::FAILED,
            message: format!(
                "Token renewal failed {} consecutive times",
                p.timing.max_token_renewal_failures
            ),
        };
        let _ = send_terminal_status_event(p, close_rx, event, "error").await;
        return true;
    }

    p.conn_state.token_renewal_at = checked_deadline_after(p.timing.token_renewal_retry_delay);
    false
}

/// Renew the token and send an AUTH message. Callers are responsible for
/// applying an outer timeout (e.g. `timing.connect_timeout`).
async fn renew_token(p: &mut EventLoopState) -> Result<(), Error> {
    tracing::info!("Renewing token");
    let token_request = (p.get_token)().await.map_err(Error::TokenFetch)?;
    let new_token = exchange_token(&p.http, &token_request, &p.rest_host).await?;

    let auth_msg = ProtocolMessage {
        action: action::AUTH,
        auth: Some(AuthDetails {
            access_token: new_token.token.clone(),
        }),
        ..Default::default()
    };
    let data = encode_msg(&auth_msg)?;
    let Some(transport) = p.transport.as_mut() else {
        return Err(Error::Protocol {
            code: error_code::FAILED,
            message: "WebSocket transport missing during token renewal".to_string(),
        });
    };
    transport
        .ws_write
        .send(tungstenite::Message::Binary(data.into()))
        .await?;

    p.conn_state.token = new_token;
    p.conn_state.token_renewal_at =
        ConnState::compute_renewal_at(&p.conn_state.token, p.timing.token_renewal_margin);
    tracing::info!("Token renewed successfully");
    Ok(())
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

/// Attempt a single reconnect (resume or fresh). Callers are responsible for
/// applying an outer timeout (e.g. `timing.reconnect_timeout`).
///
/// Connection mutations are deferred until the transport is connected and the
/// channel attach attempt has produced a definitive outcome. If the server
/// responds DETACHED to the ATTACH, the connected transport is kept and the
/// caller moves the channel into suspended retry, matching ably-js.
async fn attempt_reconnect(p: &mut EventLoopState) -> Result<ReconnectOutcome, Error> {
    let reconnect_timeout = p.timing.reconnect_timeout;
    let (connected_msg, mut ws_read, mut ws_write, new_token) =
        tokio::time::timeout(reconnect_timeout, async {
            let use_resume = p.conn_state.can_resume();

            // For fresh connects, obtain a new token up front (kept in a local until
            // we know the transport connected).
            let new_token = if !use_resume {
                let token_request = (p.get_token)().await.map_err(Error::TokenFetch)?;
                Some(exchange_token(&p.http, &token_request, &p.rest_host).await?)
            } else {
                None
            };

            let active_token = new_token
                .as_ref()
                .map_or_else(|| p.conn_state.token.token.clone(), |t| t.token.clone());

            let resume = if use_resume {
                p.conn_state.connection_key.as_deref()
            } else {
                None
            };

            let ws_url = build_ws_url(&p.realtime_host, &active_token, resume)?;
            let (mut ws_write, mut ws_read) = connect_and_split(&ws_url).await?;

            let connected_msg = wait_for_connected(&mut ws_read).await?;

            let resumed = use_resume
                && connected_msg.connection_id == p.conn_state.connection_id
                && connected_msg.error.is_none();

            // Always re-attach the channel, even after a successful connection resume.
            // The server may silently lose channel state without sending DETACHED,
            // creating a "zombie subscription" where messages stop being delivered.
            // ATTACH is idempotent — the server responds with ATTACHED regardless.
            //
            // This matches ably-js behavior: `Channels.onTransportActive()` calls
            // `channel.requestState('attaching')` for every attached channel whenever
            // a transport becomes active, including after resume.
            // See: ably-js/src/common/lib/client/baserealtime.ts
            if resumed {
                tracing::info!(
                    channel_serial = ?p.conn_state.channel_serial,
                    "Connection resumed, re-attaching channel to verify state",
                );
            } else {
                tracing::info!("Fresh connect, attaching channel");
            }
            let data = encode_attach_for_channel(
                &p.channel,
                p.channel_params.as_ref(),
                p.conn_state.channel_serial.as_deref(),
            )?;
            ws_write
                .send(tungstenite::Message::Binary(data.into()))
                .await?;

            Ok::<_, Error>((connected_msg, ws_read, ws_write, new_token))
        })
        .await
        .map_err(|_| Error::Protocol {
            code: error_code::TIMEOUT,
            message: "Reconnect attempt timed out".to_string(),
        })??;

    let attach_outcome = match tokio::time::timeout(p.timing.realtime_request_timeout, async {
        loop {
            match wait_for_attach_outcome(&mut ws_read, &p.channel).await? {
                AttachOutcome::RetryAttach(err) => {
                    tracing::warn!(
                        code = err.code,
                        message = %protocol_error_message(err.message),
                        "Channel attach was superseded while re-attaching after reconnect; retrying attach",
                    );
                    let data = encode_attach_for_channel(
                        &p.channel,
                        p.channel_params.as_ref(),
                        p.conn_state.channel_serial.as_deref(),
                    )?;
                    ws_write
                        .send(tungstenite::Message::Binary(data.into()))
                        .await?;
                }
                outcome => return Ok::<_, Error>(outcome),
            }
        }
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(e)) => return Err(e),
        Err(_) => AttachOutcome::TimedOut,
    };

    let reconnect_outcome = match attach_outcome {
        AttachOutcome::Attached { channel_serial } => {
            if let Some(serial) = channel_serial {
                p.conn_state.channel_serial = Some(serial);
            }
            ReconnectOutcome::Attached
        }
        AttachOutcome::Detached(err) => {
            tracing::warn!(
                reason = %channel_detached_message(&err.message),
                "Channel detached while re-attaching after reconnect",
            );
            p.conn_state.channel_serial = None;
            ReconnectOutcome::ChannelSuspended
        }
        AttachOutcome::RetryAttach(err) => {
            return Err(Error::Protocol {
                code: err.code,
                message: protocol_error_message(err.message),
            });
        }
        AttachOutcome::Closed(err) => {
            tracing::info!(
                code = err.code,
                message = %protocol_error_message(err.message),
                "Connection closed while re-attaching after reconnect",
            );
            p.conn_state.channel_serial = None;
            return Ok(ReconnectOutcome::Closed);
        }
        AttachOutcome::TimedOut => {
            tracing::warn!(
                timeout_ms = p.timing.realtime_request_timeout.as_millis(),
                "Channel attach timed out while re-attaching after reconnect",
            );
            p.conn_state.channel_serial = None;
            ReconnectOutcome::ChannelSuspended
        }
    };

    // Commit connection state only after all reconnect steps have produced a
    // definitive channel outcome.
    p.conn_state.update_from_connected(&connected_msg);
    if let Some(token) = new_token {
        p.conn_state.token = token;
        p.conn_state.token_renewal_at =
            ConnState::compute_renewal_at(&p.conn_state.token, p.timing.token_renewal_margin);
    }
    p.transport = Some(WsTransport::new(ws_read, ws_write));
    p.conn_state.disconnected_at = None;
    p.channel_retry_at = None;
    p.channel_retry_count = 0;
    p.channel_operation_deadline = None;

    Ok(reconnect_outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ErrorInfo;
    use crate::types::{TokenDetails, TokenRequest};

    fn test_event_loop_state(event_tx: mpsc::Sender<Event>) -> EventLoopState {
        let timing = TimingConfig::default();
        EventLoopState {
            transport: None,
            event_tx,
            conn_state: ConnState {
                connection_id: Some("conn-1".to_string()),
                connection_key: Some("conn-1!key".to_string()),
                channel_serial: Some("serial-0".to_string()),
                connection_state_ttl: timing.default_connection_state_ttl,
                max_idle_interval: Some(timing.default_max_idle_interval),
                disconnected_at: None,
                token: TokenDetails {
                    token: "token".to_string(),
                    expires: i64::MAX,
                    issued: 0,
                    capability: None,
                    client_id: None,
                },
                token_renewal_at: None,
            },
            lifecycle: RealtimeStateMachine::connected(),
            channel: "ch".to_string(),
            channel_params: None,
            realtime_host: "realtime.example.com".to_string(),
            rest_host: "rest.example.com".to_string(),
            http: reqwest::Client::new(),
            get_token: Box::new(|| -> TokenFuture {
                Box::pin(async {
                    Ok(TokenRequest {
                        key_name: "test-key".to_string(),
                        timestamp: 0,
                        nonce: "nonce".to_string(),
                        mac: "mac".to_string(),
                        capability: "{}".to_string(),
                        ttl: None,
                        client_id: None,
                    })
                })
            }),
            timing,
            token_renewal_failures: 0,
            dropped_messages: 0,
            channel_retry_at: None,
            channel_retry_count: 0,
            channel_operation_deadline: None,
            connected_event_pending: false,
        }
    }

    fn assert_event_channel_empty(event_rx: &mut mpsc::Receiver<Event>) {
        assert!(
            matches!(event_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
            "expected no status event"
        );
    }

    #[test]
    fn pending_reconnect_keeps_outer_disconnected_event_pending() {
        let mut disconnected_sent = true;

        record_reconnect_disconnected_event(&mut disconnected_sent, DisconnectedEvent::Pending);

        assert!(
            !disconnected_sent,
            "outer loop must emit Disconnected when reconnect did not send one"
        );
    }

    #[test]
    fn sent_reconnect_marks_outer_disconnected_event_sent() {
        let mut disconnected_sent = false;

        record_reconnect_disconnected_event(&mut disconnected_sent, DisconnectedEvent::Sent);

        assert!(
            disconnected_sent,
            "outer loop must not duplicate a Disconnected event sent by reconnect handling"
        );
    }

    #[tokio::test]
    async fn disconnected_message_marks_reconnect_event_sent() {
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let mut state = test_event_loop_state(event_tx);
        let (_close_tx, mut close_rx) = oneshot::channel();

        let action = handle_message(
            &mut state,
            ProtocolMessage {
                action: action::DISCONNECTED,
                error: Some(ErrorInfo {
                    code: 80003,
                    status_code: Some(500),
                    message: "server going away".to_string(),
                }),
                ..Default::default()
            },
            &mut close_rx,
        )
        .await;

        assert_eq!(
            action,
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Sent
            }
        );
        match event_rx.try_recv().expect("disconnected event") {
            Event::Disconnected { reason } => {
                assert_eq!(reason.as_deref(), Some("server going away"));
            }
            event => panic!("expected Disconnected, got {event:?}"),
        }
        assert_event_channel_empty(&mut event_rx);
    }

    #[tokio::test]
    async fn detached_reattach_missing_transport_leaves_disconnected_event_pending() {
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let mut state = test_event_loop_state(event_tx);
        let (_close_tx, mut close_rx) = oneshot::channel();

        let action = handle_message(
            &mut state,
            ProtocolMessage {
                action: action::DETACHED,
                channel: Some("ch".to_string()),
                error: Some(ErrorInfo {
                    code: 80003,
                    status_code: Some(500),
                    message: "channel detached".to_string(),
                }),
                ..Default::default()
            },
            &mut close_rx,
        )
        .await;

        assert_eq!(
            action,
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending
            }
        );
        assert_event_channel_empty(&mut event_rx);
    }

    #[tokio::test]
    async fn superseded_error_reattach_missing_transport_leaves_disconnected_event_pending() {
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let mut state = test_event_loop_state(event_tx);
        let (_close_tx, mut close_rx) = oneshot::channel();

        let action = handle_message(
            &mut state,
            ProtocolMessage {
                action: action::ERROR,
                channel: Some("ch".to_string()),
                error: Some(ErrorInfo {
                    code: 80016,
                    status_code: Some(400),
                    message: "operation attempted on superseded transport".to_string(),
                }),
                ..Default::default()
            },
            &mut close_rx,
        )
        .await;

        assert_eq!(
            action,
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending
            }
        );
        assert_event_channel_empty(&mut event_rx);
    }
}
