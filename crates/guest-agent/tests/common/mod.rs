//! Shared setup for CLI forced-termination integration tests.
//!
//! # Why separate test binaries instead of cases in one
//!
//! Many CLI tests mutate process env, current directory, and guest runtime path
//! overrides as setup input. Consolidating scenarios with different prompts or
//! grace windows into one `#[tokio::test]` binary would make those process-wide
//! side effects race. Splitting into separate binaries gives each scenario a
//! fresh process, paid for by a small cargo build-cache hit (idempotent).
//!
//! # Error handling
//!
//! Fallible helpers return `Result<_, String>` and let the test's
//! `#[tokio::test]` body propagate with `?` — clippy's
//! `allow-expect-in-tests` applies to test bodies but not to helpers
//! defined in `tests/common/mod.rs`.

#![allow(dead_code)] // consumed across multiple test binaries

mod system_log;

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use serde_json::{Value, json};
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub type SystemLogOverrideGuard = system_log::SystemLogOverrideGuard;

static UNIQUE_TEMP_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);

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

pub fn unique_temp_path(prefix: &str) -> PathBuf {
    let timestamp_nanos = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos(),
        Err(error) => error.duration().as_nanos(),
    };
    let counter = UNIQUE_TEMP_PATH_COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{timestamp_nanos}-{counter}",
        std::process::id()
    ))
}

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
    paths: guest_agent::paths::GuestPaths,
}

impl RunFilesGuard {
    pub fn new_for_paths(paths: &guest_agent::paths::GuestPaths) -> Self {
        cleanup_run_files_for_paths(paths);
        Self {
            paths: paths.clone(),
        }
    }

    pub fn sandbox_ops_file(&self) -> &str {
        self.paths.sandbox_ops_file()
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files_for_paths(&self.paths);
    }
}

fn cleanup_run_files_for_paths(paths: &guest_agent::paths::GuestPaths) {
    let _ = std::fs::remove_file(paths.agent_log_file());
    let _ = std::fs::remove_file(paths.event_error_flag());
    let _ = std::fs::remove_file(paths.session_id_file());
    let _ = std::fs::remove_file(paths.session_history_path_file());
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
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
    build_and_locate_mock_package("guest-mock-claude", "guest-mock-claude")
}

/// Build the mock Codex binary and resolve its filesystem path beside the
/// current test profile.
pub fn build_and_locate_mock_codex() -> Result<PathBuf, String> {
    build_and_locate_mock_package("guest-mock-codex", "guest-mock-codex")
}

fn build_and_locate_mock_package(package: &str, binary: &str) -> Result<PathBuf, String> {
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
    cmd.args(["build", "-p", package, "--quiet"])
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
        return Err(format!("cargo build -p {package} failed"));
    }

    let mock = target_profile_dir.join(binary);
    if !mock.exists() {
        return Err(format!("mock binary not found at {}", mock.display()));
    }
    Ok(mock)
}

/// Test-specific values for the experimental Codex app-server backend env.
pub struct CodexAppServerEnvConfig<'a> {
    pub run_id: &'a str,
    pub prompt: &'a str,
    pub scenario: Option<&'a str>,
    pub resume_session_id: Option<&'a str>,
}

/// Clear runner/bootstrap environment that could be inherited from a parent
/// runner process. Test setup helpers then write the exact env snapshot they
/// want `GuestRuntime::from_process_env` to capture.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn clear_guest_agent_bootstrap_env_for_test() {
    for key in [
        guest_contracts::env::API_URL_ENV,
        guest_contracts::env::RUN_ID_ENV,
        guest_contracts::env::API_TOKEN_ENV,
        guest_contracts::env::SANDBOX_ID_ENV,
        guest_contracts::env::SANDBOX_REUSE_RESULT_ENV,
        guest_contracts::env::PROMPT_ENV,
        guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
        guest_contracts::env::RESUME_SESSION_ID_ENV,
        guest_contracts::env::API_START_TIME_ENV,
        guest_contracts::env::SECRET_VALUES_ENV,
        guest_contracts::env::DISALLOWED_TOOLS_ENV,
        guest_contracts::env::TOOLS_ENV,
        guest_contracts::env::SETTINGS_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USER_ENV_FILE_ENV,
        guest_contracts::env::ARTIFACTS_ENV,
        guest_contracts::env::FEATURE_FLAGS_ENV,
        guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV,
        guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        guest_contracts::env::POST_RESULT_TOTAL_CAP_SECS_ENV,
        guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV,
        guest_contracts::env::MOCK_CLAUDE_PATH_ENV,
        guest_contracts::env::MOCK_CODEX_PATH_ENV,
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        process_control_ipc::BOOTSTRAP_ENV,
        "MOCK_CODEX_FIXTURE",
        "MOCK_CODEX_APP_SERVER_SCENARIO",
    ] {
        unsafe {
            std::env::remove_var(key);
        }
    }
}

