//! Public entry point: [`subscribe`] and [`Subscription`].

use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use crate::connection::{
    DEFAULT_REALTIME_HOST, DropWarningState, EventLoopState, SessionState, TransportCloseTracker,
    connect_and_attach, exchange_token, rest_host, run_event_loop,
};
use crate::protocol::error_code;
use crate::types::{Error, Event, SubscribeConfig};

/// Handle to a running subscription.
///
/// Call [`next`](Subscription::next) to receive events, [`close`](Subscription::close) to request
/// shutdown, or [`close_and_wait`](Subscription::close_and_wait) to observe graceful completion.
///
/// Messages may be dropped under backpressure if the consumer falls behind.
pub struct Subscription {
    rx: mpsc::Receiver<Event>,
    close_tx: Option<oneshot::Sender<CloseRequest>>,
    close_timeout: Duration,
    close_tracker: TransportCloseTracker,
}

pub(crate) struct CloseRequest {
    completion: Option<oneshot::Sender<Result<(), Error>>>,
}

impl CloseRequest {
    pub(crate) fn request_only() -> Self {
        Self { completion: None }
    }

    fn tracked(completion: oneshot::Sender<Result<(), Error>>) -> Self {
        Self {
            completion: Some(completion),
        }
    }

    pub(crate) fn complete(self, result: Result<(), Error>) {
        match self.completion {
            Some(completion) => {
                let _ = completion.send(result);
            }
            None => {
                if let Err(error) = result {
                    tracing::warn!(error = %error, "Failed to close Ably subscription");
                }
            }
        }
    }
}

fn close_error(code: i32, message: &str) -> Error {
    Error::Protocol {
        code,
        message: message.to_string(),
    }
}

impl Subscription {
    /// Receive the next event. Returns `None` if the background task has exited.
    pub async fn next(&mut self) -> Option<Event> {
        self.rx.recv().await
    }

    /// Request a best-effort graceful close without waiting for completion.
    pub fn close(mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(CloseRequest::request_only());
        }
    }

    /// Gracefully close the background WebSocket connection and await completion.
    ///
    /// The wait is bounded by [`TimingConfig::close_timeout`](crate::TimingConfig::close_timeout).
    /// Success means the local Ably `CLOSE`, WebSocket close, caller-requested event-loop close
    /// path, and any subscription-owned transport cleanup have completed. It does not wait for a
    /// server `CLOSED` acknowledgement.
    pub async fn close_and_wait(mut self) -> Result<(), Error> {
        self.close_tracker.observe_errors();
        let (completion_tx, completion_rx) = oneshot::channel();
        let Some(close_tx) = self.close_tx.take() else {
            return Err(close_error(
                error_code::FAILED,
                "Subscription close request was already sent",
            ));
        };
        close_tx
            .send(CloseRequest::tracked(completion_tx))
            .map_err(|_| {
                close_error(
                    error_code::FAILED,
                    "Subscription event loop stopped before close request",
                )
            })?;

        tokio::time::timeout(self.close_timeout, completion_rx)
            .await
            .map_err(|_| {
                close_error(
                    error_code::TIMEOUT,
                    "Subscription close did not complete before timeout",
                )
            })?
            .map_err(|_| {
                close_error(
                    error_code::FAILED,
                    "Subscription event loop stopped before close completion",
                )
            })?
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(CloseRequest::request_only());
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
    let close_timeout = timing.close_timeout;
    let event_channel_capacity = timing.event_channel_capacity.max(1);
    let (event_tx, event_rx) = mpsc::channel::<Event>(event_channel_capacity);
    let (close_tx, close_rx) = oneshot::channel::<CloseRequest>();
    let close_tracker = TransportCloseTracker::default();

    let realtime_host = config
        .host
        .as_deref()
        .unwrap_or(DEFAULT_REALTIME_HOST)
        .to_string();
    let rest = config
        .rest_host
        .unwrap_or_else(|| rest_host(&realtime_host));
    let http = reqwest::Client::builder()
        .timeout(timing.connect_timeout)
        .build()?;

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
    let (transport, conn_state) = tokio::time::timeout(
        timing.connect_timeout,
        connect_and_attach(
            &realtime_host,
            token,
            &config.channel,
            config.channel_params.as_ref(),
            &timing,
            close_tracker.clone(),
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
            transport: Some(transport),
            event_tx,
            session: SessionState::connected(conn_state),
            channel: config.channel,
            channel_params: config.channel_params,
            realtime_host,
            rest_host: rest,
            http,
            get_token: config.get_token,
            timing,
            drop_warnings: DropWarningState::default(),
            close_tracker: close_tracker.clone(),
        },
        close_rx,
    ));

    Ok(Subscription {
        rx: event_rx,
        close_tx: Some(close_tx),
        close_timeout,
        close_tracker,
    })
}
