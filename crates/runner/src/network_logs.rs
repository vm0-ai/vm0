use std::path::Path;

use api_contracts::generated::routes;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
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

const NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES: usize = 500;
const NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES: usize = 1024 * 1024;
const NETWORK_LOG_UPLOAD_PAYLOAD_OVERHEAD_BYTES: usize = 64;
const NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES: usize = 1;

/// Upload network logs from the per-run JSONL file.
/// Reads the file at `path`, POSTs bounded batches to telemetry endpoint,
/// and keeps the local file for debugging/log GC. Best-effort — failures only warn.
pub async fn upload_network_logs(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    path: &Path,
) {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to read network logs");
            return;
        }
    };

    let mut lines = BufReader::new(file).lines();
    let mut batch = Vec::with_capacity(NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES);
    let mut batch_bytes = empty_batch_estimated_bytes(&run_id);
    let mut batch_index = 0usize;
    let mut total_uploaded = 0usize;

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "failed to read network logs");
                return;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let log = match serde_json::from_str(line) {
            Ok(log) => log,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "malformed network log line");
                continue;
            }
        };
        let entry_bytes = estimated_entry_bytes(line);

        if !batch.is_empty()
            && (batch.len() >= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES
                || batch_bytes.saturating_add(entry_bytes) > NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES)
            && !flush_network_log_batch(
                http,
                run_id,
                sandbox_token,
                &mut batch,
                &mut batch_bytes,
                &mut batch_index,
                &mut total_uploaded,
            )
            .await
        {
            return;
        }

        batch.push(log);
        batch_bytes = batch_bytes.saturating_add(entry_bytes);

        if (batch.len() >= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES
            || batch_bytes >= NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES)
            && !flush_network_log_batch(
                http,
                run_id,
                sandbox_token,
                &mut batch,
                &mut batch_bytes,
                &mut batch_index,
                &mut total_uploaded,
            )
            .await
        {
            return;
        }
    }

    if !flush_network_log_batch(
        http,
        run_id,
        sandbox_token,
        &mut batch,
        &mut batch_bytes,
        &mut batch_index,
        &mut total_uploaded,
    )
    .await
    {
        return;
    }

    if total_uploaded > 0 {
        info!(
            run_id = %run_id,
            batches = batch_index,
            count = total_uploaded,
            "uploaded network logs"
        );
    }
}

async fn flush_network_log_batch(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    batch: &mut Vec<NetworkLog>,
    batch_bytes: &mut usize,
    batch_index: &mut usize,
    total_uploaded: &mut usize,
) -> bool {
    if batch.is_empty() {
        return true;
    }

    *batch_index += 1;
    let batch_index = *batch_index;
    let logs = std::mem::replace(
        batch,
        Vec::with_capacity(NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES),
    );
    *batch_bytes = empty_batch_estimated_bytes(&run_id);
    let count = logs.len();

    info!(run_id = %run_id, batch_index, count, "uploading network log batch");

    let payload = NetworkLogPayload {
        run_id: run_id.to_string(),
        network_logs: logs,
    };

    let result = http
        .request_route(routes::webhooks::agent::telemetry::SEND, sandbox_token)
        .json(&payload)
        .send()
        .await;

    match result {
        Ok(resp) if resp.status().is_success() => {
            // File is kept locally for debugging; gc_job_logs deletes after 7 days.
            *total_uploaded += count;
            true
        }
        Ok(resp) => {
            warn!(
                run_id = %run_id,
                batch_index,
                status = %resp.status(),
                "network logs upload rejected"
            );
            false
        }
        Err(e) => {
            warn!(
                run_id = %run_id,
                batch_index,
                error = %e,
                "network logs upload failed"
            );
            false
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use httpmock::prelude::*;
    use serde_json::json;

    use super::*;

    const SANDBOX_TOKEN: &str = "sandbox-token";

    fn http_for_server(server: &MockServer) -> HttpClient {
        HttpClient::new(server.base_url()).unwrap()
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
        let logs: Vec<_> = (0..(NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES * 2 + 1))
            .map(|idx| {
                json!({
                    "timestamp": "2026-02-15T10:00:00Z",
                    "host": format!("host-{idx}.example"),
                    "sequence": idx,
                })
            })
            .collect();
        tokio::fs::write(&path, network_log_content(&logs))
            .await
            .unwrap();

        let server = MockServer::start_async().await;
        let first_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[..NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES].to_vec(),
        });
        let second_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES..NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES * 2].to_vec(),
        });
        let third_expected = json!({
            "runId": run_id.to_string(),
            "networkLogs": logs[NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES * 2..].to_vec(),
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
                then.status(500);
            })
            .await;

        let http = http_for_server(&server);
        upload_network_logs(&http, RunId::nil(), SANDBOX_TOKEN, &path).await;

        upload.assert_calls_async(1).await;
        assert!(path.exists());
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

        let http = HttpClient::new(api_url).unwrap();
        upload_network_logs(&http, RunId::nil(), SANDBOX_TOKEN, &path).await;

        stop_accepting.notify_one();
        accept_once.await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(path.exists());
    }
}
