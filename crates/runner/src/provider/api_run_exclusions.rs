//! Bounded runner-local exclusions for API-backed job admission.
//!
//! [`ApiProvider`](super::api::ApiProvider) owns the claim-to-rediscovery
//! lifecycle. This module stores ephemeral per-run reason deadlines plus an
//! optional provider-wide deadline used only when claim-failure capacity is
//! saturated. It owns no timer or wakeup; the provider routes release deadlines
//! through [`PollWakeups`](super::api_ably_supervisor::PollWakeups).
//!
//! Claim failures renew their relative deadline. Candidate affinity is derived
//! from an absolute wire deadline, so duplicate observations retain the earlier
//! deadline and never extend protection. A run stays excluded until every active
//! reason expires. Capacity counts unique run IDs, matching the poll contract.

use std::collections::BTreeMap;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::Instant;

use super::CandidateExclusionReason;
use crate::ids::RunId;

pub(super) enum RunExclusionRecord {
    Recorded { active_count: usize },
    AtCapacity { active_count: usize },
}

pub(super) struct RunExclusionSnapshot {
    pub(super) run_ids: Vec<RunId>,
    pub(super) next_release_after: Option<Duration>,
    pub(super) block_all_remaining: Option<Duration>,
}

pub(super) struct RunExclusions {
    capacity: usize,
    state: Mutex<RunExclusionState>,
}

struct RunExclusionState {
    deadlines: BTreeMap<RunId, BTreeMap<RunExclusionReason, Instant>>,
    global_deadline: Option<Instant>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum RunExclusionReason {
    ClaimFailure,
    Candidate(CandidateExclusionReason),
}

#[derive(Clone, Copy)]
enum DeadlinePolicy {
    Renew,
    KeepEarlier,
}

impl RunExclusions {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(RunExclusionState {
                deadlines: BTreeMap::new(),
                global_deadline: None,
            }),
        }
    }

    pub(super) async fn record_claim_failure(
        &self,
        run_id: RunId,
        duration: Duration,
    ) -> RunExclusionRecord {
        self.record(
            run_id,
            RunExclusionReason::ClaimFailure,
            duration,
            DeadlinePolicy::Renew,
        )
        .await
    }

    pub(super) async fn record_candidate(
        &self,
        run_id: RunId,
        reason: CandidateExclusionReason,
        duration: Duration,
    ) -> RunExclusionRecord {
        self.record(
            run_id,
            RunExclusionReason::Candidate(reason),
            duration,
            DeadlinePolicy::KeepEarlier,
        )
        .await
    }

    async fn record(
        &self,
        run_id: RunId,
        reason: RunExclusionReason,
        duration: Duration,
        policy: DeadlinePolicy,
    ) -> RunExclusionRecord {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);

        let deadline = now + duration;
        if let Some(reasons) = state.deadlines.get_mut(&run_id) {
            record_deadline(reasons, reason, deadline, policy);
            return RunExclusionRecord::Recorded {
                active_count: state.deadlines.len(),
            };
        }

        if state.deadlines.len() >= self.capacity {
            return RunExclusionRecord::AtCapacity {
                active_count: state.deadlines.len(),
            };
        }

        state
            .deadlines
            .insert(run_id, BTreeMap::from([(reason, deadline)]));
        RunExclusionRecord::Recorded {
            active_count: state.deadlines.len(),
        }
    }

    pub(super) async fn block_all(&self, duration: Duration) {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);
        state.global_deadline = Some(now + duration);
    }

    pub(super) async fn remaining(&self, run_id: RunId) -> Option<Duration> {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);
        state
            .global_deadline
            .or_else(|| {
                state
                    .deadlines
                    .get(&run_id)
                    .and_then(effective_release_deadline)
            })
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    pub(super) async fn snapshot(&self) -> RunExclusionSnapshot {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);
        RunExclusionSnapshot {
            run_ids: state.deadlines.keys().copied().collect(),
            next_release_after: state
                .deadlines
                .values()
                .filter_map(effective_release_deadline)
                .min()
                .map(|deadline| deadline.saturating_duration_since(now)),
            block_all_remaining: state
                .global_deadline
                .map(|deadline| deadline.saturating_duration_since(now)),
        }
    }

    pub(super) async fn remove_claim_failure(&self, run_id: RunId) {
        let mut state = self.state.lock().await;
        let should_remove = state.deadlines.get_mut(&run_id).is_some_and(|reasons| {
            reasons.remove(&RunExclusionReason::ClaimFailure);
            reasons.is_empty()
        });
        if should_remove {
            state.deadlines.remove(&run_id);
        }
    }
}

fn record_deadline(
    reasons: &mut BTreeMap<RunExclusionReason, Instant>,
    reason: RunExclusionReason,
    deadline: Instant,
    policy: DeadlinePolicy,
) {
    match (reasons.get_mut(&reason), policy) {
        (Some(existing), DeadlinePolicy::Renew) => *existing = deadline,
        (Some(existing), DeadlinePolicy::KeepEarlier) => *existing = (*existing).min(deadline),
        (None, _) => {
            reasons.insert(reason, deadline);
        }
    }
}

fn effective_release_deadline(reasons: &BTreeMap<RunExclusionReason, Instant>) -> Option<Instant> {
    reasons.values().copied().max()
}

fn prune_expired(state: &mut RunExclusionState, now: Instant) {
    state.deadlines.retain(|_, reasons| {
        reasons.retain(|_, deadline| *deadline > now);
        !reasons.is_empty()
    });
    if state
        .global_deadline
        .is_some_and(|deadline| deadline <= now)
    {
        state.global_deadline = None;
    }
}
