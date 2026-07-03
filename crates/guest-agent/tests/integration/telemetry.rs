use crate::support::*;
use base64::Engine;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::time::Duration;

const TELEMETRY_DELTA_READ_LIMIT: usize = 256 * 1024;
const OVERSIZED_SYSTEM_LOG_LINE_MARKER_FRAGMENT: &str =
    "vm0 telemetry omitted oversized system log line";

struct SandboxOpsOverrideGuard;

impl SandboxOpsOverrideGuard {
    fn set(path: &str) -> Self {
        guest_common::telemetry::set_sandbox_ops_log_file(path);
        Self
    }
}

impl Drop for SandboxOpsOverrideGuard {
    fn drop(&mut self) {
        guest_common::telemetry::clear_sandbox_ops_log_file();
    }
}

struct ExplicitTelemetryFiles {
    _tmp: tempfile::TempDir,
    paths: guest_agent::paths::GuestPaths,
    _sandbox_ops_override: SandboxOpsOverrideGuard,
}

impl ExplicitTelemetryFiles {
    fn new(name: &str) -> std::io::Result<Self> {
        let tmp = tempfile::tempdir()?;
        let paths = guest_agent::paths::GuestPaths::from_runtime_dir(tmp.path().join(name));
        let sandbox_ops_override = SandboxOpsOverrideGuard::set(paths.sandbox_ops_file());
        remove_telemetry_files(&paths);
        Ok(Self {
            _tmp: tmp,
            paths,
            _sandbox_ops_override: sandbox_ops_override,
        })
    }
}

fn remove_telemetry_files(paths: &guest_agent::paths::GuestPaths) {
    let _ = std::fs::remove_file(paths.system_log_file());
    let _ = std::fs::remove_file(paths.metrics_log_file());
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
    let _ = std::fs::remove_file(paths.telemetry_system_log_pos_file());
    let _ = std::fs::remove_file(paths.telemetry_metrics_pos_file());
    let _ = std::fs::remove_file(paths.telemetry_sandbox_ops_pos_file());
}

fn ensure_parent_dir(path: &str) {
    let Some(parent) = std::path::Path::new(path).parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
}

#[tokio::test]
async fn spawn_for_paths_uploads_explicit_runtime_files() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("spawn-for-paths").unwrap();
    let paths = &files.paths;

    let upload_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(r#""runId":"explicit-run""#)
            .body_includes("explicit system log");
        then.status(200);
    });

    guest_agent::paths::write_private(paths.system_log_file(), "explicit system log\n")
        .expect("explicit system log should be written");

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "explicit-run".to_string(),
        paths,
        masker,
        http_client!(),
    );
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("explicit telemetry flush should succeed");
    telemetry.shutdown().await;

    upload_mock.assert_calls_async(1).await;
    upload_mock.delete_async().await;
}

// =========================================================================
// Telemetry flush delta semantics
//
// Backs the parallel-checkpoint-with-catch-up pattern in `main.rs`: the
// first `flush(UploadMode::Live)` runs concurrently with
// `checkpoint::create_checkpoint` and reads the `sandbox_ops` log before
// checkpoint's sub-op records are written; a second
// `flush(UploadMode::Final)` after the join picks up the delta. If the
// uploader ever stopped being incremental — re-reading from offset 0 —
// that pattern would duplicate records; if position-tracking broke in
// the other direction, checkpoint sub-ops would be lost entirely.
// =========================================================================

