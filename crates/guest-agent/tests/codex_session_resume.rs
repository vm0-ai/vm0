//! Integration tests for codex session-resume + claude session-history.
//!
//! # Why a dedicated test binary
//!
//! `guest_agent::env::Framework` and the rest of the env accessors are
//! cached in process-wide `LazyLock`s on first read. The pre-existing
//! `tests/integration/mod.rs` binary defaults to Claude (no `CLI_AGENT_TYPE`
//! set), so it can't also exercise the codex branch — once `Framework`
//! is locked to `ClaudeCode`, the codex path becomes unreachable in that
//! process. Splitting codex coverage into a separate test binary gives
//! it a fresh `LazyLock` state with `CLI_AGENT_TYPE=codex`.
//!
//! Each test still serialises behind a `std::sync::Mutex` because they share
//! that single set of LazyLocks and because they touch the same on-disk
//! session-id / history-path files (run-id-scoped under `/tmp`).
//!
//! # Coverage
//!
//! - End-to-end `send_event` → `capture_session_metadata` → marker write for the
//!   codex `thread.started` event shape.
//! - `session_history::read_session_history` decodes the marker and walks the
//!   `YYYY/MM/DD/` codex layout.
//! - Claude literal-path resolution through the same public entry,
//!   exercised by passing a literal `.jsonl` path through the
//!   history-path file.
//! - Negative path: a codex marker pointing at an empty sessions dir
//!   surfaces the "file not found" error rather than a silent fallback.

use serde_json::json;
use std::path::Path;
use std::sync::{LazyLock, Mutex, Once};

use guest_agent::masker::SecretMasker;

/// Configure the process env BEFORE any `guest_agent::env` LazyLock
/// initialiser runs. Idempotent — only the first call wins.
fn setup_env_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // SAFETY: this `Once` runs on the first test, before any test
        // body has read `guest_agent::env::*`. No other thread is
        // touching the env at this point.
        unsafe {
            std::env::set_var("CLI_AGENT_TYPE", "codex");
            // Empty API token → `send_event` skips the HTTP POST after
            // running session-id extraction (which is the part we want
            // to assert against).
            std::env::set_var("VM0_API_TOKEN", "");
            std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
            std::env::set_var("VM0_RUN_ID", format!("codex-resume-{}", std::process::id()));
            std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
            std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
            std::env::set_var("VM0_PROMPT", "test prompt");
            // `home_dir` is loaded eagerly via `expect`. The marker
            // payload embeds it, so set a stable dummy.
            std::env::set_var("HOME", "/tmp/codex-resume-home");
        }
    });
}

/// Serialise tests — they share both LazyLock state and the run-id-scoped
/// runtime metadata files written by `capture_session_metadata`.
static TEST_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

macro_rules! http_client {
    () => {
        guest_agent::http::HttpClient::new().unwrap()
    };
}

fn send_event_for_test(
    event: serde_json::Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), guest_agent::error::AgentError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let http = http_client!();
    runtime.block_on(guest_agent::events::send_event(&http, event, seq, masker))
}

/// Wipe the per-run session-id / history-path files so each test starts
/// from a clean slate. `capture_session_metadata` is idempotent (first id wins),
/// so leaving stale files would mask real failures.
fn reset_session_files() {
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
}

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &Path) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

/// Build a `YYYY/MM/DD/` style nested path under `root` and write a file.
///
/// Returns `Result<_, String>` rather than `unwrap`-ing because clippy's
/// `allow-unwrap-in-tests` only whitelists `#[test]` bodies, not module-
/// level helpers. Test bodies forward via `?`.
fn write_session_file(
    root: &Path,
    sub: &[&str],
    filename: &str,
    content: &[u8],
) -> Result<(), String> {
    let mut dir = root.to_path_buf();
    for s in sub {
        dir.push(s);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {}: {e}", dir.display()))?;
    let path = dir.join(filename);
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[test]
fn send_event_extracts_codex_thread_id_and_writes_marker() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": thread_id
    });

    // No API token → send_event skips the HTTP POST but still captures
    // session metadata, which is the part we want to assert.
    let result = send_event_for_test(event, 1, &masker);
    assert!(
        result.is_ok(),
        "send_event should succeed when no API token"
    );

    let stored_id =
        std::fs::read_to_string(guest_agent::paths::session_id_file()).expect("session id written");
    assert_eq!(stored_id, thread_id);

    let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())
        .expect("history-path file written");
    assert!(
        marker.starts_with("CODEX_SEARCH:"),
        "codex framework should write a marker, got: {marker}"
    );
    assert!(
        marker.contains("/.codex/sessions:"),
        "marker should embed the codex sessions dir, got: {marker}"
    );
    assert!(
        marker.ends_with(&format!(":{thread_id}")),
        "marker should end with the thread id, got: {marker}"
    );
    assert_eq!(masker.mask_string(thread_id), "***");

    let system_log = std::fs::read_to_string(&system_log_path).expect("system log written");
    assert!(
        system_log.contains("Session history marker written to"),
        "system log should confirm marker creation, got: {system_log}"
    );
    assert!(
        !system_log.contains(thread_id),
        "system log must not contain the raw thread id, got: {system_log}"
    );
    assert!(
        !system_log.contains("CODEX_SEARCH:"),
        "system log must not contain the codex marker payload, got: {system_log}"
    );
    assert!(
        !system_log.contains(&marker),
        "system log must not contain the full marker payload, got: {system_log}"
    );
}

