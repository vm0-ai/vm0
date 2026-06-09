//! Sandbox finalization after executor completion.
//!
//! This module owns the post-executor decision to park or destroy a sandbox.
//! The job spawn module coordinates executor orchestration, provider completion,
//! deferred uploads, and panic boundaries.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use chrono::SecondsFormat;
use futures_util::FutureExt;
use sandbox::{Sandbox, SandboxFactory, SandboxId};
use tracing::{info, warn};

use super::idle_lifecycle::{
    SharedIdlePool, destroy_idle_jobs_and_wait, destroy_idle_payload_and_wait,
};
use super::job_lifecycle::{
    ActiveBudgetLease, BudgetOwnership, CompletionPayload, CompletionReady, RunCleanupState,
};
use super::ownership::OwnershipTransitions;
#[cfg(test)]
use super::{OuterJobPanicPoint, StartLoopTestObserver, maybe_panic_outer_job};
use crate::idle_pool::{
    DestroyOutcome, IdleDestroyPayload, IdleParkActiveParts, IdleParkRequest, IdleParkRequestParts,
    ParkResult, ParkingGate, StorageFingerprints,
};
use crate::ids::RunId;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogSession;
#[cfg(test)]
use crate::provider::CompletionAuth;
use crate::resource_budget::BudgetLease;
use crate::run_cancellation::RunCancellationHandle;
use crate::status::StatusTracker;
use crate::workspace_image_cache::{
    WorkspaceCacheTerminalStatus, WorkspaceImageLease, WorkspaceImagePromotionRequest,
};
use crate::workspace_promotion::promote_workspace_image_from_active_sandbox;

fn local_completed_at() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn mark_session_affinity_refresh(
    completion_ready: CompletionReady,
    session_affinity_changed: bool,
    session_affinity_refresh_sent: bool,
) -> CompletionReady {
    if session_affinity_refresh_sent {
        completion_ready.with_session_affinity_refresh_sent()
    } else if session_affinity_changed {
        completion_ready.with_session_affinity_changed()
    } else {
        completion_ready
    }
}

pub(super) struct FinalizeContext {
    pub(super) run_id: RunId,
    pub(super) sandbox_id: SandboxId,
    pub(super) profile_name: String,
    pub(super) session_id: Option<String>,
    pub(super) guest_session_id: Option<String>,
    pub(super) source_ip: String,
    pub(super) network_log_session: Option<NetworkLogSession>,
    pub(super) workspace_image: Option<WorkspaceImageLease>,
    pub(super) workspace_promotable: bool,
    pub(super) storage_fingerprints: StorageFingerprints,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: Arc<Box<dyn SandboxFactory>>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) status: Arc<StatusTracker>,
    pub(super) park_notify: Arc<tokio::sync::Notify>,
    pub(super) parking_gate: ParkingGate,
    pub(super) network_log_drain: NetworkLogDrainCoordinator,
    pub(super) exit_code: i32,
    pub(super) cancel: RunCancellationHandle,
    pub(super) cleanup_state: RunCleanupState,
    #[cfg(test)]
    pub(super) outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    pub(super) test_observer: StartLoopTestObserver,
}

