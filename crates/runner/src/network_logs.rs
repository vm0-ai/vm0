use std::path::Path;
use std::time::Duration;

use api_contracts::generated::routes;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::time::{Instant, timeout_at};
use tracing::{info, warn};

use crate::http::HttpClient;
use crate::ids::RunId;

/// Network log entry from the per-run JSONL file.
///
/// `NETWORK_LOG_FIELDS` — shared schema boundary is api-contracts; producers
/// include mitmproxy plus Rust-side DNS/kmsg logging.
/// Uses a transparent `serde_json::Value` wrapper so all fields pass through
/// to Axiom without needing a struct field for each one. This avoids silently
/// dropping fields added by any producer.
#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
struct NetworkLog(serde_json::Value);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkLogPayload {
    run_id: String,
    network_logs: Vec<NetworkLog>,
}

const NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES: usize = 10_000;
const NETWORK_LOG_UPLOAD_INITIAL_BATCH_CAPACITY: usize = 500;
const NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES: usize = 1024 * 1024;
const NETWORK_LOG_UPLOAD_PAYLOAD_OVERHEAD_BYTES: usize = 64;
const NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES: usize = 1;
const NETWORK_LOG_UPLOAD_ERROR_BODY_MAX_BYTES: usize = 2048;
const NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS: usize = 512;
// Complement the per-request limits with finite per-run local, remote, and elapsed work.
const NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const NETWORK_LOG_UPLOAD_MAX_BATCHES: usize = 32;
const NETWORK_LOG_UPLOAD_MAX_DURATION: Duration = Duration::from_secs(10);

#[derive(Default)]
struct UploadRejectionDetails {
    error_code: Option<String>,
    error_message: Option<String>,
    body_truncated: bool,
    body_read_error: Option<String>,
}

#[derive(Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorDetails,
}

#[derive(Deserialize)]
struct ApiErrorDetails {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Copy)]
enum UploadOutcome {
    Missing,
    Complete,
    Truncated(UploadTruncationReason),
    Failed,
}

#[derive(Clone, Copy)]
enum UploadTruncationReason {
    SourceBytes,
    BatchCount,
    Deadline,
    OversizedEntry,
}

impl UploadTruncationReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::SourceBytes => "source_bytes",
            Self::BatchCount => "batch_count",
            Self::Deadline => "deadline",
            Self::OversizedEntry => "oversized_entry",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatchUploadOutcome {
    Continue,
    BatchLimit,
    Failed,
}

#[derive(Default)]
struct NetworkLogUploadProgress {
    source_file_bytes: Option<u64>,
    source_bytes_examined: u64,
    attempted_batches: usize,
    successful_batches: usize,
    attempted_entries: usize,
    uploaded_entries: usize,
    attempted_estimated_bytes: usize,
    uploaded_estimated_bytes: usize,
    unconfirmed_entries: usize,
    unconfirmed_estimated_bytes: usize,
    oversized_entries: usize,
    oversized_estimated_bytes: usize,
    observed_dropped_entries: usize,
    observed_dropped_estimated_bytes: usize,
    partial_source_line: bool,
}

/// Upload network logs from the per-run JSONL file.
/// Reads the file at `path`, POSTs bounded batches to telemetry endpoint,
/// and keeps the local file for debugging/log GC. Best-effort — failures only warn.
pub async fn upload_network_logs(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    path: &Path,
) {
    let deadline = Instant::now() + NETWORK_LOG_UPLOAD_MAX_DURATION;
    let mut uploader = NetworkLogBatchUploader::new(http, run_id, sandbox_token);
    let outcome = match timeout_at(
        deadline,
        upload_network_logs_inner(path, deadline, &mut uploader),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => UploadOutcome::Truncated(UploadTruncationReason::Deadline),
    };

    let truncation_reason = match outcome {
        UploadOutcome::Truncated(reason) => Some(reason),
        UploadOutcome::Complete | UploadOutcome::Failed
            if uploader.progress.oversized_entries > 0 =>
        {
            Some(UploadTruncationReason::OversizedEntry)
        }
        UploadOutcome::Missing | UploadOutcome::Complete | UploadOutcome::Failed => None,
    };
    if let Some(reason) = truncation_reason {
        uploader.warn_truncated(reason);
    }

    if matches!(
        outcome,
        UploadOutcome::Complete | UploadOutcome::Truncated(_)
    ) && uploader.total_uploaded() > 0
    {
        info!(
            run_id = %run_id,
            batches = uploader.successful_batch_count(),
            count = uploader.total_uploaded(),
            "uploaded network logs"
        );
    }
}

