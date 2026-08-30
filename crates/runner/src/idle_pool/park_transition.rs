use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use guest_contracts::reuse_preparation::ReusePreparationReport;
use sandbox::{
    DeviceRateLimits, Sandbox, SandboxFactory, SandboxFinalExecParkHandoff,
    SandboxFinalExecParkHandoffOutcome, SandboxFinalExecParkObserver, SandboxId,
    SandboxParkNonReusableReason, SandboxParkOutcome,
};

use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_reuse_preparation::IdleReusePreparation;
use crate::ids::RunId;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityRequest,
};
use crate::workspace_promotion::abandon_unpublished_workspace_promotion;

use super::entry::{
    IdleDestroyJob, IdleDestroyPayload, IdleEntry, IdleSandboxMetadata, IdleSandboxResources,
    ImmediateHandoffCandidate, ParkedIdleCandidate, RejectedParkedIdleCandidate,
    ReservedIdleSandbox, SpeculativeIdleSandbox, WorkspacePromotionPolicy,
};

/// One-shot request to transition an active sandbox into same-reuse-key idle
/// ownership.
#[must_use = "idle park requests own active sandbox and budget; call a park_for_idle method"]
pub(crate) struct IdleParkRequest {
    pub(super) parts: IdleParkRequestParts,
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
    pub(crate) guest_timezone_intent: GuestTimezoneIntent,
    pub(crate) workspace_image_size_bytes: u64,
    pub(crate) workspace_promotion: Option<WorkspaceImagePromotionContext>,
    pub(crate) handoff: Option<SandboxFinalExecParkHandoff>,
}

/// Result after the sandbox successfully reaches the parked state.
#[must_use = "parked outcomes must be admitted for reuse or explicitly destroyed"]
pub(crate) enum IdleParkOutcome {
    Reusable(ParkedIdleCandidate),
    Handoff(ImmediateHandoffCandidate),
    NonReusable {
        candidate: ParkedIdleCandidate,
        reason: SandboxParkNonReusableReason,
        preparation_report: ReusePreparationReport,
    },
}

pub(crate) enum IdleParkCandidate {
    Ordinary(ParkedIdleCandidate),
    Immediate(ImmediateHandoffCandidate),
}

impl IdleParkCandidate {
    pub(crate) fn with_last_completed_at(self, last_completed_at: String) -> Self {
        match self {
            Self::Ordinary(candidate) => {
                Self::Ordinary(candidate.with_last_completed_at(last_completed_at))
            }
            Self::Immediate(candidate) => {
                Self::Immediate(candidate.with_last_completed_at(last_completed_at))
            }
        }
    }

    pub(crate) fn into_active_destroy_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        match self {
            Self::Ordinary(candidate) => candidate.into_active_destroy_parts(),
            Self::Immediate(candidate) => candidate.into_active_destroy_parts(),
        }
    }
}

pub(crate) struct IdleParkNonReusable {
    pub(crate) reason: SandboxParkNonReusableReason,
    pub(crate) preparation_report: ReusePreparationReport,
}

#[must_use = "idle park failures must be explicitly destroyed or otherwise handled"]
pub(crate) struct IdleParkFailure {
    ownership: IdleParkFailureOwnership,
    reason: &'static str,
    error: String,
    expected_capacity_rejection: bool,
}

enum IdleParkFailureOwnership {
    Active {
        resources: Box<IdleSandboxResources>,
        budget_lease: BudgetLease,
    },
    Parked {
        rejected: Box<RejectedParkedIdleCandidate>,
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
        expected_capacity_rejection: bool,
    },
}

struct IdleParkTransitionInput {
    /// Run that triggered this transition and owns its diagnostics.
    operation_run_id: RunId,
    /// Run whose guest runtime directory must survive reuse cleanup.
    current_runtime_run_id: RunId,
    resources: IdleSandboxResources,
    metadata: IdleSandboxMetadata,
    budget_lease: BudgetLease,
    workspace_image_size_bytes: u64,
}

pub(crate) enum SpeculativeReparkResult {
    Reparked(Box<ReservedIdleSandbox>),
    Destroy {
        destroy_job: Box<IdleDestroyJob>,
        reason: &'static str,
        error: String,
        expected_capacity_rejection: bool,
    },
}

impl IdleParkRequest {
    pub(crate) fn new(parts: IdleParkRequestParts) -> Self {
        Self { parts }
    }

    #[cfg(test)]
    pub(crate) async fn park_for_idle(self) -> Result<IdleParkOutcome, IdleParkFailure> {
        self.park_for_idle_with_optional_observer(None).await
    }

