use super::super::support::sandbox_write_file_error;
use super::*;
use guest_contracts::codex_thread_path::{
    CODEX_THREAD_PATH_LOOKUP_REPORT_MAX_BYTES, CodexThreadPathLookupReport,
};
use sandbox::{ExecResult, ExecTermination};

#[test]
fn restore_reused_session_uses_codex_reported_rollout_path() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    let reported_path = format!(
        "/home/user/.codex/sessions/2026/06/05/rollout-2026-06-05T15-18-08-{CODEX_SESSION_ID}.jsonl"
    );
    let report = CodexThreadPathLookupReport::Found {
        path: reported_path.clone(),
    };
    let mut report_bytes = serde_json::to_vec(&report).unwrap();
    report_bytes.push(b'\n');
    sandbox.push_exec_result(Ok(ExecResult::new(0, report_bytes, Vec::new())));

    let (result, events) = capture_restore_events(restore_reused_session(&sandbox, &ctx, &session));
    result.unwrap();

    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 3);
    assert!(exec_calls[0].cmd.contains("resolve-codex-rollout-path"));
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(codex_restore_target(&writes[0].path), reported_path);
    assert_eq!(
        captured_event(&events, "restored session history")
            .fields
            .get("destination_source")
            .map(String::as_str),
        Some("codex-index")
    );
}

#[test]
fn restore_reused_zstd_session_uses_codex_reported_logical_path() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let timestamp = chrono::DateTime::parse_from_rfc3339("2026-06-04T07:18:08.000Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let session = materialized_codex_zstd_session(CODEX_SESSION_ID, b"compressed", timestamp);
    let reported_path = format!(
        "/home/user/.codex/sessions/2026/06/05/rollout-2026-06-05T15-18-08-{CODEX_SESSION_ID}.jsonl"
    );
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&CodexThreadPathLookupReport::Found {
            path: reported_path.clone(),
        })
        .unwrap(),
        Vec::new(),
    )));

    run_restore_session(restore_reused_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        codex_restore_target(&writes[0].path),
        format!("{reported_path}.zst")
    );
}

#[test]
fn restore_reused_session_falls_back_when_codex_does_not_know_thread() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&CodexThreadPathLookupReport::NotFound {}).unwrap(),
        Vec::new(),
    )));

    let (result, events) = capture_restore_events(restore_reused_session(&sandbox, &ctx, &session));
    result.unwrap();

    assert_eq!(sandbox.exec_calls().len(), 3);
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(codex_restore_target(&writes[0].path).ends_with(CODEX_CANONICAL_ROLLOUT_SUFFIX));
    assert_eq!(
        captured_event(&events, "restored session history")
            .fields
            .get("destination_source")
            .map(String::as_str),
        Some("reused-fallback")
    );
}

#[test]
fn restore_reused_session_rejects_untrusted_codex_paths_and_reports() {
    let other_thread_id = "019e9154-c304-70f0-adde-36efb1be1702";
    let invalid_reports = [
        b"{".to_vec(),
        br#"{"status":"notFound","path":"/tmp/injected"}"#.to_vec(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-{CODEX_SESSION_ID}.jsonl","extra":true}}"#
        )
        .into_bytes(),
        format!(r#"{{"status":"found","path":"/tmp/rollout-{CODEX_SESSION_ID}.jsonl"}}"#)
            .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-{CODEX_SESSION_ID_NO_DASHES}.jsonl"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-{CODEX_SESSION_ID}.jsonl.zst"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/extra/rollout-2026-06-04T07-18-08-{CODEX_SESSION_ID}.jsonl"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/../rollout-2026-06-04T07-18-08-{CODEX_SESSION_ID}.jsonl"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/05/rollout-2026-06-04T07-18-08-{CODEX_SESSION_ID}.jsonl"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/02/29/rollout-2026-02-29T07-18-08-{CODEX_SESSION_ID}.jsonl"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T24-18-08-{CODEX_SESSION_ID}.jsonl"}}"#
        )
        .into_bytes(),
        format!(
            r#"{{"status":"found","path":"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-{other_thread_id}.jsonl"}}"#
        )
        .into_bytes(),
    ];

    for report in invalid_reports {
        let sandbox = MockSandbox::new("test");
        let ctx = codex_context();
        let session = materialized_text_session(
            CODEX_SESSION_ID,
            codex_minimal_session_meta_history(CODEX_SESSION_ID),
        );
        sandbox.push_exec_result(Ok(ExecResult::new(0, report, Vec::new())));

        let error =
            run_restore_session(restore_reused_session(&sandbox, &ctx, &session)).unwrap_err();

        assert!(
            error.to_string().contains("codex"),
            "unexpected error: {error}"
        );
        assert_eq!(sandbox.exec_calls().len(), 1);
        assert!(sandbox.write_file_calls().is_empty());
    }
}

