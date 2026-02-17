use std::time::{Duration, Instant};

use chrono::Utc;
use serde::Serialize;
use tracing::warn;
use uuid::Uuid;

use crate::http::HttpClient;

/// How long before we auto-flush pending ops (matching TS: 30s).
const FLUSH_THRESHOLD: Duration = Duration::from_secs(30);

/// Timeout for telemetry HTTP requests (shorter than default API timeout).
const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(5);

/// Per-job telemetry collector. Buffers sandbox operations and flushes them
/// periodically (auto on 30 s threshold) and at job end.
///
/// Owns its state — passed as `&mut` through the call chain, no `Mutex` needed.
pub struct JobTelemetry {
    http: HttpClient,
    run_id: Uuid,
    sandbox_token: String,
    pending_ops: Vec<SandboxOp>,
    oldest_pending: Option<Instant>,
}

#[derive(Serialize, Clone)]
struct SandboxOp {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryPayload {
    run_id: String,
    sandbox_operations: Vec<SandboxOp>,
}

impl JobTelemetry {
    /// Create a new per-job telemetry collector.
    pub fn new(http: HttpClient, run_id: Uuid, sandbox_token: String) -> Self {
        Self {
            http,
            run_id,
            sandbox_token,
            pending_ops: Vec::new(),
            oldest_pending: None,
        }
    }

    /// Record a timed operation. Auto-flushes (fire-and-forget) if the oldest
    /// pending op exceeds the 30 s threshold.
    pub fn record(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
    ) {
        self.pending_ops.push(SandboxOp {
            ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            action_type: action_type.to_string(),
            duration_ms: duration.as_millis() as u64,
            success,
            error: error.map(String::from),
        });
        if self.oldest_pending.is_none() {
            self.oldest_pending = Some(Instant::now());
        }

        if let Some(oldest) = self.oldest_pending
            && oldest.elapsed() >= FLUSH_THRESHOLD
        {
            self.fire_and_forget_flush();
        }
    }

    /// Final flush — awaits the HTTP request. Consumes self so callers can't
    /// accidentally record after flushing.
    pub async fn flush(mut self) {
        if self.pending_ops.is_empty() {
            return;
        }
        let ops = std::mem::take(&mut self.pending_ops);
        send_telemetry(&self.http, self.run_id, &self.sandbox_token, ops).await;
    }

    /// Spawn a fire-and-forget flush for auto-threshold flushes.
    fn fire_and_forget_flush(&mut self) {
        let ops = std::mem::take(&mut self.pending_ops);
        self.oldest_pending = None;

        let http = self.http.clone();
        let run_id = self.run_id;
        let sandbox_token = self.sandbox_token.clone();

        tokio::spawn(async move {
            send_telemetry(&http, run_id, &sandbox_token, ops).await;
        });
    }
}

async fn send_telemetry(http: &HttpClient, run_id: Uuid, sandbox_token: &str, ops: Vec<SandboxOp>) {
    if ops.is_empty() {
        return;
    }

    let payload = TelemetryPayload {
        run_id: run_id.to_string(),
        sandbox_operations: ops,
    };

    let req = http
        .request(
            reqeast::Method::POST,
            "/api/webhooks/agent/telemetry",
            sandbox_token,
        )
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

    #[test]
    fn sandbox_op_serializes_correctly() {
        let op = SandboxOp {
            ts: "2026-01-15T10:00:00+00:00".to_string(),
            action_type: "vm_create".to_string(),
            duration_ms: 1500,
            success: true,
            error: None,
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
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("runId").is_some());
        assert!(json.get("sandboxOperations").is_some());
    }

    #[test]
    fn new_creates_empty_telemetry() {
        let http = HttpClient::new("http://localhost".to_string()).unwrap();
        let telemetry = JobTelemetry::new(http, Uuid::nil(), "tok".to_string());
        assert!(telemetry.pending_ops.is_empty());
        assert!(telemetry.oldest_pending.is_none());
    }

    #[test]
    fn record_buffers_ops() {
        let http = HttpClient::new("http://localhost".to_string()).unwrap();
        let mut telemetry = JobTelemetry::new(http, Uuid::nil(), "tok".to_string());

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
}
