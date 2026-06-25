//! Addon flush request/ack protocols.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tracing::{error, warn};
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};

pub const USAGE_FLUSH_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum time to wait for mitmproxy JSONL writes to become visible before upload.
pub const JSONL_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll interval when waiting for usage flush.
const USAGE_FLUSH_POLL: Duration = Duration::from_millis(200);

/// Minimum interval between repeated runner-triggered usage flush requests
/// while the addon is not ready.
const USAGE_FLUSH_REQUEST_INTERVAL: Duration = Duration::from_secs(1);

/// Poll interval when waiting for a single JSONL path flush.
const JSONL_FLUSH_POLL: Duration = Duration::from_millis(50);

/// Minimum interval between repeated JSONL flush signals while the addon is not ready.
const JSONL_FLUSH_REQUEST_INTERVAL: Duration = Duration::from_millis(250);

/// Tolerated wall-clock skew when validating addon timestamps.
const USAGE_PENDING_CLOCK_SKEW: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct UsageFlushTarget {
    pub(super) expected_usage_state_id: String,
    pub(super) usage_state_started_at_ms: u64,
}

#[derive(Debug, Clone)]
struct FlushRequestCore {
    expected_usage_state_id: String,
    usage_state_started_at_ms: u64,
    flush_request_id: String,
    requested_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct UsageFlushRequest {
    core: FlushRequestCore,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageFlushRequestMarker<'a> {
    usage_state_id: &'a str,
    flush_request_id: &'a str,
    requested_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsagePendingState {
    pid: u32,
    usage_state_id: String,
    updated_at_ms: u64,
    flows: u32,
    buffered: u32,
    reports: u32,
    #[serde(default)]
    flush_request_id: Option<String>,
}

#[derive(Debug, Clone)]
struct UsagePendingSnapshot {
    pid: u32,
    usage_state_id: String,
    updated_at_ms: u64,
    flows: u32,
    buffered: u32,
    reports: u32,
    flush_request_id: Option<String>,
}

impl From<&UsagePendingState> for UsagePendingSnapshot {
    fn from(state: &UsagePendingState) -> Self {
        Self {
            pid: state.pid,
            usage_state_id: state.usage_state_id.clone(),
            updated_at_ms: state.updated_at_ms,
            flows: state.flows,
            buffered: state.buffered,
            reports: state.reports,
            flush_request_id: state.flush_request_id.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct JsonlFlushRequest {
    core: FlushRequestCore,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonlFlushRequestMarker<'a> {
    usage_state_id: &'a str,
    flush_request_id: &'a str,
    requested_at_ms: u64,
    path: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonlFlushState {
    pid: u32,
    usage_state_id: String,
    updated_at_ms: u64,
    flush_request_id: String,
    path: String,
    pending: u32,
}

#[derive(Debug, Clone)]
struct JsonlFlushSnapshot {
    pid: u32,
    usage_state_id: String,
    updated_at_ms: u64,
    flush_request_id: String,
    path: String,
    pending: u32,
}

impl From<&JsonlFlushState> for JsonlFlushSnapshot {
    fn from(state: &JsonlFlushState) -> Self {
        Self {
            pid: state.pid,
            usage_state_id: state.usage_state_id.clone(),
            updated_at_ms: state.updated_at_ms,
            flush_request_id: state.flush_request_id.clone(),
            path: state.path.clone(),
            pending: state.pending,
        }
    }
}

#[derive(Clone)]
pub struct MitmJsonlFlushHandle {
    pub(super) addon_dir: PathBuf,
    pub(super) usage_state: Arc<Mutex<UsageFlushTarget>>,
    pub(super) request_lock: Arc<AsyncMutex<()>>,
    pub(super) request_flush_tx: mpsc::Sender<()>,
}

pub(super) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(super) fn new_usage_state_id() -> (String, u64) {
    (Uuid::new_v4().to_string(), now_millis())
}

pub(super) fn usage_flush_state_guard(
    usage_state: &Arc<Mutex<UsageFlushTarget>>,
) -> std::sync::MutexGuard<'_, UsageFlushTarget> {
    match usage_state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("usage flush state lock was poisoned, continuing with inner state");
            poisoned.into_inner()
        }
    }
}

impl FlushRequestCore {
    fn new(target: &UsageFlushTarget) -> Self {
        Self {
            expected_usage_state_id: target.expected_usage_state_id.clone(),
            usage_state_started_at_ms: target.usage_state_started_at_ms,
            flush_request_id: Uuid::new_v4().to_string(),
            requested_at_ms: now_millis(),
        }
    }
}

impl UsageFlushRequest {
    fn new(target: &UsageFlushTarget) -> Self {
        Self {
            core: FlushRequestCore::new(target),
        }
    }
}

impl JsonlFlushRequest {
    fn new(target: &UsageFlushTarget, path: &Path) -> Self {
        Self {
            core: FlushRequestCore::new(target),
            path: path.to_string_lossy().into_owned(),
        }
    }
}

impl MitmJsonlFlushHandle {
    pub async fn flush_path(&self, path: &Path) -> bool {
        let _request_guard = self.request_lock.lock().await;
        let target = usage_flush_state_guard(&self.usage_state).clone();
        let request = match write_jsonl_flush_request(&self.addon_dir, &target, path).await {
            Ok(request) => request,
            Err(e) => {
                warn!(error = %e, path = %path.display(), "failed to create JSONL flush request");
                return false;
            }
        };
        if !self.request_flush() {
            warn!(path = %path.display(), "failed to request JSONL flush");
            return false;
        }
        wait_jsonl_flush_requesting(&self.addon_dir, JSONL_FLUSH_TIMEOUT, &request, || {
            self.request_flush()
        })
        .await
    }

    fn request_flush(&self) -> bool {
        match self.request_flush_tx.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => true,
            Err(mpsc::error::TrySendError::Closed(())) => false,
        }
    }
}

pub async fn write_usage_flush_request(
    addon_dir: &Path,
    target: &UsageFlushTarget,
) -> RunnerResult<UsageFlushRequest> {
    let request = UsageFlushRequest::new(target);
    let marker = UsageFlushRequestMarker {
        usage_state_id: &request.core.expected_usage_state_id,
        flush_request_id: &request.core.flush_request_id,
        requested_at_ms: request.core.requested_at_ms,
    };
    write_flush_request_marker(
        addon_dir,
        "usage-flush-request",
        &marker,
        "usage flush request",
    )
    .await?;
    Ok(request)
}

async fn write_jsonl_flush_request(
    addon_dir: &Path,
    target: &UsageFlushTarget,
    log_path: &Path,
) -> RunnerResult<JsonlFlushRequest> {
    let request = JsonlFlushRequest::new(target, log_path);
    let marker = JsonlFlushRequestMarker {
        usage_state_id: &request.core.expected_usage_state_id,
        flush_request_id: &request.core.flush_request_id,
        requested_at_ms: request.core.requested_at_ms,
        path: &request.path,
    };
    write_flush_request_marker(
        addon_dir,
        "jsonl-flush-request",
        &marker,
        "JSONL flush request",
    )
    .await?;
    Ok(request)
}

async fn write_flush_request_marker<T: Serialize>(
    addon_dir: &Path,
    file_name: &str,
    marker: &T,
    description: &str,
) -> RunnerResult<()> {
    let path = addon_dir.join(file_name);
    let content = serde_json::to_vec(marker)
        .map_err(|e| RunnerError::Internal(format!("serialize {description}: {e}")))?;
    crate::state_file::write_private_atomic(&path, &content).await
}

fn parse_usage_pending_state(content: &str) -> Result<UsagePendingState, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("state file is empty".to_string());
    }
    serde_json::from_str::<UsagePendingState>(trimmed)
        .map_err(|e| format!("state file is not valid usage-pending JSON: {e}"))
}

