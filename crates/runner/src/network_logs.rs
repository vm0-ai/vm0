use std::path::Path;

use reqeast::Method;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use uuid::Uuid;

use crate::http::HttpClient;

#[derive(Serialize, Deserialize, Clone)]
struct NetworkLog {
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rule_matched: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_size: Option<u64>,
}

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
    run_id: Uuid,
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
            if let Err(e) = tokio::fs::remove_file(path).await {
                warn!(run_id = %run_id, error = %e, "failed to delete network log file");
            }
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
    fn network_log_deserializes_sni() {
        let json = r#"{"timestamp":"2026-02-15T10:00:00","mode":"sni","action":"ALLOW","host":"example.com","port":443,"rule_matched":"domain:*.example.com"}"#;
        let log: NetworkLog = serde_json::from_str(json).unwrap();
        assert_eq!(log.timestamp, "2026-02-15T10:00:00");
        assert_eq!(log.mode.as_deref(), Some("sni"));
        assert_eq!(log.host.as_deref(), Some("example.com"));
        assert!(log.method.is_none());
    }

    #[test]
    fn network_log_deserializes_mitm() {
        let json = r#"{"timestamp":"2026-02-15T10:00:00","mode":"mitm","action":"ALLOW","host":"api.example.com","port":443,"rule_matched":"domain:*.example.com","method":"GET","url":"https://api.example.com/data","status":200,"latency_ms":150,"request_size":0,"response_size":1024}"#;
        let log: NetworkLog = serde_json::from_str(json).unwrap();
        assert_eq!(log.method.as_deref(), Some("GET"));
        assert_eq!(log.status, Some(200));
        assert_eq!(log.latency_ms, Some(150));
    }

    #[test]
    fn network_log_round_trip() {
        let json = r#"{"timestamp":"2026-02-15T10:00:00","mode":"sni","action":"DENY","host":"evil.com","port":443,"rule_matched":"final"}"#;
        let log: NetworkLog = serde_json::from_str(json).unwrap();
        let reserialized = serde_json::to_value(&log).unwrap();
        assert_eq!(reserialized["timestamp"], "2026-02-15T10:00:00");
        assert_eq!(reserialized["action"], "DENY");
        assert!(reserialized.get("method").is_none());
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
