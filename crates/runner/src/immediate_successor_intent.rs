//! Retained observation state for advisory immediate-successor signals.
//!
//! This registry is deliberately separate from active-run and idle-pool state.
//! It records timing only and cannot authorize claims or sandbox transitions.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::ids::RunId;
use crate::provider::RunnerProcessIdentity;
use crate::telemetry::SandboxOpRecord;

pub(crate) const IMMEDIATE_SUCCESSOR_INTENT_EVENT_NAME: &str = "immediate-successor-intent";
const DEFAULT_CAPACITY: usize = 1024;
// Finalization can include a workspace-image copy with a five-minute timeout.
// Keep expired observations long enough to correlate that bounded slow path;
// the fixed registry capacity remains the hard memory bound.
const EXPIRED_OBSERVATION_RETENTION: Duration = Duration::from_secs(10 * 60);
const MAX_INTENT_RETENTION: Duration = Duration::from_millis(1500);
const MAX_SIGNAL_TIMESTAMP_SPAN: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ImmediateSuccessorIntentAction {
    Arm,
    Revoke,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ImmediateSuccessorEventClass {
    Prompt,
    Goal,
    Automation,
}

impl ImmediateSuccessorEventClass {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Goal => "goal",
            Self::Automation => "automation",
        }
    }

    pub(crate) const fn action_type(self) -> &'static str {
        match self {
            Self::Prompt => "runner_immediate_successor_event_prompt",
            Self::Goal => "runner_immediate_successor_event_goal",
            Self::Automation => "runner_immediate_successor_event_automation",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImmediateSuccessorIntentNotification {
    pub(crate) action: ImmediateSuccessorIntentAction,
    pub(crate) predecessor_run_id: RunId,
    pub(crate) intent_id: Uuid,
    pub(crate) runner_identity: RunnerProcessIdentity,
    pub(crate) event_class: ImmediateSuccessorEventClass,
    pub(crate) decided_at: DateTime<FixedOffset>,
    pub(crate) expires_at: DateTime<FixedOffset>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImmediateSuccessorReceiveOutcome {
    Armed,
    Duplicate,
    Revoked,
    Expired,
    WrongTarget,
    Overflow,
    Invalid,
}

impl ImmediateSuccessorReceiveOutcome {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Armed => "armed",
            Self::Duplicate => "duplicate",
            Self::Revoked => "revoked",
            Self::Expired => "expired",
            Self::WrongTarget => "wrong_target",
            Self::Overflow => "overflow",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct IntentKey {
    predecessor_run_id: RunId,
    intent_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImmediateSuccessorFinalizationStage {
    ReusePreparation,
    PhysicalPark,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImmediateSuccessorReceiptPhase {
    Unknown,
    BeforeFinalization,
    BeforePreparation,
    DuringPreparation,
    BeforePark,
    DuringPark,
    BeforePublication,
    AfterPublication,
}

impl ImmediateSuccessorReceiptPhase {
    pub(crate) const fn action_type(self) -> &'static str {
        match self {
            Self::Unknown => "runner_immediate_successor_received_phase_unknown",
            Self::BeforeFinalization => "runner_immediate_successor_received_before_finalization",
            Self::BeforePreparation => "runner_immediate_successor_received_before_preparation",
            Self::DuringPreparation => "runner_immediate_successor_received_during_preparation",
            Self::BeforePark => "runner_immediate_successor_received_before_park",
            Self::DuringPark => "runner_immediate_successor_received_during_park",
            Self::BeforePublication => "runner_immediate_successor_received_before_publication",
            Self::AfterPublication => "runner_immediate_successor_received_after_publication",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImmediateSuccessorObservationState {
    Armed,
    Revoked,
    Expired,
    Missing,
}

struct IntentEntry {
    event_class: ImmediateSuccessorEventClass,
    received_at: Instant,
    deadline: Instant,
    decision_to_receipt: Option<Duration>,
    revoked_at: Option<Instant>,
    expired_on_receipt: bool,
}

struct FinalizationTimeline {
    finalization_started_at: Option<Instant>,
    preparation_started_at: Option<Instant>,
    preparation_completed_at: Option<Instant>,
    preparation_succeeded: Option<bool>,
    park_started_at: Option<Instant>,
    park_completed_at: Option<Instant>,
    park_succeeded: Option<bool>,
    idle_published_at: Option<Instant>,
    last_updated_at: Instant,
}

impl FinalizationTimeline {
    fn new(at: Instant) -> Self {
        Self {
            finalization_started_at: None,
            preparation_started_at: None,
            preparation_completed_at: None,
            preparation_succeeded: None,
            park_started_at: None,
            park_completed_at: None,
            park_succeeded: None,
            idle_published_at: None,
            last_updated_at: at,
        }
    }
}

#[derive(Default)]
struct RegistryState {
    entries: HashMap<IntentKey, IntentEntry>,
    finalizations: HashMap<RunId, FinalizationTimeline>,
}

#[derive(Clone)]
pub(crate) struct ImmediateSuccessorIntents {
    state: Arc<Mutex<RegistryState>>,
    capacity: usize,
}

impl Default for ImmediateSuccessorIntents {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl ImmediateSuccessorIntents {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(
            capacity > 0,
            "immediate successor registry capacity must be positive"
        );
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            capacity,
        }
    }

    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub(crate) fn receive(
        &self,
        notification: ImmediateSuccessorIntentNotification,
        runner_id: &str,
        heartbeat_generation: u64,
    ) -> ImmediateSuccessorReceiveOutcome {
        self.receive_at(
            notification,
            runner_id,
            heartbeat_generation,
            Instant::now(),
            Utc::now(),
        )
    }

    fn receive_at(
        &self,
        notification: ImmediateSuccessorIntentNotification,
        runner_id: &str,
        heartbeat_generation: u64,
        received_at: Instant,
        received_wall_time: DateTime<Utc>,
    ) -> ImmediateSuccessorReceiveOutcome {
        if !notification
            .runner_identity
            .targets(runner_id, heartbeat_generation)
        {
            return ImmediateSuccessorReceiveOutcome::WrongTarget;
        }
        let signal_lifetime = (notification.expires_at - notification.decided_at).to_std();
        if !signal_lifetime
            .is_ok_and(|lifetime| !lifetime.is_zero() && lifetime <= MAX_SIGNAL_TIMESTAMP_SPAN)
        {
            return ImmediateSuccessorReceiveOutcome::Invalid;
        }
        let remaining = (notification.expires_at.with_timezone(&Utc) - received_wall_time)
            .to_std()
            .unwrap_or_default()
            .min(MAX_INTENT_RETENTION);
        let expired_on_receipt = remaining.is_zero();
        let Some(deadline) = received_at.checked_add(remaining) else {
            return ImmediateSuccessorReceiveOutcome::Invalid;
        };
        let decision_to_receipt = (received_wall_time
            - notification.decided_at.with_timezone(&Utc))
        .to_std()
        .ok()
        .filter(|duration| *duration <= MAX_SIGNAL_TIMESTAMP_SPAN);
        let key = IntentKey {
            predecessor_run_id: notification.predecessor_run_id,
            intent_id: notification.intent_id,
        };
        let mut state = self.lock();
        prune_stale_entries(&mut state, received_at);

        if let Some(entry) = state.entries.get_mut(&key) {
            if entry.deadline <= received_at {
                return ImmediateSuccessorReceiveOutcome::Expired;
            }
            if notification.action == ImmediateSuccessorIntentAction::Revoke {
                entry.revoked_at.get_or_insert(received_at);
                return ImmediateSuccessorReceiveOutcome::Revoked;
            }
            return if entry.revoked_at.is_some() {
                ImmediateSuccessorReceiveOutcome::Revoked
            } else {
                ImmediateSuccessorReceiveOutcome::Duplicate
            };
        }

        if state.entries.len() >= self.capacity {
            prune_expired_entries(&mut state, received_at);
        }
        if state.entries.len() >= self.capacity {
            return ImmediateSuccessorReceiveOutcome::Overflow;
        }

        let revoked_at =
            (notification.action == ImmediateSuccessorIntentAction::Revoke).then_some(received_at);
        state.entries.insert(
            key,
            IntentEntry {
                event_class: notification.event_class,
                received_at,
                deadline,
                decision_to_receipt,
                revoked_at,
                expired_on_receipt,
            },
        );
        if expired_on_receipt {
            ImmediateSuccessorReceiveOutcome::Expired
        } else if revoked_at.is_some() {
            ImmediateSuccessorReceiveOutcome::Revoked
        } else {
            ImmediateSuccessorReceiveOutcome::Armed
        }
    }

    pub(crate) fn record_finalization_started(&self, run_id: RunId, at: Instant) {
        let mut state = self.lock();
        prune_stale_entries(&mut state, at);
        if !state.finalizations.contains_key(&run_id) && state.finalizations.len() >= self.capacity
        {
            return;
        }
        let timeline = state
            .finalizations
            .entry(run_id)
            .or_insert_with(|| FinalizationTimeline::new(at));
        timeline.finalization_started_at.get_or_insert(at);
        timeline.last_updated_at = at;
    }

    pub(crate) fn record_finalization_stage(
        &self,
        run_id: RunId,
        stage: ImmediateSuccessorFinalizationStage,
        started_at: Instant,
        completed_at: Instant,
        success: bool,
    ) {
        let mut state = self.lock();
        prune_stale_entries(&mut state, completed_at);
        if !state.finalizations.contains_key(&run_id) && state.finalizations.len() >= self.capacity
        {
            return;
        }
        let timeline = state
            .finalizations
            .entry(run_id)
            .or_insert_with(|| FinalizationTimeline::new(completed_at));
        match stage {
            ImmediateSuccessorFinalizationStage::ReusePreparation => {
                timeline.preparation_started_at.get_or_insert(started_at);
                timeline.preparation_completed_at = Some(completed_at);
                timeline.preparation_succeeded = Some(success);
            }
            ImmediateSuccessorFinalizationStage::PhysicalPark => {
                timeline.park_started_at.get_or_insert(started_at);
                timeline.park_completed_at = Some(completed_at);
                timeline.park_succeeded = Some(success);
            }
        }
        timeline.last_updated_at = completed_at;
    }

    pub(crate) fn record_idle_publication(&self, run_id: RunId, at: Instant) {
        let mut state = self.lock();
        prune_stale_entries(&mut state, at);
        if !state.finalizations.contains_key(&run_id) && state.finalizations.len() >= self.capacity
        {
            return;
        }
        let timeline = state
            .finalizations
            .entry(run_id)
            .or_insert_with(|| FinalizationTimeline::new(at));
        timeline.idle_published_at = Some(at);
        timeline.last_updated_at = at;
    }

    pub(crate) fn observe_claim(
        &self,
        predecessor_run_id: Option<RunId>,
        claimed_at: Instant,
    ) -> Option<ImmediateSuccessorIntentObservation> {
        Some(ImmediateSuccessorIntentObservation {
            registry: self.clone(),
            predecessor_run_id: predecessor_run_id?,
            claimed_at,
        })
    }

    fn claim_snapshot(
        &self,
        predecessor_run_id: RunId,
        claimed_at: Instant,
    ) -> ImmediateSuccessorIntentSnapshot {
        let now = Instant::now();
        let mut state = self.lock();
        prune_stale_entries(&mut state, now);
        // Intent IDs distinguish competing arm/revoke pairs only. A claim's
        // existing history generation identifies the predecessor, so correlate
        // it with the best retained candidate instead of extending job state.
        let entry = state
            .entries
            .iter()
            .filter_map(|(key, entry)| {
                (key.predecessor_run_id == predecessor_run_id).then_some(entry)
            })
            .max_by_key(|entry| claim_entry_rank(entry, claimed_at));
        let Some(entry) = entry else {
            return ImmediateSuccessorIntentSnapshot::missing();
        };
        let timeline = state.finalizations.get(&predecessor_run_id);
        snapshot_entry(entry, timeline, Some(claimed_at))
    }

    pub(crate) fn snapshots_for_predecessor(
        &self,
        predecessor_run_id: RunId,
        observed_at: Instant,
    ) -> Vec<ImmediateSuccessorIntentSnapshot> {
        let mut state = self.lock();
        prune_stale_entries(&mut state, observed_at);
        let timeline = state.finalizations.get(&predecessor_run_id);
        state
            .entries
            .iter()
            .filter(|(key, _)| key.predecessor_run_id == predecessor_run_id)
            .map(|(_, entry)| snapshot_entry(entry, timeline, None))
            .collect()
    }

    pub(crate) async fn settled_receipt_records(
        self,
        predecessor_run_id: RunId,
    ) -> Vec<SandboxOpRecord> {
        // Finalization can finish before the detached API lookup and Ably
        // publish. Keep completion non-blocking while retaining late receipt
        // evidence even when a different runner eventually claims the job.
        tokio::time::sleep(MAX_INTENT_RETENTION).await;
        self.snapshots_for_predecessor(predecessor_run_id, Instant::now())
            .into_iter()
            .flat_map(ImmediateSuccessorIntentSnapshot::receipt_records)
            .collect()
    }
}

fn observation_state(
    entry: &IntentEntry,
    claimed_at: Option<Instant>,
) -> ImmediateSuccessorObservationState {
    if entry.expired_on_receipt {
        ImmediateSuccessorObservationState::Expired
    } else if entry.revoked_at.is_some() {
        ImmediateSuccessorObservationState::Revoked
    } else if claimed_at.is_some_and(|claimed_at| entry.deadline <= claimed_at) {
        ImmediateSuccessorObservationState::Expired
    } else {
        ImmediateSuccessorObservationState::Armed
    }
}

fn claim_entry_rank(entry: &IntentEntry, claimed_at: Instant) -> (u8, bool, Reverse<Duration>) {
    let state_rank = match observation_state(entry, Some(claimed_at)) {
        ImmediateSuccessorObservationState::Armed => 3,
        ImmediateSuccessorObservationState::Expired => 2,
        ImmediateSuccessorObservationState::Revoked => 1,
        ImmediateSuccessorObservationState::Missing => 0,
    };
    let received_before_claim = entry.received_at <= claimed_at;
    let distance = if received_before_claim {
        claimed_at.duration_since(entry.received_at)
    } else {
        entry.received_at.duration_since(claimed_at)
    };
    (state_rank, received_before_claim, Reverse(distance))
}

fn snapshot_entry(
    entry: &IntentEntry,
    timeline: Option<&FinalizationTimeline>,
    claimed_at: Option<Instant>,
) -> ImmediateSuccessorIntentSnapshot {
    let observation_state = observation_state(entry, claimed_at);
    let predicted_park_saved = claimed_at.and_then(|claimed_at| {
        timeline.and_then(|timeline| {
            if timeline.park_succeeded != Some(true) {
                return None;
            }
            match (timeline.park_started_at, timeline.park_completed_at) {
                (Some(started), Some(completed)) if claimed_at <= started => {
                    Some(completed.saturating_duration_since(started))
                }
                (_, Some(completed)) if claimed_at < completed => {
                    Some(completed.saturating_duration_since(claimed_at))
                }
                (_, Some(_)) => Some(Duration::ZERO),
                _ => None,
            }
        })
    });
    let predicted_prepared_hold = timeline.and_then(|timeline| {
        if timeline.preparation_succeeded != Some(true) {
            return None;
        }
        timeline.preparation_completed_at.map(|prepared_at| {
            claimed_at
                .into_iter()
                .chain(entry.revoked_at)
                .min()
                .unwrap_or(entry.deadline)
                .min(entry.deadline)
                .saturating_duration_since(prepared_at)
        })
    });
    ImmediateSuccessorIntentSnapshot {
        state: observation_state,
        event_class: Some(entry.event_class),
        receipt_phase: Some(receipt_phase(entry, timeline)),
        decision_to_receipt: entry.decision_to_receipt,
        receipt_to_claim: claimed_at.and_then(|claimed_at| {
            (claimed_at >= entry.received_at).then(|| claimed_at.duration_since(entry.received_at))
        }),
        claim_before_receipt: claimed_at.is_some_and(|claimed_at| claimed_at < entry.received_at),
        remaining_at_receipt: Some(entry.deadline.saturating_duration_since(entry.received_at)),
        predicted_park_saved,
        predicted_prepared_hold,
    }
}

fn prune_stale_entries(state: &mut RegistryState, now: Instant) {
    state.entries.retain(|_, entry| {
        now.saturating_duration_since(entry.deadline) <= EXPIRED_OBSERVATION_RETENTION
    });
    state.finalizations.retain(|_, timeline| {
        now.saturating_duration_since(timeline.last_updated_at) <= EXPIRED_OBSERVATION_RETENTION
    });
}

fn prune_expired_entries(state: &mut RegistryState, now: Instant) {
    state.entries.retain(|_, entry| entry.deadline > now);
}

fn receipt_phase(
    entry: &IntentEntry,
    timeline: Option<&FinalizationTimeline>,
) -> ImmediateSuccessorReceiptPhase {
    let Some(timeline) = timeline else {
        return ImmediateSuccessorReceiptPhase::Unknown;
    };
    let Some(finalization_started_at) = timeline.finalization_started_at else {
        return ImmediateSuccessorReceiptPhase::Unknown;
    };
    if entry.received_at <= finalization_started_at {
        return ImmediateSuccessorReceiptPhase::BeforeFinalization;
    }
    let Some(preparation_started_at) = timeline.preparation_started_at else {
        return ImmediateSuccessorReceiptPhase::BeforePreparation;
    };
    if entry.received_at < preparation_started_at {
        return ImmediateSuccessorReceiptPhase::BeforePreparation;
    }
    if timeline
        .preparation_completed_at
        .is_none_or(|completed| entry.received_at < completed)
    {
        return ImmediateSuccessorReceiptPhase::DuringPreparation;
    }
    let Some(park_started_at) = timeline.park_started_at else {
        return ImmediateSuccessorReceiptPhase::BeforePark;
    };
    if entry.received_at < park_started_at {
        return ImmediateSuccessorReceiptPhase::BeforePark;
    }
    if timeline
        .park_completed_at
        .is_none_or(|completed| entry.received_at < completed)
    {
        return ImmediateSuccessorReceiptPhase::DuringPark;
    }
    if timeline
        .idle_published_at
        .is_none_or(|published| entry.received_at < published)
    {
        ImmediateSuccessorReceiptPhase::BeforePublication
    } else {
        ImmediateSuccessorReceiptPhase::AfterPublication
    }
}

#[derive(Clone)]
pub(crate) struct ImmediateSuccessorIntentObservation {
    registry: ImmediateSuccessorIntents,
    predecessor_run_id: RunId,
    claimed_at: Instant,
}

impl ImmediateSuccessorIntentObservation {
    pub(crate) fn snapshot(&self) -> ImmediateSuccessorIntentSnapshot {
        self.registry
            .claim_snapshot(self.predecessor_run_id, self.claimed_at)
    }

    pub(crate) async fn settled_claim_records(self, idle_unpark: Duration) -> Vec<SandboxOpRecord> {
        // A job can be claimed before the detached API lookup and Ably publish
        // finish. Wait out the complete advisory window before declaring that
        // an intent was missing; this does not delay claim or execution.
        tokio::time::sleep(MAX_INTENT_RETENTION).await;
        self.snapshot().claim_records(idle_unpark)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ImmediateSuccessorIntentSnapshot {
    pub(crate) state: ImmediateSuccessorObservationState,
    pub(crate) event_class: Option<ImmediateSuccessorEventClass>,
    pub(crate) receipt_phase: Option<ImmediateSuccessorReceiptPhase>,
    pub(crate) decision_to_receipt: Option<Duration>,
    pub(crate) receipt_to_claim: Option<Duration>,
    pub(crate) claim_before_receipt: bool,
    pub(crate) remaining_at_receipt: Option<Duration>,
    pub(crate) predicted_park_saved: Option<Duration>,
    pub(crate) predicted_prepared_hold: Option<Duration>,
}

impl ImmediateSuccessorIntentSnapshot {
    fn missing() -> Self {
        Self {
            state: ImmediateSuccessorObservationState::Missing,
            event_class: None,
            receipt_phase: None,
            decision_to_receipt: None,
            receipt_to_claim: None,
            claim_before_receipt: false,
            remaining_at_receipt: None,
            predicted_park_saved: None,
            predicted_prepared_hold: None,
        }
    }

    fn push_common_records(self, records: &mut Vec<SandboxOpRecord>) {
        if let Some(event_class) = self.event_class {
            records.push(SandboxOpRecord::new(
                event_class.action_type(),
                Duration::ZERO,
                true,
                None,
            ));
        }
        if let Some(receipt_phase) = self.receipt_phase {
            records.push(SandboxOpRecord::new(
                receipt_phase.action_type(),
                Duration::ZERO,
                true,
                None,
            ));
        }
        if let Some(duration) = self.decision_to_receipt {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_decision_to_receipt",
                duration,
                true,
                None,
            ));
        }
        if let Some(duration) = self.remaining_at_receipt {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_deadline_remaining_at_receipt",
                duration,
                true,
                None,
            ));
        }
    }

    fn receipt_records(self) -> Vec<SandboxOpRecord> {
        let (action_type, success, error) = match self.state {
            ImmediateSuccessorObservationState::Armed => {
                ("runner_immediate_successor_intent_received", true, None)
            }
            ImmediateSuccessorObservationState::Revoked => (
                "runner_immediate_successor_intent_receipt_revoked",
                false,
                Some("revoked"),
            ),
            ImmediateSuccessorObservationState::Expired => (
                "runner_immediate_successor_intent_receipt_expired",
                false,
                Some("expired"),
            ),
            ImmediateSuccessorObservationState::Missing => return Vec::new(),
        };
        let mut records = vec![SandboxOpRecord::new(
            action_type,
            Duration::ZERO,
            success,
            error,
        )];
        self.push_common_records(&mut records);
        if let Some(duration) = self.predicted_prepared_hold {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_predicted_prepared_hold",
                duration,
                true,
                None,
            ));
        }
        records
    }

    pub(crate) fn claim_records(self, idle_unpark: Duration) -> Vec<SandboxOpRecord> {
        let (action_type, success, error) = match self.state {
            ImmediateSuccessorObservationState::Armed => {
                ("runner_immediate_successor_intent_matched", true, None)
            }
            ImmediateSuccessorObservationState::Revoked => (
                "runner_immediate_successor_intent_revoked",
                false,
                Some("revoked"),
            ),
            ImmediateSuccessorObservationState::Expired => (
                "runner_immediate_successor_intent_expired",
                false,
                Some("expired"),
            ),
            ImmediateSuccessorObservationState::Missing => (
                "runner_immediate_successor_intent_missing",
                false,
                Some("missing"),
            ),
        };
        let mut records = vec![SandboxOpRecord::new(
            action_type,
            Duration::ZERO,
            success,
            error,
        )];
        self.push_common_records(&mut records);
        if let Some(duration) = self.receipt_to_claim {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_receipt_to_claim",
                duration,
                true,
                None,
            ));
        }
        if self.claim_before_receipt {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_claim_before_receipt",
                Duration::ZERO,
                true,
                None,
            ));
        }
        if let Some(park_saved) = self.predicted_park_saved {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_predicted_saved",
                park_saved.saturating_add(idle_unpark),
                true,
                None,
            ));
        }
        if let Some(duration) = self.predicted_prepared_hold {
            records.push(SandboxOpRecord::new(
                "runner_immediate_successor_predicted_prepared_hold",
                duration,
                true,
                None,
            ));
        }
        records
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNER_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const GENERATION: u64 = 7;

    fn notification(
        action: ImmediateSuccessorIntentAction,
        predecessor_run_id: RunId,
        intent_id: Uuid,
        decided_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> ImmediateSuccessorIntentNotification {
        serde_json::from_value(serde_json::json!({
            "action": match action {
                ImmediateSuccessorIntentAction::Arm => "arm",
                ImmediateSuccessorIntentAction::Revoke => "revoke",
            },
            "predecessorRunId": predecessor_run_id,
            "intentId": intent_id,
            "runnerIdentity": {
                "runnerId": RUNNER_ID,
                "heartbeatGeneration": GENERATION,
            },
            "eventClass": "goal",
            "decidedAt": decided_at.to_rfc3339(),
            "expiresAt": expires_at.to_rfc3339(),
        }))
        .unwrap()
    }

    #[test]
    fn revoke_before_arm_remains_revoked() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let received = Instant::now();
        let revoke = notification(
            ImmediateSuccessorIntentAction::Revoke,
            predecessor,
            intent_id,
            wall,
            wall + chrono::Duration::seconds(1),
        );
        assert_eq!(
            registry.receive_at(revoke, RUNNER_ID, GENERATION, received, wall),
            ImmediateSuccessorReceiveOutcome::Revoked
        );
        let arm = notification(
            ImmediateSuccessorIntentAction::Arm,
            predecessor,
            intent_id,
            wall,
            wall + chrono::Duration::seconds(1),
        );
        assert_eq!(
            registry.receive_at(arm, RUNNER_ID, GENERATION, received, wall),
            ImmediateSuccessorReceiveOutcome::Revoked
        );
        let snapshot = registry
            .observe_claim(Some(predecessor), received)
            .unwrap()
            .snapshot();
        assert_eq!(snapshot.state, ImmediateSuccessorObservationState::Revoked);
    }

    #[test]
    fn claim_matches_an_active_candidate_after_another_candidate_is_revoked() {
        let registry = ImmediateSuccessorIntents::new(4);
        let predecessor = RunId::new_v4();
        let revoked_intent = Uuid::new_v4();
        let active_intent = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();

        for (offset_ms, action, intent_id) in [
            (0, ImmediateSuccessorIntentAction::Arm, revoked_intent),
            (5, ImmediateSuccessorIntentAction::Arm, active_intent),
            (10, ImmediateSuccessorIntentAction::Revoke, revoked_intent),
        ] {
            registry.receive_at(
                notification(
                    action,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base + Duration::from_millis(offset_ms),
                wall,
            );
        }

        let snapshot = registry
            .observe_claim(Some(predecessor), base + Duration::from_millis(20))
            .unwrap()
            .snapshot();
        assert_eq!(snapshot.state, ImmediateSuccessorObservationState::Armed);
        assert_eq!(snapshot.receipt_to_claim, Some(Duration::from_millis(15)));
    }

    #[test]
    fn claim_before_arm_matches_after_signal_receipt() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        let observation = registry.observe_claim(Some(predecessor), base).unwrap();

        assert_eq!(
            observation.snapshot().state,
            ImmediateSuccessorObservationState::Missing
        );
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base + Duration::from_millis(10),
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );

        let snapshot = observation.snapshot();
        assert_eq!(snapshot.state, ImmediateSuccessorObservationState::Armed);
        assert_eq!(
            snapshot.receipt_phase,
            Some(ImmediateSuccessorReceiptPhase::Unknown)
        );
        assert!(snapshot.claim_before_receipt);
        assert_eq!(snapshot.receipt_to_claim, None);
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_claim_outcome_waits_for_arm_before_reporting_missing() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        let observation = registry.observe_claim(Some(predecessor), base).unwrap();
        let report = tokio::spawn(observation.settled_claim_records(Duration::from_millis(7)));
        tokio::task::yield_now().await;

        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base + Duration::from_millis(10),
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        tokio::time::advance(MAX_INTENT_RETENTION).await;

        let records = report.await.unwrap();
        let action_types = records
            .iter()
            .map(|record| record.action_type)
            .collect::<Vec<_>>();
        assert!(action_types.contains(&"runner_immediate_successor_intent_matched"));
        assert!(action_types.contains(&"runner_immediate_successor_claim_before_receipt"));
        assert!(!action_types.contains(&"runner_immediate_successor_intent_missing"));
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_claim_outcome_reports_mixed_version_signal_absence() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let observation = registry
            .observe_claim(Some(predecessor), Instant::now())
            .unwrap();

        let report = tokio::spawn(observation.settled_claim_records(Duration::ZERO));
        tokio::task::yield_now().await;
        tokio::time::advance(MAX_INTENT_RETENTION).await;

        let records = report.await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].action_type,
            "runner_immediate_successor_intent_missing"
        );
        assert!(!records[0].success);
        assert_eq!(records[0].error, Some("missing"));
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_receipt_outcome_retains_signal_after_idle_publication() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        registry.record_finalization_started(predecessor, base);
        registry.record_finalization_stage(
            predecessor,
            ImmediateSuccessorFinalizationStage::ReusePreparation,
            base + Duration::from_millis(5),
            base + Duration::from_millis(10),
            true,
        );
        registry.record_finalization_stage(
            predecessor,
            ImmediateSuccessorFinalizationStage::PhysicalPark,
            base + Duration::from_millis(20),
            base + Duration::from_millis(80),
            true,
        );
        registry.record_idle_publication(predecessor, base + Duration::from_millis(90));
        let report = tokio::spawn(registry.clone().settled_receipt_records(predecessor));
        tokio::task::yield_now().await;

        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base + Duration::from_millis(100),
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        tokio::time::advance(MAX_INTENT_RETENTION).await;

        let records = report.await.unwrap();
        let action_types = records
            .iter()
            .map(|record| record.action_type)
            .collect::<Vec<_>>();
        assert!(action_types.contains(&"runner_immediate_successor_intent_received"));
        assert!(action_types.contains(&"runner_immediate_successor_received_after_publication"));
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_receipt_outcome_observes_revoke_after_arm() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        let report = tokio::spawn(registry.clone().settled_receipt_records(predecessor));
        tokio::task::yield_now().await;

        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Revoke,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base + Duration::from_millis(10),
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Revoked
        );
        tokio::time::advance(MAX_INTENT_RETENTION).await;

        let records = report.await.unwrap();
        let action_types = records
            .iter()
            .map(|record| record.action_type)
            .collect::<Vec<_>>();
        assert!(action_types.contains(&"runner_immediate_successor_intent_receipt_revoked"));
        assert!(!action_types.contains(&"runner_immediate_successor_intent_received"));
    }

    #[test]
    fn expired_signal_is_retained_for_claim_outcome() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let received = Instant::now();

        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall - chrono::Duration::seconds(2),
                    wall - chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Expired
        );
        let snapshot = registry
            .observe_claim(Some(predecessor), received)
            .unwrap()
            .snapshot();
        assert_eq!(snapshot.state, ImmediateSuccessorObservationState::Expired);
        assert_eq!(snapshot.remaining_at_receipt, Some(Duration::ZERO));
    }

    #[test]
    fn wrong_target_and_invalid_timestamp_span_do_not_mutate_registry() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let received = Instant::now();
        let valid = notification(
            ImmediateSuccessorIntentAction::Arm,
            predecessor,
            intent_id,
            wall,
            wall + chrono::Duration::seconds(1),
        );
        assert_eq!(
            registry.receive_at(
                valid.clone(),
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::WrongTarget
        );
        assert_eq!(
            registry.receive_at(valid, RUNNER_ID, GENERATION + 1, received, wall),
            ImmediateSuccessorReceiveOutcome::WrongTarget
        );
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(31),
                ),
                RUNNER_ID,
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Invalid
        );
        assert_eq!(
            registry
                .observe_claim(Some(predecessor), received)
                .unwrap()
                .snapshot()
                .state,
            ImmediateSuccessorObservationState::Missing
        );
    }

    #[test]
    fn duplicate_arm_is_idempotent() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let received = Instant::now();
        let signal = notification(
            ImmediateSuccessorIntentAction::Arm,
            predecessor,
            intent_id,
            wall,
            wall + chrono::Duration::seconds(1),
        );

        assert_eq!(
            registry.receive_at(signal.clone(), RUNNER_ID, GENERATION, received, wall),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        assert_eq!(
            registry.receive_at(
                signal,
                RUNNER_ID,
                GENERATION,
                received + Duration::from_millis(10),
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Duplicate
        );
        assert_eq!(
            registry
                .snapshots_for_predecessor(predecessor, received + Duration::from_millis(20))
                .len(),
            1
        );
    }

    #[test]
    fn predecessor_receipt_stays_armed_after_deadline() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let received = Instant::now();
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );

        let [snapshot] = registry
            .snapshots_for_predecessor(predecessor, received + Duration::from_secs(2))
            .try_into()
            .unwrap();
        assert_eq!(snapshot.state, ImmediateSuccessorObservationState::Armed);
        assert_eq!(snapshot.remaining_at_receipt, Some(Duration::from_secs(1)));
    }

    #[test]
    fn live_entries_are_not_evicted_on_overflow() {
        let registry = ImmediateSuccessorIntents::new(1);
        let wall = Utc::now();
        let received = Instant::now();
        let first_predecessor = RunId::new_v4();
        let first_intent = Uuid::new_v4();
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    first_predecessor,
                    first_intent,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    RunId::new_v4(),
                    Uuid::new_v4(),
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Overflow
        );
        assert_eq!(
            registry
                .observe_claim(Some(first_predecessor), received)
                .unwrap()
                .snapshot()
                .state,
            ImmediateSuccessorObservationState::Armed
        );
    }

    #[test]
    fn observation_classifies_receipt_during_park() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        let received = base + Duration::from_millis(30);
        registry.record_finalization_started(predecessor, base);
        registry.record_finalization_stage(
            predecessor,
            ImmediateSuccessorFinalizationStage::ReusePreparation,
            base + Duration::from_millis(5),
            base + Duration::from_millis(10),
            true,
        );
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                received,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        registry.record_finalization_stage(
            predecessor,
            ImmediateSuccessorFinalizationStage::PhysicalPark,
            base + Duration::from_millis(20),
            base + Duration::from_millis(80),
            true,
        );
        registry.record_idle_publication(predecessor, base + Duration::from_millis(90));

        let snapshot = registry
            .observe_claim(Some(predecessor), base + Duration::from_millis(50))
            .unwrap()
            .snapshot();
        assert_eq!(
            snapshot.receipt_phase,
            Some(ImmediateSuccessorReceiptPhase::DuringPark)
        );
        assert_eq!(
            snapshot.predicted_park_saved,
            Some(Duration::from_millis(30))
        );
        assert_eq!(
            snapshot.predicted_prepared_hold,
            Some(Duration::from_millis(40))
        );
    }

    #[test]
    fn failed_park_is_not_counted_as_predicted_savings() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        registry.record_finalization_started(predecessor, base);
        registry.record_finalization_stage(
            predecessor,
            ImmediateSuccessorFinalizationStage::PhysicalPark,
            base + Duration::from_millis(10),
            base + Duration::from_millis(30),
            false,
        );

        let snapshot = registry
            .observe_claim(Some(predecessor), base + Duration::from_millis(20))
            .unwrap()
            .snapshot();
        assert_eq!(snapshot.predicted_park_saved, None);
    }

    #[test]
    fn predicted_prepared_hold_stops_at_revoke_before_a_later_claim() {
        let registry = ImmediateSuccessorIntents::new(2);
        let predecessor = RunId::new_v4();
        let intent_id = Uuid::new_v4();
        let wall = Utc::now();
        let base = Instant::now();
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Arm,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base,
                wall,
            ),
            ImmediateSuccessorReceiveOutcome::Armed
        );
        registry.record_finalization_stage(
            predecessor,
            ImmediateSuccessorFinalizationStage::ReusePreparation,
            base + Duration::from_millis(5),
            base + Duration::from_millis(10),
            true,
        );
        assert_eq!(
            registry.receive_at(
                notification(
                    ImmediateSuccessorIntentAction::Revoke,
                    predecessor,
                    intent_id,
                    wall,
                    wall + chrono::Duration::seconds(1),
                ),
                RUNNER_ID,
                GENERATION,
                base + Duration::from_millis(30),
                wall + chrono::Duration::milliseconds(30),
            ),
            ImmediateSuccessorReceiveOutcome::Revoked
        );

        let snapshot = registry
            .observe_claim(Some(predecessor), base + Duration::from_millis(80))
            .unwrap()
            .snapshot();
        assert_eq!(
            snapshot.predicted_prepared_hold,
            Some(Duration::from_millis(20))
        );
    }
}