fn validate_usage_pending_state(
    state: &UsagePendingState,
    request: &UsageFlushRequest,
    now_ms: u64,
) -> Result<(), String> {
    validate_flush_state_core(
        &state.usage_state_id,
        state.updated_at_ms,
        state.flush_request_id.as_deref(),
        &request.core,
        "usage flush request id does not match current request",
        "usage flush request id is missing",
        now_ms,
    )
}

fn parse_jsonl_flush_state(content: &str) -> Result<JsonlFlushState, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("state file is empty".to_string());
    }
    serde_json::from_str::<JsonlFlushState>(trimmed)
        .map_err(|e| format!("state file is not valid JSONL flush JSON: {e}"))
}

fn validate_jsonl_flush_state(
    state: &JsonlFlushState,
    request: &JsonlFlushRequest,
    now_ms: u64,
) -> Result<(), String> {
    validate_flush_state_core(
        &state.usage_state_id,
        state.updated_at_ms,
        Some(&state.flush_request_id),
        &request.core,
        "JSONL flush request id does not match current request",
        "JSONL flush request id is missing",
        now_ms,
    )?;
    if state.path != request.path {
        return Err("JSONL flush path does not match current request".to_string());
    }

    Ok(())
}

fn validate_flush_state_core(
    usage_state_id: &str,
    updated_at_ms: u64,
    flush_request_id: Option<&str>,
    request: &FlushRequestCore,
    request_id_mismatch_message: &str,
    missing_request_id_message: &str,
    now_ms: u64,
) -> Result<(), String> {
    if usage_state_id != request.expected_usage_state_id {
        return Err("usage state id does not match current mitmdump process".to_string());
    }

    let skew_ms = USAGE_PENDING_CLOCK_SKEW.as_millis() as u64;
    let min_updated_at = request.usage_state_started_at_ms.saturating_sub(skew_ms);
    if updated_at_ms < min_updated_at {
        return Err(format!(
            "updatedAtMs {} predates current usage state id start {}",
            updated_at_ms, request.usage_state_started_at_ms
        ));
    }
    if updated_at_ms > now_ms.saturating_add(skew_ms) {
        return Err(format!(
            "updatedAtMs {} is too far in the future",
            updated_at_ms
        ));
    }
    match flush_request_id {
        Some(id) if id == request.flush_request_id => Ok(()),
        Some(_) => Err(request_id_mismatch_message.to_string()),
        None => Err(missing_request_id_message.to_string()),
    }
}

