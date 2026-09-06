use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use sandbox::{
    DeviceRateLimits, Sandbox, SandboxFactory, SandboxFinalExecParkHandoffPoint, SandboxId,
};

use crate::guest_timezone::GuestTimezoneIntent;
use crate::ids::RunId;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceImageCache, WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityMismatch,
    WorkspaceImagePromotionIdentityRequest,
};
use crate::workspace_promotion::{
    abandon_unpublished_workspace_promotion, prepare_workspace_image_from_parked_sandbox,
};

const BLANK_REUSE_KEY_PREFIX: &str = "__vm0_blank__:";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdleSandboxKind {
    Exact,
    Blank,
}

pub(super) struct IdleSandboxMetadata {
    pub(super) kind: IdleSandboxKind,
    pub(super) reuse_key: String,
    /// Identity of the parked sandbox. Survives reuse (next job's `run_id`
    /// differs, but `sandbox_id` stays the same) and is the join key for
    /// doctor / kill / workspace-dir naming.
    pub(super) sandbox_id: SandboxId,
    pub(super) profile_name: String,
    pub(super) device_rate_limits: Option<DeviceRateLimits>,
    pub(super) source_ip: String,
    /// Version fingerprints of storages downloaded in the previous turn.
    /// Used to skip re-downloading unchanged entries on reuse.
    pub(super) storage_fingerprints: StorageFingerprints,
    /// Verified hash-backed resume state restored into this sandbox before it
    /// was parked. Missing means reuse must fall back to materialize+restore.
    pub(super) restored_session_identity: Option<RestoredSessionIdentity>,
    pub(super) history_generation_run_id: Option<RunId>,
    pub(super) guest_timezone_intent: GuestTimezoneIntent,
    /// Local terminal timestamp for this parked sandbox.
    ///
    /// `None` is reserved for synthetic test entries and means the sandbox is not
    /// advertised as reusable.
    pub(super) last_completed_at: Option<String>,
}

impl IdleSandboxMetadata {
    pub(super) fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    fn with_last_completed_at(mut self, last_completed_at: String) -> Self {
        debug_assert_eq!(self.kind, IdleSandboxKind::Exact);
        self.last_completed_at = Some(last_completed_at);
        self
    }

    fn is_blank(&self) -> bool {
        self.kind == IdleSandboxKind::Blank
    }
}

pub(super) struct IdleSandboxResources {
    pub(super) sandbox: Box<dyn Sandbox>,
    /// Required for idle-owned/rejected destroy. Reuse discards this because
    /// the active job already has the runner's current sandbox factory.
    pub(super) factory: Arc<Box<dyn SandboxFactory>>,
    pub(super) workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

impl IdleSandboxResources {
    pub(super) fn into_destroy_payload(
        self,
        policy: WorkspacePromotionPolicy,
    ) -> IdleDestroyPayload {
        IdleDestroyPayload {
            resources: self,
            workspace_promotion_policy: policy,
        }
    }

    fn into_reuse_parts(self) -> (Box<dyn Sandbox>, Option<WorkspaceImagePromotionContext>) {
        let Self {
            sandbox,
            factory: _,
            workspace_promotion,
        } = self;
        (sandbox, workspace_promotion)
    }
}

pub(super) enum WorkspacePromotionPolicy {
    Promote,
    AbandonUnpublished(&'static str),
}

/// Active-owned sandbox after `Sandbox::park()` succeeds, before idle-pool
/// ownership is accepted.
///
/// This state proves only same-reuse-key idle park. It does not imply clean
/// cross-run reuse, snapshot readiness, or any broader sandbox correctness.
#[must_use = "parked idle candidates must be accepted by the idle pool or explicitly destroyed"]
pub struct ParkedIdleCandidate {
    pub(super) resources: IdleSandboxResources,
    pub(super) metadata: IdleSandboxMetadata,
    pub(super) budget_lease: BudgetLease,
}

/// Under-compacted parked sandbox that may only be handed to its waiting exact
/// successor or destroyed.
#[must_use = "immediate handoff candidates must be bound to a claimant or explicitly destroyed"]
pub(crate) struct ImmediateHandoffCandidate {
    candidate: ParkedIdleCandidate,
    handoff_point: SandboxFinalExecParkHandoffPoint,
}

/// Parked sandbox bound to one claimed exact successor without entering the
/// generic idle pool.
#[must_use = "finalizing handoff candidates must be activated or explicitly destroyed"]
pub(crate) struct FinalizingHandoffCandidate {
    reservation: ReservedIdleSandbox,
    successor_run_id: RunId,
    predecessor_run_id: RunId,
}

impl ParkedIdleCandidate {
    pub(crate) fn reuse_key(&self) -> &str {
        self.metadata.reuse_key()
    }

