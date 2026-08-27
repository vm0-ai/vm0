use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use api_contracts::generated::routes;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::duration::duration_ms;
use crate::http::HttpClient;
use crate::ids::RunId;
use crate::types::SandboxReuseResult;
pub(crate) use session_history::{
    SessionHistoryCacheProbeMetadata, SessionHistoryContentEncodingState,
    SessionHistoryContentLengthState, SessionHistoryResponseTelemetryMetadata,
    SessionHistoryTelemetryFields, SessionHistoryTelemetryMetadata,
    SessionHistoryTransferEncodingState, session_history_prefix_extension_action_type,
};

mod session_history;

/// How long before we auto-flush pending ops (matching TS: 30s).
const FLUSH_THRESHOLD: Duration = Duration::from_secs(30);

/// Timeout for telemetry HTTP requests (shorter than default API timeout).
const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(5);
const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Effective resource path once the guest process has spawned.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RunnerStartupPath {
    Sandbox,
    Workspace,
    Cold,
}

/// Inclusive number of Runner jobs in post-claim work before guest process spawn.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum RunnerPreSpawnConcurrencyBucket {
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "3_4")]
    ThreeToFour,
    #[serde(rename = "5_8")]
    FiveToEight,
    #[serde(rename = "9_plus")]
    NinePlus,
}

/// Shared cohort label that becomes inactive when startup terminates before spawn.
#[derive(Clone)]
pub(crate) struct RunnerPreSpawnAttribution {
    bucket: RunnerPreSpawnConcurrencyBucket,
    active: Arc<AtomicBool>,
}

impl RunnerPreSpawnAttribution {
    pub(crate) fn new(bucket: RunnerPreSpawnConcurrencyBucket) -> Self {
        Self {
            bucket,
            active: Arc::new(AtomicBool::new(true)),
        }
    }

    pub(crate) fn deactivate(&self) {
        self.active.store(false, Ordering::Relaxed);
    }

    fn active_bucket(&self) -> Option<RunnerPreSpawnConcurrencyBucket> {
        self.active.load(Ordering::Relaxed).then_some(self.bucket)
    }
}

/// Per-job telemetry collector. Buffers sandbox operations and flushes them
/// periodically (auto on 30 s threshold) and at job end.
///
/// Owns its state — passed as `&mut` through the call chain, no `Mutex` needed.
#[must_use = "JobTelemetry owns pending and in-flight ops until `flush()` is awaited; dropping it loses them"]
pub struct JobTelemetry {
    http: HttpClient,
    run_id: RunId,
    sandbox_token: String,
    runner_hostname: Option<String>,
    runner_pre_spawn_attribution: Option<RunnerPreSpawnAttribution>,
    pending_ops: Vec<SandboxOp>,
    oldest_pending: Option<Instant>,
    in_flight_flushes: Vec<JoinHandle<()>>,
}

#[derive(Serialize, Clone)]
struct SandboxOp {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_startup_path: Option<RunnerStartupPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_reuse_result: Option<SandboxReuseResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_pre_spawn_concurrency_bucket: Option<RunnerPreSpawnConcurrencyBucket>,
    #[serde(flatten)]
    session_history: Option<SessionHistoryTelemetryFields>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryPayload {
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_hostname: Option<String>,
    runner_version: &'static str,
    sandbox_operations: Vec<SandboxOp>,
}

impl JobTelemetry {
    /// Create a per-job telemetry collector for the runner that owns the job.
    ///
    pub(crate) fn new(
        http: HttpClient,
        run_id: RunId,
        sandbox_token: String,
        runner_hostname: Option<String>,
    ) -> Self {
        Self {
            http,
            run_id,
            sandbox_token,
            runner_hostname,
            runner_pre_spawn_attribution: None,
            pending_ops: Vec::new(),
            oldest_pending: None,
            in_flight_flushes: Vec::new(),
        }
    }

    pub(crate) fn start_runner_pre_spawn_attribution(
        &mut self,
        attribution: RunnerPreSpawnAttribution,
    ) {
        self.runner_pre_spawn_attribution = Some(attribution);
    }

