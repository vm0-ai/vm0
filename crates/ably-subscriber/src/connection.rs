//! Connection management: event loop, reconnection, and token renewal.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use crate::Error;
use crate::TokenRequest;
use crate::protocol::{
    AuthDetails, ErrorInfo, ProtocolMessage, action, build_attach_msg, decode_msg, encode_msg,
    error_code, flags,
};
use crate::types::{Event, Message, TimingConfig, TokenDetails, TokenFuture, redact_access_token};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = concat!("ably-subscriber-rs/", env!("CARGO_PKG_VERSION"));

fn is_localhost(host: &str) -> bool {
    let Ok(url) = url::Url::parse(&format!("http://{host}/")) else {
        return false;
    };

    match url.host() {
        Some(url::Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") => true,
        Some(url::Host::Ipv4(addr)) if addr == std::net::Ipv4Addr::LOCALHOST => true,
        Some(url::Host::Ipv6(addr)) if addr == std::net::Ipv6Addr::LOCALHOST => true,
        _ => false,
    }
}

fn error_or_unknown(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
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
    client: &reqwest::Client,
    token_request: &TokenRequest,
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
                        message: protocol_error_message(err.message),
                    });
                }
                action::DISCONNECTED => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_error_message(err.message),
                    });
                }
                _ => {
                    tracing::info!(action = msg.action, "Ignoring pre-CONNECTED message");
                }
            }
        }
    }
    Err(Error::Protocol {
        code: error_code::FAILED,
        message: "Connection closed before CONNECTED received".to_string(),
    })
}

enum AttachOutcome {
    Attached { channel_serial: Option<String> },
    Detached(ErrorInfo),
    RetryAttach(ErrorInfo),
    Closed(ErrorInfo),
    TimedOut,
}

fn detached_error_or_default(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
        code: error_code::CHANNEL_OPERATION_FAILED,
        status_code: Some(404),
        message: "Channel detached".to_string(),
    })
}

fn closed_error_or_default(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
        code: error_code::FAILED,
        status_code: None,
        message: "Connection closed by server".to_string(),
    })
}

async fn wait_for_attach_outcome(
    ws_read: &mut WsRead,
    channel: &str,
) -> Result<AttachOutcome, Error> {
    while let Some(frame) = ws_read.next().await {
        let frame = frame?;
        if let tungstenite::Message::Binary(data) = frame {
            let msg = decode_msg(&data)?;
            match msg.action {
                action::ATTACHED => {
                    if msg.channel.as_deref() == Some(channel) {
                        return Ok(AttachOutcome::Attached {
                            channel_serial: msg.channel_serial,
                        });
                    }
                }
                action::ERROR => {
                    let err = error_or_unknown(msg.error);
                    if let Some(msg_channel) = msg.channel.as_deref() {
                        if msg_channel != channel {
                            continue;
                        }
                        if err.code == 80016 {
                            return Ok(AttachOutcome::RetryAttach(err));
                        }
                    }
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_error_message(err.message),
                    });
                }
                action::DETACHED => {
                    if msg.channel.as_deref() == Some(channel) {
                        return Ok(AttachOutcome::Detached(detached_error_or_default(
                            msg.error,
                        )));
                    }
                }
                action::DISCONNECTED => {
                    let err = error_or_unknown(msg.error.clone());
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_disconnect_reason(msg.error),
                    });
                }
                action::CLOSED => {
                    return Ok(AttachOutcome::Closed(closed_error_or_default(msg.error)));
                }
                _ => {
                    tracing::info!(action = msg.action, "Ignoring pre-ATTACHED message");
                }
            }
        }
    }
    Err(Error::Protocol {
        code: error_code::CHANNEL_OPERATION_FAILED,
        message: "Connection closed before ATTACHED received".to_string(),
    })
}

