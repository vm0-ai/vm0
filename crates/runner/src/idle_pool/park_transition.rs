use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use sandbox::{
    DeviceRateLimits, Sandbox, SandboxFactory, SandboxFinalExecParkObserver, SandboxId,
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
    IdleDestroyJob, IdleEntry, IdleSandboxMetadata, IdleSandboxResources, ParkedIdleCandidate,
    RejectedParkedIdleCandidate, ReservedIdleSandbox, SpeculativeIdleSandbox,
    WorkspacePromotionPolicy,
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

struct IdleParkTransitionInput {
    run_id: RunId,
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
                run_id,
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
        )
        .await
    }
}

async fn park_idle_transition(
    input: IdleParkTransitionInput,
    observer: Option<&mut dyn SandboxFinalExecParkObserver>,
) -> Result<IdleParkOutcome, IdleParkFailure> {
    let IdleParkTransitionInput {
        run_id,
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

    let preparation =
        match IdleReusePreparation::new(sandbox.id(), run_id, retained_runtime_dir.as_deref()) {
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
        let transition = match observer {
            Some(observer) => sandbox.final_exec_and_park_with_observer(
                &request,
                "idle-reuse-preparation-and-park",
                observer,
            ),
            None => sandbox.final_exec_and_park(&request, "idle-reuse-preparation-and-park"),
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
        Ok(Err(error)) => Err(IdleParkFailure {
            ownership: IdleParkFailureOwnership::Active {
                resources: IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                },
                budget_lease,
            },
            reason: "park_failed",
            error: error.to_string(),
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

impl SpeculativeIdleSandbox {
    pub(crate) async fn repark_for_claim_rollback(
        self,
        run_id: RunId,
        workspace_image_size_bytes: u64,
    ) -> SpeculativeReparkResult {
        let Self { entry } = self;
        let IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at,
            idle_timeout,
        } = entry;
        let reuse_key = metadata.reuse_key.clone();
        let profile_name = metadata.profile_name.clone();
        match park_idle_transition(
            IdleParkTransitionInput {
                run_id,
                resources,
                metadata,
                budget_lease,
                workspace_image_size_bytes,
            },
            None,
        )
        .await
        {
            Ok(IdleParkOutcome::Reusable(candidate)) => {
                SpeculativeReparkResult::Reparked(Box::new(ReservedIdleSandbox {
                    entry: candidate.into_idle_entry(parked_at, idle_timeout),
                }))
            }
            Ok(IdleParkOutcome::NonReusable { candidate, reason }) => {
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
                }
            }
            Err(failure) => {
                let (destroy_job, reason, error) =
                    failure.into_speculative_destroy_job(reuse_key, profile_name);
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(destroy_job),
                    reason,
                    error,
                }
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
    fn into_speculative_destroy_job(
        self,
        reuse_key: String,
        profile_name: String,
    ) -> (IdleDestroyJob, &'static str, String) {
        let Self {
            ownership,
            reason,
            error,
        } = self;
        let (payload, budget_lease) = match ownership {
            IdleParkFailureOwnership::Active {
                resources,
                budget_lease,
            } => (
                resources
                    .into_destroy_payload(WorkspacePromotionPolicy::AbandonUnpublished(reason)),
                budget_lease,
            ),
            IdleParkFailureOwnership::Parked { rejected } => rejected.into_active_destroy_parts(),
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
        )
    }

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
