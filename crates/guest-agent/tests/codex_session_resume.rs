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
//! Each `#[tokio::test]` in this binary still serialises behind a
//! `std::sync::Mutex` because they share that single set of LazyLocks
//! and because they touch the same on-disk session-id / history-path
//! files (run-id-scoped under `/tmp`).
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

#![allow(clippy::await_holding_lock)]

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
/// `/tmp/vm0-session-*.txt` files written by `capture_session_metadata`.
static TEST_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

macro_rules! http_client {
    () => {
        guest_agent::http::HttpClient::new().unwrap()
    };
}

/// Wipe the per-run session-id / history-path files so each test starts
/// from a clean slate. `capture_session_metadata` is idempotent (first id wins),
/// so leaving stale files would mask real failures.
fn reset_session_files() {
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
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

#[tokio::test]
async fn send_event_extracts_codex_thread_id_and_writes_marker() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": "0193abcd-ef01-7234-89ab-cdef01234567"
    });

    // No API token → send_event skips the HTTP POST but still captures
    // session metadata, which is the part we want to assert.
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;
    assert!(
        result.is_ok(),
        "send_event should succeed when no API token"
    );

    let stored_id =
        std::fs::read_to_string(guest_agent::paths::session_id_file()).expect("session id written");
    assert_eq!(stored_id, "0193abcd-ef01-7234-89ab-cdef01234567");

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
        marker.ends_with(":0193abcd-ef01-7234-89ab-cdef01234567"),
        "marker should end with the thread id, got: {marker}"
    );
}

#[tokio::test]
async fn send_event_codex_ignores_non_thread_started_event() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "turn.completed"});
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "session id file must not be written for non-thread.started events"
    );
}

#[tokio::test]
async fn send_event_codex_ignores_empty_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "thread.started", "thread_id": ""});
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "empty thread_id must not be persisted"
    );
}

#[tokio::test]
async fn send_event_codex_ignores_malformed_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "thread.started", "thread_id": "abc"});
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "malformed thread_id must not be persisted"
    );
}

#[tokio::test]
async fn read_session_history_resolves_codex_marker_end_to_end() {
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

#[tokio::test]
async fn read_session_history_decodes_legacy_zstd_session() {
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

#[tokio::test]
async fn read_session_history_resolves_dash_stripped_filename() {
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

#[tokio::test]
async fn read_session_history_codex_marker_with_no_match_fails_fast() {
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
}

#[tokio::test]
async fn read_session_history_codex_marker_rejects_dash_only_thread_id() {
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

#[tokio::test]
async fn read_session_history_codex_marker_rejects_short_thread_id() {
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

#[cfg(unix)]
#[tokio::test]
async fn read_session_history_codex_marker_skips_symlinks() {
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
#[tokio::test]
async fn read_session_history_codex_marker_rejects_symlinked_sessions_root() {
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
#[tokio::test]
async fn read_session_history_codex_marker_skips_special_files() {
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

#[tokio::test]
async fn read_session_history_resolves_claude_literal_path() {
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
