use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
use std::time::{Duration, Instant};

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use sandbox::{
    DeviceRateLimits, Sandbox, SandboxFactory, SandboxId, SandboxParkNonReusableReason,
    SandboxParkOutcome,
};

use crate::idle_reuse_preparation::IdleReusePreparation;
use crate::ids::RunId;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::status::IdleVm;
use crate::storage_fingerprints::StorageFingerprints;
use crate::types::{HeldSandboxState, ReusableSandboxState};
use crate::workspace_image_cache::{
    WorkspaceImageCache, WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityMismatch,
    WorkspaceImagePromotionIdentityRequest,
};
use crate::workspace_promotion::{
    abandon_unpublished_workspace_promotion, prepare_workspace_image_from_parked_sandbox,
};

#[cfg(test)]
pub(crate) mod test_support;

/// Default idle timeout for kept-alive VMs (30 minutes).
///
/// Re-exported via `SandboxConfig::default()` so the YAML default and
/// the in-process fallback stay locked together.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 1800;

/// Configuration for the idle sandbox pool.
#[derive(Debug, Clone)]
pub struct IdlePoolConfig {
    /// Default idle timeout for parked VMs.
    pub default_timeout: Duration,
    /// Maximum number of idle VMs (0 = unlimited).
    pub max_idle: usize,
}

impl Default for IdlePoolConfig {
    fn default() -> Self {
        Self {
            default_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
            max_idle: 0,
        }
    }
}

/// Lifecycle-owned gate for whether completed jobs may enter the idle pool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ParkingState {
    Open = 0,
    SoftDraining = 1,
    Closed = 2,
}

impl ParkingState {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Open,
            1 => Self::SoftDraining,
            2 => Self::Closed,
            _ => Self::Closed,
        }
    }
}

/// Shared parking permission updated before publishing runner mode transitions.
#[derive(Clone, Debug)]
pub(crate) struct ParkingGate {
    state: Arc<AtomicU8>,
}

impl ParkingGate {
    pub(crate) fn new_open() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(ParkingState::Open as u8)),
        }
    }

    pub(crate) fn state(&self) -> ParkingState {
        ParkingState::from_u8(self.state.load(Ordering::SeqCst))
    }

    pub(crate) fn is_open(&self) -> bool {
        self.state() == ParkingState::Open
    }

    pub(crate) fn soft_drain(&self) -> bool {
        match self.state.compare_exchange(
            ParkingState::Open as u8,
            ParkingState::SoftDraining as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state) => ParkingState::from_u8(state) == ParkingState::SoftDraining,
        }
    }

    pub(crate) fn open_after_soft_drain(&self) -> bool {
        match self.state.compare_exchange(
            ParkingState::SoftDraining as u8,
            ParkingState::Open as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state) => ParkingState::from_u8(state) == ParkingState::Open,
        }
    }

    pub(crate) fn close(&self) {
        self.state
            .store(ParkingState::Closed as u8, Ordering::SeqCst);
    }
}

impl Default for ParkingGate {
    fn default() -> Self {
        Self::new_open()
    }
}

/// One-shot request to transition an active sandbox into same-reuse-key idle
/// ownership.
#[must_use = "idle park requests own active sandbox and budget; call park_for_idle"]
pub(crate) struct IdleParkRequest {
    parts: IdleParkRequestParts,
}

#[must_use = "idle park request parts own active sandbox and budget"]
pub(crate) struct IdleParkRequestParts {
    pub(crate) run_id: RunId,
    pub(crate) sandbox: Box<dyn Sandbox>,
    pub(crate) factory: Arc<Box<dyn SandboxFactory>>,
    pub(crate) reuse_key: String,
    pub(crate) sandbox_id: SandboxId,
    pub(crate) profile_name: String,
    pub(crate) device_rate_limits: Option<DeviceRateLimits>,
    pub(crate) budget_lease: BudgetLease,
    pub(crate) source_ip: String,
    pub(crate) storage_fingerprints: StorageFingerprints,
    pub(crate) restored_session_identity: Option<RestoredSessionIdentity>,
    pub(crate) history_generation_run_id: Option<RunId>,
    pub(crate) workspace_image_size_bytes: u64,
    pub(crate) workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

struct IdleSandboxMetadata {
    reuse_key: String,
    /// Identity of the parked sandbox. Survives reuse (next job's `run_id`
    /// differs, but `sandbox_id` stays the same) and is the join key for
    /// doctor / kill / workspace-dir naming.
    sandbox_id: SandboxId,
    profile_name: String,
    device_rate_limits: Option<DeviceRateLimits>,
    source_ip: String,
    /// Version fingerprints of storages downloaded in the previous turn.
    /// Used to skip re-downloading unchanged entries on reuse.
    storage_fingerprints: StorageFingerprints,
    /// Verified hash-backed resume state restored into this sandbox before it
    /// was parked. Missing means reuse must fall back to materialize+restore.
    restored_session_identity: Option<RestoredSessionIdentity>,
    history_generation_run_id: Option<RunId>,
    /// Local terminal timestamp for this parked sandbox.
    ///
    /// `None` is reserved for synthetic test entries and means the VM is not
    /// advertised for reuse affinity.
    last_completed_at: Option<String>,
}

impl IdleSandboxMetadata {
    fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    fn with_last_completed_at(mut self, last_completed_at: String) -> Self {
        self.last_completed_at = Some(last_completed_at);
        self
    }
}

struct IdleSandboxResources {
    sandbox: Box<dyn Sandbox>,
    /// Required for idle-owned/rejected destroy. Reuse discards this because
    /// the active job already has the runner's current sandbox factory.
    factory: Arc<Box<dyn SandboxFactory>>,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
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

enum WorkspacePromotionPolicy {
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
    resources: IdleSandboxResources,
    metadata: IdleSandboxMetadata,
    budget_lease: BudgetLease,
}

/// Result after the sandbox successfully reaches the parked state.
#[must_use = "parked outcomes must be admitted for reuse or explicitly destroyed"]
pub(crate) enum IdleParkOutcome {
    Reusable(ParkedIdleCandidate),
    NonReusable {
        candidate: ParkedIdleCandidate,
        reason: SandboxParkNonReusableReason,
    },
}

#[must_use = "idle park failures must be explicitly destroyed or otherwise handled"]
pub(crate) struct IdleParkFailure {
    ownership: IdleParkFailureOwnership,
    reason: &'static str,
    error: String,
}

enum IdleParkFailureOwnership {
    Active {
        resources: IdleSandboxResources,
        budget_lease: BudgetLease,
    },
    Parked {
        rejected: RejectedParkedIdleCandidate,
    },
}

#[must_use = "active idle-park parts still own a sandbox and budget lease"]
pub(crate) struct IdleParkActiveParts {
    pub(crate) sandbox: Box<dyn Sandbox>,
    pub(crate) factory: Arc<Box<dyn SandboxFactory>>,
    pub(crate) budget_lease: BudgetLease,
    pub(crate) workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

#[must_use = "idle park failure parts must be logged and cleaned up"]
pub(crate) enum IdleParkFailureParts {
    Active {
        active: IdleParkActiveParts,
        reason: &'static str,
        error: String,
    },
    Parked {
        rejected: RejectedParkedIdleCandidate,
        reason: &'static str,
        error: String,
    },
}

impl IdleParkRequest {
    pub(crate) fn new(parts: IdleParkRequestParts) -> Self {
        Self { parts }
    }

