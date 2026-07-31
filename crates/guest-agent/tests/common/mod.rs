//! Shared setup for CLI integration tests.
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
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

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

pub const MOCK_TERMINATION_READY_EVENT: &str = "vm0_mock_termination_ready";
pub const MOCK_POST_RESULT_READY_EVENT: &str = "vm0_mock_post_result_ready";
pub const MOCK_POST_RESULT_ACTIVITY_ONE_EVENT: &str = "vm0_mock_post_result_activity_1_ready";
pub const MOCK_POST_RESULT_ACTIVITY_TWO_EVENT: &str = "vm0_mock_post_result_activity_2_ready";
pub const MOCK_POST_RESULT_LIVENESS_EVENT: &str = "vm0_mock_post_result_stale_deadline_survived";
pub const MOCK_POST_RESULT_RELEASE_ONE_SOCKET: &str = ".vm0-post-result-release-1.sock";
pub const MOCK_POST_RESULT_RELEASE_TWO_SOCKET: &str = ".vm0-post-result-release-2.sock";

/// Documented maximum number of stderr lines returned in
/// `guest_agent::cli::CliExecutionResult`.
pub const CLI_STDERR_RESULT_MAX_LINES: usize = 200;

/// Documented maximum byte length for one returned stderr line after CRLF normalization.
pub const CLI_STDERR_RESULT_MAX_LINE_BYTES: usize = 16 * 1024;

/// Integration contract for one accepted ordinary CLI stdout record.
pub const CLI_STDOUT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

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
    pub content_type: Option<String>,
    pub client_request_id: Option<String>,
    pub body: String,
}

pub fn event_request_sequences(request: &RecordedRequest) -> Result<Vec<u32>, String> {
    let body: Value = serde_json::from_str(&request.body)
        .map_err(|error| format!("parse event request body: {error}"))?;
    body.get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "event request omitted events array".to_string())?
        .iter()
        .map(|event| {
            event
                .get("sequenceNumber")
                .and_then(Value::as_u64)
                .and_then(|sequence| u32::try_from(sequence).ok())
                .ok_or_else(|| "event omitted a u32 sequenceNumber".to_string())
        })
        .collect()
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

pub struct ControlledRequest {
    pub request: RecordedRequest,
    response: oneshot::Sender<u16>,
}

impl ControlledRequest {
    pub fn respond(self, status: u16) -> Result<(), String> {
        self.response
            .send(status)
            .map_err(|_| "controlled HTTP request closed before response".to_string())
    }
}

pub struct ControlledHttpServer {
    pub base_url: String,
    requests: Arc<AtomicUsize>,
    completed_responses: Arc<AtomicUsize>,
    recorded_requests: Arc<Mutex<Vec<RecordedRequest>>>,
    request_rx: mpsc::UnboundedReceiver<ControlledRequest>,
    handle: tokio::task::JoinHandle<()>,
}

impl ControlledHttpServer {
    pub async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("bind controlled HTTP server: {error}"))?;
        let addr = listener
            .local_addr()
            .map_err(|error| format!("controlled HTTP server local_addr: {error}"))?;
        let requests = Arc::new(AtomicUsize::new(0));
        let task_requests = Arc::clone(&requests);
        let completed_responses = Arc::new(AtomicUsize::new(0));
        let task_completed_responses = Arc::clone(&completed_responses);
        let recorded_requests = Arc::new(Mutex::new(Vec::new()));
        let task_recorded_requests = Arc::clone(&recorded_requests);
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _peer)) = listener.accept().await {
                let connection_tx = request_tx.clone();
                let connection_requests = Arc::clone(&task_requests);
                let connection_completed_responses = Arc::clone(&task_completed_responses);
                let connection_recorded_requests = Arc::clone(&task_recorded_requests);
                tokio::spawn(async move {
                    let Ok(request) = read_http_request(&mut socket).await else {
                        let _ = write_http_response(&mut socket, 400).await;
                        return;
                    };
                    connection_requests.fetch_add(1, Ordering::SeqCst);
                    if let Ok(mut requests) = connection_recorded_requests.lock() {
                        requests.push(request.clone());
                    }
                    let (response, response_rx) = oneshot::channel();
                    if connection_tx
                        .send(ControlledRequest { request, response })
                        .is_err()
                    {
                        return;
                    }
                    let Ok(status) = response_rx.await else {
                        return;
                    };
                    let _ = write_http_response(&mut socket, status).await;
                    connection_completed_responses.fetch_add(1, Ordering::SeqCst);
                });
            }
        });

        Ok(Self {
            base_url: format!("http://{addr}"),
            requests,
            completed_responses,
            recorded_requests,
            request_rx,
            handle,
        })
    }

    pub async fn next_request(&mut self, timeout: Duration) -> Result<ControlledRequest, String> {
        tokio::time::timeout(timeout, self.request_rx.recv())
            .await
            .map_err(|_| format!("controlled HTTP server received no request within {timeout:?}"))?
            .ok_or_else(|| "controlled HTTP server stopped accepting requests".to_string())
    }

    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn completed_response_count(&self) -> usize {
        self.completed_responses.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Result<Vec<RecordedRequest>, String> {
        self.recorded_requests
            .lock()
            .map(|requests| requests.clone())
            .map_err(|_| "controlled HTTP request mutex poisoned".to_string())
    }
}