pub(super) async fn finalize_sandbox_for_completion(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    completion_payload: CompletionPayload,
    ctx: FinalizeContext,
) -> CompletionReady {
    let Some(sandbox) = sandbox else {
        return CompletionReady::new(completion_payload, BudgetOwnership::active(active_lease));
    };

    let FinalizeContext {
        run_id,
        sandbox_id,
        profile_name,
        session_id,
        guest_session_id,
        source_ip,
        mut network_log_session,
        workspace_image,
        workspace_promotable,
        storage_fingerprints,
        device_rate_limits,
        factory,
        idle_pool,
        status,
        park_notify,
        parking_gate,
        network_log_drain,
        exit_code,
        cancel,
        cleanup_state,
        #[cfg(test)]
        outer_job_panic,
        #[cfg(test)]
        test_observer,
    } = ctx;

    let destroy_bookkeeping = DestroyBookkeepingContext {
        cleanup_state: &cleanup_state,
        #[cfg(test)]
        run_id,
        #[cfg(test)]
        outer_job_panic,
    };
    let cancelled = cancel.is_cancelled();
    let terminal_status = workspace_terminal_status(exit_code, cancelled);
    let completed_at = local_completed_at();
    let parkable_session = if exit_code == 0 && !cancelled && parking_gate.is_open() {
        // Prefer context session_id (from resume_session), fall back to
        // guest-reported session ID (first run — CLI generated it).
        session_id
            .as_deref()
            .or(guest_session_id.as_deref())
            .map(str::to_owned)
    } else {
        None
    };
    let promotion_session_id = session_id.as_deref().or(guest_session_id.as_deref());
    let workspace_promotion = workspace_image.and_then(|workspace_image| {
        workspace_image.into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            session_id_override: promotion_session_id,
            terminal_status,
            completed_at: completed_at.clone(),
            storage_fingerprints: storage_fingerprints.clone(),
            promotable: workspace_promotable,
        })
    });

    let mut session_affinity_changed = false;
    let mut session_affinity_refresh_sent = false;
    let budget = if let Some(session_id) = parkable_session {
        // Inflate the guest balloon BEFORE acquiring the pool lock —
        // the HTTP call to Firecracker can take milliseconds, and we
        // must not block other take/park operations on it.
        let park_request = IdleParkRequest::new(IdleParkRequestParts {
            sandbox,
            factory: Arc::clone(&factory),
            session_id: session_id.clone(),
            sandbox_id,
            profile_name: profile_name.clone(),
            device_rate_limits: device_rate_limits.clone(),
            budget_lease: active_lease.into_idle_park_lease(),
            source_ip,
            storage_fingerprints,
            workspace_promotion,
        });
        let candidate = match park_request.park_for_idle().await {
            Ok(candidate) => candidate,
            Err(failure) => {
                let failure = failure.into_active_parts();
                let IdleParkActiveParts {
                    sandbox,
                    factory: failure_factory,
                    budget_lease,
                    workspace_promotion,
                } = failure.active;
                warn!(
                    run_id = %run_id,
                    session_id,
                    error = %failure.error,
                    "sandbox park failed, destroying instead of parking"
                );
                let workspace_cache_promoted = promote_workspace_image_from_active_sandbox(
                    sandbox.as_ref(),
                    workspace_promotion.as_ref(),
                    "park_failed",
                )
                .await;
                let destroy_outcome = stop_and_destroy_sandbox(
                    sandbox,
                    &**failure_factory,
                    ActiveCleanupContext {
                        run_id,
                        sandbox_id,
                        profile_name: &profile_name,
                        session_id: Some(&session_id),
                        reason: "park_failed",
                        network_log_session: network_log_session.take(),
                        network_log_drain: network_log_drain.clone(),
                    },
                )
                .await;
                record_destroy_result(destroy_outcome, destroy_bookkeeping);
                return mark_session_affinity_refresh(
                    CompletionReady::new(
                        completion_payload,
                        BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(
                            budget_lease,
                        )),
                    ),
                    workspace_cache_promoted,
                    false,
                );
            }
        };
        if cancel.is_cancelled() {
            let (payload, budget_lease) = candidate.into_active_destroy_parts();
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            info!(
                run_id = %run_id,
                session_id,
                "job cancelled while parking, destroying VM"
            );
            let destroy_result = destroy_active_owned_idle_payload(
                payload,
                budget_lease,
                "cancelled",
                destroy_bookkeeping,
            )
            .await;
            session_affinity_changed |= destroy_result.workspace_cache_promoted;
            destroy_result.budget
        } else {
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            #[cfg(test)]
            test_observer.notify_before_idle_pool_ownership_transfer(run_id);
            loop {
                let mut pool = idle_pool.lock().await;
                // Let cancellation win while finalization is still waiting for
                // the pool lock. Once the pool lock is held, only enter the
                // final transfer boundary if the per-run gate is immediately
                // available; otherwise release the pool lock before waiting.
                let Some(transfer_guard) = cancel.try_transfer_guard() else {
                    drop(pool);
                    let transfer_guard = cancel.transfer_guard().await;
                    if cancel.is_cancelled() {
                        info!(
                            run_id = %run_id,
                            session_id,
                            "job cancelled before idle pool ownership transfer, destroying VM"
                        );
                        drop(transfer_guard);
                        let (payload, budget_lease) = candidate.into_active_destroy_parts();
                        let destroy_result = destroy_active_owned_idle_payload(
                            payload,
                            budget_lease,
                            "cancelled",
                            destroy_bookkeeping,
                        )
                        .await;
                        return mark_session_affinity_refresh(
                            CompletionReady::new(completion_payload, destroy_result.budget),
                            destroy_result.workspace_cache_promoted,
                            false,
                        );
                    }
                    drop(transfer_guard);
                    continue;
                };
                if cancel.is_cancelled() {
                    info!(
                        run_id = %run_id,
                        session_id,
                        "job cancelled before idle pool ownership transfer, destroying VM"
                    );
                    drop(transfer_guard);
                    drop(pool);
                    let (payload, budget_lease) = candidate.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        "cancelled",
                        destroy_bookkeeping,
                    )
                    .await;
                    return mark_session_affinity_refresh(
                        CompletionReady::new(completion_payload, destroy_result.budget),
                        destroy_result.workspace_cache_promoted,
                        false,
                    );
                }
                let candidate = candidate.with_last_completed_at(completed_at.clone());
                break match pool.park(candidate) {
                    ParkResult::Parked => {
                        info!(run_id = %run_id, session_id, "VM parked for reuse");
                        cleanup_state.mark_idle_pool_owned();
                        #[cfg(test)]
                        maybe_panic_outer_job(
                            outer_job_panic,
                            OuterJobPanicPoint::IdlePoolOwned,
                            run_id,
                        );
                        // Push fresh idle state to status.json BEFORE
                        // conditional active-run removal (below) clears the run_id
                        // from active_runs. Without this, doctor would
                        // briefly see the FC as unknown (neither active
                        // nor idle) until the next idle_cleanup tick
                        // (~10s), producing transient false-positive
                        // FirecrackerNotInStatus warnings.
                        let snapshot = pool.status_snapshot();
                        drop(transfer_guard);
                        drop(pool);
                        let ownership = OwnershipTransitions::new(status.as_ref());
                        ownership
                            .publish_idle_status_after_pool_transfer(snapshot)
                            .await;
                        session_affinity_changed = true;
                        session_affinity_refresh_sent = true;
                        park_notify.notify_one();
                        BudgetOwnership::idle_owned()
                    }
                    ParkResult::Replaced(evicted) => {
                        info!(run_id = %run_id, session_id, "VM parked, evicting previous");
                        cleanup_state.mark_idle_pool_owned();
                        #[cfg(test)]
                        maybe_panic_outer_job(
                            outer_job_panic,
                            OuterJobPanicPoint::IdlePoolOwned,
                            run_id,
                        );
                        let snapshot = pool.status_snapshot();
                        drop(transfer_guard);
                        drop(pool);
                        let ownership = OwnershipTransitions::new(status.as_ref());
                        ownership
                            .publish_idle_status_after_pool_transfer(snapshot)
                            .await;
                        session_affinity_changed = true;
                        session_affinity_refresh_sent = true;
                        park_notify.notify_one();
                        // The replaced VM was park()ed when it entered the
                        // pool; destroying a parked sandbox is safe — Drop
                        // aborts any leftover handles and the FC process is
                        // killed regardless of balloon state.
                        if destroy_idle_jobs_and_wait(vec![evicted], "park_replaced").await {
                            park_notify.notify_one();
                        }
                        BudgetOwnership::idle_owned()
                    }
                    ParkResult::Rejected(rejected) => {
                        info!(run_id = %run_id, session_id, "idle parking rejected, destroying VM");
                        drop(transfer_guard);
                        drop(pool);
                        // Pool unchanged (park rejected) — no status
                        // update needed. The rejected sandbox was just
                        // park()ed above; destroying a parked sandbox is
                        // safe — see Replaced arm for rationale.
                        let (payload, lease) = rejected.into_active_destroy_parts();
                        let destroy_result = destroy_active_owned_idle_payload(
                            payload,
                            lease,
                            "park_rejected",
                            destroy_bookkeeping,
                        )
                        .await;
                        session_affinity_changed |= destroy_result.workspace_cache_promoted;
                        destroy_result.budget
                    }
                };
            }
        }
    } else {
        // No parkable session — stop + destroy.
        let workspace_cache_promoted = promote_workspace_image_from_active_sandbox(
            sandbox.as_ref(),
            workspace_promotion.as_ref(),
            active_cleanup_reason(
                exit_code,
                cancelled,
                parking_gate.is_open(),
                session_id.as_deref(),
                guest_session_id.as_deref(),
            ),
        )
        .await;
        session_affinity_changed |= workspace_cache_promoted;
        let destroy_outcome = stop_and_destroy_sandbox(
            sandbox,
            &**factory,
            ActiveCleanupContext {
                run_id,
                sandbox_id,
                profile_name: &profile_name,
                session_id: session_id.as_deref().or(guest_session_id.as_deref()),
                reason: active_cleanup_reason(
                    exit_code,
                    cancelled,
                    parking_gate.is_open(),
                    session_id.as_deref(),
                    guest_session_id.as_deref(),
                ),
                network_log_session: network_log_session.take(),
                network_log_drain: network_log_drain.clone(),
            },
        )
        .await;
        record_destroy_result(destroy_outcome, destroy_bookkeeping);
        BudgetOwnership::active(active_lease)
    };

    mark_session_affinity_refresh(
        CompletionReady::new(completion_payload, budget),
        session_affinity_changed,
        session_affinity_refresh_sent,
    )
}