    pub(crate) async fn park_for_idle_with_observer(
        self,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<IdleParkOutcome, IdleParkFailure> {
        self.park_for_idle_with_optional_observer(Some(observer))
            .await
    }

    async fn park_for_idle_with_optional_observer(
        self,
        observer: Option<&mut dyn SandboxFinalExecParkObserver>,
    ) -> Result<IdleParkOutcome, IdleParkFailure> {
        let IdleParkRequestParts {
            run_id,
            sandbox,
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
            guest_timezone_intent,
            workspace_image_size_bytes,
            workspace_promotion,
            handoff,
        } = self.parts;

        let metadata = IdleSandboxMetadata {
            reuse_key,
            sandbox_id,
            profile_name,
            device_rate_limits,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            guest_timezone_intent,
            last_completed_at: None,
        };

        park_idle_transition(
            IdleParkTransitionInput {
                operation_run_id: run_id,
                current_runtime_run_id: run_id,
                resources: IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                },
                metadata,
                budget_lease,
                workspace_image_size_bytes,
            },
            observer,
            handoff,
        )
        .await
    }
}

async fn park_idle_transition(
    input: IdleParkTransitionInput,
    observer: Option<&mut dyn SandboxFinalExecParkObserver>,
    handoff: Option<SandboxFinalExecParkHandoff>,
) -> Result<IdleParkOutcome, IdleParkFailure> {
    let IdleParkTransitionInput {
        operation_run_id,
        current_runtime_run_id,
        resources,
        metadata,
        budget_lease,
        workspace_image_size_bytes,
    } = input;
    let IdleSandboxResources {
        mut sandbox,
        factory,
        workspace_promotion,
    } = resources;
    let retained_runtime_dir = metadata
        .restored_session_identity
        .as_ref()
        .and_then(RestoredSessionIdentity::final_metadata_verification)
        .map(|verification| verification.runtime_dir.to_owned());

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
        abandon_unpublished_workspace_promotion(workspace_promotion, "promotion_identity_mismatch")
            .await;
        return Err(IdleParkFailure {
            ownership: IdleParkFailureOwnership::Active {
                resources: Box::new(IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion: None,
                }),
                budget_lease,
            },
            reason: "promotion_identity_mismatch",
            error: format!("workspace promotion identity mismatch: {mismatch}"),
            expected_capacity_rejection: false,
        });
    }

    let preparation = match IdleReusePreparation::new(
        sandbox.id(),
        operation_run_id,
        current_runtime_run_id,
        retained_runtime_dir.as_deref(),
    ) {
        Ok(preparation) => preparation,
        Err(error) => {
            return Err(IdleParkFailure {
                ownership: IdleParkFailureOwnership::Active {
                    resources: Box::new(IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion,
                    }),
                    budget_lease,
                },
                reason: "reuse_preparation_failed",
                error: error.to_string(),
                expected_capacity_rejection: false,
            });
        }
    };

    let final_exec_and_park = {
        let request = preparation.exec_request();
        let transition = async {
            match (observer, handoff.as_ref()) {
                (Some(observer), Some(handoff)) => {
                    sandbox
                        .final_exec_and_park_for_handoff(
                            &request,
                            "idle-reuse-preparation-and-park",
                            handoff,
                            observer,
                        )
                        .await
                }
                (Some(observer), None) => sandbox
                    .final_exec_and_park_with_observer(
                        &request,
                        "idle-reuse-preparation-and-park",
                        observer,
                    )
                    .await
                    .map(SandboxFinalExecParkHandoffOutcome::Parked),
                (None, _) => sandbox
                    .final_exec_and_park(&request, "idle-reuse-preparation-and-park")
                    .await
                    .map(SandboxFinalExecParkHandoffOutcome::Parked),
            }
        };
        AssertUnwindSafe(transition).catch_unwind().await
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
            let exec_result = match &outcome {
                SandboxFinalExecParkHandoffOutcome::Parked(outcome) => &outcome.exec_result,
                SandboxFinalExecParkHandoffOutcome::Handoff { exec_result, .. } => exec_result,
            };
            let preparation_report = match preparation.validate_result(exec_result) {
                Ok(report) => report,
                Err(error) => {
                    let expected_capacity_rejection = error.is_expected_capacity_rejection();
                    return Err(IdleParkFailure {
                        ownership: IdleParkFailureOwnership::Parked {
                            rejected: Box::new(candidate.into_rejected()),
                        },
                        reason: "reuse_preparation_failed",
                        error: error.to_string(),
                        expected_capacity_rejection,
                    });
                }
            };
            Ok(match outcome {
                SandboxFinalExecParkHandoffOutcome::Handoff { point, .. } => {
                    IdleParkOutcome::Handoff(candidate.into_immediate_handoff(point))
                }
                SandboxFinalExecParkHandoffOutcome::Parked(outcome) => match outcome.park_outcome {
                    SandboxParkOutcome::Reusable => IdleParkOutcome::Reusable(candidate),
                    SandboxParkOutcome::NonReusable(reason) => IdleParkOutcome::NonReusable {
                        candidate,
                        reason,
                        preparation_report,
                    },
                },
            })
        }
        Ok(Err(error)) => Err(IdleParkFailure {
            ownership: IdleParkFailureOwnership::Active {
                resources: Box::new(IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                }),
                budget_lease,
            },
            reason: "park_failed",
            error: error.to_string(),
            expected_capacity_rejection: false,
        }),
        Err(_) => {
            // A panic leaves the park transition state uncertain; destroy
            // the sandbox, but do not publish a workspace cache image.
            abandon_unpublished_workspace_promotion(workspace_promotion, "park_panicked").await;
            Err(IdleParkFailure {
                ownership: IdleParkFailureOwnership::Active {
                    resources: Box::new(IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion: None,
                    }),
                    budget_lease,
                },
                reason: "park_panicked",
                error: "sandbox park panicked".into(),
                expected_capacity_rejection: false,
            })
        }
    }
}

