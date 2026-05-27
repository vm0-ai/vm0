//! Public types for the ably-subscriber crate.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite;

pub(crate) fn redact_access_token(input: &str) -> String {
    const PARAM: &str = "access_token=";

    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find(PARAM) {
        output.push_str(&rest[..start + PARAM.len()]);
        output.push_str("<redacted>");

        rest = &rest[start + PARAM.len()..];
        let end = rest
            .find(['&', ' ', '"', '\'', ')', ']', '}'])
            .unwrap_or(rest.len());
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

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
    /// Ably API key name used to sign this token request.
    pub key_name: String,
    /// Request timestamp, in milliseconds since the Unix epoch.
    pub timestamp: i64,
    /// Unique nonce used to prevent token request replay.
    pub nonce: String,
    /// Message Authentication Code for the canonical token request fields.
    pub mac: String,
    /// JSON-encoded Ably capability requested for the token.
    pub capability: String,
    /// Requested token lifetime duration, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    /// Client ID to associate with the requested token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// Ably TokenDetails — the actual token returned by Ably's REST API.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDetails {
    /// Ably token string used to authenticate realtime requests.
    pub token: String,
    /// Token expiry time, in milliseconds since the Unix epoch.
    #[serde(default)]
    pub expires: i64,
    /// Token issue time, in milliseconds since the Unix epoch.
    #[serde(default)]
    pub issued: i64,
    /// JSON-encoded Ably capability granted to the token.
    #[serde(default)]
    pub capability: Option<String>,
    /// Client ID associated with the token, when present.
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

/// Events emitted by a [`Subscription`](crate::Subscription).
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

/// Timing parameters that control reconnection, heartbeat, token renewal, and
/// backpressure behavior. Defaults are production-oriented; values that replace
/// previous hardcoded constants keep their prior values.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TimingConfig {
    // -- Connection ----------------------------------------------------------
    /// Timeout for WebSocket connect, HTTP requests, and token operations.
    pub connect_timeout: Duration,
    /// Timeout for best-effort protocol/WebSocket close during shutdown.
    pub close_timeout: Duration,
    /// Timeout wrapping each individual reconnect attempt.
    pub reconnect_timeout: Duration,
    /// Fallback `max_idle_interval` when the server omits connection details.
    /// If connection details are present but `maxIdleInterval` is zero or
    /// absent, no idle timeout is enforced, matching Ably realtime semantics.
    pub default_max_idle_interval: Duration,
    /// Default `connection_state_ttl` when the server doesn't specify one.
    pub default_connection_state_ttl: Duration,

    // -- Heartbeat -----------------------------------------------------------
    /// Extra margin added to `max_idle_interval` for heartbeat timeout.
    pub heartbeat_margin: Duration,

    // -- Reconnection retry --------------------------------------------------
    /// Retry timeout while in the Ably `disconnected` state.
    ///
    /// Matches ably-js `disconnectedRetryTimeout`.
    pub disconnected_retry_timeout: Duration,
    /// Retry timeout while in the Ably `suspended` state.
    ///
    /// Matches ably-js `suspendedRetryTimeout`.
    pub suspended_retry_timeout: Duration,
    /// Retry timeout while a channel is `suspended` after an attach failure.
    ///
    /// Matches ably-js `channelRetryTimeout`.
    pub channel_retry_timeout: Duration,
    /// Timeout for an in-flight realtime channel ATTACH operation.
    /// Initial subscribe connect+attach is bounded by
    /// [`connect_timeout`](Self::connect_timeout); this timeout applies after
    /// the subscription is established.
    ///
    /// Matches ably-js `realtimeRequestTimeout`.
    pub realtime_request_timeout: Duration,
    /// Legacy base interval for the first retry attempt.
    ///
    /// Kept for API compatibility; the Ably-aligned state machine uses
    /// [`disconnected_retry_timeout`](Self::disconnected_retry_timeout) and
    /// [`suspended_retry_timeout`](Self::suspended_retry_timeout).
    pub initial_retry_interval: Duration,
    /// Legacy cap on exponential backoff between retries.
    ///
    /// Kept for API compatibility.
    pub max_retry_interval: Duration,
    /// Minimum spacing between reconnect attempts after transport-level
    /// disconnects. This mirrors ably-js' guard against tight reconnect loops
    /// when a server or proxy repeatedly closes otherwise healthy sockets.
    pub min_reconnect_interval: Duration,
    /// Legacy maximum number of consecutive reconnection attempts before giving up.
    ///
    /// Kept for API compatibility. Ably-js retries disconnected/suspended
    /// connections indefinitely, so this field is not used by the current state
    /// machine.
    pub max_retry_attempts: u32,

    // -- Channel re-attach ---------------------------------------------------
    /// Legacy re-attach window used by the previous reconnect-on-repeat-detach
    /// behavior. Kept for API compatibility.
    pub reattach_window: Duration,

    // -- Token renewal -------------------------------------------------------
    /// How early before token expiry to start proactive renewal.
    pub token_renewal_margin: Duration,
    /// Delay before retrying a failed token renewal.
    pub token_renewal_retry_delay: Duration,
    /// Number of consecutive token renewal failures before emitting a fatal error.
    pub max_token_renewal_failures: u32,

    // -- Backpressure --------------------------------------------------------
    /// Bounded capacity of the internal event channel (mpsc). Values below 1
    /// are treated as 1 because Tokio channels do not support zero capacity.
    pub event_channel_capacity: usize,
}

impl Default for TimingConfig {
    fn default() -> Self {
        Self {
            // Connection
            connect_timeout: Duration::from_secs(30),
            close_timeout: Duration::from_secs(5),
            reconnect_timeout: Duration::from_secs(60),
            default_max_idle_interval: Duration::from_secs(15),
            default_connection_state_ttl: Duration::from_secs(120),
            // Heartbeat
            heartbeat_margin: Duration::from_secs(10),
            // Reconnection retry
            disconnected_retry_timeout: Duration::from_secs(15),
            suspended_retry_timeout: Duration::from_secs(30),
            channel_retry_timeout: Duration::from_secs(15),
            realtime_request_timeout: Duration::from_secs(10),
            initial_retry_interval: Duration::from_secs(1),
            max_retry_interval: Duration::from_secs(15),
            min_reconnect_interval: Duration::from_secs(1),
            max_retry_attempts: 40,
            // Channel re-attach
            reattach_window: Duration::from_secs(15),
            // Token renewal
            token_renewal_margin: Duration::from_secs(300),
            token_renewal_retry_delay: Duration::from_secs(30),
            max_token_renewal_failures: 3,
            // Backpressure
            event_channel_capacity: 64,
        }
    }
}

/// Configuration for [`subscribe`](crate::subscribe).
#[non_exhaustive]
pub struct SubscribeConfig {
    /// Callback that returns a fresh [`TokenRequest`] from your server.
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    /// Channel name to subscribe to (e.g. `"runner-group:my-group"`).
    pub channel: String,
    /// Optional channel parameters (e.g. `{"rewind": "2m"}`).
    pub channel_params: Option<HashMap<String, String>>,
    /// Ably realtime host/authority, without a URL scheme, path, query, or
    /// fragment. Defaults to `"realtime.ably.io"`.
    pub host: Option<String>,
    /// Ably REST host for token exchange. Defaults to `"rest.ably.io"` when
    /// `host` is the default, otherwise falls back to the realtime host value.
    /// Like [`host`](Self::host), this must be a host/authority rather than a
    /// base URL.
    pub rest_host: Option<String>,
    /// Override timing parameters. `None` uses [`TimingConfig::default()`].
    pub timing: Option<TimingConfig>,
}

impl SubscribeConfig {
    /// Create a new configuration with the required fields.
    ///
    /// Optional fields (`channel_params`, `host`, `rest_host`, `timing`) default
    /// to `None` and can be set directly after construction.
    pub fn new(
        get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
        channel: impl Into<String>,
    ) -> Self {
        Self {
            get_token,
            channel: channel.into(),
            channel_params: None,
            host: None,
            rest_host: None,
            timing: None,
        }
    }
}

/// Errors returned by this crate.
#[derive(thiserror::Error)]
pub enum Error {
    /// WebSocket transport failure while connecting, reading, writing, or
    /// closing the Ably realtime connection.
    ///
    /// `Display` and `Debug` redact `access_token` query parameter values from
    /// formatted WebSocket error messages.
    #[error("WebSocket error: {}", redact_access_token(&.0.to_string()))]
    WebSocket(Box<tungstenite::Error>),

    /// HTTP client setup or request failure while exchanging a [`TokenRequest`]
    /// for Ably token details.
    ///
    /// This covers the `reqwest` client used for Ably REST token exchange and
    /// the exchange request/response itself. It is distinct from
    /// [`Error::TokenFetch`], which represents the user-provided token request
    /// callback.
    #[error("Token exchange HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// Failure while encoding an outbound Ably protocol message as MessagePack.
    #[error("MessagePack encode error: {0}")]
    MsgpackEncode(#[from] rmp_serde::encode::Error),

    /// Ably protocol-level failure or a local failure mapped into Ably-style
    /// protocol error fields.
    ///
    /// The `code` and `message` may come from an Ably protocol message, such as
    /// `ERROR`, `DISCONNECTED`, `DETACHED`, or `CLOSED`, or they may be
    /// generated locally by this crate for conditions such as decode failures,
    /// timeouts, or a connection closing before the expected protocol message
    /// arrives. Callers should not assume this variant always means the Ably
    /// service returned the error.
    ///
    /// `Display` and `Debug` redact `access_token` query parameter values from
    /// the formatted message.
    #[error("Ably protocol error: code={code}, {}", redact_access_token(message))]
    Protocol {
        /// Ably-style error code, either received from Ably or generated by
        /// this crate for a locally detected protocol failure.
        code: i32,
        /// Human-readable protocol error detail, either received from Ably or
        /// generated locally by this crate.
        message: String,
    },

    /// Failure returned by the user-provided token request callback.
    ///
    /// This is distinct from [`Error::Http`], which represents the subsequent
    /// Ably REST token exchange. `Display` and `Debug` redact `access_token`
    /// query parameter values from the formatted callback error.
    #[error("Token fetch failed: {}", redact_access_token(&.0.to_string()))]
    TokenFetch(BoxError),

    /// Invalid endpoint URL or URL component built from the subscription
    /// configuration or token request.
    ///
    /// This also covers local validation failures for endpoint host and
    /// [`TokenRequest`] key-name values that would otherwise be silently
    /// normalized by URL parsing. The message deliberately omits the raw input
    /// because callers may accidentally include credentials in host-like values
    /// or authentication material in token request fields.
    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
}

impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Error")
            .field(&redact_access_token(&self.to_string()))
            .finish()
    }
}

