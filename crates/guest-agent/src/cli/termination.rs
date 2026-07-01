//! CLI process-group termination state machine.
//!
//! `execute_cli` owns the select-loop orchestration and decides when external
//! events happen. This module owns the termination policy state transitions,
//! process-group signal side effects, diagnostics, and post-result cleanup
//! deadlines for those events.

use super::process_group::ChildProcessGroup;
use crate::error::AgentError;
use guest_common::log_warn;
use guest_common::telemetry::record_sandbox_op;
use guest_contracts::diagnostics::{
    CliTerminationDiagnostic, CliTerminationReason as DiagnosticTerminationReason,
    CliTerminationSignal,
};
use std::pin::Pin;
use std::time::Duration;
use tokio::time::{Instant, Sleep};

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Debug, Clone, Copy)]
pub(super) struct PostResultCleanupPolicy {
    sigterm_grace: Duration,
    total_cap: Duration,
    sigkill_grace: Duration,
}

impl PostResultCleanupPolicy {
    pub(super) fn new(
        sigterm_grace: Duration,
        total_cap: Duration,
        sigkill_grace: Duration,
    ) -> Self {
        Self {
            sigterm_grace,
            total_cap,
            sigkill_grace,
        }
    }
}

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
enum TerminationState {
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
    fn label(self) -> &'static str {
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
    fn is_pending(self) -> bool {
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
    fn should_arm_post_result(self, cli_exited: bool) -> bool {
        matches!(self, TerminationState::Idle) && !cli_exited
    }
}

/// Bounded cleanup window after Claude Code emits a terminal result.
///
/// The quiet deadline extends when post-result meaningful events arrive; the
/// total cap is fixed from the initial arm time so a noisy child cannot keep the
/// sandbox alive indefinitely.
#[derive(Debug, Clone, Copy)]
struct PostResultCleanupState {
    started_at: Instant,
    last_meaningful_event_at: Instant,
    quiet_deadline: Instant,
    total_cap_deadline: Instant,
    meaningful_event_count: u64,
    signal_sent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PostResultCleanupTimeout {
    trigger: PostResultCleanupTrigger,
    elapsed: Duration,
    quiet_for: Duration,
    meaningful_event_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PostResultCleanupTrigger {
    Quiet,
    TotalCap,
}

impl PostResultCleanupTrigger {
    fn label(self) -> &'static str {
        match self {
            Self::Quiet => "quiet_timeout",
            Self::TotalCap => "total_cap",
        }
    }
}

fn deadline_after(now: Instant, duration: Duration) -> Instant {
    now.checked_add(duration).unwrap_or(now)
}

impl PostResultCleanupState {
    fn arm(now: Instant, quiet: Duration, total_cap: Duration) -> Self {
        Self {
            started_at: now,
            last_meaningful_event_at: now,
            quiet_deadline: deadline_after(now, quiet),
            total_cap_deadline: deadline_after(now, total_cap),
            meaningful_event_count: 0,
            signal_sent: false,
        }
    }

    fn next_deadline(self) -> Option<Instant> {
        if self.signal_sent {
            return None;
        }
        Some(self.quiet_deadline.min(self.total_cap_deadline))
    }

    fn record_meaningful_event(&mut self, now: Instant, quiet: Duration) -> Option<Instant> {
        if self.signal_sent {
            return None;
        }
        self.last_meaningful_event_at = now;
        self.quiet_deadline = deadline_after(now, quiet);
        self.meaningful_event_count = self.meaningful_event_count.saturating_add(1);
        self.next_deadline()
    }

    fn mark_signal_sent(&mut self, now: Instant) -> Option<PostResultCleanupTimeout> {
        if self.signal_sent {
            return None;
        }
        self.signal_sent = true;
        self.timeout_due(now)
    }

