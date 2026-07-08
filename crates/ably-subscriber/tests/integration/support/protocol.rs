use ably_subscriber::protocol::{
    AblyMessage, ProtocolMessage, action, decode_msg, encode_msg, flags,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite;

use super::{TEST_IO_TIMEOUT, WsStream};

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(crate) fn assert_attach_resume(msg: &ProtocolMessage, expected: bool) {
    let has_resume = msg.flags.unwrap_or(0) & flags::ATTACH_RESUME != 0;
    assert_eq!(has_resume, expected, "unexpected ATTACH_RESUME flag");
}

pub(crate) async fn read_protocol_msg(
    ws: &mut WsStream,
) -> Result<ProtocolMessage, Box<dyn std::error::Error>> {
    loop {
        let frame = ws.next().await.ok_or("WebSocket closed unexpectedly")??;
        if let tungstenite::Message::Binary(data) = frame {
            return Ok(decode_msg(&data)?);
        }
    }
}

pub(crate) async fn expect_protocol_msg(
    ws: &mut WsStream,
    context: &str,
) -> Result<ProtocolMessage, Box<dyn std::error::Error>> {
    tokio::time::timeout(TEST_IO_TIMEOUT, read_protocol_msg(ws))
        .await
        .map_err(|_| std::io::Error::other(format!("timed out waiting for {context}")))?
}

pub(crate) async fn send_message(
    ws: &mut WsStream,
    channel: &str,
    name: &str,
    data: serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    send_message_with_channel_serial(ws, channel, name, data, Some("serial-1")).await
}

pub(crate) async fn send_message_with_channel_serial(
    ws: &mut WsStream,
    channel: &str,
    name: &str,
    data: serde_json::Value,
    channel_serial: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let msg = ProtocolMessage {
        action: action::MESSAGE,
        channel: Some(channel.into()),
        channel_serial: channel_serial.map(str::to_string),
        messages: Some(vec![AblyMessage {
            id: Some("msg-1".into()),
            name: Some(name.into()),
            data: Some(data),
            timestamp: Some(now_ms()),
            ..Default::default()
        }]),
        ..Default::default()
    };
    ws.send(tungstenite::Message::Binary(encode_msg(&msg)?.into()))
        .await?;
    Ok(())
}
