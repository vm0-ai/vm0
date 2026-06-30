//! Job discovery branch handling and idle-reuse admission.
//!
//! `run()` owns the provider discovery future and reactor scheduling. This
//! module owns the body that turns a discovered job into a claimed spawned job.

use std::collections::BTreeMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::active_sessions::ActiveCliAgentSessionGuard;
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    SharedIdlePool, add_preparing_run_with_idle_status_snapshot,
    add_running_run_with_idle_status_snapshot, spawn_idle_destroy_job,
};
use super::job_spawn::{JobProfile, SpawnContext, SpawnJobRequest, spawn_job};
use crate::config::ProfileConfig;
use crate::executor::{
    RunnerPreSpawnPhase, RunnerPreSpawnTiming, SessionHistoryMaterializer,
    SessionHistoryRestoreFallback, SessionHistoryRestorePlan, validate_resume_session_id,
};
use crate::http::HttpClient;
use crate::idle_pool::{IdlePoolSnapshot, IdleUnparkResult, ReusableIdleSandbox};
use crate::ids::RunId;
use crate::paths::diagnostic_session_fingerprint;
use crate::provider::{ClaimedJob, JobCandidate};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::run_cancellation::{RunCancellationHandle, SharedRunCancellationMap};
use crate::status::{RunnerMode, StatusTracker};
use crate::types::{ExecutionContext, SandboxReuseResult};

pub(super) struct DiscoveredJob {
    pub(super) candidate: JobCandidate,
}

pub(super) struct DiscoveredJobContext<'a> {
    pub(super) profiles: &'a BTreeMap<String, ProfileConfig>,
    pub(super) factories: &'a BTreeMap<String, (SharedFactory, bool)>,
    pub(super) budget: &'a Arc<ResourceBudget>,
    pub(super) idle_pool: &'a SharedIdlePool,
    pub(super) status: &'a StatusTracker,
    pub(super) mode_rx: &'a tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) cancel_tokens: &'a SharedRunCancellationMap,
    pub(super) spawn_ctx: &'a SpawnContext,
    pub(super) destroy_tasks: &'a mut JoinSet<bool>,
    pub(super) jobs: &'a mut JoinSet<Option<RunId>>,
}

struct LocalAdmission {
    run_id: RunId,
    budget_lease: BudgetLease,
    cancel: RunCancellationHandle,
}

struct AdmittedClaim {
    claimed: ClaimedJob,
    budget_lease: BudgetLease,
    cancel: RunCancellationHandle,
}

struct ReuseAdmissionRequest<'a> {
    profile_name: &'a str,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    workspace_disk_mb: u32,
    context: &'a ExecutionContext,
    resume_session_valid: bool,
    job_lease: BudgetLease,
}

impl LocalAdmission {
    async fn rollback(self, cancel_tokens: &SharedRunCancellationMap) {
        let Self {
            run_id,
            budget_lease,
            cancel: _,
        } = self;
        cancel_tokens.lock().await.remove(&run_id);
        drop(budget_lease);
    }

    fn into_admitted(self, claimed: ClaimedJob) -> AdmittedClaim {
        AdmittedClaim {
            claimed,
            budget_lease: self.budget_lease,
            cancel: self.cancel,
        }
    }
}

