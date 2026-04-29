use sandbox::SandboxId;

use crate::ids::RunId;
use crate::provider::JobProvider;
use crate::resource_budget::BudgetLease;
use crate::status::StatusTracker;
use crate::types::SandboxReuseResult;

/// Budget ownership while a claimed job is active in the outer task.
pub(super) struct ActiveBudgetLease(BudgetLease);

impl ActiveBudgetLease {
    pub(super) fn new(lease: BudgetLease) -> Self {
        Self(lease)
    }

    pub(super) fn into_park_candidate_lease(self) -> BudgetLease {
        self.0
    }

    pub(super) fn from_rejected_park(lease: BudgetLease) -> Self {
        Self(lease)
    }
}

/// Budget ownership after sandbox finalization but before completion is reported.
#[must_use]
pub(super) enum BudgetOwnership {
    Active(ActiveBudgetLease),
    IdleOwned,
}

impl BudgetOwnership {
    pub(super) fn active(lease: ActiveBudgetLease) -> Self {
        Self::Active(lease)
    }

    pub(super) fn idle_owned() -> Self {
        Self::IdleOwned
    }

    fn release(self) {
        match self {
            Self::Active(lease) => drop(lease),
            Self::IdleOwned => {}
        }
    }
}

/// Data required for the provider completion call.
pub(super) struct CompletionPayload {
    run_id: RunId,
    exit_code: i32,
    error: Option<String>,
    sandbox_id: SandboxId,
    reuse_result: SandboxReuseResult,
}

impl CompletionPayload {
    pub(super) fn new(
        run_id: RunId,
        exit_code: i32,
        error: Option<String>,
        sandbox_id: SandboxId,
        reuse_result: SandboxReuseResult,
    ) -> Self {
        Self {
            run_id,
            exit_code,
            error,
            sandbox_id,
            reuse_result,
        }
    }
}

/// Sandbox cleanup/parking has finished; completion can now be reported.
#[must_use]
pub(super) struct CompletionReady {
    payload: CompletionPayload,
    budget: BudgetOwnership,
}

impl CompletionReady {
    pub(super) fn new(payload: CompletionPayload, budget: BudgetOwnership) -> Self {
        Self { payload, budget }
    }

    pub(super) async fn complete_and_release(
        self,
        provider: &dyn JobProvider,
        status: &StatusTracker,
    ) {
        let Self { payload, budget } = self;
        let CompletionPayload {
            run_id,
            exit_code,
            error,
            sandbox_id,
            reuse_result,
        } = payload;

        provider
            .complete(
                run_id,
                exit_code,
                error.as_deref(),
                Some(sandbox_id),
                Some(reuse_result),
            )
            .await;
        status.remove_run(run_id).await;
        budget.release();
    }
}