#[tokio::test]
async fn flush_is_incremental_between_calls() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("flush-incremental").unwrap();
    let paths = &files.paths;

    // Two mocks, registered in this order. httpmock matches by ID ascending
    // and returns the first hit, so `first_op_mock` wins when the payload
    // contains that substring; `catchup_mock` catches subsequent POSTs.
    let first_op_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("first_op");
        then.status(200);
    });
    let catchup_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    // Pre-checkpoint record → first flush captures it.
    guest_common::telemetry::record_sandbox_op("first_op", Duration::from_millis(10), true, None);
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("first flush should succeed");

    // Simulates a checkpoint sub-op written AFTER the parallel pass read
    // the sandbox_ops file. The catch-up flush must pick it up.
    guest_common::telemetry::record_sandbox_op("second_op", Duration::from_millis(20), true, None);
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("catch-up flush should succeed");

    telemetry.shutdown().await;

    // The first upload carried `first_op` and matched `first_op_mock`.
    // The catch-up MUST NOT have carried `first_op` (position tracking
    // advanced past it) — otherwise `first_op_mock` would have matched
    // twice and `catchup_mock` zero times.
    first_op_mock.assert_calls_async(1).await;
    catchup_mock.assert_calls_async(1).await;

    first_op_mock.delete_async().await;
    catchup_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn final_flush_and_shutdown_uploads_log_emitted_immediately_before_it() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("final-flush-tail").unwrap();
    let paths = &files.paths;
    let system_log = paths.system_log_file();

    let marker = "fatal-tail-before-final-telemetry";
    let upload_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(marker);
        then.status(200);
    });

    let system_log_guard = SystemLogOverrideGuard::set(system_log);
    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    guest_common::log_warn!("sandbox:guest-agent", "{marker}");
    telemetry
        .final_flush_and_shutdown()
        .await
        .expect("final flush and shutdown should upload just-emitted log");
    drop(system_log_guard);

    upload_mock.assert_calls_async(1).await;
    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn telemetry_preserves_runtime_session_id_and_masks_secrets() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("runtime-session-mask").unwrap();
    let paths = &files.paths;
    let _session_files = SessionCheckpointFilesGuard::new();

    let system_log = paths.system_log_file();
    ensure_parent_dir(system_log);

    let session_id = "telemetry-session-id";
    let secret = "actual-telemetry-secret-123";
    let event_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(format!(r#""session_id":"{session_id}""#));
        then.status(200);
    });
    let raw_telemetry_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(secret);
        then.status(500);
    });
    let masked_telemetry_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(format!("system log {session_id} ***"));
        then.status(200);
    });

    let secret_values = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = std::sync::Arc::new(SecretMasker::from_raw(&secret_values));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        std::sync::Arc::clone(&masker),
        http_client!(),
    );
    let event = serde_json::json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id
    });
    let config = shared_guest_config().expect("shared integration guest config should be valid");
    guest_agent::events::send_event_for_config(&http_client!(), event, 1, &masker, &config, paths)
        .await
        .expect("session event should be sent");

    std::fs::write(system_log, format!("system log {session_id} {secret}\n"))
        .expect("system log should be written");
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("final flush should upload masked log");
    telemetry.shutdown().await;

    event_mock.assert_calls_async(1).await;
    raw_telemetry_mock.assert_calls_async(0).await;
    masked_telemetry_mock.assert_calls_async(1).await;

    event_mock.delete_async().await;
    raw_telemetry_mock.delete_async().await;
    masked_telemetry_mock.delete_async().await;
    remove_telemetry_files(paths);
}

