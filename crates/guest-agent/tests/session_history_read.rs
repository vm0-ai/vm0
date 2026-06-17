//! Integration tests for session-history reading.
//!
//! These tests exercise the public `read_session_history` entry with real
//! temporary filesystem state. They intentionally do not initialize Codex
//! framework env because they cover reader behavior, not event metadata capture.

use std::path::{Path, PathBuf};

const VALID_CODEX_THREAD_ID: &str = "0193abcd-ef01-7234-89ab-cdef01234567";
const UNKNOWN_CODEX_THREAD_ID: &str = "ffffffff-ffff-7fff-bfff-ffffffffffff";

/// Build a `YYYY/MM/DD/` style nested path under `root` and write a file.
///
/// Returns `Result<_, String>` rather than `unwrap`-ing because clippy's
/// test unwrap allowance applies to `#[test]` bodies, not helpers.
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

fn write_codex_marker_path_file(
    root: &Path,
    sessions_dir: &Path,
    thread_id: &str,
) -> Result<PathBuf, String> {
    let path_file = root.join("path.txt");
    let marker = format!(
        "CODEX_SEARCH:{}:{thread_id}",
        sessions_dir.to_string_lossy()
    );
    std::fs::write(&path_file, marker.as_bytes())
        .map_err(|e| format!("write {}: {e}", path_file.display()))?;
    Ok(path_file)
}

fn assert_error_contains_without_secret(
    error: impl std::fmt::Display,
    expected: &str,
    secret: &str,
) {
    let msg = error.to_string();
    assert!(
        msg.contains(expected),
        "expected error containing {expected:?}, got: {msg}"
    );
    assert!(
        !msg.contains(secret),
        "error must not expose sensitive id {secret:?}, got: {msg}"
    );
}

#[test]
fn read_session_history_resolves_literal_codex_marker_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let history = b"{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl"),
        history,
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, history);
}

#[test]
fn read_session_history_decodes_legacy_zstd_session() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let history = b"{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n";
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl.zst"),
        &compressed,
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, history);
}

#[test]
fn read_session_history_rejects_duplicate_codex_matches() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl"),
        b"first\n",
    )
    .unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "29"],
        &format!("rollout-2026-04-29T11-22-37-{VALID_CODEX_THREAD_ID}.jsonl"),
        b"second\n",
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("duplicate codex sessions must fail clearly");
    assert_error_contains_without_secret(
        err,
        "Multiple Codex session files found",
        VALID_CODEX_THREAD_ID,
    );
}

#[test]
fn read_session_history_rejects_duplicate_jsonl_and_zstd_matches() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl"),
        b"jsonl\n",
    )
    .unwrap();
    let compressed = zstd::encode_all(b"zstd\n".as_slice(), 0).unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "29"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl.zst"),
        &compressed,
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("duplicate codex sessions must include zstd matches");
    assert_error_contains_without_secret(
        err,
        "Multiple Codex session files found",
        VALID_CODEX_THREAD_ID,
    );
}

#[test]
fn read_session_history_rejects_duplicate_before_reading_corrupt_zstd() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl.zst"),
        b"not zstd",
    )
    .unwrap();
    write_session_file(
        &sessions_dir,
        &["2026", "04", "29"],
        &format!("rollout-2026-04-29T11-22-37-{VALID_CODEX_THREAD_ID}.jsonl.zst"),
        b"also not zstd",
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("duplicate codex sessions must fail before decoding any candidate");
    assert_error_contains_without_secret(
        err,
        "Multiple Codex session files found",
        VALID_CODEX_THREAD_ID,
    );
}

#[test]
fn read_session_history_corrupt_zstd_error_omits_thread_id() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("{VALID_CODEX_THREAD_ID}.jsonl.zst"),
        b"not zstd",
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("corrupt zstd codex session must fail clearly");
    assert_error_contains_without_secret(
        err,
        "Failed to decompress zstd session history",
        VALID_CODEX_THREAD_ID,
    );
}

#[test]
fn read_session_history_resolves_dash_stripped_filename() {
    // Real codex CLI prefixes filenames with `rollout-{ts}-` and the
    // concatenation strips the UUID dashes. The substring matcher must
    // handle that.
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let id_no_dashes = VALID_CODEX_THREAD_ID.replace('-', "");
    let history = b"line1\nline2\n";
    write_session_file(
        &sessions_dir,
        &["2026", "04", "28"],
        &format!("rollout-2026-04-28T11-22-37-{id_no_dashes}.jsonl"),
        history,
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, history);
}