    fn timeout_due(self, now: Instant) -> Option<PostResultCleanupTimeout> {
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

    fn elapsed(self, now: Instant) -> Duration {
        now.saturating_duration_since(self.started_at)
    }

    fn quiet_for(self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_meaningful_event_at)
    }

    fn meaningful_event_count(self) -> u64 {
        self.meaningful_event_count
    }
}

pub(super) enum ControlTerminationLog {
    ClaudeStdinWriterFailed { error: String },
    ClaudeStdinWriterTaskFailed { error: String },
    StuckTool { name: String, elapsed: u64 },
    HeartbeatFailed,
    HeartbeatTaskPanicked,
    HeartbeatStoppedBeforeStatus,
}

impl ControlTerminationLog {
    fn write(self, pgid: &str) {
        match self {
            Self::ClaudeStdinWriterFailed { error } => {
                log_warn!(
                    LOG_TAG,
                    "Claude stdin writer failed, SIGTERM pgid={pgid}: {error}"
                );
            }
            Self::ClaudeStdinWriterTaskFailed { error } => {
                log_warn!(
                    LOG_TAG,
                    "Claude stdin writer task failed, SIGTERM pgid={pgid}: {error}"
                );
            }
            Self::StuckTool { name, elapsed } => {
                log_warn!(
                    LOG_TAG,
                    "Tool timeout: {name} stuck for {elapsed}s, SIGTERM pgid={pgid}"
                );
            }
            Self::HeartbeatFailed => {
                log_warn!(LOG_TAG, "Heartbeat failed, SIGTERM pgid={pgid}");
            }
            Self::HeartbeatTaskPanicked => {
                log_warn!(LOG_TAG, "Heartbeat task panicked, SIGTERM pgid={pgid}");
            }
            Self::HeartbeatStoppedBeforeStatus => {
                log_warn!(
                    LOG_TAG,
                    "Heartbeat task stopped before reporting status, SIGTERM pgid={pgid}"
                );
            }
        }
    }
}

pub(super) struct CliTerminationRuntime {
    process_group: Option<ChildProcessGroup>,
    pgid: Option<i32>,
    policy: PostResultCleanupPolicy,
    state: TerminationState,
    post_result_cleanup: Option<PostResultCleanupState>,
    control_error: Option<AgentError>,
    diagnostic: Option<CliTerminationDiagnostic>,
}

impl CliTerminationRuntime {
    pub(super) fn new(
        process_group: Option<ChildProcessGroup>,
        policy: PostResultCleanupPolicy,
    ) -> Self {
        Self {
            process_group,
            pgid: process_group.map(ChildProcessGroup::raw_pgid),
            policy,
            state: TerminationState::Idle,
            post_result_cleanup: None,
            control_error: None,
            diagnostic: None,
        }
    }

    pub(super) fn can_begin_initial_prompt_stdin_control_failure(&self, cli_exited: bool) -> bool {
        matches!(self.state, TerminationState::Idle) && !cli_exited
    }

    pub(super) fn has_control_error(&self) -> bool {
        self.control_error.is_some()
    }

    pub(super) fn has_pending_deadline(&self) -> bool {
        self.state.is_pending()
    }

    pub(super) fn has_post_result_cleanup(&self) -> bool {
        self.post_result_cleanup.is_some()
    }

    pub(super) fn arm_post_result_cleanup(
        &mut self,
        cli_exited: bool,
        mut termination_deadline: Pin<&mut Sleep>,
    ) -> bool {
        if !self.state.should_arm_post_result(cli_exited) {
            return false;
        }

        let now = Instant::now();
        let cleanup =
            PostResultCleanupState::arm(now, self.policy.sigterm_grace, self.policy.total_cap);
        let Some(next_deadline) = cleanup.next_deadline() else {
            return false;
        };

        self.state = TerminationState::SigtermPending {
            reason: TerminationReason::PostResult,
        };
        termination_deadline.as_mut().reset(next_deadline);
        self.post_result_cleanup = Some(cleanup);
        true
    }

