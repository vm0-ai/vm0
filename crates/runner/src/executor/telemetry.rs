//! Executor telemetry marker helpers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tracing::warn;

use super::MIN_EPOCH_MS_TIMESTAMP;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, SandboxReuseResult};
use crate::workspace_image_cache::WorkspaceCacheCheckoutResult;

static INVALID_API_START_TIME_WARNED: AtomicBool = AtomicBool::new(false);

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
