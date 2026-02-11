//! Ably Pub/Sub subscribe-only Realtime SDK.
//!
//! Implements the minimum subset of the Ably realtime protocol needed for
//! subscribing to channels via WebSocket with MessagePack encoding.
//!
//! # Features
//! - TokenRequest-based authentication (exchange with Ably REST API)
//! - MessagePack binary protocol (Ably default)
//! - Automatic connection resume after disconnection
//! - Proactive token renewal before expiry
//! - Heartbeat-based connection liveness detection
//!
//! # Example
//! ```no_run
//! # async fn example() -> Result<(), ably_subscriber::Error> {
//! use ably_subscriber::{SubscribeConfig, Event};
//!
//! let config = ably_subscriber::SubscribeConfig {
//!     get_token: Box::new(|| Box::pin(async { todo!() })),
//!     channel: "my-channel".to_string(),
//!     channel_params: None,
//!     host: None,
//! };
//!
//! let mut sub = ably_subscriber::subscribe(config).await?;
//! while let Some(event) = sub.next().await {
//!     match event {
//!         Event::Message(msg) => println!("got: {:?}", msg.name),
//!         Event::Connected => println!("connected"),
//!         _ => {}
//!     }
//! }
//! # Ok(())
//! # }
//! ```

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A future that returns a `Result<TokenRequest>`.
pub type TokenFuture = Pin<Box<dyn Future<Output = Result<TokenRequest, BoxError>> + Send>>;

/// A boxed error type for the token callback.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Ably TokenRequest — a signed request obtained from your server.
///
/// Your server creates this using `client.auth.createTokenRequest()` and
/// returns it to the client. The client then exchanges it with Ably's REST API
/// for an actual token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    pub key_name: String,
    pub timestamp: i64,
    pub nonce: String,
    pub mac: String,
    pub capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// Ably TokenDetails — the actual token returned by Ably's REST API.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDetails {
    pub token: String,
    #[serde(default)]
    pub expires: i64,
    #[serde(default)]
    pub issued: i64,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

/// A message received from an Ably channel.
#[derive(Debug, Clone)]
pub struct Message {
    /// Event name (e.g. "job", "events", "status").
    pub name: Option<String>,
    /// Message payload.
    pub data: serde_json::Value,
    /// Unique message ID.
    pub id: Option<String>,
    /// Publisher's client ID.
    pub client_id: Option<String>,
    /// Server timestamp (milliseconds since epoch).
    pub timestamp: Option<i64>,
}

/// Events emitted by a [`Subscription`].
#[derive(Debug)]
pub enum Event {
    /// A message was received on the subscribed channel.
    Message(Message),
    /// Successfully connected (or reconnected) and channel is attached.
    Connected,
    /// Temporarily disconnected; the SDK will attempt to reconnect.
    Disconnected { reason: Option<String> },
    /// An unrecoverable error occurred.
    Error { code: i32, message: String },
}

/// Configuration for [`subscribe`].
pub struct SubscribeConfig {
    /// Callback that returns a fresh [`TokenRequest`] from your server.
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    /// Channel name to subscribe to (e.g. `"runner-group:my-group"`).
    pub channel: String,
    /// Optional channel parameters (e.g. `{"rewind": "2m"}`).
    pub channel_params: Option<HashMap<String, String>>,
    /// Ably realtime host. Defaults to `"realtime.ably.io"`.
    pub host: Option<String>,
}

/// Handle to a running subscription.
///
/// Call [`next`](Subscription::next) to receive events, or [`close`](Subscription::close) to
/// shut down the connection.
pub struct Subscription {
    rx: mpsc::Receiver<Event>,
    close_tx: Option<oneshot::Sender<()>>,
}

impl Subscription {
    /// Receive the next event. Returns `None` if the background task has exited.
    pub async fn next(&mut self) -> Option<Event> {
        self.rx.recv().await
    }

    /// Gracefully close the connection.
    pub fn close(mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Errors returned by this crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("WebSocket error: {0}")]
    WebSocket(Box<tungstenite::Error>),