    pub(crate) async fn park_for_idle(self) -> Result<IdleParkOutcome, IdleParkFailure> {
        let IdleParkRequestParts {
            run_id,
            mut sandbox,
            factory,
            reuse_key,
            sandbox_id,
            profile_name,
            device_rate_limits,
            budget_lease,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            workspace_image_size_bytes,
            workspace_promotion,
        } = self.parts;

        let retained_runtime_dir = restored_session_identity
            .as_ref()
            .and_then(RestoredSessionIdentity::final_metadata_verification)
            .map(|verification| verification.runtime_dir.to_owned());

        let metadata = IdleSandboxMetadata {
            reuse_key,
            sandbox_id,
            profile_name,
            device_rate_limits,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            last_completed_at: None,
        };

        if let Some(promotion) = workspace_promotion.as_ref()
            && let Err(mismatch) =
                promotion.validate_stored_cache_identity(WorkspaceImagePromotionIdentityRequest {
                    sandbox_id: metadata.sandbox_id,
                    profile_name: &metadata.profile_name,
                    reuse_key: metadata.reuse_key(),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: workspace_image_size_bytes,
                })
        {
            tracing::warn!(
                sandbox_id = %metadata.sandbox_id,
                profile_name = %metadata.profile_name,
                mismatch = mismatch.as_str(),
                "workspace promotion identity mismatch before idle park; destroying without workspace promotion"
            );
            abandon_unpublished_workspace_promotion(
                workspace_promotion,
                "promotion_identity_mismatch",
            )
            .await;
            return Err(IdleParkFailure {
                ownership: IdleParkFailureOwnership::Active {
                    resources: IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion: None,
                    },
                    budget_lease,
                },
                reason: "promotion_identity_mismatch",
                error: format!("workspace promotion identity mismatch: {mismatch}"),
            });
        }

        let preparation = match IdleReusePreparation::new(
            sandbox.id(),
            run_id,
            retained_runtime_dir.as_deref(),
        ) {
            Ok(preparation) => preparation,
            Err(error) => {
                return Err(IdleParkFailure {
                    ownership: IdleParkFailureOwnership::Active {
                        resources: IdleSandboxResources {
                            sandbox,
                            factory,
                            workspace_promotion,
                        },
                        budget_lease,
                    },
                    reason: "reuse_preparation_failed",
                    error: error.to_string(),
                });
            }
        };

        let final_exec_and_park = {
            let request = preparation.exec_request();
            AssertUnwindSafe(
                sandbox.final_exec_and_park(&request, "idle-reuse-preparation-and-park"),
            )
            .catch_unwind()
            .await
        };
        match final_exec_and_park {
            Ok(Ok(outcome)) => {
                let candidate = ParkedIdleCandidate {
                    resources: IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion,
                    },
                    metadata,
                    budget_lease,
                };
                if let Err(error) = preparation.validate_result(&outcome.exec_result) {
                    return Err(IdleParkFailure {
                        ownership: IdleParkFailureOwnership::Parked {
                            rejected: candidate.into_rejected(),
                        },
                        reason: "reuse_preparation_failed",
                        error: error.to_string(),
                    });
                }
                Ok(match outcome.park_outcome {
                    SandboxParkOutcome::Reusable => IdleParkOutcome::Reusable(candidate),
                    SandboxParkOutcome::NonReusable(reason) => {
                        IdleParkOutcome::NonReusable { candidate, reason }
                    }
                })
            }
            Ok(Err(e)) => Err(IdleParkFailure {
                ownership: IdleParkFailureOwnership::Active {
                    resources: IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion,
                    },
                    budget_lease,
                },
                reason: "park_failed",
                error: e.to_string(),
            }),
            Err(_) => {
                // A panic leaves the park transition state uncertain; destroy
                // the sandbox, but do not publish a workspace cache image.
                abandon_unpublished_workspace_promotion(workspace_promotion, "park_panicked").await;
                Err(IdleParkFailure {
                    ownership: IdleParkFailureOwnership::Active {
                        resources: IdleSandboxResources {
                            sandbox,
                            factory,
                            workspace_promotion: None,
                        },
                        budget_lease,
                    },
                    reason: "park_panicked",
                    error: "sandbox park panicked".into(),
                })
            }
        }
    }
}

impl IdleParkOutcome {
    pub(crate) fn into_parts(self) -> (ParkedIdleCandidate, Option<SandboxParkNonReusableReason>) {
        match self {
            Self::Reusable(candidate) => (candidate, None),
            Self::NonReusable { candidate, reason } => (candidate, Some(reason)),
        }
    }

    #[cfg(test)]
    pub(crate) fn expect_reusable(self) -> ParkedIdleCandidate {
        match self {
            Self::Reusable(candidate) => candidate,
            Self::NonReusable { reason, .. } => {
                panic!(
                    "expected reusable parked candidate, got {}",
                    reason.as_str()
                )
            }
        }
    }
}

