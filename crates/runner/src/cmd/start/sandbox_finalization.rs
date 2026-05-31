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
use tokio_util::sync::CancellationToken;
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
    DestroyOutcome, IdleParkActiveParts, IdleParkRequest, IdleParkRequestParts, ParkResult,
    ParkingGate, StorageFingerprints,
};
use crate::ids::RunId;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogSession;
#[cfg(test)]
use crate::provider::CompletionAuth;
use crate::status::StatusTracker;
use crate::workspace_image_cache::{WorkspaceCacheTerminalStatus, WorkspaceImageLease};
use crate::workspace_mount::flush_and_unmount_workspace_drive;

fn local_completed_at() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
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
    pub(super) cancel: CancellationToken,
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

    let cancelled = cancel.is_cancelled();
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

    let mut workspace_cache_promoted = false;
    let budget = if let Some(session_id) = parkable_session {
        workspace_cache_promoted = promote_workspace_image_from_active_sandbox(
            sandbox.as_ref(),
            run_id,
            workspace_image.as_ref(),
            workspace_promotable,
            workspace_terminal_status(exit_code, cancelled),
            &storage_fingerprints,
            &WorkspacePromotionLogContext {
                sandbox_id,
                profile_name: &profile_name,
                session_id: Some(&session_id),
                reason: "park",
            },
        )
        .await;

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
            workspace_drive_available: workspace_image
                .as_ref()
                .is_some_and(WorkspaceImageLease::workspace_drive_available),
        });
        let candidate = match park_request.park_for_idle().await {
            Ok(candidate) => candidate,
            Err(failure) => {
                let failure = failure.into_active_parts();
                let IdleParkActiveParts {
                    sandbox,
                    factory: failure_factory,
                    budget_lease,
                } = failure.active;
                warn!(
                    run_id = %run_id,
                    session_id,
                    error = %failure.error,
                    "sandbox park failed, destroying instead of parking"
                );
                let cleanup_outcome = stop_and_destroy_sandbox(
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
                        workspace_image: None,
                        workspace_promotable: false,
                        workspace_storage_fingerprints: None,
                        workspace_terminal_status: workspace_terminal_status(exit_code, cancelled),
                    },
                )
                .await;
                workspace_cache_promoted |= cleanup_outcome.workspace_cache_promoted;
                if cleanup_outcome.destroy == DestroyOutcome::Completed {
                    cleanup_state.mark_destroy_completed();
                }
                #[cfg(test)]
                maybe_panic_outer_job(
                    outer_job_panic,
                    OuterJobPanicPoint::DestroyCompleted,
                    run_id,
                );
                return CompletionReady::new(
                    completion_payload,
                    BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(budget_lease)),
                )
                .with_workspace_cache_promoted(workspace_cache_promoted);
            }
        };
        if cancel.is_cancelled() {
            let IdleParkActiveParts {
                sandbox,
                factory: candidate_factory,
                budget_lease,
            } = candidate.into_active_parts();
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            info!(
                run_id = %run_id,
                session_id,
                "job cancelled while parking, destroying VM"
            );
            let cleanup_outcome = stop_and_destroy_sandbox(
                sandbox,
                &**candidate_factory,
                ActiveCleanupContext {
                    run_id,
                    sandbox_id,
                    profile_name: &profile_name,
                    session_id: Some(&session_id),
                    reason: "cancelled",
                    network_log_session: None,
                    network_log_drain: network_log_drain.clone(),
                    workspace_image: None,
                    workspace_promotable: false,
                    workspace_storage_fingerprints: None,
                    workspace_terminal_status: workspace_terminal_status(exit_code, true),
                },
            )
            .await;
            workspace_cache_promoted |= cleanup_outcome.workspace_cache_promoted;
            if cleanup_outcome.destroy == DestroyOutcome::Completed {
                cleanup_state.mark_destroy_completed();
            }
            #[cfg(test)]
            maybe_panic_outer_job(
                outer_job_panic,
                OuterJobPanicPoint::DestroyCompleted,
                run_id,
            );
            BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(budget_lease))
        } else {
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            #[cfg(test)]
            test_observer.notify_before_idle_pool_ownership_transfer(run_id);
            let mut pool = idle_pool.lock().await;
            if cancel.is_cancelled() {
                info!(
                    run_id = %run_id,
                    session_id,
                    "job cancelled before idle pool ownership transfer, destroying VM"
                );
                drop(pool);
                let IdleParkActiveParts {
                    sandbox,
                    factory: candidate_factory,
                    budget_lease,
                } = candidate.into_active_parts();
                let cleanup_outcome = stop_and_destroy_sandbox(
                    sandbox,
                    &**candidate_factory,
                    ActiveCleanupContext {
                        run_id,
                        sandbox_id,
                        profile_name: &profile_name,
                        session_id: Some(&session_id),
                        reason: "cancelled",
                        network_log_session: None,
                        network_log_drain: network_log_drain.clone(),
                        workspace_image: None,
                        workspace_promotable: false,
                        workspace_storage_fingerprints: None,
                        workspace_terminal_status: workspace_terminal_status(exit_code, true),
                    },
                )
                .await;
                workspace_cache_promoted |= cleanup_outcome.workspace_cache_promoted;
                if cleanup_outcome.destroy == DestroyOutcome::Completed {
                    cleanup_state.mark_destroy_completed();
                }
                #[cfg(test)]
                maybe_panic_outer_job(
                    outer_job_panic,
                    OuterJobPanicPoint::DestroyCompleted,
                    run_id,
                );
                return CompletionReady::new(
                    completion_payload,
                    BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(budget_lease)),
                )
                .with_workspace_cache_promoted(workspace_cache_promoted);
            }
            let candidate = candidate.with_last_completed_at(local_completed_at());
            match pool.park(candidate) {
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
                    drop(pool);
                    let ownership = OwnershipTransitions::new(status.as_ref());
                    ownership
                        .publish_idle_status_after_pool_transfer(snapshot)
                        .await;
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
                    drop(pool);
                    let ownership = OwnershipTransitions::new(status.as_ref());
                    ownership
                        .publish_idle_status_after_pool_transfer(snapshot)
                        .await;
                    // Notify immediately — session is already in pool.
                    // Don't wait for stop_and_destroy which can be slow.
                    park_notify.notify_one();
                    // The replaced VM was park()ed when it entered the
                    // pool; destroying a parked sandbox is safe — Drop
                    // aborts any leftover handles and the FC process is
                    // killed regardless of balloon state.
                    destroy_idle_jobs_and_wait(vec![evicted], "park_replaced").await;
                    BudgetOwnership::idle_owned()
                }
                ParkResult::Rejected(rejected) => {
                    info!(run_id = %run_id, session_id, "idle parking rejected, destroying VM");
                    drop(pool);
                    // Pool unchanged (park rejected) — no status
                    // update needed. The rejected sandbox was just
                    // park()ed above; destroying a parked sandbox is
                    // safe — see Replaced arm for rationale.
                    let (payload, lease) = rejected.into_active_destroy_parts();
                    let destroy_outcome =
                        destroy_idle_payload_and_wait(payload, "park_rejected").await;
                    if destroy_outcome == DestroyOutcome::Completed {
                        cleanup_state.mark_destroy_completed();
                    }
                    #[cfg(test)]
                    maybe_panic_outer_job(
                        outer_job_panic,
                        OuterJobPanicPoint::DestroyCompleted,
                        run_id,
                    );
                    BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(lease))
                }
            }
        }
    } else {
        // No parkable session — stop + destroy.
        let cleanup_outcome = stop_and_destroy_sandbox(
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
                workspace_image,
                workspace_promotable,
                workspace_storage_fingerprints: Some(storage_fingerprints),
                workspace_terminal_status: workspace_terminal_status(exit_code, cancelled),
            },
        )
        .await;
        workspace_cache_promoted |= cleanup_outcome.workspace_cache_promoted;
        if cleanup_outcome.destroy == DestroyOutcome::Completed {
            cleanup_state.mark_destroy_completed();
        }
        #[cfg(test)]
        maybe_panic_outer_job(
            outer_job_panic,
            OuterJobPanicPoint::DestroyCompleted,
            run_id,
        );
        BudgetOwnership::active(active_lease)
    };

    CompletionReady::new(completion_payload, budget)
        .with_workspace_cache_promoted(workspace_cache_promoted)
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

