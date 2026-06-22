//! CLI process-group termination state machine.
//!
//! Signal sending, deadline reset timing, and child wait ordering remain in
//! `execute_cli`; this module only owns the FSM state and guards.

use std::time::Duration;
use tokio::time::Instant;

/// State machine driving forced CLI process-group termination. A single
/// pinned deadline is resettable across phases; the enum value tells the
/// lone select! branch what to do when the deadline fires.
///
/// | From             | Trigger        | To              | Action          |
/// |------------------|----------------|-----------------|-----------------|
/// | `Idle`           | `type=result`  | `SigtermPending`| arm delayed sigterm grace |
/// | `Idle`           | forced kill    | `SigkillPending`| SIGTERM pgid, arm sigkill grace |
/// | `SigtermPending` | deadline fires | `SigkillPending`| SIGTERM pgid, arm sigkill grace |
/// | `SigkillPending` | deadline fires | `Done`          | SIGKILL pgid    |
/// | _any pending_    | `child.wait()` | `Done`          | (no signal)     |
///
/// `Done` is sticky: a late second `type=result` on the same run cannot
/// re-arm the deadline, and any in-flight signalling is one-shot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TerminationState {
    Idle,
    SigtermPending { reason: TerminationReason },
    SigkillPending { reason: TerminationReason },
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TerminationReason {
    PostResult,
    InitialPromptStdin,
    StuckTool,
    HeartbeatError,
    HeartbeatPanic,
}

impl TerminationReason {
    pub(super) fn label(self) -> &'static str {
        match self {
            TerminationReason::PostResult => "post-result reap",
            TerminationReason::InitialPromptStdin => "initial-prompt stdin",
            TerminationReason::StuckTool => "stuck-tool watchdog",
            TerminationReason::HeartbeatError => "heartbeat error",
            TerminationReason::HeartbeatPanic => "heartbeat panic",
        }
    }
}

impl TerminationState {
    /// True while waiting for an armed SIGTERM or SIGKILL deadline to fire;
    /// used as the select! branch's eligibility guard.
    pub(super) fn is_pending(self) -> bool {
        matches!(
            self,
            TerminationState::SigtermPending { .. } | TerminationState::SigkillPending { .. }
        )
    }

    /// Whether to arm the reap deadline on an incoming `type=result`
    /// event. Only the initial Idle -> SigtermPending transition should
    /// fire -- later events (or a result that races a CLI exit) must
    /// not re-arm. Single source of truth consumed by both the
    /// production guard in `execute_cli` and the FSM unit tests.
    pub(super) fn should_arm_post_result(self, cli_exited: bool) -> bool {
        matches!(self, TerminationState::Idle) && !cli_exited
    }
}

/// Bounded cleanup window after Claude Code emits a terminal result.
///
/// The quiet deadline extends when post-result meaningful events arrive; the
/// total cap is fixed from the initial arm time so a noisy child cannot keep the
/// sandbox alive indefinitely.
#[derive(Debug, Clone, Copy)]
pub(super) struct PostResultCleanupState {
    started_at: Instant,
    last_meaningful_event_at: Instant,
    quiet_deadline: Instant,
    total_cap_deadline: Instant,
    meaningful_event_count: u64,
    signal_sent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PostResultCleanupTimeout {
    pub(super) trigger: PostResultCleanupTrigger,
    pub(super) elapsed: Duration,
    pub(super) quiet_for: Duration,
    pub(super) meaningful_event_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PostResultCleanupTrigger {
    Quiet,
    TotalCap,
}

impl PostResultCleanupTrigger {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Quiet => "quiet_timeout",
            Self::TotalCap => "total_cap",
        }
    }
}

impl PostResultCleanupState {
    pub(super) fn arm(now: Instant, quiet: Duration, total_cap: Duration) -> Self {
        Self {
            started_at: now,
            last_meaningful_event_at: now,
            quiet_deadline: now + quiet,
            total_cap_deadline: now + total_cap,
            meaningful_event_count: 0,
            signal_sent: false,
        }
    }

    pub(super) fn next_deadline(self) -> Option<Instant> {
        if self.signal_sent {
            return None;
        }
        Some(self.quiet_deadline.min(self.total_cap_deadline))
    }

    pub(super) fn record_meaningful_event(
        &mut self,
        now: Instant,
        quiet: Duration,
    ) -> Option<Instant> {
        if self.signal_sent {
            return None;
        }
        self.last_meaningful_event_at = now;
        self.quiet_deadline = now + quiet;
        self.meaningful_event_count = self.meaningful_event_count.saturating_add(1);
        self.next_deadline()
    }

    pub(super) fn mark_signal_sent(&mut self, now: Instant) -> Option<PostResultCleanupTimeout> {
        if self.signal_sent {
            return None;
        }
        self.signal_sent = true;
        self.timeout_due(now)
    }

    pub(super) fn timeout_due(self, now: Instant) -> Option<PostResultCleanupTimeout> {
        let trigger =
            if now >= self.total_cap_deadline && self.total_cap_deadline <= self.quiet_deadline {
                PostResultCleanupTrigger::TotalCap
            } else if now >= self.quiet_deadline {
                PostResultCleanupTrigger::Quiet
            } else if now >= self.total_cap_deadline {
                PostResultCleanupTrigger::TotalCap
            } else {
                return None;
            };

        Some(PostResultCleanupTimeout {
            trigger,
            elapsed: self.elapsed(now),
            quiet_for: self.quiet_for(now),
            meaningful_event_count: self.meaningful_event_count,
        })
    }