impl IdleParkFailure {
    pub(crate) fn into_parts(self) -> IdleParkFailureParts {
        let Self {
            ownership,
            reason,
            error,
        } = self;
        match ownership {
            IdleParkFailureOwnership::Active {
                resources,
                budget_lease,
            } => {
                let IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                } = resources;
                IdleParkFailureParts::Active {
                    active: IdleParkActiveParts {
                        sandbox,
                        factory,
                        budget_lease,
                        workspace_promotion,
                    },
                    reason,
                    error,
                }
            }
            IdleParkFailureOwnership::Parked { rejected } => IdleParkFailureParts::Parked {
                rejected,
                reason,
                error,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn into_error(self) -> String {
        match self.into_parts() {
            IdleParkFailureParts::Active { error, .. }
            | IdleParkFailureParts::Parked { error, .. } => error,
        }
    }
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

    fn into_idle_entry(self, parked_at: Instant, idle_timeout: Duration) -> IdleEntry {
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

    fn into_rejected(self) -> RejectedParkedIdleCandidate {
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
    resources: IdleSandboxResources,
    metadata: IdleSandboxMetadata,
    budget_lease: BudgetLease,
    parked_at: Instant,
    idle_timeout: Duration,
}

#[must_use = "reserved idle sandboxes must be activated, restored, or destroyed"]
pub struct ReservedIdleSandbox {
    entry: IdleEntry,
}

pub enum RestoreReservedIdleResult {
    Restored,
    Rejected(Box<IdleDestroyJob>),
}

/// Idle pool status snapshot paired with a monotonic mutation revision.
///
/// Status writes happen after dropping the pool lock, so an older snapshot can
/// otherwise complete after a newer drain/evict write and reintroduce stale
/// `idle_vms` in status.json.
#[derive(Clone, Debug)]
pub struct IdlePoolSnapshot {
    pub revision: u64,
    pub idle_vms: Vec<IdleVm>,
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
    resources: IdleSandboxResources,
    workspace_promotion_policy: WorkspacePromotionPolicy,
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
    payload: IdleDestroyPayload,
    budget_lease: BudgetLease,
    reuse_key: String,
    profile_name: String,
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
    fn reuse_key(&self) -> &str {
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

    fn is_expired_at(&self, now: Instant) -> bool {
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

/// Pool of idle sandboxes keyed by reuse key.
///
/// After a job completes successfully, its sandbox can be parked here
/// instead of being destroyed. A subsequent job for the same reuse key
/// can reuse the parked sandbox, skipping VM creation and startup.
pub struct IdlePool {
    entries: HashMap<String, IdleEntry>,
    config: IdlePoolConfig,
    revision: u64,
    /// Shared lifecycle gate. The signal/main-loop lifecycle controller updates
    /// this before publishing externally visible mode transitions.
    parking_gate: ParkingGate,
}

impl IdlePool {
    #[cfg(test)]
    pub fn new(config: IdlePoolConfig) -> Self {
        Self::new_with_parking_gate(config, ParkingGate::new_open())
    }

    pub(crate) fn new_with_parking_gate(config: IdlePoolConfig, parking_gate: ParkingGate) -> Self {
        Self {
            entries: HashMap::new(),
            config,
            revision: 0,
            parking_gate,
        }
    }

    /// Park a sandbox in the pool. Returns the previously parked destroy job
    /// for this reuse key if one existed (caller must destroy it).
    ///
    /// Returns `Rejected(candidate)` if parking is closed/soft-draining or at capacity.
    pub fn park(&mut self, candidate: ParkedIdleCandidate) -> ParkResult {
        self.park_at(candidate, Instant::now(), self.config.default_timeout)
    }

    #[cfg(test)]
    pub fn park_at_for_test(
        &mut self,
        candidate: ParkedIdleCandidate,
        parked_at: Instant,
        idle_timeout: Duration,
    ) -> ParkResult {
        self.park_at(candidate, parked_at, idle_timeout)
    }

    fn park_at(
        &mut self,
        candidate: ParkedIdleCandidate,
        parked_at: Instant,
        idle_timeout: Duration,
    ) -> ParkResult {
        let reuse_key = candidate.reuse_key().to_string();
        if !self.parking_gate.is_open() {
            return ParkResult::Rejected(candidate.into_rejected());
        }
        if self.config.max_idle > 0 && self.entries.len() >= self.config.max_idle {
            // At capacity and this reuse key has no existing entry to replace.
            if !self.entries.contains_key(&reuse_key) {
                return ParkResult::Rejected(candidate.into_rejected());
            }
        }
        let entry = candidate.into_idle_entry(parked_at, idle_timeout);
        let result = match self.entries.insert(reuse_key, entry) {
            Some(evicted) => ParkResult::Replaced(evicted.into_destroy_job()),
            None => ParkResult::Parked,
        };
        self.bump_revision();
        result
    }

    pub fn take(&mut self, reuse_key: &str) -> Option<IdleEntry> {
        let entry = self.entries.remove(reuse_key);
        if entry.is_some() {
            self.bump_revision();
        }
        entry
    }

    pub fn has_reusable(
        &self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> bool {
        self.entries.get(reuse_key).is_some_and(|entry| {
            !entry.is_expired_at(Instant::now())
                && entry.profile_name() == profile_name
                && entry.device_rate_limits() == device_rate_limits
        })
    }

    pub fn reserve_reusable(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> Option<ReservedIdleSandbox> {
        if !self.has_reusable(reuse_key, profile_name, device_rate_limits) {
            return None;
        }
        let entry = self.entries.remove(reuse_key)?;
        self.bump_revision();
        Some(ReservedIdleSandbox { entry })
    }

    pub fn reserve_reusable_generation(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
        history_generation_run_id: RunId,
    ) -> Option<ReservedIdleSandbox> {
        if !self.has_reusable(reuse_key, profile_name, device_rate_limits)
            || self
                .entries
                .get(reuse_key)
                .and_then(|entry| entry.metadata.history_generation_run_id)
                != Some(history_generation_run_id)
        {
            return None;
        }
        let entry = self.entries.remove(reuse_key)?;
        self.bump_revision();
        Some(ReservedIdleSandbox { entry })
    }

    pub fn restore_reserved(
        &mut self,
        reservation: ReservedIdleSandbox,
    ) -> RestoreReservedIdleResult {
        let entry = reservation.entry;
        let reuse_key = entry.reuse_key().to_owned();
        let has_capacity = self.config.max_idle == 0 || self.entries.len() < self.config.max_idle;
        if !self.parking_gate.is_open()
            || entry.is_expired_at(Instant::now())
            || !has_capacity
            || self.entries.contains_key(&reuse_key)
        {
            return RestoreReservedIdleResult::Rejected(Box::new(entry.into_destroy_job()));
        }

        self.entries.insert(reuse_key, entry);
        self.bump_revision();
        RestoreReservedIdleResult::Restored
    }

    /// Remove and return all entries that have exceeded their idle timeout.
    pub fn evict_expired(&mut self) -> Vec<IdleDestroyJob> {
        let now = Instant::now();
        let expired: Vec<IdleDestroyJob> = self
            .entries
            .extract_if(|_, entry| entry.is_expired_at(now))
            .map(|(_, entry)| entry.into_destroy_job())
            .collect();
        if !expired.is_empty() {
            self.bump_revision();
        }
        expired
    }

    /// Remove expired entries and return the post-eviction idle status snapshot.
    pub fn evict_expired_with_snapshot(&mut self) -> (Vec<IdleDestroyJob>, IdlePoolSnapshot) {
        let expired = self.evict_expired();
        let snapshot = self.status_snapshot();
        (expired, snapshot)
    }

    /// Evict the oldest idle entry (by park time). Used for resource
    /// pressure relief.
    pub fn evict_oldest(&mut self) -> Option<IdleDestroyJob> {
        let oldest_key = self
            .entries
            .iter()
            .min_by_key(|(_, e)| e.parked_at)
            .map(|(k, _)| k.clone())?;
        let job = self
            .entries
            .remove(&oldest_key)
            .map(IdleEntry::into_destroy_job);
        if job.is_some() {
            self.bump_revision();
        }
        job
    }

    /// Return a revisioned reuse-key-sorted snapshot suitable for status.json.
    ///
    /// Produced in a single iteration so `reuse_key` and `sandbox_id` can never
    /// drift out of pairing.
    pub fn status_snapshot(&self) -> IdlePoolSnapshot {
        let mut vms: Vec<IdleVm> = self.entries.values().map(idle_vm_for_entry).collect();
        vms.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
        IdlePoolSnapshot {
            revision: self.revision,
            idle_vms: vms,
        }
    }

    /// Return true when the idle pool currently owns `sandbox_id`.
    pub fn contains_sandbox_id(&self, sandbox_id: SandboxId) -> bool {
        self.entries
            .values()
            .any(|entry| entry.metadata.sandbox_id == sandbox_id)
    }

    /// Return a reuse-key-sorted snapshot of the idle pool suitable
    /// for status.json. Produced in a single iteration so `reuse_key` and
    /// `sandbox_id` can never drift out of pairing.
    #[cfg(test)]
    pub fn held_snapshot(&self) -> Vec<IdleVm> {
        self.status_snapshot().idle_vms
    }

    /// Return every reusable sandbox currently held in the pool, sorted by
    /// reuse key for deterministic heartbeat output.
    ///
    /// Prefer [`status_snapshot`](Self::status_snapshot) when pairing with
    /// sandbox IDs — it produces both views from a single iteration.
    pub fn held_sandbox_states(&self) -> Vec<HeldSandboxState> {
        let mut states: Vec<HeldSandboxState> = self
            .entries
            .iter()
            .filter_map(|(reuse_key, entry)| {
                entry
                    .metadata
                    .last_completed_at
                    .as_ref()
                    .map(|last_completed_at| HeldSandboxState {
                        reuse_key: reuse_key.clone(),
                        last_completed_at: last_completed_at.clone(),
                        reusable_sandbox: ReusableSandboxState {
                            profile: entry.metadata.profile_name.clone(),
                            history_generation_run_id: entry.metadata.history_generation_run_id,
                        },
                    })
            })
            .collect();
        states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
        states
    }

    #[cfg(test)]
    pub fn held_reuse_keys(&self) -> Vec<String> {
        let mut reuse_keys: Vec<String> = self.entries.keys().cloned().collect();
        reuse_keys.sort_unstable();
        reuse_keys
    }

    /// Number of idle VMs in the pool.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Current lifecycle parking state.
    #[cfg(test)]
    pub fn parking_state(&self) -> ParkingState {
        self.parking_gate.state()
    }

    /// Shared lifecycle parking gate.
    #[cfg(test)]
    pub fn parking_gate(&self) -> ParkingGate {
        self.parking_gate.clone()
    }

    /// Drain all entries from the pool. Parking permission is controlled by
    /// [`ParkingGate`] so soft-drain resume can reopen parking before
    /// [`crate::lifecycle::RunnerMode::Running`] becomes visible.
    pub fn drain(&mut self) -> Vec<IdleDestroyJob> {
        let jobs: Vec<IdleDestroyJob> = self
            .entries
            .drain()
            .map(|(_, entry)| entry.into_destroy_job())
            .collect();
        if !jobs.is_empty() {
            self.bump_revision();
        }
        jobs
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

fn idle_vm_for_entry(entry: &IdleEntry) -> IdleVm {
    IdleVm {
        reuse_key: entry.reuse_key().to_owned(),
        sandbox_id: entry.metadata.sandbox_id,
    }
}

/// Result of a `park` operation.
#[must_use]
pub enum ParkResult {
    /// Successfully parked; no previous entry for this reuse key.
    Parked,
    /// Successfully parked; the returned job destroys the replaced idle VM.
    Replaced(IdleDestroyJob),
    /// Parking is closed/soft-draining or at capacity; the entry could not be parked.
    Rejected(RejectedParkedIdleCandidate),
}

#[cfg(test)]
mod destroy_tests;

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use guest_contracts::reuse_preparation::ReusePreparationRequest;
    use guest_contracts::session_history_identity::{
        FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
    };
    use sha2::{Digest, Sha256};

    use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
    use crate::resource_budget::ResourceBudget;
    use crate::storage_fingerprints::StorageFingerprint;

    use super::test_support::ParkedIdleCandidateBuilder;
    use sandbox::{ResourceLimits, SandboxConfig};
    use sandbox_mock::{MockSandboxFactory, MockSandboxOverrides};

    fn make_budget_lease(vcpu: u32, memory_mb: u32) -> BudgetLease {
        let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
        ResourceBudget::try_reserve_lease(&budget, vcpu, memory_mb).unwrap()
    }

    fn make_candidate_for(reuse_key: &str, vcpu: u32, memory_mb: u32) -> ParkedIdleCandidate {
        make_candidate_for_with_lease(reuse_key, make_budget_lease(vcpu, memory_mb))
    }

    fn make_candidate_for_with_lease(
        reuse_key: &str,
        budget_lease: BudgetLease,
    ) -> ParkedIdleCandidate {
        ParkedIdleCandidateBuilder::new(reuse_key, budget_lease)
            .with_mock_sandbox_name("test")
            .build()
    }

    fn park_at(
        pool: &mut IdlePool,
        reuse_key: &str,
        candidate: ParkedIdleCandidate,
        parked_at: Instant,
        idle_timeout: Duration,
    ) -> ParkResult {
        assert_eq!(candidate.reuse_key(), reuse_key);
        pool.park_at_for_test(candidate, parked_at, idle_timeout)
    }

    fn pool_config(max_idle: usize) -> IdlePoolConfig {
        IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle,
        }
    }

    #[test]
    fn parked_candidate_exposes_reuse_key() {
        let candidate =
            ParkedIdleCandidateBuilder::new("initial-reuse-key", make_budget_lease(1, 1024))
                .with_reuse_key("thread:chat-thread")
                .build();

        assert_eq!(candidate.reuse_key(), "thread:chat-thread");
    }

    async fn make_idle_park_request(
        overrides: Arc<MockSandboxOverrides>,
        session_id: &str,
        budget_lease: BudgetLease,
    ) -> IdleParkRequest {
        add_healthy_reuse_preparation_matcher(&overrides);
        let sandbox_id = SandboxId::new_v4();
        let factory: Arc<Box<dyn SandboxFactory>> =
            Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
        let sandbox = factory
            .create(SandboxConfig {
                id: sandbox_id,
                resources: ResourceLimits {
                    cpu_count: budget_lease.vcpu(),
                    memory_mb: budget_lease.memory_mb(),
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create sandbox");
        IdleParkRequest::new(IdleParkRequestParts {
            run_id: RunId::new_v4(),
            sandbox,
            factory,
            reuse_key: session_id.into(),
            sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            restored_session_identity: None,
            history_generation_run_id: None,
            workspace_image_size_bytes: 0,
            workspace_promotion: None,
        })
    }

    #[tokio::test]
    async fn idle_park_request_success_returns_parked_candidate() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let request = make_idle_park_request(
            Arc::clone(&overrides),
            "session-1",
            make_budget_lease(2, 2048),
        )
        .await;

        let candidate = match request.park_for_idle().await {
            Ok(outcome) => outcome.expect_reusable(),
            Err(_) => panic!("park should succeed"),
        };

        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(candidate.reuse_key(), "session-1");
    }

    #[tokio::test]
    async fn idle_park_request_semantic_rejection_returns_parked_ownership() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: "prepare-for-reuse".into(),
            exit_code: 0,
            stdout: b"not-json".to_vec(),
            stderr: Vec::new(),
        });
        let request = make_idle_park_request(
            Arc::clone(&overrides),
            "session-invalid-report",
            make_budget_lease(2, 2048),
        )
        .await;

        let failure = match request.park_for_idle().await {
            Ok(_) => panic!("invalid report must reject idle admission"),
            Err(failure) => failure,
        };
        let IdleParkFailureParts::Parked {
            rejected,
            reason,
            error,
        } = failure.into_parts()
        else {
            panic!("semantic rejection after park must retain parked ownership");
        };

        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(reason, "reuse_preparation_failed");
        assert!(error.contains("invalid report"));
        let (payload, budget_lease) = rejected.into_active_destroy_parts();
        assert_eq!(budget_lease.vcpu(), 2);
        assert_eq!(budget_lease.memory_mb(), 2048);
        assert_eq!(payload.stop_and_destroy().await, DestroyOutcome::Completed);
        assert_eq!(overrides.destroy_call_count(), 1);
    }

    #[tokio::test]
    async fn idle_park_request_protects_retained_identity_runtime_directory() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let session_id = "session-retained-runtime";
        let mut request = make_idle_park_request(
            Arc::clone(&overrides),
            session_id,
            make_budget_lease(2, 2048),
        )
        .await;
        let run_id = request.parts.run_id;
        let retained_runtime_dir = "/home/user/.vm0/guest-agent/runs/previous-run";
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(session_id.as_bytes())),
            FinalSessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(b"history")),
            b"history".len() as u64,
            "/home/user/.claude/projects/session.jsonl",
        )
        .unwrap();
        request.parts.restored_session_identity = Some(
            RestoredSessionIdentity::from_final_metadata(
                metadata,
                format!("{retained_runtime_dir}/final-session-history-identity.json"),
                retained_runtime_dir,
            )
            .unwrap(),
        );

        let _candidate = request
            .park_for_idle()
            .await
            .unwrap_or_else(|_| panic!("healthy guest should park"));

        let calls = overrides.exec_calls();
        let call = calls
            .iter()
            .find(|call| call.cmd.contains("prepare-for-reuse"))
            .expect("reuse preparation call");
        let reuse_request: ReusePreparationRequest = serde_json::from_slice(
            call.stdin_bytes
                .as_deref()
                .expect("reuse request should be sent on stdin"),
        )
        .unwrap();
        assert_eq!(
            reuse_request.current_runtime_dir,
            format!("/home/user/.vm0/guest-agent/runs/{run_id}")
        );
        assert_eq!(
            reuse_request.retained_runtime_dir.as_deref(),
            Some(retained_runtime_dir)
        );
    }

    #[tokio::test]
    async fn idle_park_request_success_preserves_reuse_metadata() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let sandbox_id = SandboxId::new_v4();
        let session_id = "session-metadata";
        let profile_name = "vm0/large";
        let source_ip = "10.99.0.42";
        let history_generation_run_id = RunId::new_v4();
        let budget_lease = make_budget_lease(2, 2048);
        add_healthy_reuse_preparation_matcher(&overrides);
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
        ));
        let sandbox = factory
            .create(SandboxConfig {
                id: sandbox_id,
                resources: ResourceLimits {
                    cpu_count: budget_lease.vcpu(),
                    memory_mb: budget_lease.memory_mb(),
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create sandbox");
        let storage_fingerprints = StorageFingerprints {
            storages: HashMap::from([(
                "/mnt/storage".into(),
                StorageFingerprint::new("storage-a", "storage-version-2"),
            )]),
            artifacts: HashMap::from([(
                "/workspace".into(),
                StorageFingerprint::new("artifact-a", "artifact-version-3"),
            )]),
        };
        let expected_storage_fingerprints = storage_fingerprints.clone();
        let restored_session_identity =
            RestoredSessionIdentity::claude_code_for_test("history-hash-a");
        let request = IdleParkRequest::new(IdleParkRequestParts {
            run_id: RunId::new_v4(),
            sandbox,
            factory,
            reuse_key: session_id.into(),
            sandbox_id,
            profile_name: profile_name.into(),
            device_rate_limits: None,
            budget_lease,
            source_ip: source_ip.into(),
            storage_fingerprints,
            restored_session_identity: Some(restored_session_identity.clone()),
            history_generation_run_id: Some(history_generation_run_id),
            workspace_image_size_bytes: 0,
            workspace_promotion: None,
        });

        let candidate = match request.park_for_idle().await {
            Ok(outcome) => outcome.expect_reusable(),
            Err(_) => panic!("park should succeed"),
        };

        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(candidate.reuse_key(), session_id);
        assert_eq!(candidate.sandbox_id(), sandbox_id);
        assert_eq!(candidate.metadata.profile_name, profile_name);
        assert_eq!(
            candidate.metadata.history_generation_run_id,
            Some(history_generation_run_id)
        );

        let mut pool = IdlePool::new(pool_config(0));
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let reservation = pool
            .reserve_reusable(session_id, profile_name, &None)
            .expect("idle entry should be reserved");

        let IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } = reservation.try_unpark().await
        else {
            panic!("unpark should succeed");
        };
        let sandbox = *sandbox;
        assert_eq!(sandbox.sandbox_id(), sandbox_id);
        let reused_parts = sandbox.into_parts();
        assert_eq!(reused_parts.source_ip, source_ip);
        assert_eq!(
            reused_parts.restored_session_identity,
            Some(restored_session_identity)
        );
        assert_eq!(
            reused_parts.storage_fingerprints.storages,
            expected_storage_fingerprints.storages
        );
        assert_eq!(
            reused_parts.storage_fingerprints.artifacts,
            expected_storage_fingerprints.artifacts
        );
        assert_eq!(budget_lease.vcpu(), 2);
        assert_eq!(budget_lease.memory_mb(), 2048);
    }

    #[tokio::test]
    async fn idle_park_request_error_returns_owned_failure_parts() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
            transition: sandbox::SandboxIdleTransition::Park,
            message: "simulated park error".into(),
        }));
        let request = make_idle_park_request(
            Arc::clone(&overrides),
            "session-1",
            make_budget_lease(2, 2048),
        )
        .await;

