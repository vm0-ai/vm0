use sandbox::SandboxId;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use crate::ids::RunId;
use crate::provider::JobProvider;
use crate::resource_budget::BudgetLease;
use crate::status::StatusTracker;
use crate::types::SandboxReuseResult;

/// Ownership facts known by the outer runner task for panic cleanup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RunCleanupDisposition {
    /// The sandbox may still be active, or ownership is otherwise uncertain.
    ActiveOrUnknown,
    /// The sandbox has been accepted by the idle pool.
    IdlePoolOwned,
    /// The active sandbox was explicitly destroyed and destroy returned normally.
    DestroyCompleted,
    /// Normal completion already cleared, or no longer owns, active status.
    StatusRemoved,
}

/// Shared monotonic cleanup state for a claimed run.
#[derive(Clone, Debug)]
pub(super) struct RunCleanupState {
    state: Arc<AtomicU8>,
}

impl RunCleanupState {
    const ACTIVE_OR_UNKNOWN: u8 = 0;
    const DESTROY_COMPLETED: u8 = 1;
    const IDLE_POOL_OWNED: u8 = 2;
    const STATUS_REMOVED: u8 = 3;

    pub(super) fn new() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(Self::ACTIVE_OR_UNKNOWN)),
        }
    }

    pub(super) fn disposition(&self) -> RunCleanupDisposition {
        match self.state.load(Ordering::Acquire) {
            Self::STATUS_REMOVED => RunCleanupDisposition::StatusRemoved,
            Self::IDLE_POOL_OWNED => RunCleanupDisposition::IdlePoolOwned,
            Self::DESTROY_COMPLETED => RunCleanupDisposition::DestroyCompleted,
            _ => RunCleanupDisposition::ActiveOrUnknown,
        }
    }

    pub(super) fn mark_idle_pool_owned(&self) {
        self.mark_at_least(Self::IDLE_POOL_OWNED);
    }

    pub(super) fn mark_destroy_completed(&self) {
        self.mark_at_least(Self::DESTROY_COMPLETED);
    }

    pub(super) fn mark_status_removed(&self) {
        self.mark_at_least(Self::STATUS_REMOVED);
    }

    fn mark_at_least(&self, next: u8) {
        let _ = self
            .state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (next > current).then_some(next)
            });
    }
}

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
        cleanup_state: &RunCleanupState,
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
        status.remove_run_if_matching(run_id, sandbox_id).await;
        cleanup_state.mark_status_removed();
        budget.release();
    }
}
