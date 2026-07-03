use std::time::{Duration, Instant};

use api_contracts::generated::routes;
use chrono::Utc;
use serde::Serialize;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::duration::duration_ms;
use crate::http::HttpClient;
use crate::ids::RunId;
use crate::types::{ResumeSessionHistoryEncoding, ResumeSessionHistoryRef};

/// How long before we auto-flush pending ops (matching TS: 30s).
const FLUSH_THRESHOLD: Duration = Duration::from_secs(30);

/// Timeout for telemetry HTTP requests (shorter than default API timeout).
const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(5);

const SIZE_64_KIB: u64 = 64 * 1024;
const SIZE_256_KIB: u64 = 256 * 1024;
const SIZE_1_MIB: u64 = 1024 * 1024;
const SIZE_4_MIB: u64 = 4 * SIZE_1_MIB;
const SIZE_16_MIB: u64 = 16 * SIZE_1_MIB;
const SIZE_64_MIB: u64 = 64 * SIZE_1_MIB;

/// Per-job telemetry collector. Buffers sandbox operations and flushes them
/// periodically (auto on 30 s threshold) and at job end.
///
/// Owns its state — passed as `&mut` through the call chain, no `Mutex` needed.
#[must_use = "JobTelemetry owns pending and in-flight ops until `flush()` is awaited; dropping it loses them"]
pub struct JobTelemetry {
    http: HttpClient,
    run_id: RunId,
    sandbox_token: String,
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
    encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_history_raw_size_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_history_encoded_size_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_history_compression_ratio_bucket: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryPayload {
    run_id: String,
    sandbox_operations: Vec<SandboxOp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SessionHistoryTelemetryMetadata {
    encoding: &'static str,
    raw_size_bucket: &'static str,
    encoded_size_bucket: &'static str,
    compression_ratio_bucket: &'static str,
}

impl SessionHistoryTelemetryMetadata {
    pub(crate) fn from_ref(history_ref: &ResumeSessionHistoryRef) -> Self {
        let encoding = history_ref
            .encoding
            .unwrap_or(ResumeSessionHistoryEncoding::Identity);
        Self {
            encoding: session_history_encoding_value(encoding),
            raw_size_bucket: size_bucket(history_ref.raw_size),
            encoded_size_bucket: size_bucket(history_ref.encoded_size),
            compression_ratio_bucket: compression_ratio_bucket(
                encoding,
                history_ref.raw_size,
                history_ref.encoded_size,
            ),
        }
    }

    pub(crate) fn encoding(self) -> &'static str {
        self.encoding
    }

    fn raw_size_bucket(self) -> &'static str {
        self.raw_size_bucket
    }

    fn encoded_size_bucket(self) -> &'static str {
        self.encoded_size_bucket
    }

    fn compression_ratio_bucket(self) -> &'static str {
        self.compression_ratio_bucket
    }
}

impl JobTelemetry {
    /// Create a new per-job telemetry collector.
    pub fn new(http: HttpClient, run_id: RunId, sandbox_token: String) -> Self {
        Self {
            http,
            run_id,
            sandbox_token,
            pending_ops: Vec::new(),
            oldest_pending: None,
            in_flight_flushes: Vec::new(),
        }
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
        self.record_inner(
            action_type,
            duration,
            success,
            error,
            metadata.map(SessionHistoryTelemetryMetadata::encoding),
            metadata,
        );
    }

    fn record_inner(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        encoding: Option<&'static str>,
        metadata: Option<SessionHistoryTelemetryMetadata>,
    ) {
        self.pending_ops.push(SandboxOp {
            ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            action_type: action_type.to_string(),
            duration_ms: duration_ms(duration),
            success,
            error: error.map(String::from),
            encoding: encoding.map(String::from),
            session_history_raw_size_bucket: metadata
                .map(SessionHistoryTelemetryMetadata::raw_size_bucket)
                .map(String::from),
            session_history_encoded_size_bucket: metadata
                .map(SessionHistoryTelemetryMetadata::encoded_size_bucket)
                .map(String::from),
            session_history_compression_ratio_bucket: metadata
                .map(SessionHistoryTelemetryMetadata::compression_ratio_bucket)
                .map(String::from),
        });
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

        tokio::join!(
            send_telemetry(&self.http, run_id, &self.sandbox_token, ops),
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

    #[cfg(test)]
    pub(crate) fn pending_ops_with_session_history_metadata_snapshot(
        &self,
    ) -> Vec<SessionHistoryTelemetrySnapshot> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.success,
                    op.error.clone(),
                    op.encoding.clone(),
                    op.session_history_raw_size_bucket.clone(),
                    op.session_history_encoded_size_bucket.clone(),
                    op.session_history_compression_ratio_bucket.clone(),
                )
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

        let handle = tokio::spawn(async move {
            send_telemetry(&http, run_id, &sandbox_token, ops).await;
        });
        self.in_flight_flushes.push(handle);
    }
}

