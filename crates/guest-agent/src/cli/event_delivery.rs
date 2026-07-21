//! Shared CLI event delivery worker and acknowledgement state.
//!
//! Event schema transformation and HTTP retry details stay in `events` and
//! `http`; this module owns ordered background delivery shared by CLI backends.

use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use guest_common::log_warn;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinHandle;

use super::LOG_TAG;

const EVENT_DELIVERY_QUEUE_CAPACITY: usize = 512;
const EVENT_DELIVERY_MAX_BYTES: usize = 16 * 1024 * 1024;
const EVENT_DELIVERY_DRAIN_TIMEOUT: Duration = Duration::from_secs(120);

struct PreparedEvent {
    sequence: u32,
    payload: serde_json::Value,
    _byte_budget: OwnedSemaphorePermit,
}

pub(super) struct EventDeliverySender {
    tx: mpsc::Sender<PreparedEvent>,
    byte_budget: Arc<Semaphore>,
}

impl EventDeliverySender {
    pub(super) fn try_send(
        &self,
        sequence: u32,
        payload: serde_json::Value,
    ) -> Result<(), AgentError> {
        let payload_bytes = serialized_size(&payload)?;
        if payload_bytes > EVENT_DELIVERY_MAX_BYTES {
            return Err(AgentError::Execution(format!(
                "CLI event delivery payload at sequence {sequence} is {payload_bytes} bytes, exceeding the {EVENT_DELIVERY_MAX_BYTES}-byte buffer limit"
            )));
        }

        let available_bytes = self.byte_budget.available_permits();
        let byte_budget = Arc::clone(&self.byte_budget)
            .try_acquire_many_owned(payload_bytes as u32)
            .map_err(|_| {
                AgentError::Execution(format!(
                    "CLI event delivery byte buffer exhausted at sequence {sequence}: payload is {payload_bytes} bytes, {available_bytes} of {EVENT_DELIVERY_MAX_BYTES} bytes available"
                ))
            })?;
        let prepared = PreparedEvent {
            sequence,
            payload,
            _byte_budget: byte_budget,
        };

        match self.tx.try_send(prepared) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => Err(AgentError::Execution(format!(
                "CLI event delivery queue exceeded {EVENT_DELIVERY_QUEUE_CAPACITY} pending events at sequence {sequence}"
            ))),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(AgentError::Execution(format!(
                "CLI event delivery worker stopped before sequence {sequence} could be queued"
            ))),
        }
    }
}

pub(super) struct EventDeliveryRuntime {
    sender: EventDeliverySender,
    worker: JoinHandle<Option<u32>>,
}

impl EventDeliveryRuntime {
    pub(super) fn start(http: HttpClient, event_error_flag: String) -> Self {
        let (tx, event_rx) = mpsc::channel(EVENT_DELIVERY_QUEUE_CAPACITY);
        let sender = EventDeliverySender {
            tx,
            byte_budget: Arc::new(Semaphore::new(EVENT_DELIVERY_MAX_BYTES)),
        };
        let worker = tokio::spawn(run_event_sender(event_rx, http, event_error_flag));
        Self { sender, worker }
    }

    pub(super) fn sender(&self) -> &EventDeliverySender {
        &self.sender
    }

    pub(super) async fn finish(self) -> Result<Option<u32>, AgentError> {
        let Self { sender, mut worker } = self;
        drop(sender);

        match tokio::time::timeout(EVENT_DELIVERY_DRAIN_TIMEOUT, &mut worker).await {
            Ok(Ok(sequence)) => Ok(sequence),
            Ok(Err(error)) => Err(AgentError::Execution(format!(
                "CLI event delivery worker failed: {error}"
            ))),
            Err(_) => {
                worker.abort();
                let _ = worker.await;
                Err(AgentError::Execution(format!(
                    "CLI event delivery did not drain within {} seconds",
                    EVENT_DELIVERY_DRAIN_TIMEOUT.as_secs()
                )))
            }
        }
    }

    pub(super) async fn abort(self) {
        let Self { sender, worker } = self;
        drop(sender);
        worker.abort();
        let _ = worker.await;
    }
}

#[derive(Default)]
struct SerializedSize {
    bytes: usize,
}

impl Write for SerializedSize {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buffer.len());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialized_size(payload: &serde_json::Value) -> Result<usize, AgentError> {
    let mut size = SerializedSize::default();
    serde_json::to_writer(&mut size, payload)?;
    Ok(size.bytes)
}

#[derive(Default)]
struct AckedEventPrefix {
    next_expected: u32,
    last_contiguous: Option<u32>,
    prefix_broken: bool,
}

impl AckedEventPrefix {
    fn record_success(&mut self, sequence: u32) {
        if self.prefix_broken {
            return;
        }

        if sequence == self.next_expected {
            self.last_contiguous = Some(sequence);
            self.next_expected = sequence.saturating_add(1);
        } else if sequence > self.next_expected {
            self.prefix_broken = true;
        }
    }

    fn record_failure(&mut self, sequence: u32) {
        if sequence >= self.next_expected {
            self.prefix_broken = true;
        }
    }

    fn last_contiguous(&self) -> Option<u32> {
        self.last_contiguous
    }
}

async fn run_event_sender(
    mut event_rx: mpsc::Receiver<PreparedEvent>,
    http: HttpClient,
    event_error_flag: String,
) -> Option<u32> {
    let mut acked_prefix = AckedEventPrefix::default();
    while let Some(PreparedEvent {
        sequence, payload, ..
    }) = event_rx.recv().await
    {
        match events::post_event_with_error_flag(&http, &payload, &event_error_flag).await {
            Ok(()) => {
                acked_prefix.record_success(sequence);
            }
            Err(e) => {
                acked_prefix.record_failure(sequence);
                log_warn!(LOG_TAG, "Event send failed: {e}");
            }
        }
    }
    acked_prefix.last_contiguous()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acked_event_prefix_advances_on_contiguous_successes() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_success(1);
        prefix.record_success(2);

        assert_eq!(prefix.last_contiguous(), Some(2));
    }

    #[test]
    fn acked_event_prefix_stops_at_first_failed_event() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_failure(1);
        prefix.record_success(2);

        assert_eq!(prefix.last_contiguous(), Some(0));
    }

    #[test]
    fn acked_event_prefix_has_no_watermark_when_first_event_fails() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_failure(0);
        prefix.record_success(1);

        assert_eq!(prefix.last_contiguous(), None);
    }

    #[test]
    fn acked_event_prefix_rejects_success_gap() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_success(2);
        prefix.record_success(3);

        assert_eq!(prefix.last_contiguous(), Some(0));
    }
}