async fn upload_network_logs_inner(
    path: &Path,
    deadline: Instant,
    uploader: &mut NetworkLogBatchUploader<'_>,
) -> UploadOutcome {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return UploadOutcome::Missing,
        Err(e) => {
            warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
            return UploadOutcome::Failed;
        }
    };

    let source_file_bytes = match file.metadata().await {
        Ok(metadata) => metadata.len(),
        Err(e) => {
            warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
            return UploadOutcome::Failed;
        }
    };
    uploader.progress.source_file_bytes = Some(source_file_bytes);

    let source_is_larger_than_limit = source_file_bytes > NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES;
    let mut reader = BufReader::new(file.take(NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES));
    let mut line = Vec::new();
    let mut source_limit_reached = false;

    loop {
        if Instant::now() >= deadline {
            return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
        }

        line.clear();
        let bytes_read = match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(bytes_read) => bytes_read,
            Err(e) => {
                warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
                return UploadOutcome::Failed;
            }
        };
        uploader.progress.source_bytes_examined = uploader
            .progress
            .source_bytes_examined
            .saturating_add(bytes_read as u64);

        let reached_capped_source_end = source_is_larger_than_limit
            && uploader.progress.source_bytes_examined >= NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES;
        if reached_capped_source_end && !line.ends_with(b"\n") {
            uploader.progress.partial_source_line = true;
            source_limit_reached = true;
            break;
        }

        if Instant::now() >= deadline {
            return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
        }

        let line = match std::str::from_utf8(&line) {
            Ok(line) => line.trim(),
            Err(e) => {
                warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
                return UploadOutcome::Failed;
            }
        };
        if line.is_empty() {
            if reached_capped_source_end {
                source_limit_reached = true;
                break;
            }
            continue;
        }

        let log = match serde_json::from_str(line) {
            Ok(log) => log,
            Err(e) => {
                warn!(run_id = %uploader.run_id, error = %e, "malformed network log line");
                if reached_capped_source_end {
                    source_limit_reached = true;
                    break;
                }
                continue;
            }
        };
        let entry_bytes = estimated_entry_bytes(line);

        if Instant::now() >= deadline {
            return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
        }

        match uploader.push(log, entry_bytes).await {
            BatchUploadOutcome::Continue => {}
            BatchUploadOutcome::BatchLimit => {
                return UploadOutcome::Truncated(UploadTruncationReason::BatchCount);
            }
            BatchUploadOutcome::Failed => return UploadOutcome::Failed,
        }

        if reached_capped_source_end {
            source_limit_reached = true;
            break;
        }

        if !uploader.can_attempt_more_batches() {
            if uploader.progress.source_bytes_examined < source_file_bytes {
                return UploadOutcome::Truncated(UploadTruncationReason::BatchCount);
            }
            break;
        }
    }

    if Instant::now() >= deadline {
        return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
    }

    match uploader.finish().await {
        BatchUploadOutcome::Continue if source_limit_reached => {
            UploadOutcome::Truncated(UploadTruncationReason::SourceBytes)
        }
        BatchUploadOutcome::Continue => UploadOutcome::Complete,
        BatchUploadOutcome::BatchLimit => {
            uploader.discard_pending_batch();
            UploadOutcome::Truncated(UploadTruncationReason::BatchCount)
        }
        BatchUploadOutcome::Failed => UploadOutcome::Failed,
    }
}

struct NetworkLogBatchUploader<'a> {
    http: &'a HttpClient,
    run_id: RunId,
    sandbox_token: &'a str,
    batch: Vec<NetworkLog>,
    batch_bytes: usize,
    progress: NetworkLogUploadProgress,
}

impl<'a> NetworkLogBatchUploader<'a> {
    fn new(http: &'a HttpClient, run_id: RunId, sandbox_token: &'a str) -> Self {
        Self {
            http,
            run_id,
            sandbox_token,
            batch: Vec::with_capacity(NETWORK_LOG_UPLOAD_INITIAL_BATCH_CAPACITY),
            batch_bytes: empty_batch_estimated_bytes(&run_id),
            progress: NetworkLogUploadProgress::default(),
        }
    }

    async fn push(&mut self, log: NetworkLog, entry_bytes: usize) -> BatchUploadOutcome {
        if self.is_oversized_entry(entry_bytes) {
            self.progress.oversized_entries = self.progress.oversized_entries.saturating_add(1);
            self.progress.oversized_estimated_bytes = self
                .progress
                .oversized_estimated_bytes
                .saturating_add(entry_bytes);

            if !self.batch.is_empty() {
                let outcome = self.flush().await;
                if outcome != BatchUploadOutcome::Continue {
                    return outcome;
                }
            }
            return BatchUploadOutcome::Continue;
        }

        if !self.can_attempt_more_batches() {
            self.record_observed_dropped_entry(entry_bytes);
            return BatchUploadOutcome::BatchLimit;
        }

        if self.should_flush_before_push(entry_bytes) {
            let outcome = self.flush().await;
            if outcome != BatchUploadOutcome::Continue {
                return outcome;
            }
            if !self.can_attempt_more_batches() {
                self.record_observed_dropped_entry(entry_bytes);
                return BatchUploadOutcome::BatchLimit;
            }
        }

        self.batch.push(log);
        self.batch_bytes = self.batch_bytes.saturating_add(entry_bytes);

        if self.should_flush_after_push() {
            return self.flush().await;
        }

        BatchUploadOutcome::Continue
    }