async fn wait_for_attached(ws_read: &mut WsRead, channel: &str) -> Result<Option<String>, Error> {
    match wait_for_attach_outcome(ws_read, channel).await? {
        AttachOutcome::Attached { channel_serial } => Ok(channel_serial),
        AttachOutcome::Detached(err) => Err(Error::Protocol {
            code: err.code,
            message: channel_detached_message(&err.message),
        }),
        AttachOutcome::RetryAttach(err) => Err(Error::Protocol {
            code: err.code,
            message: protocol_error_message(err.message),
        }),
        AttachOutcome::Closed(err) => Err(Error::Protocol {
            code: err.code,
            message: protocol_error_message(err.message),
        }),
        AttachOutcome::TimedOut => Err(Error::Protocol {
            code: error_code::TIMEOUT,
            message: "Channel attach timed out".to_string(),
        }),
    }
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
    conn_state.channel_serial = wait_for_attached(&mut ws_read, channel).await?;
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
    pub max_idle_interval: Option<Duration>,
    pub disconnected_at: Option<Instant>,
    pub token: TokenDetails,
    pub token_renewal_at: Option<Instant>,
}

impl ConnState {
    fn from_connected(msg: &ProtocolMessage, token: TokenDetails, timing: &TimingConfig) -> Self {
        let mut state = ConnState {
            connection_id: None,
            connection_key: None,
            channel_serial: None,
            connection_state_ttl: timing.default_connection_state_ttl,
            max_idle_interval: Some(timing.default_max_idle_interval),
            disconnected_at: None,
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
            if let Some(ttl) = details.connection_state_ttl
                && let Some(ttl) = positive_external_millis(ttl)
            {
                self.connection_state_ttl = ttl;
            }
            self.max_idle_interval = details.max_idle_interval.and_then(positive_external_millis);
        }
    }

    fn compute_renewal_at(token: &TokenDetails, margin: Duration) -> Option<Instant> {
        let now_ms = unix_now_ms();
        let remaining_ms = token.expires.saturating_sub(now_ms);
        if remaining_ms <= 0 {
            return Some(Instant::now());
        }

        let renew_in_ms = (remaining_ms as u128).saturating_sub(margin.as_millis());
        let renew_in = Duration::from_millis(u64::try_from(renew_in_ms).ok()?);
        checked_deadline_after(renew_in)
    }

    /// Resume is allowed while the Ably connection state is still retained and
    /// we have a connection key. This mirrors ably-js' suspend timer: once a
    /// connection has been detected as disconnected, the resumable window is
    /// `connection_state_ttl`.
    fn can_resume(&self) -> bool {
        if let Some(disconnected_at) = self.disconnected_at {
            disconnected_at.elapsed() < self.connection_state_ttl && self.connection_key.is_some()
        } else {
            false
        }
    }
}

fn unix_now_ms() -> i64 {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(now_ms).unwrap_or(i64::MAX)
}

fn positive_external_millis(value: i64) -> Option<Duration> {
    if value <= 0 {
        return None;
    }
    Some(Duration::from_millis(value as u64))
}

fn checked_deadline_after(duration: Duration) -> Option<Instant> {
    Instant::now().checked_add(duration)
}

fn checked_deadline_from(start: Instant, duration: Duration) -> Option<Instant> {
    start.checked_add(duration)
}

fn idle_deadline(
    max_idle_interval: Option<Duration>,
    heartbeat_margin: Duration,
) -> Option<(Instant, Duration)> {
    let idle_timeout = max_idle_interval?.checked_add(heartbeat_margin)?;
    let deadline = checked_deadline_after(idle_timeout)?;
    Some((deadline, idle_timeout))
}

// ---------------------------------------------------------------------------
// Background event loop
// ---------------------------------------------------------------------------

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

pub(crate) struct WsTransport {
    ws_read: WsRead,
    ws_write: WsWrite,
}