    #[cfg(test)]
    pub(crate) fn sandbox_id(&self) -> SandboxId {
        self.metadata.sandbox_id
    }

    pub(crate) fn with_last_completed_at(mut self, last_completed_at: String) -> Self {
        self.metadata = self.metadata.with_last_completed_at(last_completed_at);
        self
    }

    pub(crate) fn blank(
        sandbox: Box<dyn Sandbox>,
        factory: Arc<Box<dyn SandboxFactory>>,
        budget_lease: BudgetLease,
        sandbox_id: SandboxId,
        profile_name: String,
        device_rate_limits: Option<DeviceRateLimits>,
    ) -> Self {
        let source_ip = sandbox.source_ip().to_owned();
        Self {
            resources: IdleSandboxResources {
                sandbox,
                factory,
                workspace_promotion: None,
            },
            metadata: IdleSandboxMetadata {
                kind: IdleSandboxKind::Blank,
                reuse_key: format!("{BLANK_REUSE_KEY_PREFIX}{sandbox_id}"),
                sandbox_id,
                profile_name,
                device_rate_limits,
                source_ip,
                storage_fingerprints: StorageFingerprints::default(),
                restored_session_identity: None,
                history_generation_run_id: None,
                guest_timezone_intent: GuestTimezoneIntent::Unknown,
                last_completed_at: None,
            },
            budget_lease,
        }
    }

    pub(super) fn is_blank(&self) -> bool {
        self.metadata.is_blank()
    }

    pub(super) fn into_idle_entry(self, parked_at: Instant) -> IdleEntry {
        let Self {
            resources,
            metadata,
            budget_lease,
        } = self;

        IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at,
        }
    }

    pub(crate) fn into_finalizing_handoff(
        self,
        successor_run_id: RunId,
        predecessor_run_id: RunId,
    ) -> FinalizingHandoffCandidate {
        debug_assert_eq!(
            self.metadata.history_generation_run_id,
            Some(predecessor_run_id)
        );
        FinalizingHandoffCandidate {
            reservation: ReservedIdleSandbox {
                entry: self.into_idle_entry(Instant::now()),
            },
            successor_run_id,
            predecessor_run_id,
        }
    }

    pub(crate) fn into_immediate_handoff(
        self,
        handoff_point: SandboxFinalExecParkHandoffPoint,
    ) -> ImmediateHandoffCandidate {
        ImmediateHandoffCandidate {
            candidate: self,
            handoff_point,
        }
    }

    pub(crate) fn into_active_destroy_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        let Self {
            resources,
            budget_lease,
            ..
        } = self;
        (
            resources.into_destroy_payload(WorkspacePromotionPolicy::Promote),
            budget_lease,
        )
    }

    pub(super) fn into_rejected(self) -> RejectedParkedIdleCandidate {
        let Self {
            resources,
            budget_lease,
            ..
        } = self;

        RejectedParkedIdleCandidate {
            payload: resources.into_destroy_payload(WorkspacePromotionPolicy::Promote),
            budget_lease,
        }
    }
}