pub(super) async fn handle_discovered_job(job: DiscoveredJob, mut ctx: DiscoveredJobContext<'_>) {
    let DiscoveredJob { candidate } = job;
    let run_id = candidate.run_id();
    let profile_name = candidate.profile_name().to_owned();
    // Look up profile config for resource requirements.
    let Some(profile_config) = ctx.profiles.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
        return;
    };
    let job_vcpu = profile_config.vcpu;
    let job_memory = profile_config.memory_mb;
    let job_workspace_disk_mb = profile_config.workspace_disk_mb;
    // Look up factory for this profile.
    let Some((factory, restore_guest_state)) = ctx.factories.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "no factory for profile, skipping");
        return;
    };

    let Some(admission) =
        claim_with_local_admission(candidate, run_id, job_vcpu, job_memory, &ctx).await
    else {
        return;
    };
    let AdmittedClaim {
        claimed,
        budget_lease: job_lease,
        cancel: job_cancel,
    } = admission;
    let mut pre_spawn_timing = RunnerPreSpawnTiming::start_after_claim();
    let started_at = Instant::now();
    let resume_session_valid = validate_resume_session_id(claimed.context()).is_ok();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ResumeSessionValidation, started_at);
    let active_cli_agent_session_guard = ActiveCliAgentSessionGuard::new(
        ctx.spawn_ctx.active_cli_agent_sessions.clone(),
        if resume_session_valid {
            claimed.context().cli_agent_session_id().map(str::to_owned)
        } else {
            None
        },
    );
    info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");
    let started_at = Instant::now();
    let device_rate_limits = crate::io_limits::device_rate_limits_for_context(
        ctx.spawn_ctx.device_rate_limits.as_ref(),
        claimed.context(),
    );
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::DeviceRateLimits, started_at);

    let (reuse_entry, active_lease, reuse_result, idle_snapshot) = try_reuse_from_pool(
        run_id,
        ReuseAdmissionRequest {
            profile_name: &profile_name,
            device_rate_limits: &device_rate_limits,
            workspace_disk_mb: job_workspace_disk_mb,
            context: claimed.context(),
            resume_session_valid,
            job_lease,
        },
        &mut ctx,
        &mut pre_spawn_timing,
    )
    .await;

    let session_history_restore_plan = build_session_history_restore_plan(
        &ctx.spawn_ctx.exec_config.http,
        claimed.context(),
        resume_session_valid,
        &job_cancel,
        reuse_entry.as_ref(),
        reuse_result,
        &mut pre_spawn_timing,
    );

    // Determine sandbox_id after the reuse decision. On reuse, the sandbox keeps
    // its original identity; on a fresh create, allocate a new UUID for the
    // executor's SandboxConfig. This is the join key for doctor and kill.
    let sandbox_id = match &reuse_entry {
        Some(entry) => entry.sandbox_id(),
        None => SandboxId::new_v4(),
    };
    let started_at = Instant::now();
    publish_active_run_status(
        ctx.status,
        run_id,
        sandbox_id,
        reuse_entry.is_some(),
        idle_snapshot,
    )
    .await;
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ActiveStatusPublish, started_at);

    let job_profile = JobProfile {
        profile_name,
        vcpu: job_vcpu,
        memory_mb: job_memory,
        workspace_disk_mb: job_workspace_disk_mb,
        budget_lease: active_lease,
        restore_guest_state: *restore_guest_state,
        device_rate_limits,
        factory: Arc::clone(factory),
        cancel: job_cancel,
    };
    spawn_job(
        SpawnJobRequest {
            claimed,
            sandbox_id,
            job_profile,
            reuse_entry,
            reuse_result,
            pre_spawn_timing,
            session_history_restore_plan,
            active_cli_agent_session_guard,
        },
        ctx.spawn_ctx,
        ctx.jobs,
    );
}