#[derive(Clone, Copy)]
struct DestroyBookkeepingContext<'a> {
    cleanup_state: &'a RunCleanupState,
    #[cfg(test)]
    run_id: RunId,
    #[cfg(test)]
    outer_job_panic: Option<OuterJobPanicPoint>,
}

struct ActiveOwnedIdleDestroyResult {
    budget: BudgetOwnership,
    workspace_cache_promoted: bool,
}

fn record_destroy_result(outcome: DestroyOutcome, context: DestroyBookkeepingContext<'_>) {
    if outcome == DestroyOutcome::Completed {
        context.cleanup_state.mark_destroy_completed();
    }
    #[cfg(test)]
    maybe_panic_outer_job(
        context.outer_job_panic,
        OuterJobPanicPoint::DestroyCompleted,
        context.run_id,
    );
}

async fn destroy_active_owned_idle_payload(
    payload: IdleDestroyPayload,
    budget_lease: BudgetLease,
    reason: &'static str,
    bookkeeping: DestroyBookkeepingContext<'_>,
) -> ActiveOwnedIdleDestroyResult {
    let destroy_result = destroy_idle_payload_and_wait(payload, reason).await;
    record_destroy_result(destroy_result.outcome, bookkeeping);
    ActiveOwnedIdleDestroyResult {
        budget: BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(budget_lease)),
        workspace_cache_promoted: destroy_result.workspace_cache_promoted,
    }
}