    pub(super) fn elapsed(self, now: Instant) -> Duration {
        now.saturating_duration_since(self.started_at)
    }

    pub(super) fn quiet_for(self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_meaningful_event_at)
    }

    pub(super) fn meaningful_event_count(self) -> u64 {
        self.meaningful_event_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn termination_state_is_pending_only_between_arming_and_done() {
        assert!(!TerminationState::Idle.is_pending());
        assert!(
            TerminationState::SigtermPending {
                reason: TerminationReason::PostResult,
            }
            .is_pending()
        );
        assert!(
            TerminationState::SigkillPending {
                reason: TerminationReason::StuckTool,
            }
            .is_pending()
        );
        assert!(!TerminationState::Done.is_pending());
    }

    /// The arming guard must fire exactly once per run, on the first
    /// `type=result` event, and only when the CLI is still alive. Any
    /// later state -- or a CLI that already exited -- must be ignored
    /// (Done is sticky; SigtermPending/SigkillPending already armed).
    ///
    /// Calls `TerminationState::should_arm_post_result` directly so
    /// the test shares a single source of truth with the production
    /// `select!` branch.
    #[test]
    fn termination_state_should_arm_post_result_matches_invariant() {
        // Fire only from Idle with CLI still alive.
        assert!(TerminationState::Idle.should_arm_post_result(false));

        // CLI already exited -> no arm, even from Idle.
        assert!(!TerminationState::Idle.should_arm_post_result(true));

        // Already armed -> no re-arm.
        assert!(
            !TerminationState::SigtermPending {
                reason: TerminationReason::PostResult,
            }
            .should_arm_post_result(false)
        );
        assert!(
            !TerminationState::SigkillPending {
                reason: TerminationReason::HeartbeatError,
            }
            .should_arm_post_result(false)
        );

        // Done is sticky.
        assert!(!TerminationState::Done.should_arm_post_result(false));
    }

    #[test]
    fn post_result_cleanup_arm_uses_earliest_deadline() {
        let now = Instant::now();
        let cleanup =
            PostResultCleanupState::arm(now, Duration::from_secs(10), Duration::from_secs(3));

        assert_eq!(cleanup.next_deadline(), Some(now + Duration::from_secs(3)));
    }

    #[test]
    fn post_result_cleanup_meaningful_event_refreshes_quiet_deadline_only() {
        let now = Instant::now();
        let mut cleanup =
            PostResultCleanupState::arm(now, Duration::from_secs(2), Duration::from_secs(10));
        let event_at = now + Duration::from_secs(1);

        assert_eq!(
            cleanup.record_meaningful_event(event_at, Duration::from_secs(2)),
            Some(now + Duration::from_secs(3))
        );
        assert_eq!(cleanup.meaningful_event_count, 1);
        assert_eq!(
            cleanup.timeout_due(now + Duration::from_secs(2)),
            None,
            "old quiet deadline must not fire after a meaningful event"
        );
        assert_eq!(
            cleanup.timeout_due(now + Duration::from_secs(3)),
            Some(PostResultCleanupTimeout {
                trigger: PostResultCleanupTrigger::Quiet,
                elapsed: Duration::from_secs(3),
                quiet_for: Duration::from_secs(2),
                meaningful_event_count: 1,
            })
        );
    }

    #[test]
    fn post_result_cleanup_total_cap_is_not_refreshed_by_events() {
        let now = Instant::now();
        let mut cleanup =
            PostResultCleanupState::arm(now, Duration::from_secs(2), Duration::from_secs(3));
        let event_at = now + Duration::from_secs(2);

        assert_eq!(
            cleanup.record_meaningful_event(event_at, Duration::from_secs(2)),
            Some(now + Duration::from_secs(3))
        );
        assert_eq!(
            cleanup.timeout_due(now + Duration::from_secs(3)),
            Some(PostResultCleanupTimeout {
                trigger: PostResultCleanupTrigger::TotalCap,
                elapsed: Duration::from_secs(3),
                quiet_for: Duration::from_secs(1),
                meaningful_event_count: 1,
            })
        );
    }

    #[test]
    fn post_result_cleanup_does_not_refresh_after_signal() {
        let now = Instant::now();
        let mut cleanup =
            PostResultCleanupState::arm(now, Duration::from_secs(1), Duration::from_secs(5));

        assert_eq!(
            cleanup.mark_signal_sent(now + Duration::from_secs(1)),
            Some(PostResultCleanupTimeout {
                trigger: PostResultCleanupTrigger::Quiet,
                elapsed: Duration::from_secs(1),
                quiet_for: Duration::from_secs(1),
                meaningful_event_count: 0,
            })
        );
        assert_eq!(
            cleanup.record_meaningful_event(now + Duration::from_secs(2), Duration::from_secs(1)),
            None
        );
        assert_eq!(cleanup.next_deadline(), None);
    }

    #[test]
    fn child_exit_or_stronger_termination_parks_cleanup_driver_state() {
        let mut state = TerminationState::SigtermPending {
            reason: TerminationReason::PostResult,
        };
        assert!(state.is_pending());
        state = TerminationState::Done;
        assert!(!state.is_pending());

        let mut state = TerminationState::SigtermPending {
            reason: TerminationReason::PostResult,
        };
        assert!(state.is_pending());
        state = TerminationState::SigkillPending {
            reason: TerminationReason::HeartbeatError,
        };
        assert_eq!(
            state,
            TerminationState::SigkillPending {
                reason: TerminationReason::HeartbeatError
            }
        );
    }
}
