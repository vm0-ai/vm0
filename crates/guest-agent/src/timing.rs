//! E2E timing helpers — measure durations from API start time.

use crate::env;
use guest_common::log_info;
use guest_common::telemetry::record_sandbox_op;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Record an E2E duration from `VM0_API_START_TIME` to now under `op_name`.
pub fn record_e2e_from_api(op_name: &str) {
    let api_start = env::api_start_time();
    if !api_start.is_empty()
        && let Ok(api_ms) = api_start.parse::<u64>()
    {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let e2e = now_ms.saturating_sub(api_ms);
        record_sandbox_op(op_name, std::time::Duration::from_millis(e2e), true, None);
        log_info!(LOG_TAG, "E2E {op_name}: {e2e}ms");
    }
}