impl WsTransport {
    pub(crate) fn new(ws_read: WsRead, ws_write: WsWrite) -> Self {
        Self { ws_read, ws_write }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionLifecycleState {
    Connecting,
    Connected,
    Disconnected,
    Suspended,
    Closing,
    Closed,
    Failed,
}

impl ConnectionLifecycleState {
    fn send_events(self) -> bool {
        matches!(self, Self::Connected)
    }

    fn queue_events(self) -> bool {
        matches!(self, Self::Connecting | Self::Disconnected)
    }

    fn terminal(self) -> bool {
        matches!(self, Self::Closed | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChannelLifecycleState {
    Attaching,
    Attached,
    Detached,
    Suspended,
    Failed,
}

#[derive(Debug, Clone)]
pub(crate) struct RealtimeStateMachine {
    connection: ConnectionLifecycleState,
    channel: ChannelLifecycleState,
}

impl RealtimeStateMachine {
    pub(crate) fn connected() -> Self {
        Self {
            connection: ConnectionLifecycleState::Connected,
            channel: ChannelLifecycleState::Attached,
        }
    }

    fn request_connecting(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Connecting);
        // Our reconnect attempt performs transport activation and channel attach
        // in one async step. Mark the channel as attaching before that step so
        // the lifecycle still mirrors ably-js' attached -> attaching -> attached
        // transition for every new transport.
        if matches!(
            self.channel,
            ChannelLifecycleState::Attached | ChannelLifecycleState::Suspended
        ) {
            self.transition_channel(ChannelLifecycleState::Attaching);
        }
    }

    fn notify_transport_connected(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Connected);
        self.on_transport_active();
    }

    fn notify_connected(&mut self) {
        self.notify_transport_connected();
        self.notify_channel_attached();
    }

    fn notify_disconnected(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Disconnected);
    }

    fn notify_suspended(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Suspended);
        self.notify_channel_suspended();
    }

    fn request_closing(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Closing);
        self.notify_channel_detached();
    }

    fn notify_closed(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Closed);
        self.notify_channel_detached();
    }

    fn notify_failed(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Failed);
        self.notify_channel_failed();
    }

    fn request_channel_attaching(&mut self) {
        if self.connection.send_events() {
            self.transition_channel(ChannelLifecycleState::Attaching);
        }
    }

    fn notify_channel_attached(&mut self) {
        self.transition_channel(ChannelLifecycleState::Attached);
    }

    fn notify_channel_detached(&mut self) {
        self.transition_channel(ChannelLifecycleState::Detached);
    }

    fn notify_channel_suspended(&mut self) {
        self.transition_channel(ChannelLifecycleState::Suspended);
    }

    fn notify_channel_failed(&mut self) {
        self.transition_channel(ChannelLifecycleState::Failed);
    }

    fn on_transport_active(&mut self) {
        // Matches ably-js Channels.onTransportActive(): when a new transport
        // becomes active, any attached/suspended channel must re-attach on that
        // transport rather than assuming server-side channel state survived.
        match self.channel {
            ChannelLifecycleState::Attaching => {}
            ChannelLifecycleState::Suspended | ChannelLifecycleState::Attached => {
                self.request_channel_attaching();
            }
            ChannelLifecycleState::Detached | ChannelLifecycleState::Failed => {}
        }
    }

    fn transition_connection(&mut self, next: ConnectionLifecycleState) {
        if self.connection.terminal() || self.connection == next {
            return;
        }
        tracing::info!(
            previous = ?self.connection,
            current = ?next,
            queue_events = next.queue_events(),
            send_events = next.send_events(),
            "Ably connection state transition",
        );
        self.connection = next;
    }

    fn transition_channel(&mut self, next: ChannelLifecycleState) {
        if self.channel == next {
            return;
        }
        tracing::info!(
            previous = ?self.channel,
            current = ?next,
            "Ably channel state transition",
        );
        self.channel = next;
    }
}

impl ConnState {
    fn clear_resume_state(&mut self) {
        self.connection_id = None;
        self.connection_key = None;
        self.channel_serial = None;
    }
}