    #[error("Token exchange HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("MessagePack decode error: {0}")]
    MsgpackDecode(#[from] rmp_serde::decode::Error),

    #[error("MessagePack encode error: {0}")]
    MsgpackEncode(#[from] rmp_serde::encode::Error),

    #[error("Ably protocol error: code={code}, {message}")]
    Protocol { code: i32, message: String },

    #[error("Token fetch failed: {0}")]
    TokenFetch(BoxError),

    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),

    #[error("Connection failed after {attempts} attempts")]
    ConnectionFailed { attempts: u32 },
}

impl From<tungstenite::Error> for Error {
    fn from(e: tungstenite::Error) -> Self {
        Error::WebSocket(Box::new(e))
    }
}

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

mod action {
    pub const HEARTBEAT: i32 = 0;
    pub const CONNECTED: i32 = 4;
    pub const DISCONNECTED: i32 = 6;
    pub const CLOSE: i32 = 7;
    pub const CLOSED: i32 = 8;
    pub const ERROR: i32 = 9;
    pub const ATTACH: i32 = 10;
    pub const ATTACHED: i32 = 11;
    pub const DETACHED: i32 = 13;
    pub const MESSAGE: i32 = 15;
    pub const AUTH: i32 = 17;
}

mod flags {
    #![allow(dead_code)]
    pub const HAS_PRESENCE: i32 = 1;
    pub const HAS_BACKLOG: i32 = 2;
    pub const HAS_CHANNEL_RESUMED: i32 = 4;
    pub const MODE_SUBSCRIBE: i32 = 262_144; // bit 18
}

const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = "ably-subscriber-rs/0.1";
const HEARTBEAT_MARGIN: Duration = Duration::from_secs(10);
const DEFAULT_MAX_IDLE_INTERVAL: Duration = Duration::from_secs(15);
const DEFAULT_CONNECTION_STATE_TTL: Duration = Duration::from_secs(120);
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const MAX_RETRY_ATTEMPTS: u32 = 40; // ~10 minutes
const TOKEN_RENEWAL_MARGIN: Duration = Duration::from_secs(300); // 5 minutes

// ---------------------------------------------------------------------------
// Wire protocol types (MessagePack)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct ProtocolMessage {
    action: i32,
    channel: Option<String>,
    #[serde(rename = "channelSerial")]
    channel_serial: Option<String>,
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    #[serde(rename = "connectionKey")]
    connection_key: Option<String>,
    #[serde(rename = "connectionDetails")]
    connection_details: Option<ConnectionDetails>,
    #[serde(rename = "connectionSerial")]
    connection_serial: Option<i64>,
    #[serde(rename = "msgSerial")]
    msg_serial: Option<i64>,
    flags: Option<i32>,
    error: Option<ErrorInfo>,
    auth: Option<AuthDetails>,
    messages: Option<Vec<AblyMessage>>,
    timestamp: Option<i64>,
    params: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct ConnectionDetails {
    #[serde(rename = "clientId")]
    client_id: Option<String>,
    #[serde(rename = "connectionKey")]
    connection_key: Option<String>,
    #[serde(rename = "connectionStateTtl")]
    connection_state_ttl: Option<i64>,
    #[serde(rename = "maxIdleInterval")]
    max_idle_interval: Option<i64>,
    #[serde(rename = "maxMessageSize")]
    max_message_size: Option<i64>,
    #[serde(rename = "maxFrameSize")]
    max_frame_size: Option<i64>,
    #[serde(rename = "serverId")]
    server_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct ErrorInfo {
    code: i32,
    #[serde(rename = "statusCode")]
    status_code: Option<i32>,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct AuthDetails {
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct AblyMessage {
    id: Option<String>,
    name: Option<String>,
    data: Option<serde_json::Value>,
    #[serde(rename = "clientId")]
    client_id: Option<String>,
    timestamp: Option<i64>,
    encoding: Option<String>,
}

// ---------------------------------------------------------------------------
// Encode / decode helpers
// ---------------------------------------------------------------------------

fn encode_msg(msg: &ProtocolMessage) -> Result<Vec<u8>, Error> {
    Ok(rmp_serde::to_vec_named(msg)?)
}

fn decode_msg(data: &[u8]) -> Result<ProtocolMessage, Error> {
    Ok(rmp_serde::from_slice(data)?)
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/// Derive REST host from realtime host.
fn rest_host(realtime_host: &str) -> String {
    if realtime_host == DEFAULT_REALTIME_HOST {
        "rest.ably.io".to_string()
    } else {
        realtime_host.to_string()
    }
}

/// Exchange a TokenRequest for a TokenDetails via Ably's REST API.
async fn exchange_token(
    client: &reqwest::Client,
    token_request: &TokenRequest,
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
// Connection state
// ---------------------------------------------------------------------------

struct ConnState {
    connection_id: Option<String>,
    connection_key: Option<String>,
    connection_serial: i64,
    connection_state_ttl: Duration,
    max_idle_interval: Duration,
    disconnected_at: Option<Instant>,
    token: TokenDetails,
    token_renewal_at: Instant,
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
// Core: subscribe
// ---------------------------------------------------------------------------

/// Subscribe to an Ably channel.
///
/// Establishes a WebSocket connection, exchanges the token, attaches to the
/// channel, and returns a [`Subscription`] that yields [`Event`]s.
///
/// The background task automatically handles reconnection, token renewal, and
/// heartbeat timeout detection.
pub async fn subscribe(config: SubscribeConfig) -> Result<Subscription, Error> {
    let (event_tx, event_rx) = mpsc::channel::<Event>(64);
    let (close_tx, close_rx) = oneshot::channel::<()>();

    let realtime_host = config
        .host
        .as_deref()
        .unwrap_or(DEFAULT_REALTIME_HOST)
        .to_string();
    let rest = rest_host(&realtime_host);
    let http = reqwest::Client::new();

    // Initial token exchange
    let token_request = (config.get_token)().await.map_err(Error::TokenFetch)?;
    let token = exchange_token(&http, &token_request, &rest).await?;

    // Connect WebSocket
    let ws_url = build_ws_url(&realtime_host, &token.token, None)?;
    let (ws_write, mut ws_read) = connect_and_split(&ws_url).await?;

    // Wait for CONNECTED
    let connected_msg = wait_for_connected(&mut ws_read).await?;
    let conn_state = ConnState::from_connected(&connected_msg, token);

    // Send ATTACH
    let attach = build_attach_msg(&config.channel, config.channel_params.as_ref());
    let mut ws_write = ws_write;
    let encoded = encode_msg(&attach)?;
    ws_write
        .send(tungstenite::Message::Binary(encoded.into()))
        .await?;

    // Wait for ATTACHED
    wait_for_attached(&mut ws_read, &config.channel).await?;

    let _ = event_tx.send(Event::Connected).await;

    // Spawn background event loop
    tokio::spawn(run_event_loop(
        EventLoopState {
            ws_read,
            ws_write,
            event_tx,
            conn_state,
            channel: config.channel,
            channel_params: config.channel_params,
            realtime_host,
            rest_host: rest,
            http,
            get_token: config.get_token,
        },
        close_rx,
    ));

    Ok(Subscription {
        rx: event_rx,
        close_tx: Some(close_tx),
    })
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

type WsRead = futures_util::stream::SplitStream<WsStream>;
type WsWrite = futures_util::stream::SplitSink<WsStream, tungstenite::Message>;

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

fn build_attach_msg(channel: &str, params: Option<&HashMap<String, String>>) -> ProtocolMessage {
    ProtocolMessage {
        action: action::ATTACH,
        channel: Some(channel.to_string()),
        flags: Some(flags::MODE_SUBSCRIBE),
        params: params.cloned(),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Background event loop
// ---------------------------------------------------------------------------

struct EventLoopState {
    ws_read: WsRead,
    ws_write: WsWrite,
    event_tx: mpsc::Sender<Event>,
    conn_state: ConnState,
    channel: String,
    channel_params: Option<HashMap<String, String>>,
    realtime_host: String,
    rest_host: String,
    http: reqwest::Client,
    get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
}

async fn run_event_loop(mut p: EventLoopState, mut close_rx: oneshot::Receiver<()>) {
    let mut retry_count: u32 = 0;

    'outer: loop {
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
                                    if handle_message(&mut p, &msg).await == LoopAction::Stop {
                                        return;
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
        let _ = p.event_tx.send(Event::Disconnected { reason: None }).await;

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

            let jitter = Duration::from_millis((retry_count as u64 * 137) % 2000);
            tokio::select! {
                _ = tokio::time::sleep(RETRY_INTERVAL + jitter) => {}
                _ = &mut close_rx => {
                    tracing::info!("Close requested during reconnect");
                    return;
                }
            }

            match attempt_reconnect(&mut p).await {
                Ok(()) => {
                    retry_count = 0;
                    let _ = p.event_tx.send(Event::Connected).await;
                    continue 'outer;
                }
                Err(e) => {
                    tracing::warn!("Reconnect attempt {retry_count} failed: {e}");
                }
            }
        }
    }
}

#[derive(PartialEq, Eq)]
enum LoopAction {
    Continue,
    Stop,
}

async fn handle_message(p: &mut EventLoopState, msg: &ProtocolMessage) -> LoopAction {
    match msg.action {
        action::HEARTBEAT => {
            tracing::trace!("Heartbeat received");
        }
        action::MESSAGE => {
            if let Some(ref messages) = msg.messages {
                for m in messages {
                    let event = Event::Message(Message {
                        name: m.name.clone(),
                        data: m.data.clone().unwrap_or(serde_json::Value::Null),
                        id: m.id.clone(),
                        client_id: m.client_id.clone(),
                        timestamp: m.timestamp,
                    });
                    if p.event_tx.send(event).await.is_err() {
                        return LoopAction::Stop;
                    }
                }
            }
        }
        action::DISCONNECTED => {
            let reason = msg.error.as_ref().map(|e| e.message.clone());
            let _ = p.event_tx.send(Event::Disconnected { reason }).await;
            // The outer loop will handle reconnection
        }
        action::ERROR => {
            let err = msg.error.clone().unwrap_or_default();
            let _ = p
                .event_tx
                .send(Event::Error {
                    code: err.code,
                    message: err.message,
                })
                .await;
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
            // Received during AUTH renewal — update connection details
            if let Some(ref details) = msg.connection_details {
                if let Some(ref key) = details.connection_key {
                    p.conn_state.connection_key = Some(key.clone());
                }
                if let Some(ttl) = details.connection_state_ttl {
                    p.conn_state.connection_state_ttl = Duration::from_millis(ttl as u64);
                }
                if let Some(idle) = details.max_idle_interval {
                    p.conn_state.max_idle_interval = Duration::from_millis(idle as u64);
                }
            }
            p.conn_state.connection_id = msg.connection_id.clone();
        }
        action::CLOSED => {
            tracing::info!("Connection closed by server");
            return LoopAction::Stop;
        }
        action::AUTH => {
            // Server requests reauth
            tracing::info!("Server requested reauthentication");
            if let Err(e) = renew_token(p).await {
                tracing::error!("Server-initiated token renewal failed: {e}");
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
    p.conn_state.token_renewal_at = ConnState::compute_renewal_at(&p.conn_state.token);
    tracing::info!("Token renewed successfully");
    Ok(())
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

async fn attempt_reconnect(p: &mut EventLoopState) -> Result<(), Error> {
    let use_resume = p.conn_state.can_resume();

    // Get a fresh token if needed
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

    // Wait for CONNECTED
    let connected_msg = wait_for_connected(&mut ws_read).await?;

    // Check if resume succeeded
    let resumed = use_resume
        && connected_msg.connection_id == p.conn_state.connection_id
        && connected_msg.error.is_none();

    // Update state from new CONNECTED message
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

    // Re-attach channel if not resumed
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

    // -- Token serde --

    #[test]
    fn token_request_json_round_trip() {
        let tr = TokenRequest {
            key_name: "xVLyHw.mDYnFA".to_string(),
            timestamp: 1700000000000,
            nonce: "abc123".to_string(),
            mac: "base64mac==".to_string(),
            capability: r#"{"channel":["subscribe"]}"#.to_string(),
            ttl: Some(3600000),
            client_id: None,
        };
        let json = serde_json::to_string(&tr).unwrap_or_default();
        assert!(json.contains("keyName"));
        assert!(json.contains("xVLyHw.mDYnFA"));
        assert!(!json.contains("clientId")); // None → skipped

        let parsed: TokenRequest = serde_json::from_str(&json).unwrap_or_else(|_| tr.clone());
        assert_eq!(parsed.key_name, "xVLyHw.mDYnFA");
        assert_eq!(parsed.ttl, Some(3600000));
    }

    #[test]
    fn token_details_json_deserialization() {
        let json = r#"{
            "token": "xVLyHw.some-token-string",
            "keyName": "xVLyHw.mDYnFA",
            "issued": 1700000000000,
            "expires": 1700003600000,
            "capability": "{\"*\":[\"*\"]}"
        }"#;
        let td: TokenDetails = serde_json::from_str(json).unwrap_or_default();
        assert_eq!(td.token, "xVLyHw.some-token-string");
        assert_eq!(td.expires, 1700003600000);
        assert_eq!(td.issued, 1700000000000);
    }

    // -- Protocol message msgpack round-trip --

    #[test]
    fn encode_decode_attach() {
        let msg = ProtocolMessage {
            action: action::ATTACH,
            channel: Some("test-channel".to_string()),
            flags: Some(flags::MODE_SUBSCRIBE),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::ATTACH);
        assert_eq!(decoded.channel.as_deref(), Some("test-channel"));
        assert_eq!(decoded.flags, Some(flags::MODE_SUBSCRIBE));
    }

    #[test]
    fn encode_decode_close() {
        let msg = ProtocolMessage {
            action: action::CLOSE,
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::CLOSE);
    }

    #[test]
    fn encode_decode_auth() {
        let msg = ProtocolMessage {
            action: action::AUTH,
            auth: Some(AuthDetails {
                access_token: "my-token".to_string(),
            }),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::AUTH);
        assert_eq!(
            decoded.auth.as_ref().map(|a| a.access_token.as_str()),
            Some("my-token")
        );
    }

    #[test]
    fn encode_decode_connected() {
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("abc123".to_string()),
            connection_key: Some("abc123!key".to_string()),
            connection_serial: Some(-1),
            connection_details: Some(ConnectionDetails {
                connection_state_ttl: Some(120000),
                max_idle_interval: Some(15000),
                server_id: Some("frontend.0".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::CONNECTED);
        assert_eq!(decoded.connection_id.as_deref(), Some("abc123"));
        assert_eq!(decoded.connection_key.as_deref(), Some("abc123!key"));
        assert_eq!(decoded.connection_serial, Some(-1));
        let details = decoded.connection_details.as_ref();
        assert!(details.is_some());
        let default_details = ConnectionDetails::default();
        let details = details.unwrap_or(&default_details);
        assert_eq!(details.connection_state_ttl, Some(120000));
        assert_eq!(details.max_idle_interval, Some(15000));
    }

    #[test]
    fn encode_decode_message_with_data() {
        let msg = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("runner-group:test".to_string()),
            connection_serial: Some(5),
            messages: Some(vec![AblyMessage {
                id: Some("msg-001".to_string()),
                name: Some("job".to_string()),
                data: Some(serde_json::json!({"runId": "uuid-123"})),
                client_id: Some("publisher".to_string()),
                timestamp: Some(1700000000000),
                encoding: None,
            }]),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::MESSAGE);
        assert_eq!(decoded.channel.as_deref(), Some("runner-group:test"));
        let messages = decoded.messages.as_ref();
        assert!(messages.is_some());
        let empty_vec = Vec::new();
        let messages = messages.unwrap_or(&empty_vec);
        assert_eq!(messages.len(), 1);
        if let Some(m) = messages.first() {
            assert_eq!(m.name.as_deref(), Some("job"));
            assert_eq!(
                m.data
                    .as_ref()
                    .and_then(|d| d.get("runId"))
                    .and_then(|v| v.as_str()),
                Some("uuid-123")
            );
        }
    }

    #[test]
    fn encode_decode_heartbeat() {
        let msg = ProtocolMessage {
            action: action::HEARTBEAT,
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::HEARTBEAT);
    }

    #[test]
    fn encode_decode_error() {
        let msg = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 40142,
                status_code: Some(401),
                message: "Token expired".to_string(),
            }),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::ERROR);
        let err = decoded.error.as_ref();
        assert!(err.is_some());
        let default_err = ErrorInfo::default();
        let err = err.unwrap_or(&default_err);
        assert_eq!(err.code, 40142);
        assert_eq!(err.status_code, Some(401));
        assert_eq!(err.message, "Token expired");
    }

    #[test]
    fn encode_decode_disconnected() {
        let msg = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "Connection lost".to_string(),
            }),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::DISCONNECTED);
        assert_eq!(decoded.error.as_ref().map(|e| e.code), Some(80003));
    }

    #[test]
    fn encode_decode_attach_with_params() {
        let mut params = HashMap::new();
        params.insert("rewind".to_string(), "2m".to_string());
        let msg = ProtocolMessage {
            action: action::ATTACH,
            channel: Some("run:uuid-123".to_string()),
            flags: Some(flags::MODE_SUBSCRIBE),
            params: Some(params),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap_or_default();
        let decoded = decode_msg(&data).unwrap_or_default();
        assert_eq!(decoded.action, action::ATTACH);
        assert_eq!(
            decoded
                .params
                .as_ref()
                .and_then(|p| p.get("rewind"))
                .map(String::as_str),
            Some("2m")
        );
    }

    // -- URL construction --

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

    // -- REST host derivation --

    #[test]
    fn rest_host_default() {
        assert_eq!(rest_host("realtime.ably.io"), "rest.ably.io");
    }

    #[test]
    fn rest_host_custom() {
        assert_eq!(rest_host("custom.example.com"), "custom.example.com");
    }

    // -- ConnState --

    #[test]
    fn conn_state_from_connected() {
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-1".to_string()),
            connection_key: Some("conn-1!key".to_string()),
            connection_serial: Some(-1),
            connection_details: Some(ConnectionDetails {
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

    // -- Action / flag constants --

    #[test]
    fn action_constants() {
        assert_eq!(action::HEARTBEAT, 0);
        assert_eq!(action::CONNECTED, 4);
        assert_eq!(action::DISCONNECTED, 6);
        assert_eq!(action::CLOSE, 7);
        assert_eq!(action::CLOSED, 8);
        assert_eq!(action::ERROR, 9);
        assert_eq!(action::ATTACH, 10);
        assert_eq!(action::ATTACHED, 11);
        assert_eq!(action::DETACHED, 13);
        assert_eq!(action::MESSAGE, 15);
        assert_eq!(action::AUTH, 17);
    }

    #[test]
    fn flag_constants() {
        assert_eq!(flags::MODE_SUBSCRIBE, 262_144);
        assert_eq!(flags::MODE_SUBSCRIBE, 1 << 18);
        assert_eq!(flags::HAS_PRESENCE, 1);
        assert_eq!(flags::HAS_BACKLOG, 2);
        assert_eq!(flags::HAS_CHANNEL_RESUMED, 4);
    }

    // -- build_attach_msg --

    #[test]
    fn build_attach_msg_basic() {
        let msg = build_attach_msg("my-channel", None);
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("my-channel"));
        assert_eq!(msg.flags, Some(flags::MODE_SUBSCRIBE));
        assert!(msg.params.is_none());
    }

    #[test]
    fn build_attach_msg_with_rewind() {
        let mut params = HashMap::new();
        params.insert("rewind".to_string(), "2m".to_string());
        let msg = build_attach_msg("run:abc", Some(&params));
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("run:abc"));
        assert_eq!(
            msg.params
                .as_ref()
                .and_then(|p| p.get("rewind"))
                .map(String::as_str),
            Some("2m")
        );
    }
}
