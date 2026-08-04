use crate::provider::{JobCandidate, RunnerPreferenceReason};
use crate::telemetry::PRE_PARK_HANDOFF_AXIOM_TARGET;

#[derive(Clone, Copy)]
pub(super) enum CandidateOutcome {
    Received,
    Retained,
    SlotOccupied,
    Expired,
    Cancelled,
    Mismatched,
    ClaimLost,
    Claimed,
}

impl CandidateOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Retained => "retained",
            Self::SlotOccupied => "slot_occupied",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
            Self::Mismatched => "mismatched",
            Self::ClaimLost => "claim_lost",
            Self::Claimed => "claimed",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum CandidateReason {
    MissingReuseKey,
    MissingHistoryGeneration,
    InactivePredecessor,
    RunnerModeChanged,
    CancellationRegistrationConflict,
    ProviderRejected,
    ProviderRunIdMismatch,
}

impl CandidateReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::MissingReuseKey => "missing_reuse_key",
            Self::MissingHistoryGeneration => "missing_history_generation",
            Self::InactivePredecessor => "inactive_predecessor",
            Self::RunnerModeChanged => "runner_mode_changed",
            Self::CancellationRegistrationConflict => "cancellation_registration_conflict",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderRunIdMismatch => "provider_run_id_mismatch",
        }
    }
}

pub(super) fn record_candidate_observation(
    candidate: &JobCandidate,
    runner_id: &str,
    heartbeat_generation: u64,
    outcome: CandidateOutcome,
    reason: Option<CandidateReason>,
) {
    if !is_selected_finalizing_candidate(candidate, runner_id, heartbeat_generation) {
        return;
    }

    let successor_run_id = candidate.run_id();
    match (candidate.history_generation_run_id(), reason) {
        (Some(predecessor_run_id), Some(reason)) => tracing::info!(
            target: PRE_PARK_HANDOFF_AXIOM_TARGET,
            measurement = "pre_park_successor_handoff",
            outcome = outcome.as_str(),
            reason = reason.as_str(),
            predecessor_run_id = %predecessor_run_id,
            successor_run_id = %successor_run_id,
            runner_id,
            heartbeat_generation,
            "pre-park successor handoff candidate observed"
        ),
        (Some(predecessor_run_id), None) => tracing::info!(
            target: PRE_PARK_HANDOFF_AXIOM_TARGET,
            measurement = "pre_park_successor_handoff",
            outcome = outcome.as_str(),
            predecessor_run_id = %predecessor_run_id,
            successor_run_id = %successor_run_id,
            runner_id,
            heartbeat_generation,
            "pre-park successor handoff candidate observed"
        ),
        (None, Some(reason)) => tracing::info!(
            target: PRE_PARK_HANDOFF_AXIOM_TARGET,
            measurement = "pre_park_successor_handoff",
            outcome = outcome.as_str(),
            reason = reason.as_str(),
            successor_run_id = %successor_run_id,
            runner_id,
            heartbeat_generation,
            "pre-park successor handoff candidate observed"
        ),
        (None, None) => tracing::info!(
            target: PRE_PARK_HANDOFF_AXIOM_TARGET,
            measurement = "pre_park_successor_handoff",
            outcome = outcome.as_str(),
            successor_run_id = %successor_run_id,
            runner_id,
            heartbeat_generation,
            "pre-park successor handoff candidate observed"
        ),
    }
}

pub(super) fn is_selected_finalizing_candidate(
    candidate: &JobCandidate,
    runner_id: &str,
    heartbeat_generation: u64,
) -> bool {
    candidate.runner_preference().is_some_and(|preference| {
        preference.reason() == RunnerPreferenceReason::FinalizingPredecessor
            && preference.targets(runner_id, heartbeat_generation)
    })
}
