//! E2E timing helpers — measure durations from API start time.

use crate::env;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

const LOG_TAG: &str = "sandbox:guest-agent";
const MIN_EPOCH_MS_TIMESTAMP: u64 = 1_000_000_000_000;
static INVALID_API_START_TIME_WARNED: AtomicBool = AtomicBool::new(false);

/// Record an E2E duration from `VM0_API_START_TIME` to now under `op_name`.
pub fn record_e2e_from_api(op_name: &str) {
    let now_ms = current_epoch_ms();
    let api_start = env::api_start_time();
    if let Some(duration) = e2e_duration_from_api_start(api_start, now_ms) {
        record_sandbox_op(op_name, duration, true, None);
        log_info!(LOG_TAG, "E2E {op_name}: {}ms", duration.as_millis());
    } else if !api_start.is_empty() {
        warn_invalid_api_start_time_once(op_name, api_start);
    }
}

fn warn_invalid_api_start_time_once(op_name: &str, api_start: &str) {
    if INVALID_API_START_TIME_WARNED.swap(true, Ordering::Relaxed) {
        return;
    }

    log_warn!(
        LOG_TAG,
        "Skipping E2E {op_name}: invalid VM0_API_START_TIME={api_start:?}; expected Unix epoch milliseconds"
    );
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn e2e_duration_from_api_start(api_start: &str, now_ms: u64) -> Option<Duration> {
    let api_start_ms = parse_api_start_time_ms(api_start)?;
    Some(Duration::from_millis(now_ms.saturating_sub(api_start_ms)))
}

fn parse_api_start_time_ms(api_start: &str) -> Option<u64> {
    let api_start_ms = api_start.parse::<u64>().ok()?;
    if api_start_ms < MIN_EPOCH_MS_TIMESTAMP {
        return None;
    }

    Some(api_start_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e2e_duration_from_api_start_returns_elapsed_duration() {
        let duration = e2e_duration_from_api_start("1700000000000", 1_700_000_001_250);

        assert_eq!(duration, Some(Duration::from_millis(1_250)));
    }

    #[test]
    fn e2e_duration_from_api_start_clamps_future_start_to_zero() {
        let duration = e2e_duration_from_api_start("1700000001250", 1_700_000_000_000);

        assert_eq!(duration, Some(Duration::ZERO));
    }

    #[test]
    fn e2e_duration_from_api_start_ignores_empty_input() {
        let duration = e2e_duration_from_api_start("", 1_700_000_001_250);

        assert_eq!(duration, None);
    }

    #[test]
    fn e2e_duration_from_api_start_ignores_non_numeric_input() {
        let duration = e2e_duration_from_api_start("not-a-timestamp", 1_700_000_001_250);

        assert_eq!(duration, None);
    }

    #[test]
    fn e2e_duration_from_api_start_ignores_seconds_shaped_input() {
        let duration = e2e_duration_from_api_start("1700000000", 1_700_000_001_250);

        assert_eq!(duration, None);
    }
}