    async fn finish(&mut self) -> BatchUploadOutcome {
        self.flush().await
    }

    fn total_uploaded(&self) -> usize {
        self.progress.uploaded_entries
    }

    fn successful_batch_count(&self) -> usize {
        self.progress.successful_batches
    }

    fn can_attempt_more_batches(&self) -> bool {
        self.progress.attempted_batches < NETWORK_LOG_UPLOAD_MAX_BATCHES
    }

    fn should_flush_before_push(&self, entry_bytes: usize) -> bool {
        !self.batch.is_empty()
            && (self.batch.len() >= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES
                || self.batch_bytes.saturating_add(entry_bytes)
                    > NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES)
    }

    fn should_flush_after_push(&self) -> bool {
        self.batch.len() >= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES
            || self.batch_bytes >= NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES
    }

    fn is_oversized_entry(&self, entry_bytes: usize) -> bool {
        empty_batch_estimated_bytes(&self.run_id).saturating_add(entry_bytes)
            > NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES
    }

    fn record_observed_dropped_entry(&mut self, entry_bytes: usize) {
        self.progress.observed_dropped_entries =
            self.progress.observed_dropped_entries.saturating_add(1);
        self.progress.observed_dropped_estimated_bytes = self
            .progress
            .observed_dropped_estimated_bytes
            .saturating_add(entry_bytes);
    }

    fn discard_pending_batch(&mut self) {
        self.progress.observed_dropped_entries = self
            .progress
            .observed_dropped_entries
            .saturating_add(self.batch.len());
        self.progress.observed_dropped_estimated_bytes = self
            .progress
            .observed_dropped_estimated_bytes
            .saturating_add(
                self.batch_bytes
                    .saturating_sub(empty_batch_estimated_bytes(&self.run_id)),
            );
        self.batch.clear();
        self.batch_bytes = empty_batch_estimated_bytes(&self.run_id);
    }

    fn warn_truncated(&self, reason: UploadTruncationReason) {
        let source_file_bytes_known = self.progress.source_file_bytes.is_some();
        let source_file_bytes = self.progress.source_file_bytes.unwrap_or_default();
        let remaining_source_bytes =
            source_file_bytes.saturating_sub(self.progress.source_bytes_examined);

        warn!(
            run_id = %self.run_id,
            reason = reason.as_str(),
            source_file_bytes,
            source_file_bytes_known,
            source_bytes_examined = self.progress.source_bytes_examined,
            remaining_source_bytes,
            remaining_source_bytes_known = source_file_bytes_known,
            attempted_batches = self.progress.attempted_batches,
            successful_batches = self.progress.successful_batches,
            attempted_entries = self.progress.attempted_entries,
            uploaded_entries = self.progress.uploaded_entries,
            unconfirmed_entries = self.progress.unconfirmed_entries,
            attempted_estimated_bytes = self.progress.attempted_estimated_bytes,
            uploaded_estimated_bytes = self.progress.uploaded_estimated_bytes,
            unconfirmed_estimated_bytes = self.progress.unconfirmed_estimated_bytes,
            oversized_entries = self.progress.oversized_entries,
            oversized_estimated_bytes = self.progress.oversized_estimated_bytes,
            observed_dropped_entries = self.progress.observed_dropped_entries,
            observed_dropped_estimated_bytes =
                self.progress.observed_dropped_estimated_bytes,
            partial_source_line = self.progress.partial_source_line,
            "network log upload truncated"
        );
    }

    async fn flush(&mut self) -> BatchUploadOutcome {
        if self.batch.is_empty() {
            return BatchUploadOutcome::Continue;
        }

        if !self.can_attempt_more_batches() {
            return BatchUploadOutcome::BatchLimit;
        }

        self.progress.attempted_batches = self.progress.attempted_batches.saturating_add(1);
        let batch_index = self.progress.attempted_batches;
        let logs = std::mem::replace(
            &mut self.batch,
            Vec::with_capacity(NETWORK_LOG_UPLOAD_INITIAL_BATCH_CAPACITY),
        );
        let batch_bytes = self.batch_bytes;
        self.batch_bytes = empty_batch_estimated_bytes(&self.run_id);
        let count = logs.len();
        self.progress.attempted_entries = self.progress.attempted_entries.saturating_add(count);
        self.progress.attempted_estimated_bytes = self
            .progress
            .attempted_estimated_bytes
            .saturating_add(batch_bytes);
        self.progress.unconfirmed_entries = count;
        self.progress.unconfirmed_estimated_bytes = batch_bytes;

        info!(run_id = %self.run_id, batch_index, count, "uploading network log batch");

        let payload = NetworkLogPayload {
            run_id: self.run_id.to_string(),
            network_logs: logs,
        };

        let result = self
            .http
            .request_route(routes::webhooks::agent::telemetry::SEND, self.sandbox_token)
            .json(&payload)
            .send("network_logs")
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                // File is kept locally for debugging; gc_job_logs deletes after 7 days.
                self.progress.successful_batches =
                    self.progress.successful_batches.saturating_add(1);
                self.progress.uploaded_entries =
                    self.progress.uploaded_entries.saturating_add(count);
                self.progress.uploaded_estimated_bytes = self
                    .progress
                    .uploaded_estimated_bytes
                    .saturating_add(batch_bytes);
                self.progress.unconfirmed_entries = 0;
                self.progress.unconfirmed_estimated_bytes = 0;
                BatchUploadOutcome::Continue
            }
            Ok(resp) => {
                let status = resp.status();
                self.progress.unconfirmed_entries = 0;
                self.progress.unconfirmed_estimated_bytes = 0;
                let rejection = upload_rejection_details(resp).await;
                warn!(
                    run_id = %self.run_id,
                    batch_index,
                    status = %status,
                    response_error_code = rejection.error_code.as_deref().unwrap_or(""),
                    response_error_message = rejection.error_message.as_deref().unwrap_or(""),
                    response_body_truncated = rejection.body_truncated,
                    response_body_read_error = rejection.body_read_error.as_deref().unwrap_or(""),
                    "network logs upload rejected"
                );
                BatchUploadOutcome::Failed
            }
            Err(e) => {
                warn!(
                    run_id = %self.run_id,
                    batch_index,
                    error = %e,
                    "network logs upload failed"
                );
                BatchUploadOutcome::Failed
            }
        }
    }
}