/// Regression for #11008. Combines two distinct guarantees that
/// together produce the "exactly one HTTP POST" assertion:
///
/// 1. **Channel serialization**: every flush goes through the same
///    `tokio::select!` arm in `run()`, so `upload_telemetry` calls are
///    strictly sequential — `save_position` is single-writer.
/// 2. **Empty-delta short-circuit**: the second and third flushes
///    observe `pos == file_len` after the first flush advanced the
///    position, hit the `system_log.is_empty() && metrics.is_empty()
///    && sandbox_ops.is_empty()` early-return in `upload_telemetry`,
///    and skip HTTP entirely.
///
/// Without (1), two flushes could read the same pos and post twice.
/// Without (2), three flushes would all serialize but each would post
/// (the second and third with empty bodies). Asserting `calls == 1`
/// pins both: pos never regresses (1) and empty deltas don't generate
/// HTTP traffic (2).
#[tokio::test]
async fn concurrent_flushes_do_not_regress_pos_file() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("concurrent-flushes").unwrap();
    let paths = &files.paths;
    let ops_file = paths.sandbox_ops_file();
    let pos_file = paths.telemetry_sandbox_ops_pos_file();

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    // Record one op, then fire several concurrent flushes. Pre-refactor a
    // tick + final could both read the same pos and race on save_position;
    // post-refactor the select serialises them, so only the first sees a
    // non-empty delta and only one HTTP POST happens.
    guest_common::telemetry::record_sandbox_op("only_op", Duration::from_millis(5), true, None);

    let (r1, r2, r3) = tokio::join!(
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
    );
    r1.expect("flush 1 ok");
    r2.expect("flush 2 ok");
    r3.expect("flush 3 ok");

    telemetry.shutdown().await;

    // Pos file points at end of the file — no regression.
    let pos: u64 = std::fs::read_to_string(pos_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let file_len = std::fs::metadata(ops_file).unwrap().len();
    assert_eq!(pos, file_len, "pos must match file length, no regression");

    // Exactly one upload carried the delta — the others saw empty files.
    upload_mock.assert_calls_async(1).await;

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

/// Pins three invariants that have no other test coverage:
/// 1. `flush` propagates the upload's `Err` to the caller (rather than
///    swallowing it via `let _ = reply.send(...)`).
/// 2. The uploader loop **keeps running** after a failed upload — a
///    subsequent `flush` must succeed, not return `TelemetryUnavailable`.
/// 3. A failed upload does **not** advance the pos file, so the deferred
///    delta is re-included in the next attempt (and uploaded once
///    HTTP recovers).
#[tokio::test]
async fn flush_propagates_error_then_loop_recovers() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("flush-error-recovery").unwrap();
    let paths = &files.paths;

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    // Force upload_telemetry to fire HTTP by writing a delta.
    guest_common::telemetry::record_sandbox_op(
        "first_attempt_op",
        Duration::from_millis(5),
        true,
        None,
    );

    // First attempt: server returns 500.
    let fail_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(500);
    });

    let r1 = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert!(r1.is_err(), "flush must propagate the HTTP 500 to caller");
    fail_mock.assert_calls_async(1).await;
    fail_mock.delete_async().await;

    // Second attempt: server returns 200, AND must still see
    // `first_attempt_op` in the body because the failed first upload
    // did not advance the pos file.
    let success_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("first_attempt_op");
        then.status(200);
    });

    let r2 = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert!(
        r2.is_ok(),
        "loop must keep accepting flushes after a failed upload, got {r2:?}",
    );
    success_mock.assert_calls_async(1).await;

    telemetry.shutdown().await;

    success_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn skip_only_metrics_progress_saves_position_without_posting_empty_payload() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("skip-only-metrics").unwrap();
    let paths = &files.paths;

    let metrics_file = paths.metrics_log_file();
    let metrics_pos_file = paths.telemetry_metrics_pos_file();
    ensure_parent_dir(metrics_file);
    assert!(
        std::fs::write(metrics_file, "x".repeat(TELEMETRY_DELTA_READ_LIMIT + 1)).is_ok(),
        "oversized metrics log should be written",
    );

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("skip-only flush should succeed without HTTP");
    telemetry.shutdown().await;

    upload_mock.assert_calls_async(0).await;
    let pos_text = std::fs::read_to_string(metrics_pos_file)
        .expect("metrics telemetry position should be written");
    let pos: u64 = pos_text
        .trim()
        .parse()
        .expect("metrics telemetry position should be numeric");
    assert_eq!(pos, TELEMETRY_DELTA_READ_LIMIT as u64);

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn oversized_system_log_uploads_marker_without_raw_line_fragment() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("oversized-system-log").unwrap();
    let paths = &files.paths;

    let system_log = paths.system_log_file();
    let system_log_pos_file = paths.telemetry_system_log_pos_file();
    let raw_token = "raw-secret-token";
    ensure_parent_dir(system_log);
    assert!(
        std::fs::write(
            system_log,
            raw_token.repeat((TELEMETRY_DELTA_READ_LIMIT / raw_token.len()) + 1),
        )
        .is_ok(),
        "oversized system log should be written",
    );

    let raw_fragment_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(raw_token);
        then.status(500);
    });
    let marker_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(OVERSIZED_SYSTEM_LOG_LINE_MARKER_FRAGMENT);
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("oversized system log marker upload should succeed");
    telemetry.shutdown().await;

    raw_fragment_mock.assert_calls_async(0).await;
    marker_mock.assert_calls_async(1).await;
    let pos_text = std::fs::read_to_string(system_log_pos_file)
        .expect("system log telemetry position should be written");
    let pos: u64 = pos_text
        .trim()
        .parse()
        .expect("system log telemetry position should be numeric");
    assert_eq!(pos, TELEMETRY_DELTA_READ_LIMIT as u64);

    raw_fragment_mock.delete_async().await;
    marker_mock.delete_async().await;
    remove_telemetry_files(paths);
}