struct WorkspacePromotionLogContext<'a> {
    sandbox_id: SandboxId,
    profile_name: &'a str,
    session_id: Option<&'a str>,
    reason: &'static str,
}

async fn promote_workspace_image_from_active_sandbox(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    workspace_image: Option<&WorkspaceImageLease>,
    workspace_promotable: bool,
    terminal_status: WorkspaceCacheTerminalStatus,
    storage_fingerprints: &StorageFingerprints,
    log: &WorkspacePromotionLogContext<'_>,
) -> bool {
    if !workspace_promotable {
        return false;
    }
    let Some(workspace_image) = workspace_image else {
        return false;
    };
    if !workspace_image.workspace_drive_available() {
        return false;
    }

    match flush_and_unmount_workspace_drive(sandbox, run_id, workspace_image.working_dir()).await {
        Ok(true) => {}
        Ok(false) => return false,
        Err(e) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %log.sandbox_id,
                profile_name = log.profile_name,
                session_id = log.session_id.unwrap_or("<none>"),
                reason = log.reason,
                error = %e,
                "workspace image cache promotion skipped because guest unmount failed"
            );
            return false;
        }
    }

    match workspace_image
        .promote(
            run_id,
            log.session_id,
            terminal_status,
            local_completed_at(),
            storage_fingerprints,
        )
        .await
    {
        Ok(promoted) => promoted,
        Err(e) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %log.sandbox_id,
                profile_name = log.profile_name,
                session_id = log.session_id.unwrap_or("<none>"),
                reason = log.reason,
                error = %e,
                "workspace image cache promotion failed"
            );
            false
        }
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
    workspace_image: Option<WorkspaceImageLease>,
    workspace_promotable: bool,
    workspace_storage_fingerprints: Option<StorageFingerprints>,
    workspace_terminal_status: WorkspaceCacheTerminalStatus,
}