fn empty_batch_estimated_bytes(run_id: &RunId) -> usize {
    NETWORK_LOG_UPLOAD_PAYLOAD_OVERHEAD_BYTES + run_id.to_string().len()
}

fn estimated_entry_bytes(line: &str) -> usize {
    line.len()
        .saturating_add(NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES)
}

async fn upload_rejection_details(mut resp: reqwest::Response) -> UploadRejectionDetails {
    let mut body = Vec::new();
    let mut body_truncated = false;

    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = NETWORK_LOG_UPLOAD_ERROR_BODY_MAX_BYTES.saturating_sub(body.len());
                if chunk.len() > remaining {
                    if let Some(prefix) = chunk.get(..remaining) {
                        body.extend_from_slice(prefix);
                    }
                    body_truncated = true;
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                return UploadRejectionDetails {
                    body_read_error: Some(truncate_log_field(e.to_string())),
                    ..Default::default()
                };
            }
        }
    }

    parse_upload_rejection_body(&body, body_truncated)
}

fn parse_upload_rejection_body(body: &[u8], body_truncated: bool) -> UploadRejectionDetails {
    let Ok(api_error) = serde_json::from_slice::<ApiErrorEnvelope>(body) else {
        return UploadRejectionDetails {
            body_truncated,
            ..Default::default()
        };
    };

    UploadRejectionDetails {
        error_code: api_error.error.code.map(truncate_log_field),
        error_message: api_error.error.message.map(truncate_log_field),
        body_truncated,
        body_read_error: None,
    }
}

