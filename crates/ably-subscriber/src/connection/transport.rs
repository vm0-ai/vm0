use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, Stream, StreamExt};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_util::task::TaskTracker;

use super::state::idle_deadline;
use crate::Error;
use crate::protocol::error_code;
use crate::types::redact_auth_query_params;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

type WsSplitRead = futures_util::stream::SplitStream<WsStream>;
pub(crate) type WsWrite = futures_util::stream::SplitSink<WsStream, tungstenite::Message>;

pub(crate) struct WsRead {
    inner: WsSplitRead,
    last_inbound_activity_at: Instant,
}

impl WsRead {
    fn new(inner: WsSplitRead) -> Self {
        Self {
            inner,
            last_inbound_activity_at: Instant::now(),
        }
    }

    pub(super) fn idle_deadline(
        &self,
        max_idle_interval: Option<Duration>,
        heartbeat_margin: Duration,
    ) -> Option<(Instant, Duration)> {
        idle_deadline(
            self.last_inbound_activity_at,
            max_idle_interval,
            heartbeat_margin,
        )
    }
}

impl Stream for WsRead {
    type Item = Result<tungstenite::Message, tungstenite::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let result = Pin::new(&mut self.inner).poll_next(cx);
        if matches!(&result, Poll::Ready(Some(Ok(_)))) {
            self.last_inbound_activity_at = Instant::now();
        }
        result
    }
}

pub(crate) struct WsTransport {
    pub(super) ws_read: WsRead,
    pub(super) ws_write: WsWrite,
}

impl WsTransport {
    fn new(ws_read: WsRead, ws_write: WsWrite) -> Self {
        Self { ws_read, ws_write }
    }

    async fn close(self, close_timeout: Duration) -> Result<(), Error> {
        let Self {
            ws_read,
            mut ws_write,
        } = self;
        drop(ws_read);
        tokio::time::timeout(close_timeout, ws_write.close())
            .await
            .map_err(|_| Error::Protocol {
                code: error_code::TIMEOUT,
                message: "WebSocket transport close timed out".to_string(),
            })??;
        Ok(())
    }

    pub(super) fn close_in_background(
        self,
        close_timeout: Duration,
        close_tracker: &TransportCloseTracker,
    ) {
        let error_observer = close_tracker.clone();
        let close_task = close_tracker.tasks.spawn(async move {
            if let Err(error) = self.close(close_timeout).await {
                tracing::warn!(
                    error = %error,
                    timeout_ms = close_timeout.as_millis(),
                    "Failed to close websocket transport"
                );
                error_observer.record(error).await;
            }
        });
        drop(close_task);
    }
}

/// Tracks transport-only close tasks owned by one subscription.
#[derive(Clone, Default)]
pub(crate) struct TransportCloseTracker {
    tasks: TaskTracker,
    observe_errors: Arc<AtomicBool>,
    first_error: Arc<Mutex<Option<Error>>>,
}

impl TransportCloseTracker {
    pub(crate) fn observe_errors(&self) {
        self.observe_errors.store(true, Ordering::Release);
    }

    async fn record(&self, error: Error) {
        if !self.observe_errors.load(Ordering::Acquire) {
            return;
        }
        let mut first_error = self.first_error.lock().await;
        if first_error.is_none() {
            *first_error = Some(error);
        }
    }

    pub(crate) async fn finish(&self) -> Result<(), Error> {
        self.tasks.close();
        self.tasks.wait().await;
        match self.first_error.lock().await.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// Owns a connected transport until setup commits it as active.
///
/// Dropping a setup future drops this guard and schedules bounded transport
/// cleanup, so cancellation cannot silently abandon an established WebSocket.
pub(super) struct PendingWsTransport {
    transport: Option<WsTransport>,
    close_timeout: Duration,
    close_tracker: TransportCloseTracker,
}

impl PendingWsTransport {
    fn new(
        transport: WsTransport,
        close_timeout: Duration,
        close_tracker: TransportCloseTracker,
    ) -> Self {
        Self {
            transport: Some(transport),
            close_timeout,
            close_tracker,
        }
    }

    fn transport_mut(&mut self) -> Result<&mut WsTransport, Error> {
        self.transport.as_mut().ok_or_else(|| Error::Protocol {
            code: error_code::FAILED,
            message: "Pending WebSocket transport is unavailable".to_string(),
        })
    }

    pub(super) fn read_mut(&mut self) -> Result<&mut WsRead, Error> {
        Ok(&mut self.transport_mut()?.ws_read)
    }

    pub(super) fn write_mut(&mut self) -> Result<&mut WsWrite, Error> {
        Ok(&mut self.transport_mut()?.ws_write)
    }

    pub(super) fn into_transport(mut self) -> Result<WsTransport, Error> {
        self.transport.take().ok_or_else(|| Error::Protocol {
            code: error_code::FAILED,
            message: "Pending WebSocket transport is unavailable".to_string(),
        })
    }
}

impl Drop for PendingWsTransport {
    fn drop(&mut self) {
        if let Some(transport) = self.transport.take() {
            transport.close_in_background(self.close_timeout, &self.close_tracker);
        }
    }
}

pub(super) async fn connect_pending(
    url: &str,
    close_timeout: Duration,
    close_tracker: TransportCloseTracker,
) -> Result<PendingWsTransport, Error> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    let (ws_write, ws_read) = ws.split();
    Ok(PendingWsTransport::new(
        WsTransport::new(WsRead::new(ws_read), ws_write),
        close_timeout,
        close_tracker,
    ))
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
    redact_auth_query_params(frame.reason.as_ref())
}

pub(super) fn websocket_error_reason(error: &tungstenite::Error) -> String {
    format!(
        "websocket error: {}",
        redact_auth_query_params(&error.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_close_reason_redacts_auth_query_params_from_reason() {
        let frame = CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "url=wss://example/?access_token=close-token&resume=close-key&format=msgpack"
                .into(),
        };

        let reason = websocket_close_reason(Some(&frame));
        let log_reason = websocket_close_frame_reason(&frame);

        assert_eq!(
            reason,
            "websocket closed code=1000 reason=url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
        );
        assert_eq!(
            log_reason,
            "url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
        );
        assert!(!reason.contains("close-token"));
        assert!(!reason.contains("close-key"));
        assert!(!log_reason.contains("close-token"));
        assert!(!log_reason.contains("close-key"));
    }

    #[test]
    fn websocket_error_reason_redacts_auth_query_params() {
        let err = tungstenite::Error::Url(tungstenite::error::UrlError::UnableToConnect(
            "wss://example/?access_token=error-token&resume=error-key&format=msgpack".to_string(),
        ));

        let reason = websocket_error_reason(&err);

        assert_eq!(
            reason,
            "websocket error: URL error: Unable to connect to wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
        );
        assert!(!reason.contains("error-token"));
        assert!(!reason.contains("error-key"));
    }
}
