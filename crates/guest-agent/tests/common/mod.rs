//! Shared setup for CLI forced-termination integration tests.
//!
//! # Why separate test binaries instead of cases in one
//!
//! `guest_agent::env` caches all `VM0_*` values in process-wide
//! `LazyLock`s on first read. Consolidating scenarios with different
//! prompts or grace windows into one `#[tokio::test]` binary would
//! require each test to see its own `VM0_PROMPT`, which is impossible
//! once the `LazyLock` is initialised. Splitting into separate binaries
//! gives each one a fresh process + fresh LazyLock state, paid for by
//! a small cargo build-cache hit (idempotent).
//!
//! # Error handling
//!
//! Fallible helpers return `Result<_, String>` and let the test's
//! `#[tokio::test]` body propagate with `?` — clippy's
//! `allow-expect-in-tests` applies to test bodies but not to helpers
//! defined in `tests/common/mod.rs`.

#![allow(dead_code)] // consumed across multiple test binaries

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 128 + SIGTERM(15). Rust / glibc's default signal handler maps a
/// SIGTERM-terminated process to this exit code.
pub const SIGTERM_EXIT: i32 = 143;

/// 128 + SIGKILL(9). Un-catchable; the only way out for a process
/// that ignores SIGTERM.
pub const SIGKILL_EXIT: i32 = 137;

/// Normal clean exit. Reap should never fire on this path.
pub const CLEAN_EXIT: i32 = 0;

/// Documented maximum number of stderr lines returned in
/// `guest_agent::cli::CliExecutionResult`.
pub const CLI_STDERR_RESULT_MAX_LINES: usize = 200;

/// Documented maximum byte length for one returned stderr line after CRLF normalization.
pub const CLI_STDERR_RESULT_MAX_LINE_BYTES: usize = 16 * 1024;

/// Documented replacement for a stderr line that exceeds the diagnostic limit.
pub const CLI_STDERR_OMITTED_LONG_LINE: &str =
    "[stderr line omitted: exceeded diagnostic size limit]";

pub const CHAT_STREAM_THREAD_ID: &str = "22222222-2222-4222-8222-222222222222";
pub const CHAT_STREAM_SESSION_ID: &str = "mock-stream-session";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordedHttpEvent {
    Request(RecordedRequest),
    Response { path: String, status: u16 },
}