impl ImmediateHandoffCandidate {
    pub(crate) fn handoff_point(&self) -> SandboxFinalExecParkHandoffPoint {
        self.handoff_point
    }

    pub(crate) fn with_last_completed_at(self, last_completed_at: String) -> Self {
        let Self {
            candidate,
            handoff_point,
        } = self;
        Self {
            candidate: candidate.with_last_completed_at(last_completed_at),
            handoff_point,
        }
    }

    pub(crate) fn into_finalizing_handoff(
        self,
        successor_run_id: RunId,
        predecessor_run_id: RunId,
    ) -> FinalizingHandoffCandidate {
        self.candidate
            .into_finalizing_handoff(successor_run_id, predecessor_run_id)
    }

    pub(crate) fn into_active_destroy_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        self.candidate.into_active_destroy_parts()
    }
}

impl FinalizingHandoffCandidate {
    pub(crate) fn into_reservation(
        self: Box<Self>,
        successor_run_id: RunId,
        predecessor_run_id: RunId,
    ) -> Result<ReservedIdleSandbox, Box<Self>> {
        if self.successor_run_id == successor_run_id
            && self.predecessor_run_id == predecessor_run_id
        {
            Ok(self.reservation)
        } else {
            Err(self)
        }
    }

    pub(crate) fn into_destroy_job(self: Box<Self>) -> IdleDestroyJob {
        self.reservation.into_destroy_job()
    }

    pub(crate) fn into_parked_candidate(self: Box<Self>) -> ParkedIdleCandidate {
        let IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at: _,
        } = self.reservation.entry;
        ParkedIdleCandidate {
            resources,
            metadata,
            budget_lease,
        }
    }
}

/// A pool-owned sandbox waiting for reuse.
///
/// Only `IdlePool` can create this from a [`ParkedIdleCandidate`]. This keeps
/// rejected active-job parks out of the idle-owned lifecycle state.
pub struct IdleEntry {
    pub(super) resources: IdleSandboxResources,
    pub(super) metadata: IdleSandboxMetadata,
    pub(super) budget_lease: BudgetLease,
    pub(super) parked_at: Instant,
}

#[must_use = "reserved idle sandboxes must be activated, restored, or destroyed"]
pub struct ReservedIdleSandbox {
    pub(super) entry: IdleEntry,
}

pub enum RestoreReservedIdleResult {
    Restored,
    Rejected(Box<IdleDestroyJob>),
}

/// Result of an explicit sandbox destroy attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DestroyOutcome {
    /// `SandboxFactory::destroy` returned normally and no panic was observed.
    /// A non-panic `stop()` error is logged, then destroy still proves teardown.
    Completed,
    /// Cleanup fell back to panic/drop behavior, so process teardown is not proven.
    Uncertain,
}

/// Reusable sandbox state handed to the executor after a successful unpark.
///
/// The budget lease is intentionally not part of this payload. The outer job
/// task owns the active lease so executor panics cannot release capacity before
/// provider completion and post-job cleanup finish.
pub struct ReusableIdleSandbox {
    sandbox: Box<dyn Sandbox>,
    metadata: IdleSandboxMetadata,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
    guest_state_prepared: bool,
}

pub struct ReusableIdleSandboxParts {
    pub sandbox: Box<dyn Sandbox>,
    pub kind: IdleSandboxKind,
    pub reuse_key: String,
    pub source_ip: String,
    pub storage_fingerprints: StorageFingerprints,
    pub restored_session_identity: Option<RestoredSessionIdentity>,
    pub workspace_promotion: Option<WorkspaceImagePromotionContext>,
    pub guest_state_prepared: bool,
}

/// An exact-generation idle sandbox that has been unparked for claim-time
/// preparation but has not yet been committed to a claimed job.
#[must_use = "speculatively active sandboxes must be committed, re-parked, or destroyed"]
pub(crate) struct SpeculativeIdleSandbox {
    pub(super) entry: IdleEntry,
}