#[cfg(test)]
type SessionHistoryTelemetrySnapshot = (
    String,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

const fn session_history_encoding_value(encoding: ResumeSessionHistoryEncoding) -> &'static str {
    match encoding {
        ResumeSessionHistoryEncoding::Identity => "identity",
        ResumeSessionHistoryEncoding::Gzip => "gzip",
    }
}

const fn size_bucket(size: u64) -> &'static str {
    if size < SIZE_64_KIB {
        "lt_64_kib"
    } else if size < SIZE_256_KIB {
        "64_256_kib"
    } else if size < SIZE_1_MIB {
        "256_kib_1_mib"
    } else if size < SIZE_4_MIB {
        "1_4_mib"
    } else if size < SIZE_16_MIB {
        "4_16_mib"
    } else if size < SIZE_64_MIB {
        "16_64_mib"
    } else {
        "64_128_mib"
    }
}

fn compression_ratio_bucket(
    encoding: ResumeSessionHistoryEncoding,
    raw_size: u64,
    encoded_size: u64,
) -> &'static str {
    if encoding == ResumeSessionHistoryEncoding::Identity {
        return "identity";
    }
    if raw_size == 0 {
        return "ge_1";
    }

    let ratio = encoded_size as f64 / raw_size as f64;
    if ratio < 0.25 {
        "lt_0_25"
    } else if ratio < 0.5 {
        "0_25_0_5"
    } else if ratio < 0.75 {
        "0_5_0_75"
    } else if ratio < 1.0 {
        "0_75_1"
    } else {
        "ge_1"
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
    ops: Vec<SandboxOp>,
) {
    if ops.is_empty() {
        return;
    }

    let payload = TelemetryPayload {
        run_id: run_id.to_string(),
        sandbox_operations: ops,
    };

    let req = http
        .request_route(routes::webhooks::agent::telemetry::SEND, sandbox_token)
        .timeout(TELEMETRY_TIMEOUT)
        .json(&payload);

    match req.send().await {
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

    fn http_client() -> HttpClient {
        http_client_for_api_url("http://localhost")
    }

    fn http_client_for_api_url(api_url: &str) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
        })
        .unwrap()
    }

    fn http_headers_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn content_length(headers: &str) -> usize {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find_map(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0)
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> String {
        use tokio::io::AsyncReadExt;

        let mut buf = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 1024];
            let len = socket.read(&mut chunk).await.unwrap();
            assert!(len > 0, "connection closed before HTTP headers completed");
            buf.extend_from_slice(&chunk[..len]);

            if let Some(header_end) = http_headers_end(&buf) {
                break header_end;
            }
        };

        let headers = String::from_utf8_lossy(&buf[..header_end]);
        let body_len = content_length(&headers);
        while buf.len() < header_end + body_len {
            let mut chunk = [0; 1024];
            let len = socket.read(&mut chunk).await.unwrap();
            assert!(len > 0, "connection closed before HTTP body completed");
            buf.extend_from_slice(&chunk[..len]);
        }

        String::from_utf8(buf).unwrap()
    }

    #[test]
    fn sandbox_op_serializes_correctly() {
        let op = SandboxOp {
            ts: "2026-01-15T10:00:00+00:00".to_string(),
            action_type: "vm_create".to_string(),
            duration_ms: 1500,
            success: true,
            error: None,
            encoding: None,
            session_history_raw_size_bucket: None,
            session_history_encoded_size_bucket: None,
            session_history_compression_ratio_bucket: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json["ts"], "2026-01-15T10:00:00+00:00");
        assert_eq!(json["action_type"], "vm_create");
        assert_eq!(json["duration_ms"], 1500);
        assert_eq!(json["success"], true);
        assert!(json.get("error").is_none()); // omitted when None
    }

    #[test]
    fn telemetry_payload_uses_camel_case() {
        let payload = TelemetryPayload {
            run_id: "abc-123".to_string(),
            sandbox_operations: vec![SandboxOp {
                ts: "2026-01-15T10:00:00+00:00".to_string(),
                action_type: "test".to_string(),
                duration_ms: 100,
                success: true,
                error: None,
                encoding: Some("gzip".to_string()),
                session_history_raw_size_bucket: Some("64_256_kib".to_string()),
                session_history_encoded_size_bucket: Some("lt_64_kib".to_string()),
                session_history_compression_ratio_bucket: Some("lt_0_25".to_string()),
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("runId").is_some());
        assert!(json.get("sandboxOperations").is_some());
        assert_eq!(json["sandboxOperations"][0]["encoding"], "gzip");
        assert_eq!(
            json["sandboxOperations"][0]["session_history_raw_size_bucket"],
            "64_256_kib"
        );
        assert_eq!(
            json["sandboxOperations"][0]["session_history_encoded_size_bucket"],
            "lt_64_kib"
        );
        assert_eq!(
            json["sandboxOperations"][0]["session_history_compression_ratio_bucket"],
            "lt_0_25"
        );
    }

    #[test]
    fn new_creates_empty_telemetry() {
        let http = http_client();
        let telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());
        assert!(telemetry.pending_ops.is_empty());
        assert!(telemetry.oldest_pending.is_none());
        assert!(telemetry.in_flight_flushes.is_empty());
    }

    #[test]
    fn record_buffers_ops() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());

        telemetry.record("vm_create", Duration::from_millis(500), true, None);
        telemetry.record(
            "agent_execute",
            Duration::from_secs(10),
            false,
            Some("timeout"),
        );

        assert_eq!(telemetry.pending_ops.len(), 2);
        assert_eq!(telemetry.pending_ops[0].action_type, "vm_create");
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
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());
        let metadata = SessionHistoryTelemetryMetadata {
            encoding: "gzip",
            raw_size_bucket: "64_256_kib",
            encoded_size_bucket: "lt_64_kib",
            compression_ratio_bucket: "lt_0_25",
        };

        telemetry.record_with_session_history_metadata(
            "session_history_download",
            Duration::from_millis(500),
            true,
            None,
            Some(metadata),
        );

        assert_eq!(
            telemetry.pending_ops_with_session_history_metadata_snapshot(),
            vec![(
                "session_history_download".to_string(),
                true,
                None,
                Some("gzip".to_string()),
                Some("64_256_kib".to_string()),
                Some("lt_64_kib".to_string()),
                Some("lt_0_25".to_string())
            )]
        );
    }

    #[test]
    fn record_saturates_large_duration() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());

        telemetry.record("huge_op", Duration::MAX, true, None);

        assert_eq!(telemetry.pending_ops.len(), 1);
        assert_eq!(telemetry.pending_ops[0].duration_ms, u64::MAX);
    }

    #[tokio::test]
    async fn record_within_threshold_does_not_flush() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert_eq!(telemetry.pending_ops_snapshot().len(), 2);
        assert!(telemetry.oldest_pending.is_some());
    }

    #[tokio::test]
    async fn auto_flush_triggers_after_threshold() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());

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
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            request_tx.send(request).unwrap();
            release_rx.await.unwrap();
            socket
                .write_all(
                    concat!(
                        "HTTP/1.1 200 OK\r\n",
                        "content-length: 16\r\n",
                        "content-type: application/json\r\n",
                        "connection: close\r\n",
                        "\r\n",
                        r#"{"success":true}"#
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let http = http_client_for_api_url(&api_url);
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string());

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert!(telemetry.pending_ops_snapshot().is_empty());
        assert_eq!(telemetry.in_flight_flushes.len(), 1);

        let request = tokio::time::timeout(Duration::from_secs(1), request_rx)
            .await
            .expect("auto flush request should reach the server")
            .unwrap();
        assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer tok")
        );
        assert!(request.contains(r#""action_type":"op1""#));
        assert!(request.contains(r#""action_type":"op2""#));

        let mut flush = Box::pin(telemetry.flush());
        assert!(
            flush.as_mut().now_or_never().is_none(),
            "flush returned before the held auto-flush response completed"
        );

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), flush)
            .await
            .expect("flush should complete after the response is released");
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("server should exit")
            .unwrap();
    }
}
