//! Shared CLI event delivery worker and acknowledgement state.
//!
//! Event schema transformation and HTTP retry details stay in `events` and
//! `http`; this module owns ordered background delivery shared by CLI backends.

use crate::events;
use crate::http::HttpClient;
use guest_common::log_warn;

use super::LOG_TAG;

pub(super) struct PreparedEvent {
    pub(super) sequence: u32,
    pub(super) payload: serde_json::Value,
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

pub(super) async fn run_event_sender(
    mut event_rx: tokio::sync::mpsc::UnboundedReceiver<PreparedEvent>,
    http: HttpClient,
    event_error_flag: String,
) -> Option<u32> {
    let mut acked_prefix = AckedEventPrefix::default();
    while let Some(PreparedEvent { sequence, payload }) = event_rx.recv().await {
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