#[test]
fn send_event_canonicalizes_codex_thread_id_before_writing_marker() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": "0193ABCDEF01723489ABCDEF01234567"
    });
    let expected = "0193abcd-ef01-7234-89ab-cdef01234567";

    let result = send_event_for_test(event, 1, &masker);
    assert!(
        result.is_ok(),
        "send_event should succeed when no API token"
    );

    let stored_id =
        std::fs::read_to_string(guest_agent::paths::session_id_file()).expect("session id written");
    assert_eq!(stored_id, expected);

    let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())
        .expect("history-path file written");
    assert!(
        marker.ends_with(&format!(":{expected}")),
        "marker should use canonical thread id, got: {marker}"
    );
}

#[test]
fn send_event_repairs_missing_codex_history_marker_after_later_event() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    for seed_empty_marker in [false, true] {
        reset_session_files();
        guest_agent::paths::write_private(guest_agent::paths::session_id_file(), thread_id)
            .expect("seed existing session id");
        if seed_empty_marker {
            guest_agent::paths::write_private(guest_agent::paths::session_history_path_file(), "")
                .expect("seed empty history marker");
        } else {
            assert!(
                !Path::new(guest_agent::paths::session_history_path_file()).exists(),
                "history marker should start missing"
            );
        }

        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "turn.completed"});

        let result = send_event_for_test(event, 1, &masker);
        assert!(result.is_ok());

        let stored_id = std::fs::read_to_string(guest_agent::paths::session_id_file())
            .expect("session id kept");
        assert_eq!(stored_id, thread_id);
        let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())
            .expect("history marker repaired");
        assert!(
            marker.ends_with(&format!(":{thread_id}")),
            "repaired marker should point at the existing thread id, got: {marker}"
        );
    }
}

#[test]
fn send_event_codex_ignores_non_thread_started_event() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "turn.completed"});
    let result = send_event_for_test(event, 1, &masker);
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "session id file must not be written for non-thread.started events"
    );
}

#[test]
fn send_event_codex_ignores_empty_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "thread.started", "thread_id": ""});
    let result = send_event_for_test(event, 1, &masker);
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "empty thread_id must not be persisted"
    );
}

#[test]
fn send_event_codex_ignores_malformed_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();

    for thread_id in ["abc", "0193-abcd-ef01-7234-89abcdef01234567"] {
        reset_session_files();

        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "thread.started", "thread_id": thread_id});
        let result = send_event_for_test(event, 1, &masker);
        assert!(result.is_ok());

        assert!(
            !Path::new(guest_agent::paths::session_id_file()).exists(),
            "malformed thread_id must not be persisted: {thread_id}"
        );
        if thread_id.len() >= 5 {
            assert_eq!(masker.mask_string(thread_id), "***");
        } else {
            assert_eq!(masker.mask_string(thread_id), thread_id);
        }
    }
}

#[test]
fn read_session_history_resolves_codex_marker_end_to_end() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    // Set up a fake codex sessions tree under a temp dir, with a jsonl file
    // at the canonical YYYY/MM/DD/ depth.
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let history = b"{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{thread_id}.jsonl"),
        history,
    )
    .unwrap();

    // Drive the public entry exactly the way `checkpoint.rs` does:
    // a marker file pointing at the sessions dir + thread id.
    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, history);
}

#[test]
fn read_session_history_decodes_legacy_zstd_session() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let history = b"{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n";
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{thread_id}.jsonl.zst"),
        &compressed,
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, history);
}

