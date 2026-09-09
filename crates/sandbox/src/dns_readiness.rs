use std::time::{Duration, SystemTime};

/// Bounded result of one guest DNS readiness attempt, not the whole start.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxDnsReadinessOutcome {
    /// The guest resolver returned the required answer.
    Success,
    /// The host request reached its deadline without a complete result.
    Deadline,
    /// The guest control request failed without a valid result.
    Transport,
    /// The guest killed the resolver after its process deadline.
    ProcessTimeout,
    /// The guest cancelled the resolver.
    ProcessCancelled,
    /// The guest could not start the resolver.
    StartFailed,
    /// The guest could not wait for the resolver.
    WaitFailed,
    /// The resolver exited unsuccessfully.
    ExitNonZero,
    /// Resolver output exceeded its bounds or could not be fully collected.
    OutputTruncated,
    /// The resolver did not return the required answer.
    UnexpectedAnswer,
    /// The host future was dropped; elapsed time is an incomplete interval.
    HostCancelled,
}

impl SandboxDnsReadinessOutcome {
    /// Stable low-cardinality telemetry classification.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Deadline => "deadline",
            Self::Transport => "transport",
            Self::ProcessTimeout => "process_timeout",
            Self::ProcessCancelled => "process_cancelled",
            Self::StartFailed => "start_failed",
            Self::WaitFailed => "wait_failed",
            Self::ExitNonZero => "exit_nonzero",
            Self::OutputTruncated => "output_truncated",
            Self::UnexpectedAnswer => "unexpected_answer",
            Self::HostCancelled => "host_cancelled",
        }
    }
}

/// One attempt nested inside the authoritative guest DNS readiness start stage.
///
/// Host and guest elapsed durations are measured locally in their respective
/// processes. Guest time includes resolver setup, execution and cleanup, not
/// just DNS network latency. Completion wall time is only for event placement;
/// it must never be subtracted from a guest timestamp to derive elapsed time.
#[derive(Clone, Copy, Debug)]
pub struct SandboxDnsReadinessAttempt {
    /// One-based ordinal within this readiness invocation, bounded to three.
    /// A replacement sandbox starts its own sequence at one.
    pub attempt: u16,
    /// Whether this invocation ends after this attempt, including cancellation.
    pub final_attempt: bool,
    /// Host request/response and validation interval; incomplete on host cancellation.
    pub duration: Duration,
    /// Existing guest-reported helper lifecycle duration, absent without a valid result.
    pub guest_duration_ms: Option<u32>,
    /// Bounded validation or operation outcome.
    pub outcome: SandboxDnsReadinessOutcome,
    /// Host completion time, captured before any buffered observer replay.
    pub completed_at: SystemTime,
}
