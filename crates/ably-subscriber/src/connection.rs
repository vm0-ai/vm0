//! Connection management: event loop, reconnection, and token renewal.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

use crate::Error;
use crate::protocol::{
    AuthDetails, ProtocolMessage, action, build_attach_msg, decode_msg, encode_msg,
};
use crate::types::{Event, Message, TokenDetails, TokenFuture};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = "ably-subscriber-rs/0.1";
const HEARTBEAT_MARGIN: Duration = Duration::from_secs(10);
const DEFAULT_MAX_IDLE_INTERVAL: Duration = Duration::from_secs(15);
const DEFAULT_CONNECTION_STATE_TTL: Duration = Duration::from_secs(120);
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const MAX_RETRY_ATTEMPTS: u32 = 40; // ~10 minutes
const TOKEN_RENEWAL_MARGIN: Duration = Duration::from_secs(300); // 5 minutes
const TOKEN_RENEWAL_RETRY_DELAY: Duration = Duration::from_secs(30);

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
    client: &reqwest::Client,
    token_request: &crate::TokenRequest,
    host: &str,
) -> Result<TokenDetails, Error> {
    let url = format!(
        "https://{host}/keys/{}/requestToken",
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

fn build_ws_url(host: &str, token: &str, resume: Option<(&str, i64)>) -> Result<String, Error> {
    let mut u = url::Url::parse(&format!("wss://{host}/"))?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("access_token", token);
        q.append_pair("format", "msgpack");
        q.append_pair("v", PROTOCOL_VERSION);
        q.append_pair("agent", AGENT_STRING);
        q.append_pair("heartbeats", "true");
        q.append_pair("echo", "false");
        if let Some((key, serial)) = resume {
            q.append_pair("resume", key);
            q.append_pair("connection_serial", &serial.to_string());
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
                    let err = msg.error.unwrap_or_default();
                    return Err(Error::Protocol {
                        code: err.code,
                        message: err.message,
                    });
                }
                action::DISCONNECTED => {
                    let err = msg.error.unwrap_or_default();
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
        code: 80000,
        message: "Connection closed before CONNECTED received".to_string(),
    })
}

async fn wait_for_attached(ws_read: &mut WsRead, channel: &str) -> Result<(), Error> {
    while let Some(frame) = ws_read.next().await {
        let frame = frame?;
        if let tungstenite::Message::Binary(data) = frame {
            let msg = decode_msg(&data)?;
            match msg.action {
                action::ATTACHED => {
                    if msg.channel.as_deref() == Some(channel) {
                        return Ok(());
                    }
                }
                action::ERROR => {
                    let err = msg.error.unwrap_or_default();
                    return Err(Error::Protocol {
                        code: err.code,
                        message: err.message,
                    });
                }
                action::DETACHED => {
                    let err = msg.error.unwrap_or_default();
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
        code: 90000,
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
) -> Result<(WsWrite, WsRead, ConnState), Error> {
    let ws_url = build_ws_url(realtime_host, &token.token, None)?;
    let (mut ws_write, mut ws_read) = connect_and_split(&ws_url).await?;
    let connected_msg = wait_for_connected(&mut ws_read).await?;
    let conn_state = ConnState::from_connected(&connected_msg, token);
    let attach = build_attach_msg(channel, channel_params);
    let encoded = encode_msg(&attach)?;
    ws_write
        .send(tungstenite::Message::Binary(encoded.into()))
        .await?;
    wait_for_attached(&mut ws_read, channel).await?;
    Ok((ws_write, ws_read, conn_state))
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

pub(crate) struct ConnState {
    pub connection_id: Option<String>,
    pub connection_key: Option<String>,
    pub connection_serial: i64,
    pub connection_state_ttl: Duration,
    pub max_idle_interval: Duration,
    pub disconnected_at: Option<Instant>,
    pub token: TokenDetails,
    pub token_renewal_at: Instant,
}

impl ConnState {
    fn from_connected(msg: &ProtocolMessage, token: TokenDetails) -> Self {
        let mut state = ConnState {
            connection_id: msg.connection_id.clone(),
            connection_key: msg.connection_key.clone(),
            connection_serial: msg.connection_serial.unwrap_or(-1),
            connection_state_ttl: DEFAULT_CONNECTION_STATE_TTL,
            max_idle_interval: DEFAULT_MAX_IDLE_INTERVAL,
            disconnected_at: None,
            token_renewal_at: Self::compute_renewal_at(&token),
            token,
        };

        if let Some(ref details) = msg.connection_details {
            if let Some(ttl) = details.connection_state_ttl {
                state.connection_state_ttl = Duration::from_millis(ttl as u64);
            }
            if let Some(idle) = details.max_idle_interval {
                state.max_idle_interval = Duration::from_millis(idle as u64);
            }
            if let Some(ref key) = details.connection_key {
                state.connection_key = Some(key.clone());
            }
        }

        state
    }

    fn compute_renewal_at(token: &TokenDetails) -> Instant {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let remaining_ms = (token.expires - now_ms).max(0) as u64;
        let margin_ms = TOKEN_RENEWAL_MARGIN.as_millis() as u64;
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

    fn update_serial(&mut self, msg: &ProtocolMessage) {
        if let Some(serial) = msg.connection_serial
            && serial > self.connection_serial
        {
            self.connection_serial = serial;
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
    pub http: reqwest::Client,
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
}

pub(crate) async fn run_event_loop(mut p: EventLoopState, mut close_rx: oneshot::Receiver<()>) {
    let mut retry_count: u32 = 0;

    'outer: loop {
        let mut disconnected_sent = false;
        // Main message processing loop
        loop {
            let idle_timeout = p.conn_state.max_idle_interval + HEARTBEAT_MARGIN;
            let idle_deadline = Instant::now() + idle_timeout;

            tokio::select! {
                frame = p.ws_read.next() => {
                    match frame {
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            retry_count = 0;
                            match decode_msg(&data) {
                                Ok(msg) => {
                                    p.conn_state.update_serial(&msg);
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
                    if let Err(e) = renew_token(&mut p).await {
                        tracing::error!("Token renewal failed: {e}");
                        // Push renewal time forward to avoid busy-loop on persistent failures
                        p.conn_state.token_renewal_at = Instant::now() + TOKEN_RENEWAL_RETRY_DELAY;
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
            if retry_count > MAX_RETRY_ATTEMPTS {
                let _ = p
                    .event_tx
                    .send(Event::Error {
                        code: 80000,
                        message: format!("Connection failed after {retry_count} attempts"),
                    })
                    .await;
                return;
            }

            // Use subsecond nanos from wall clock for non-deterministic jitter
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as u64;
            let jitter = Duration::from_millis(nanos % 2000);
            tokio::select! {
                _ = tokio::time::sleep(RETRY_INTERVAL + jitter) => {}
                _ = &mut close_rx => {
                    tracing::info!("Close requested during reconnect");
                    return;
                }
            }

            match tokio::time::timeout(CONNECT_TIMEOUT, attempt_reconnect(&mut p)).await {
                Ok(Ok(())) => {
                    retry_count = 0;
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

async fn handle_message(p: &mut EventLoopState, msg: ProtocolMessage) -> LoopAction {
    match msg.action {
        action::HEARTBEAT => {
            tracing::trace!("Heartbeat received");
        }
        action::MESSAGE => {
            if let Some(messages) = msg.messages {
                for m in messages {
                    let event = Event::Message(Message {
                        name: m.name,
                        data: m.data.unwrap_or(serde_json::Value::Null),
                        id: m.id,
                        client_id: m.client_id,
                        timestamp: m.timestamp,
                    });
                    if p.event_tx.send(event).await.is_err() {
                        return LoopAction::Stop;
                    }
                }
            }
        }
        action::DISCONNECTED => {
            let reason = msg.error.map(|e| e.message);
            let _ = p.event_tx.send(Event::Disconnected { reason }).await;
            return LoopAction::Reconnect;
        }
        action::ERROR => {
            let err = msg.error.unwrap_or_default();
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
            tracing::warn!(channel = ?msg.channel, "Channel detached, re-attaching");
            let attach = build_attach_msg(&p.channel, p.channel_params.as_ref());
            if let Ok(data) = encode_msg(&attach) {
                let _ = p
                    .ws_write
                    .send(tungstenite::Message::Binary(data.into()))
                    .await;
            }
        }
        action::ATTACHED => {
            tracing::info!(channel = ?msg.channel, "Channel attached");
        }
        action::CONNECTED => {
            if let Some(details) = msg.connection_details {
                if let Some(key) = details.connection_key {
                    p.conn_state.connection_key = Some(key);
                }
                if let Some(ttl) = details.connection_state_ttl {
                    p.conn_state.connection_state_ttl = Duration::from_millis(ttl as u64);
                }
                if let Some(idle) = details.max_idle_interval {
                    p.conn_state.max_idle_interval = Duration::from_millis(idle as u64);
                }
            }
            p.conn_state.connection_id = msg.connection_id;
        }
        action::CLOSED => {
            tracing::info!("Connection closed by server");
            return LoopAction::Stop;
        }
        action::AUTH => {
            tracing::info!("Server requested reauthentication");
            if let Err(e) = renew_token(p).await {
                tracing::error!("Server-initiated token renewal failed: {e}");
                p.conn_state.token_renewal_at = Instant::now() + TOKEN_RENEWAL_RETRY_DELAY;
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

async fn renew_token(p: &mut EventLoopState) -> Result<(), Error> {
    tracing::info!("Renewing token");
    let token_request = tokio::time::timeout(CONNECT_TIMEOUT, (p.get_token)())
        .await
        .map_err(|_| Error::Protocol {
            code: 80014,
            message: "Token fetch timed out".to_string(),
        })?
        .map_err(Error::TokenFetch)?;
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
    p.conn_state.token_renewal_at = ConnState::compute_renewal_at(&p.conn_state.token);
    tracing::info!("Token renewed successfully");
    Ok(())
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

async fn attempt_reconnect(p: &mut EventLoopState) -> Result<(), Error> {
    let use_resume = p.conn_state.can_resume();

    if !use_resume {
        let token_request = (p.get_token)().await.map_err(Error::TokenFetch)?;
        p.conn_state.token = exchange_token(&p.http, &token_request, &p.rest_host).await?;
        p.conn_state.token_renewal_at = ConnState::compute_renewal_at(&p.conn_state.token);
    }

    let resume = if use_resume {
        p.conn_state
            .connection_key
            .as_deref()
            .map(|key| (key, p.conn_state.connection_serial))
    } else {
        None
    };

    let ws_url = build_ws_url(&p.realtime_host, &p.conn_state.token.token, resume)?;
    let (ws_write, mut ws_read) = connect_and_split(&ws_url).await?;

    let connected_msg = wait_for_connected(&mut ws_read).await?;

    let resumed = use_resume
        && connected_msg.connection_id == p.conn_state.connection_id
        && connected_msg.error.is_none();

    let old_key = p.conn_state.connection_key.clone();
    let old_ttl = p.conn_state.connection_state_ttl;
    let old_idle = p.conn_state.max_idle_interval;
    p.conn_state.connection_id = connected_msg.connection_id.clone();
    p.conn_state.connection_key = connected_msg.connection_key.clone();
    p.conn_state.connection_serial = connected_msg.connection_serial.unwrap_or(-1);
    p.conn_state.disconnected_at = None;

    if let Some(ref details) = connected_msg.connection_details {
        if let Some(ref key) = details.connection_key {
            p.conn_state.connection_key = Some(key.clone());
        }
        if let Some(ttl) = details.connection_state_ttl {
            p.conn_state.connection_state_ttl = Duration::from_millis(ttl as u64);
        } else {
            p.conn_state.connection_state_ttl = old_ttl;
        }
        if let Some(idle) = details.max_idle_interval {
            p.conn_state.max_idle_interval = Duration::from_millis(idle as u64);
        } else {
            p.conn_state.max_idle_interval = old_idle;
        }
    } else {
        p.conn_state.connection_key = old_key;
    }

    p.ws_read = ws_read;
    p.ws_write = ws_write;

    if !resumed {
        tracing::info!("Resume failed or fresh connect, re-attaching channel");
        let attach = build_attach_msg(&p.channel, p.channel_params.as_ref());
        let data = encode_msg(&attach)?;
        p.ws_write
            .send(tungstenite::Message::Binary(data.into()))
            .await?;
        wait_for_attached(&mut p.ws_read, &p.channel).await?;
    } else {
        tracing::info!("Connection resumed successfully");
    }

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
        assert!(url.is_ok());
        let url = url.unwrap_or_default();
        assert!(url.starts_with("wss://realtime.ably.io/"));
        assert!(url.contains("access_token=my-token"));
        assert!(url.contains("format=msgpack"));
        assert!(url.contains("v=5"));
        assert!(url.contains("heartbeats=true"));
        assert!(url.contains("echo=false"));
        assert!(url.contains("agent=ably-subscriber-rs"));
        assert!(!url.contains("resume="));
    }

    #[test]
    fn build_ws_url_with_resume() {
        let url = build_ws_url("realtime.ably.io", "my-token", Some(("conn-key!abc", 42)));
        assert!(url.is_ok());
        let url = url.unwrap_or_default();
        assert!(url.contains("resume=conn-key"));
        assert!(url.contains("connection_serial=42"));
    }

    #[test]
    fn build_ws_url_custom_host() {
        let url = build_ws_url("sandbox-realtime.ably.io", "tok", None);
        assert!(url.is_ok());
        let url = url.unwrap_or_default();
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
        let state = ConnState::from_connected(&msg, token);
        assert_eq!(state.connection_id.as_deref(), Some("conn-1"));
        assert_eq!(state.connection_key.as_deref(), Some("conn-1!key"));
        assert_eq!(state.connection_serial, -1);
        assert_eq!(state.connection_state_ttl, Duration::from_millis(60000));
        assert_eq!(state.max_idle_interval, Duration::from_millis(10000));
    }

    #[test]
    fn conn_state_can_resume() {
        let mut state = ConnState {
            connection_id: Some("c1".to_string()),
            connection_key: Some("c1!key".to_string()),
            connection_serial: 5,
            connection_state_ttl: Duration::from_secs(120),
            max_idle_interval: Duration::from_secs(15),
            disconnected_at: None,
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
}
