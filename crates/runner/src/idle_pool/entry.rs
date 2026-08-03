use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sandbox::{DeviceRateLimits, Sandbox, SandboxFactory, SandboxId};

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

pub(super) struct IdleSandboxMetadata {
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
    /// Local terminal timestamp for this parked sandbox.
    ///
    /// `None` is reserved for synthetic test entries and means the VM is not
    /// advertised for reuse affinity.
    pub(super) last_completed_at: Option<String>,
}

impl IdleSandboxMetadata {
    pub(super) fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    fn with_last_completed_at(mut self, last_completed_at: String) -> Self {
        self.last_completed_at = Some(last_completed_at);
        self
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
    fn into_destroy_payload(self, policy: WorkspacePromotionPolicy) -> IdleDestroyPayload {
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
/// cross-run reuse, snapshot readiness, or any broader VM correctness.
#[must_use = "parked idle candidates must be accepted by the idle pool or explicitly destroyed"]
pub struct ParkedIdleCandidate {
    pub(super) resources: IdleSandboxResources,
    pub(super) metadata: IdleSandboxMetadata,
    pub(super) budget_lease: BudgetLease,
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

    pub(super) fn into_idle_entry(self, parked_at: Instant, idle_timeout: Duration) -> IdleEntry {
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
            idle_timeout,
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

/// A pool-owned sandbox waiting for reuse.
///
/// Only `IdlePool` can create this from a [`ParkedIdleCandidate`]. This keeps
/// rejected active-job parks out of the idle-owned lifecycle state.
pub struct IdleEntry {
    pub(super) resources: IdleSandboxResources,
    pub(super) metadata: IdleSandboxMetadata,
    pub(super) budget_lease: BudgetLease,
    pub(super) parked_at: Instant,
    pub(super) idle_timeout: Duration,
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
}

pub struct ReusableIdleSandboxParts {
    pub sandbox: Box<dyn Sandbox>,
    pub reuse_key: String,
    pub source_ip: String,
    pub storage_fingerprints: StorageFingerprints,
    pub restored_session_identity: Option<RestoredSessionIdentity>,
    pub workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

impl ReusableIdleSandbox {
    pub fn sandbox_id(&self) -> SandboxId {
        self.metadata.sandbox_id
    }

    pub fn restored_session_identity(&self) -> Option<&RestoredSessionIdentity> {
        self.metadata.restored_session_identity.as_ref()
    }

    pub fn into_parts(self) -> ReusableIdleSandboxParts {
        let Self {
            sandbox,
            metadata,
            workspace_promotion,
        } = self;
        let IdleSandboxMetadata {
            reuse_key,
            sandbox_id: _,
            profile_name: _,
            device_rate_limits: _,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id: _,
            last_completed_at: _,
        } = metadata;

        ReusableIdleSandboxParts {
            sandbox,
            reuse_key,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            workspace_promotion,
        }
    }
}

/// Physical resources needed to destroy an idle VM, without its budget lease.
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

    pub fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

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

impl IdleEntry {
    pub(super) fn reuse_key(&self) -> &str {
        self.metadata.reuse_key()
    }

    pub fn profile_name(&self) -> &str {
        &self.metadata.profile_name
    }

    pub fn device_rate_limits(&self) -> &Option<DeviceRateLimits> {
        &self.metadata.device_rate_limits
    }

    #[cfg(test)]
    pub fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

    #[cfg(test)]
    pub fn budget_memory_mb(&self) -> u32 {
        self.budget_lease.memory_mb()
    }

    pub(super) fn is_expired_at(&self, now: Instant) -> bool {
        now.duration_since(self.parked_at) >= self.idle_timeout
    }

    /// Unpark and consume this idle entry. On failure the entry becomes an
    /// idle-owned destroy job so callers cannot keep using a partially
    /// unparked sandbox.
    pub async fn try_unpark(mut self) -> IdleUnparkResult {
        match AssertUnwindSafe(self.resources.sandbox.unpark())
            .catch_unwind()
            .await
        {
            Ok(Ok(())) => {
                let (sandbox, budget_lease) = self.into_reuse_parts();
                IdleUnparkResult::Reused {
                    sandbox: Box::new(sandbox),
                    budget_lease,
                }
            }
            Ok(Err(e)) => IdleUnparkResult::Failed {
                destroy_job: Box::new(
                    self.into_destroy_job_abandoning_workspace_promotion("unpark_failed"),
                ),
                error: e.to_string(),
            },
            Err(_) => IdleUnparkResult::Failed {
                destroy_job: Box::new(
                    self.into_destroy_job_abandoning_workspace_promotion("unpark_panicked"),
                ),
                error: "sandbox unpark panicked".into(),
            },
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
    pub fn reuse_key(&self) -> &str {
        self.entry.reuse_key()
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

    pub async fn try_unpark(self) -> IdleUnparkResult {
        self.entry.try_unpark().await
    }

    pub fn into_destroy_job(self) -> IdleDestroyJob {
        self.entry.into_destroy_job()
    }

    pub fn into_destroy_job_without_workspace_promotion_for_mismatch(self) -> IdleDestroyJob {
        self.entry
            .into_destroy_job_without_workspace_promotion_for_mismatch()
    }
}
