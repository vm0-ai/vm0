use std::error::Error as StdError;
use std::io;

use ably_subscriber::{
    Error as AblyError,
    protocol::{AblyMessage, ProtocolMessage, action, decode_msg, error_code},
};

type TestResult<T = ()> = Result<T, Box<dyn StdError>>;

fn str_value(value: &str) -> rmpv::Value {
    rmpv::Value::from(value)
}

fn field(name: &str, value: rmpv::Value) -> (rmpv::Value, rmpv::Value) {
    (str_value(name), value)
}

fn encode_value(value: rmpv::Value) -> TestResult<Vec<u8>> {
    let mut data = Vec::new();
    rmpv::encode::write_value(&mut data, &value)?;
    Ok(data)
}

fn expect_bad_request(data: &[u8]) -> TestResult {
    match decode_msg(data) {
        Err(AblyError::Protocol { code, .. }) => {
            assert_eq!(code, error_code::BAD_REQUEST);
            Ok(())
        }
        Err(err) => {
            Err(io::Error::other(format!("expected BAD_REQUEST protocol error, got {err}")).into())
        }
        Ok(_) => Err(io::Error::other("expected BAD_REQUEST protocol error").into()),
    }
}

fn message_named(name: &str) -> rmpv::Value {
    rmpv::Value::Map(vec![
        field("name", str_value(name)),
        field(
            "data",
            rmpv::Value::Map(vec![field("runId", str_value(name))]),
        ),
    ])
}

fn single_message(decoded: &ProtocolMessage) -> TestResult<&AblyMessage> {
    let messages = decoded
        .messages
        .as_deref()
        .ok_or_else(|| io::Error::other("messages are missing"))?;
    let [message] = messages else {
        return Err(
            io::Error::other(format!("expected one message, got {}", messages.len())).into(),
        );
    };
    Ok(message)
}

#[test]
fn decode_msg_rejects_empty_payload() -> TestResult {
    expect_bad_request(&[])
}

#[test]
fn decode_msg_rejects_truncated_msgpack_payloads() -> TestResult {
    expect_bad_request(&[0x81])?;
    expect_bad_request(&[0x91])
}

#[test]
fn decode_msg_rejects_non_map_roots() -> TestResult {
    let payloads = vec![
        rmpv::Value::Nil,
        rmpv::Value::from(1),
        str_value("not-map"),
        rmpv::Value::Array(Vec::new()),
    ];

    for payload in payloads {
        let encoded = encode_value(payload)?;
        expect_bad_request(&encoded)?;
    }

    Ok(())
}

#[test]
fn decode_msg_rejects_missing_action() -> TestResult {
    let payload = rmpv::Value::Map(vec![field("messages", rmpv::Value::Array(Vec::new()))]);
    let encoded = encode_value(payload)?;

    expect_bad_request(&encoded)?;

    Ok(())
}

#[test]
fn decode_msg_rejects_field_type_mismatches() -> TestResult {
    let action_as_string = rmpv::Value::Map(vec![field("action", str_value("15"))]);
    let encoded = encode_value(action_as_string)?;
    expect_bad_request(&encoded)?;

    let messages_as_string = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("messages", str_value("not-array")),
    ]);
    let encoded = encode_value(messages_as_string)?;
    expect_bad_request(&encoded)?;

    let message_item_as_string = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("messages", rmpv::Value::Array(vec![str_value("not-map")])),
    ]);
    let encoded = encode_value(message_item_as_string)?;
    expect_bad_request(&encoded)?;

    Ok(())
}

#[test]
fn decode_msg_rejects_nil_required_fields() -> TestResult {
    let action_as_nil = rmpv::Value::Map(vec![field("action", rmpv::Value::Nil)]);
    let encoded = encode_value(action_as_nil)?;
    expect_bad_request(&encoded)?;

    let error_code_as_nil = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::ERROR)),
        field(
            "error",
            rmpv::Value::Map(vec![field("code", rmpv::Value::Nil)]),
        ),
    ]);
    let encoded = encode_value(error_code_as_nil)?;
    expect_bad_request(&encoded)?;

    let auth_token_as_nil = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::AUTH)),
        field(
            "auth",
            rmpv::Value::Map(vec![field("accessToken", rmpv::Value::Nil)]),
        ),
    ]);
    let encoded = encode_value(auth_token_as_nil)?;
    expect_bad_request(&encoded)?;

    Ok(())
}

#[test]
fn decode_msg_rejects_integer_fields_outside_target_range() -> TestResult {
    let action_outside_i32 = rmpv::Value::Map(vec![field("action", rmpv::Value::from(i64::MAX))]);
    let encoded = encode_value(action_outside_i32)?;
    expect_bad_request(&encoded)?;

    let timestamp_outside_i64 = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("timestamp", rmpv::Value::from(u64::MAX)),
    ]);
    let encoded = encode_value(timestamp_outside_i64)?;
    expect_bad_request(&encoded)?;

    Ok(())
}

