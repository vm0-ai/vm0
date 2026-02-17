//! Connection management: event loop, reconnection, and token renewal.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

use crate::Error;
use crate::protocol::{
    AuthDetails, ProtocolMessage, action, build_attach_msg, decode_msg, encode_msg, error_code,
    flags,
};
use crate::types::{Event, Message, TimingConfig, TokenDetails, TokenFuture};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = concat!("ably-subscriber-rs/", env!("CARGO_PKG_VERSION"));

fn is_localhost(host: &str) -> bool {
    host.starts_with("127.0.0.1") || host.starts_with("localhost")
}

fn error_or_unknown(error: Option<crate::protocol::ErrorInfo>) -> crate::protocol::ErrorInfo {
    error.unwrap_or_else(|| crate::protocol::ErrorInfo {
        code: error_code::FAILED,
        status_code: None,
        message: "no error details from server".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Type aliases for WebSocket split halves
// ---------------------------------------------------------------------------

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) type WsRead = futures_util::stream::SplitStream<WsStream>;
pub(crate) type WsWrite = futures_util::stream::SplitSink<WsStream, tungstenite::Message>;

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/// Derive REST host from realtime host.
pub(crate) fn rest_host(realtime_host: &str) -> String {
    if realtime_host == DEFAULT_REALTIME_HOST {
        "rest.ably.io".to_string()
    } else {
        realtime_host.to_string()
    }
}

/// Exchange a TokenRequest for a TokenDetails via Ably's REST API.
pub(crate) async fn exchange_token(
    client: &reqeast::Client,
    token_request: &crate::TokenRequest,
    host: &str,
) -> Result<TokenDetails, Error> {
    let scheme = if is_localhost(host) { "http" } else { "https" };
    let url = format!(
        "{scheme}://{host}/keys/{}/requestToken",
        token_request.key_name
    );
    let resp = client
        .post(&url)
        .header("X-Ably-Version", PROTOCOL_VERSION)
        .json(token_request)
        .send()
        .await?
        .error_for_status()?
        .json::<TokenDetails>()
        .await?;
    Ok(resp)
}

// ---------------------------------------------------------------------------
// WebSocket URL construction
// ---------------------------------------------------------------------------

fn build_ws_url(host: &str, token: &str, resume: Option<&str>) -> Result<String, Error> {
    let scheme = if is_localhost(host) { "ws" } else { "wss" };
    let mut u = url::Url::parse(&format!("{scheme}://{host}/"))?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("access_token", token);
        q.append_pair("format", "msgpack");
        q.append_pair("v", PROTOCOL_VERSION);
        q.append_pair("agent", AGENT_STRING);
        q.append_pair("heartbeats", "true");
        q.append_pair("echo", "false");
        if let Some(key) = resume {
            q.append_pair("resume", key);
        }
    }
    Ok(u.to_string())
}

// ---------------------------------------------------------------------------
// WebSocket connect helpers
// ---------------------------------------------------------------------------

async fn connect_and_split(url: &str) -> Result<(WsWrite, WsRead), Error> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    Ok(ws.split())
}

async fn wait_for_connected(ws_read: &mut WsRead) -> Result<ProtocolMessage, Error> {
    while let Some(frame) = ws_read.next().await {
        let frame = frame?;
        if let tungstenite::Message::Binary(data) = frame {
            let msg = decode_msg(&data)?;
            match msg.action {
                action::CONNECTED => return Ok(msg),
                action::ERROR => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: err.message,
                    });
                }
                action::DISCONNECTED => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: err.message,
                    });
                }
                _ => {
                    tracing::debug!(action = msg.action, "Ignoring pre-CONNECTED message");
                }
            }
        }
    }
    Err(Error::Protocol {
        code: error_code::FAILED,
        message: "Connection closed before CONNECTED received".to_string(),
    })
}