    pub(super) fn record_post_result_activity(
        &mut self,
        cleanup_was_armed_before_event: bool,
        mut termination_deadline: Pin<&mut Sleep>,
    ) {
        if !cleanup_was_armed_before_event {
            return;
        }

        if matches!(
            self.state,
            TerminationState::SigtermPending {
                reason: TerminationReason::PostResult
            }
        ) && let Some(cleanup) = self.post_result_cleanup.as_mut()
        {
            let next_deadline =
                cleanup.record_meaningful_event(Instant::now(), self.policy.sigterm_grace);
            if let Some(next_deadline) = next_deadline {
                termination_deadline.as_mut().reset(next_deadline);
            }
        }
    }

    pub(super) fn mark_child_exited(&mut self) {
        self.state = TerminationState::Done;
        self.post_result_cleanup = None;
    }

    pub(super) fn begin_control_failure(
        &mut self,
        reason: TerminationReason,
        error: AgentError,
        log: ControlTerminationLog,
        termination_deadline: Pin<&mut Sleep>,
    ) -> bool {
        if self.control_error.is_some() || matches!(self.state, TerminationState::Done) {
            return false;
        }

        let pgid = self.pgid_label();
        log.write(&pgid);
        self.begin_forced_sigkill_pending(reason, error, termination_deadline);
        true
    }

    fn pgid_label(&self) -> String {
        self.pgid
            .map_or_else(|| "unknown".to_string(), |pid| pid.to_string())
    }

    fn begin_forced_sigkill_pending(
        &mut self,
        reason: TerminationReason,
        error: AgentError,
        mut termination_deadline: Pin<&mut Sleep>,
    ) {
        let grace = self.policy.sigkill_grace;
        record_cli_termination_signal(
            &mut self.diagnostic,
            reason,
            CliTerminationSignal::Sigterm,
            self.pgid,
            grace,
        );
        if let Some(process_group) = self.process_group {
            process_group.sigterm();
        }
        self.control_error = Some(error);
        self.post_result_cleanup = None;
        self.state = TerminationState::SigkillPending { reason };
        termination_deadline
            .as_mut()
            .reset(deadline_after(Instant::now(), grace));
    }