impl SpeculativeIdleSandbox {
    pub(crate) async fn repark_for_claim_rollback(
        self,
        operation_run_id: RunId,
        workspace_image_size_bytes: u64,
    ) -> SpeculativeReparkResult {
        let Some(current_runtime_run_id) = self.entry.metadata.history_generation_run_id else {
            const REASON: &str = "speculative_repark_missing_history_generation";
            return SpeculativeReparkResult::Destroy {
                destroy_job: Box::new(self.into_destroy_job(REASON)),
                reason: REASON,
                error: "speculative exact-reuse entry is missing a history generation".into(),
                expected_capacity_rejection: false,
            };
        };
        let Self { entry } = self;
        let IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at,
        } = entry;
        let reuse_key = metadata.reuse_key.clone();
        let profile_name = metadata.profile_name.clone();
        match park_idle_transition(
            IdleParkTransitionInput {
                operation_run_id,
                current_runtime_run_id,
                resources,
                metadata,
                budget_lease,
                workspace_image_size_bytes,
            },
            None,
            None,
        )
        .await
        {
            Ok(IdleParkOutcome::Reusable(candidate)) => {
                SpeculativeReparkResult::Reparked(Box::new(ReservedIdleSandbox {
                    entry: candidate.into_idle_entry(parked_at),
                }))
            }
            Ok(IdleParkOutcome::Handoff(candidate)) => {
                let (payload, budget_lease) = candidate.into_active_destroy_parts();
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(IdleDestroyJob {
                        payload,
                        budget_lease,
                        reuse_key,
                        profile_name,
                    }),
                    reason: "speculative_repark_unexpected_handoff",
                    error: "speculative re-park unexpectedly produced an immediate handoff".into(),
                    expected_capacity_rejection: false,
                }
            }
            Ok(IdleParkOutcome::NonReusable {
                candidate, reason, ..
            }) => {
                let (payload, budget_lease) = candidate.into_active_destroy_parts();
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(IdleDestroyJob {
                        payload,
                        budget_lease,
                        reuse_key,
                        profile_name,
                    }),
                    reason: "speculative_repark_non_reusable",
                    error: format!("re-parked sandbox is not reusable: {}", reason.as_str()),
                    expected_capacity_rejection: false,
                }
            }
            Err(failure) => {
                let (destroy_job, reason, error, expected_capacity_rejection) =
                    failure.into_speculative_destroy_job(reuse_key, profile_name);
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(destroy_job),
                    reason,
                    error,
                    expected_capacity_rejection,
                }
            }
        }
    }
}

impl IdleParkOutcome {
    pub(crate) fn into_parts(self) -> (IdleParkCandidate, Option<IdleParkNonReusable>) {
        match self {
            Self::Reusable(candidate) => (IdleParkCandidate::Ordinary(candidate), None),
            Self::Handoff(candidate) => (IdleParkCandidate::Immediate(candidate), None),
            Self::NonReusable {
                candidate,
                reason,
                preparation_report,
            } => (
                IdleParkCandidate::Ordinary(candidate),
                Some(IdleParkNonReusable {
                    reason,
                    preparation_report,
                }),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn expect_reusable(self) -> ParkedIdleCandidate {
        match self {
            Self::Reusable(candidate) => candidate,
            Self::Handoff(_) => panic!("expected ordinary reusable parked candidate, got handoff"),
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
    fn into_speculative_destroy_job(
        self,
        reuse_key: String,
        profile_name: String,
    ) -> (IdleDestroyJob, &'static str, String, bool) {
        let Self {
            ownership,
            reason,
            error,
            expected_capacity_rejection,
        } = self;
        let (payload, budget_lease) = match ownership {
            IdleParkFailureOwnership::Active {
                resources,
                budget_lease,
            } => (
                (*resources)
                    .into_destroy_payload(WorkspacePromotionPolicy::AbandonUnpublished(reason)),
                budget_lease,
            ),
            IdleParkFailureOwnership::Parked { rejected } => {
                (*rejected).into_active_destroy_parts()
            }
        };
        (
            IdleDestroyJob {
                payload,
                budget_lease,
                reuse_key,
                profile_name,
            },
            reason,
            error,
            expected_capacity_rejection,
        )
    }

    pub(crate) fn into_parts(self) -> IdleParkFailureParts {
        let Self {
            ownership,
            reason,
            error,
            expected_capacity_rejection,
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
                } = *resources;
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
                rejected: *rejected,
                reason,
                error,
                expected_capacity_rejection,
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
