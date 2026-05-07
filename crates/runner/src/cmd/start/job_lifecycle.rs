use sandbox::SandboxId;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use crate::ids::RunId;
use crate::provider::JobProvider;
use crate::resource_budget::BudgetLease;
use crate::types::SandboxReuseResult;

use super::ownership::{OwnershipTransitions, RunSandbox};

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
        ownership: &OwnershipTransitions<'_>,
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
        ownership
            .active_completed(RunSandbox::new(run_id, sandbox_id))
            .await;
        cleanup_state.mark_status_removed();
        budget.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use sandbox::SandboxId;

    use crate::ids::RunId;
    use crate::provider::JobProvider;
    use crate::resource_budget::{BudgetLease, ResourceBudget};
    use crate::status::StatusTracker;
    use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};

    use super::super::ownership::OwnershipTransitions;

    fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        (budget, lease)
    }
    fn test_completion_payload(run_id: RunId, sandbox_id: SandboxId) -> CompletionPayload {
        CompletionPayload::new(run_id, 0, None, sandbox_id, SandboxReuseResult::PoolMiss)
    }

    async fn status_active_run_count(path: &std::path::Path) -> usize {
        let raw = tokio::fs::read_to_string(path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        status["active_runs"].as_array().unwrap().len()
    }
    async fn status_active_run_records(status_path: &std::path::Path) -> Vec<(String, String)> {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut records: Vec<(String, String)> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| {
                (
                    run["run_id"].as_str().unwrap().to_string(),
                    run["sandbox_id"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        records.sort_unstable();
        records
    }
    struct CompletionOrderProvider {
        budget: Arc<ResourceBudget>,
        budget_count_at_complete: Arc<AtomicUsize>,
        active_runs_at_complete: Arc<AtomicUsize>,
        status_path: std::path::PathBuf,
    }

    #[async_trait]
    impl JobProvider for CompletionOrderProvider {
        async fn discover(&self) -> Option<(RunId, String)> {
            None
        }

        async fn claim(&self, _run_id: RunId) -> Option<ExecutionContext> {
            None
        }

        async fn complete(
            &self,
            _run_id: RunId,
            _exit_code: i32,
            _error: Option<&str>,
            _sandbox_id: Option<SandboxId>,
            _reuse_result: Option<SandboxReuseResult>,
        ) {
            self.budget_count_at_complete
                .store(self.budget.allocated().2, Ordering::SeqCst);
            self.active_runs_at_complete.store(
                status_active_run_count(&self.status_path).await,
                Ordering::SeqCst,
            );
        }

        async fn heartbeat(&self, _state: &HeartbeatState) {}

        async fn shutdown(&self) {}
    }

    #[tokio::test]
    async fn completion_ready_complete_and_release_orders_completion_status_and_budget() {
        let (budget, lease) = test_budget_lease();
        let budget_count_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let active_runs_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let provider = CompletionOrderProvider {
            budget: Arc::clone(&budget),
            budget_count_at_complete: Arc::clone(&budget_count_at_complete),
            active_runs_at_complete: Arc::clone(&active_runs_at_complete),
            status_path: status_path.clone(),
        };
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;

        CompletionReady::new(
            test_completion_payload(run_id, sandbox_id),
            BudgetOwnership::active(ActiveBudgetLease::new(lease)),
        )
        .complete_and_release(&provider, &ownership, &cleanup_state)
        .await;

        assert_eq!(
            budget_count_at_complete.load(Ordering::SeqCst),
            1,
            "active budget must still be held while provider.complete runs",
        );
        assert_eq!(
            active_runs_at_complete.load(Ordering::SeqCst),
            1,
            "active status removal must happen after provider.complete",
        );
        assert_eq!(
            status_active_run_count(&status_path).await,
            0,
            "active status removal should complete before active budget release returns",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::StatusRemoved,
        );
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn completion_ready_idle_owned_does_not_release_park_candidate_budget() {
        let (budget, lease) = test_budget_lease();
        let park_candidate_lease = ActiveBudgetLease::new(lease).into_park_candidate_lease();
        let budget_count_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let active_runs_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let provider = CompletionOrderProvider {
            budget: Arc::clone(&budget),
            budget_count_at_complete,
            active_runs_at_complete,
            status_path,
        };
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;

        CompletionReady::new(
            test_completion_payload(run_id, sandbox_id),
            BudgetOwnership::idle_owned(),
        )
        .complete_and_release(&provider, &ownership, &cleanup_state)
        .await;

        assert_eq!(
            budget.allocated().2,
            1,
            "idle-owned completion must not release the park candidate budget",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::StatusRemoved,
        );
        drop(park_candidate_lease);
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn completion_ready_does_not_remove_reinserted_active_run() {
        let (budget, lease) = test_budget_lease();
        let budget_count_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let active_runs_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let provider = CompletionOrderProvider {
            budget: Arc::clone(&budget),
            budget_count_at_complete,
            active_runs_at_complete,
            status_path: status_path.clone(),
        };
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let completed_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, completed_sandbox_id).await;
        status.add_run(run_id, current_sandbox_id).await;

        CompletionReady::new(
            test_completion_payload(run_id, completed_sandbox_id),
            BudgetOwnership::active(ActiveBudgetLease::new(lease)),
        )
        .complete_and_release(&provider, &ownership, &cleanup_state)
        .await;

        assert_eq!(
            status_active_run_records(&status_path).await,
            vec![(run_id.to_string(), current_sandbox_id.to_string())],
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::StatusRemoved,
        );
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn rejected_park_budget_is_recovered_as_active_and_released_after_completion() {
        let (budget, lease) = test_budget_lease();
        let budget_count_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let active_runs_at_complete = Arc::new(AtomicUsize::new(usize::MAX));
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let provider = CompletionOrderProvider {
            budget: Arc::clone(&budget),
            budget_count_at_complete: Arc::clone(&budget_count_at_complete),
            active_runs_at_complete,
            status_path,
        };
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;

        CompletionReady::new(
            test_completion_payload(run_id, sandbox_id),
            BudgetOwnership::active(ActiveBudgetLease::from_rejected_park(lease)),
        )
        .complete_and_release(&provider, &ownership, &cleanup_state)
        .await;

        assert_eq!(
            budget_count_at_complete.load(Ordering::SeqCst),
            1,
            "rejected park must retain active budget through provider.complete",
        );
        assert_eq!(budget.allocated().2, 0);
    }

    #[test]
    fn active_budget_drop_releases_budget_as_raii_fallback() {
        let (budget, lease) = test_budget_lease();
        drop(ActiveBudgetLease::new(lease));
        assert_eq!(budget.allocated().2, 0);
    }

    #[test]
    fn run_cleanup_state_does_not_downgrade_precise_ownership() {
        let state = RunCleanupState::new();

        state.mark_idle_pool_owned();
        state.mark_destroy_completed();
        assert_eq!(state.disposition(), RunCleanupDisposition::IdlePoolOwned);

        state.mark_status_removed();
        state.mark_idle_pool_owned();
        assert_eq!(state.disposition(), RunCleanupDisposition::StatusRemoved);
    }
}