#[test]
fn read_session_history_codex_marker_with_no_match_fails_fast() {
    // Plant an unrelated file under the tree so any silent fallback would have
    // something to pick. The fail-fast path must reject it.
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "27"],
        "rollout-unrelated.jsonl.zst",
        &zstd::encode_all(b"unrelated".as_slice(), 0).unwrap(),
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, UNKNOWN_CODEX_THREAD_ID).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("missing codex session must surface as an error");
    assert_error_contains_without_secret(
        err,
        "Codex session file not found",
        UNKNOWN_CODEX_THREAD_ID,
    );
}

#[test]
fn read_session_history_codex_marker_rejects_dash_only_thread_id() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "27"],
        "rollout-unrelated.jsonl",
        b"unrelated\n",
    )
    .unwrap();

    let path_file = write_codex_marker_path_file(tmp.path(), &sessions_dir, "---").unwrap();

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
    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    write_session_file(
        &sessions_dir,
        &["2026", "04", "27"],
        "rollout-abc.jsonl",
        b"unrelated\n",
    )
    .unwrap();

    let path_file = write_codex_marker_path_file(tmp.path(), &sessions_dir, "abc").unwrap();

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
    let tmp = tempfile::tempdir().unwrap();
    let session_id = "sess-secret-123";
    let history = tmp.path().join(format!("{session_id}.jsonl"));
    let path_file = tmp.path().join("path.txt");
    std::fs::write(&path_file, history.to_string_lossy().as_bytes()).unwrap();

    let err = guest_agent::session_history::read_session_history(path_file.to_str().unwrap())
        .expect_err("missing literal session history path must fail clearly");
    assert_error_contains_without_secret(err, "Failed to read session history", session_id);
}

#[cfg(unix)]
#[test]
fn read_session_history_codex_marker_skips_symlinks() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let outside_dir = tmp.path().join("outside");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    std::fs::create_dir_all(&outside_dir).unwrap();

    let outside_history = outside_dir.join(format!("{VALID_CODEX_THREAD_ID}.jsonl"));
    std::fs::write(&outside_history, b"outside-history\n").unwrap();

    symlink(&outside_dir, sessions_dir.join("linked-outside")).unwrap();
    symlink(
        &outside_history,
        sessions_dir.join(format!("{VALID_CODEX_THREAD_ID}.jsonl")),
    )
    .unwrap();
    symlink(
        "/definitely/missing/codex-history.jsonl",
        sessions_dir.join("dangling.jsonl"),
    )
    .unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

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

    let tmp = tempfile::tempdir().unwrap();
    let real_sessions_dir = tmp.path().join("real-sessions");
    let sessions_link = tmp.path().join("sessions-link");
    std::fs::create_dir_all(&real_sessions_dir).unwrap();

    std::fs::write(
        real_sessions_dir.join(format!("{VALID_CODEX_THREAD_ID}.jsonl")),
        b"outside-root-history\n",
    )
    .unwrap();
    symlink(&real_sessions_dir, &sessions_link).unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_link, VALID_CODEX_THREAD_ID).unwrap();

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

    let tmp = tempfile::tempdir().unwrap();
    let real_codex_home = tmp.path().join("real-codex-home");
    let codex_home_link = tmp.path().join(".codex");
    let real_sessions_dir = real_codex_home.join("sessions");
    std::fs::create_dir_all(&real_sessions_dir).unwrap();

    std::fs::write(
        real_sessions_dir.join(format!("{VALID_CODEX_THREAD_ID}.jsonl")),
        b"outside-parent-history\n",
    )
    .unwrap();
    symlink(&real_codex_home, &codex_home_link).unwrap();

    let path_file = write_codex_marker_path_file(
        tmp.path(),
        &codex_home_link.join("sessions"),
        VALID_CODEX_THREAD_ID,
    )
    .unwrap();

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

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();

    let _socket =
        UnixListener::bind(sessions_dir.join(format!("{VALID_CODEX_THREAD_ID}.jsonl"))).unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

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

    let tmp = tempfile::tempdir().unwrap();
    let sessions_dir = tmp.path().join("sessions");
    let blocked_dir = sessions_dir.join("blocked");
    std::fs::create_dir_all(&blocked_dir).unwrap();
    std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

    let path_file =
        write_codex_marker_path_file(tmp.path(), &sessions_dir, VALID_CODEX_THREAD_ID).unwrap();

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
    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("session.jsonl");
    std::fs::write(&history, b"line1\nline2\n").unwrap();
    let path_file = tmp.path().join("path.txt");
    std::fs::write(&path_file, history.to_string_lossy().as_bytes()).unwrap();

    let bytes =
        guest_agent::session_history::read_session_history(path_file.to_str().unwrap()).unwrap();
    assert_eq!(bytes, b"line1\nline2\n");
}