pub struct RecordingServer {
    pub base_url: String,
    events: Arc<Mutex<Vec<RecordedHttpEvent>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl RecordingServer {
    pub async fn start(ably_status: u16, ably_response_delay: Duration) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind recording server: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("recording server local_addr: {e}"))?;
        let events = Arc::new(Mutex::new(Vec::new()));
        let task_events = Arc::clone(&events);
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _peer)) = listener.accept().await {
                let connection_events = Arc::clone(&task_events);
                tokio::spawn(async move {
                    let Ok(request) = read_http_request(&mut socket).await else {
                        let _ = write_http_response(&mut socket, 400).await;
                        return;
                    };
                    let status = if request.path.starts_with("/channels/") {
                        ably_status
                    } else {
                        200
                    };
                    push_recorded_event(
                        &connection_events,
                        RecordedHttpEvent::Request(request.clone()),
                    );
                    if request.path.starts_with("/channels/") && !ably_response_delay.is_zero() {
                        tokio::time::sleep(ably_response_delay).await;
                    }
                    let _ = write_http_response(&mut socket, status).await;
                    push_recorded_event(
                        &connection_events,
                        RecordedHttpEvent::Response {
                            path: request.path,
                            status,
                        },
                    );
                });
            }
        });

        Ok(Self {
            base_url: format!("http://{addr}"),
            events,
            handle,
        })
    }

    pub fn events(&self) -> Result<Vec<RecordedHttpEvent>, String> {
        self.events
            .lock()
            .map(|events| events.clone())
            .map_err(|_| "recording server event mutex poisoned".to_string())
    }

    pub fn requests(&self) -> Result<Vec<RecordedRequest>, String> {
        Ok(self
            .events()?
            .into_iter()
            .filter_map(|event| match event {
                RecordedHttpEvent::Request(request) => Some(request),
                RecordedHttpEvent::Response { .. } => None,
            })
            .collect())
    }

    pub async fn wait_for_quiet(
        &self,
        quiet_for: Duration,
        timeout: Duration,
    ) -> Result<Vec<RecordedHttpEvent>, String> {
        let started_at = Instant::now();
        let mut last_len = self.events()?.len();
        let mut quiet_started_at = Instant::now();

        loop {
            let events = self.events()?;
            if events.len() != last_len {
                last_len = events.len();
                quiet_started_at = Instant::now();
            } else if quiet_started_at.elapsed() >= quiet_for {
                return Ok(events);
            }

            if started_at.elapsed() >= timeout {
                return Err(format!(
                    "recording server did not become quiet within {timeout:?}; observed {last_len} events"
                ));
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for RecordingServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[derive(Debug)]
pub struct RunFilesGuard {
    ops_file: String,
}

impl RunFilesGuard {
    pub fn new() -> Self {
        let ops_file = guest_common::telemetry::sandbox_ops_log().to_string();
        cleanup_run_files(&ops_file);
        Self { ops_file }
    }
}

impl Default for RunFilesGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files(&self.ops_file);
    }
}

fn cleanup_run_files(ops_file: &str) {
    let _ = std::fs::remove_file(guest_agent::paths::agent_log_file());
    let _ = std::fs::remove_file(guest_agent::paths::event_error_flag());
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
    let _ = std::fs::remove_file(ops_file);
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Result<RecordedRequest, String> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(index) = find_subsequence(&buffer, b"\r\n\r\n") {
            break index;
        }
        let mut chunk = [0u8; 1024];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request: {e}"))?;
        if read == 0 {
            return Err("connection closed before request headers".to_string());
        }
        buffer.extend_from_slice(
            chunk
                .get(..read)
                .ok_or_else(|| "read chunk length out of bounds".to_string())?,
        );
    };

    let header_bytes = buffer
        .get(..header_end)
        .ok_or_else(|| "request header range out of bounds".to_string())?;
    let headers = std::str::from_utf8(header_bytes)
        .map_err(|e| format!("request headers are not UTF-8: {e}"))?;
    let (request_line, header_lines) = headers
        .split_once("\r\n")
        .map_or((headers, ""), |(line, rest)| (line, rest));
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("invalid request line: {request_line:?}"))?
        .to_string();

    let mut authorization = None;
    let mut content_length = 0usize;
    for line in header_lines.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let trimmed_name = name.trim();
        let trimmed_value = value.trim();
        if trimmed_name.eq_ignore_ascii_case("authorization") {
            authorization = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("content-length") {
            content_length = trimmed_value
                .parse()
                .map_err(|e| format!("invalid content-length {trimmed_value:?}: {e}"))?;
        }
    }

    let body_start = header_end
        .checked_add(4)
        .ok_or_else(|| "request header length overflow".to_string())?;
    let body_end = body_start
        .checked_add(content_length)
        .ok_or_else(|| "request body length overflow".to_string())?;
    while buffer.len() < body_end {
        let mut chunk = [0u8; 1024];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request body: {e}"))?;
        if read == 0 {
            return Err("connection closed before request body".to_string());
        }
        buffer.extend_from_slice(
            chunk
                .get(..read)
                .ok_or_else(|| "body chunk length out of bounds".to_string())?,
        );
    }

    let body_bytes = buffer
        .get(body_start..body_end)
        .ok_or_else(|| "request body range out of bounds".to_string())?;
    let body = String::from_utf8_lossy(body_bytes).into_owned();

    Ok(RecordedRequest {
        path,
        authorization,
        body,
    })
}

async fn write_http_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response =
        format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("write response: {e}"))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn push_recorded_event(events: &Arc<Mutex<Vec<RecordedHttpEvent>>>, event: RecordedHttpEvent) {
    if let Ok(mut events) = events.lock() {
        events.push(event);
    }
}