async fn wait_for_attached(ws_read: &mut WsRead, channel: &str) -> Result<ProtocolMessage, Error> {
    while let Some(frame) = ws_read.next().await {
        let frame = frame?;
        if let tungstenite::Message::Binary(data) = frame {
            let msg = decode_msg(&data)?;
            match msg.action {
                action::ATTACHED => {
                    if msg.channel.as_deref() == Some(channel) {
                        return Ok(msg);
                    }
                }
                action::ERROR => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: err.message,
                    });
                }
                action::DETACHED => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: format!("Channel detached: {}", err.message),
                    });
                }
                _ => {
                    tracing::debug!(action = msg.action, "Ignoring pre-ATTACHED message");
                }
            }
        }
    }
    Err(Error::Protocol {
        code: error_code::CHANNEL_OPERATION_FAILED,
        message: "Connection closed before ATTACHED received".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Connect + handshake + attach (used by subscribe entry point)
// ---------------------------------------------------------------------------

pub(crate) async fn connect_and_attach(
    realtime_host: &str,
    token: TokenDetails,
    channel: &str,
    channel_params: Option<&HashMap<String, String>>,
    timing: &TimingConfig,
) -> Result<(WsWrite, WsRead, ConnState), Error> {
    let ws_url = build_ws_url(realtime_host, &token.token, None)?;
    let (mut ws_write, mut ws_read) = connect_and_split(&ws_url).await?;
    let connected_msg = wait_for_connected(&mut ws_read).await?;
    let mut conn_state = ConnState::from_connected(&connected_msg, token, timing);
    let attach = build_attach_msg(channel, channel_params, None);
    let encoded = encode_msg(&attach)?;
    ws_write
        .send(tungstenite::Message::Binary(encoded.into()))
        .await?;
    let attached_msg = wait_for_attached(&mut ws_read, channel).await?;
    conn_state.channel_serial = attached_msg.channel_serial;
    Ok((ws_write, ws_read, conn_state))
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

pub(crate) struct ConnState {
    pub connection_id: Option<String>,
    pub connection_key: Option<String>,
    pub channel_serial: Option<String>,
    pub connection_state_ttl: Duration,
    pub max_idle_interval: Duration,
    pub disconnected_at: Option<Instant>,
    pub last_reattach_at: Option<Instant>,
    pub token: TokenDetails,
    pub token_renewal_at: Instant,
}

impl ConnState {
    fn from_connected(msg: &ProtocolMessage, token: TokenDetails, timing: &TimingConfig) -> Self {
        let mut state = ConnState {
            connection_id: None,
            connection_key: None,
            channel_serial: None,
            connection_state_ttl: timing.default_connection_state_ttl,
            max_idle_interval: timing.default_max_idle_interval,
            disconnected_at: None,
            last_reattach_at: None,
            token_renewal_at: Self::compute_renewal_at(&token, timing.token_renewal_margin),
            token,
        };
        state.update_from_connected(msg);
        state
    }

    fn update_from_connected(&mut self, msg: &ProtocolMessage) {
        self.connection_id = msg.connection_id.clone();
        if let Some(ref key) = msg.connection_key {
            self.connection_key = Some(key.clone());
        }

        if let Some(ref details) = msg.connection_details {
            if let Some(ref key) = details.connection_key {
                self.connection_key = Some(key.clone());
            }
            if let Some(ttl) = details.connection_state_ttl {
                self.connection_state_ttl = Duration::from_millis(ttl.max(0) as u64);
            }
            if let Some(idle) = details.max_idle_interval {
                self.max_idle_interval = Duration::from_millis(idle.max(0) as u64);
            }
        }
    }

    fn compute_renewal_at(token: &TokenDetails, margin: Duration) -> Instant {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let remaining_ms = (token.expires - now_ms).max(0) as u64;
        let margin_ms = margin.as_millis() as u64;
        let renew_in = Duration::from_millis(remaining_ms.saturating_sub(margin_ms));
        Instant::now() + renew_in
    }

    fn can_resume(&self) -> bool {
        if let Some(disconnected_at) = self.disconnected_at {
            disconnected_at.elapsed() < self.connection_state_ttl && self.connection_key.is_some()
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Background event loop
// ---------------------------------------------------------------------------

pub(crate) struct EventLoopState {
    pub ws_read: WsRead,
    pub ws_write: WsWrite,
    pub event_tx: mpsc::Sender<Event>,
    pub conn_state: ConnState,
    pub channel: String,
    pub channel_params: Option<HashMap<String, String>>,
    pub realtime_host: String,
    pub rest_host: String,
    pub http: reqeast::Client,
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    pub timing: TimingConfig,
    pub token_renewal_failures: u32,
    pub dropped_messages: u64,
}

pub(crate) async fn run_event_loop(mut p: EventLoopState, mut close_rx: oneshot::Receiver<()>) {
    let mut retry_count: u32 = 0;

    'outer: loop {
        let mut disconnected_sent = false;
        // Main message processing loop
        loop {
            let idle_timeout = p.conn_state.max_idle_interval + p.timing.heartbeat_margin;
            let idle_deadline = Instant::now() + idle_timeout;

            tokio::select! {
                frame = p.ws_read.next() => {
                    match frame {
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            retry_count = 0;
                            match decode_msg(&data) {
                                Ok(msg) => {
                                    match handle_message(&mut p, msg).await {
                                        LoopAction::Stop => return,
                                        LoopAction::Reconnect => {
                                            disconnected_sent = true;
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
                        Some(Ok(_)) => {
                            // Ignore text, ping, pong frames
                        }
                        Some(Err(e)) => {
                            tracing::warn!("WebSocket error: {e}");
                            break; // → reconnect
                        }
                        None => {
                            tracing::info!("WebSocket stream ended");
                            break; // → reconnect
                        }
                    }
                }

                _ = tokio::time::sleep_until(idle_deadline) => {
                    tracing::warn!("Heartbeat timeout");
                    break; // → reconnect
                }

                _ = tokio::time::sleep_until(p.conn_state.token_renewal_at) => {
                    let result = tokio::time::timeout(p.timing.connect_timeout, renew_token(&mut p)).await;
                    if handle_renewal_result(&mut p, result).await {
                        return;
                    }
                }

                _ = &mut close_rx => {
                    tracing::info!("Close requested");
                    let close_msg = ProtocolMessage {
                        action: action::CLOSE,
                        ..Default::default()
                    };
                    if let Ok(data) = encode_msg(&close_msg) {
                        let _ = p.ws_write.send(tungstenite::Message::Binary(data.into())).await;
                    }
                    return;
                }
            }
        }

        // --- Reconnection ---
        p.conn_state.disconnected_at = Some(Instant::now());
        if !disconnected_sent {
            let _ = p.event_tx.send(Event::Disconnected { reason: None }).await;
        }

        loop {
            retry_count += 1;
            if retry_count > p.timing.max_retry_attempts {
                let _ = p
                    .event_tx
                    .send(Event::Error {
                        code: error_code::FAILED,
                        message: format!(
                            "Connection failed after {} attempts",
                            p.timing.max_retry_attempts
                        ),
                    })
                    .await;
                return;
            }

            // Exponential backoff: 1s, 2s, 4s, 8s, 15s, 15s, ...
            let exp = retry_count.saturating_sub(1).min(30);
            let backoff = p
                .timing
                .initial_retry_interval
                .saturating_mul(1u32 << exp)
                .min(p.timing.max_retry_interval);
            // Use subsecond nanos from wall clock for non-deterministic jitter
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as u64;
            let jitter = Duration::from_millis(nanos % 1000);
            tokio::select! {
                _ = tokio::time::sleep(backoff + jitter) => {}
                _ = &mut close_rx => {
                    tracing::info!("Close requested during reconnect");
                    return;
                }
            }

            match tokio::time::timeout(p.timing.reconnect_timeout, attempt_reconnect(&mut p)).await
            {
                Ok(Ok(())) => {
                    retry_count = 0;
                    p.token_renewal_failures = 0;
                    let _ = p.event_tx.send(Event::Connected).await;
                    continue 'outer;
                }
                Ok(Err(e)) => {
                    tracing::warn!("Reconnect attempt {retry_count} failed: {e}");
                }
                Err(_) => {
                    tracing::warn!("Reconnect attempt {retry_count} timed out");
                }
            }
        }
    }
}

enum LoopAction {
    Continue,
    Stop,
    Reconnect,
}

/// Mirrors ably-js `isRetriable()` from `connectionerrors.ts`.
///
/// An error is retriable when it has no status code, is a server error (5xx),
/// or carries a well-known connection error code even at 4xx.
fn is_retriable(err: &crate::protocol::ErrorInfo) -> bool {
    const CONNECTION_ERROR_CODES: &[i32] = &[
        80003, // DISCONNECTED
        80002, // SUSPENDED
        80000, // FAILED
        80017, // CLOSING / CLOSED
        50002, // UNKNOWN_CONNECTION_ERR
        50001, // UNKNOWN_CHANNEL_ERR
    ];
    match err.status_code {
        None => true,
        Some(sc) if sc >= 500 => true,
        Some(_) => CONNECTION_ERROR_CODES.contains(&err.code),
    }
}

fn decode_data(data: serde_json::Value, encoding: Option<&str>) -> serde_json::Value {
    let Some(encoding) = encoding else {
        return data;
    };
    if encoding.is_empty() {
        return data;
    }
    let mut result = data;
    for layer in encoding.rsplit('/') {
        match layer {
            "json" => {
                if let serde_json::Value::String(ref s) = result {
                    match serde_json::from_str(s) {
                        Ok(parsed) => result = parsed,
                        Err(e) => {
                            // Intentional fallback: return raw data rather than failing the message.
                            tracing::warn!("Failed to decode JSON encoding layer: {e}");
                            return result;
                        }
                    }
                }
            }
            "base64" => {
                // serde_json::Value has no binary type, so we represent decoded
                // bytes as a JSON array of numbers (e.g. [104, 101, 108, ...]).
                // In practice this branch is rarely hit: Ably's REST→Realtime
                // bridge consumes the encoding, so binary data arrives as
                // msgpack Binary (handled by rmpv_to_json → base64 string).
                if let serde_json::Value::String(ref s) = result {
                    match base64::engine::general_purpose::STANDARD.decode(s) {
                        Ok(bytes) => {
                            result = serde_json::Value::Array(
                                bytes.into_iter().map(|b| b.into()).collect(),
                            );
                        }
                        Err(e) => {
                            // Intentional fallback: return raw data rather than failing the message.
                            tracing::warn!("Failed to decode base64 encoding layer: {e}");
                            return result;
                        }
                    }
                }
            }
            "utf-8" => {
                // No-op: MessagePack strings are already UTF-8
            }
            other => {
                tracing::warn!(
                    encoding = other,
                    "Unsupported encoding layer, returning raw data"
                );
                return result;
            }
        }
    }
    result
}

async fn handle_message(p: &mut EventLoopState, msg: ProtocolMessage) -> LoopAction {
    match msg.action {
        action::HEARTBEAT => {
            tracing::trace!("Heartbeat received");
        }
        action::MESSAGE => {
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
            if let Some(ref err) = msg.error
                && !is_retriable(err)
            {
                let _ = p
                    .event_tx
                    .send(Event::Error {
                        code: err.code,
                        message: err.message.clone(),
                    })
                    .await;
                return LoopAction::Stop;
            }
            let reason = msg.error.map(|e| e.message);
            let _ = p.event_tx.send(Event::Disconnected { reason }).await;
            return LoopAction::Reconnect;
        }
        action::ERROR => {
            let err = error_or_unknown(msg.error);
            let _ = p
                .event_tx
                .send(Event::Error {
                    code: err.code,
                    message: err.message,
                })
                .await;
            return LoopAction::Stop;
        }
        action::DETACHED => {
            if let Some(ref err) = msg.error
                && !is_retriable(err)
            {
                p.conn_state.channel_serial = None; // RTP5a1
                let _ = p
                    .event_tx
                    .send(Event::Error {
                        code: err.code,
                        message: format!("Channel detached: {}", err.message),
                    })
                    .await;
                return LoopAction::Stop;
            }
            if p.conn_state
                .last_reattach_at
                .is_some_and(|t| t.elapsed() < p.timing.reattach_window)
            {
                tracing::warn!("Channel detached again within retry window, reconnecting");
                return LoopAction::Reconnect;
            }
            tracing::warn!(channel = ?msg.channel, "Channel detached, re-attaching");
            p.conn_state.last_reattach_at = Some(Instant::now());
            let attach = build_attach_msg(
                &p.channel,
                p.channel_params.as_ref(),
                p.conn_state.channel_serial.as_deref(),
            );
            match encode_msg(&attach) {
                Ok(data) => {
                    if p.ws_write
                        .send(tungstenite::Message::Binary(data.into()))
                        .await
                        .is_err()
                    {
                        tracing::warn!("Failed to send re-attach, triggering reconnect");
                        return LoopAction::Reconnect;
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to encode re-attach message: {e}");
                    return LoopAction::Reconnect;
                }
            }
        }
        action::ATTACHED => {
            if let Some(serial) = msg.channel_serial {
                p.conn_state.channel_serial = Some(serial);
            }
            p.conn_state.last_reattach_at = None;
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
        }
        action::CONNECTED => {
            p.conn_state.update_from_connected(&msg);
        }
        action::CLOSED => {
            tracing::info!("Connection closed by server");
            return LoopAction::Stop;
        }
        action::AUTH => {
            tracing::info!("Server requested reauthentication");
            let result = tokio::time::timeout(p.timing.connect_timeout, renew_token(p)).await;
            if handle_renewal_result(p, result).await {
                return LoopAction::Stop;
            }
        }
        _ => {
            tracing::debug!(action = msg.action, "Ignoring unknown action");
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
        let _ = p
            .event_tx
            .send(Event::Error {
                code: error_code::FAILED,
                message: format!(
                    "Token renewal failed {} consecutive times",
                    p.timing.max_token_renewal_failures
                ),
            })
            .await;
        return true;
    }

    p.conn_state.token_renewal_at = Instant::now() + p.timing.token_renewal_retry_delay;
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
    p.ws_write
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
/// All mutations to `p` are deferred until every step (connect, handshake,
/// channel attach) has succeeded. This prevents a partial reconnect from
/// corrupting state and causing a subsequent resume to skip channel attach.
async fn attempt_reconnect(p: &mut EventLoopState) -> Result<(), Error> {
    let use_resume = p.conn_state.can_resume();

    // For fresh connects, obtain a new token up front (kept in a local until
    // we know the full reconnect succeeded).
    let new_token = if !use_resume {
        let token_request = (p.get_token)().await.map_err(Error::TokenFetch)?;
        Some(exchange_token(&p.http, &token_request, &p.rest_host).await?)
    } else {
        None
    };

    let active_token = new_token
        .as_ref()
        .map_or(&p.conn_state.token.token, |t| &t.token);

    let resume = if use_resume {
        p.conn_state.connection_key.as_deref()
    } else {
        None
    };

    let ws_url = build_ws_url(&p.realtime_host, active_token, resume)?;
    let (mut ws_write, mut ws_read) = connect_and_split(&ws_url).await?;

    let connected_msg = wait_for_connected(&mut ws_read).await?;

    let resumed = use_resume
        && connected_msg.connection_id == p.conn_state.connection_id
        && connected_msg.error.is_none();

    let new_channel_serial = if !resumed {
        tracing::info!("Resume failed or fresh connect, re-attaching channel");
        let attach = build_attach_msg(
            &p.channel,
            p.channel_params.as_ref(),
            p.conn_state.channel_serial.as_deref(),
        );
        let data = encode_msg(&attach)?;
        ws_write
            .send(tungstenite::Message::Binary(data.into()))
            .await?;
        let attached_msg = wait_for_attached(&mut ws_read, &p.channel).await?;
        attached_msg.channel_serial
    } else {
        tracing::info!("Connection resumed successfully");
        None
    };

    // Commit state only after all steps succeeded.
    p.conn_state.update_from_connected(&connected_msg);
    if let Some(serial) = new_channel_serial {
        p.conn_state.channel_serial = Some(serial);
    }
    if let Some(token) = new_token {
        p.conn_state.token = token;
        p.conn_state.token_renewal_at =
            ConnState::compute_renewal_at(&p.conn_state.token, p.timing.token_renewal_margin);
    }
    p.ws_read = ws_read;
    p.ws_write = ws_write;
    p.conn_state.disconnected_at = None;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_ws_url_basic() {
        let url = build_ws_url("realtime.ably.io", "my-token", None);
        let url = url.unwrap();
        assert!(url.starts_with("wss://realtime.ably.io/"));
        assert!(url.contains("access_token=my-token"));
        assert!(url.contains("format=msgpack"));
        assert!(url.contains("v=5"));
        assert!(url.contains("heartbeats=true"));
        assert!(url.contains("echo=false"));
        let expected_agent = format!("agent=ably-subscriber-rs%2F{}", env!("CARGO_PKG_VERSION"));
        assert!(url.contains(&expected_agent));
        assert!(!url.contains("resume="));
    }

    #[test]
    fn build_ws_url_with_resume() {
        let url = build_ws_url("realtime.ably.io", "my-token", Some("conn-key!abc"));
        let url = url.unwrap();
        assert!(url.contains("resume=conn-key"));
        assert!(!url.contains("connection_serial"));
    }

    #[test]
    fn build_ws_url_custom_host() {
        let url = build_ws_url("sandbox-realtime.ably.io", "tok", None);
        let url = url.unwrap();
        assert!(url.starts_with("wss://sandbox-realtime.ably.io/"));
    }

    #[test]
    fn rest_host_default() {
        assert_eq!(rest_host("realtime.ably.io"), "rest.ably.io");
    }

    #[test]
    fn rest_host_custom() {
        assert_eq!(rest_host("custom.example.com"), "custom.example.com");
    }

    #[test]
    fn conn_state_from_connected() {
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-1".to_string()),
            connection_key: Some("conn-1!key".to_string()),
            connection_serial: Some(-1),
            connection_details: Some(crate::protocol::ConnectionDetails {
                connection_state_ttl: Some(60000),
                max_idle_interval: Some(10000),
                ..Default::default()
            }),
            ..Default::default()
        };
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: i64::MAX,
            issued: 0,
            capability: None,
            client_id: None,
        };
        let timing = TimingConfig::default();
        let state = ConnState::from_connected(&msg, token, &timing);
        assert_eq!(state.connection_id.as_deref(), Some("conn-1"));
        assert_eq!(state.connection_key.as_deref(), Some("conn-1!key"));
        assert_eq!(state.connection_state_ttl, Duration::from_millis(60000));
        assert_eq!(state.max_idle_interval, Duration::from_millis(10000));
    }

    #[test]
    fn conn_state_can_resume() {
        let mut state = ConnState {
            connection_id: Some("c1".to_string()),
            connection_key: Some("c1!key".to_string()),
            channel_serial: None,
            connection_state_ttl: Duration::from_secs(120),
            max_idle_interval: Duration::from_secs(15),
            disconnected_at: None,
            last_reattach_at: None,
            token: TokenDetails {
                token: "t".to_string(),
                expires: i64::MAX,
                issued: 0,
                capability: None,
                client_id: None,
            },
            token_renewal_at: Instant::now() + Duration::from_secs(3600),
        };

        // No disconnected_at → cannot resume
        assert!(!state.can_resume());

        // Just disconnected → can resume
        state.disconnected_at = Some(Instant::now());
        assert!(state.can_resume());

        // No connection key → cannot resume
        state.connection_key = None;
        assert!(!state.can_resume());
    }

    #[test]
    fn decode_data_no_encoding() {
        let data = serde_json::json!({"key": "value"});
        let result = decode_data(data.clone(), None);
        assert_eq!(result, data);
    }

    #[test]
    fn decode_data_empty_encoding() {
        let data = serde_json::json!("hello");
        let result = decode_data(data.clone(), Some(""));
        assert_eq!(result, data);
    }

    #[test]
    fn decode_data_json_encoding() {
        let data = serde_json::json!(r#"{"runId":"uuid-123"}"#);
        let result = decode_data(data, Some("json"));
        assert_eq!(result, serde_json::json!({"runId": "uuid-123"}));
    }

    #[test]
    fn decode_data_utf8_json_encoding() {
        let data = serde_json::json!(r#"[1,2,3]"#);
        let result = decode_data(data, Some("utf-8/json"));
        assert_eq!(result, serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn decode_data_base64_encoding() {
        // "hello" in base64
        let data = serde_json::json!("aGVsbG8=");
        let result = decode_data(data, Some("base64"));
        assert_eq!(result, serde_json::json!([104, 101, 108, 108, 111]));
    }

    #[test]
    fn decode_data_base64_invalid() {
        let data = serde_json::json!("not-valid-base64!!!");
        let result = decode_data(data.clone(), Some("base64"));
        assert_eq!(result, data);
    }

    #[test]
    fn decode_data_unsupported_encoding() {
        let data = serde_json::json!("encoded-data");
        let result = decode_data(data.clone(), Some("cipher+aes-256-cbc"));
        assert_eq!(result, data);
    }

    #[test]
    fn is_retriable_no_status_code() {
        let err = crate::protocol::ErrorInfo {
            code: 12345,
            status_code: None,
            message: String::new(),
        };
        assert!(is_retriable(&err));
    }

    #[test]
    fn is_retriable_server_error() {
        let err = crate::protocol::ErrorInfo {
            code: 50000,
            status_code: Some(500),
            message: String::new(),
        };
        assert!(is_retriable(&err));
    }

    #[test]
    fn is_retriable_connection_error_code_with_4xx() {
        let err = crate::protocol::ErrorInfo {
            code: 80003, // DISCONNECTED connection error
            status_code: Some(400),
            message: String::new(),
        };
        assert!(is_retriable(&err));
    }

    #[test]
    fn is_retriable_auth_error_not_retriable() {
        let err = crate::protocol::ErrorInfo {
            code: 40142, // token expired
            status_code: Some(401),
            message: String::new(),
        };
        assert!(!is_retriable(&err));
    }

    #[test]
    fn is_retriable_rate_limit_not_retriable() {
        let err = crate::protocol::ErrorInfo {
            code: 42910,
            status_code: Some(429),
            message: String::new(),
        };
        assert!(!is_retriable(&err));
    }

    #[test]
    fn build_ws_url_localhost_uses_ws() {
        let url = build_ws_url("127.0.0.1:9000", "tok", None).unwrap();
        assert!(url.starts_with("ws://127.0.0.1:9000/"));

        let url = build_ws_url("localhost:9000", "tok", None).unwrap();
        assert!(url.starts_with("ws://localhost:9000/"));
    }
}