/// Wait for all pending proxy usage reports to be delivered.
///
/// The runner writes a request marker, signals the Python addon, and then waits
/// for JSON in `{addon_dir}/usage-pending` that acknowledges that request with
/// the current mitmdump usage-state identity plus in-flight flow, buffered
/// event, and report counters. A successful drain requires current valid state
/// with the active `flushRequestId` and `flows == 0`, `buffered == 0`, and
/// `reports == 0`. Missing, unreadable, stale, wrong state id, wrong request
/// id, or invalid state is treated as not ready and waits until timeout. The
/// JSON `pid` is diagnostic only: mitmdump launchers can keep the runner's
/// direct child as a wrapper while the Python addon runs in a child process.
#[cfg(test)]
async fn wait_usage_flush(
    addon_dir: &Path,
    timeout: Duration,
    request: &UsageFlushRequest,
) -> bool {
    wait_usage_flush_requesting(addon_dir, timeout, request, || true).await
}

/// Wait for proxy usage drain while actively asking the addon for fresh snapshots.
pub async fn wait_usage_flush_requesting(
    addon_dir: &Path,
    timeout: Duration,
    request: &UsageFlushRequest,
    mut request_flush: impl FnMut() -> bool,
) -> bool {
    let path = addon_dir.join("usage-pending");
    let started_at = tokio::time::Instant::now();
    let deadline = started_at + timeout;
    let mut next_flush_request_at = started_at + USAGE_FLUSH_REQUEST_INTERVAL;
    loop {
        let (not_ready, snapshot) = match read_addon_state_file(&path).await {
            Ok(Some(content)) => match parse_usage_pending_state(&content) {
                Ok(state) => {
                    let snapshot = Some(UsagePendingSnapshot::from(&state));
                    match validate_usage_pending_state(&state, request, now_millis()) {
                        Ok(()) => {
                            if state.flows == 0 && state.buffered == 0 && state.reports == 0 {
                                return true;
                            }
                            (
                                format!(
                                    "pending flows={} buffered={} reports={}",
                                    state.flows, state.buffered, state.reports
                                ),
                                snapshot,
                            )
                        }
                        Err(reason) => (reason, snapshot),
                    }
                }
                Err(reason) => (reason, None),
            },
            Ok(None) => (format!("cannot read {}: not found", path.display()), None),
            Err(e) => (format!("cannot read {}: {e}", path.display()), None),
        };
        let now = tokio::time::Instant::now();
        if now >= next_flush_request_at {
            if !request_flush() {
                error!(
                    r#type = "usage_underbilling",
                    reason = "usage_flush_request_failed",
                    underbilling_class = "risk",
                    component = "runner",
                    not_ready = %not_ready,
                    request_usage_state_id = %request.core.expected_usage_state_id,
                    request_id = %request.core.flush_request_id,
                    "usage flush request failed, proceeding with proxy stop"
                );
                return false;
            }
            next_flush_request_at = now + USAGE_FLUSH_REQUEST_INTERVAL;
        }
        if now >= deadline {
            match snapshot {
                Some(snapshot) => error!(
                    r#type = "usage_underbilling",
                    reason = "usage_flush_timeout",
                    underbilling_class = "risk",
                    component = "runner",
                    timeout_secs = timeout.as_secs(),
                    not_ready = %not_ready,
                    pid = snapshot.pid,
                    usage_state_id = %snapshot.usage_state_id,
                    updated_at_ms = snapshot.updated_at_ms,
                    flows = snapshot.flows,
                    buffered = snapshot.buffered,
                    reports = snapshot.reports,
                    flush_request_id = snapshot.flush_request_id.as_deref().unwrap_or(""),
                    "usage flush timed out, proceeding with proxy stop"
                ),
                None => error!(
                    r#type = "usage_underbilling",
                    reason = "usage_flush_timeout",
                    underbilling_class = "risk",
                    component = "runner",
                    timeout_secs = timeout.as_secs(),
                    not_ready = %not_ready,
                    request_usage_state_id = %request.core.expected_usage_state_id,
                    request_id = %request.core.flush_request_id,
                    "usage flush timed out, proceeding with proxy stop"
                ),
            }
            return false;
        }
        tokio::time::sleep(std::cmp::min(USAGE_FLUSH_POLL, deadline - now)).await;
    }
}