/// Integration tests call `execute_cli` directly, bypassing the runner-side
/// workspace-drive mount. Create the canonical mountpoint once at the host-test
/// boundary so tests exercise the same cwd contract as production.
pub fn ensure_canonical_workspace_for_test() -> Result<(), String> {
    let path = Path::new(guest_agent::paths::CANONICAL_WORKING_DIR);
    if path.is_dir() {
        return Ok(());
    }

    match std::fs::create_dir_all(path) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(e) => {
            return Err(format!(
                "create canonical workspace {}: {e}",
                path.display()
            ));
        }
    }

    let status = std::process::Command::new("sudo")
        .args(["-n", "mkdir", "-p"])
        .arg(path)
        .status()
        .map_err(|e| format!("invoke sudo mkdir for {}: {e}", path.display()))?;
    if !status.success() {
        return Err(format!(
            "sudo mkdir failed for canonical workspace {} with status {status}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "canonical workspace was not created as a directory: {}",
            path.display()
        ));
    }
    Ok(())
}

/// Build the mock binary (idempotent when up to date) and resolve its
/// filesystem path.
///
/// The subprocess `cargo build` must land the artifact in the same
/// `target/` directory + profile that the enclosing `cargo test` uses,
/// otherwise the mock goes to a different spot than where we look for
/// it — which happens under `cargo llvm-cov` (custom `--target-dir`)
/// and under `cargo test --release`. We infer both from the currently-
/// running test binary's path and forward them to the subprocess.
pub fn build_and_locate_mock() -> Result<PathBuf, String> {
    // Test binary:   <target_dir>/<profile>/deps/<name>-<hash>
    //   parent():    <target_dir>/<profile>/deps
    //   parent().parent():  <target_dir>/<profile>   ← target_profile_dir
    //   parent().parent().parent():  <target_dir>
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let target_profile_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "target/<profile> dir".to_string())?;
    let target_dir = target_profile_dir
        .parent()
        .ok_or_else(|| "target dir".to_string())?;
    let profile_dir_name = target_profile_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "profile dir name".to_string())?;

    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "-p", "guest-mock-claude", "--quiet"])
        .arg("--target-dir")
        .arg(target_dir);
    // Cargo profile → output dir mapping:
    //   --release            → target_dir/release
    //   --profile <name>     → target_dir/<name>
    //   (default / dev)      → target_dir/debug
    // So pick the flag that lands the artifact beside our test binary.
    match profile_dir_name {
        "debug" => {}
        "release" => {
            cmd.arg("--release");
        }
        other => {
            cmd.args(["--profile", other]);
        }
    }

    let status = cmd
        .status()
        .map_err(|e| format!("invoke cargo build: {e}"))?;
    if !status.success() {
        return Err("cargo build -p guest-mock-claude failed".into());
    }

    let mock = target_profile_dir.join("guest-mock-claude");
    if !mock.exists() {
        return Err(format!("mock binary not found at {}", mock.display()));
    }
    Ok(mock)
}

