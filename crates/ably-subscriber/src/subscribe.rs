//! Public entry point: [`subscribe`] and [`Subscription`].

use tokio::sync::{mpsc, oneshot};

use crate::connection::{
    DEFAULT_REALTIME_HOST, EventLoopState, connect_and_attach, exchange_token, rest_host,
    run_event_loop,
};
use crate::protocol::error_code;
use crate::types::{Error, Event, SubscribeConfig};

/// Handle to a running subscription.
///
/// Call [`next`](Subscription::next) to receive events, or [`close`](Subscription::close) to
/// shut down the connection.
///
/// Messages may be dropped under backpressure if the consumer falls behind.
pub struct Subscription {
    rx: mpsc::Receiver<Event>,
    close_tx: Option<oneshot::Sender<()>>,
}

impl Subscription {
    /// Receive the next event. Returns `None` if the background task has exited.
    pub async fn next(&mut self) -> Option<Event> {
        self.rx.recv().await
    }

    /// Gracefully close the connection.
    pub fn close(mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Subscribe to an Ably channel.
///
/// Establishes a WebSocket connection, exchanges the token, attaches to the
/// channel, and returns a [`Subscription`] that yields [`Event`]s.
///
/// The background task automatically handles reconnection, token renewal, and
/// heartbeat timeout detection.
pub async fn subscribe(config: SubscribeConfig) -> Result<Subscription, Error> {
    let timing = config.timing.unwrap_or_default();
    let (event_tx, event_rx) = mpsc::channel::<Event>(timing.event_channel_capacity);
    let (close_tx, close_rx) = oneshot::channel::<()>();

    let realtime_host = config
        .host
        .as_deref()
        .unwrap_or(DEFAULT_REALTIME_HOST)
        .to_string();
    let rest = config
        .rest_host
        .unwrap_or_else(|| rest_host(&realtime_host));
    let http = reqeast::builder().timeout(timing.connect_timeout).build()?;

    // Initial token exchange (with timeout)
    let token_request = tokio::time::timeout(timing.connect_timeout, (config.get_token)())
        .await
        .map_err(|_| Error::Protocol {
            code: error_code::TIMEOUT,
            message: "Token fetch timed out".to_string(),
        })?
        .map_err(Error::TokenFetch)?;
    let token = exchange_token(&http, &token_request, &rest).await?;

    // Connect, handshake, and attach with timeout
    let (ws_write, ws_read, conn_state) = tokio::time::timeout(
        timing.connect_timeout,
        connect_and_attach(
            &realtime_host,
            token,
            &config.channel,
            config.channel_params.as_ref(),
            &timing,
        ),
    )
    .await
    .map_err(|_| Error::Protocol {
        code: error_code::TIMEOUT,
        message: "Connection timed out".to_string(),
    })??;

    let _ = event_tx.send(Event::Connected).await;

    // Spawn background event loop
    tokio::spawn(run_event_loop(
        EventLoopState {
            ws_read,
            ws_write,
            event_tx,
            conn_state,
            channel: config.channel,
            channel_params: config.channel_params,
            realtime_host,
            rest_host: rest,
            http,
            get_token: config.get_token,
            timing,
            token_renewal_failures: 0,
            dropped_messages: 0,
        },
        close_rx,
    ));

    Ok(Subscription {
        rx: event_rx,
        close_tx: Some(close_tx),
    })
}