async fn close_network_log_session(
    run_id: RunId,
    session: Option<NetworkLogSession>,
    drain: &NetworkLogDrainCoordinator,
) {
    if let Some(session) = session {
        session.close_for_upload(run_id, drain).await;
    }
}

fn active_cleanup_reason(
    exit_code: i32,
    cancelled: bool,
    parking_open: bool,
    context_session_id: Option<&str>,
    guest_session_id: Option<&str>,
) -> &'static str {
    if cancelled {
        "cancelled"
    } else if exit_code != 0 {
        "nonzero_exit"
    } else if !parking_open {
        "parking_closed"
    } else if context_session_id.is_none() && guest_session_id.is_none() {
        "no_session"
    } else {
        "not_parkable"
    }
}

fn workspace_terminal_status(exit_code: i32, cancelled: bool) -> WorkspaceCacheTerminalStatus {
    if cancelled {
        WorkspaceCacheTerminalStatus::Cancelled
    } else if exit_code == 0 {
        WorkspaceCacheTerminalStatus::Success
    } else {
        WorkspaceCacheTerminalStatus::NonzeroExit
    }
}

struct ActiveCleanupContext<'a> {
    run_id: RunId,
    sandbox_id: SandboxId,
    profile_name: &'a str,
    session_id: Option<&'a str>,
    reason: &'static str,
    network_log_session: Option<NetworkLogSession>,
    network_log_drain: NetworkLogDrainCoordinator,
}