pub(crate) enum SpeculativeIdleUnparkResult {
    Ready(Box<SpeculativeIdleSandbox>),
    Failed {
        destroy_job: Box<IdleDestroyJob>,
        error: String,
    },
}

impl ReusableIdleSandbox {
    pub fn sandbox_id(&self) -> SandboxId {
        self.metadata.sandbox_id
    }

    pub fn restored_session_identity(&self) -> Option<&RestoredSessionIdentity> {
        self.metadata.restored_session_identity.as_ref()
    }

    pub(crate) fn kind(&self) -> IdleSandboxKind {
        self.metadata.kind
    }

    pub fn into_parts(self) -> ReusableIdleSandboxParts {
        let Self {
            sandbox,
            metadata,
            workspace_promotion,
            guest_state_prepared,
        } = self;
        let IdleSandboxMetadata {
            kind,
            reuse_key,
            sandbox_id: _,
            profile_name: _,
            device_rate_limits: _,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id: _,
            guest_timezone_intent: _,
            last_completed_at: _,
        } = metadata;

        ReusableIdleSandboxParts {
            sandbox,
            kind,
            reuse_key,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            workspace_promotion,
            guest_state_prepared,
        }
    }

    pub(crate) fn into_destroy_job(
        self,
        factory: Arc<Box<dyn SandboxFactory>>,
        budget_lease: BudgetLease,
        reason: &'static str,
    ) -> IdleDestroyJob {
        let Self {
            sandbox,
            metadata,
            workspace_promotion,
            guest_state_prepared: _,
        } = self;
        let IdleSandboxMetadata {
            reuse_key,
            profile_name,
            ..
        } = metadata;
        IdleDestroyJob {
            payload: IdleSandboxResources {
                sandbox,
                factory,
                workspace_promotion,
            }
            .into_destroy_payload(WorkspacePromotionPolicy::AbandonUnpublished(reason)),
            budget_lease,
            reuse_key,
            profile_name,
        }
    }
}

/// Physical resources needed to destroy an idle sandbox, without its budget lease.
pub(crate) struct IdleDestroyPayload {
    pub(super) resources: IdleSandboxResources,
    pub(super) workspace_promotion_policy: WorkspacePromotionPolicy,
}

pub(crate) struct IdleDestroyResult {
    pub(crate) outcome: DestroyOutcome,
    pub(crate) workspace_cache_promoted: bool,
}

pub(crate) struct RetainedIdleDestroyResult {
    pub(crate) outcome: DestroyOutcome,
    pub(crate) workspace_cache_promoted: bool,
    pub(crate) budget_lease: BudgetLease,
}

impl IdleDestroyPayload {
    /// Stop the sandbox and destroy it via its factory.
    #[cfg(test)]
    pub(crate) async fn stop_and_destroy(self) -> DestroyOutcome {
        self.finalize_workspace_and_destroy("idle_destroy")
            .await
            .outcome
    }

    pub(crate) async fn finalize_workspace_and_destroy(
        self,
        context: &'static str,
    ) -> IdleDestroyResult {
        let IdleSandboxResources {
            mut sandbox,
            factory,
            workspace_promotion,
        } = self.resources;
        let prepared_promotion = match self.workspace_promotion_policy {
            WorkspacePromotionPolicy::Promote => {
                prepare_workspace_image_from_parked_sandbox(
                    sandbox.as_mut(),
                    workspace_promotion,
                    context,
                )
                .await
            }
            WorkspacePromotionPolicy::AbandonUnpublished(reason) => {
                abandon_unpublished_workspace_promotion(workspace_promotion, reason).await;
                None
            }
        };
        let mut uncertain = false;
        let stopped = match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "failed to stop idle sandbox");
                false
            }
            Err(_) => {
                tracing::warn!("idle sandbox stop panicked");
                uncertain = true;
                false
            }
        };
        let workspace_cache_promoted = match (prepared_promotion, stopped) {
            (Some(promotion), true) => promotion.publish().await,
            (Some(promotion), false) => {
                promotion.abandon("idle_sandbox_stop_failed").await;
                false
            }
            (None, _) => false,
        };
        if AssertUnwindSafe(factory.destroy(sandbox))
            .catch_unwind()
            .await
            .is_err()
        {
            tracing::warn!("idle sandbox destroy panicked");
            uncertain = true;
        }
        if uncertain {
            IdleDestroyResult {
                outcome: DestroyOutcome::Uncertain,
                workspace_cache_promoted,
            }
        } else {
            IdleDestroyResult {
                outcome: DestroyOutcome::Completed,
                workspace_cache_promoted,
            }
        }
    }
}

