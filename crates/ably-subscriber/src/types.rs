//! Public types for the ably-subscriber crate.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite;

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

/// Configuration for [`subscribe`](crate::subscribe).
pub struct SubscribeConfig {
    /// Callback that returns a fresh [`TokenRequest`] from your server.
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    /// Channel name to subscribe to (e.g. `"runner-group:my-group"`).
    pub channel: String,
    /// Optional channel parameters (e.g. `{"rewind": "2m"}`).
    pub channel_params: Option<HashMap<String, String>>,
    /// Ably realtime host. Defaults to `"realtime.ably.io"`.
    pub host: Option<String>,
    /// Ably REST host for token exchange. Defaults to `"rest.ably.io"` when
    /// `host` is the default, otherwise falls back to the realtime host value.
    pub rest_host: Option<String>,
}

/// Errors returned by this crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("WebSocket error: {0}")]
    WebSocket(Box<tungstenite::Error>),

    #[error("Token exchange HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("MessagePack encode error: {0}")]
    MsgpackEncode(#[from] rmp_serde::encode::Error),

    #[error("Ably protocol error: code={code}, {message}")]
    Protocol { code: i32, message: String },

    #[error("Token fetch failed: {0}")]
    TokenFetch(BoxError),

    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
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
}