#[test]
fn read_session_history_rejects_duplicate_codex_matches() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{thread_id}.jsonl"),
        b"first\n",
    )
    .unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "29"],
        &format!("rollout-2026-04-29T11-22-37-{thread_id}.jsonl"),
        b"second\n",
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("duplicate codex sessions must fail clearly");
    let msg = err.to_string();
    assert!(
        msg.contains("Multiple Codex session files found"),
        "expected duplicate-session error, got: {msg}"
    );
    assert!(
        !msg.contains(thread_id),
        "duplicate-session error must not expose thread id, got: {msg}"
    );
}

#[test]
fn read_session_history_rejects_duplicate_jsonl_and_zstd_matches() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{thread_id}.jsonl"),
        b"jsonl\n",
    )
    .unwrap();
    let compressed = zstd::encode_all(b"zstd\n".as_slice(), 0).unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "29"],
        &format!("{thread_id}.jsonl.zst"),
        &compressed,
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("duplicate codex sessions must include zstd matches");
    let msg = err.to_string();
    assert!(
        msg.contains("Multiple Codex session files found"),
        "expected duplicate-session error, got: {msg}"
    );
    assert!(
        !msg.contains(thread_id),
        "duplicate-session error must not expose thread id, got: {msg}"
    );
}

#[test]
fn read_session_history_rejects_duplicate_before_reading_corrupt_zstd() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{thread_id}.jsonl.zst"),
        b"not zstd",
    )
    .unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "29"],
        &format!("rollout-2026-04-29T11-22-37-{thread_id}.jsonl.zst"),
        b"also not zstd",
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("duplicate codex sessions must fail before decoding any candidate");
    let msg = err.to_string();
    assert!(
        msg.contains("Multiple Codex session files found"),
        "expected duplicate-session error, got: {msg}"
    );
    assert!(
        !msg.contains(thread_id),
        "duplicate-session error must not expose thread id, got: {msg}"
    );
}

#[test]
fn read_session_history_corrupt_zstd_error_omits_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{thread_id}.jsonl.zst"),
        b"not zstd",
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("corrupt zstd codex session must fail clearly");
    let msg = err.to_string();
    assert!(
        msg.contains("Failed to decompress zstd session history"),
        "expected zstd decode error, got: {msg}"
    );
    assert!(
        !msg.contains(thread_id),
        "zstd decode error must not expose thread id, got: {msg}"
    );
}

#[test]
fn read_session_history_resolves_dash_stripped_filename() {
    // Real codex CLI prefixes filenames with `rollout-{ts}-` and the
    // concatenation strips the UUID dashes — the substring matcher must
    // handle that. Bug-prone enough to deserve its own integration case.
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let id_no_dashes = thread_id.replace('-', "");
    let history = b"line1\nline2\n";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("rollout-2026-04-28T11-22-37-{id_no_dashes}.jsonl"),
        history,
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, history);
}

#[test]
fn read_session_history_codex_marker_with_no_match_fails_fast() {
    // Verifies the post-fix behaviour (#11430 review feedback): when no
    // filename matches the dash-stripped UUID, return a "not found"
    // error instead of silently picking some unrelated recent file.
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    // Plant an unrelated file under the tree so any silent fallback
    // would have something to pick. The fix-fast path must reject it.
    write_session_file(
        &sessions_dir,
        &["2026", "04", "27"],
        "rollout-unrelated.jsonl.zst",
        &zstd::encode_all(b"unrelated".as_slice(), 0).unwrap(),
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let unknown_id = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    let marker = format!(
        "CODEX_SEARCH:{}:{unknown_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("missing codex session must surface as an error");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected fail-fast error, got: {msg}"
    );
    assert!(
        !msg.contains(unknown_id),
        "missing-session error must not expose thread id, got: {msg}"
    );
}

#[test]
fn read_session_history_codex_marker_rejects_dash_only_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "27"],
        "rollout-unrelated.jsonl",
        b"unrelated\n",
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!("CODEX_SEARCH:{}:---", sessions_dir.to_string_lossy());
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("dash-only codex thread id must not match every history file");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected malformed thread id to fail fast, got: {msg}"
    );
}

#[test]
fn read_session_history_codex_marker_rejects_short_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "27"],
        "rollout-abc.jsonl",
        b"unrelated\n",
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!("CODEX_SEARCH:{}:abc", sessions_dir.to_string_lossy());
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("short codex thread id must not match unrelated history files");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected malformed thread id to fail fast, got: {msg}"
    );
}