#[test]
fn restore_reused_session_rejects_failed_or_oversized_lookup() {
    let oversized = vec![b'a'; CODEX_THREAD_PATH_LOOKUP_REPORT_MAX_BYTES + 1];
    let failures = [
        ExecResult::new(1, Vec::new(), b"lookup failed".to_vec()),
        ExecResult {
            termination: ExecTermination::WaitFailed,
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
        ExecResult {
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout: b"{\"status\":\"notFound\"}".to_vec(),
            stderr: Vec::new(),
            diagnostic: String::new(),
            stdout_truncated: true,
            stderr_truncated: false,
        },
        ExecResult::new(0, oversized, Vec::new()),
    ];

    for failure in failures {
        let sandbox = MockSandbox::new("test");
        let ctx = codex_context();
        let session = materialized_text_session(
            CODEX_SESSION_ID,
            codex_minimal_session_meta_history(CODEX_SESSION_ID),
        );
        sandbox.push_exec_result(Ok(failure));

        let error =
            run_restore_session(restore_reused_session(&sandbox, &ctx, &session)).unwrap_err();

        assert!(
            error.to_string().contains("codex thread path lookup"),
            "unexpected error: {error}"
        );
        assert_eq!(sandbox.exec_calls().len(), 1);
        assert!(sandbox.write_file_calls().is_empty());
    }
}

#[test]
fn restore_session_writes_codex_session() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    ctx.resume_session = Some(resume_ref_for_history(CODEX_SESSION_ID, history.as_bytes()));
    let session = materialized_text_session(CODEX_SESSION_ID, history.clone());
    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_restore_calls(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        codex_restore_target(&writes[0].path).ends_with(CODEX_CANONICAL_ROLLOUT_SUFFIX),
        "codex resume history must be restored as a canonical rollout jsonl, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, session.history_bytes());
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_writes_codex_zstd_session() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    let compressed = zstd::encode_all(history.as_bytes(), 0).unwrap();
    let timestamp = chrono::DateTime::parse_from_rfc3339("2026-06-04T07:18:08.000Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let session = materialized_codex_zstd_session(CODEX_SESSION_ID, &compressed, timestamp);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_restore_calls(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        codex_restore_target(&writes[0].path)
            .ends_with(&format!("{CODEX_CANONICAL_ROLLOUT_SUFFIX}.zst")),
        "codex zstd resume history must be restored as canonical rollout jsonl.zst, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, compressed);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
}

#[test]
fn restore_session_logs_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session));

    let diagnostics = result.unwrap();
    assert_eq!(diagnostics.framework, "codex");
    assert_eq!(diagnostics.session_id, CODEX_SESSION_ID);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
    let restore_event = captured_event(&events, "restored session history");
    assert_eq!(
        restore_event.fields.get("framework").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        restore_event.fields.get("session_id").map(String::as_str),
        Some(CODEX_SESSION_ID)
    );
    assert_eq!(
        restore_event
            .fields
            .get("destination_source")
            .map(String::as_str),
        Some("non-reused-fallback")
    );
    assert!(
        !restore_event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {restore_event:#?}"
    );
}

