//! Ably wire protocol types, constants, and MessagePack encode/decode.

use std::collections::HashMap;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::Error;

// ---------------------------------------------------------------------------
// Protocol action constants
// ---------------------------------------------------------------------------

pub mod action {
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

pub mod error_code {
    pub const FAILED: i32 = 80000;
    pub const TIMEOUT: i32 = 80014;
    pub const CHANNEL_OPERATION_FAILED: i32 = 90000;
    pub const BAD_REQUEST: i32 = 40000;
}

pub mod flags {
    // Ably protocol flag constants (complete set for ATTACHED responses).
    // Only ATTACH_RESUME and MODE_SUBSCRIBE are used for sending; the
    // others are kept for decoding server responses.
    pub const HAS_PRESENCE: i32 = 1;
    pub const HAS_BACKLOG: i32 = 2;
    pub const HAS_CHANNEL_RESUMED: i32 = 4;
    pub const ATTACH_RESUME: i32 = 1 << 5; // 32
    pub const MODE_SUBSCRIBE: i32 = 262_144; // bit 18
}

// ---------------------------------------------------------------------------
// Wire protocol types (MessagePack)
// ---------------------------------------------------------------------------

// NOTE: We intentionally omit `skip_serializing_if = "Option::is_none"` on
// these structs. rmp_serde has a long-standing bug where skipped Option fields
// cause deserialization failures: https://github.com/3Hren/msgpack-rust/issues/86
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProtocolMessage {
    pub action: i32,
    pub id: Option<String>,
    pub channel: Option<String>,
    pub channel_serial: Option<String>,
    pub connection_id: Option<String>,
    pub connection_key: Option<String>,
    pub connection_details: Option<ConnectionDetails>,
    /// Deprecated in protocol v3+; retained for wire compatibility with older servers.
    pub connection_serial: Option<i64>,
    pub msg_serial: Option<i64>,
    pub flags: Option<i32>,
    pub error: Option<ErrorInfo>,
    pub auth: Option<AuthDetails>,
    pub messages: Option<Vec<AblyMessage>>,
    pub timestamp: Option<i64>,
    pub params: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionDetails {
    pub client_id: Option<String>,
    pub connection_key: Option<String>,
    pub connection_state_ttl: Option<i64>,
    pub max_idle_interval: Option<i64>,
    pub max_message_size: Option<i64>,
    pub max_frame_size: Option<i64>,
    pub server_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: i32,
    pub status_code: Option<i32>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AuthDetails {
    pub access_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AblyMessage {
    pub id: Option<String>,
    pub name: Option<String>,
    pub data: Option<serde_json::Value>,
    pub client_id: Option<String>,
    pub timestamp: Option<i64>,
    pub encoding: Option<String>,
}

// ---------------------------------------------------------------------------
// Encode / decode helpers
// ---------------------------------------------------------------------------

pub fn encode_msg(msg: &ProtocolMessage) -> Result<Vec<u8>, Error> {
    Ok(rmp_serde::to_vec_named(msg)?)
}

pub fn decode_msg(data: &[u8]) -> Result<ProtocolMessage, Error> {
    // Three-step decode: msgpack → rmpv::Value → serde_json::Value → ProtocolMessage.
    //
    // 1. rmpv::Value handles msgpack binary data (which serde_json::Value cannot).
    // 2. serde_json::Value deduplicates map keys (Ably may send "messages" twice,
    //    which rmp_serde's struct deserializer rejects).
    // This adds allocation overhead compared to direct struct deserialization.
    let mut cursor = std::io::Cursor::new(data);
    let value = rmpv::decode::read_value(&mut cursor).map_err(|e| Error::Protocol {
        code: error_code::BAD_REQUEST,
        message: format!("msgpack decode error: {e}"),
    })?;
    let json = rmpv_to_json(value);
    serde_json::from_value(json).map_err(|e| Error::Protocol {
        code: error_code::BAD_REQUEST,
        message: format!("message decode error: {e}"),
    })
}

/// Convert an rmpv::Value to serde_json::Value, encoding binary data as base64 strings.
fn rmpv_to_json(value: rmpv::Value) -> serde_json::Value {
    match value {
        rmpv::Value::Nil => serde_json::Value::Null,
        rmpv::Value::Boolean(b) => serde_json::Value::Bool(b),
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                serde_json::Value::Number(n.into())
            } else if let Some(n) = i.as_u64() {
                serde_json::Value::Number(n.into())
            } else {
                serde_json::Value::Null
            }
        }
        rmpv::Value::F32(f) => serde_json::Number::from_f64(f64::from(f))
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        rmpv::Value::F64(f) => serde_json::Number::from_f64(f)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        rmpv::Value::String(s) => {
            if s.is_str() {
                serde_json::Value::String(s.into_str().unwrap_or_default().to_string())
            } else {
                tracing::warn!("msgpack string contains invalid UTF-8, substituting empty string");
                serde_json::Value::String(String::new())
            }
        }
        rmpv::Value::Binary(bytes) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            serde_json::Value::String(encoded)
        }
        rmpv::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(rmpv_to_json).collect())
        }
        rmpv::Value::Map(map) => {
            let obj = map
                .into_iter()
                .map(|(k, v)| {
                    let key = match k {
                        rmpv::Value::String(s) => {
                            if s.is_str() {
                                s.into_str().unwrap_or_default().to_string()
                            } else {
                                tracing::warn!("msgpack map key contains invalid UTF-8, substituting empty string");
                                String::new()
                            }
                        }
                        other => format!("{other}"),
                    };
                    (key, rmpv_to_json(v))
                })
                .collect();
            serde_json::Value::Object(obj)
        }
        rmpv::Value::Ext(_, bytes) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            serde_json::Value::String(encoded)
        }
    }
}

