use std::path::Path;

use reqeast::Method;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::http::HttpClient;
use crate::ids::RunId;

/// Network log entry from mitmproxy JSONL.
///
/// [NETWORK_LOG_FIELDS] — fields are defined in mitm_addon.py (source of truth).
/// Uses a transparent `serde_json::Value` wrapper so all fields pass through
/// to Axiom without needing a struct field for each one. This avoids silently
/// dropping new fields added to the Python addon.
#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
struct NetworkLog(serde_json::Value);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkLogPayload {
    run_id: String,
    network_logs: Vec<NetworkLog>,
}

/// Upload network logs from the mitmproxy JSONL file.
/// Reads the file at `path`, POSTs to telemetry endpoint,
/// and deletes the file on success. Best-effort — failures only warn.
pub async fn upload_network_logs(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    path: &Path,
) {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to read network logs");
            return;
        }
    };

    let logs: Vec<NetworkLog> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| match serde_json::from_str(line) {
            Ok(log) => Some(log),
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "malformed network log line");
                None
            }
        })
        .collect();

    if logs.is_empty() {
        return;
    }

    info!(run_id = %run_id, count = logs.len(), "uploading network logs");

    let payload = NetworkLogPayload {
        run_id: run_id.to_string(),
        network_logs: logs,
    };

    let result = http
        .request(Method::POST, "/api/webhooks/agent/telemetry", sandbox_token)
        .json(&payload)
        .send()
        .await;

    match result {
        Ok(resp) if resp.status().is_success() => {
            // File is kept locally for debugging; gc_job_logs deletes after 7 days.
        }
        Ok(resp) => {
            warn!(run_id = %run_id, status = %resp.status(), "network logs upload rejected");
        }
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "network logs upload failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_log_preserves_all_fields() {
        let json = r#"{"timestamp":"2026-02-15T10:00:00","action":"ALLOW","host":"api.github.com","port":443,"method":"GET","url":"https://api.github.com/repos/vm0-ai/vm0","status":200,"latency_ms":150,"request_size":0,"response_size":1024,"firewall_base":"https://api.github.com","firewall_name":"github","firewall_ref":"github","firewall_permission":"metadata:read","firewall_rule_match":"GET /repos/{owner}/{repo}"}"#;
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
}