/// Configure one test binary for the experimental Codex app-server backend.
///
/// Must be called before building a `GuestRuntime` because runtime bootstrap
/// captures the process env snapshot.
///
/// # Safety
/// Callers must use this from a single-test integration binary before any other
/// thread reads the process environment.
pub unsafe fn setup_codex_app_server_env(
    mock_path: &Path,
    home: &Path,
    config: CodexAppServerEnvConfig<'_>,
) -> Result<(), String> {
    unsafe {
        clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var("VM0_CODEX_APP_SERVER_BACKEND", "1");
        std::env::set_var("VM0_MOCK_CODEX_PATH", mock_path);
        std::env::set_var("USE_MOCK_CODEX", "true");
        if let Some(scenario) = config.scenario {
            std::env::set_var("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
        } else {
            std::env::remove_var("MOCK_CODEX_APP_SERVER_SCENARIO");
        }
        std::env::set_var("VM0_RUN_ID", config.run_id);
        std::env::set_var("VM0_PROMPT", config.prompt);
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", home);
        if let Some(resume_session_id) = config.resume_session_id {
            std::env::set_var("VM0_RESUME_SESSION_ID", resume_session_id);
        } else {
            std::env::remove_var("VM0_RESUME_SESSION_ID");
        }
    }
    std::fs::create_dir_all(home).map_err(|error| format!("create home: {error}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(home).map_err(|error| format!("set_current_dir: {error}"))?;
    Ok(())
}

pub fn active_input_payload(text: &str) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&json!({
        "type": "active-input",
        "text": text,
    }))
}

pub fn read_codex_session_history_events_for_paths(
    paths: &guest_agent::paths::GuestPaths,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    read_codex_session_history_events_for_path(paths.session_history_path_file())
}

fn read_codex_session_history_events_for_path(
    session_history_path_file: &str,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let history = guest_agent::session_history::read_session_history(session_history_path_file)?;
    let history = String::from_utf8(history)?;
    history
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

/// Configure the process environment for a reap test. Must be called before
/// building a `GuestRuntime` because runtime bootstrap captures the process env
/// snapshot.
///
/// `prompt` decides which mock-claude test prefix runs:
/// - `@hang-after-result` → SIGTERM path
/// - `@hang-after-result-deaf` → SIGKILL escalation path
/// - `@hang-after-result-then-event` → post-result quiet refresh path
/// - `@hang-after-result-periodic-events` → post-result total cap path
/// - `@hang-after-error-result` → error result followed by post-result cleanup
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
/// in the same binary races on CWD and runtime capture order.
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
        clear_guest_agent_bootstrap_env_for_test();
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
        std::env::set_var("VM0_POST_RESULT_TOTAL_CAP_SECS", "60");
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

pub fn spawn_heartbeat_monitor<F>(future: F) -> guest_agent::cli::HeartbeatMonitor
where
    F: std::future::Future<Output = Result<(), guest_agent::error::AgentError>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let task = tokio::spawn(future);
        let status = match task.await {
            Ok(Ok(())) => guest_agent::cli::HeartbeatStatus::Stopped,
            Ok(Err(error)) => guest_agent::cli::HeartbeatStatus::Failed(error),
            Err(error) => guest_agent::cli::HeartbeatStatus::TaskFailed(error.to_string()),
        };
        let _ = tx.send(status);
    });
    Some(rx)
}

/// Dummy heartbeat that never completes. The CLI-wait / reap-deadline
/// branches of `execute_cli`'s select! loop are the intended exit paths
/// for these tests; a heartbeat failure would go through a different
/// code path entirely.
pub fn spawn_dummy_heartbeat() -> guest_agent::cli::HeartbeatMonitor {
    None
}

pub fn guest_runtime_from_process_env() -> Result<guest_agent::run_context::GuestRuntime, String> {
    guest_agent::run_context::GuestRuntime::from_process_env()
}

pub async fn execute_cli_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    execute_cli_with_active_input_for_runtime(
        runtime,
        masker,
        heartbeat,
        active_input.into_writer(),
    )
    .await
}

pub async fn execute_cli_with_active_input_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
    active_input: guest_agent::active_input::ActiveInputWriter,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    guest_agent::cli::execute_cli_with_active_input_for_config(
        masker,
        heartbeat,
        runtime.http.clone(),
        active_input,
        &runtime.config,
        &runtime.paths,
    )
    .await
}

pub async fn wait_for_path(path: &Path, timeout: Duration) -> io::Result<()> {
    tokio::time::timeout(timeout, wait_for_path_event(path))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out waiting for {}", path.display()),
            )
        })?
}

async fn wait_for_path_event(path: &Path) -> io::Result<()> {
    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;

    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let async_fd = async_inotify_fd(inotify)?;
    loop {
        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        if tokio::fs::try_exists(path).await? {
            return Ok(());
        }
    }
}

fn async_inotify_fd(inotify: Inotify) -> io::Result<AsyncFd<OwnedFd>> {
    let fd: OwnedFd = inotify.into();
    AsyncFd::new(fd).map_err(|error| io::Error::other(format!("AsyncFd: {error}")))
}

fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: fd is a valid non-blocking inotify descriptor borrowed from
        // AsyncFd. The stack buffer is valid for the requested byte length.
        let result = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}
