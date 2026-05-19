use base64::Engine as _;

use crate::protocol::ProtocolMessage;

pub(super) fn message_targets_channel(msg: &ProtocolMessage, channel: &str) -> bool {
    msg.channel.as_deref() == Some(channel)
}

pub(super) fn decode_data(data: serde_json::Value, encoding: Option<&str>) -> serde_json::Value {
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
                // In practice this branch is rarely hit: Ably's REST->Realtime
                // bridge consumes the encoding, so binary data arrives as
                // msgpack Binary (handled by rmpv_to_json -> base64 string).
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