    pub(super) fn handle_deadline(&mut self, mut termination_deadline: Pin<&mut Sleep>) {
        match self.state {
            TerminationState::SigtermPending { reason } => {
                let now = Instant::now();
                let cleanup_timeout = (reason == TerminationReason::PostResult)
                    .then(|| {
                        self.post_result_cleanup
                            .as_mut()
                            .and_then(|cleanup| cleanup.mark_signal_sent(now))
                    })
                    .flatten();
                let grace = cleanup_timeout
                    .map(|timeout| timeout.elapsed)
                    .unwrap_or(self.policy.sigterm_grace);

                if let Some(pid) = self.pgid {
                    if reason == TerminationReason::PostResult {
                        if let Some(timeout) = cleanup_timeout {
                            let trigger = timeout.trigger.label();
                            let elapsed_ms = timeout.elapsed.as_millis();
                            let quiet_ms = timeout.quiet_for.as_millis();
                            let meaningful_events = timeout.meaningful_event_count;
                            let detail = format!(
                                "trigger={trigger} signal=sigterm elapsed_ms={elapsed_ms} quiet_ms={quiet_ms} meaningful_events={meaningful_events}"
                            );
                            log_warn!(
                                LOG_TAG,
                                "Post-result cleanup {trigger} reached after {elapsed_ms}ms (quiet {quiet_ms}ms, meaningful events {meaningful_events}), SIGTERM pgid={pid}"
                            );
                            record_sandbox_op(
                                "post_result_cleanup_terminated",
                                timeout.elapsed,
                                true,
                                Some(&detail),
                            );
                        } else {
                            log_warn!(
                                LOG_TAG,
                                "Post-result cleanup deadline fired without state, SIGTERM pgid={pid}"
                            );
                        }
                    } else {
                        log_warn!(
                            LOG_TAG,
                            "CLI still running after {} sigterm grace {}ms, SIGTERM pgid={pid}",
                            reason.label(),
                            grace.as_millis()
                        );
                    }
                    record_cli_termination_signal(
                        &mut self.diagnostic,
                        reason,
                        CliTerminationSignal::Sigterm,
                        self.pgid,
                        grace,
                    );
                    if let Some(process_group) = self.process_group {
                        process_group.sigterm();
                    }
                }

                self.state = TerminationState::SigkillPending { reason };
                termination_deadline
                    .as_mut()
                    .reset(deadline_after(Instant::now(), self.policy.sigkill_grace));
            }
            TerminationState::SigkillPending { reason } => {
                let grace = self.policy.sigkill_grace;
                let now = Instant::now();
                if let Some(pid) = self.pgid {
                    log_warn!(
                        LOG_TAG,
                        "CLI did not exit after {} SIGTERM+{}ms, SIGKILL pgid={pid}",
                        reason.label(),
                        grace.as_millis()
                    );
                    if reason == TerminationReason::PostResult
                        && let Some(cleanup) = self.post_result_cleanup
                    {
                        let elapsed = cleanup.elapsed(now);
                        let quiet_ms = cleanup.quiet_for(now).as_millis();
                        let meaningful_events = cleanup.meaningful_event_count();
                        let elapsed_ms = elapsed.as_millis();
                        let detail = format!(
                            "trigger=sigkill_escalation signal=sigkill elapsed_ms={elapsed_ms} quiet_ms={quiet_ms} meaningful_events={meaningful_events}"
                        );
                        record_sandbox_op(
                            "post_result_cleanup_terminated",
                            elapsed,
                            true,
                            Some(&detail),
                        );
                    }
                    record_cli_termination_signal(
                        &mut self.diagnostic,
                        reason,
                        CliTerminationSignal::Sigkill,
                        self.pgid,
                        grace,
                    );
                    if let Some(process_group) = self.process_group {
                        process_group.sigkill();
                    }
                }
                self.post_result_cleanup = None;
                self.state = TerminationState::Done;
            }
            // Unreachable by the is_pending() guard. Log in every build so
            // any future FSM regression surfaces in production runner logs;
            // debug_assert adds a fail-fast panic under cfg(debug_assertions).
            TerminationState::Idle | TerminationState::Done => {
                log_warn!(
                    LOG_TAG,
                    "termination_deadline fired in non-pending state {:?}",
                    self.state
                );
                debug_assert!(
                    false,
                    "termination_deadline fired in non-pending state {:?}",
                    self.state
                );
            }
        }
    }