/// Idle-owned destroy state. The budget lease is released when this job is
/// consumed after physical cleanup.
#[must_use = "dropping IdleDestroyJob releases budget without destroying the sandbox"]
pub struct IdleDestroyJob {
    pub(super) payload: IdleDestroyPayload,
    pub(super) budget_lease: BudgetLease,
    pub(super) reuse_key: String,
    pub(super) profile_name: String,
}

impl IdleDestroyJob {
    #[cfg(test)]
    pub async fn run(self) {
        let _ = self.run_with_context("idle_destroy").await;
    }

    pub async fn run_with_context(self, context: &'static str) -> bool {
        let result = self.run_retaining_lease(context).await;
        drop(result.budget_lease);
        result.workspace_cache_promoted
    }

    pub(crate) async fn run_retaining_lease(
        self,
        context: &'static str,
    ) -> RetainedIdleDestroyResult {
        let Self {
            payload,
            budget_lease,
            reuse_key: _,
            profile_name: _,
        } = self;
        let result = payload.finalize_workspace_and_destroy(context).await;
        RetainedIdleDestroyResult {
            outcome: result.outcome,
            workspace_cache_promoted: result.workspace_cache_promoted,
            budget_lease,
        }
    }

    pub(crate) fn into_retiring_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        let Self {
            payload,
            budget_lease,
            reuse_key: _,
            profile_name: _,
        } = self;
        (payload, budget_lease)
    }

    pub fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    #[cfg(test)]
    pub fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

    #[cfg(test)]
    pub fn budget_memory_mb(&self) -> u32 {
        self.budget_lease.memory_mb()
    }
}

/// Park was rejected before the idle pool accepted ownership.
///
/// The lease belongs back to the active job so completion accounting can stay
/// reserved until physical destroy and provider completion finish.
#[must_use = "rejected parked idle candidates must be destroyed while their lease stays active"]
pub struct RejectedParkedIdleCandidate {
    payload: IdleDestroyPayload,
    budget_lease: BudgetLease,
}

impl RejectedParkedIdleCandidate {
    pub(crate) fn into_active_destroy_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        let Self {
            payload,
            budget_lease,
        } = self;
        (payload, budget_lease)
    }
}

pub enum IdleUnparkResult {
    Reused {
        sandbox: Box<ReusableIdleSandbox>,
        budget_lease: BudgetLease,
    },
    Failed {
        destroy_job: Box<IdleDestroyJob>,
        error: String,
    },
}

enum IdleActivationFailure {
    Returned(String),
    Panicked,
}

impl IdleEntry {
    pub(super) fn kind(&self) -> IdleSandboxKind {
        self.metadata.kind
    }

    pub(super) fn reuse_key(&self) -> &str {
        self.metadata.reuse_key()
    }

    pub fn profile_name(&self) -> &str {
        &self.metadata.profile_name
    }

    pub fn device_rate_limits(&self) -> &Option<DeviceRateLimits> {
        &self.metadata.device_rate_limits
    }

    pub(super) fn is_blank(&self) -> bool {
        self.metadata.is_blank()
    }

