//! Executor telemetry marker helpers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tracing::warn;

use super::MIN_EPOCH_MS_TIMESTAMP;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, SandboxReuseResult};
use crate::workspace_image_cache::WorkspaceCacheCheckoutResult;

static INVALID_API_START_TIME_WARNED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
pub(crate) enum RunnerPreSpawnPhase {
    ResumeSessionValidation,
    SessionHistoryMaterializerStart,
    DeviceRateLimits,
    IdleReuseLookup,
    HeldSessionStateRefresh,
    ProviderHeldSessionUpdate,
    WorkspacePromotionValidation,
    IdleUnpark,
    ActiveStatusPublish,
    SpawnJobSetup,
}

impl RunnerPreSpawnPhase {
    const ALL: [Self; 10] = [
        Self::ResumeSessionValidation,
        Self::SessionHistoryMaterializerStart,
        Self::DeviceRateLimits,
        Self::IdleReuseLookup,
        Self::HeldSessionStateRefresh,
        Self::ProviderHeldSessionUpdate,
        Self::WorkspacePromotionValidation,
        Self::IdleUnpark,
        Self::ActiveStatusPublish,
        Self::SpawnJobSetup,
    ];

    const fn action_type(self) -> &'static str {
        match self {
            Self::ResumeSessionValidation => "runner_claim_resume_session_validation",
            Self::SessionHistoryMaterializerStart => {
                "runner_claim_session_history_materializer_start"
            }
            Self::DeviceRateLimits => "runner_claim_device_rate_limits",
            Self::IdleReuseLookup => "runner_claim_idle_reuse_lookup",
            Self::HeldSessionStateRefresh => "runner_claim_held_session_state_refresh",
            Self::ProviderHeldSessionUpdate => "runner_claim_provider_held_session_update",
            Self::WorkspacePromotionValidation => "runner_claim_workspace_promotion_validation",
            Self::IdleUnpark => "runner_claim_idle_unpark",
            Self::ActiveStatusPublish => "runner_claim_active_status_publish",
            Self::SpawnJobSetup => "runner_claim_spawn_job_setup",
        }
    }
}

#[derive(Default)]
struct RunnerPreSpawnPhaseDurations {
    resume_session_validation: Option<Duration>,
    session_history_materializer_start: Option<Duration>,
    device_rate_limits: Option<Duration>,
    idle_reuse_lookup: Option<Duration>,
    held_session_state_refresh: Option<Duration>,
    provider_held_session_update: Option<Duration>,
    workspace_promotion_validation: Option<Duration>,
    idle_unpark: Option<Duration>,
    active_status_publish: Option<Duration>,
    spawn_job_setup: Option<Duration>,
}

impl RunnerPreSpawnPhaseDurations {
    fn get_mut(&mut self, phase: RunnerPreSpawnPhase) -> &mut Option<Duration> {
        match phase {
            RunnerPreSpawnPhase::ResumeSessionValidation => &mut self.resume_session_validation,
            RunnerPreSpawnPhase::SessionHistoryMaterializerStart => {
                &mut self.session_history_materializer_start
            }
            RunnerPreSpawnPhase::DeviceRateLimits => &mut self.device_rate_limits,
            RunnerPreSpawnPhase::IdleReuseLookup => &mut self.idle_reuse_lookup,
            RunnerPreSpawnPhase::HeldSessionStateRefresh => &mut self.held_session_state_refresh,
            RunnerPreSpawnPhase::ProviderHeldSessionUpdate => {
                &mut self.provider_held_session_update
            }
            RunnerPreSpawnPhase::WorkspacePromotionValidation => {
                &mut self.workspace_promotion_validation
            }
            RunnerPreSpawnPhase::IdleUnpark => &mut self.idle_unpark,
            RunnerPreSpawnPhase::ActiveStatusPublish => &mut self.active_status_publish,
            RunnerPreSpawnPhase::SpawnJobSetup => &mut self.spawn_job_setup,
        }
    }

    fn get(&self, phase: RunnerPreSpawnPhase) -> Option<Duration> {
        match phase {
            RunnerPreSpawnPhase::ResumeSessionValidation => self.resume_session_validation,
            RunnerPreSpawnPhase::SessionHistoryMaterializerStart => {
                self.session_history_materializer_start
            }
            RunnerPreSpawnPhase::DeviceRateLimits => self.device_rate_limits,
            RunnerPreSpawnPhase::IdleReuseLookup => self.idle_reuse_lookup,
            RunnerPreSpawnPhase::HeldSessionStateRefresh => self.held_session_state_refresh,
            RunnerPreSpawnPhase::ProviderHeldSessionUpdate => self.provider_held_session_update,
            RunnerPreSpawnPhase::WorkspacePromotionValidation => {
                self.workspace_promotion_validation
            }
            RunnerPreSpawnPhase::IdleUnpark => self.idle_unpark,
            RunnerPreSpawnPhase::ActiveStatusPublish => self.active_status_publish,
            RunnerPreSpawnPhase::SpawnJobSetup => self.spawn_job_setup,
        }
    }
}

pub(crate) struct RunnerPreSpawnTiming {
    claim_returned_at: Instant,
    phase_durations: RunnerPreSpawnPhaseDurations,
    task_enqueued_at: Option<Instant>,
}