#[test]
fn restore_session_writes_codex_session_with_canonical_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        "{\"type\":\"thread.started\"}\n{not-json}\n",
    );

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_restore_calls(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    let target = codex_restore_target(&writes[0].path);
    assert!(
        target.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = target
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with(CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, session.history_bytes());
}

#[test]
fn restore_session_writes_invalid_utf8_codex_history_with_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let history =
        b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-06-04T07:18:08.000Z\"}}\n\xff\n";
    let session = materialized_bytes_session(CODEX_SESSION_ID, history);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_restore_calls(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    let target = codex_restore_target(&writes[0].path);
    assert!(
        target.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = target
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with(CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, history);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_canonicalizes_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID_COMPACT_UPPERCASE, "{}\n");

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_restore_calls(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        codex_restore_target(&writes[0].path).ends_with(CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX),
        "codex restore path must use canonical thread id, got {}",
        writes[0].path
    );
}

#[tokio::test]
async fn restore_session_rejects_short_codex_session_id_without_cleanup() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session("abc", "{}");

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("invalid codex session_id"), "got: {err}");
    assert!(
        !message.contains("abc"),
        "invalid codex error must not echo raw session id: {message}"
    );
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_rejects_decorated_codex_session_id_without_cleanup() {
    for raw_session_id in [
        "{019e9154-c304-70f0-adde-36efb1be1701}",
        "urn:uuid:019e9154-c304-70f0-adde-36efb1be1701",
    ] {
        let sandbox = MockSandbox::new("test");
        let ctx = codex_context();
        let session = materialized_text_session(raw_session_id, "{}");

        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

        let message = err.to_string();
        assert!(message.contains("invalid session_id"), "got: {err}");
        assert!(
            !message.contains(raw_session_id),
            "invalid codex error must not echo raw session id: {message}"
        );
        assert!(sandbox.exec_calls().is_empty());
        assert!(sandbox.write_file_calls().is_empty());
    }
}

#[tokio::test]
async fn restore_session_fails_before_write_when_codex_prepare_fails() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        b"cleanup stdout".to_vec(),
        b"cleanup failed".to_vec(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains("codex session restore prepare failed"),
        "got: {message}"
    );
    assert!(message.contains("cleanup failed"), "got: {message}");
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_fails_when_codex_cleanup_exceeds_scan_budget() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"codex session cleanup exceeded scan budget".to_vec(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session restore commit failed"));
    assert!(message.contains("codex session cleanup exceeded scan budget"));
    assert_eq!(sandbox.write_file_calls().len(), 1);
}

#[tokio::test]
async fn restore_session_preserves_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        format!("stdout includes {CODEX_SESSION_ID_NO_DASHES}").into_bytes(),
        format!("find: {CODEX_CANONICAL_ROLLOUT_PATH}: Permission denied").into_bytes(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session restore commit failed"));
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_SESSION_ID_NO_DASHES),
        "got: {message}"
    );
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
    assert_eq!(sandbox.write_file_calls().len(), 1);
}

#[tokio::test]
async fn restore_session_preserves_non_exited_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::WaitFailed,
        stdout: format!("stdout includes {CODEX_SESSION_ID_NO_DASHES}").into_bytes(),
        stderr: format!("find: {CODEX_CANONICAL_ROLLOUT_PATH}: Permission denied").into_bytes(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session restore commit failed (wait failed)"));
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_SESSION_ID_NO_DASHES),
        "got: {message}"
    );
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
    assert_eq!(sandbox.write_file_calls().len(), 1);
}

#[tokio::test]
async fn restore_session_preserves_codex_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to rename temp file to {CODEX_CANONICAL_ROLLOUT_PATH}: thread {CODEX_SESSION_ID_NO_DASHES}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_SESSION_ID_NO_DASHES),
        "got: {message}"
    );
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_preserves_codex_original_no_dash_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID_COMPACT_UPPERCASE,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write original thread {CODEX_SESSION_ID_COMPACT_UPPERCASE} at {CODEX_CANONICAL_ROLLOUT_PATH}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(CODEX_SESSION_ID_COMPACT_UPPERCASE),
        "got: {message}"
    );
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_preserves_codex_mixed_case_original_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID_MIXED_CASE,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write original thread {CODEX_SESSION_ID_MIXED_CASE} with canonical {CODEX_SESSION_ID}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(CODEX_SESSION_ID_MIXED_CASE),
        "got: {message}"
    );
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
}