    #[cfg(test)]
    pub fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

    #[cfg(test)]
    pub fn budget_memory_mb(&self) -> u32 {
        self.budget_lease.memory_mb()
    }

    /// Bind the next run identity while parked, then unpark and consume this
    /// idle entry. On failure the entry becomes an idle-owned destroy job so
    /// callers cannot keep using a partially unparked sandbox.
    pub async fn try_unpark_for_run(mut self, run_id: RunId) -> IdleUnparkResult {
        match self.activate_for_run(run_id).await {
            Ok(()) => {
                let (sandbox, budget_lease) = self.into_reuse_parts();
                IdleUnparkResult::Reused {
                    sandbox: Box::new(sandbox),
                    budget_lease,
                }
            }
            Err(IdleActivationFailure::Returned(error)) => IdleUnparkResult::Failed {
                destroy_job: Box::new(
                    self.into_destroy_job_abandoning_workspace_promotion("unpark_failed"),
                ),
                error,
            },
            Err(IdleActivationFailure::Panicked) => IdleUnparkResult::Failed {
                destroy_job: Box::new(
                    self.into_destroy_job_abandoning_workspace_promotion("unpark_panicked"),
                ),
                error: "sandbox unpark panicked".into(),
            },
        }
    }

    async fn activate_for_run(&mut self, run_id: RunId) -> Result<(), IdleActivationFailure> {
        let activation = async {
            self.resources
                .sandbox
                .bind_run_control(&run_id.to_string())?;
            self.resources.sandbox.unpark().await
        };
        match AssertUnwindSafe(activation).catch_unwind().await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(IdleActivationFailure::Returned(error.to_string())),
            Err(_) => Err(IdleActivationFailure::Panicked),
        }
    }

    fn into_reuse_parts(self) -> (ReusableIdleSandbox, BudgetLease) {
        let Self {
            resources,
            metadata,
            budget_lease,
            ..
        } = self;
        let (sandbox, workspace_promotion) = resources.into_reuse_parts();

        (
            ReusableIdleSandbox {
                sandbox,
                metadata,
                workspace_promotion,
                guest_state_prepared: false,
            },
            budget_lease,
        )
    }

    pub fn into_destroy_job(self) -> IdleDestroyJob {
        self.into_destroy_job_with_workspace_promotion(WorkspacePromotionPolicy::Promote)
    }

    pub fn into_destroy_job_without_workspace_promotion_for_mismatch(self) -> IdleDestroyJob {
        self.into_destroy_job_abandoning_workspace_promotion("promotion_identity_mismatch")
    }

    pub fn validate_workspace_promotion_identity(
        &self,
        cache: &WorkspaceImageCache,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        let Some(promotion) = self.resources.workspace_promotion.as_ref() else {
            return Ok(());
        };
        promotion.validate_expected_identity(
            cache,
            WorkspaceImagePromotionIdentityRequest {
                sandbox_id: self.metadata.sandbox_id,
                profile_name: &self.metadata.profile_name,
                reuse_key: self.metadata.reuse_key(),
                working_dir,
                image_size_bytes,
            },
        )
    }

    fn into_destroy_job_abandoning_workspace_promotion(
        self,
        reason: &'static str,
    ) -> IdleDestroyJob {
        self.into_destroy_job_with_workspace_promotion(
            WorkspacePromotionPolicy::AbandonUnpublished(reason),
        )
    }

    fn into_destroy_job_with_workspace_promotion(
        self,
        workspace_promotion_policy: WorkspacePromotionPolicy,
    ) -> IdleDestroyJob {
        let Self {
            resources,
            metadata,
            budget_lease,
            ..
        } = self;
        let IdleSandboxMetadata {
            reuse_key,
            profile_name,
            ..
        } = metadata;

        IdleDestroyJob {
            payload: resources.into_destroy_payload(workspace_promotion_policy),
            budget_lease,
            reuse_key,
            profile_name,
        }
    }
}