        let failure = match request.park_for_idle().await {
            Ok(_) => panic!("park should fail"),
            Err(failure) => failure,
        };
        let IdleParkFailureParts::Active { active, error, .. } = failure.into_parts() else {
            panic!("park operation errors must retain active ownership");
        };

        assert_eq!(overrides.park_call_count(), 1);
        assert!(error.contains("simulated park error"));
        assert_eq!(active.budget_lease.vcpu(), 2);
        assert_eq!(active.budget_lease.memory_mb(), 2048);
    }

    #[tokio::test]
    async fn idle_park_request_panic_returns_owned_failure_parts() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_park_panic("simulated park panic");
        let request = make_idle_park_request(
            Arc::clone(&overrides),
            "session-1",
            make_budget_lease(2, 2048),
        )
        .await;

        let failure = match request.park_for_idle().await {
            Ok(_) => panic!("park should panic"),
            Err(failure) => failure,
        };
        let IdleParkFailureParts::Active { active, error, .. } = failure.into_parts() else {
            panic!("park panics must retain active ownership");
        };

        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(error, "sandbox park panicked");
        assert_eq!(active.budget_lease.vcpu(), 2);
        assert_eq!(active.budget_lease.memory_mb(), 2048);
    }

    #[test]
    fn park_and_take() {
        let mut pool = IdlePool::new(pool_config(0));
        assert_eq!(pool.len(), 0);

        let result = pool.park(make_candidate_for("session-1", 2, 2048));
        assert!(matches!(result, ParkResult::Parked));
        assert_eq!(pool.len(), 1);

        let entry = pool.take("session-1").unwrap();
        assert_eq!(entry.budget_vcpu(), 2);
        assert_eq!(entry.budget_memory_mb(), 2048);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn reusable_reservation_is_exclusive_and_restorable() {
        let mut pool = IdlePool::new(pool_config(0));
        let candidate = make_candidate_for("session-reserved", 2, 2048);
        let sandbox_id = candidate.sandbox_id();
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let parked_revision = pool.status_snapshot().revision;

        assert!(
            pool.reserve_reusable("session-reserved", "vm0/large", &None)
                .is_none(),
            "profile mismatch must not reserve the idle entry"
        );
        let reservation = pool
            .reserve_reusable("session-reserved", "vm0/default", &None)
            .expect("matching idle entry should be reserved");
        assert_eq!(pool.len(), 0);
        assert_eq!(pool.status_snapshot().revision, parked_revision + 1);
        assert!(
            pool.reserve_reusable("session-reserved", "vm0/default", &None)
                .is_none(),
            "a removed reservation cannot be acquired twice"
        );

        assert!(matches!(
            pool.restore_reserved(reservation),
            RestoreReservedIdleResult::Restored
        ));
        assert_eq!(pool.len(), 1);
        assert_eq!(pool.status_snapshot().revision, parked_revision + 2);
        assert_eq!(pool.status_snapshot().idle_vms[0].sandbox_id, sandbox_id);
    }

    #[test]
    fn reusable_generation_reservation_requires_exact_generation() {
        let mut pool = IdlePool::new(pool_config(0));
        let held_generation_run_id = RunId::new_v4();
        let requested_generation_run_id = RunId::new_v4();
        let candidate =
            ParkedIdleCandidateBuilder::new("session-generation", make_budget_lease(2, 2048))
                .with_history_generation_run_id(held_generation_run_id)
                .with_last_completed_at("2026-07-15T00:00:00.000Z")
                .build();
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let parked_revision = pool.status_snapshot().revision;

        assert!(
            pool.reserve_reusable_generation(
                "session-generation",
                "vm0/default",
                &None,
                requested_generation_run_id,
            )
            .is_none(),
            "a different generation must remain parked"
        );
        assert_eq!(pool.len(), 1);
        assert_eq!(pool.status_snapshot().revision, parked_revision);

        let _reservation = pool
            .reserve_reusable_generation(
                "session-generation",
                "vm0/default",
                &None,
                held_generation_run_id,
            )
            .expect("the exact generation should reserve");
        assert_eq!(pool.len(), 0);
    }

    #[tokio::test]
    async fn reserved_restore_preserves_newer_same_session_entry() {
        let mut pool = IdlePool::new(pool_config(0));
        let old = make_candidate_for("session-collision", 2, 2048);
        let old_sandbox_id = old.sandbox_id();
        assert!(matches!(pool.park(old), ParkResult::Parked));
        let reservation = pool
            .reserve_reusable("session-collision", "vm0/default", &None)
            .expect("old entry should reserve");

        let replacement = make_candidate_for("session-collision", 2, 2048);
        let replacement_sandbox_id = replacement.sandbox_id();
        assert!(matches!(pool.park(replacement), ParkResult::Parked));
        let RestoreReservedIdleResult::Rejected(rejected) = pool.restore_reserved(reservation)
        else {
            panic!("collision must reject the older reservation");
        };
        assert_eq!(
            pool.status_snapshot().idle_vms[0].sandbox_id,
            replacement_sandbox_id
        );
        assert_ne!(old_sandbox_id, replacement_sandbox_id);
        rejected.run().await;
        assert_eq!(pool.len(), 1);
    }

    #[tokio::test]
    async fn reserved_restore_rejects_after_parking_closes() {
        let mut pool = IdlePool::new(pool_config(0));
        assert!(matches!(
            pool.park(make_candidate_for("session-closed", 2, 2048)),
            ParkResult::Parked
        ));
        let reservation = pool
            .reserve_reusable("session-closed", "vm0/default", &None)
            .expect("entry should reserve");
        pool.parking_gate().close();

        let RestoreReservedIdleResult::Rejected(rejected) = pool.restore_reserved(reservation)
        else {
            panic!("closed parking must reject reservation restore");
        };
        rejected.run().await;
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn park_uses_candidate_reuse_key_as_pool_key() {
        let mut pool = IdlePool::new(pool_config(0));
        let result = pool.park(make_candidate_for("candidate-session", 2, 2048));
        assert!(matches!(result, ParkResult::Parked));

        assert!(
            pool.take("caller-provided-session").is_none(),
            "park no longer accepts a separate reuse key"
        );
        assert!(pool.take("candidate-session").is_some());
    }

    #[test]
    fn take_missing_returns_none() {
        let mut pool = IdlePool::new(pool_config(0));
        assert!(pool.take("nonexistent").is_none());
    }

    #[test]
    fn park_same_reuse_key_evicts_previous() {
        let mut pool = IdlePool::new(pool_config(0));

        let _ = pool.park(make_candidate_for("session-1", 2, 2048));
        let result = pool.park(make_candidate_for("session-1", 4, 4096));

        match result {
            ParkResult::Replaced(evicted) => {
                assert_eq!(evicted.budget_vcpu(), 2);
                assert_eq!(evicted.budget_memory_mb(), 2048);
            }
            _ => panic!("expected Replaced"),
        }

        assert_eq!(pool.len(), 1);
        let entry = pool.take("session-1").unwrap();
        assert_eq!(entry.budget_vcpu(), 4);
    }

    #[test]
    fn park_respects_max_idle() {
        let mut pool = IdlePool::new(pool_config(2));

        let _ = pool.park(make_candidate_for("s1", 2, 2048));
        let _ = pool.park(make_candidate_for("s2", 2, 2048));

        // Third session should fail
        let result = pool.park(make_candidate_for("s3", 2, 2048));
        assert!(matches!(result, ParkResult::Rejected(_)));
        assert_eq!(pool.len(), 2);

        // But replacing existing session should work
        let result = pool.park(make_candidate_for("s1", 4, 4096));
        assert!(matches!(result, ParkResult::Replaced(_)));
        assert_eq!(pool.len(), 2);
    }

    #[tokio::test]
    async fn rejected_parked_idle_candidate_returns_active_owned_lease() {
        let mut pool = IdlePool::new(pool_config(1));
        let _ = pool.park(make_candidate_for("existing", 2, 2048));

        let rejected_budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
        let rejected_lease = ResourceBudget::try_reserve_lease(&rejected_budget, 2, 2048).unwrap();
        let result = pool.park(make_candidate_for_with_lease("rejected", rejected_lease));

        let ParkResult::Rejected(rejected) = result else {
            panic!("expected rejected parked idle candidate");
        };
        assert_eq!(
            rejected_budget.allocated().2,
            1,
            "rejected candidate must retain active job lease"
        );

        let (payload, lease) = rejected.into_active_destroy_parts();
        assert_eq!(
            rejected_budget.allocated().2,
            1,
            "splitting physical destroy from lease must keep active capacity"
        );
        payload.stop_and_destroy().await;
        drop(lease);
        assert_eq!(rejected_budget.allocated().2, 0);
    }

    #[test]
    fn evict_expired() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        // Entry expired 10s ago
        let _ = park_at(
            &mut pool,
            "expired",
            make_candidate_for("expired", 2, 2048),
            now - Duration::from_secs(310),
            Duration::from_secs(300),
        );
        // Entry still fresh
        let _ = park_at(
            &mut pool,
            "fresh",
            make_candidate_for("fresh", 2, 2048),
            now,
            Duration::from_secs(300),
        );

        let evicted = pool.evict_expired();
        assert_eq!(evicted.len(), 1);
        assert_eq!(pool.len(), 1);
        assert!(pool.take("fresh").is_some());
    }

    #[test]
    fn evict_expired_with_snapshot_none_expired_keeps_revision() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();
        let fresh = make_candidate_for("fresh", 2, 2048);
        let fresh_sandbox_id = fresh.sandbox_id();
        let _ = park_at(&mut pool, "fresh", fresh, now, Duration::from_secs(300));
        let before_revision = pool.status_snapshot().revision;

        let (evicted, snapshot) = pool.evict_expired_with_snapshot();

        assert!(evicted.is_empty());
        assert_eq!(pool.len(), 1);
        assert_eq!(snapshot.revision, before_revision);
        assert_eq!(snapshot.idle_vms.len(), 1);
        assert_eq!(snapshot.idle_vms[0].reuse_key, "fresh");
        assert_eq!(snapshot.idle_vms[0].sandbox_id, fresh_sandbox_id);
    }

    #[test]
    fn evict_expired_with_snapshot_returns_retained_entries_sorted() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        let expired = make_candidate_for("expired", 2, 2048);
        let _ = park_at(
            &mut pool,
            "expired",
            expired,
            now - Duration::from_secs(310),
            Duration::from_secs(300),
        );
        let retained_b = make_candidate_for("sess-b", 4, 4096);
        let retained_b_sandbox_id = retained_b.sandbox_id();
        let _ = park_at(
            &mut pool,
            "sess-b",
            retained_b,
            now,
            Duration::from_secs(300),
        );
        let retained_a = make_candidate_for("sess-a", 1, 1024);
        let retained_a_sandbox_id = retained_a.sandbox_id();
        let _ = park_at(
            &mut pool,
            "sess-a",
            retained_a,
            now,
            Duration::from_secs(300),
        );
        let before_revision = pool.status_snapshot().revision;

        let (evicted, snapshot) = pool.evict_expired_with_snapshot();

        assert_eq!(evicted.len(), 1);
        assert_eq!(pool.len(), 2);
        assert_eq!(snapshot.revision, before_revision + 1);
        assert_eq!(snapshot.idle_vms.len(), 2);
        assert_eq!(snapshot.idle_vms[0].reuse_key, "sess-a");
        assert_eq!(snapshot.idle_vms[0].sandbox_id, retained_a_sandbox_id);
        assert_eq!(snapshot.idle_vms[1].reuse_key, "sess-b");
        assert_eq!(snapshot.idle_vms[1].sandbox_id, retained_b_sandbox_id);
    }

    #[test]
    fn evict_expired_with_snapshot_all_expired_returns_empty_snapshot() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        let _ = park_at(
            &mut pool,
            "s1",
            make_candidate_for("s1", 2, 2048),
            now - Duration::from_secs(400),
            Duration::from_secs(300),
        );
        let _ = park_at(
            &mut pool,
            "s2",
            make_candidate_for("s2", 4, 4096),
            now - Duration::from_secs(310),
            Duration::from_secs(300),
        );
        let before_revision = pool.status_snapshot().revision;

        let (evicted, snapshot) = pool.evict_expired_with_snapshot();

        assert_eq!(evicted.len(), 2);
        assert_eq!(pool.len(), 0);
        assert_eq!(snapshot.revision, before_revision + 1);
        assert!(snapshot.idle_vms.is_empty());
    }

    #[test]
    fn evict_oldest() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        let _ = park_at(
            &mut pool,
            "old",
            make_candidate_for("old", 2, 2048),
            now - Duration::from_secs(100),
            Duration::from_secs(300),
        );
        let _ = park_at(
            &mut pool,
            "new",
            make_candidate_for("new", 4, 4096),
            now,
            Duration::from_secs(300),
        );

        let evicted = pool.evict_oldest().unwrap();
        assert_eq!(evicted.budget_vcpu(), 2); // the old one
        assert_eq!(pool.len(), 1);
        assert!(pool.take("new").is_some());
    }

    #[test]
    fn evict_oldest_empty_returns_none() {
        let mut pool = IdlePool::new(pool_config(0));
        assert!(pool.evict_oldest().is_none());
    }

    #[test]
    fn held_reuse_keys() {
        let mut pool = IdlePool::new(pool_config(0));
        let _ = pool.park(make_candidate_for("s1", 2, 2048));
        let _ = pool.park(make_candidate_for("s2", 2, 2048));

        let reuse_keys = pool.held_reuse_keys();
        assert_eq!(reuse_keys, vec!["s1", "s2"]);
    }

    #[test]
    fn held_sandbox_states_include_only_entries_with_timestamps() {
        let mut pool = IdlePool::new(pool_config(0));
        let history_generation_run_id = RunId::new_v4();
        let unconfirmed = make_candidate_for("sess-unconfirmed", 2, 2048);
        let confirmed_b = make_candidate_for("sess-b", 2, 2048)
            .with_last_completed_at("2026-05-28T00:00:01.000Z".to_string());
        let confirmed_a = ParkedIdleCandidateBuilder::new("sess-a", make_budget_lease(2, 2048))
            .with_mock_sandbox_name("test")
            .with_history_generation_run_id(history_generation_run_id)
            .with_last_completed_at("2026-05-28T00:00:00.000Z")
            .build();

        let _ = pool.park(unconfirmed);
        let _ = pool.park(confirmed_b);
        let _ = pool.park(confirmed_a);

        assert_eq!(
            pool.held_sandbox_states(),
            vec![
                HeldSandboxState {
                    reuse_key: "sess-a".to_string(),
                    last_completed_at: "2026-05-28T00:00:00.000Z".to_string(),
                    reusable_sandbox: ReusableSandboxState {
                        profile: "vm0/default".to_string(),
                        history_generation_run_id: Some(history_generation_run_id),
                    },
                },
                HeldSandboxState {
                    reuse_key: "sess-b".to_string(),
                    last_completed_at: "2026-05-28T00:00:01.000Z".to_string(),
                    reusable_sandbox: ReusableSandboxState {
                        profile: "vm0/default".to_string(),
                        history_generation_run_id: None,
                    },
                },
            ],
        );
    }

    #[test]
    fn held_snapshot_pairs_and_sorts() {
        // Park in reverse order to ensure sort kicks in.
        let mut pool = IdlePool::new(pool_config(0));
        let entry_b = make_candidate_for("sess-b", 2, 2048);
        let sid_b = entry_b.sandbox_id();
        let entry_a = make_candidate_for("sess-a", 2, 2048);
        let sid_a = entry_a.sandbox_id();
        let _ = pool.park(entry_b);
        let _ = pool.park(entry_a);

        let vms = pool.held_snapshot();
        assert_eq!(vms.len(), 2);
        assert_eq!(vms[0].reuse_key, "sess-a");
        assert_eq!(vms[0].sandbox_id, sid_a);
        assert_eq!(vms[1].reuse_key, "sess-b");
        assert_eq!(vms[1].sandbox_id, sid_b);
    }

    #[test]
    fn held_snapshot_empty_pool() {
        let pool = IdlePool::new(pool_config(0));
        assert!(pool.held_snapshot().is_empty());
    }

    #[test]
    fn contains_sandbox_id_tracks_current_idle_ownership() {
        let mut pool = IdlePool::new(pool_config(0));
        let candidate = make_candidate_for("s1", 2, 2048);
        let sandbox_id = candidate.sandbox_id();
        assert!(!pool.contains_sandbox_id(sandbox_id));

        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        assert!(pool.contains_sandbox_id(sandbox_id));

        assert!(pool.take("s1").is_some());
        assert!(!pool.contains_sandbox_id(sandbox_id));
    }

    #[test]
    fn status_snapshot_revision_tracks_idle_vm_mutations() {
        let mut pool = IdlePool::new(pool_config(0));
        assert_eq!(pool.status_snapshot().revision, 0);

        let _ = pool.park(make_candidate_for("s1", 2, 2048));
        assert_eq!(pool.status_snapshot().revision, 1);

        assert!(pool.take("s1").is_some());
        assert_eq!(pool.status_snapshot().revision, 2);

        let drained = pool.drain();
        assert!(drained.is_empty());
        assert_eq!(
            pool.status_snapshot().revision,
            2,
            "empty drain must not create a fake idle_vms mutation",
        );

        let _ = pool.park(make_candidate_for("s2", 2, 2048));
        assert_eq!(pool.status_snapshot().revision, 3);

        let drained = pool.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!(pool.status_snapshot().revision, 4);
    }

    #[test]
    fn drain() {
        let mut pool = IdlePool::new(pool_config(0));
        let _ = pool.park(make_candidate_for("s1", 2, 2048));
        let _ = pool.park(make_candidate_for("s2", 4, 4096));

        let drained = pool.drain();
        assert_eq!(drained.len(), 2);
        assert_eq!(pool.len(), 0);
        assert_eq!(pool.parking_state(), ParkingState::Open);
    }

    #[test]
    fn park_rejected_while_soft_draining() {
        let mut pool = IdlePool::new(pool_config(0));
        let gate = pool.parking_gate();
        let _ = pool.park(make_candidate_for("s1", 2, 2048));
        gate.soft_drain();
        assert_eq!(pool.parking_state(), ParkingState::SoftDraining);

        let result = pool.park(make_candidate_for("s2", 4, 4096));
        assert!(matches!(result, ParkResult::Rejected(_)));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn park_rejected_when_closed() {
        let mut pool = IdlePool::new(pool_config(0));
        let gate = pool.parking_gate();
        gate.close();

        let result = pool.park(make_candidate_for("s1", 2, 2048));
        assert!(matches!(result, ParkResult::Rejected(_)));
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn soft_drain_can_reopen_parking() {
        let mut pool = IdlePool::new(pool_config(0));
        let gate = pool.parking_gate();
        gate.soft_drain();
        assert!(matches!(
            pool.park(make_candidate_for("s1", 2, 2048)),
            ParkResult::Rejected(_)
        ));

        gate.open_after_soft_drain();
        let result = pool.park(make_candidate_for("s1", 2, 2048));
        assert!(matches!(result, ParkResult::Parked));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn evict_expired_none_expired() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();
        let _ = park_at(
            &mut pool,
            "fresh",
            make_candidate_for("fresh", 2, 2048),
            now,
            Duration::from_secs(300),
        );
        let evicted = pool.evict_expired();
        assert!(evicted.is_empty());
        assert_eq!(pool.len(), 1);
        assert_eq!(pool.status_snapshot().revision, 1);
    }

    #[test]
    fn drain_empty_pool() {
        let mut pool = IdlePool::new(pool_config(0));
        let drained = pool.drain();
        assert!(drained.is_empty());
        assert_eq!(pool.parking_state(), ParkingState::Open);
    }

    #[test]
    fn evict_expired_all_entries() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        let _ = park_at(
            &mut pool,
            "s1",
            make_candidate_for("s1", 2, 2048),
            now - Duration::from_secs(400),
            Duration::from_secs(300),
        );
        let _ = park_at(
            &mut pool,
            "s2",
            make_candidate_for("s2", 4, 4096),
            now - Duration::from_secs(310),
            Duration::from_secs(300),
        );
        assert_eq!(pool.len(), 2);

        let evicted = pool.evict_expired();
        assert_eq!(evicted.len(), 2);
        assert_eq!(pool.len(), 0);
        assert_eq!(pool.status_snapshot().revision, 3);
    }

    #[test]
    fn evict_expired_respects_per_entry_timeout() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        // Short timeout (60s), parked 70s ago → expired
        let _ = park_at(
            &mut pool,
            "short",
            make_candidate_for("short", 2, 2048),
            now - Duration::from_secs(70),
            Duration::from_secs(60),
        );
        // Long timeout (300s), parked 70s ago → NOT expired
        let _ = park_at(
            &mut pool,
            "long",
            make_candidate_for("long", 4, 4096),
            now - Duration::from_secs(70),
            Duration::from_secs(300),
        );

        let evicted = pool.evict_expired();
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].budget_vcpu(), 2); // only the short-timeout entry
        assert_eq!(pool.len(), 1);
        assert!(pool.take("long").is_some());
    }

    #[test]
    fn park_max_idle_one() {
        let mut pool = IdlePool::new(pool_config(1));

        let result = pool.park(make_candidate_for("s1", 2, 2048));
        assert!(matches!(result, ParkResult::Parked));

        // Second different session rejected
        let result = pool.park(make_candidate_for("s2", 4, 4096));
        assert!(matches!(result, ParkResult::Rejected(_)));
        assert_eq!(pool.len(), 1);

        // Same session replacement still works
        let result = pool.park(make_candidate_for("s1", 8, 8192));
        assert!(matches!(result, ParkResult::Replaced(_)));
        assert_eq!(pool.len(), 1);
        let entry = pool.take("s1").unwrap();
        assert_eq!(entry.budget_vcpu(), 8);
    }
}
