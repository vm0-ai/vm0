//! Public entry point: [`subscribe`] and [`Subscription`].

use futures_util::SinkExt;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite;

use crate::connection::{
    ConnState, DEFAULT_REALTIME_HOST, EventLoopState, build_ws_url, connect_and_split,
    exchange_token, rest_host, run_event_loop, wait_for_attached, wait_for_connected,
};
use crate::protocol::{build_attach_msg, encode_msg};
use crate::types::{Error, Event, SubscribeConfig};

/// Handle to a running subscription.
///
/// Call [`next`](Subscription::next) to receive events, or [`close`](Subscription::close) to
/// shut down the connection.
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
    let (event_tx, event_rx) = mpsc::channel::<Event>(64);
    let (close_tx, close_rx) = oneshot::channel::<()>();

    let realtime_host = config
        .host
        .as_deref()
        .unwrap_or(DEFAULT_REALTIME_HOST)
        .to_string();
    let rest = rest_host(&realtime_host);
    let http = reqwest::Client::new();

    // Initial token exchange
    let token_request = (config.get_token)().await.map_err(Error::TokenFetch)?;
    let token = exchange_token(&http, &token_request, &rest).await?;

    // Connect WebSocket
    let ws_url = build_ws_url(&realtime_host, &token.token, None)?;
    let (ws_write, mut ws_read) = connect_and_split(&ws_url).await?;

    // Wait for CONNECTED
    let connected_msg = wait_for_connected(&mut ws_read).await?;
    let conn_state = ConnState::from_connected(&connected_msg, token);

    // Send ATTACH
    let attach = build_attach_msg(&config.channel, config.channel_params.as_ref());
    let mut ws_write = ws_write;
    let encoded = encode_msg(&attach)?;
    ws_write
        .send(tungstenite::Message::Binary(encoded.into()))
        .await?;

    // Wait for ATTACHED
    wait_for_attached(&mut ws_read, &config.channel).await?;

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
        },
        close_rx,
    ));

    Ok(Subscription {
        rx: event_rx,
        close_tx: Some(close_tx),
    })
}
