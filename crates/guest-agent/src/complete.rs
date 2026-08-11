//! Guest-side `/webhooks/agent/complete` caller.
//!
//! The runner also posts `/complete` after it observes the VM exit, but by
//! then the run has incurred `final_telemetry`, VM teardown, stop/destroy,
//! and host observation delays. The guest calls it after a successful
//! checkpoint, or after a cancelled run's recovery attempt has returned. The
//! runner's subsequent call is absorbed by the route's idempotency check.
//!
//! Fire-and-forget semantics: a failure is logged and swallowed because the
//! runner's fallback is the correctness guarantee. One attempt (matching
//! telemetry) so a flaky network does not tie up VM shutdown.
//!
//! Trust model: sandbox and workspace metadata are relayed from
//! runner-set env vars and included in the payload for analytics only. The
//! guest is semi-trusted under the normal threat model, and the runner's
//! fallback call is idempotency-short-circuited, so a compromised guest
//! could skew these values with no way for the runner to correct them. Do
//! not treat these fields as authoritative for security decisions.

use crate::http::HttpClient;
use guest_common::{log_info, log_warn};
use serde::Serialize;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletePayload<'a> {
    run_id: &'a str,
    exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_sequence: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_reuse_result: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_reuse_result: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_input_delivery_ids: Option<&'a [String]>,
}

fn as_optional(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

fn as_optional_slice(values: &[String]) -> Option<&[String]> {
    (!values.is_empty()).then_some(values)
}

/// Report a successful run to the host. Normal CLI runs call this only after
/// `checkpoint::create_checkpoint_for_runtime()` succeeds. Pi runs do not
/// create CLI session checkpoints; their acknowledged terminal transcript
/// message is the host-side completion proof instead.
///
/// Sandbox and workspace reuse fields are relayed analytics values;
/// empty strings are serialized as absent so an unset env var is equivalent
/// to omitting the field.
///
/// `last_event_sequence` is the highest contiguous agent event sequence whose
/// events webhook POST succeeded. The host persists it on the run, and clients
/// use it as a terminal event-drain watermark after observing terminal status.
///
/// Fire-and-forget. Returns `()` and never propagates errors — the runner's
/// fallback call covers any failure here.
pub async fn report_success_for_run(
    http: &HttpClient,
    run_id: &str,
    sandbox_id: &str,
    sandbox_reuse_result: &str,
    workspace_reuse_result: &str,
    last_event_sequence: Option<u32>,
    active_input_delivery_ids: &[String],
) {
    report_payload(
        http,
        payload_for_run(
            run_id,
            0,
            sandbox_id,
            sandbox_reuse_result,
            workspace_reuse_result,
            last_event_sequence,
            active_input_delivery_ids,
        ),
    )
    .await;
}

/// Report an explicit user cancellation after its recovery-checkpoint attempt.
///
/// Fire-and-forget. A failed request is logged and swallowed so runner
/// completion remains the fallback.
pub async fn report_user_cancellation_for_run(
    http: &HttpClient,
    run_id: &str,
    sandbox_id: &str,
    sandbox_reuse_result: &str,
    workspace_reuse_result: &str,
    last_event_sequence: Option<u32>,
    active_input_delivery_ids: &[String],
) {
    report_payload(
        http,
        payload_for_run(
            run_id,
            1,
            sandbox_id,
            sandbox_reuse_result,
            workspace_reuse_result,
            last_event_sequence,
            active_input_delivery_ids,
        ),
    )
    .await;
}

fn payload_for_run<'a>(
    run_id: &'a str,
    exit_code: i32,
    sandbox_id: &'a str,
    sandbox_reuse_result: &'a str,
    workspace_reuse_result: &'a str,
    last_event_sequence: Option<u32>,
    active_input_delivery_ids: &'a [String],
) -> CompletePayload<'a> {
    CompletePayload {
        run_id,
        exit_code,
        last_event_sequence,
        sandbox_id: as_optional(sandbox_id),
        sandbox_reuse_result: as_optional(sandbox_reuse_result),
        workspace_reuse_result: as_optional(workspace_reuse_result),
        active_input_delivery_ids: as_optional_slice(active_input_delivery_ids),
    }
}

async fn report_payload(http: &HttpClient, payload: CompletePayload<'_>) {
    if !http.has_api() {
        return;
    }

    // 1 attempt — the runner's fallback is the safety net. Retrying from the
    // guest just delays VM exit without improving the outcome.
    let url = match http.complete_url() {
        Ok(url) => url,
        Err(e) => {
            log_warn!(LOG_TAG, "Complete webhook skipped: {e}");
            return;
        }
    };
    match http.post_json(url, &payload, 1).await {
        Ok(_) => log_info!(LOG_TAG, "Complete webhook acknowledged"),
        Err(e) => log_warn!(LOG_TAG, "Complete webhook failed (runner will retry): {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_omits_missing_metadata() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            last_event_sequence: None,
            sandbox_id: None,
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(json, r#"{"runId":"run-123","exitCode":0}"#);
    }

    #[test]
    fn payload_includes_metadata_when_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            last_event_sequence: None,
            sandbox_id: Some("abc"),
            sandbox_reuse_result: Some("reused"),
            workspace_reuse_result: Some("sandboxReused"),
            active_input_delivery_ids: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""sandboxId":"abc""#));
        assert!(json.contains(r#""sandboxReuseResult":"reused""#));
        assert!(json.contains(r#""workspaceReuseResult":"sandboxReused""#));
    }

    /// Completion metadata fields must be skipped independently so one absent
    /// runner value does not silently drop another useful value.
    #[test]
    fn payload_skips_sandbox_id_when_only_reuse_result_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            last_event_sequence: None,
            sandbox_id: None,
            sandbox_reuse_result: Some("poolMiss"),
            workspace_reuse_result: None,
            active_input_delivery_ids: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("sandboxId"));
        assert!(json.contains(r#""sandboxReuseResult":"poolMiss""#));
    }

    #[test]
    fn payload_skips_reuse_result_when_only_sandbox_id_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            last_event_sequence: None,
            sandbox_id: Some("sid"),
            sandbox_reuse_result: None,
            workspace_reuse_result: Some("cacheMiss"),
            active_input_delivery_ids: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""sandboxId":"sid""#));
        assert!(!json.contains("sandboxReuseResult"));
        assert!(json.contains(r#""workspaceReuseResult":"cacheMiss""#));
    }

    #[test]
    fn as_optional_treats_empty_as_none() {
        assert_eq!(as_optional(""), None);
        assert_eq!(as_optional("value"), Some("value"));
    }

    #[test]
    fn payload_includes_last_event_sequence_when_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            last_event_sequence: Some(7),
            sandbox_id: None,
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(
            json,
            r#"{"runId":"run-123","exitCode":0,"lastEventSequence":7}"#
        );
    }
}