#[test]
fn decode_msg_rejects_nested_field_type_mismatches() -> TestResult {
    let message_name_as_array = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![field(
                "name",
                rmpv::Value::Array(Vec::new()),
            )])]),
        ),
    ]);
    let encoded = encode_value(message_name_as_array)?;
    expect_bad_request(&encoded)?;

    Ok(())
}

#[test]
fn decode_msg_type_errors_do_not_include_field_values() -> TestResult {
    let secret = "secret-access-token";
    let auth_as_string = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::AUTH)),
        field("auth", str_value(secret)),
    ]);
    let encoded = encode_value(auth_as_string)?;

    match decode_msg(&encoded) {
        Err(AblyError::Protocol { message, .. }) => {
            assert!(message.contains("field auth expected map, got string"));
            assert!(!message.contains(secret));
            Ok(())
        }
        Err(err) => {
            Err(io::Error::other(format!("expected BAD_REQUEST protocol error, got {err}")).into())
        }
        Ok(_) => Err(io::Error::other("expected BAD_REQUEST protocol error").into()),
    }
}

#[test]
fn decode_msg_rejects_trailing_bytes() -> TestResult {
    let payload = rmpv::Value::Map(vec![field("action", rmpv::Value::from(action::HEARTBEAT))]);
    let mut encoded = encode_value(payload)?;
    encoded.push(0xc0);

    expect_bad_request(&encoded)?;

    Ok(())
}

#[test]
fn decode_msg_accepts_unknown_numeric_action() -> TestResult {
    let payload = rmpv::Value::Map(vec![field("action", rmpv::Value::from(123_456))]);
    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert_eq!(decoded.action, 123_456);

    Ok(())
}

#[test]
fn decode_msg_preserves_nil_optional_fields_and_empty_nested_defaults() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::CONNECTED)),
        field("channel", rmpv::Value::Nil),
        field("messages", rmpv::Value::Nil),
        field("params", rmpv::Value::Nil),
        field("connectionDetails", rmpv::Value::Map(Vec::new())),
        field("error", rmpv::Value::Map(Vec::new())),
        field("auth", rmpv::Value::Map(Vec::new())),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert!(decoded.channel.is_none());
    assert!(decoded.messages.is_none());
    assert!(decoded.params.is_none());
    let connection_details = decoded
        .connection_details
        .as_ref()
        .ok_or_else(|| io::Error::other("connection details are missing"))?;
    assert!(connection_details.connection_key.is_none());
    let error = decoded
        .error
        .as_ref()
        .ok_or_else(|| io::Error::other("error info is missing"))?;
    assert_eq!(error.code, 0);
    assert_eq!(error.message, "");
    let auth = decoded
        .auth
        .as_ref()
        .ok_or_else(|| io::Error::other("auth details are missing"))?;
    assert_eq!(auth.access_token, "");

    Ok(())
}

#[test]
fn decode_msg_treats_non_finite_optional_fields_as_null() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("channel", rmpv::Value::F64(f64::NAN)),
        field("timestamp", rmpv::Value::F64(f64::INFINITY)),
        field("params", rmpv::Value::F32(f32::NEG_INFINITY)),
        field("connectionDetails", rmpv::Value::F64(f64::NAN)),
        field("auth", rmpv::Value::F32(f32::INFINITY)),
        field("error", rmpv::Value::F64(f64::NEG_INFINITY)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![
                field("name", str_value("job")),
                field("data", rmpv::Value::F64(f64::NAN)),
                field("timestamp", rmpv::Value::F64(f64::INFINITY)),
                field("encoding", rmpv::Value::F32(f32::NAN)),
            ])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert!(decoded.channel.is_none());
    assert!(decoded.timestamp.is_none());
    assert!(decoded.params.is_none());
    assert!(decoded.connection_details.is_none());
    assert!(decoded.auth.is_none());
    assert!(decoded.error.is_none());
    let message = single_message(&decoded)?;
    assert_eq!(message.name.as_deref(), Some("job"));
    assert!(message.data.is_none());
    assert!(message.timestamp.is_none());
    assert!(message.encoding.is_none());

    Ok(())
}

#[test]
fn decode_msg_treats_non_finite_messages_field_as_null() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("messages", rmpv::Value::F64(f64::NAN)),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert!(decoded.messages.is_none());
    Ok(())
}

#[test]
fn decode_msg_accepts_duplicate_scalar_keys_from_msgpack() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::ATTACHED)),
        field("channel", str_value("first")),
        field("channel", str_value("second")),
        field("flags", rmpv::Value::from(1)),
        field("flags", rmpv::Value::from(2)),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert_eq!(decoded.action, action::ATTACHED);
    assert_eq!(decoded.channel.as_deref(), Some("second"));
    assert_eq!(decoded.flags, Some(2));
    Ok(())
}

#[test]
fn decode_msg_accepts_duplicate_field_when_later_value_is_valid() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", str_value("not-a-number")),
        field("action", rmpv::Value::from(action::ATTACHED)),
        field("channel", rmpv::Value::Array(Vec::new())),
        field("channel", str_value("channel")),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert_eq!(decoded.action, action::ATTACHED);
    assert_eq!(decoded.channel.as_deref(), Some("channel"));
    Ok(())
}

