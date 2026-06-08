use crate::support::*;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::time::Duration;

const TELEMETRY_DELTA_READ_LIMIT: usize = 256 * 1024;
const OVERSIZED_SYSTEM_LOG_LINE_MARKER_FRAGMENT: &str =
    "vm0 telemetry omitted oversized system log line";

fn remove_telemetry_files() {
    let _ = std::fs::remove_file(guest_agent::paths::system_log_file());
    let _ = std::fs::remove_file(guest_agent::paths::metrics_log_file());
    let _ = std::fs::remove_file(guest_agent::paths::sandbox_ops_file());
    let _ = std::fs::remove_file(guest_agent::paths::telemetry_system_log_pos_file());
    let _ = std::fs::remove_file(guest_agent::paths::telemetry_metrics_pos_file());
    let _ = std::fs::remove_file(guest_agent::paths::telemetry_sandbox_ops_pos_file());
}

fn ensure_parent_dir(path: &str) {
    let Some(parent) = std::path::Path::new(path).parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
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
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // Reset per-run telemetry state so this test drives sandbox_ops
    // deterministically (other tests in this file don't record sandbox_ops,
    // but be defensive against cross-test leakage).
    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let pos_file = guest_agent::paths::telemetry_sandbox_ops_pos_file();
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);

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
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

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
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);
}

#[tokio::test]
async fn final_flush_uploads_log_emitted_immediately_before_it() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let system_log = guest_agent::paths::system_log_file();
    let pos_file = guest_agent::paths::telemetry_system_log_pos_file();
    let _ = std::fs::remove_file(system_log);
    let _ = std::fs::remove_file(pos_file);

    let marker = "fatal-tail-before-final-telemetry";
    let upload_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(marker);
        then.status(200);
    });

    let system_log_guard = SystemLogOverrideGuard::set(system_log);
    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

    guest_common::log_warn!("sandbox:guest-agent", "{marker}");
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("final flush should upload just-emitted log");

    telemetry.shutdown().await;
    drop(system_log_guard);

    upload_mock.assert_calls_async(1).await;
    upload_mock.delete_async().await;
    let _ = std::fs::remove_file(system_log);
    let _ = std::fs::remove_file(pos_file);
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
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let pos_file = guest_agent::paths::telemetry_sandbox_ops_pos_file();
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

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
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);
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
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let pos_file = guest_agent::paths::telemetry_sandbox_ops_pos_file();
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

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
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);
}

#[tokio::test]
async fn skip_only_metrics_progress_saves_position_without_posting_empty_payload() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    remove_telemetry_files();

    let metrics_file = guest_agent::paths::metrics_log_file();
    let metrics_pos_file = guest_agent::paths::telemetry_metrics_pos_file();
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
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

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
    remove_telemetry_files();
}

#[tokio::test]
async fn oversized_system_log_uploads_marker_without_raw_line_fragment() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    remove_telemetry_files();

    let system_log = guest_agent::paths::system_log_file();
    let system_log_pos_file = guest_agent::paths::telemetry_system_log_pos_file();
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
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

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
    remove_telemetry_files();
}