/// Configure the process environment for a reap test. Must be called
/// BEFORE any `guest_agent::env::*` accessor — the library's LazyLocks
/// capture these values on first read.
///
/// `prompt` decides which mock-claude test prefix runs:
/// - `@hang-after-result` → SIGTERM path
/// - `@hang-after-result-deaf` → SIGKILL escalation path
/// - `@exit-after-result` → happy path (no signal ever fires)
/// - `@fail-no-newline:<message>` → stderr EOF without trailing newline
/// - `@fail-invalid-utf8` → stderr bytes that are not valid UTF-8
/// - `@fail-invalid-utf8-long` → invalid UTF-8 whose lossy form exceeds the limit
/// - `@stuck-tool-deaf` → forced-termination SIGKILL escalation path
/// - `@stuck-tool-closed-stdout-deaf` → stdout EOF before forced termination
///
/// `sigterm_grace_secs` / `sigkill_grace_secs` control how long the
/// FSM waits before each signal escalation. Signal-exit tests want
/// them small (~1s) for fast convergence; the happy-path test can use
/// a sigterm grace larger than its outer timeout so post-result reap
/// cannot mask the natural clean-exit assertion.
///
/// # Side effects
///
/// - Mutates the process-wide environment (`set_var`).
/// - Mutates the process-wide working directory (`set_current_dir`).
///
/// Call AT MOST ONCE per test binary; calling from multiple `#[test]`s
/// in the same binary races on CWD and on `LazyLock` capture order.
///
/// SAFETY: callers run in a single-test test binary, so no other thread
/// is reading the process env concurrently.
pub unsafe fn setup_env(
    mock_path: &Path,
    workdir: &Path,
    prompt: &str,
    sigterm_grace_secs: u64,
    sigkill_grace_secs: u64,
) -> Result<(), String> {
    unsafe {
        // Route the CLI binary resolution to the cargo-built mock.
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("VM0_MOCK_CLAUDE_PATH", mock_path);
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var(
            "VM0_POST_RESULT_SIGTERM_GRACE_SECS",
            sigterm_grace_secs.to_string(),
        );
        std::env::set_var(
            "VM0_POST_RESULT_SIGKILL_GRACE_SECS",
            sigkill_grace_secs.to_string(),
        );
        // Derive run_id from the test binary's filename (which cargo
        // hashes per target) so the three reap test binaries running
        // concurrently don't collide on the run-scoped files that
        // paths.rs creates.
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "post-result-reap-test".to_string());
        std::env::set_var("VM0_RUN_ID", run_id);
        std::env::set_var("VM0_PROMPT", prompt);
        // Empty API token → has_api() false → no network calls.
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        // Redirect HOME so the mock's session-history write
        // (`$HOME/.claude/projects/.../<session>.jsonl`) stays inside
        // the tempdir and gets cleaned up with it, instead of
        // accumulating in the dev's real ~/.claude on every run.
        std::env::set_var("HOME", workdir);
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}

/// Configure the process environment for one chat-streaming integration test.
/// See `setup_env` for the LazyLock and cwd caveats.
///
/// SAFETY: callers run one scenario per test binary, before any
/// `guest_agent::env::*` accessor can read the process env.
pub unsafe fn setup_chat_stream_env(
    mock_path: &Path,
    workdir: &Path,
    run_id: &str,
    prompt: &str,
    api_url: &str,
    stream_enabled: bool,
    secret_values: Option<&str>,
) -> Result<(), String> {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("VM0_MOCK_CLAUDE_PATH", mock_path);
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var("VM0_POST_RESULT_SIGTERM_GRACE_SECS", "3");
        std::env::set_var("VM0_POST_RESULT_SIGKILL_GRACE_SECS", "1");
        std::env::set_var("VM0_RUN_ID", run_id);
        std::env::set_var("VM0_PROMPT", prompt);
        std::env::set_var("VM0_API_URL", api_url);
        std::env::set_var("VM0_API_TOKEN", "test-token");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::remove_var("VM0_CHAT_STREAM_CHANNEL");
        std::env::remove_var("VM0_CHAT_STREAM_TOPIC");
        std::env::remove_var("VM0_CHAT_STREAM_TOKEN");
        std::env::remove_var("VM0_CHAT_STREAM_ABLY_BASE");
        std::env::remove_var("VM0_SECRET_VALUES");
        if stream_enabled {
            std::env::set_var("VM0_CHAT_STREAM_CHANNEL", "user:user_123");
            std::env::set_var(
                "VM0_CHAT_STREAM_TOPIC",
                format!("chatThreadMessageDelta:{CHAT_STREAM_THREAD_ID}"),
            );
            std::env::set_var("VM0_CHAT_STREAM_TOKEN", "stream-token");
            std::env::set_var("VM0_CHAT_STREAM_ABLY_BASE", api_url);
        }
        if let Some(secret_values) = secret_values {
            std::env::set_var("VM0_SECRET_VALUES", secret_values);
        }
        std::env::set_var("HOME", workdir);
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}

/// Dummy heartbeat that never completes. The CLI-wait / reap-deadline
/// branches of `execute_cli`'s select! loop are the intended exit paths
/// for these tests; a heartbeat failure would go through a different
/// code path entirely.
pub fn spawn_dummy_heartbeat() -> tokio::task::JoinHandle<Result<(), guest_agent::error::AgentError>>
{
    tokio::spawn(std::future::pending())
}