    /// Stop decorating operations after the success-only `api_to_spawn` boundary.
    pub(crate) fn finish_runner_pre_spawn_attribution(&mut self) {
        self.runner_pre_spawn_attribution = None;
    }

    /// Record a timed operation. Starts an owned auto-flush if the oldest
    /// pending op exceeds the 30 s threshold.
    pub fn record(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
    ) {
        self.record_inner(action_type, duration, success, error, None, None);
    }

    /// Record a timed operation with an optional bounded terminal outcome.
    pub(crate) fn record_with_outcome(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        outcome: Option<&str>,
    ) {
        self.record_inner(action_type, duration, success, error, outcome, None);
    }

    /// Record a timed operation using the timestamp captured when it completed.
    ///
    /// This preserves event timing when a concurrently polled operation cannot
    /// be added to this mutable buffer until another operation also finishes.
    pub(crate) fn record_at(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        completed_at: DateTime<Utc>,
    ) {
        self.push_operation(sandbox_op_at(
            action_type,
            duration,
            success,
            error,
            None,
            None,
            completed_at,
        ));
    }

    pub(crate) fn record_api_to_spawn(
        &mut self,
        duration: Duration,
        runner_startup_path: RunnerStartupPath,
        sandbox_reuse_result: SandboxReuseResult,
    ) {
        let mut op = sandbox_op("api_to_spawn", duration, true, None, None, None);
        op.runner_startup_path = Some(runner_startup_path);
        op.sandbox_reuse_result = Some(sandbox_reuse_result);
        self.push_operation(op);
    }

    /// Record a zero-duration operation with fixed low-cardinality outcome dimensions.
    pub(crate) fn record_bounded_outcome(
        &mut self,
        action_type: &'static str,
        success: bool,
        outcome: &'static str,
        reason: Option<&'static str>,
    ) {
        let mut op = sandbox_op(action_type, Duration::ZERO, success, None, None, None);
        op.outcome = Some(outcome.to_string());
        op.reason = reason.map(str::to_string);
        self.push_operation(op);
    }

    /// Record a timed operation with low-cardinality session-history transport
    /// dimensions derived from the hash-backed resume history ref.
    pub fn record_with_session_history_metadata(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        metadata: Option<SessionHistoryTelemetryMetadata>,
    ) {
        self.record_inner(action_type, duration, success, error, None, metadata);
    }

    pub(crate) fn reporter(&self) -> SandboxOpReporter {
        SandboxOpReporter {
            http: self.http.clone(),
            run_id: self.run_id,
            sandbox_token: self.sandbox_token.clone(),
            runner_hostname: self.runner_hostname.clone(),
        }
    }

    fn record_inner(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        outcome: Option<&str>,
        metadata: Option<SessionHistoryTelemetryMetadata>,
    ) {
        self.push_operation(sandbox_op(
            action_type,
            duration,
            success,
            error,
            outcome,
            metadata,
        ));
    }

    fn push_operation(&mut self, mut operation: SandboxOp) {
        operation.runner_pre_spawn_concurrency_bucket = self
            .runner_pre_spawn_attribution
            .as_ref()
            .and_then(RunnerPreSpawnAttribution::active_bucket);
        self.pending_ops.push(operation);
        if self.oldest_pending.is_none() {
            self.oldest_pending = Some(Instant::now());
        }

        if let Some(oldest) = self.oldest_pending
            && oldest.elapsed() >= FLUSH_THRESHOLD
        {
            self.start_auto_flush();
        }
    }

    /// Final flush — awaits buffered and already-started HTTP requests.
    /// Consumes self so callers can't accidentally record after flushing.
    pub async fn flush(mut self) {
        if self.pending_ops.is_empty() && self.in_flight_flushes.is_empty() {
            return;
        }
        let ops = std::mem::take(&mut self.pending_ops);
        let in_flight_flushes = std::mem::take(&mut self.in_flight_flushes);
        let run_id = self.run_id;
        let runner_hostname = self.runner_hostname.clone();

        tokio::join!(
            send_telemetry(
                &self.http,
                run_id,
                &self.sandbox_token,
                runner_hostname,
                ops,
            ),
            drain_in_flight_flushes(run_id, in_flight_flushes),
        );
    }