#[cfg(test)]
async fn wait_jsonl_flush(
    addon_dir: &Path,
    timeout: Duration,
    request: &JsonlFlushRequest,
) -> bool {
    wait_jsonl_flush_requesting(addon_dir, timeout, request, || true).await
}

async fn wait_jsonl_flush_requesting(
    addon_dir: &Path,
    timeout: Duration,
    request: &JsonlFlushRequest,
    mut request_flush: impl FnMut() -> bool,
) -> bool {
    let path = addon_dir.join("jsonl-flush-state");
    let started_at = tokio::time::Instant::now();
    let deadline = started_at + timeout;
    let mut next_flush_request_at = started_at + JSONL_FLUSH_REQUEST_INTERVAL;
    loop {
        let (not_ready, snapshot) = match read_addon_state_file(&path).await {
            Ok(Some(content)) => match parse_jsonl_flush_state(&content) {
                Ok(state) => {
                    let snapshot = Some(JsonlFlushSnapshot::from(&state));
                    match validate_jsonl_flush_state(&state, request, now_millis()) {
                        Ok(()) => {
                            if state.pending == 0 {
                                return true;
                            }
                            (format!("pending writes={}", state.pending), snapshot)
                        }
                        Err(reason) => (reason, snapshot),
                    }
                }
                Err(reason) => (reason, None),
            },
            Ok(None) => (format!("cannot read {}: not found", path.display()), None),
            Err(e) => (format!("cannot read {}: {e}", path.display()), None),
        };
        let now = tokio::time::Instant::now();
        if now >= next_flush_request_at {
            if !request_flush() {
                warn!(
                    reason = %not_ready,
                    "JSONL flush request failed, proceeding with network log upload"
                );
                return false;
            }
            next_flush_request_at = now + JSONL_FLUSH_REQUEST_INTERVAL;
        }
        if now >= deadline {
            match snapshot {
                Some(snapshot) => warn!(
                    timeout_secs = timeout.as_secs(),
                    reason = %not_ready,
                    pid = snapshot.pid,
                    usage_state_id = %snapshot.usage_state_id,
                    updated_at_ms = snapshot.updated_at_ms,
                    flush_request_id = %snapshot.flush_request_id,
                    path = %snapshot.path,
                    pending = snapshot.pending,
                    "JSONL flush timed out, proceeding with network log upload"
                ),
                None => warn!(
                    timeout_secs = timeout.as_secs(),
                    reason = %not_ready,
                    "JSONL flush timed out, proceeding with network log upload"
                ),
            }
            return false;
        }
        tokio::time::sleep(std::cmp::min(JSONL_FLUSH_POLL, deadline - now)).await;
    }
}