#[test]
fn decode_msg_accepts_duplicate_params_field_when_later_value_is_valid() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::ATTACH)),
        field(
            "params",
            rmpv::Value::Map(vec![
                field("rewind", rmpv::Value::Array(Vec::new())),
                field("rewind", str_value("2m")),
            ]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert_eq!(
        decoded
            .params
            .as_ref()
            .and_then(|params| params.get("rewind"))
            .map(String::as_str),
        Some("2m")
    );
    Ok(())
}

#[test]
fn decode_msg_accepts_duplicate_messages_key_from_msgpack() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("messages", rmpv::Value::Array(vec![message_named("first")])),
        field(
            "messages",
            rmpv::Value::Array(vec![message_named("second")]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert_eq!(decoded.action, action::MESSAGE);
    let message = single_message(&decoded)?;
    assert_eq!(message.name.as_deref(), Some("second"));
    assert_eq!(
        message
            .data
            .as_ref()
            .and_then(|data| data.get("runId"))
            .and_then(|run_id| run_id.as_str()),
        Some("second")
    );
    Ok(())
}

#[test]
fn decode_msg_accepts_duplicate_message_fields_from_msgpack() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![
                field("name", str_value("first")),
                field("name", str_value("second")),
                field("timestamp", rmpv::Value::from(1)),
                field("timestamp", rmpv::Value::from(2)),
            ])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    let message = single_message(&decoded)?;
    assert_eq!(message.name.as_deref(), Some("second"));
    assert_eq!(message.timestamp, Some(2));
    Ok(())
}

#[test]
fn decode_msg_accepts_duplicate_nested_field_when_later_value_is_valid() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![
                field("name", rmpv::Value::Array(Vec::new())),
                field("name", str_value("job")),
                field("timestamp", str_value("not-a-number")),
                field("timestamp", rmpv::Value::from(2)),
            ])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    let message = single_message(&decoded)?;
    assert_eq!(message.name.as_deref(), Some("job"));
    assert_eq!(message.timestamp, Some(2));
    Ok(())
}

#[test]
fn decode_msg_ignores_unknown_fields() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field("unknownTopLevel", str_value("ignored")),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![
                field("name", str_value("job")),
                field("unknownMessageField", rmpv::Value::Boolean(true)),
            ])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    assert_eq!(decoded.action, action::MESSAGE);
    let message = single_message(&decoded)?;
    assert_eq!(message.name.as_deref(), Some("job"));
    Ok(())
}

#[test]
fn decode_msg_preserves_nested_data_maps_and_arrays() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![field(
                "data",
                rmpv::Value::Map(vec![
                    field(
                        "items",
                        rmpv::Value::Array(vec![
                            rmpv::Value::from(1),
                            rmpv::Value::Boolean(true),
                            str_value("three"),
                        ]),
                    ),
                    field(
                        "nested",
                        rmpv::Value::Map(vec![field("ok", str_value("yes"))]),
                    ),
                ]),
            )])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    let message = single_message(&decoded)?;
    assert_eq!(
        message.data.as_ref(),
        Some(&serde_json::json!({
            "items": [1, true, "three"],
            "nested": {"ok": "yes"}
        }))
    );
    Ok(())
}

#[test]
fn decode_msg_converts_msgpack_binary_data_to_base64_string() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![
                field("name", str_value("job")),
                field("data", rmpv::Value::Binary(vec![0x00, 0x01, 0xfe, 0xff])),
            ])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    let message = single_message(&decoded)?;
    assert_eq!(message.name.as_deref(), Some("job"));
    assert_eq!(
        message.data.as_ref().and_then(|data| data.as_str()),
        Some("AAH+/w==")
    );
    Ok(())
}

#[test]
fn decode_msg_converts_msgpack_ext_data_to_base64_string() -> TestResult {
    let payload = rmpv::Value::Map(vec![
        field("action", rmpv::Value::from(action::MESSAGE)),
        field(
            "messages",
            rmpv::Value::Array(vec![rmpv::Value::Map(vec![field(
                "data",
                rmpv::Value::Ext(1, vec![0xde, 0xad]),
            )])]),
        ),
    ]);

    let encoded = encode_value(payload)?;
    let decoded = decode_msg(&encoded)?;

    let message = single_message(&decoded)?;
    assert_eq!(
        message.data.as_ref().and_then(|data| data.as_str()),
        Some("3q0=")
    );
    Ok(())
}

#[test]
fn decode_msg_replaces_invalid_utf8_string_with_empty_string() -> TestResult {
    let data = [
        0x82,
        b'\xa6',
        b'a',
        b'c',
        b't',
        b'i',
        b'o',
        b'n',
        action::MESSAGE as u8,
        b'\xa7',
        b'c',
        b'h',
        b'a',
        b'n',
        b'n',
        b'e',
        b'l',
        b'\xa1',
        b'\xff',
    ];

    let decoded = decode_msg(&data)?;

    assert_eq!(decoded.action, action::MESSAGE);
    assert_eq!(decoded.channel.as_deref(), Some(""));
    Ok(())
}