// ---------------------------------------------------------------------------
// Helper to build an ATTACH message
// ---------------------------------------------------------------------------

pub fn build_attach_msg(
    channel: &str,
    params: Option<&HashMap<String, String>>,
    channel_serial: Option<&str>,
) -> ProtocolMessage {
    let (cs, f) = match channel_serial {
        Some(s) => (
            Some(s.to_string()),
            flags::MODE_SUBSCRIBE | flags::ATTACH_RESUME,
        ),
        None => (None, flags::MODE_SUBSCRIBE),
    };
    ProtocolMessage {
        action: action::ATTACH,
        channel: Some(channel.to_string()),
        channel_serial: cs,
        flags: Some(f),
        params: params.cloned(),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_attach() {
        let msg = ProtocolMessage {
            action: action::ATTACH,
            channel: Some("test-channel".to_string()),
            flags: Some(flags::MODE_SUBSCRIBE),
            ..Default::default()
        };
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
        assert_eq!(decoded.action, action::CONNECTED);
        assert_eq!(decoded.connection_id.as_deref(), Some("abc123"));
        assert_eq!(decoded.connection_key.as_deref(), Some("abc123!key"));
        assert_eq!(decoded.connection_serial, Some(-1));
        let details = decoded.connection_details.as_ref().unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
        assert_eq!(decoded.action, action::MESSAGE);
        assert_eq!(decoded.channel.as_deref(), Some("runner-group:test"));
        let messages = decoded.messages.as_ref().unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
        assert_eq!(decoded.action, action::ERROR);
        let err = decoded.error.as_ref().unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
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
        let data = encode_msg(&msg).unwrap();
        let decoded = decode_msg(&data).unwrap();
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

    #[test]
    fn build_attach_msg_basic() {
        let msg = build_attach_msg("my-channel", None, None);
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("my-channel"));
        assert_eq!(msg.flags, Some(flags::MODE_SUBSCRIBE));
        assert!(msg.channel_serial.is_none());
        assert!(msg.params.is_none());
    }

    #[test]
    fn build_attach_msg_with_rewind() {
        let mut params = HashMap::new();
        params.insert("rewind".to_string(), "2m".to_string());
        let msg = build_attach_msg("run:abc", Some(&params), None);
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

    #[test]
    fn build_attach_msg_with_channel_serial() {
        let msg = build_attach_msg("my-channel", None, Some("serial-abc"));
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-abc"));
        let f = msg.flags.unwrap();
        assert_ne!(f & flags::ATTACH_RESUME, 0);
        assert_ne!(f & flags::MODE_SUBSCRIBE, 0);
    }

    #[test]
    fn build_attach_msg_without_channel_serial_no_resume_flag() {
        let msg = build_attach_msg("my-channel", None, None);
        let f = msg.flags.unwrap();
        assert_eq!(f & flags::ATTACH_RESUME, 0);
        assert_ne!(f & flags::MODE_SUBSCRIBE, 0);
    }
}
