use std::panic::AssertUnwindSafe;
use std::sync::Arc;

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
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityRequest,
};
use crate::workspace_promotion::abandon_unpublished_workspace_promotion;

use super::entry::{
    IdleSandboxMetadata, IdleSandboxResources, ParkedIdleCandidate, RejectedParkedIdleCandidate,
};

/// One-shot request to transition an active sandbox into same-reuse-key idle
/// ownership.
#[must_use = "idle park requests own active sandbox and budget; call park_for_idle"]
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
