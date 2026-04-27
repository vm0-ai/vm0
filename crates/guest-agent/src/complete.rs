//! Guest-side `/webhooks/agent/complete` caller.
//!
//! The runner also posts `/complete` after it observes the VM exit, but by
//! then the run has incurred `final_telemetry`, VM teardown, stop/destroy,
//! and host observation delays. Firing the webhook from the guest the
//! instant `POST /checkpoints` returns closes that gap: the host transitions
//! the run to `completed` as soon as the checkpoint row is visible, and the
//! runner's subsequent call is absorbed by the route's idempotency check.
//!
//! Fire-and-forget semantics: a failure is logged and swallowed because the
//! runner's fallback is the correctness guarantee. One attempt (matching
//! telemetry) so a flaky network does not tie up VM shutdown.
//!
//! Trust model: `sandbox_id` and `sandbox_reuse_result` are relayed from
//! runner-set env vars and included in the payload for analytics only. The
//! guest is semi-trusted under the normal threat model, and the runner's
//! fallback call is idempotency-short-circuited, so a compromised guest
//! could skew these values with no way for the runner to correct them. Do
//! not treat either field as authoritative for security decisions.

use crate::env;
use crate::urls;
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
}

fn as_optional(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

/// Report a successful run to the host. Only called after
/// `checkpoint::create_checkpoint()` returns Ok, which guarantees the
/// `checkpoints` row exists so the complete route can build `RunResult`.
///
/// `sandbox_id` and `sandbox_reuse_result` are relayed analytics values;
/// empty strings are serialized as absent so an unset env var is equivalent
/// to omitting the field.
///
/// `last_event_sequence` is the highest contiguous agent event sequence whose
/// events webhook POST succeeded. The host uses it as a best-effort Axiom
/// visibility watermark before marking the run completed.
///
/// Fire-and-forget. Returns `()` and never propagates errors — the runner's
/// fallback call covers any failure here.
pub async fn report_success(
    sandbox_id: &str,
    sandbox_reuse_result: &str,
    last_event_sequence: Option<u32>,
) {
    if !env::has_api() {
        return;
    }

    let payload = CompletePayload {
        run_id: env::run_id(),
        exit_code: 0,
        last_event_sequence,
        sandbox_id: as_optional(sandbox_id),
        sandbox_reuse_result: as_optional(sandbox_reuse_result),
    };

    // 1 attempt — the runner's fallback is the safety net. Retrying from the
    // guest just delays VM exit without improving the outcome.
    match crate::http::post_json(urls::complete_url(), &payload, 1).await {
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
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""sandboxId":"abc""#));
        assert!(json.contains(r#""sandboxReuseResult":"reused""#));
    }

    /// Both metadata fields must be skipped independently — a regression that
    /// ties them together (e.g. switching to a single `Option<Metadata>` without
    /// care) would silently drop whichever field happened to be empty on one
    /// side.
    #[test]
    fn payload_skips_sandbox_id_when_only_reuse_result_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            last_event_sequence: None,
            sandbox_id: None,
            sandbox_reuse_result: Some("poolMiss"),
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
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""sandboxId":"sid""#));
        assert!(!json.contains("sandboxReuseResult"));
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
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(
            json,
            r#"{"runId":"run-123","exitCode":0,"lastEventSequence":7}"#
        );
    }
}