async fn read_addon_state_file(path: &Path) -> RunnerResult<Option<String>> {
    crate::state_file::read_to_string(
        path,
        crate::state_file::USAGE_PENDING_MAX_BYTES,
        crate::state_file::OwnerCheck::None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::MitmProxy;
    use std::sync::atomic::Ordering;
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    fn make_fifo(path: &Path) {
        let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );
    }

    async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let output = future.await;
        drop(guard);
        (output, captured.entries())
    }

    fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
    }

    fn usage_target() -> UsageFlushTarget {
        UsageFlushTarget {
            expected_usage_state_id: "state-test".to_string(),
            usage_state_started_at_ms: 1_770_000_000_000,
        }
    }

    fn usage_request() -> UsageFlushRequest {
        UsageFlushRequest {
            core: FlushRequestCore {
                expected_usage_state_id: "state-test".to_string(),
                usage_state_started_at_ms: 1_770_000_000_000,
                flush_request_id: "request-test".to_string(),
                requested_at_ms: 1_770_000_000_000,
            },
        }
    }

    fn jsonl_request(path: &Path) -> JsonlFlushRequest {
        JsonlFlushRequest {
            core: FlushRequestCore {
                expected_usage_state_id: "state-test".to_string(),
                usage_state_started_at_ms: 1_770_000_000_000,
                flush_request_id: "jsonl-request-test".to_string(),
                requested_at_ms: 1_770_000_000_000,
            },
            path: path.to_string_lossy().into_owned(),
        }
    }

    fn jsonl_state(path: &Path, pending: u32) -> String {
        serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flushRequestId": "jsonl-request-test",
            "path": path.to_string_lossy().to_string(),
            "pending": pending,
        })
        .to_string()
    }

    fn usage_state(flows: u32, buffered: u32, reports: u32) -> String {
        usage_state_with_request(flows, buffered, reports, Some("request-test"))
    }

    fn usage_state_with_request(
        flows: u32,
        buffered: u32,
        reports: u32,
        flush_request_id: Option<&str>,
    ) -> String {
        let mut state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        });
        if let Some(flush_request_id) = flush_request_id {
            state["flushRequestId"] = serde_json::json!(flush_request_id);
        }
        state.to_string()
    }

    #[tokio::test]
    async fn write_usage_flush_request_writes_marker() {
        let dir = tempfile::tempdir().unwrap();
        let target = usage_target();

        let request = write_usage_flush_request(dir.path(), &target)
            .await
            .unwrap();

        let marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("usage-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["usageStateId"], "state-test");
        assert_eq!(marker["flushRequestId"], request.core.flush_request_id);
        assert_eq!(marker["requestedAtMs"], request.core.requested_at_ms);
    }

    #[tokio::test]
    async fn write_usage_flush_request_removes_tmp_when_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = usage_target();
        std::fs::create_dir(dir.path().join("usage-flush-request")).unwrap();

        let result = write_usage_flush_request(dir.path(), &target).await;

        assert!(result.is_err());
        let leaked_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .any(|name| name.to_string_lossy().ends_with(".tmp"));
        assert!(!leaked_tmp, "usage flush request tmp file leaked");
    }

    #[tokio::test]
    async fn write_jsonl_flush_request_writes_marker() {
        let dir = tempfile::tempdir().unwrap();
        let target = usage_target();
        let log_path = dir.path().join("network.jsonl");

        let request = write_jsonl_flush_request(dir.path(), &target, &log_path)
            .await
            .unwrap();

        let marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("jsonl-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["usageStateId"], "state-test");
        assert_eq!(marker["flushRequestId"], request.core.flush_request_id);
        assert_eq!(marker["requestedAtMs"], request.core.requested_at_ms);
        assert_eq!(marker["path"], log_path.to_string_lossy().to_string());
    }

    #[tokio::test]
    async fn write_jsonl_flush_request_removes_tmp_when_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = usage_target();
        let log_path = dir.path().join("network.jsonl");
        std::fs::create_dir(dir.path().join("jsonl-flush-request")).unwrap();

        let result = write_jsonl_flush_request(dir.path(), &target, &log_path).await;

        assert!(result.is_err());
        let leaked_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .any(|name| name.to_string_lossy().ends_with(".tmp"));
        assert!(!leaked_tmp, "JSONL flush request tmp file leaked");
    }

    fn usage_state_without_request(flows: u32, buffered: u32, reports: u32) -> String {
        serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        })
        .to_string()
    }

    const USAGE_FLUSH_TEST_DELAY: Duration = Duration::from_millis(1);

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_returns_true_when_zero() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        std::fs::write(
            dir.path().join("jsonl-flush-state"),
            jsonl_state(&log_path, 0),
        )
        .unwrap();
        assert!(wait_jsonl_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_rejects_wrong_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flushRequestId": "old-request",
            "path": log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(dir.path().join("jsonl-flush-state"), state.to_string()).unwrap();
        assert!(!wait_jsonl_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_rejects_wrong_path() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        std::fs::write(
            dir.path().join("jsonl-flush-state"),
            jsonl_state(&dir.path().join("other.jsonl"), 0),
        )
        .unwrap();
        assert!(!wait_jsonl_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_rejects_wrong_usage_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "old-state",
            "updatedAtMs": 1_770_000_000_001u64,
            "flushRequestId": "jsonl-request-test",
            "path": log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(dir.path().join("jsonl-flush-state"), state.to_string()).unwrap();
        assert!(!wait_jsonl_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_rejects_state_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        let outside = dir.path().join("outside-jsonl-flush-state");
        std::fs::write(&outside, jsonl_state(&log_path, 0)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("jsonl-flush-state")).unwrap();

        assert!(!wait_jsonl_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_rejects_fifo_state_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        make_fifo(&dir.path().join("jsonl-flush-state"));

        assert!(!wait_jsonl_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_jsonl_flush_requests_flush_when_pending() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let request = jsonl_request(&log_path);
        let path = dir.path().join("jsonl-flush-state");
        std::fs::write(&path, jsonl_state(&log_path, 1)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let l = log_path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let flushed =
            wait_jsonl_flush_requesting(dir.path(), Duration::from_secs(5), &request, || {
                requests.fetch_add(1, Ordering::SeqCst);
                std::fs::write(&p, jsonl_state(&l, 0)).unwrap();
                true
            })
            .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn jsonl_flush_handle_writes_request_and_sends_flush_signal() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("network.jsonl");
        let (tx, mut rx) = mpsc::channel(1);
        let usage_state = Arc::new(Mutex::new(usage_target()));
        let handle = MitmJsonlFlushHandle {
            addon_dir: dir.path().to_path_buf(),
            usage_state,
            request_lock: Arc::new(AsyncMutex::new(())),
            request_flush_tx: tx,
        };

        let d = dir.path().to_path_buf();
        let l = log_path.clone();
        let waiter = tokio::spawn(async move { handle.flush_path(&l).await });

        rx.recv().await.unwrap();
        let marker: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.join("jsonl-flush-request")).unwrap())
                .unwrap();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flushRequestId": marker["flushRequestId"],
            "path": log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(d.join("jsonl-flush-state"), state.to_string()).unwrap();

        assert!(waiter.await.unwrap());
    }

    #[tokio::test]
    async fn jsonl_flush_handle_serializes_concurrent_requests() {
        let dir = tempfile::tempdir().unwrap();
        let first_log_path = dir.path().join("network-a.jsonl");
        let second_log_path = dir.path().join("network-b.jsonl");
        let (tx, mut rx) = mpsc::channel(1);
        let handle = MitmJsonlFlushHandle {
            addon_dir: dir.path().to_path_buf(),
            usage_state: Arc::new(Mutex::new(usage_target())),
            request_lock: Arc::new(AsyncMutex::new(())),
            request_flush_tx: tx,
        };

        let first_handle = handle.clone();
        let first_path = first_log_path.clone();
        let first = tokio::spawn(async move { first_handle.flush_path(&first_path).await });

        rx.recv().await.unwrap();
        let first_marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("jsonl-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            first_marker["path"],
            first_log_path.to_string_lossy().to_string()
        );

        let second_handle = handle.clone();
        let second_path = second_log_path.clone();
        let second = tokio::spawn(async move { second_handle.flush_path(&second_path).await });
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());

        let first_state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flushRequestId": first_marker["flushRequestId"],
            "path": first_log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(
            dir.path().join("jsonl-flush-state"),
            first_state.to_string(),
        )
        .unwrap();
        assert!(first.await.unwrap());

        rx.recv().await.unwrap();
        let second_marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("jsonl-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            second_marker["path"],
            second_log_path.to_string_lossy().to_string()
        );
        let second_state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flushRequestId": second_marker["flushRequestId"],
            "path": second_log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(
            dir.path().join("jsonl-flush-state"),
            second_state.to_string(),
        )
        .unwrap();
        assert!(second.await.unwrap());
    }

    #[tokio::test]
    async fn jsonl_flush_handles_from_same_proxy_serialize_concurrent_requests() {
        let dir = tempfile::tempdir().unwrap();
        let first_log_path = dir.path().join("network-a.jsonl");
        let second_log_path = dir.path().join("network-b.jsonl");
        let (mut proxy, _crash_rx) = MitmProxy::noop();
        proxy.set_addon_dir_for_test(dir.path().to_path_buf());
        let (tx, mut rx) = mpsc::channel(1);
        let first_handle = proxy.jsonl_flush_handle(tx.clone());
        let second_handle = proxy.jsonl_flush_handle(tx);

        let first_path = first_log_path.clone();
        let first = tokio::spawn(async move { first_handle.flush_path(&first_path).await });

        rx.recv().await.unwrap();
        let first_marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("jsonl-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            first_marker["path"],
            first_log_path.to_string_lossy().to_string()
        );

        let second_path = second_log_path.clone();
        let second = tokio::spawn(async move { second_handle.flush_path(&second_path).await });
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());

        let first_state = serde_json::json!({
            "pid": 1234,
            "usageStateId": first_marker["usageStateId"],
            "updatedAtMs": now_millis(),
            "flushRequestId": first_marker["flushRequestId"],
            "path": first_log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(
            dir.path().join("jsonl-flush-state"),
            first_state.to_string(),
        )
        .unwrap();
        assert!(first.await.unwrap());

        rx.recv().await.unwrap();
        let second_marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("jsonl-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            second_marker["path"],
            second_log_path.to_string_lossy().to_string()
        );
        let second_state = serde_json::json!({
            "pid": 1234,
            "usageStateId": second_marker["usageStateId"],
            "updatedAtMs": now_millis(),
            "flushRequestId": second_marker["flushRequestId"],
            "path": second_log_path.to_string_lossy().to_string(),
            "pending": 0,
        });
        std::fs::write(
            dir.path().join("jsonl-flush-state"),
            second_state.to_string(),
        )
        .unwrap();
        assert!(second.await.unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_returns_true_when_zero() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(0, 0, 0)).unwrap();
        assert!(wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_missing_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(
            dir.path().join("usage-pending"),
            usage_state_without_request(0, 0, 0),
        )
        .unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_wrong_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(
            dir.path().join("usage-pending"),
            usage_state_with_request(0, 0, 0, Some("old-request")),
        )
        .unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_state_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let outside = dir.path().join("outside-usage-pending");
        std::fs::write(&outside, usage_state(0, 0, 0)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("usage-pending")).unwrap();

        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_fifo_state_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        make_fifo(&dir.path().join("usage-pending"));

        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_oversized_state() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(
            dir.path().join("usage-pending"),
            vec![b' '; crate::state_file::USAGE_PENDING_MAX_BYTES as usize + 1],
        )
        .unwrap();

        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_times_out_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_waits_for_state_file_to_appear() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");

        let p = path.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(USAGE_FLUSH_TEST_DELAY).await;
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
        });

        let d = dir.path().to_path_buf();
        assert!(wait_usage_flush(&d, Duration::from_secs(5), &request).await);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_waits_until_zero() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(2, 0, 1)).unwrap();

        let p = path.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(USAGE_FLUSH_TEST_DELAY).await;
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
        });

        let d = dir.path().to_path_buf();
        assert!(wait_usage_flush(&d, Duration::from_secs(5), &request).await);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_waits_until_buffered_zero() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(0, 2, 0)).unwrap();

        let p = path.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(USAGE_FLUSH_TEST_DELAY).await;
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
        });

        let d = dir.path().to_path_buf();
        assert!(wait_usage_flush(&d, Duration::from_secs(5), &request).await);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_buffered() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(0, 2, 0)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_reports_pending() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(0, 0, 1)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_request_id_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(
            &path,
            usage_state_with_request(0, 0, 0, Some("old-request")),
        )
        .unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_usage_state_id_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        let stale_state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "old-state",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(&path, stale_state.to_string()).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_state_file_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, "garbage").unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_throttles_repeat_flush_requests() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(0, 2, 0)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let requests = std::sync::Arc::clone(&request_count);
        let flushed = wait_usage_flush_requesting(
            dir.path(),
            USAGE_FLUSH_REQUEST_INTERVAL - Duration::from_millis(1),
            &request,
            || {
                requests.fetch_add(1, Ordering::SeqCst);
                true
            },
        )
        .await;

        assert!(!flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_returns_false_when_repeat_request_fails() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(0, 2, 0)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let requests = std::sync::Arc::clone(&request_count);
        let (flushed, events) = capture_async_log_events(wait_usage_flush_requesting(
            dir.path(),
            Duration::from_secs(5),
            &request,
            || {
                requests.fetch_add(1, Ordering::SeqCst);
                false
            },
        ))
        .await;

        assert!(!flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::ERROR);
        assert_event_field(
            event,
            "message",
            "usage flush request failed, proceeding with proxy stop",
        );
        assert_event_field(event, "type", "usage_underbilling");
        assert_event_field(event, "reason", "usage_flush_request_failed");
        assert_event_field(event, "underbilling_class", "risk");
        assert_event_field(event, "component", "runner");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(1, 0, 3)).unwrap();
        // Very short timeout — should return false.
        let (flushed, events) = capture_async_log_events(wait_usage_flush(
            dir.path(),
            Duration::from_millis(50),
            &request,
        ))
        .await;

        assert!(!flushed);
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::ERROR);
        assert_event_field(
            event,
            "message",
            "usage flush timed out, proceeding with proxy stop",
        );
        assert_event_field(event, "type", "usage_underbilling");
        assert_event_field(event, "reason", "usage_flush_timeout");
        assert_event_field(event, "underbilling_class", "risk");
        assert_event_field(event, "component", "runner");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_times_out_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), "garbage").unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_times_out_on_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), "").unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_unknown_field() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
            "extraField": "unexpected",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_legacy_state_without_buffered_count() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_missing_required_field() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_wrong_usage_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "old-state",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_allows_wrapper_pid_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 5678,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_stale_state() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_769_000_000_000u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_future_state() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": now_millis() + USAGE_PENDING_CLOCK_SKEW.as_millis() as u64 + 60_000,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }
}