pub(super) struct RunnerSpawnTiming {
    executor_started_at: Instant,
    pre_spawn_timing: Option<RunnerPreSpawnTiming>,
}

impl RunnerPreSpawnTiming {
    pub(crate) fn start_after_claim() -> Self {
        Self {
            claim_returned_at: Instant::now(),
            phase_durations: RunnerPreSpawnPhaseDurations::default(),
            task_enqueued_at: None,
        }
    }

    pub(crate) fn record_phase(&mut self, phase: RunnerPreSpawnPhase, duration: Duration) {
        *self.phase_durations.get_mut(phase) = Some(duration);
    }

    pub(crate) fn record_phase_elapsed(&mut self, phase: RunnerPreSpawnPhase, started_at: Instant) {
        self.record_phase(phase, started_at.elapsed());
    }

    pub(crate) fn mark_task_enqueued(&mut self) {
        self.task_enqueued_at = Some(Instant::now());
    }

    fn elapsed_at(&self, at: Instant) -> Duration {
        at.saturating_duration_since(self.claim_returned_at)
    }

    fn record_collected_phases(&self, telemetry: &mut JobTelemetry, executor_started_at: Instant) {
        for phase in RunnerPreSpawnPhase::ALL {
            if let Some(duration) = self.phase_durations.get(phase) {
                telemetry.record(phase.action_type(), duration, true, None);
            }
        }
        if let Some(task_enqueued_at) = self.task_enqueued_at {
            telemetry.record(
                "runner_claim_task_schedule_wait",
                executor_started_at.saturating_duration_since(task_enqueued_at),
                true,
                None,
            );
        }
    }
}

impl RunnerSpawnTiming {
    pub(super) fn start(pre_spawn_timing: Option<RunnerPreSpawnTiming>) -> Self {
        Self {
            executor_started_at: Instant::now(),
            pre_spawn_timing,
        }
    }

    pub(super) fn record_claim_to_executor_start(&self, telemetry: &mut JobTelemetry) {
        if let Some(pre_spawn_timing) = self.pre_spawn_timing.as_ref() {
            telemetry.record(
                "runner_claim_to_executor_start",
                pre_spawn_timing.elapsed_at(self.executor_started_at),
                true,
                None,
            );
            pre_spawn_timing.record_collected_phases(telemetry, self.executor_started_at);
        }
    }

    pub(super) fn record_spawn_success_at(
        &self,
        telemetry: &mut JobTelemetry,
        spawned_at: Instant,
    ) {
        telemetry.record(
            "runner_executor_start_to_spawn",
            spawned_at.saturating_duration_since(self.executor_started_at),
            true,
            None,
        );
        if let Some(pre_spawn_timing) = self.pre_spawn_timing.as_ref() {
            telemetry.record(
                "runner_claim_to_spawn",
                pre_spawn_timing.elapsed_at(spawned_at),
                true,
                None,
            );
        }
    }
}

pub(super) fn record_reuse_result(telemetry: &mut JobTelemetry, result: SandboxReuseResult) {
    let action_type = match result {
        SandboxReuseResult::Reused => "sandbox_reuse_hit",
        SandboxReuseResult::NoSessionId
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => "sandbox_reuse_miss",
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

pub(super) fn record_workspace_cache_result(
    telemetry: &mut JobTelemetry,
    result: WorkspaceCacheCheckoutResult,
) {
    let action_type = match result {
        WorkspaceCacheCheckoutResult::Hit => "workspace_image_cache_hit",
        WorkspaceCacheCheckoutResult::Miss => "workspace_image_cache_miss",
        WorkspaceCacheCheckoutResult::NoSession => "workspace_image_cache_no_session",
        WorkspaceCacheCheckoutResult::InvalidWorkingDir => {
            "workspace_image_cache_invalid_working_dir"
        }
        WorkspaceCacheCheckoutResult::LockBusy => "workspace_image_cache_lock_busy",
        WorkspaceCacheCheckoutResult::InvalidMetadata => "workspace_image_cache_invalid_metadata",
        WorkspaceCacheCheckoutResult::DiskPressure => "workspace_image_cache_disk_pressure",
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

pub(super) fn record_api_latency(
    action_type: &str,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) {
    if let Some(api_start_ms) = context.api_start_time {
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        if let Some(duration) = elapsed_since_api_start_ms(api_start_ms, now_ms) {
            telemetry.record(action_type, duration, true, None);
        } else {
            warn_invalid_api_start_time_once(action_type, context, api_start_ms);
        }
    }
}

pub(super) fn warn_invalid_api_start_time_once(
    action_type: &str,
    context: &ExecutionContext,
    api_start_ms: u64,
) {
    if INVALID_API_START_TIME_WARNED.swap(true, Ordering::Relaxed) {
        return;
    }

    warn!(
        run_id = %context.run_id,
        api_start_ms,
        min_epoch_ms_timestamp = MIN_EPOCH_MS_TIMESTAMP,
        action_type,
        "skipping API latency telemetry for invalid epoch-ms start timestamp"
    );
}

pub(super) fn elapsed_since_api_start_ms(api_start_ms: u64, now_ms: u64) -> Option<Duration> {
    if api_start_ms < MIN_EPOCH_MS_TIMESTAMP {
        return None;
    }

    Some(Duration::from_millis(now_ms.saturating_sub(api_start_ms)))
}