impl From<tungstenite::Error> for Error {
    fn from(e: tungstenite::Error) -> Self {
        Error::WebSocket(Box::new(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let json = serde_json::to_string(&tr).unwrap();
        assert!(json.contains("keyName"));
        assert!(json.contains("xVLyHw.mDYnFA"));
        assert!(!json.contains("clientId")); // None → skipped

        let parsed: TokenRequest = serde_json::from_str(&json).unwrap();
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
        let td: TokenDetails = serde_json::from_str(json).unwrap();
        assert_eq!(td.token, "xVLyHw.some-token-string");
        assert_eq!(td.expires, 1700003600000);
        assert_eq!(td.issued, 1700000000000);
    }

    #[test]
    fn timing_config_close_timeout_is_shorter_than_connect_timeout() {
        let timing = TimingConfig::default();

        assert_eq!(timing.close_timeout, Duration::from_secs(5));
        assert!(
            timing.close_timeout < timing.connect_timeout,
            "best-effort close should not wait as long as connect"
        );
    }

    #[test]
    fn websocket_error_display_redacts_access_token_query_param() {
        let err = Error::from(tungstenite::Error::Url(
            tungstenite::error::UrlError::UnableToConnect(
                "wss://realtime.ably.io/?access_token=secret-token&format=msgpack \
                 retry_url=wss://realtime.ably.io/?format=msgpack&access_token=second-secret"
                    .to_string(),
            ),
        ));

        let message = err.to_string();
        assert_eq!(
            message,
            "WebSocket error: URL error: Unable to connect to \
             wss://realtime.ably.io/?access_token=<redacted>&format=msgpack \
             retry_url=wss://realtime.ably.io/?format=msgpack&access_token=<redacted>"
        );
        assert!(!message.contains("secret-token"));
        assert!(!message.contains("second-secret"));

        let debug_message = format!("{err:?}");
        assert!(debug_message.contains("access_token=<redacted>"));
        assert!(!debug_message.contains("secret-token"));
        assert!(!debug_message.contains("second-secret"));
    }

    #[test]
    fn protocol_error_display_redacts_access_token_query_param() {
        let err = Error::Protocol {
            code: 80003,
            message: "failed wss://realtime.ably.io/?access_token=secret-token&format=msgpack"
                .to_string(),
        };

        let message = err.to_string();
        assert_eq!(
            message,
            "Ably protocol error: code=80003, failed \
             wss://realtime.ably.io/?access_token=<redacted>&format=msgpack"
        );
        assert!(!message.contains("secret-token"));
    }

    #[test]
    fn token_fetch_error_display_redacts_access_token_query_param() {
        let err = Error::TokenFetch(Box::new(std::io::Error::other(
            "failed wss://realtime.ably.io/?access_token=secret-token&format=msgpack",
        )));

        let message = err.to_string();
        assert_eq!(
            message,
            "Token fetch failed: failed \
             wss://realtime.ably.io/?access_token=<redacted>&format=msgpack"
        );
        assert!(!message.contains("secret-token"));
    }

    #[test]
    fn access_token_redaction_handles_common_message_delimiters() {
        let message = concat!(
            "url=\"wss://example/?access_token=quoted-secret\" ",
            "url='wss://example/?access_token=single-quoted' ",
            "url=(wss://example/?access_token=paren-secret) ",
            "url=[wss://example/?access_token=bracket-secret] ",
            "json={\"url\":\"wss://example/?access_token=json-secret\"}",
        );

        let redacted = redact_access_token(message);

        assert_eq!(
            redacted,
            concat!(
                "url=\"wss://example/?access_token=<redacted>\" ",
                "url='wss://example/?access_token=<redacted>' ",
                "url=(wss://example/?access_token=<redacted>) ",
                "url=[wss://example/?access_token=<redacted>] ",
                "json={\"url\":\"wss://example/?access_token=<redacted>\"}",
            )
        );
        for secret in [
            "quoted-secret",
            "single-quoted",
            "paren-secret",
            "bracket-secret",
            "json-secret",
        ] {
            assert!(!redacted.contains(secret));
        }
    }
}
