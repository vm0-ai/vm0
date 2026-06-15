use futures_util::StreamExt;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use crate::Error;
use crate::types::redact_access_token;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) type WsRead = futures_util::stream::SplitStream<WsStream>;
pub(crate) type WsWrite = futures_util::stream::SplitSink<WsStream, tungstenite::Message>;

pub(super) async fn connect_and_split(url: &str) -> Result<(WsWrite, WsRead), Error> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    Ok(ws.split())
}

pub(crate) struct WsTransport {
    pub(super) ws_read: WsRead,
    pub(super) ws_write: WsWrite,
}

impl WsTransport {
    pub(crate) fn new(ws_read: WsRead, ws_write: WsWrite) -> Self {
        Self { ws_read, ws_write }
    }
}

pub(super) fn websocket_close_reason(frame: Option<&CloseFrame>) -> String {
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

pub(super) fn websocket_close_frame_reason(frame: &CloseFrame) -> String {
    redact_access_token(frame.reason.as_ref())
}

pub(super) fn websocket_error_reason(error: &tungstenite::Error) -> String {
    format!(
        "websocket error: {}",
        redact_access_token(&error.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
