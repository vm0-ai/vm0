use std::error::Error;
use std::io;

use ably_subscriber::protocol::{AblyMessage, ProtocolMessage, action, decode_msg};

type TestResult<T = ()> = Result<T, Box<dyn Error>>;

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
        .ok_or_else(|| io::Error::other("messages are present"))?;
    let [message] = messages else {
        return Err(
            io::Error::other(format!("expected one message, got {}", messages.len())).into(),
        );
    };
    Ok(message)
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