fn truncate_log_field(value: String) -> String {
    let mut truncated = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index == NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS {
            truncated.push_str("...");
            return truncated;
        }
        truncated.push(ch);
    }
    value
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use httpmock::prelude::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    use crate::http::HttpClientConfig;

    use super::*;

    const SANDBOX_TOKEN: &str = "sandbox-token";

    fn http_for_server(server: &MockServer) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: server.base_url(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn network_log_file(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("network.jsonl")
    }

    fn network_log_content(logs: &[serde_json::Value]) -> String {
        logs.iter()
            .map(|log| serde_json::to_string(log).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }

    fn one_entry_per_batch_logs(count: usize) -> Vec<serde_json::Value> {
        let body = "x".repeat(NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES / 2);
        (0..count)
            .map(|sequence| {
                json!({
                    "sequence": sequence,
                    "body": &body,
                })
            })
            .collect()
    }

    fn estimated_batch_bytes(run_id: &RunId, logs: &[serde_json::Value]) -> usize {
        logs.iter().fold(
            empty_batch_estimated_bytes(run_id),
            |estimated_bytes, log| {
                estimated_bytes
                    .saturating_add(estimated_entry_bytes(&serde_json::to_string(log).unwrap()))
            },
        )
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

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
    }

    fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
    }

    fn has_captured_event(events: &[CapturedEvent], message: &str) -> bool {
        events.iter().any(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
    }

    async fn read_http_request_body(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut chunk = [0_u8; 8192];

        loop {
            let bytes_read = stream.read(&mut chunk).await.unwrap();
            assert!(bytes_read > 0, "connection closed before request completed");
            request.extend_from_slice(&chunk[..bytes_read]);

            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") {
                        Some(value.trim().parse::<usize>().unwrap())
                    } else {
                        None
                    }
                })
                .expect("request must include content-length");
            let body_start = header_end + 4;
            if request.len() >= body_start + content_length {
                return request[body_start..body_start + content_length].to_vec();
            }
        }
    }

    #[test]
    fn network_log_preserves_all_fields() {
        let json = r#"{"timestamp":"2026-02-15T10:00:00","action":"ALLOW","host":"api.github.com","port":443,"method":"GET","url":"https://api.github.com/repos/vm0-ai/vm0","status":200,"latency_ms":150,"request_size":0,"response_size":1024,"firewall_base":"https://api.github.com","firewall_name":"github","firewall_permission":"metadata:read","firewall_rule_match":"GET /repos/{owner}/{repo}"}"#;
        let log: NetworkLog = serde_json::from_str(json).unwrap();
        let v = &log.0;
        assert_eq!(v["method"], "GET");
        assert_eq!(v["status"], 200);
        assert_eq!(v["firewall_name"], "github");
        assert_eq!(v["firewall_permission"], "metadata:read");
    }

    #[test]
    fn network_log_round_trip() {
        let json = r#"{"timestamp":"2026-02-15T10:00:00","action":"DENY","host":"evil.com","port":443,"method":"GET","url":"https://evil.com","status":403,"latency_ms":5,"request_size":0,"response_size":0,"firewall_base":"https://evil.com","firewall_name":"blocked"}"#;
        let log: NetworkLog = serde_json::from_str(json).unwrap();
        let reserialized = serde_json::to_value(&log).unwrap();
        assert_eq!(reserialized["action"], "DENY");
        assert_eq!(reserialized["firewall_name"], "blocked");
    }

    #[test]
    fn network_log_payload_uses_camel_case() {
        let payload = NetworkLogPayload {
            run_id: "abc".to_string(),
            network_logs: vec![],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("runId").is_some());
        assert!(json.get("networkLogs").is_some());
    }

    #[test]
    fn network_log_malformed_line_skipped() {
        let valid = r#"{"timestamp":"2026-02-15T10:00:00"}"#;
        let invalid = "not json at all";
        assert!(serde_json::from_str::<NetworkLog>(valid).is_ok());
        assert!(serde_json::from_str::<NetworkLog>(invalid).is_err());
    }

    #[test]
    fn upload_rejection_body_parser_extracts_bounded_api_error_fields() {
        let long_message = "x".repeat(NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS + 1);
        let body = json!({
            "error": {
                "code": "BAD_REQUEST",
                "message": long_message,
            },
        });
        let details = parse_upload_rejection_body(body.to_string().as_bytes(), false);

        assert_eq!(details.error_code.as_deref(), Some("BAD_REQUEST"));
        assert_eq!(
            details.error_message.unwrap().len(),
            NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS + 3
        );
        assert!(!details.body_truncated);
        assert!(details.body_read_error.is_none());
    }

    #[test]
    fn upload_rejection_body_parser_ignores_malformed_body() {
        let details = parse_upload_rejection_body(b"not-json", true);

        assert_eq!(details.error_code, None);
        assert_eq!(details.error_message, None);
        assert!(details.body_truncated);
        assert!(details.body_read_error.is_none());
    }

    #[tokio::test]
    async fn upload_network_logs_posts_payload_and_keeps_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let first = json!({
            "timestamp": "2026-02-15T10:00:00Z",
            "action": "ALLOW",
            "host": "api.github.com",
            "status": 200,
        });
        let second = json!({
            "timestamp": "2026-02-15T10:00:01Z",
            "action": "DENY",
            "host": "blocked.example",
            "status": 403,
        });
        let content = format!(
            "{}\n{}\n",
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": [first, second],
        });
        let upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .header("authorization", format!("Bearer {SANDBOX_TOKEN}"))
                    .json_body(expected.clone());
                then.status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"success":true}"#);
            })
            .await;

        let http = http_for_server(&server);
        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

        upload.assert_calls_async(1).await;
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
    }

    #[tokio::test]
    async fn upload_network_logs_splits_batches_by_entry_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let logs: Vec<_> = (0..=NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES)
            .map(|idx| {
                json!({
                    "timestamp": "2026-02-15T10:00:00Z",
                    "host": format!("host-{idx}.example"),
                    "sequence": idx,
                })
            })
            .collect();
        let content = network_log_content(&logs);
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let first_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[..NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES].to_vec(),
        });
        let second_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES..].to_vec(),
        });
        let first_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(first_expected.clone());
                then.status(200);
            })
            .await;
        let second_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(second_expected.clone());
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

        first_upload.assert_calls_async(1).await;
        second_upload.assert_calls_async(1).await;
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
    }

    #[tokio::test]
    async fn upload_network_logs_allows_exact_batch_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let logs = one_entry_per_batch_logs(NETWORK_LOG_UPLOAD_MAX_BATCHES);
        tokio::fs::write(&path, network_log_content(&logs))
            .await
            .unwrap();

        let server = MockServer::start_async().await;
        let upload = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        let (_, events) =
            capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path))
                .await;

        upload
            .assert_calls_async(NETWORK_LOG_UPLOAD_MAX_BATCHES)
            .await;
        assert!(!has_captured_event(&events, "network log upload truncated"));
    }

    #[tokio::test(start_paused = true)]
    async fn upload_network_logs_completes_incident_sized_file_within_batch_budget() {
        const INCIDENT_SOURCE_BYTES: usize = 15_175_970;
        const INCIDENT_ENTRY_COUNT: usize = 48_060;
        const INCIDENT_BODY_BYTES: usize = 252;

        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let body = "x".repeat(INCIDENT_BODY_BYTES);
        let mut content = String::with_capacity(INCIDENT_SOURCE_BYTES);
        for sequence in 0..INCIDENT_ENTRY_COUNT {
            writeln!(
                &mut content,
                r#"{{"timestamp":"2026-02-15T10:00:00Z","sequence":{sequence},"body":"{body}"}}"#
            )
            .unwrap();
        }
        assert!(content.len().abs_diff(INCIDENT_SOURCE_BYTES) <= 1024);
        tokio::fs::write(&path, &content).await.unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let received_batches = Arc::new(Mutex::new(Vec::new()));
        let server_batches = received_batches.clone();
        let stop_server = Arc::new(tokio::sync::Notify::new());
        let server_stop = stop_server.clone();
        let server_task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = tokio::select! {
                    () = server_stop.notified() => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let request_body = read_http_request_body(&mut stream).await;
                let payload: serde_json::Value = serde_json::from_slice(&request_body).unwrap();
                let logs = payload["networkLogs"].as_array().unwrap();
                let estimated_bytes = estimated_batch_bytes(&run_id, logs);
                assert!(logs.len() <= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES);
                assert!(estimated_bytes <= NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES);
                server_batches.lock().unwrap().push(logs.len());
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();
            }
        });

        let http = HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap();
        let clock_guard = tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        });
        let (_, events) =
            capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path))
                .await;
        clock_guard.abort();
        let _ = clock_guard.await;
        stop_server.notify_one();
        server_task.await.unwrap();

        let (received_batch_count, received_entry_count) = {
            let received_batches = received_batches.lock().unwrap();
            (
                received_batches.len(),
                received_batches.iter().sum::<usize>(),
            )
        };
        assert!(received_batch_count > 0);
        assert!(received_batch_count <= NETWORK_LOG_UPLOAD_MAX_BATCHES);
        assert_eq!(received_entry_count, INCIDENT_ENTRY_COUNT);
        let uploaded = captured_event(&events, "uploaded network logs");
        assert_event_field(uploaded, "batches", &received_batch_count.to_string());
        assert_event_field(uploaded, "count", &INCIDENT_ENTRY_COUNT.to_string());
        assert!(!has_captured_event(&events, "network log upload truncated"));
        assert_eq!(
            tokio::fs::metadata(&path).await.unwrap().len(),
            content.len() as u64
        );
    }

    #[tokio::test]
    async fn upload_network_logs_stops_at_batch_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let uploaded_count = NETWORK_LOG_UPLOAD_MAX_BATCHES;
        let logs = one_entry_per_batch_logs(uploaded_count + 2);
        let content = network_log_content(&logs);
        let dropped_entry_bytes =
            estimated_entry_bytes(&serde_json::to_string(&logs[uploaded_count]).unwrap());
        let remaining_source_bytes = serde_json::to_string(&logs[uploaded_count + 1])
            .unwrap()
            .len()
            + 1;
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let upload = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        let (_, events) =
            capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path))
                .await;

        upload
            .assert_calls_async(NETWORK_LOG_UPLOAD_MAX_BATCHES)
            .await;
        let event = captured_event(&events, "network log upload truncated");
        assert_event_field(event, "reason", "batch_count");
        assert_event_field(event, "source_file_bytes", &content.len().to_string());
        assert_event_field(
            event,
            "source_bytes_examined",
            &(content.len() - remaining_source_bytes).to_string(),
        );
        assert_event_field(
            event,
            "remaining_source_bytes",
            &remaining_source_bytes.to_string(),
        );
        assert_event_field(
            event,
            "attempted_batches",
            &NETWORK_LOG_UPLOAD_MAX_BATCHES.to_string(),
        );
        assert_event_field(
            event,
            "successful_batches",
            &NETWORK_LOG_UPLOAD_MAX_BATCHES.to_string(),
        );
        assert_event_field(event, "attempted_entries", &uploaded_count.to_string());
        assert_event_field(event, "uploaded_entries", &uploaded_count.to_string());
        assert_event_field(event, "unconfirmed_entries", "0");
        assert_event_field(event, "observed_dropped_entries", "1");
        assert_event_field(
            event,
            "observed_dropped_estimated_bytes",
            &dropped_entry_bytes.to_string(),
        );
    }

    #[tokio::test]
    async fn upload_network_logs_splits_batches_by_estimated_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let large_value = "x".repeat(NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES / 2);
        let first = json!({
            "timestamp": "2026-02-15T10:00:00Z",
            "host": "large-first.example",
            "body": large_value,
        });
        let second = json!({
            "timestamp": "2026-02-15T10:00:01Z",
            "host": "large-second.example",
            "body": large_value,
        });
        let logs = vec![first.clone(), second.clone()];
        let content = network_log_content(&logs);
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let first_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": [first],
        });
        let second_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": [second],
        });
        let first_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(first_expected.clone());
                then.status(200);
            })
            .await;
        let second_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(second_expected.clone());
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

        first_upload.assert_calls_async(1).await;
        second_upload.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn upload_network_logs_skips_oversized_entry_and_continues() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let oversized_value = "x".repeat(NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES);
        let oversized = json!({
            "timestamp": "2026-02-15T10:00:00Z",
            "host": "oversized.example",
            "body": oversized_value,
        });
        let valid = json!({
            "timestamp": "2026-02-15T10:00:01Z",
            "host": "valid-after-oversized.example",
        });
        let logs = vec![oversized, valid.clone()];
        let content = network_log_content(&logs);
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": [valid],
        });
        let upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(expected.clone());
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        let (_, events) =
            capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path))
                .await;

        upload.assert_calls_async(1).await;
        let event = captured_event(&events, "network log upload truncated");
        assert_event_field(event, "reason", "oversized_entry");
        assert_event_field(event, "attempted_batches", "1");
        assert_event_field(event, "successful_batches", "1");
        assert_event_field(event, "attempted_entries", "1");
        assert_event_field(event, "uploaded_entries", "1");
        assert_event_field(event, "unconfirmed_entries", "0");
        assert_event_field(event, "oversized_entries", "1");
        assert_event_field(event, "observed_dropped_entries", "0");
        assert_event_field(event, "remaining_source_bytes", "0");
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
    }

    #[tokio::test]
    async fn upload_network_logs_stops_at_source_byte_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let mut content = vec![b'x'; NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES as usize - 1];
        content.extend_from_slice("€".as_bytes());
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let upload = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        let (_, events) = capture_async_log_events(upload_network_logs(
            &http,
            RunId::nil(),
            SANDBOX_TOKEN,
            &path,
        ))
        .await;

        upload.assert_calls_async(0).await;
        let event = captured_event(&events, "network log upload truncated");
        assert_event_field(event, "reason", "source_bytes");
        assert_event_field(event, "source_file_bytes", &content.len().to_string());
        assert_event_field(
            event,
            "source_bytes_examined",
            &NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES.to_string(),
        );
        assert_event_field(event, "remaining_source_bytes", "2");
        assert_event_field(event, "attempted_batches", "0");
        assert_event_field(event, "attempted_entries", "0");
        assert_event_field(event, "partial_source_line", "true");
        assert!(!has_captured_event(&events, "failed to read network logs"));
        assert!(!has_captured_event(&events, "malformed network log line"));
        assert_eq!(
            tokio::fs::metadata(&path).await.unwrap().len(),
            content.len() as u64
        );
    }

    #[tokio::test]
    async fn upload_network_logs_allows_exact_source_byte_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let log = json!({ "sequence": 1 });
        let mut content = network_log_content(std::slice::from_ref(&log)).into_bytes();
        content.resize(NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES as usize, b' ');
        tokio::fs::write(&path, &content).await.unwrap();

        let server = MockServer::start_async().await;
        let expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": [log],
        });
        let upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(expected.clone());
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        let (_, events) =
            capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path))
                .await;

        upload.assert_calls_async(1).await;
        assert!(!has_captured_event(&events, "network log upload truncated"));
        assert_eq!(
            tokio::fs::metadata(&path).await.unwrap().len(),
            NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES
        );
    }

    #[tokio::test]
    async fn upload_network_logs_skips_malformed_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let first = json!({
            "timestamp": "2026-02-15T10:00:00Z",
            "host": "first-valid.example",
        });
        let second = json!({
            "timestamp": "2026-02-15T10:00:01Z",
            "host": "second-valid.example",
        });
        tokio::fs::write(
            &path,
            format!(
                "{}\nnot json with invalid.example\n{}\n\n",
                serde_json::to_string(&first).unwrap(),
                serde_json::to_string(&second).unwrap()
            ),
        )
        .await
        .unwrap();

        let server = MockServer::start_async().await;
        let expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": [first, second],
        });
        let upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(expected.clone());
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

        upload.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn upload_network_logs_stops_after_rejected_batch() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let run_id = RunId::nil();
        let logs = one_entry_per_batch_logs(3);
        tokio::fs::write(&path, network_log_content(&logs))
            .await
            .unwrap();

        let server = MockServer::start_async().await;
        let first_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[..1].to_vec(),
        });
        let second_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[1..2].to_vec(),
        });
        let third_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[2..].to_vec(),
        });
        let first_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(first_expected.clone());
                then.status(200);
            })
            .await;
        let second_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(second_expected.clone());
                then.status(500);
            })
            .await;
        let third_upload = server
            .mock_async(move |when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .json_body(third_expected.clone());
                then.status(200);
            })
            .await;

        let http = http_for_server(&server);
        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

        first_upload.assert_calls_async(1).await;
        second_upload.assert_calls_async(1).await;
        third_upload.assert_calls_async(0).await;
        assert!(path.exists());
    }

    #[tokio::test]
    async fn upload_network_logs_returns_without_post_for_empty_missing_or_unreadable_input() {
        let server = MockServer::start_async().await;
        let upload = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.status(200);
            })
            .await;
        let http = http_for_server(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().unwrap();

        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &network_log_file(&dir)).await;

        let empty = dir.path().join("empty.jsonl");
        tokio::fs::write(&empty, " \n\t\n").await.unwrap();
        upload_network_logs(&http, run_id, SANDBOX_TOKEN, &empty).await;

        upload_network_logs(&http, run_id, SANDBOX_TOKEN, dir.path()).await;

        upload.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn upload_network_logs_returns_without_retry_when_server_rejects() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        tokio::fs::write(&path, r#"{"host":"reject.example"}"#)
            .await
            .unwrap();

        let server = MockServer::start_async().await;
        let upload = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.status(400)
                    .header("content-type", "application/json")
                    .json_body(json!({
                        "error": {
                            "code": "BAD_REQUEST",
                            "message": "networkLogs.0.action: Invalid option: expected one of \"ALLOW\"|\"DENY\"|\"BLOCK\"",
                        },
                    }));
            })
            .await;

        let http = http_for_server(&server);
        let (_, events) = capture_async_log_events(upload_network_logs(
            &http,
            RunId::nil(),
            SANDBOX_TOKEN,
            &path,
        ))
        .await;

        upload.assert_calls_async(1).await;
        let event = captured_event(&events, "network logs upload rejected");
        assert_event_field(event, "status", "400 Bad Request");
        assert_event_field(event, "response_error_code", "BAD_REQUEST");
        assert_event_field(
            event,
            "response_error_message",
            "networkLogs.0.action: Invalid option: expected one of \"ALLOW\"|\"DENY\"|\"BLOCK\"",
        );
        assert_event_field(event, "response_body_truncated", "false");
        assert!(path.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn upload_network_logs_uses_one_absolute_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        let logs = one_entry_per_batch_logs(3);
        tokio::fs::write(&path, network_log_content(&logs))
            .await
            .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let first_received = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let second_received = Arc::new(tokio::sync::Notify::new());
        let server_task = {
            let first_received = first_received.clone();
            let release_first = release_first.clone();
            let second_received = second_received.clone();
            tokio::spawn(async move {
                let (mut first, _) = listener.accept().await.unwrap();
                let _ = read_http_request_body(&mut first).await;
                first_received.notify_one();
                release_first.notified().await;
                first
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();
                drop(first);

                let (mut second, _) = listener.accept().await.unwrap();
                let _ = read_http_request_body(&mut second).await;
                second_received.notify_one();
                let hold_second = tokio::sync::Notify::new();
                hold_second.notified().await;
                drop(second);
            })
        };

        let http = HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap();
        let upload = capture_async_log_events(upload_network_logs(
            &http,
            RunId::nil(),
            SANDBOX_TOKEN,
            &path,
        ));
        tokio::pin!(upload);
        let clock_guard = tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        });

        tokio::select! {
            () = first_received.notified() => {}
            result = &mut upload => panic!("upload ended before first request: {result:#?}"),
        }
        tokio::time::advance(Duration::from_secs(6)).await;
        release_first.notify_one();
        tokio::select! {
            () = second_received.notified() => {}
            result = &mut upload => panic!("upload ended before second request: {result:#?}"),
        }
        clock_guard.abort();
        let _ = clock_guard.await;
        tokio::time::advance(Duration::from_secs(4)).await;

        let (_, events) = upload.await;
        server_task.abort();
        let _ = server_task.await;

        let truncation = captured_event(&events, "network log upload truncated");
        assert_event_field(truncation, "reason", "deadline");
        assert_event_field(truncation, "attempted_batches", "2");
        assert_event_field(truncation, "successful_batches", "1");
        assert_event_field(truncation, "attempted_entries", "2");
        assert_event_field(truncation, "uploaded_entries", "1");
        assert_event_field(truncation, "unconfirmed_entries", "1");
        assert_event_field(truncation, "remaining_source_bytes", "0");
        let uploaded = captured_event(&events, "uploaded network logs");
        assert_event_field(uploaded, "batches", "1");
        assert_event_field(uploaded, "count", "1");
        assert!(!has_captured_event(&events, "network logs upload failed"));
    }

    #[tokio::test]
    async fn upload_network_logs_returns_on_transport_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = network_log_file(&dir);
        tokio::fs::write(&path, r#"{"host":"transport-error.example"}"#)
            .await
            .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let attempts = Arc::new(AtomicUsize::new(0));
        let accept_attempts = attempts.clone();
        let stop_accepting = Arc::new(tokio::sync::Notify::new());
        let stop_signal = stop_accepting.clone();
        let accept_once = tokio::spawn(async move {
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        if accepted.is_ok() {
                            accept_attempts.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    () = stop_signal.notified() => break,
                }
            }
        });

        let http = HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap();
        upload_network_logs(&http, RunId::nil(), SANDBOX_TOKEN, &path).await;

        stop_accepting.notify_one();
        accept_once.await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(path.exists());
    }
}