    pub(super) fn finish(
        self,
        exit_code: i32,
    ) -> (Option<AgentError>, Option<CliTerminationDiagnostic>) {
        let cli_termination = self
            .diagnostic
            .map(|diagnostic| diagnostic.with_observed_exit_code(exit_code));
        (self.control_error, cli_termination)
    }
}

fn record_cli_termination_signal(
    cli_termination: &mut Option<CliTerminationDiagnostic>,
    reason: TerminationReason,
    signal: CliTerminationSignal,
    pgid: Option<i32>,
    grace: Duration,
) {
    let diagnostic = cli_termination
        .take()
        .unwrap_or_else(|| CliTerminationDiagnostic::new(diagnostic_termination_reason(reason)));
    let grace_ms = u64::try_from(grace.as_millis()).unwrap_or(u64::MAX);
    *cli_termination = Some(diagnostic.record_signal(signal, pgid, Some(grace_ms)));
}

fn diagnostic_termination_reason(reason: TerminationReason) -> DiagnosticTerminationReason {
    match reason {
        TerminationReason::PostResult => DiagnosticTerminationReason::PostResultReap,
        TerminationReason::InitialPromptStdin => DiagnosticTerminationReason::InitialPromptStdin,
        TerminationReason::StuckTool => DiagnosticTerminationReason::StuckToolWatchdog,
        TerminationReason::HeartbeatError => DiagnosticTerminationReason::HeartbeatError,
        TerminationReason::HeartbeatPanic => DiagnosticTerminationReason::HeartbeatPanic,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};

    fn test_policy() -> PostResultCleanupPolicy {
        PostResultCleanupPolicy::new(
            Duration::from_secs(3),
            Duration::from_secs(60),
            Duration::from_secs(1),
        )
    }

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
    fn cli_termination_signal_records_initial_prompt_stdin_and_escalation() {
        let mut diagnostic = None;

        record_cli_termination_signal(
            &mut diagnostic,
            TerminationReason::InitialPromptStdin,
            CliTerminationSignal::Sigterm,
            Some(42),
            Duration::from_secs(1),
        );

        let first = diagnostic.expect("diagnostic after SIGTERM");
        assert_eq!(first.reason, CliTerminationReason::InitialPromptStdin);
        assert_eq!(first.signal_sent, Some(CliTerminationSignal::Sigterm));
        assert_eq!(first.signal_pgid, Some(42));
        assert_eq!(first.signal_grace_ms, Some(1_000));
        assert!(!first.escalated);

        let mut diagnostic = Some(first);
        record_cli_termination_signal(
            &mut diagnostic,
            TerminationReason::InitialPromptStdin,
            CliTerminationSignal::Sigkill,
            Some(42),
            Duration::from_secs(2),
        );

        let escalated = diagnostic.expect("diagnostic after SIGKILL");
        assert_eq!(escalated.reason, CliTerminationReason::InitialPromptStdin);
        assert_eq!(escalated.signal_sent, Some(CliTerminationSignal::Sigkill));
        assert_eq!(escalated.signal_pgid, Some(42));
        assert_eq!(escalated.signal_grace_ms, Some(2_000));
        assert!(escalated.escalated);
    }

    #[tokio::test]
    async fn control_failure_overrides_post_result_cleanup() {
        let deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(deadline);
        let mut runtime = CliTerminationRuntime::new(None, test_policy());

        assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
        assert!(runtime.has_post_result_cleanup());

        assert!(runtime.begin_control_failure(
            TerminationReason::HeartbeatError,
            AgentError::Execution("heartbeat failed".to_string()),
            ControlTerminationLog::HeartbeatFailed,
            deadline.as_mut(),
        ));

        let control_error = runtime
            .control_error
            .as_ref()
            .expect("control error should be stored");
        assert!(control_error.to_string().contains("heartbeat failed"));
        assert!(!runtime.has_post_result_cleanup());
        assert_eq!(
            runtime.state,
            TerminationState::SigkillPending {
                reason: TerminationReason::HeartbeatError
            }
        );
        let diagnostic = runtime.diagnostic.expect("diagnostic should be recorded");
        assert_eq!(diagnostic.reason, CliTerminationReason::HeartbeatError);
        assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigterm));
        assert_eq!(diagnostic.signal_pgid, None);
        assert!(diagnostic.signal_grace_ms.is_some());
        assert!(!diagnostic.escalated);
    }