fn websocket_close_reason(frame: Option<&CloseFrame>) -> String {
    match frame {
        Some(frame) if frame.reason.is_empty() => {
            format!("websocket closed code={}", frame.code)
        }
        Some(frame) => {
            let reason = websocket_close_frame_reason(frame);
            format!("websocket closed code={} reason={}", frame.code, reason)
        }
        None => "websocket closed without close frame".to_string(),
    }
}

fn websocket_close_frame_reason(frame: &CloseFrame) -> String {
    redact_access_token(frame.reason.as_ref())
}

fn websocket_error_reason(error: &tungstenite::Error) -> String {
    format!(
        "websocket error: {}",
        redact_access_token(&error.to_string())
    )
}

fn protocol_disconnect_reason(error: Option<ErrorInfo>) -> String {
    match error {
        Some(error) if !error.message.is_empty() => redact_access_token(&error.message),
        Some(error) => {
            let status = error
                .status_code
                .map(|status_code| format!(" status={status_code}"))
                .unwrap_or_default();
            format!("server sent DISCONNECTED code={}{}", error.code, status)
        }
        None => "server sent DISCONNECTED without error details".to_string(),
    }
}

fn protocol_error_message(message: String) -> String {
    redact_access_token(&message)
}

fn channel_detached_message(message: &str) -> String {
    format!("Channel detached: {}", redact_access_token(message))
}

fn reconnect_spacing_delay(last_attempt: Option<Instant>, min_interval: Duration) -> Duration {
    last_attempt.map_or(Duration::ZERO, |attempt| {
        min_interval.saturating_sub(attempt.elapsed())
    })
}

fn retry_delay(initial_timeout: Duration, retry_attempt: u32) -> Duration {
    // Mirrors ably-js Utils.getRetryTime(): base * min((attempt + 2) / 3, 2)
    // with jitter in [0.8, 1.0). Use wall-clock subsecond nanos as a cheap
    // process-local jitter source; cryptographic randomness is unnecessary.
    let backoff_num = (retry_attempt + 2).min(6) as u128;
    let base_ms = initial_timeout.as_millis();
    let upper_ms = base_ms.saturating_mul(backoff_num) / 3;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u128;
    let jitter_per_mille = 800 + (nanos % 200);
    Duration::from_millis(upper_ms.saturating_mul(jitter_per_mille) as u64 / 1000)
}

