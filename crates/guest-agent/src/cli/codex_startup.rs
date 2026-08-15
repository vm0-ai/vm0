//! Exactly-once telemetry for Codex startup through primary turn readiness.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use guest_common::telemetry::record_sandbox_op;

/// Records the complete Codex setup-to-turn-readiness boundary once.
pub struct CodexStartupTiming {
    started_at: Instant,
    completed: AtomicBool,
}

impl CodexStartupTiming {
    /// Start a Codex startup observation at the current monotonic time.
    #[must_use]
    pub fn start() -> Self {
        Self {
            started_at: Instant::now(),
            completed: AtomicBool::new(false),
        }
    }

    /// Complete startup successfully at the time readiness was observed.
    pub fn record_success_at(&self, observed_at: Instant) {
        self.record_at(observed_at, true);
    }

    /// Complete startup as failed at the current monotonic time.
    pub fn record_failure(&self) {
        self.record_at(Instant::now(), false);
    }

    fn record_at(&self, completed_at: Instant, success: bool) {
        if self.completed.swap(true, Ordering::Relaxed) {
            return;
        }

        record_sandbox_op(
            "codex_startup",
            completed_at.saturating_duration_since(self.started_at),
            success,
            None,
        );
    }
}
