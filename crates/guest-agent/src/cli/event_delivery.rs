//! CLI stdout event delivery state.
//!
//! Event schema transformation and HTTP posting stay in `events`; this module
//! only owns execution-delivery state consumed by `execute_cli`.

pub(super) struct PreparedEvent {
    pub(super) sequence: u32,
    pub(super) payload: serde_json::Value,
}

#[derive(Default)]
pub(super) struct AckedEventPrefix {
    next_expected: u32,
    last_contiguous: Option<u32>,
    prefix_broken: bool,
}

impl AckedEventPrefix {
    pub(super) fn record_success(&mut self, sequence: u32) {
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

    pub(super) fn record_failure(&mut self, sequence: u32) {
        if sequence >= self.next_expected {
            self.prefix_broken = true;
        }
    }

    pub(super) fn last_contiguous(&self) -> Option<u32> {
        self.last_contiguous
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