impl Drop for ControlledHttpServer {
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
    let mut content_type = None;
    let mut client_request_id = None;
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
        if trimmed_name.eq_ignore_ascii_case("content-type") {
            content_type = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("x-client-request-id") {
            client_request_id = Some(trimmed_value.to_string());
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
        content_type,
        client_request_id,
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

    let mock = target_profile_dir.join(binary);
    let workspace_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "guest-agent workspace directory".to_string())?;
    let package_dir = workspace_dir.join(package);
    let fingerprint = mock_fingerprint(&package_dir, profile_dir_name)?;
    let marker = target_dir.join(format!(".vm0-{package}-{profile_dir_name}.fingerprint"));
    let lock = target_dir.join(format!(".vm0-{package}-{profile_dir_name}.lock"));

    while std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .is_err()
    {
        if std::fs::metadata(&lock)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(600))
        {
            let _ = std::fs::remove_file(&lock);
            continue;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let result = (|| {
        if mock.exists() && std::fs::read_to_string(&marker).ok().as_deref() == Some(&fingerprint) {
            return Ok(mock.clone());
        }

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
        if !mock.exists() {
            return Err(format!("mock binary not found at {}", mock.display()));
        }
        std::fs::write(&marker, fingerprint).map_err(|e| format!("write mock fingerprint: {e}"))?;
        Ok(mock.clone())
    })();
    let _ = std::fs::remove_file(lock);
    result
}

fn mock_fingerprint(package_dir: &Path, profile: &str) -> Result<String, String> {
    let mut files = Vec::new();
    collect_files(package_dir, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    hasher.update(profile.as_bytes());
    for path in files {
        hasher.update(
            path.strip_prefix(package_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .as_bytes(),
        );
        hasher.update(std::fs::read(&path).map_err(|e| format!("read mock source: {e}"))?);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read mock package: {e}"))? {
        let path = entry
            .map_err(|e| format!("read mock package entry: {e}"))?
            .path();
        if path.file_name().is_some_and(|name| name == "target") {
            continue;
        }
        if path.is_dir() {
            collect_files(&path, files)?;
        } else {
            files.push(path);
        }
    }
    Ok(())
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
        guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        guest_contracts::env::SECRET_VALUES_ENV,
        guest_contracts::env::DISALLOWED_TOOLS_ENV,
        guest_contracts::env::TOOLS_ENV,
        guest_contracts::env::SETTINGS_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USER_ENV_FILE_ENV,
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
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

pub fn write_run_payload_file_for_test(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<std::path::PathBuf, String> {
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create run payload dir: {error}"))?;
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let bytes =
        serde_json::to_vec(payload).map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write run payload: {error}"))?;
    Ok(path)
}

/// Write the runner-owned run payload file and expose it through process env.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn set_run_payload_file_env_for_test(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<(), String> {
    let path = write_run_payload_file_for_test(runtime_dir, payload)?;
    unsafe {
        std::env::set_var(guest_contracts::env::RUN_PAYLOAD_FILE_ENV, path);
    }
    Ok(())
}

/// Write model-provider/user environment and expose it through process env.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn set_user_env_file_env_for_test(
    runtime_dir: &Path,
    user_env: &HashMap<String, String>,
) -> Result<(), String> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create user env dir: {error}"))?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let bytes =
        serde_json::to_vec(user_env).map_err(|error| format!("serialize user env: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write user env: {error}"))?;
    unsafe {
        std::env::set_var(guest_contracts::env::USER_ENV_FILE_ENV, path);
    }
    Ok(())
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
        std::env::set_var("VM0_API_BACKEND_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", home);
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(home, config.run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: config.prompt.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
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

/// Configure the process environment for one mock-Claude CLI integration-test
/// binary. Must be called before building a `GuestRuntime` because runtime
/// bootstrap captures the process env snapshot.
///
/// `prompt` is interpreted by `guest-mock-claude`. See the module documentation
/// in `crates/guest-mock-claude/src/main.rs` for the complete special-prefix
/// catalog and `SCENARIO_RULES` in
/// `crates/guest-mock-claude/src/scenario.rs` for authoritative matching
/// behavior. Prompts that match no special rule use ordinary shell behavior.
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
        // hashes per target) so concurrently running integration-test
        // binaries don't collide on the run-scoped files that paths.rs
        // creates.
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "post-result-reap-test".to_string());
        std::env::set_var("VM0_RUN_ID", &run_id);
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(workdir, &run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: prompt.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        // Empty API token → has_api() false → no network calls.
        std::env::set_var("VM0_API_BACKEND_URL", "http://127.0.0.1:1");
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

pub async fn execute_cli_with_cancellation_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    guest_agent::cli::execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat,
        runtime.http.clone(),
        guest_agent::cli::CliExecutionControls::new(active_input.into_writer(), cancellation),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    )
    .await
}

pub struct VirtualTimeCheckpoint<'a> {
    file: &'a str,
    needle: &'a str,
    advance: Duration,
    release_socket: Option<&'a Path>,
}

impl<'a> VirtualTimeCheckpoint<'a> {
    pub fn new(file: &'a str, needle: &'a str, advance: Duration) -> Self {
        Self {
            file,
            needle,
            advance,
            release_socket: None,
        }
    }

    pub fn release_after_advance(mut self, release_socket: &'a Path) -> Self {
        self.release_socket = Some(release_socket);
        self
    }
}

pub async fn execute_with_virtual_time_checkpoints<F>(
    future: F,
    checkpoints: &[VirtualTimeCheckpoint<'_>],
) -> Result<F::Output, String>
where
    F: Future,
{
    for checkpoint in checkpoints {
        guest_agent::paths::ensure_parent_dir(checkpoint.file).map_err(|error| {
            format!(
                "prepare parent directory for virtual-time checkpoint {}: {error}",
                checkpoint.file
            )
        })?;
    }

    tokio::pin!(future);
    for (index, checkpoint) in checkpoints.iter().enumerate() {
        tokio::select! {
            _ = &mut future => {
                return Err(format!(
                    "CLI execution completed before {:?} appeared in {}",
                    checkpoint.needle, checkpoint.file
                ));
            }
            ready = wait_for_file_contains(
                Path::new(checkpoint.file),
                checkpoint.needle,
                Duration::from_secs(5),
            ) => {
                ready.map_err(|error| {
                    format!(
                        "wait for {:?} in {} before advancing time: {error}",
                        checkpoint.needle, checkpoint.file
                    )
                })?;
            }
        }

        tokio::time::pause();
        tokio::time::advance(checkpoint.advance).await;

        let execution_poll =
            std::future::poll_fn(|context| Poll::Ready(future.as_mut().poll(context))).await;
        let release_result = if matches!(&execution_poll, Poll::Pending)
            && let Some(release_socket) = checkpoint.release_socket
        {
            UnixStream::connect(release_socket)
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "release virtual-time checkpoint through {}: {error}",
                        release_socket.display()
                    )
                })
        } else {
            Ok(())
        };
        tokio::time::resume();
        release_result?;

        if let Poll::Ready(output) = execution_poll {
            if index + 1 == checkpoints.len() && checkpoint.release_socket.is_none() {
                return Ok(output);
            }
            return Err(format!(
                "CLI execution completed after advancing time for {:?} before all checkpoint stages finished",
                checkpoint.needle
            ));
        }
    }

    Ok(future.await)
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

pub async fn wait_for_file_contains(
    path: &Path,
    needle: &str,
    timeout: Duration,
) -> io::Result<()> {
    tokio::time::timeout(
        timeout,
        wait_for_file_contains_event(path, needle.as_bytes()),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "timed out waiting for {} to contain {needle:?}",
                path.display()
            ),
        )
    })?
}

async fn wait_for_file_contains_event(path: &Path, needle: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(
            dir,
            AddWatchFlags::IN_CREATE
                | AddWatchFlags::IN_MODIFY
                | AddWatchFlags::IN_MOVED_TO
                | AddWatchFlags::IN_CLOSE_WRITE,
        )
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;
    let async_fd = async_inotify_fd(inotify)?;

    loop {
        match tokio::fs::read(path).await {
            Ok(contents) if find_subsequence(&contents, needle).is_some() => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();
    }
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