struct ActiveCleanupOutcome {
    destroy: DestroyOutcome,
    workspace_cache_promoted: bool,
}

/// Stop a sandbox and destroy it via its factory.
async fn stop_and_destroy_sandbox(
    mut sandbox: Box<dyn Sandbox>,
    factory: &dyn SandboxFactory,
    mut context: ActiveCleanupContext<'_>,
) -> ActiveCleanupOutcome {
    let mut uncertain = false;
    let default_storage_fingerprints;
    let workspace_storage_fingerprints = match context.workspace_storage_fingerprints.as_ref() {
        Some(storage_fingerprints) => storage_fingerprints,
        None => {
            default_storage_fingerprints = StorageFingerprints::default();
            &default_storage_fingerprints
        }
    };
    let workspace_cache_promoted = promote_workspace_image_from_active_sandbox(
        sandbox.as_ref(),
        context.run_id,
        context.workspace_image.as_ref(),
        context.workspace_promotable,
        context.workspace_terminal_status,
        workspace_storage_fingerprints,
        &WorkspacePromotionLogContext {
            sandbox_id: context.sandbox_id,
            profile_name: context.profile_name,
            session_id: context.session_id,
            reason: context.reason,
        },
    )
    .await;
    match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %context.sandbox_id,
                profile_name = context.profile_name,
                session_id = context.session_id.unwrap_or("<none>"),
                reason = context.reason,
                error = %e,
                "sandbox stop failed during active cleanup"
            );
        }
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
    if workspace_cache_promoted && uncertain {
        warn!(
            run_id = %context.run_id,
            sandbox_id = %context.sandbox_id,
            profile_name = context.profile_name,
            session_id = context.session_id.unwrap_or("<none>"),
            reason = context.reason,
            "workspace image cache was promoted before uncertain sandbox cleanup"
        );
    }
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
    let destroy = if uncertain {
        DestroyOutcome::Uncertain
    } else {
        DestroyOutcome::Completed
    };
    ActiveCleanupOutcome {
        destroy,
        workspace_cache_promoted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use sandbox::{SandboxFactory, SandboxId};
    use sandbox_mock::{MockSandbox, MockSandboxFactory};
    use tokio_util::sync::CancellationToken;

    use super::super::idle_lifecycle::SharedIdlePool;
    use super::super::job_lifecycle::{ActiveBudgetLease, CompletionPayload, RunCleanupState};
    use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};
    use crate::ids::RunId;
    use crate::network_log_drain::NetworkLogDrainCoordinator;
    use crate::network_log_manager::NetworkLogManager;
    use crate::resource_budget::{BudgetLease, ResourceBudget};
    use crate::status::StatusTracker;
    use crate::types::SandboxReuseResult;
    use crate::workspace_image_cache::{
        SessionWorkspaceCache, WorkspaceCacheCheckoutResult, WorkspaceImageActiveLeaseRequest,
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
                        max_idle: 10,
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
            cancel: CancellationToken,
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
                CancellationToken::new(),
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
    async fn finalizer_closes_network_log_session_before_cancel_destroy() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let cancel = CancellationToken::new();
        cancel.cancel();
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
    async fn workspace_promotion_skips_guest_unmount_when_workspace_drive_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().join("home"));
        let cache = SessionWorkspaceCache::shared(
            crate::paths::RunnerPaths::new(dir.path().join("runner")),
            &home,
            "test-group",
        );
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease = cache
            .lease_active(WorkspaceImageActiveLeaseRequest {
                run_id,
                sandbox_id,
                session_id: Some("sess-no-drive"),
                working_dir: "/workspace",
                workspace_drive_available: false,
            })
            .await;
        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
        assert!(!lease.workspace_drive_available());

        let sandbox = MockSandbox::new("workspace-no-drive");
        sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
            64,
            Vec::new(),
            b"unexpected guest unmount".to_vec(),
        )));

        let promoted = promote_workspace_image_from_active_sandbox(
            &sandbox,
            run_id,
            Some(&lease),
            true,
            WorkspaceCacheTerminalStatus::Success,
            &StorageFingerprints::default(),
            &WorkspacePromotionLogContext {
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some("sess-no-drive"),
                reason: "test",
            },
        )
        .await;

        assert!(!promoted);
        assert!(sandbox.exec_calls().is_empty());
    }

    #[tokio::test]
    async fn finalizer_marks_workspace_cache_promotion_for_active_cleanup() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().join("home"));
        let runner_paths = crate::paths::RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::shared(runner_paths.clone(), &home, "test-group");
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_lease = cache
            .lease_active(WorkspaceImageActiveLeaseRequest {
                run_id,
                sandbox_id,
                session_id: Some("sess-active-cleanup"),
                working_dir: "/workspace",
                workspace_drive_available: true,
            })
            .await;
        tokio::fs::create_dir_all(runner_paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(
            runner_paths.active_workspace_image(&sandbox_id),
            b"workspace image",
        )
        .await
        .unwrap();

        let network_log_session = fixture.network_log_session().await;
        let mut ctx = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-active-cleanup",
            network_log_session,
            CancellationToken::new(),
        );
        ctx.workspace_image = Some(workspace_lease);
        ctx.workspace_promotable = true;
        ctx.exit_code = 1;

        let completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("workspace-active-cleanup"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                1,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            ctx,
        )
        .await;

        assert!(completion_ready.workspace_cache_promoted());
        let held = cache.held_session_states().await;
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].session_id, "sess-active-cleanup");
    }

    #[tokio::test]
    async fn finalizer_promotes_cancelled_first_run_workspace_with_late_guest_session_id() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().join("home"));
        let runner_paths = crate::paths::RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::shared(runner_paths.clone(), &home, "test-group");
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_lease = cache
            .lease_active(WorkspaceImageActiveLeaseRequest {
                run_id,
                sandbox_id,
                session_id: None,
                working_dir: "/workspace",
                workspace_drive_available: true,
            })
            .await;
        assert_eq!(
            workspace_lease.result(),
            WorkspaceCacheCheckoutResult::NoSession
        );
        tokio::fs::create_dir_all(runner_paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(
            runner_paths.active_workspace_image(&sandbox_id),
            b"workspace image",
        )
        .await
        .unwrap();

        let cancel = CancellationToken::new();
        cancel.cancel();
        let network_log_session = fixture.network_log_session().await;
        let mut ctx = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            cancel,
        );
        ctx.session_id = None;
        ctx.guest_session_id = Some("sess-cancelled-first-run".into());
        ctx.workspace_image = Some(workspace_lease);
        ctx.workspace_promotable = true;

        let completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("workspace-cancelled-first-run"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            ctx,
        )
        .await;

        assert!(completion_ready.workspace_cache_promoted());
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        let held = cache.held_session_states().await;
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].session_id, "sess-cancelled-first-run");
    }
}