    #[tokio::test]
    async fn second_control_failure_does_not_overwrite_first() {
        let deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(deadline);
        let mut runtime = CliTerminationRuntime::new(None, test_policy());

        assert!(runtime.begin_control_failure(
            TerminationReason::HeartbeatError,
            AgentError::Execution("first heartbeat failure".to_string()),
            ControlTerminationLog::HeartbeatFailed,
            deadline.as_mut(),
        ));
        assert!(!runtime.begin_control_failure(
            TerminationReason::StuckTool,
            AgentError::Execution("second tool failure".to_string()),
            ControlTerminationLog::StuckTool {
                name: "WebFetch".to_string(),
                elapsed: 30,
            },
            deadline.as_mut(),
        ));

        let control_error = runtime
            .control_error
            .as_ref()
            .expect("first control error should remain");
        assert!(
            control_error
                .to_string()
                .contains("first heartbeat failure")
        );
        assert_eq!(
            runtime.state,
            TerminationState::SigkillPending {
                reason: TerminationReason::HeartbeatError
            }
        );
        assert_eq!(
            runtime.diagnostic.expect("diagnostic").reason,
            CliTerminationReason::HeartbeatError
        );
    }

    #[tokio::test]
    async fn stdin_control_failure_is_only_eligible_while_idle() {
        let deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(deadline);
        let mut runtime = CliTerminationRuntime::new(None, test_policy());

        assert!(runtime.can_begin_initial_prompt_stdin_control_failure(false));
        assert!(!runtime.can_begin_initial_prompt_stdin_control_failure(true));

        assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
        assert!(!runtime.can_begin_initial_prompt_stdin_control_failure(false));

        runtime.mark_child_exited();
        assert!(!runtime.can_begin_initial_prompt_stdin_control_failure(false));
    }

    #[tokio::test]
    async fn child_exit_parks_termination_and_prevents_late_post_result_arm() {
        let deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(deadline);
        let mut runtime = CliTerminationRuntime::new(None, test_policy());

        assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
        runtime.mark_child_exited();

        assert!(!runtime.has_pending_deadline());
        assert!(!runtime.has_post_result_cleanup());
        assert!(!runtime.arm_post_result_cleanup(false, deadline.as_mut()));
        assert!(!runtime.begin_control_failure(
            TerminationReason::HeartbeatError,
            AgentError::Execution("late heartbeat failure".to_string()),
            ControlTerminationLog::HeartbeatFailed,
            deadline.as_mut(),
        ));
        assert!(runtime.control_error.is_none());
        assert!(runtime.diagnostic.is_none());
        assert_eq!(runtime.state, TerminationState::Done);
    }

    #[tokio::test]
    async fn post_result_activity_refreshes_only_for_previously_armed_cleanup() {
        let deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(deadline);
        let mut runtime = CliTerminationRuntime::new(None, test_policy());

        runtime.record_post_result_activity(false, deadline.as_mut());
        assert!(runtime.post_result_cleanup.is_none());

        assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
        runtime.record_post_result_activity(false, deadline.as_mut());
        assert_eq!(
            runtime
                .post_result_cleanup
                .expect("cleanup")
                .meaningful_event_count(),
            0
        );

        runtime.record_post_result_activity(true, deadline.as_mut());
        assert_eq!(
            runtime
                .post_result_cleanup
                .expect("cleanup")
                .meaningful_event_count(),
            1
        );
    }

    #[test]
    fn post_result_cleanup_arm_uses_earliest_deadline() {
        let now = Instant::now();
        let cleanup =
            PostResultCleanupState::arm(now, Duration::from_secs(10), Duration::from_secs(3));

        assert_eq!(cleanup.next_deadline(), Some(now + Duration::from_secs(3)));
    }

    #[test]
    fn post_result_cleanup_arm_uses_immediate_deadline_on_overflow() {
        let now = Instant::now();
        let cleanup = PostResultCleanupState::arm(now, Duration::MAX, Duration::MAX);

        assert_eq!(cleanup.next_deadline(), Some(now));
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
    fn post_result_cleanup_meaningful_event_uses_immediate_deadline_on_overflow() {
        let now = Instant::now();
        let mut cleanup =
            PostResultCleanupState::arm(now, Duration::from_secs(10), Duration::from_secs(20));
        let event_at = now + Duration::from_secs(1);

        assert_eq!(
            cleanup.record_meaningful_event(event_at, Duration::MAX),
            Some(event_at)
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
