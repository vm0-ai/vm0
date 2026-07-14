use ably_subscriber::protocol::{action, decode_msg};
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite;

use super::{TEST_IO_TIMEOUT, WsStream};

pub(crate) async fn expect_websocket_close_frame(
    ws: &mut WsStream,
) -> Result<(), Box<dyn std::error::Error>> {
    let frame = tokio::time::timeout(TEST_IO_TIMEOUT, ws.next())
        .await
        .map_err(|_| std::io::Error::other("timed out waiting for websocket close frame"))?
        .ok_or_else(|| std::io::Error::other("websocket closed before close frame"))??;
    if !matches!(frame, tungstenite::Message::Close(_)) {
        return Err(std::io::Error::other(format!(
            "expected websocket close frame, got {frame:?}"
        ))
        .into());
    }
    Ok(())
}

pub(crate) async fn expect_websocket_close_frame_while_ignoring_attach(
    ws: &mut WsStream,
) -> Result<(), Box<dyn std::error::Error>> {
    tokio::time::timeout(TEST_IO_TIMEOUT, async {
        loop {
            let frame = ws
                .next()
                .await
                .ok_or_else(|| std::io::Error::other("websocket closed before close frame"))??;
            match frame {
                tungstenite::Message::Close(_) => return Ok(()),
                tungstenite::Message::Binary(data) => {
                    let msg = decode_msg(&data)?;
                    if msg.action != action::ATTACH {
                        return Err(std::io::Error::other(format!(
                            "expected ATTACH or close frame, got action {}",
                            msg.action
                        ))
                        .into());
                    }
                }
                other => {
                    return Err(std::io::Error::other(format!(
                        "expected ATTACH or close frame, got {other:?}"
                    ))
                    .into());
                }
            }
        }
    })
    .await
    .map_err(|_| std::io::Error::other("timed out waiting for websocket close frame"))?
}

pub(crate) async fn expect_websocket_closed(
    ws: &mut WsStream,
) -> Result<(), Box<dyn std::error::Error>> {
    let frame = tokio::time::timeout(TEST_IO_TIMEOUT, ws.next())
        .await
        .map_err(|_| std::io::Error::other("timed out waiting for websocket to close"))?;
    match frame {
        None | Some(Ok(tungstenite::Message::Close(_))) => Ok(()),
        Some(Err(error)) => Err(error.into()),
        Some(Ok(frame)) => {
            Err(std::io::Error::other(format!("expected websocket close, got {frame:?}")).into())
        }
    }
}
