//! CLI process-group termination state machine.
//!
//! Signal sending, deadline reset timing, and child wait ordering remain in
//! `execute_cli`; this module only owns the FSM state and guards.

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
    StuckTool,
    HeartbeatError,
    HeartbeatPanic,
}

impl TerminationReason {
    pub(super) fn label(self) -> &'static str {
        match self {
            TerminationReason::PostResult => "post-result reap",
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
}
