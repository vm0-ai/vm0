//! Shared CLI event delivery worker and acknowledgement state.
//!
//! Event schema transformation and HTTP retry details stay in `events` and
//! `http`; this module owns bounded non-blocking admission and serial FIFO
//! backlog batching shared by CLI backends. A batch is one retry/failure unit,
//! and acknowledgement remains the highest contiguous successful sequence.

use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use bytes::Bytes;
use guest_common::{log_info, log_warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinHandle;

use super::LOG_TAG;

const EVENT_DELIVERY_QUEUE_CAPACITY: usize = 512;
const EVENT_DELIVERY_MAX_BYTES: usize = 16 * 1024 * 1024;
const EVENT_DELIVERY_MAX_REQUEST_EVENTS: usize = 32;
const EVENT_DELIVERY_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const EVENT_DELIVERY_DRAIN_TIMEOUT: Duration = Duration::from_secs(120);

struct PreparedEvent {
    sequence: u32,
    event: Bytes,
    conservative_bytes: usize,
    byte_budget: OwnedSemaphorePermit,
}

pub(super) struct EventDeliverySender {
    tx: mpsc::Sender<PreparedEvent>,
    byte_budget: Arc<Semaphore>,
    pressure: Arc<DeliveryPressure>,
    payload_envelope: Arc<events::EventPayloadEnvelope>,
}

impl EventDeliverySender {
    pub(super) fn try_send(
        &self,
        sequence: u32,
        event: serde_json::Value,
    ) -> Result<(), AgentError> {
        let event = Bytes::from(serde_json::to_vec(&event)?);
        let conservative_bytes = self.payload_envelope.singleton_bytes(event.len());
        if conservative_bytes > EVENT_DELIVERY_MAX_REQUEST_BYTES {
            return Err(AgentError::Execution(format!(
                "CLI event delivery payload at sequence {sequence} is {conservative_bytes} bytes, exceeding the {EVENT_DELIVERY_MAX_REQUEST_BYTES}-byte request limit"
            )));
        }

        let available_bytes = self.byte_budget.available_permits();
        let byte_budget = Arc::clone(&self.byte_budget)
            .try_acquire_many_owned(conservative_bytes as u32)
            .map_err(|_| {
                AgentError::Execution(format!(
                    "CLI event delivery byte buffer exhausted at sequence {sequence}: payload is {conservative_bytes} bytes, {available_bytes} of {EVENT_DELIVERY_MAX_BYTES} bytes available, {} events pending",
                    self.pressure.pending_events()
                ))
            })?;
        let admission = self.pressure.begin_admission(conservative_bytes);
        let prepared = PreparedEvent {
            sequence,
            event,
            conservative_bytes,
            byte_budget,
        };

        match self.tx.try_send(prepared) {
            Ok(()) => {
                self.pressure.confirm_admission(admission);
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.pressure.reject_admission(conservative_bytes);
                Err(AgentError::Execution(format!(
                    "CLI event delivery queue exceeded {EVENT_DELIVERY_QUEUE_CAPACITY} pending events at sequence {sequence}; {} bytes buffered",
                    self.pressure.buffered_bytes()
                )))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.pressure.reject_admission(conservative_bytes);
                Err(AgentError::Execution(format!(
                    "CLI event delivery worker stopped before sequence {sequence} could be queued"
                )))
            }
        }
    }
}

pub(super) struct EventDeliveryRuntime {
    sender: EventDeliverySender,
    worker: JoinHandle<Option<u32>>,
    pressure: Arc<DeliveryPressure>,
}

impl EventDeliveryRuntime {
    pub(super) fn start(
        http: HttpClient,
        event_error_flag: String,
        run_id: &str,
    ) -> Result<Self, AgentError> {
        let (tx, event_rx) = mpsc::channel(EVENT_DELIVERY_QUEUE_CAPACITY);
        let pressure = Arc::new(DeliveryPressure::default());
        let payload_envelope = Arc::new(events::EventPayloadEnvelope::new(run_id)?);
        let sender = EventDeliverySender {
            tx,
            byte_budget: Arc::new(Semaphore::new(EVENT_DELIVERY_MAX_BYTES)),
            pressure: Arc::clone(&pressure),
            payload_envelope: Arc::clone(&payload_envelope),
        };
        let worker = tokio::spawn(run_event_sender(
            event_rx,
            http,
            event_error_flag,
            payload_envelope,
            Arc::clone(&pressure),
        ));
        Ok(Self {
            sender,
            worker,
            pressure,
        })
    }

    pub(super) fn sender(&self) -> &EventDeliverySender {
        &self.sender
    }

    pub(super) async fn finish(self) -> Result<Option<u32>, AgentError> {
        let Self {
            sender,
            mut worker,
            pressure,
        } = self;
        drop(sender);
        let drain_start = pressure.snapshot();
        log_info!(
            LOG_TAG,
            "Event delivery drain started: pending_events={} buffered_bytes={}",
            drain_start.pending_events,
            drain_start.buffered_bytes
        );

        match tokio::time::timeout(EVENT_DELIVERY_DRAIN_TIMEOUT, &mut worker).await {
            Ok(Ok(sequence)) => Ok(sequence),
            Ok(Err(error)) => Err(AgentError::Execution(format!(
                "CLI event delivery worker failed: {error}"
            ))),
            Err(_) => {
                worker.abort();
                let _ = worker.await;
                let snapshot = pressure.snapshot();
                Err(AgentError::Execution(format!(
                    "CLI event delivery did not drain within {} seconds: {} events pending, {} bytes buffered",
                    EVENT_DELIVERY_DRAIN_TIMEOUT.as_secs(),
                    snapshot.pending_events,
                    snapshot.buffered_bytes
                )))
            }
        }
    }

    pub(super) async fn abort(self) {
        let Self {
            sender,
            worker,
            pressure: _,
        } = self;
        drop(sender);
        worker.abort();
        let _ = worker.await;
    }
}

#[derive(Clone, Copy)]
struct AdmissionPressure {
    pending_events: usize,
    buffered_bytes: usize,
}

#[derive(Clone, Copy)]
struct DeliveryPressureSnapshot {
    pending_events: usize,
    buffered_bytes: usize,
    max_pending_events: usize,
    max_buffered_bytes: usize,
}

#[derive(Default)]
struct DeliveryPressure {
    pending_events: AtomicUsize,
    buffered_bytes: AtomicUsize,
    max_pending_events: AtomicUsize,
    max_buffered_bytes: AtomicUsize,
}

impl DeliveryPressure {
    fn begin_admission(&self, bytes: usize) -> AdmissionPressure {
        AdmissionPressure {
            pending_events: self.pending_events.fetch_add(1, Ordering::Relaxed) + 1,
            buffered_bytes: self.buffered_bytes.fetch_add(bytes, Ordering::Relaxed) + bytes,
        }
    }

    fn confirm_admission(&self, admission: AdmissionPressure) {
        self.max_pending_events
            .fetch_max(admission.pending_events, Ordering::Relaxed);
        self.max_buffered_bytes
            .fetch_max(admission.buffered_bytes, Ordering::Relaxed);
    }

    fn reject_admission(&self, bytes: usize) {
        self.pending_events.fetch_sub(1, Ordering::Relaxed);
        self.buffered_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn mark_dequeued(&self) {
        self.pending_events.fetch_sub(1, Ordering::Relaxed);
    }

    fn release_bytes(&self, bytes: usize) {
        self.buffered_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn pending_events(&self) -> usize {
        self.pending_events.load(Ordering::Relaxed)
    }

    fn buffered_bytes(&self) -> usize {
        self.buffered_bytes.load(Ordering::Relaxed)
    }

    fn snapshot(&self) -> DeliveryPressureSnapshot {
        DeliveryPressureSnapshot {
            pending_events: self.pending_events(),
            buffered_bytes: self.buffered_bytes(),
            max_pending_events: self.max_pending_events.load(Ordering::Relaxed),
            max_buffered_bytes: self.max_buffered_bytes.load(Ordering::Relaxed),
        }
    }
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
    payload_envelope: Arc<events::EventPayloadEnvelope>,
    pressure: Arc<DeliveryPressure>,
) -> Option<u32> {
    let mut acked_prefix = AckedEventPrefix::default();
    let mut carried_event = None;
    let mut stats = DeliveryStats::default();

    loop {
        let first_event = match carried_event.take() {
            Some(event) => event,
            None => {
                let Some(event) = event_rx.recv().await else {
                    break;
                };
                pressure.mark_dequeued();
                event
            }
        };
        let first_sequence = first_event.sequence;
        let (batch, next_carried_event) = collect_batch(first_event, &mut event_rx, &pressure);
        let last_sequence = batch.last().map_or(first_sequence, |event| event.sequence);
        carried_event = next_carried_event;
        let EventBatch {
            sequences,
            payload,
            conservative_bytes,
            byte_budgets,
        } = EventBatch::new(batch, &payload_envelope);
        let event_count = sequences.len();
        let send_result =
            events::post_serialized_event_with_error_flag(&http, payload, &event_error_flag).await;
        drop(byte_budgets);
        pressure.release_bytes(conservative_bytes);

        let succeeded = send_result.is_ok();
        stats.record_request(event_count, conservative_bytes, succeeded);
        log_info!(
            LOG_TAG,
            "Event delivery request: first_sequence={first_sequence} last_sequence={last_sequence} events={event_count} conservative_bytes={conservative_bytes} result={} queued_events_remaining={}",
            if succeeded { "success" } else { "failure" },
            pressure.pending_events() + usize::from(carried_event.is_some())
        );

        match send_result {
            Ok(()) => {
                for sequence in sequences {
                    acked_prefix.record_success(sequence);
                }
            }
            Err(e) => {
                acked_prefix.record_failure(first_sequence);
                log_warn!(
                    LOG_TAG,
                    "Event send failed for sequences {first_sequence}-{last_sequence}: {e}"
                );
            }
        }
    }

    let last_contiguous = acked_prefix.last_contiguous();
    let pressure = pressure.snapshot();
    log_info!(
        LOG_TAG,
        "Event delivery complete: events={} requests={} failed_requests={} max_batch_events={} max_batch_bytes={} max_pending_events={} max_buffered_bytes={} last_contiguous_sequence={last_contiguous:?}",
        stats.total_events,
        stats.total_requests,
        stats.failed_requests,
        stats.max_batch_events,
        stats.max_batch_bytes,
        pressure.max_pending_events,
        pressure.max_buffered_bytes
    );
    last_contiguous
}

fn collect_batch(
    first_event: PreparedEvent,
    event_rx: &mut mpsc::Receiver<PreparedEvent>,
    pressure: &DeliveryPressure,
) -> (Vec<PreparedEvent>, Option<PreparedEvent>) {
    let mut conservative_bytes = first_event.conservative_bytes;
    let mut batch = Vec::with_capacity(EVENT_DELIVERY_MAX_REQUEST_EVENTS);
    batch.push(first_event);

    while batch.len() < EVENT_DELIVERY_MAX_REQUEST_EVENTS {
        let next_event = match event_rx.try_recv() {
            Ok(event) => {
                pressure.mark_dequeued();
                event
            }
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected) => {
                break;
            }
        };
        if next_event.conservative_bytes > EVENT_DELIVERY_MAX_REQUEST_BYTES - conservative_bytes {
            return (batch, Some(next_event));
        }
        conservative_bytes += next_event.conservative_bytes;
        batch.push(next_event);
    }

    (batch, None)
}

struct EventBatch {
    sequences: Vec<u32>,
    payload: Bytes,
    conservative_bytes: usize,
    byte_budgets: Vec<OwnedSemaphorePermit>,
}

impl EventBatch {
    fn new(events: Vec<PreparedEvent>, payload_envelope: &events::EventPayloadEnvelope) -> Self {
        let mut sequences = Vec::with_capacity(events.len());
        let mut event_bytes = Vec::with_capacity(events.len());
        let mut conservative_bytes = 0usize;
        let mut byte_budgets = Vec::with_capacity(events.len());

        for event in events {
            sequences.push(event.sequence);
            event_bytes.push(event.event);
            conservative_bytes += event.conservative_bytes;
            byte_budgets.push(event.byte_budget);
        }

        Self {
            sequences,
            payload: payload_envelope.payload(&event_bytes),
            conservative_bytes,
            byte_budgets,
        }
    }
}

#[derive(Default)]
struct DeliveryStats {
    total_events: usize,
    total_requests: usize,
    failed_requests: usize,
    max_batch_events: usize,
    max_batch_bytes: usize,
}

impl DeliveryStats {
    fn record_request(&mut self, events: usize, bytes: usize, succeeded: bool) {
        self.total_events += events;
        self.total_requests += 1;
        self.failed_requests += usize::from(!succeeded);
        self.max_batch_events = self.max_batch_events.max(events);
        self.max_batch_bytes = self.max_batch_bytes.max(bytes);
    }
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