#[test]
fn read_session_history_read_error_omits_literal_session_path() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let session_id = "sess-secret-123";
    let history = tmp.path().join(format!("{session_id}.jsonl"));
    let path_file = tmp.path().join("path.txt");
    std::fs::write(&path_file, history.to_string_lossy().as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("missing literal session history path must fail clearly");
    let msg = err.to_string();
    assert!(
        msg.contains("Failed to read session history"),
        "expected read error, got: {msg}"
    );
    assert!(
        !msg.contains(session_id),
        "history read error must not expose session id, got: {msg}"
    );
}

#[cfg(unix)]
#[test]
fn read_session_history_codex_marker_skips_symlinks() {
    use std::os::unix::fs::symlink;

    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let outside_dir = tmp.path().join("outside");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    std::fs::create_dir_all(&outside_dir).unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let outside_history = outside_dir.join(format!("{thread_id}.jsonl"));
    std::fs::write(&outside_history, b"outside-history\n").unwrap();

    symlink(&outside_dir, sessions_dir.join("linked-outside")).unwrap();
    symlink(
        &outside_history,
        sessions_dir.join(format!("{thread_id}.jsonl")),
    )
    .unwrap();
    symlink(
        "/definitely/missing/codex-history.jsonl",
        sessions_dir.join("dangling.jsonl"),
    )
    .unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("codex lookup must not follow symlinked history paths");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected symlinked candidates to be ignored, got: {msg}"
    );
}

#[cfg(unix)]
#[test]
fn read_session_history_codex_marker_rejects_symlinked_sessions_root() {
    use std::os::unix::fs::symlink;

    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let real_sessions_dir = tmp.path().join("real-sessions");
    let sessions_link = tmp.path().join("sessions-link");
    std::fs::create_dir_all(&real_sessions_dir).unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    std::fs::write(
        real_sessions_dir.join(format!("{thread_id}.jsonl")),
        b"outside-root-history\n",
    )
    .unwrap();
    symlink(&real_sessions_dir, &sessions_link).unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_link.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("codex lookup must not follow a symlinked sessions root");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected symlinked sessions root to be ignored, got: {msg}"
    );
}

#[cfg(unix)]
#[test]
fn read_session_history_codex_marker_rejects_symlinked_codex_home_parent() {
    use std::os::unix::fs::symlink;

    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let real_codex_home = tmp.path().join("real-codex-home");
    let codex_home_link = tmp.path().join(".codex");
    let real_sessions_dir = real_codex_home.join("sessions");
    std::fs::create_dir_all(&real_sessions_dir).unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    std::fs::write(
        real_sessions_dir.join(format!("{thread_id}.jsonl")),
        b"outside-parent-history\n",
    )
    .unwrap();
    symlink(&real_codex_home, &codex_home_link).unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        codex_home_link.join("sessions").to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("codex lookup must not follow a symlinked codex home parent");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected symlinked codex home parent to be ignored, got: {msg}"
    );
}

#[cfg(unix)]
#[test]
fn read_session_history_codex_marker_skips_special_files() {
    use std::os::unix::net::UnixListener;

    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let _socket = UnixListener::bind(sessions_dir.join(format!("{thread_id}.jsonl"))).unwrap();

    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("codex lookup must ignore matching non-regular files");
    let msg = err.to_string();
    assert!(
        msg.contains("Codex session file not found"),
        "expected matching special file to be ignored, got: {msg}"
    );
}

#[cfg(unix)]
#[test]
fn read_session_history_codex_marker_reports_unreadable_directory() {
    use std::os::unix::fs::PermissionsExt;

    // SAFETY: `geteuid` only reads the current process credential.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }

    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let blocked_dir = sessions_dir.join("blocked");
    std::fs::create_dir_all(&blocked_dir).unwrap();
    std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let path_file = tmp.path().join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes()).unwrap();

    let result = guest_agent::session_history::read_session_history(path_file.to_str().unwrap());
    std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

    let err = result.expect_err("unreadable codex directories must surface as read errors");
    let msg = err.to_string();
    assert!(
        msg.contains("Failed to read session history"),
        "expected directory read error, got: {msg}"
    );
    assert!(
        msg.contains("Permission denied"),
        "expected permission failure to be preserved, got: {msg}"
    );
}

#[test]
fn read_session_history_resolves_claude_literal_path() {
    // Claude path goes through the same public entry but uses a literal
    // jsonl path rather than a marker. Covered here because the Claude-
    // side integration test in `tests/integration/mod.rs` only asserts the
    // marker write, not the read-back through `read_session_history`.
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("session.jsonl");
    std::fs::write(&history, b"line1\nline2\n").unwrap();
    let path_file = tmp.path().join("path.txt");
    std::fs::write(&path_file, history.to_string_lossy().as_bytes()).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, b"line1\nline2\n");
}