/// Stop a sandbox and destroy it via its factory.
async fn stop_and_destroy_sandbox(
    mut sandbox: Box<dyn Sandbox>,
    factory: &dyn SandboxFactory,
    mut context: ActiveCleanupContext<'_>,
) -> DestroyOutcome {
    let mut uncertain = false;
    match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => warn!(
            run_id = %context.run_id,
            sandbox_id = %context.sandbox_id,
            profile_name = context.profile_name,
            session_id = context.session_id.unwrap_or("<none>"),
            reason = context.reason,
            error = %e,
            "sandbox stop failed during active cleanup"
        ),
        Err(_) => {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %context.sandbox_id,
                profile_name = context.profile_name,
                session_id = context.session_id.unwrap_or("<none>"),
                reason = context.reason,
                "sandbox stop panicked during active cleanup"
            );
            uncertain = true;
        }
    }
    close_network_log_session(
        context.run_id,
        context.network_log_session.take(),
        &context.network_log_drain,
    )
    .await;
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!(
            run_id = %context.run_id,
            sandbox_id = %context.sandbox_id,
            profile_name = context.profile_name,
            session_id = context.session_id.unwrap_or("<none>"),
            reason = context.reason,
            "sandbox destroy panicked during active cleanup"
        );
        uncertain = true;
    }
    if uncertain {
        DestroyOutcome::Uncertain
    } else {
        DestroyOutcome::Completed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
    use sandbox::{ExecResult, SandboxFactory, SandboxId};
    use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory};

    use super::super::idle_lifecycle::SharedIdlePool;
    use super::super::job_lifecycle::{
        ActiveBudgetLease, CompletionPayload, RunCleanupDisposition, RunCleanupState,
    };
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult,
        ParkedIdleCandidate, ParkingGate, SyntheticParkedIdleCandidateParts,
    };
    use crate::ids::RunId;
    use crate::network_log_drain::NetworkLogDrainCoordinator;
    use crate::network_log_manager::NetworkLogManager;
    use crate::paths::RunnerPaths;
    use crate::resource_budget::{BudgetLease, ResourceBudget};
    use crate::status::StatusTracker;
    use crate::types::SandboxReuseResult;
    use crate::workspace_image_cache::{
        SessionWorkspaceCache, WorkspaceImagePrepareRequest, WorkspaceImagePromotionContext,
    };

    fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        (budget, lease)
    }

    struct FinalizeTestFixture {
        dir: tempfile::TempDir,
        status: Arc<StatusTracker>,
        parking_gate: ParkingGate,
        idle_pool: SharedIdlePool,
        network_log_manager: NetworkLogManager,
    }

    impl FinalizeTestFixture {
        async fn new() -> Self {
            Self::new_with_max_idle(10).await
        }

        async fn new_with_max_idle(max_idle: usize) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status = Arc::new(StatusTracker::new(
                dir.path().join("status.json"),
                4,
                None,
                None,
            ));
            status.write_initial().await;
            let parking_gate = ParkingGate::new_open();
            let idle_pool: SharedIdlePool =
                Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
                    IdlePoolConfig {
                        default_timeout: Duration::from_secs(300),
                        max_idle,
                    },
                    parking_gate.clone(),
                )));
            let network_log_manager = NetworkLogManager::new();

            Self {
                dir,
                status,
                parking_gate,
                idle_pool,
                network_log_manager,
            }
        }

        async fn network_log_session(&self) -> NetworkLogSession {
            self.network_log_manager
                .register_source_ip("10.0.0.1", self.dir.path().join("network.jsonl"))
                .await
        }

        fn finalize_context(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            session_id: &str,
            network_log_session: NetworkLogSession,
            cancel: RunCancellationHandle,
        ) -> FinalizeContext {
            FinalizeContext {
                run_id,
                sandbox_id,
                profile_name: "vm0/default".into(),
                session_id: Some(session_id.into()),
                guest_session_id: None,
                source_ip: "10.0.0.1".into(),
                network_log_session: Some(network_log_session),
                workspace_image: None,
                workspace_promotable: false,
                storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
                device_rate_limits: None,
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                idle_pool: Arc::clone(&self.idle_pool),
                status: Arc::clone(&self.status),
                park_notify: Arc::new(tokio::sync::Notify::new()),
                parking_gate: self.parking_gate.clone(),
                network_log_drain: NetworkLogDrainCoordinator::noop(),
                exit_code: 0,
                cancel,
                cleanup_state: RunCleanupState::new(),
                outer_job_panic: None,
                test_observer: StartLoopTestObserver::default(),
            }
        }
    }

    async fn prepare_test_workspace_image_lease(
        paths: &RunnerPaths,
        cache: &SessionWorkspaceCache,
        run_id: RunId,
        sandbox_id: SandboxId,
        session_id: &str,
    ) -> WorkspaceImageLease {
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: b"image".len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        lease
    }

    fn test_promotion_context(
        lease: WorkspaceImageLease,
        run_id: RunId,
        sandbox_id: SandboxId,
        session_id: &str,
        terminal_status: WorkspaceCacheTerminalStatus,
        storage_fingerprints: crate::idle_pool::StorageFingerprints,
    ) -> WorkspaceImagePromotionContext {
        lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status,
                completed_at: local_completed_at(),
                storage_fingerprints,
                promotable: true,
            })
            .expect("test workspace image should be promotable")
    }

    async fn sandbox_with_overrides(
        sandbox_id: SandboxId,
        overrides: Arc<sandbox_mock::MockSandboxOverrides>,
    ) -> (Arc<Box<dyn SandboxFactory>>, Box<dyn Sandbox>) {
        let factory: Arc<Box<dyn SandboxFactory>> =
            Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
        let sandbox = factory
            .create(sandbox::SandboxConfig {
                id: sandbox_id,
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create sandbox with overrides");
        (factory, sandbox)
    }

    #[tokio::test]
    async fn finalizer_closes_network_log_session_before_parking() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("network-log-park"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            fixture.finalize_context(
                run_id,
                sandbox_id,
                "sess-network-log-park",
                network_log_session,
                RunCancellationHandle::new(),
            ),
        )
        .await;

        assert_eq!(fixture.idle_pool.lock().await.len(), 1);
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-park.test"})
                )
                .await,
            "parked sandbox must not retain the previous run's network-log attribution",
        );
    }

    #[tokio::test]
    async fn finalizer_keeps_idle_pool_ownership_when_cancelled_after_transfer() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cancel = RunCancellationHandle::new();
        let cleanup_state = RunCleanupState::new();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-cancel-after-transfer",
            network_log_session,
            cancel.clone(),
        );
        context.cleanup_state = cleanup_state.clone();

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("cancel-after-transfer"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            context,
        )
        .await;

        assert_eq!(fixture.idle_pool.lock().await.len(), 1);
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );

        assert!(cancel.cancel().await);

        assert_eq!(
            fixture.idle_pool.lock().await.len(),
            1,
            "late cancellation must not undo idle-pool ownership",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
    }

    #[tokio::test]
    async fn workspace_promotion_unmounts_and_promotes_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease =
            prepare_test_workspace_image_lease(&paths, &cache, run_id, sandbox_id, "sess-promote")
                .await;
        let sandbox = MockSandbox::new("workspace-promotion");
        let promotion = test_promotion_context(
            lease,
            run_id,
            sandbox_id,
            "sess-promote",
            WorkspaceCacheTerminalStatus::Success,
            crate::idle_pool::StorageFingerprints::default(),
        );

        let promoted =
            promote_workspace_image_from_active_sandbox(&sandbox, Some(&promotion), "test").await;

        assert!(promoted);
        drop(promotion);
        let states = cache.held_session_states().await;
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].session_id, "sess-promote");
        let exec_calls = sandbox.exec_calls();
        assert_eq!(exec_calls.len(), 1);
        assert!(exec_calls[0].sudo);
        assert!(exec_calls[0].cmd.contains("umount -- \"$workspace_dir\""));
    }

    #[tokio::test]
    async fn non_success_workspace_promotion_does_not_mark_storages_reusable() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());

        for (session_id, terminal_status) in [
            ("sess-nonzero", WorkspaceCacheTerminalStatus::NonzeroExit),
            ("sess-cancelled", WorkspaceCacheTerminalStatus::Cancelled),
        ] {
            let run_id = RunId::new_v4();
            let sandbox_id = SandboxId::new_v4();
            let lease =
                prepare_test_workspace_image_lease(&paths, &cache, run_id, sandbox_id, session_id)
                    .await;
            let sandbox = MockSandbox::new(format!("workspace-promotion-{session_id}"));
            let storage_fingerprints = crate::idle_pool::StorageFingerprints {
                storages: std::collections::HashMap::from([(
                    CANONICAL_WORKING_DIR.to_owned(),
                    ("repo".to_owned(), "v1".to_owned()),
                )]),
                artifacts: std::collections::HashMap::from([(
                    format!("{CANONICAL_WORKING_DIR}/artifact"),
                    ("artifact".to_owned(), "v1".to_owned()),
                )]),
            };
            let promotion = test_promotion_context(
                lease,
                run_id,
                sandbox_id,
                session_id,
                terminal_status,
                storage_fingerprints,
            );

            let promoted =
                promote_workspace_image_from_active_sandbox(&sandbox, Some(&promotion), "test")
                    .await;

            assert!(promoted);
            drop(promotion);
            let checkout = cache
                .prepare(WorkspaceImagePrepareRequest {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    session_id: Some(session_id),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                    workspace_drive_required: true,
                })
                .await;

            assert!(checkout.is_cache_hit());
            let previous_storage = checkout
                .previous_storage()
                .expect("cache hit should expose previous storage fingerprints");
            assert!(StorageFingerprints::fingerprint_is_tainted(
                previous_storage
                    .storages
                    .get(CANONICAL_WORKING_DIR)
                    .expect("storage path should be retained for cleanup")
            ));
            assert!(StorageFingerprints::fingerprint_is_tainted(
                previous_storage
                    .artifacts
                    .get(&format!("{CANONICAL_WORKING_DIR}/artifact"))
                    .expect("artifact path should be retained for cleanup")
            ));
        }
    }

    #[tokio::test]
    async fn workspace_promotion_skips_cache_when_guest_unmount_fails() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease =
            prepare_test_workspace_image_lease(&paths, &cache, run_id, sandbox_id, "sess-failed")
                .await;
        let sandbox = MockSandbox::new("workspace-promotion-fail");
        sandbox.push_exec_result(Ok(ExecResult::new(64, Vec::new(), b"not mounted".to_vec())));
        let promotion = test_promotion_context(
            lease,
            run_id,
            sandbox_id,
            "sess-failed",
            WorkspaceCacheTerminalStatus::Success,
            crate::idle_pool::StorageFingerprints::default(),
        );

        let promoted =
            promote_workspace_image_from_active_sandbox(&sandbox, Some(&promotion), "test").await;

        assert!(!promoted);
        assert!(
            cache.held_session_states().await.is_empty(),
            "unmount failure must not advertise an unflushed workspace image"
        );
        assert_eq!(sandbox.exec_calls().len(), 1);
    }

    #[tokio::test]
    async fn finalizer_parks_workspace_cache_promotion_without_publishing_cache() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: None,
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: b"image".len() as u64,
                workspace_drive_required: true,
            })
            .await;
        assert!(workspace_image.can_attempt_promotion(Some("sess-guest")));
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.session_id = None;
        context.guest_session_id = Some("sess-guest".into());
        context.workspace_image = Some(workspace_image);
        context.workspace_promotable = true;

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("guest-session-promotion"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            context,
        )
        .await;

        let idle_states = fixture.idle_pool.lock().await.held_session_states();
        assert_eq!(idle_states.len(), 1);
        assert_eq!(idle_states[0].session_id, "sess-guest");
        let cache_states = cache.held_session_states().await;
        assert!(
            cache_states.is_empty(),
            "parked sandboxes keep the live workspace mounted and must not publish a separate cache image"
        );
    }

    #[tokio::test]
    async fn finalizer_promotes_workspace_cache_when_parked_candidate_is_rejected() {
        let fixture = FinalizeTestFixture::new_with_max_idle(1).await;
        let (_existing_budget, existing_lease) = test_budget_lease();
        let existing = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
            sandbox: Box::new(MockSandbox::new("existing-idle")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: "sess-existing".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: existing_lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        })
        .with_last_completed_at(local_completed_at());
        assert!(matches!(
            fixture.idle_pool.lock().await.park(existing),
            ParkResult::Parked
        ));

        let (_budget, lease) = test_budget_lease();
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some("sess-new"),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: b"image".len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-new",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.workspace_image = Some(workspace_image);
        context.workspace_promotable = true;

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("rejected-workspace-promotion"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            context,
        )
        .await;

        let idle_states = fixture.idle_pool.lock().await.held_session_states();
        assert_eq!(idle_states.len(), 1);
        assert_eq!(idle_states[0].session_id, "sess-existing");
        let cache_states = cache.held_session_states().await;
        assert_eq!(cache_states.len(), 1);
        assert_eq!(cache_states[0].session_id, "sess-new");
    }

    #[tokio::test]
    async fn finalizer_notifies_after_replaced_idle_workspace_cache_promotion() {
        let fixture = FinalizeTestFixture::new().await;
        let session_id = "sess-replaced-cache";
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());

        let old_run_id = RunId::new_v4();
        let old_sandbox_id = SandboxId::new_v4();
        let old_workspace_image = prepare_test_workspace_image_lease(
            &paths,
            &cache,
            old_run_id,
            old_sandbox_id,
            session_id,
        )
        .await;
        let old_promotion = test_promotion_context(
            old_workspace_image,
            old_run_id,
            old_sandbox_id,
            session_id,
            WorkspaceCacheTerminalStatus::Success,
            crate::idle_pool::StorageFingerprints::default(),
        );
        let destroy_gate = MockLifecycleGate::new();
        let existing_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        existing_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let existing_factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(Arc::clone(&existing_overrides)),
        ));
        let existing_sandbox = existing_factory
            .create(sandbox::SandboxConfig {
                id: old_sandbox_id,
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create existing sandbox");
        let (_existing_budget, existing_lease) = test_budget_lease();
        let existing_candidate = IdleParkRequest::new(IdleParkRequestParts {
            source_ip: existing_sandbox.source_ip().to_owned(),
            sandbox: existing_sandbox,
            factory: existing_factory,
            session_id: session_id.into(),
            sandbox_id: old_sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: existing_lease,
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
            workspace_promotion: Some(old_promotion),
        })
        .park_for_idle()
        .await
        .unwrap_or_else(|failure| {
            let error = failure.into_active_parts().error;
            panic!("existing sandbox should park: {error}");
        })
        .with_last_completed_at(local_completed_at());
        assert!(matches!(
            fixture.idle_pool.lock().await.park(existing_candidate),
            ParkResult::Parked
        ));

        let park_notify = Arc::new(tokio::sync::Notify::new());
        let (_budget, lease) = test_budget_lease();
        let network_log_session = fixture.network_log_session().await;
        let new_run_id = RunId::new_v4();
        let new_sandbox_id = SandboxId::new_v4();
        let mut context = fixture.finalize_context(
            new_run_id,
            new_sandbox_id,
            session_id,
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.park_notify = Arc::clone(&park_notify);

        let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("replacement-sandbox"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                new_run_id,
                0,
                None,
                new_sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            context,
        ));

        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("replaced idle destroy should reach destroy gate");
        assert!(
            park_notify.notified().now_or_never().is_some(),
            "newly parked replacement should notify before replaced destroy finishes"
        );

        destroy_gate.release_one();
        let _completion_ready = finalize_task.await.expect("finalizer task should join");
        assert!(
            park_notify.notified().now_or_never().is_some(),
            "replaced idle workspace cache promotion should notify after destroy"
        );
        assert!(
            cache
                .held_session_states()
                .await
                .iter()
                .any(|state| state.session_id == session_id),
            "replaced idle workspace cache should be visible after destroy completion"
        );
    }

    #[tokio::test]
    async fn finalizer_closes_network_log_session_before_cancel_destroy() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let cancel = RunCancellationHandle::new();
        cancel.cancel().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("network-log-cancel"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            fixture.finalize_context(
                run_id,
                sandbox_id,
                "sess-network-log-cancel",
                network_log_session,
                cancel,
            ),
        )
        .await;

        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-destroy.test"})
                )
                .await,
            "cancelled destroyed sandbox must not retain network-log attribution",
        );
    }

    #[tokio::test]
    async fn finalizer_destroys_candidate_when_cancelled_after_park() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cancel = RunCancellationHandle::new();
        let cleanup_state = RunCleanupState::new();
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let park_gate = MockLifecycleGate::new();
        let destroy_gate = MockLifecycleGate::new();
        overrides.set_park_lifecycle_gate(park_gate.clone());
        overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-cancel-after-park",
            network_log_session,
            cancel.clone(),
        );
        context.factory = factory;
        context.cleanup_state = cleanup_state.clone();

        let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
            Some(sandbox),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            context,
        ));

        assert_eq!(
            park_gate
                .wait_entered(1, Duration::from_secs(5))
                .await
                .expect("park should enter gate"),
            1
        );
        cancel.cancel().await;
        park_gate.release_one();
        assert_eq!(
            destroy_gate
                .wait_entered(1, Duration::from_secs(5))
                .await
                .expect("cancelled parked candidate should enter destroy gate"),
            1
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-cancelled-park.test"})
                )
                .await,
            "cancelled parked candidate must close network-log attribution before destroy",
        );

        destroy_gate.release_one();
        let _completion_ready = finalize_task.await.expect("finalizer task should join");
        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::DestroyCompleted
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn finalizer_destroys_candidate_when_cancelled_before_idle_pool_transfer() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cancel = RunCancellationHandle::new();
        let cleanup_state = RunCleanupState::new();
        let observer = StartLoopTestObserver::default();
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let destroy_gate = MockLifecycleGate::new();
        overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-cancel-before-transfer",
            network_log_session,
            cancel.clone(),
        );
        context.factory = factory;
        context.cleanup_state = cleanup_state.clone();
        context.test_observer = observer.clone();
        // Hold the pool lock so cancellation lands after the observer event but
        // before ownership can transfer into the idle pool.
        let pool_guard = fixture.idle_pool.lock().await;

        let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
            Some(sandbox),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            context,
        ));

        observer
            .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
            .await;
        cancel.cancel().await;
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"before-transfer-cancel.test"})
                )
                .await,
            "network-log attribution must be closed before waiting for idle-pool ownership",
        );
        drop(pool_guard);
        assert_eq!(
            destroy_gate
                .wait_entered(1, Duration::from_secs(5))
                .await
                .expect("cancelled candidate should enter destroy gate"),
            1
        );

        destroy_gate.release_one();
        let _completion_ready = finalize_task.await.expect("finalizer task should join");
        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::DestroyCompleted
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    }
}
