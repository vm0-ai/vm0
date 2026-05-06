use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::future::join_all;
use futures_util::task::noop_waker_ref;
use tokio::io::{AsyncBufRead, Lines};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tracing::warn;

use crate::ids::RunId;

const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct NetworkLogDrainCoordinator {
    producers: Arc<Vec<NetworkLogDrainProducer>>,
    timeout: Duration,
}

impl Default for NetworkLogDrainCoordinator {
    fn default() -> Self {
        Self::noop()
    }
}

impl NetworkLogDrainCoordinator {
    pub fn new(producers: Vec<NetworkLogDrainProducer>) -> Self {
        Self {
            producers: Arc::new(producers),
            timeout: DEFAULT_DRAIN_TIMEOUT,
        }
    }

    pub fn noop() -> Self {
        Self::new(Vec::new())
    }

    #[cfg(test)]
    pub(crate) fn new_with_timeout_for_test(
        producers: Vec<NetworkLogDrainProducer>,
        timeout: Duration,
    ) -> Self {
        Self {
            producers: Arc::new(producers),
            timeout,
        }
    }

    pub async fn drain(&self, context: NetworkLogDrainContext<'_>) {
        join_all(
            self.producers
                .iter()
                .map(|producer| producer.drain(context, self.timeout)),
        )
        .await;
    }
}

#[derive(Clone)]
pub struct NetworkLogDrainProducer {
    name: &'static str,
    tx: mpsc::Sender<NetworkLogDrainRequest>,
}

impl NetworkLogDrainProducer {
    pub fn channel(name: &'static str) -> (Self, mpsc::Receiver<NetworkLogDrainRequest>) {
        let (tx, rx) = mpsc::channel(64);
        (Self { name, tx }, rx)
    }

    pub(crate) async fn drain(&self, context: NetworkLogDrainContext<'_>, wait: Duration) {
        let (ack_tx, ack_rx) = oneshot::channel();
        match timeout(wait, self.tx.send(NetworkLogDrainRequest { ack: ack_tx })).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                warn!(
                    run_id = %context.run_id,
                    source_ip = context.source_ip,
                    path = %context.path.display(),
                    generation = context.generation,
                    producer = self.name,
                    "network log drain producer unavailable"
                );
                return;
            }
            Err(_) => {
                warn!(
                    run_id = %context.run_id,
                    source_ip = context.source_ip,
                    path = %context.path.display(),
                    generation = context.generation,
                    producer = self.name,
                    timeout_ms = wait.as_millis(),
                    "network log drain request timed out"
                );
                return;
            }
        }

        match timeout(wait, ack_rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => warn!(
                run_id = %context.run_id,
                source_ip = context.source_ip,
                path = %context.path.display(),
                generation = context.generation,
                producer = self.name,
                "network log drain producer dropped ack"
            ),
            Err(_) => warn!(
                run_id = %context.run_id,
                source_ip = context.source_ip,
                path = %context.path.display(),
                generation = context.generation,
                producer = self.name,
                timeout_ms = wait.as_millis(),
                "network log drain producer timed out"
            ),
        }
    }
}

pub(crate) struct NetworkLogDrainRequest {
    ack: oneshot::Sender<()>,
}

impl NetworkLogDrainRequest {
    pub(crate) fn ack(self) {
        let _ = self.ack.send(());
    }
}

#[derive(Clone, Copy)]
pub struct NetworkLogDrainContext<'a> {
    pub run_id: RunId,
    pub source_ip: &'a str,
    pub path: &'a Path,
    pub generation: u64,
}

pub(crate) enum ReadyLine {
    Line(String),
    Eof,
    Pending,
}

/// Poll `Lines::next_line` once without waiting for future readiness.
///
/// `Lines::next_line` is cancellation-safe; when the poll returns `Pending`,
/// dropping the future preserves the reader state for the normal loop. This is
/// the producer-owned barrier used to drain complete lines that are immediately
/// observable to the runner reader task without sleeping.
pub(crate) fn poll_next_line_ready<R>(lines: &mut Lines<R>) -> std::io::Result<ReadyLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut next = std::pin::pin!(lines.next_line());
    let mut cx = Context::from_waker(noop_waker_ref());
    match Future::poll(next.as_mut(), &mut cx) {
        Poll::Ready(Ok(Some(line))) => Ok(ReadyLine::Line(line)),
        Poll::Ready(Ok(None)) => Ok(ReadyLine::Eof),
        Poll::Ready(Err(e)) => Err(e),
        Poll::Pending => Ok(ReadyLine::Pending),
    }
}