fn build_session_history_restore_plan(
    http: &HttpClient,
    context: &ExecutionContext,
    resume_session_valid: bool,
    cancel: &RunCancellationHandle,
    reuse_entry: Option<&ReusableIdleSandbox>,
    reuse_result: SandboxReuseResult,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> SessionHistoryRestorePlan {
    if !resume_session_valid {
        return SessionHistoryRestorePlan::Default;
    }
    let Some(resume_session) = context.resume_session.as_ref() else {
        return SessionHistoryRestorePlan::Default;
    };
    if resume_session.history_ref().is_none() {
        return SessionHistoryRestorePlan::Default;
    }

    let fallback = match reuse_result {
        SandboxReuseResult::Reused => {
            let requested_identity = RestoredSessionIdentity::from_context(context);
            if let Some(requested_identity) = requested_identity {
                match reuse_entry.and_then(ReusableIdleSandbox::restored_session_identity) {
                    Some(restored_identity)
                        if restored_identity.is_verified_match_for_request(&requested_identity) =>
                    {
                        return SessionHistoryRestorePlan::SkipVerified(restored_identity.clone());
                    }
                    Some(restored_identity) if restored_identity == &requested_identity => {
                        if restored_identity.has_final_metadata_verification() {
                            Some(SessionHistoryRestoreFallback::IdentityMismatch)
                        } else {
                            Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                        }
                    }
                    Some(_) => Some(SessionHistoryRestoreFallback::IdentityMismatch),
                    None => Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
                }
            } else {
                Some(SessionHistoryRestoreFallback::IdentityMismatch)
            }
        }
        SandboxReuseResult::NoSessionId
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => Some(SessionHistoryRestoreFallback::NonReuse),
    };

    let started_at = Instant::now();
    let materializer =
        SessionHistoryMaterializer::start_cancellable(http, Some(resume_session), cancel.token());
    pre_spawn_timing.record_phase_elapsed(
        RunnerPreSpawnPhase::SessionHistoryMaterializerStart,
        started_at,
    );
    SessionHistoryRestorePlan::Prestarted {
        materializer,
        fallback,
    }
}

async fn publish_active_run_status(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    reused_idle: bool,
    idle_snapshot: Option<IdlePoolSnapshot>,
) {
    if let Some(snapshot) = idle_snapshot {
        if reused_idle {
            add_running_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await;
        } else {
            add_preparing_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await;
        }
    } else {
        status.add_preparing_run(run_id, sandbox_id).await;
    }
}

async fn claim_with_local_admission(
    mut candidate: JobCandidate,
    run_id: RunId,
    job_vcpu: u32,
    job_memory: u32,
    ctx: &DiscoveredJobContext<'_>,
) -> Option<AdmittedClaim> {
    candidate.mark_local_admission_started();

    // Reserve resources before claiming so we don't waste a job that another
    // runner could handle.
    let job_lease = ResourceBudget::try_reserve_lease(ctx.budget, job_vcpu, job_memory)?;

    // Insert cancel token before claiming so provider-side cancel channels
    // (Ably supervisor for ApiProvider, `.cancel` scan for LocalProvider) can
    // find the active job. Skip duplicate discoveries; overwriting would break
    // cancel delivery for the executor.
    let job_cancel = RunCancellationHandle::new();
    {
        let mut tokens = ctx.cancel_tokens.lock().await;
        match tokens.entry(run_id) {
            Entry::Occupied(_) => return None,
            Entry::Vacant(entry) => {
                entry.insert(job_cancel.clone());
            }
        }
    }

    let admission = LocalAdmission {
        run_id,
        budget_lease: job_lease,
        cancel: job_cancel,
    };

    // This is the last reversible point before provider-side ownership.
    // Soft drain must stop new claims, while hard stop still claims and
    // cancels so provider state is completed deterministically.
    let mode = *ctx.mode_rx.borrow();
    match mode {
        RunnerMode::Running => {}
        RunnerMode::Draining => {
            admission.rollback(ctx.cancel_tokens).await;
            return None;
        }
        RunnerMode::Stopping => {
            admission.cancel.cancel().await;
        }
        RunnerMode::Stopped => {
            admission.rollback(ctx.cancel_tokens).await;
            return None;
        }
    }
    // claim() runs in the branch handler: non-interruptible, so a valid
    // successful claim is always paired with complete().
    let Some(claimed) = ctx.spawn_ctx.provider.claim(candidate).await else {
        // None means the job won't run here: either lost the race to another
        // runner, or the provider rejected the job. Release the reservation and
        // cancel token so the runner can continue.
        admission.rollback(ctx.cancel_tokens).await;
        return None;
    };
    if claimed.context().run_id != run_id {
        warn!(
            run_id = %run_id,
            context_run_id = %claimed.context().run_id,
            "provider returned claimed job with mismatched run_id"
        );
        admission.rollback(ctx.cancel_tokens).await;
        return None;
    }

    Some(admission.into_admitted(claimed))
}

async fn try_reuse_from_pool(
    run_id: RunId,
    request: ReuseAdmissionRequest<'_>,
    ctx: &mut DiscoveredJobContext<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> (
    Option<ReusableIdleSandbox>,
    BudgetLease,
    SandboxReuseResult,
    Option<IdlePoolSnapshot>,
) {
    let ReuseAdmissionRequest {
        profile_name,
        device_rate_limits,
        workspace_disk_mb,
        context,
        resume_session_valid,
        job_lease,
    } = request;

    let started_at = Instant::now();
    if !resume_session_valid {
        pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
        return (None, job_lease, SandboxReuseResult::NoSessionId, None);
    }
    let Some(cli_agent_session_id) = context.cli_agent_session_id() else {
        pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
        return (None, job_lease, SandboxReuseResult::NoSessionId, None);
    };
    let session_fingerprint = diagnostic_session_fingerprint(cli_agent_session_id);

    // Take the entry under the pool lock, then drop the lock before any awaits
    // so unpark does not block other take/park operations.
    let (taken, snapshot, held_session_states) = {
        let mut pool = ctx.idle_pool.lock().await;
        let taken = pool.take(cli_agent_session_id);
        let snapshot = taken.as_ref().map(|_| pool.status_snapshot());
        let held_session_states = pool.held_session_states();
        (taken, snapshot, held_session_states)
    };
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
    let started_at = Instant::now();
    let held_session_states = ctx
        .spawn_ctx
        .held_session_snapshot
        .current_held_session_states(
            held_session_states,
            &ctx.spawn_ctx.active_cli_agent_sessions,
            Some(cli_agent_session_id),
        );
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::HeldSessionStateRefresh, started_at);
    let started_at = Instant::now();
    ctx.spawn_ctx
        .provider
        .set_held_session_states(held_session_states)
        .await;
    pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::ProviderHeldSessionUpdate, started_at);
    match taken {
        Some(entry)
            if entry.profile_name() == profile_name
                && entry.device_rate_limits() == device_rate_limits =>
        {
            if let Some(cache) = ctx.spawn_ctx.exec_config.workspace_cache.as_ref() {
                let started_at = Instant::now();
                let validation = entry.validate_workspace_promotion_identity(
                    cache,
                    CANONICAL_WORKING_DIR,
                    u64::from(workspace_disk_mb) * 1024 * 1024,
                );
                pre_spawn_timing.record_phase_elapsed(
                    RunnerPreSpawnPhase::WorkspacePromotionValidation,
                    started_at,
                );
                if let Err(mismatch) = validation {
                    warn!(
                        run_id = %run_id,
                        session_fingerprint = %session_fingerprint,
                        profile = %profile_name,
                        mismatch = mismatch.as_str(),
                        "workspace promotion identity mismatch, destroying idle VM and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(
                        ctx.destroy_tasks,
                        entry.into_destroy_job_without_workspace_promotion_for_mismatch(),
                        "reuse_workspace_promotion_mismatch",
                    );
                    return (None, job_lease, SandboxReuseResult::PoolMiss, snapshot);
                }
            }
            let started_at = Instant::now();
            let unpark_result = entry.try_unpark().await;
            pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
            match unpark_result {
                IdleUnparkResult::Reused {
                    sandbox,
                    budget_lease,
                } => {
                    info!(
                        run_id = %run_id,
                        session_fingerprint = %session_fingerprint,
                        "reusing idle VM for session"
                    );
                    // Idle entry already holds budget. Drop the speculative
                    // fresh-job lease and move the idle lease to the outer job
                    // task before handing the sandbox to the executor.
                    drop(job_lease);
                    (
                        Some(*sandbox),
                        budget_lease,
                        SandboxReuseResult::Reused,
                        snapshot,
                    )
                }
                IdleUnparkResult::Failed { destroy_job, error } => {
                    warn!(
                        run_id = %run_id,
                        session_fingerprint = %session_fingerprint,
                        error = %error,
                        "unpark failed, destroying idle VM and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(ctx.destroy_tasks, *destroy_job, "reuse_unpark_failed");
                    (None, job_lease, SandboxReuseResult::UnparkFailed, snapshot)
                }
            }
        }
        Some(stale) if stale.profile_name() == profile_name => {
            info!(
                run_id = %run_id,
                session_fingerprint = %session_fingerprint,
                profile = %profile_name,
                "idle VM device rate limiter mismatch, destroying"
            );
            spawn_idle_destroy_job(
                ctx.destroy_tasks,
                stale.into_destroy_job(),
                "reuse_device_limit_mismatch",
            );
            (
                None,
                job_lease,
                SandboxReuseResult::DeviceLimitMismatch,
                snapshot,
            )
        }
        Some(stale) => {
            info!(
                run_id = %run_id,
                session_fingerprint = %session_fingerprint,
                old_profile = %stale.profile_name(),
                new_profile = %profile_name,
                "idle VM profile mismatch, destroying"
            );
            spawn_idle_destroy_job(
                ctx.destroy_tasks,
                stale.into_destroy_job(),
                "reuse_profile_mismatch",
            );
            (
                None,
                job_lease,
                SandboxReuseResult::ProfileMismatch,
                snapshot,
            )
        }
        None => {
            info!(
                run_id = %run_id,
                session_fingerprint = %session_fingerprint,
                "no idle VM found for session"
            );
            (None, job_lease, SandboxReuseResult::PoolMiss, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::StartLoopTestObserver;
    use super::super::job_lifecycle::{ActiveBudgetLease, CompletionPayload, RunCleanupState};
    use super::super::sandbox_finalization::{FinalizeContext, finalize_sandbox_for_completion};
    use crate::http::HttpClientConfig;
    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
    use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkResult, ParkingGate};
    use crate::network_log_drain::NetworkLogDrainCoordinator;
    use crate::provider::CompletionAuth;
    use crate::resource_budget::ResourceBudget;
    use crate::status::IdleVm;
    use crate::test_fixtures::execution_context_for_test;
    use crate::types::{ResumeSession, ResumeSessionHistory, ResumeSessionHistoryRef};
    use guest_contracts::{
        codex_thread_id::canonical_codex_thread_id,
        session_history_identity::{
            FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
        },
    };
    use sandbox::SandboxFactory;
    use sandbox_mock::{MockSandbox, MockSandboxFactory};
    use sha2::{Digest, Sha256};

    fn read_active_run_phase(path: &std::path::Path) -> String {
        let raw = std::fs::read_to_string(path).unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        status["active_runs"][0]["phase"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn idle_snapshot() -> IdlePoolSnapshot {
        IdlePoolSnapshot {
            revision: 1,
            idle_vms: vec![IdleVm {
                session_id: "sess-removed-from-pool".into(),
                sandbox_id: SandboxId::new_v4(),
            }],
        }
    }

    fn test_http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
        })
        .unwrap()
    }

    fn context_with_history_ref(history_hash: &str) -> ExecutionContext {
        context_with_history_ref_and_size(history_hash, Some(12))
    }

    fn context_with_history_ref_and_size(
        history_hash: &str,
        size: Option<u64>,
    ) -> ExecutionContext {
        let mut context = execution_context_for_test(RunId::new_v4());
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-restore-plan".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: crate::types::ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.into(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    size,
                },
            },
        });
        context
    }

    async fn reusable_sandbox_with_identity(
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ReusableIdleSandbox {
        let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 1, 1).unwrap();
        let builder = ParkedIdleCandidateBuilder::new("sess-restore-plan", lease);
        let builder = if let Some(restored_session_identity) = restored_session_identity {
            builder.with_restored_session_identity(restored_session_identity)
        } else {
            builder
        };
        let candidate = builder.build();
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let entry = pool
            .take("sess-restore-plan")
            .expect("idle entry should exist");
        let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark().await else {
            panic!("idle entry should unpark");
        };
        *sandbox
    }

    async fn reusable_sandbox_parked_by_finalizer(
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ReusableIdleSandbox {
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
                    default_timeout: std::time::Duration::from_secs(300),
                    max_idle: 10,
                },
                parking_gate.clone(),
            )));
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("restore-plan-finalizer"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            FinalizeContext {
                run_id,
                sandbox_id,
                profile_name: "vm0/default".into(),
                cli_agent_session_id: Some("sess-restore-plan".into()),
                discovered_cli_agent_session_id: None,
                restored_session_identity,
                source_ip: "10.0.0.1".into(),
                network_log_session: None,
                workspace_image: None,
                workspace_image_size_bytes: 0,
                storage_fingerprints: crate::storage_fingerprints::StorageFingerprints::default(),
                device_rate_limits: None,
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                idle_pool: Arc::clone(&idle_pool),
                status,
                park_notify: Arc::new(tokio::sync::Notify::new()),
                parking_gate,
                network_log_drain: NetworkLogDrainCoordinator::noop(),
                exit_code: 0,
                cancel: RunCancellationHandle::new(),
                cleanup_state: RunCleanupState::new(),
                outer_job_panic: None,
                test_observer: StartLoopTestObserver::default(),
            },
        )
        .await;

        let entry = idle_pool
            .lock()
            .await
            .take("sess-restore-plan")
            .expect("finalizer should park reusable sandbox");
        let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark().await else {
            panic!("finalized idle entry should unpark");
        };
        *sandbox
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_preparing_after_reuse_miss_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);

        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            false,
            Some(idle_snapshot()),
        )
        .await;

        assert_eq!(read_active_run_phase(&status_path), "preparing");
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_running_for_reused_idle_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);

        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            true,
            Some(idle_snapshot()),
        )
        .await;

        assert_eq!(read_active_run_phase(&status_path), "running");
    }

    #[tokio::test]
    async fn restore_plan_skips_matching_checkpointed_final_identity() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref_and_size(&history_hash, Some(12));
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity =
            RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
                .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_with_identity(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching checkpointed final identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_skips_matching_codex_checkpointed_final_identity() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let mut context = execution_context_for_test(RunId::new_v4());
        context.cli_agent_type = "codex".into();
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "019E9154C30470F0ADDE36EFB1BE1701".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: crate::types::ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.clone(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    size: Some(12),
                },
            },
        });
        let canonical_thread_id =
            canonical_codex_thread_id("019E9154C30470F0ADDE36EFB1BE1701").unwrap();
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            hex::encode(Sha256::digest(canonical_thread_id.as_bytes())),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            format!("CODEX_SEARCH:26:/home/user/.codex/sessions:{canonical_thread_id}"),
        )
        .unwrap();
        let restored_identity =
            RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
                .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_with_identity(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching Codex checkpointed final identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_skips_identity_parked_by_finalizer() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity = RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_parked_by_finalizer(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
            }
            _ => panic!("finalizer-parked restored identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_skips_matching_reused_identity_without_requested_size() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref_and_size(&history_hash, None);
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity = RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_with_identity(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
            }
            _ => panic!("missing requested size should still allow verified skip"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_is_unverified() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::from_context(&context).unwrap();
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                );
            }
            _ => panic!("unverified reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_size_mismatches() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            13,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity = RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity");
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch)
                );
            }
            _ => panic!("reused identity with mismatched size should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_reused_identity_is_missing() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let reusable_sandbox = reusable_sandbox_with_identity(None).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::MissingIdleIdentity)
                );
            }
            _ => panic!("missing reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_finalizer_parked_without_identity() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let reusable_sandbox = reusable_sandbox_parked_by_finalizer(None).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::MissingIdleIdentity)
                );
            }
            _ => panic!("finalizer-parked missing identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_reused_identity_mismatches() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::claude_code_for_test("history-hash-b");
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &context,
            true,
            &cancel,
            Some(&reusable_sandbox),
            SandboxReuseResult::Reused,
            &mut timing,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch)
                );
            }
            _ => panic!("mismatched reused identity should fall back to restore"),
        }
    }
}