async fn sleep_until_optional(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn message_targets_channel(msg: &ProtocolMessage, channel: &str) -> bool {
    msg.channel.as_deref() == Some(channel)
}

fn encode_attach_for_channel(
    channel: &str,
    channel_params: Option<&HashMap<String, String>>,
    channel_serial: Option<&str>,
) -> Result<Vec<u8>, Error> {
    let attach = build_attach_msg(channel, channel_params, channel_serial);
    encode_msg(&attach)
}

fn request_channel_attach(p: &mut EventLoopState) -> bool {
    p.lifecycle.request_channel_attaching();
    if p.lifecycle.channel != ChannelLifecycleState::Attaching
        || !p.lifecycle.connection.send_events()
    {
        return false;
    }

    p.channel_retry_at = None;
    p.channel_operation_deadline = Some(Instant::now() + p.timing.realtime_request_timeout);
    true
}

fn schedule_channel_retry(p: &mut EventLoopState) {
    p.channel_operation_deadline = None;
    if p.lifecycle.channel == ChannelLifecycleState::Suspended
        && p.lifecycle.connection.send_events()
    {
        p.channel_retry_count += 1;
        p.channel_retry_at = Some(
            Instant::now() + retry_delay(p.timing.channel_retry_timeout, p.channel_retry_count),
        );
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
                        LoopAction::Reconnect => {
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
                                        LoopAction::Reconnect => {
                                            disconnected_sent = true;
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

enum LoopAction {
    Continue,
    Stop,
    Reconnect,
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
            return LoopAction::Reconnect;
        }
    };

    let connect_timeout = p.timing.connect_timeout;
    let Some(transport) = p.transport.as_mut() else {
        tracing::warn!("Missing websocket transport for attach");
        return LoopAction::Reconnect;
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
            LoopAction::Reconnect
        }
        Err(_) => {
            tracing::warn!("Timed out sending attach, triggering reconnect");
            close_websocket_transport(p);
            LoopAction::Reconnect
        }
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
            return LoopAction::Reconnect;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ConnectionDetails;

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
        let timing = TimingConfig::default();
        let state = ConnState::from_connected(&msg, token, &timing);
        assert_eq!(state.connection_id.as_deref(), Some("conn-1"));
        assert_eq!(state.connection_key.as_deref(), Some("conn-1!key"));
        assert_eq!(state.connection_state_ttl, Duration::from_millis(60000));
        assert_eq!(state.max_idle_interval, Some(Duration::from_millis(10000)));
        assert!(state.token_renewal_at.is_some());
    }

    #[test]
    fn conn_state_ignores_non_positive_connection_state_ttl() {
        let timing = TimingConfig::default();
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: unix_now_ms() + 3_600_000,
            issued: 0,
            capability: None,
            client_id: None,
        };

        for ttl in [0, -1] {
            let msg = ProtocolMessage {
                action: action::CONNECTED,
                connection_details: Some(ConnectionDetails {
                    connection_state_ttl: Some(ttl),
                    max_idle_interval: Some(10000),
                    ..Default::default()
                }),
                ..Default::default()
            };

            let state = ConnState::from_connected(&msg, token.clone(), &timing);
            assert_eq!(
                state.connection_state_ttl,
                timing.default_connection_state_ttl
            );
        }
    }

    #[test]
    fn conn_state_keeps_default_connection_state_ttl_when_details_omit_ttl() {
        let timing = TimingConfig::default();
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: unix_now_ms() + 3_600_000,
            issued: 0,
            capability: None,
            client_id: None,
        };
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_details: Some(ConnectionDetails {
                connection_state_ttl: None,
                max_idle_interval: Some(10000),
                ..Default::default()
            }),
            ..Default::default()
        };

        let state = ConnState::from_connected(&msg, token, &timing);
        assert_eq!(
            state.connection_state_ttl,
            timing.default_connection_state_ttl
        );
        assert_eq!(state.max_idle_interval, Some(Duration::from_millis(10000)));
    }

    #[test]
    fn conn_state_disables_idle_timeout_for_missing_or_non_positive_idle_interval() {
        let timing = TimingConfig::default();
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: unix_now_ms() + 3_600_000,
            issued: 0,
            capability: None,
            client_id: None,
        };

        for idle in [None, Some(0), Some(-1)] {
            let msg = ProtocolMessage {
                action: action::CONNECTED,
                connection_details: Some(ConnectionDetails {
                    connection_state_ttl: Some(60000),
                    max_idle_interval: idle,
                    ..Default::default()
                }),
                ..Default::default()
            };

            let state = ConnState::from_connected(&msg, token.clone(), &timing);
            assert_eq!(state.max_idle_interval, None);
        }
    }

    #[test]
    fn idle_deadline_is_disabled_without_max_idle_interval() {
        assert_eq!(idle_deadline(None, Duration::from_secs(10)), None);
    }

    #[test]
    fn conn_state_uses_default_idle_interval_without_connection_details() {
        let timing = TimingConfig::default();
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: unix_now_ms() + 3_600_000,
            issued: 0,
            capability: None,
            client_id: None,
        };
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_details: None,
            ..Default::default()
        };

        let state = ConnState::from_connected(&msg, token, &timing);
        assert_eq!(
            state.max_idle_interval,
            Some(timing.default_max_idle_interval)
        );
    }

    #[test]
    fn conn_state_handles_huge_external_timing_values_without_panicking() {
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_details: Some(ConnectionDetails {
                connection_state_ttl: Some(i64::MAX),
                max_idle_interval: Some(i64::MAX),
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

        let state = ConnState::from_connected(&msg, token, &TimingConfig::default());
        let _ = idle_deadline(state.max_idle_interval, Duration::from_secs(10));
        let _ = checked_deadline_from(Instant::now(), state.connection_state_ttl);
        let _ = state.token_renewal_at;
    }

    #[test]
    fn expired_token_renewal_is_scheduled_immediately() {
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: 0,
            issued: 0,
            capability: None,
            client_id: None,
        };

        let renewal_at = ConnState::compute_renewal_at(&token, Duration::from_secs(300))
            .expect("expired tokens should still schedule renewal");
        assert!(renewal_at <= Instant::now());
    }

    #[test]
    fn token_inside_renewal_margin_is_scheduled_immediately() {
        let token = TokenDetails {
            token: "tok".to_string(),
            expires: unix_now_ms() + 60_000,
            issued: 0,
            capability: None,
            client_id: None,
        };

        let renewal_at = ConnState::compute_renewal_at(&token, Duration::from_secs(300))
            .expect("tokens inside the renewal margin should schedule renewal");
        assert!(renewal_at <= Instant::now());
    }

    #[test]
    fn conn_state_can_resume() {
        let mut state = ConnState {
            connection_id: Some("c1".to_string()),
            connection_key: Some("c1!key".to_string()),
            channel_serial: None,
            connection_state_ttl: Duration::from_secs(120),
            max_idle_interval: Some(Duration::from_secs(15)),
            disconnected_at: None,
            token: TokenDetails {
                token: "t".to_string(),
                expires: i64::MAX,
                issued: 0,
                capability: None,
                client_id: None,
            },
            token_renewal_at: checked_deadline_after(Duration::from_secs(3600)),
        };

        // No disconnected_at → cannot resume
        assert!(!state.can_resume());

        // Just disconnected → can resume
        state.disconnected_at = Some(Instant::now());
        assert!(state.can_resume());

        // Expired connection state TTL → cannot resume
        state.disconnected_at = Some(Instant::now() - Duration::from_secs(121));
        assert!(!state.can_resume());
        state.disconnected_at = Some(Instant::now());

        // No connection key → cannot resume
        state.connection_key = None;
        assert!(!state.can_resume());
    }

    #[test]
    fn realtime_state_machine_reattaches_attached_channel_on_new_transport() {
        let mut lifecycle = RealtimeStateMachine::connected();

        lifecycle.notify_disconnected();
        lifecycle.request_connecting();

        assert_eq!(lifecycle.connection, ConnectionLifecycleState::Connecting);
        assert_eq!(lifecycle.channel, ChannelLifecycleState::Attaching);

        lifecycle.notify_connected();

        assert_eq!(lifecycle.connection, ConnectionLifecycleState::Connected);
        assert_eq!(lifecycle.channel, ChannelLifecycleState::Attached);
    }

    #[test]
    fn realtime_state_machine_close_detaches_channel_and_becomes_terminal() {
        let mut lifecycle = RealtimeStateMachine::connected();

        lifecycle.request_closing();
        lifecycle.notify_closed();
        lifecycle.notify_disconnected();

        assert_eq!(lifecycle.connection, ConnectionLifecycleState::Closed);
        assert_eq!(lifecycle.channel, ChannelLifecycleState::Detached);
    }

    #[test]
    fn realtime_state_machine_failure_fails_channel_and_becomes_terminal() {
        let mut lifecycle = RealtimeStateMachine::connected();

        lifecycle.notify_failed();
        lifecycle.request_connecting();

        assert_eq!(lifecycle.connection, ConnectionLifecycleState::Failed);
        assert_eq!(lifecycle.channel, ChannelLifecycleState::Failed);
    }

    #[test]
    fn websocket_close_reason_redacts_access_token_from_reason() {
        let frame = CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "url=wss://example/?access_token=close-secret&format=msgpack".into(),
        };

        let reason = websocket_close_reason(Some(&frame));
        let log_reason = websocket_close_frame_reason(&frame);

        assert_eq!(
            reason,
            "websocket closed code=1000 reason=url=wss://example/?access_token=<redacted>&format=msgpack"
        );
        assert_eq!(
            log_reason,
            "url=wss://example/?access_token=<redacted>&format=msgpack"
        );
        assert!(!reason.contains("close-secret"));
        assert!(!log_reason.contains("close-secret"));
    }

    #[test]
    fn websocket_error_reason_redacts_access_token() {
        let err = tungstenite::Error::Url(tungstenite::error::UrlError::UnableToConnect(
            "wss://example/?access_token=error-secret&format=msgpack".to_string(),
        ));

        let reason = websocket_error_reason(&err);

        assert_eq!(
            reason,
            "websocket error: URL error: Unable to connect to wss://example/?access_token=<redacted>&format=msgpack"
        );
        assert!(!reason.contains("error-secret"));
    }

    #[test]
    fn protocol_disconnect_reason_redacts_access_token_from_message() {
        let reason = protocol_disconnect_reason(Some(ErrorInfo {
            code: 80003,
            status_code: Some(500),
            message: "failed url=wss://example/?access_token=protocol-secret&format=msgpack"
                .to_string(),
        }));

        assert_eq!(
            reason,
            "failed url=wss://example/?access_token=<redacted>&format=msgpack"
        );
        assert!(!reason.contains("protocol-secret"));
    }

    #[test]
    fn event_error_helpers_redact_access_token() {
        let protocol_message = protocol_error_message(
            "failed url=wss://example/?access_token=event-secret&format=msgpack".to_string(),
        );
        let detached_message = channel_detached_message(
            "failed url=wss://example/?access_token=detached-secret&format=msgpack",
        );

        assert_eq!(
            protocol_message,
            "failed url=wss://example/?access_token=<redacted>&format=msgpack"
        );
        assert_eq!(
            detached_message,
            "Channel detached: failed url=wss://example/?access_token=<redacted>&format=msgpack"
        );
        assert!(!protocol_message.contains("event-secret"));
        assert!(!detached_message.contains("detached-secret"));
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

    fn assert_websocket_endpoint(
        url: &str,
        scheme: &str,
        expected_host: url::Host<&str>,
        expected_port: Option<u16>,
    ) {
        let parsed = url::Url::parse(url).unwrap();
        assert_eq!(parsed.scheme(), scheme);
        assert_eq!(parsed.host(), Some(expected_host));
        assert_eq!(parsed.port(), expected_port);
    }

    #[test]
    fn build_ws_url_localhost_uses_ws() {
        let url = build_ws_url("127.0.0.1:9000", "tok", None).unwrap();
        assert_websocket_endpoint(
            &url,
            "ws",
            url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST),
            Some(9000),
        );

        let url = build_ws_url("localhost:9000", "tok", None).unwrap();
        assert_websocket_endpoint(&url, "ws", url::Host::Domain("localhost"), Some(9000));

        let url = build_ws_url("LOCALHOST:9000", "tok", None).unwrap();
        assert_websocket_endpoint(&url, "ws", url::Host::Domain("localhost"), Some(9000));

        let url = build_ws_url("[::1]:9000", "tok", None).unwrap();
        assert_websocket_endpoint(
            &url,
            "ws",
            url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST),
            Some(9000),
        );
    }

    #[test]
    fn build_ws_url_localhost_prefixes_use_wss() {
        let cases = [
            (
                "localhost.evil.com",
                url::Host::Domain("localhost.evil.com"),
            ),
            (
                "127.0.0.1.attacker.com",
                url::Host::Domain("127.0.0.1.attacker.com"),
            ),
            (
                "127.0.0.10",
                url::Host::Ipv4(std::net::Ipv4Addr::new(127, 0, 0, 10)),
            ),
        ];

        for (host, expected_host) in cases {
            let url = build_ws_url(host, "tok", None).unwrap();
            assert_websocket_endpoint(&url, "wss", expected_host, None);
        }
    }
}
