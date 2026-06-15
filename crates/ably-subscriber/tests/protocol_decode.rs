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

    Ok(())
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