    /// Snapshot of buffered ops for tests. Returns `(action_type, success, error)`
    /// tuples in insertion order.
    #[cfg(test)]
    pub(crate) fn pending_ops_snapshot(&self) -> Vec<(String, bool, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| (op.action_type.clone(), op.success, op.error.clone()))
            .collect()
    }

    /// Snapshot of buffered ops for tests that need to assert duration semantics.
    #[cfg(test)]
    pub(crate) fn pending_ops_with_duration_snapshot(
        &self,
    ) -> Vec<(String, u64, bool, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.duration_ms,
                    op.success,
                    op.error.clone(),
                )
            })
            .collect()
    }

    /// Snapshot of buffered low-cardinality outcome dimensions for tests.
    #[cfg(test)]
    pub(crate) fn pending_ops_with_outcome_snapshot(
        &self,
    ) -> Vec<(String, bool, Option<String>, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.success,
                    op.outcome.clone(),
                    op.reason.clone(),
                )
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_ops_with_session_history_metadata_snapshot(
        &self,
    ) -> Vec<SessionHistoryTelemetrySnapshot> {
        self.pending_ops
            .iter()
            .map(|op| SessionHistoryTelemetrySnapshot {
                action_type: op.action_type.clone(),
                success: op.success,
                error: op.error.clone(),
                session_history: op.session_history,
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_ops_with_runner_startup_snapshot(
        &self,
    ) -> Vec<RunnerStartupTelemetrySnapshot> {
        self.pending_ops
            .iter()
            .map(|op| RunnerStartupTelemetrySnapshot {
                action_type: op.action_type.clone(),
                runner_startup_path: op.runner_startup_path,
                sandbox_reuse_result: op.sandbox_reuse_result,
                runner_pre_spawn_concurrency_bucket: op.runner_pre_spawn_concurrency_bucket,
            })
            .collect()
    }

    /// Rewind the oldest-pending marker to simulate a buffered op that has
    /// aged past the auto-flush threshold, without needing a real sleep or a
    /// paused tokio clock.
    #[cfg(test)]
    pub(crate) fn rewind_oldest_pending_for_test(&mut self, by: Duration) {
        if let Some(instant) = self.oldest_pending {
            self.oldest_pending = Some(instant - by);
        }
    }

    /// Start an owned flush for auto-threshold flushes.
    fn start_auto_flush(&mut self) {
        let ops = std::mem::take(&mut self.pending_ops);
        self.oldest_pending = None;

        let http = self.http.clone();
        let run_id = self.run_id;
        let sandbox_token = self.sandbox_token.clone();
        let runner_hostname = self.runner_hostname.clone();

        let handle = tokio::spawn(async move {
            send_telemetry(&http, run_id, &sandbox_token, runner_hostname, ops).await;
        });
        self.in_flight_flushes.push(handle);
    }
}

#[derive(Clone)]
pub(crate) struct SandboxOpReporter {
    http: HttpClient,
    run_id: RunId,
    sandbox_token: String,
    runner_hostname: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SandboxOpRecord {
    pub(crate) action_type: &'static str,
    pub(crate) duration: Duration,
    pub(crate) success: bool,
    pub(crate) error: Option<&'static str>,
}

impl SandboxOpRecord {
    pub(crate) const fn new(
        action_type: &'static str,
        duration: Duration,
        success: bool,
        error: Option<&'static str>,
    ) -> Self {
        Self {
            action_type,
            duration,
            success,
            error,
        }
    }
}

impl SandboxOpReporter {
    pub(crate) async fn report(&self, records: Vec<SandboxOpRecord>) {
        let ops = records
            .into_iter()
            .map(|record| {
                sandbox_op(
                    record.action_type,
                    record.duration,
                    record.success,
                    record.error,
                    None,
                    None,
                )
            })
            .collect();
        send_telemetry(
            &self.http,
            self.run_id,
            &self.sandbox_token,
            self.runner_hostname.clone(),
            ops,
        )
        .await;
    }
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionHistoryTelemetrySnapshot {
    pub(crate) action_type: String,
    pub(crate) success: bool,
    pub(crate) error: Option<String>,
    pub(crate) session_history: Option<SessionHistoryTelemetryFields>,
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RunnerStartupTelemetrySnapshot {
    pub(crate) action_type: String,
    pub(crate) runner_startup_path: Option<RunnerStartupPath>,
    pub(crate) sandbox_reuse_result: Option<SandboxReuseResult>,
    pub(crate) runner_pre_spawn_concurrency_bucket: Option<RunnerPreSpawnConcurrencyBucket>,
}

fn sandbox_op(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
    outcome: Option<&str>,
    metadata: Option<SessionHistoryTelemetryMetadata>,
) -> SandboxOp {
    sandbox_op_at(
        action_type,
        duration,
        success,
        error,
        outcome,
        metadata,
        Utc::now(),
    )
}

fn sandbox_op_at(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
    outcome: Option<&str>,
    metadata: Option<SessionHistoryTelemetryMetadata>,
    completed_at: DateTime<Utc>,
) -> SandboxOp {
    SandboxOp {
        ts: completed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        action_type: action_type.to_string(),
        duration_ms: duration_ms(duration),
        success,
        error: error.map(String::from),
        outcome: outcome.map(String::from),
        reason: None,
        runner_startup_path: None,
        sandbox_reuse_result: None,
        runner_pre_spawn_concurrency_bucket: None,
        session_history: metadata.map(SessionHistoryTelemetryFields::from),
    }
}

async fn drain_in_flight_flushes(run_id: RunId, in_flight_flushes: Vec<JoinHandle<()>>) {
    for handle in in_flight_flushes {
        if let Err(e) = handle.await {
            warn!(run_id = %run_id, error = %e, "telemetry auto-flush task failed");
        }
    }
}

async fn send_telemetry(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    runner_hostname: Option<String>,
    ops: Vec<SandboxOp>,
) {
    if ops.is_empty() {
        return;
    }

    let payload = TelemetryPayload {
        run_id: run_id.to_string(),
        runner_hostname,
        runner_version: RUNNER_VERSION,
        sandbox_operations: ops,
    };

    let req = http
        .request_route(routes::webhooks::agent::telemetry::SEND, sandbox_token)
        .timeout(TELEMETRY_TIMEOUT)
        .json(&payload);

    match req.send("telemetry").await {
        Ok(resp) if !resp.status().is_success() => {
            warn!(run_id = %run_id, status = %resp.status(), "telemetry flush rejected");
        }
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "telemetry flush failed");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::HttpClientConfig;
    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
    use crate::types::{
        ResumeSessionHistoryDownloadSource, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
        ResumeSessionHistoryRefKind,
    };

    fn http_client() -> HttpClient {
        http_client_for_api_url("http://localhost")
    }

    fn http_client_for_api_url(api_url: &str) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn session_history_metadata() -> SessionHistoryTelemetryMetadata {
        SessionHistoryTelemetryMetadata::from_ref(&ResumeSessionHistoryRef {
            kind: ResumeSessionHistoryRefKind::Blob,
            hash: "hash".to_string(),
            url: "https://example.com/history".to_string(),
            encoding: ResumeSessionHistoryEncoding::Gzip,
            raw_size: 128 * 1024,
            encoded_size: 16 * 1024,
            download_source: Some(ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint),
        })
    }

    #[test]
    fn sandbox_op_omits_optional_fields_without_session_history() {
        let op = SandboxOp {
            ts: "2026-01-15T10:00:00+00:00".to_string(),
            action_type: "sandbox_create".to_string(),
            duration_ms: 1500,
            success: true,
            error: None,
            outcome: None,
            reason: None,
            runner_startup_path: None,
            sandbox_reuse_result: None,
            runner_pre_spawn_concurrency_bucket: None,
            session_history: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "ts": "2026-01-15T10:00:00+00:00",
                "action_type": "sandbox_create",
                "duration_ms": 1500,
                "success": true,
            })
        );
    }

    #[test]
    fn bounded_outcome_serializes_fixed_dimensions() {
        let mut telemetry = JobTelemetry::new(http_client(), RunId::nil(), "tok".to_string(), None);
        telemetry.record_bounded_outcome(
            "storage_cache_fresh_delivery_scan_groups",
            true,
            "17_plus",
            Some("prepared"),
        );

        assert_eq!(
            serde_json::to_value(&telemetry.pending_ops[0]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending_ops[0].ts.clone(),
                "action_type": "storage_cache_fresh_delivery_scan_groups",
                "duration_ms": 0,
                "success": true,
                "outcome": "17_plus",
                "reason": "prepared",
            })
        );
    }

    #[tokio::test]
    async fn record_with_outcome_is_sent_in_flush_payload() {
        use httpmock::prelude::*;

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes(r#""action_type":"runner_host_physical_park_balloon_settle""#)
                    .body_includes(r#""duration_ms":125"#)
                    .body_includes(r#""success":true"#)
                    .body_includes(r#""outcome":"target_reached""#);
                then.status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"success":true,"id":"ok"}"#);
            })
            .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.base_url()),
            RunId::nil(),
            "tok".to_string(),
            None,
        );
        telemetry.record_with_outcome(
            "runner_host_physical_park_balloon_settle",
            Duration::from_millis(125),
            true,
            None,
            Some("target_reached"),
        );
        telemetry.flush().await;

        telemetry_mock.assert_calls_async(1).await;
    }

    #[test]
    fn api_to_spawn_serializes_bounded_startup_metadata() {
        let mut telemetry = JobTelemetry::new(http_client(), RunId::nil(), "tok".to_string(), None);
        telemetry.start_runner_pre_spawn_attribution(RunnerPreSpawnAttribution::new(
            RunnerPreSpawnConcurrencyBucket::ThreeToFour,
        ));
        telemetry.record_api_to_spawn(
            Duration::from_millis(125),
            RunnerStartupPath::Workspace,
            SandboxReuseResult::PoolMiss,
        );

        assert_eq!(
            serde_json::to_value(&telemetry.pending_ops[0]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending_ops[0].ts.clone(),
                "action_type": "api_to_spawn",
                "duration_ms": 125,
                "success": true,
                "runner_startup_path": "workspace",
                "sandbox_reuse_result": "poolMiss",
                "runner_pre_spawn_concurrency_bucket": "3_4",
            })
        );
    }

    #[test]
    fn telemetry_payload_flattens_session_history_fields() {
        let metadata = session_history_metadata()
            .with_cache_probe(SessionHistoryCacheProbeMetadata::new(true, false))
            .with_response(SessionHistoryResponseTelemetryMetadata::new(
                SessionHistoryContentLengthState::MatchesExpected,
                SessionHistoryContentEncodingState::Absent,
                SessionHistoryTransferEncodingState::Absent,
            ));
        let payload = TelemetryPayload {
            run_id: "abc-123".to_string(),
            runner_hostname: None,
            runner_version: RUNNER_VERSION,
            sandbox_operations: vec![SandboxOp {
                ts: "2026-01-15T10:00:00+00:00".to_string(),
                action_type: "test".to_string(),
                duration_ms: 100,
                success: true,
                error: None,
                outcome: None,
                reason: None,
                runner_startup_path: None,
                sandbox_reuse_result: None,
                runner_pre_spawn_concurrency_bucket: None,
                session_history: Some(metadata.into()),
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "runId": "abc-123",
                "runnerVersion": RUNNER_VERSION,
                "sandboxOperations": [{
                    "ts": "2026-01-15T10:00:00+00:00",
                    "action_type": "test",
                    "duration_ms": 100,
                    "success": true,
                    "encoding": "gzip",
                    "session_history_raw_size_bucket": "64_256_kib",
                    "session_history_encoded_size_bucket": "lt_64_kib",
                    "session_history_compression_ratio_bucket": "lt_0_25",
                    "session_history_ref_seen_recently": "true",
                    "session_history_ref_download_inflight": "false",
                    "session_history_content_length_state": "matches_expected",
                    "session_history_content_encoding_state": "absent",
                    "session_history_transfer_encoding_state": "absent",
                    "session_history_download_source": "configured_public_endpoint",
                }],
            })
        );
    }

    #[test]
    fn telemetry_payload_includes_canonical_attribution() {
        let payload = TelemetryPayload {
            run_id: "abc-123".to_string(),
            runner_hostname: Some("prod-1.aws.vm3.ai".to_string()),
            runner_version: RUNNER_VERSION,
            sandbox_operations: vec![],
        };

        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({
                "runId": "abc-123",
                "runnerHostname": "prod-1.aws.vm3.ai",
                "runnerVersion": RUNNER_VERSION,
                "sandboxOperations": [],
            })
        );
    }

    #[test]
    fn new_creates_empty_telemetry() {
        let http = http_client();
        let telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);
        assert!(telemetry.pending_ops.is_empty());
        assert!(telemetry.oldest_pending.is_none());
        assert!(telemetry.in_flight_flushes.is_empty());
    }

    #[test]
    fn record_buffers_ops() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("sandbox_create", Duration::from_millis(500), true, None);
        telemetry.record(
            "agent_execute",
            Duration::from_secs(10),
            false,
            Some("timeout"),
        );

        assert_eq!(telemetry.pending_ops.len(), 2);
        assert_eq!(telemetry.pending_ops[0].action_type, "sandbox_create");
        assert_eq!(telemetry.pending_ops[0].duration_ms, 500);
        assert!(telemetry.pending_ops[0].success);
        assert!(telemetry.pending_ops[0].error.is_none());
        assert_eq!(telemetry.pending_ops[1].action_type, "agent_execute");
        assert!(!telemetry.pending_ops[1].success);
        assert_eq!(telemetry.pending_ops[1].error.as_deref(), Some("timeout"));
        assert!(telemetry.oldest_pending.is_some());
    }

    #[test]
    fn record_with_session_history_metadata_buffers_low_cardinality_buckets() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);
        let metadata = session_history_metadata()
            .with_cache_probe(SessionHistoryCacheProbeMetadata::new(false, true))
            .with_response(SessionHistoryResponseTelemetryMetadata::new(
                SessionHistoryContentLengthState::MatchesExpected,
                SessionHistoryContentEncodingState::Absent,
                SessionHistoryTransferEncodingState::Chunked,
            ));

        telemetry.record_with_session_history_metadata(
            "session_history_download",
            Duration::from_millis(500),
            true,
            None,
            Some(metadata),
        );

        assert_eq!(
            telemetry.pending_ops_with_session_history_metadata_snapshot(),
            vec![SessionHistoryTelemetrySnapshot {
                action_type: "session_history_download".to_string(),
                success: true,
                error: None,
                session_history: Some(metadata.into()),
            }]
        );
    }

    #[test]
    fn record_saturates_large_duration() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("huge_op", Duration::MAX, true, None);

        assert_eq!(telemetry.pending_ops.len(), 1);
        assert_eq!(telemetry.pending_ops[0].duration_ms, u64::MAX);
    }

    #[tokio::test]
    async fn record_within_threshold_does_not_flush() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert_eq!(telemetry.pending_ops_snapshot().len(), 2);
        assert!(telemetry.oldest_pending.is_some());
    }

    #[tokio::test]
    async fn telemetry_flush_preserves_captured_operation_timestamp() {
        use httpmock::prelude::*;

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes(r#""ts":"2026-08-11T10:20:30.456Z""#)
                    .body_includes(r#""action_type":"concurrent_operation""#)
                    .body_includes(r#""runnerHostname":"prod-1.aws.vm3.ai""#)
                    .body_includes(format!(r#""runnerVersion":"{RUNNER_VERSION}""#));
                then.status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"success":true,"id":"ok"}"#);
            })
            .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.base_url()),
            RunId::nil(),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );
        let completed_at = DateTime::parse_from_rfc3339("2026-08-11T10:20:30.456Z")
            .unwrap()
            .with_timezone(&Utc);

        telemetry.record_at(
            "concurrent_operation",
            Duration::from_millis(25),
            true,
            None,
            completed_at,
        );
        telemetry.flush().await;

        telemetry_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn auto_flush_triggers_after_threshold() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("op1", Duration::from_millis(10), true, None);
        assert_eq!(telemetry.pending_ops_snapshot().len(), 1);

        // Age the oldest-pending marker past the threshold so the next record
        // starts an owned auto flush.
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.record("op2", Duration::from_millis(10), true, None);

        // start_auto_flush drains the buffer (including the op that
        // tripped the threshold) and resets the oldest-pending marker so the
        // next record re-seeds it.
        assert!(telemetry.pending_ops_snapshot().is_empty());
        assert!(telemetry.oldest_pending.is_none());
        assert_eq!(telemetry.in_flight_flushes.len(), 1);

        for handle in telemetry.in_flight_flushes.drain(..) {
            handle.abort();
            let _ = handle.await;
        }
    }

    #[tokio::test]
    async fn flush_waits_for_in_flight_auto_flush_after_buffer_is_drained() {
        use futures_util::FutureExt;

        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: release_rx,
            response: json_response("200 OK", r#"{"success":true}"#),
        }])
        .await;
        let api_url = server.url();

        let http = http_client_for_api_url(&api_url);
        let mut telemetry = JobTelemetry::new(
            http,
            RunId::nil(),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert!(telemetry.pending_ops_snapshot().is_empty());
        assert_eq!(telemetry.in_flight_flushes.len(), 1);

        let request = server.next_request("auto flush request").await;
        assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer tok")
        );
        assert!(request.contains(r#""action_type":"op1""#));
        assert!(request.contains(r#""action_type":"op2""#));
        assert!(!request.contains(r#""runnerName""#));
        assert!(request.contains(r#""runnerHostname":"prod-1.aws.vm3.ai""#));
        assert!(request.contains(&format!(r#""runnerVersion":"{RUNNER_VERSION}""#)));

        let mut flush = Box::pin(telemetry.flush());
        assert!(
            flush.as_mut().now_or_never().is_none(),
            "flush returned before the held auto-flush response completed"
        );

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), flush)
            .await
            .expect("flush should complete after the response is released");
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn detached_reporter_sends_sandbox_operations_payload() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let api_url = server.url();

        let telemetry = JobTelemetry::new(
            http_client_for_api_url(&api_url),
            RunId::nil(),
            "tok".to_string(),
            None,
        );
        let reporter = telemetry.reporter();

        reporter
            .report(vec![SandboxOpRecord::new(
                "storage_cache_background_fill_filled",
                Duration::from_millis(42),
                true,
                None,
            )])
            .await;

        let requests = server.assert_finished_with_requests().await;
        let request = &requests[0];
        assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer tok")
        );
        assert!(request.contains(r#""runId":"00000000-0000-0000-0000-000000000000""#));
        assert!(request.contains(r#""action_type":"storage_cache_background_fill_filled""#));
        assert!(request.contains(r#""duration_ms":42"#));
        assert!(request.contains(r#""success":true"#));
    }

    #[tokio::test]
    async fn canonical_attribution_is_sent_by_direct_reporter() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let api_url = server.url();

        let telemetry = JobTelemetry::new(
            http_client_for_api_url(&api_url),
            RunId::nil(),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );
        telemetry
            .reporter()
            .report(vec![SandboxOpRecord::new(
                "runner_attribution_test",
                Duration::from_millis(1),
                true,
                None,
            )])
            .await;

        let requests = server.assert_finished_with_requests().await;
        let request = &requests[0];
        assert!(!request.contains(r#""runnerName""#));
        assert!(request.contains(r#""runnerHostname":"prod-1.aws.vm3.ai""#));
        assert!(request.contains(&format!(r#""runnerVersion":"{RUNNER_VERSION}""#)));
    }
}