impl ReservedIdleSandbox {
    pub(crate) fn sandbox_id(&self) -> SandboxId {
        self.entry.metadata.sandbox_id
    }

    pub(crate) fn kind(&self) -> IdleSandboxKind {
        self.entry.metadata.kind
    }

    pub fn reuse_key(&self) -> &str {
        self.entry.reuse_key()
    }

    pub(crate) fn profile_name(&self) -> &str {
        self.entry.profile_name()
    }

    pub(crate) fn device_rate_limits(&self) -> &Option<DeviceRateLimits> {
        self.entry.device_rate_limits()
    }

    pub(crate) fn guest_timezone_intent(&self) -> &GuestTimezoneIntent {
        &self.entry.metadata.guest_timezone_intent
    }

    pub fn validate_workspace_promotion_identity(
        &self,
        cache: &WorkspaceImageCache,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        self.entry
            .validate_workspace_promotion_identity(cache, working_dir, image_size_bytes)
    }

    pub async fn try_unpark_for_run(self, run_id: RunId) -> IdleUnparkResult {
        self.entry.try_unpark_for_run(run_id).await
    }

    pub(crate) async fn try_unpark_for_speculation(
        self,
        run_id: RunId,
    ) -> SpeculativeIdleUnparkResult {
        let mut entry = self.entry;
        match entry.activate_for_run(run_id).await {
            Ok(()) => {
                SpeculativeIdleUnparkResult::Ready(Box::new(SpeculativeIdleSandbox { entry }))
            }
            Err(IdleActivationFailure::Returned(error)) => {
                SpeculativeIdleUnparkResult::Failed {
                    destroy_job: Box::new(entry.into_destroy_job_abandoning_workspace_promotion(
                        "speculative_unpark_failed",
                    )),
                    error,
                }
            }
            Err(IdleActivationFailure::Panicked) => SpeculativeIdleUnparkResult::Failed {
                destroy_job: Box::new(entry.into_destroy_job_abandoning_workspace_promotion(
                    "speculative_unpark_panicked",
                )),
                error: "sandbox unpark panicked".into(),
            },
        }
    }

    pub fn into_destroy_job(self) -> IdleDestroyJob {
        self.entry.into_destroy_job()
    }

    pub fn into_destroy_job_without_workspace_promotion_for_mismatch(self) -> IdleDestroyJob {
        self.entry
            .into_destroy_job_without_workspace_promotion_for_mismatch()
    }
}

impl SpeculativeIdleSandbox {
    pub(crate) fn sandbox(&self) -> &dyn Sandbox {
        self.entry.resources.sandbox.as_ref()
    }

    pub(crate) fn reuse_key(&self) -> &str {
        self.entry.reuse_key()
    }

    pub(crate) fn guest_timezone_intent(&self) -> &GuestTimezoneIntent {
        &self.entry.metadata.guest_timezone_intent
    }

    pub(crate) fn validate_workspace_promotion_identity(
        &self,
        cache: &WorkspaceImageCache,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        self.entry
            .validate_workspace_promotion_identity(cache, working_dir, image_size_bytes)
    }

    pub(crate) fn commit(self, guest_state_prepared: bool) -> (ReusableIdleSandbox, BudgetLease) {
        let Self { entry } = self;
        let IdleEntry {
            resources,
            metadata,
            budget_lease,
            ..
        } = entry;
        let (sandbox, workspace_promotion) = resources.into_reuse_parts();
        (
            ReusableIdleSandbox {
                sandbox,
                metadata,
                workspace_promotion,
                guest_state_prepared,
            },
            budget_lease,
        )
    }

    pub(crate) fn into_destroy_job(self, reason: &'static str) -> IdleDestroyJob {
        self.entry
            .into_destroy_job_abandoning_workspace_promotion(reason)
    }
}
