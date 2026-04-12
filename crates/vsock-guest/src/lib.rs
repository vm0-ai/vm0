//! Vsock Guest library for Firecracker VM host-guest communication.
//!
//! This library provides the core functionality for host-guest IPC via vsock
//! or Unix sockets. It can be used standalone or embedded in other binaries
//! like guest-init.
//!
//! Protocol encoding/decoding is handled by the `vsock-proto` crate.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, MSG_ERROR, MSG_EXEC, MSG_EXEC_RESULT, MSG_PING, MSG_PONG, MSG_PROCESS_EXIT, MSG_READY,
    MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK,
    MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, ProtocolError, RawMessage,
};

/// Flag indicating shutdown was received (don't reconnect after shutdown).
///
/// Process-level static: safe because integration tests use `handle_connection` per-thread
/// (not `run()`), and each test gets its own connection. Only `run()` reads this flag.
static SHUTDOWN_RECEIVED: AtomicBool = AtomicBool::new(false);

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB

/// Exit code returned when command times out (same as bash/Python)
const EXIT_CODE_TIMEOUT: i32 = 124;

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;

/// Buffer size for reading stdout chunks from a spawned process.
const STDOUT_CHUNK_SIZE: usize = 8 * 1024;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// `send_process_exit()` anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
const STDOUT_DRAIN_DEADLINE_SECS: u64 = 5;

/// Convert a ProtocolError to an io::Error
fn to_io_error(e: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Get the user to execute commands as
/// - Debug builds: None (run as current user via sh -c)
/// - Release builds: Some("user") (run as user via su - user -c)
///
/// The rootfs must have the "user" account (UID 1000) configured with passwordless sudo.
/// See: crates/runner/scripts/build-rootfs.sh for user account setup.
fn get_exec_user() -> Option<&'static str> {
    #[cfg(debug_assertions)]
    {
        None
    }

    #[cfg(not(debug_assertions))]
    {
        // Default user for command execution (UID 1000, matching E2B sandbox)
        Some("user")
    }
}

/// Shell-escape a value by wrapping in single quotes and escaping embedded `'`.
fn shell_escape_value(val: &str) -> String {
    format!("'{}'", val.replace('\'', "'\\''"))
}

/// Prepend environment variable exports to a command string.
///
/// Returns the command unchanged when `env` is empty. Otherwise produces
/// `export KEY='value' KEY2='value2'; command` so the variables are
/// available for shell expansion in the command.
fn prepend_env(command: &str, env: &[(&str, &str)]) -> String {
    if env.is_empty() {
        return command.to_string();
    }
    let mut parts = String::from("export ");
    for (i, (key, val)) in env.iter().enumerate() {
        if i > 0 {
            parts.push(' ');
        }
        parts.push_str(key);
        parts.push('=');
        parts.push_str(&shell_escape_value(val));
    }
    parts.push_str("; ");
    parts.push_str(command);
    parts
}

/// Build a Command to execute a shell command as the appropriate user.
///
/// When `sudo` is true the command runs as root, bypassing `su - user` and
/// the PAM overhead that comes with it.
///
/// In release builds the guest-init process is already root, so `sh -c`
/// suffices. In debug builds the process is a normal user, so `sudo sh -c`
/// is needed to elevate.
fn build_exec_command(command: &str, sudo: bool) -> Command {
    match get_exec_user() {
        Some(user) => {
            if sudo {
                // Release: already root — run directly
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("su");
                c.arg("-").arg(user).arg("-c").arg(command);
                c
            }
        }
        None => {
            if sudo {
                // Debug: not root — elevate with sudo
                let mut c = Command::new("sudo");
                c.arg("sh").arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            }
        }
    }
}

/// Truncate a command string for logging, preserving UTF-8 boundaries
fn truncate_preview(s: &str) -> String {
    if s.len() <= COMMAND_PREVIEW_MAX_LEN {
        return s.to_string();
    }
    // Find a safe UTF-8 boundary at or before the max length
    let end = s
        .char_indices()
        .take_while(|(i, _)| *i < COMMAND_PREVIEW_MAX_LEN)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(COMMAND_PREVIEW_MAX_LEN);
    format!("{}...", &s[..end])
}

/// Extract exit code from ExitStatus, mapping signals to 128 + signal number
#[cfg(unix)]
fn extract_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| status.signal().map(|sig| 128 + sig).unwrap_or(1))
}

#[cfg(not(unix))]
fn extract_exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Log a message to stderr
pub fn log(level: &str, msg: &str) {
    eprintln!("[vsock-guest] [{level}] {msg}");
}

/// Run a child process with timeout. Returns (exit_code, stdout, stderr).
/// Returns exit code 124 on timeout (same as bash timeout command).
fn wait_with_timeout(child: std::process::Child, timeout_ms: u32) -> (i32, Vec<u8>, Vec<u8>) {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    let timeout = Duration::from_millis(timeout_ms as u64);
    let child_id = child.id();

    // Track if WE sent the kill (to distinguish from external SIGKILL)
    let killed_by_timeout = Arc::new(AtomicBool::new(false));
    let killed_by_timeout_clone = Arc::clone(&killed_by_timeout);

    // Channel to signal when process completes
    let (tx, rx) = mpsc::channel::<()>();

    // Spawn a thread that will kill the process after timeout
    thread::spawn(move || {
        // Wait for either timeout or signal that process completed
        if rx.recv_timeout(timeout).is_err() {
            // Timeout reached — kill the entire process group.
            // SAFETY: child_id is a valid PID from Command::spawn (Linux PIDs < 4M,
            // so u32→i32 cast never overflows). Negative pid kills the process group.
            let ret = unsafe { libc::kill(-(child_id as i32), libc::SIGKILL) };
            if ret == 0 {
                killed_by_timeout_clone.store(true, Ordering::SeqCst);
            } else {
                let err = std::io::Error::last_os_error();
                log(
                    "WARN",
                    &format!("timeout kill(-{child_id}, SIGKILL) failed: {err}"),
                );
            }
        }
    });

    // Wait for the process to complete
    let output = child.wait_with_output();

    // Signal that process completed (killer thread will exit)
    let _ = tx.send(());

    match output {
        Ok(output) => {
            // Check if process was killed by OUR timeout (not external SIGKILL)
            if killed_by_timeout.load(Ordering::SeqCst) {
                return (EXIT_CODE_TIMEOUT, output.stdout, b"Timeout".to_vec());
            }
            (
                extract_exit_code(output.status),
                output.stdout,
                output.stderr,
            )
        }
        Err(e) => (1, Vec::new(), format!("Failed to wait: {}", e).into_bytes()),
    }
}

/// Handle exec message
fn handle_exec(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> (i32, Vec<u8>, Vec<u8>) {
    log(
        "INFO",
        &format!(
            "exec: {} (timeout={}ms, sudo={}, env_count={})",
            truncate_preview(command),
            timeout_ms,
            sudo,
            env.len(),
        ),
    );
    let command = prepend_env(command, env);

    // Create new process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        build_exec_command(&command, sudo)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
    };
    #[cfg(not(unix))]
    let child = build_exec_command(&command, sudo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match child {
        Ok(child) => {
            let result = wait_with_timeout(child, timeout_ms);
            log(
                "INFO",
                &format!(
                    "exec result: exit_code={}, stdout_len={}, stderr_len={}",
                    result.0,
                    result.1.len(),
                    result.2.len()
                ),
            );
            result
        }
        Err(e) => (
            1,
            Vec::new(),
            format!("Failed to execute: {}", e).into_bytes(),
        ),
    }
}

/// Handle write_file message
fn handle_write_file(path: &str, content: &[u8], use_sudo: bool) -> (bool, String) {
    log(
        "INFO",
        &format!(
            "write_file: path={} size={} sudo={}",
            path,
            content.len(),
            use_sudo
        ),
    );

    // Execute as 'user' (UID 1000) to match E2B sandbox behavior
    // Use subprocess instead of direct fs::write to run as user
    const WRITE_TIMEOUT_MS: u32 = 30_000;

    // Build the write command: tee for privileged writes (build_exec_command
    // handles root elevation), cat for normal writes with parent dir creation.
    let write_cmd = if use_sudo {
        format!("tee '{}'", path.replace('\'', "'\\''"))
    } else {
        // Create parent directory if needed, then write
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                format!(
                    "mkdir -p '{}' && cat > '{}'",
                    parent.display().to_string().replace('\'', "'\\''"),
                    path.replace('\'', "'\\''")
                )
            } else {
                format!("cat > '{}'", path.replace('\'', "'\\''"))
            }
        } else {
            format!("cat > '{}'", path.replace('\'', "'\\''"))
        }
    };

    let mut child = match build_exec_command(&write_cmd, use_sudo)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn write command: {}", e)),
    };

    // Write content to stdin and close it
    if let Some(mut stdin) = child.stdin.take()
        && let Err(e) = stdin.write_all(content)
    {
        let _ = child.kill();
        let _ = child.wait(); // Prevent zombie process
        return (false, format!("Failed to write to stdin: {}", e));
    }
    // stdin is dropped here, closing the pipe

    // Wait with timeout
    let (exit_code, _, stderr) = wait_with_timeout(child, WRITE_TIMEOUT_MS);
    if exit_code == EXIT_CODE_TIMEOUT {
        return (false, "write timed out".to_string());
    }
    if exit_code != 0 {
        let stderr_str = String::from_utf8_lossy(&stderr);
        return (false, format!("write failed: {}", stderr_str));
    }
    (true, String::new())
}

/// Handle shutdown message - sync filesystems and acknowledge
fn handle_shutdown(seq: u32) -> io::Result<Vec<u8>> {
    log("INFO", "Shutdown requested, syncing filesystems...");
    // SAFETY: libc::sync() has no preconditions — it flushes all pending filesystem writes.
    unsafe {
        libc::sync();
    }
    log("INFO", "Sync complete");
    // Set flag so run() knows not to reconnect after connection closes
    SHUTDOWN_RECEIVED.store(true, Ordering::SeqCst);
    vsock_proto::encode(MSG_SHUTDOWN_ACK, seq, &[]).map_err(to_io_error)
}

/// Handle spawn_watch message - spawn process and monitor in background.
///
/// Returns immediate acknowledgment with PID, then sends process_exit when done.
///
/// When `stdout_log_path` is `Some`, stdout is streamed to the host via
/// `MSG_STDOUT_CHUNK` messages AND teed to the specified file path inside the VM.
/// Handle spawn_watch: spawn the child, write the response over the wire,
/// THEN start the background monitor. This ordering is critical — the
/// streaming monitor thread also writes to the same socket (via the shared
/// `writer` mutex), and `MSG_STDOUT_CHUNK` messages must not arrive at the
/// host before the `MSG_SPAWN_WATCH_RESULT` for this pid. If the monitor
/// thread were spawned first, it could race the main thread for the mutex
/// and send chunks before the result, causing the host to drop them (the
/// host only registers the stdout channel when it processes the result).
fn handle_spawn_watch(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    stdout_log_path: Option<&str>,
    seq: u32,
    writer: Arc<Mutex<UnixStream>>,
) -> io::Result<()> {
    log(
        "INFO",
        &format!(
            "spawn_watch: {} (timeout={}ms, sudo={}, env_count={}, stream={})",
            truncate_preview(command),
            timeout_ms,
            sudo,
            env.len(),
            stdout_log_path.is_some(),
        ),
    );
    let command = prepend_env(command, env);

    // Create new process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        build_exec_command(&command, sudo)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
    };
    #[cfg(not(unix))]
    let child = build_exec_command(&command, sudo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match child {
        Ok(mut child) => {
            let pid = child.id();
            log("INFO", &format!("spawn_watch: started pid={}", pid));

            // Write the response BEFORE spawning the monitor thread.
            // The monitor thread contends for the same writer mutex to send
            // stdout chunks / process_exit. Writing here guarantees the
            // spawn_watch_result is on the wire first.
            let payload = vsock_proto::encode_spawn_watch_result(pid);
            let response =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, seq, &payload).map_err(to_io_error)?;
            {
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                w.write_all(&response)?;
            }

            if let Some(log_path) = stdout_log_path {
                // Streaming mode: tee stdout to log file + vsock chunks.
                // Take stdout from child so we can read it in a separate thread.
                let stdout_pipe = child.stdout.take();
                spawn_streaming_monitor(
                    pid,
                    child,
                    timeout_ms,
                    stdout_pipe,
                    log_path.to_owned(),
                    writer,
                );
            } else {
                // Buffered mode: no streaming, collect stdout at exit.
                spawn_buffered_monitor(pid, child, timeout_ms, writer);
            }

            Ok(())
        }
        Err(e) => {
            let payload = vsock_proto::encode_error(&format!("Failed to spawn: {}", e));
            let response = vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
            let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
            w.write_all(&response)?;
            Ok(())
        }
    }
}

/// Streaming monitor: reads stdout in chunks (tees to file + vsock), races
/// stdout/stderr reading against child exit, then sends process_exit.
///
/// Architecture:
/// - Timeout killer thread: kills process group after deadline
/// - Stderr reader thread: drains stderr, sends result via channel
/// - Stdout reader thread: streams chunks to log + vsock, signals via channel
/// - Monitor thread: waits for `child.wait()`, then applies drain deadline
///
/// If the child exits but orphaned processes hold pipe fds open, stdout/stderr
/// threads may block past the drain deadline. The monitor thread proceeds to
/// `send_process_exit()` regardless after `STDOUT_DRAIN_DEADLINE_SECS`.
fn spawn_streaming_monitor(
    pid: u32,
    mut child: std::process::Child,
    timeout_ms: u32,
    stdout_pipe: Option<std::process::ChildStdout>,
    log_path: String,
    writer: Arc<Mutex<UnixStream>>,
) {
    thread::spawn(move || {
        // Set up timeout BEFORE the stdout loop — if the process runs past the
        // deadline it must be killed even while we are still reading output.
        let child_id = child.id();
        let killed_by_timeout = Arc::new(AtomicBool::new(false));
        let timeout_done_tx = if timeout_ms > 0 {
            let killed_clone = Arc::clone(&killed_by_timeout);
            let timeout = Duration::from_millis(timeout_ms as u64);
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            thread::spawn(move || {
                if rx.recv_timeout(timeout).is_err() {
                    // SAFETY: child_id is a valid PID. Negative pid kills the process group.
                    let ret = unsafe { libc::kill(-(child_id as i32), libc::SIGKILL) };
                    if ret == 0 {
                        killed_clone.store(true, Ordering::SeqCst);
                    } else {
                        let err = std::io::Error::last_os_error();
                        log(
                            "WARN",
                            &format!("timeout kill(-{child_id}, SIGKILL) failed: {err}"),
                        );
                    }
                }
            });
            Some(tx)
        } else {
            None
        };

        // Drain stderr in a background thread BEFORE the stdout reader.
        // If we waited until after, a child producing >64KB of stderr could
        // fill the pipe buffer and block — preventing further stdout writes
        // and causing our stdout read loop to hang (deadlock).
        // Uses a channel instead of JoinHandle::join() for timed drain.
        let (stderr_tx, stderr_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = io::BufReader::new(stderr).read_to_end(&mut buf);
                let _ = stderr_tx.send(buf);
            });
        } else {
            drop(stderr_tx);
        }

        // Stream stdout to file + vsock in a dedicated thread.
        // Previously this was an inline loop that blocked child.wait() —
        // if orphaned processes held the stdout fd, the monitor hung forever.
        let (stdout_tx, stdout_rx) = std::sync::mpsc::channel::<()>();
        if let Some(mut stdout) = stdout_pipe {
            let stdout_writer = Arc::clone(&writer);
            thread::spawn(move || {
                let log_file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path);
                let mut log_file = match log_file {
                    Ok(f) => Some(f),
                    Err(e) => {
                        log(
                            "WARN",
                            &format!("spawn_watch: failed to open log file {}: {}", log_path, e),
                        );
                        None
                    }
                };

                let mut buf = [0u8; STDOUT_CHUNK_SIZE];
                loop {
                    let n = match stdout.read(&mut buf) {
                        Ok(0) => break, // EOF
                        Ok(n) => n,
                        Err(e) => {
                            log("WARN", &format!("spawn_watch: stdout read error: {}", e));
                            break;
                        }
                    };
                    let chunk = match buf.get(..n) {
                        Some(c) => c,
                        None => break,
                    };

                    // Write to log file (best-effort)
                    if let Some(ref mut f) = log_file {
                        let _ = f.write_all(chunk);
                    }

                    // Send chunk via vsock (best-effort)
                    let payload = vsock_proto::encode_stdout_chunk(pid, chunk);
                    if let Ok(msg) = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, &payload) {
                        let mut w = stdout_writer.lock().unwrap_or_else(|e| e.into_inner());
                        if let Err(e) = w.write_all(&msg) {
                            log(
                                "WARN",
                                &format!("spawn_watch: failed to send stdout chunk: {}", e),
                            );
                            break;
                        }
                    }
                }
                let _ = stdout_tx.send(());
            });
        } else {
            drop(stdout_tx);
        }

        // child.wait() is now UNBLOCKED — no pipe fds held by this thread.
        let status = child.wait();

        // Signal timeout thread that process completed.
        // Must send() not drop — dropping disconnects the channel, which
        // recv_timeout treats as an error and would fire the killer.
        if let Some(tx) = timeout_done_tx {
            let _ = tx.send(());
        }

        // Shared drain deadline: stdout + stderr share a single budget.
        // This matches guest-agent's 5s drain behavior.
        let deadline = std::time::Instant::now() + Duration::from_secs(STDOUT_DRAIN_DEADLINE_SECS);

        // Drain stdout — wait up to deadline
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if stdout_rx.recv_timeout(remaining).is_err() {
            log(
                "WARN",
                &format!(
                    "spawn_watch: pid={pid} stdout drain deadline reached after \
                     {STDOUT_DRAIN_DEADLINE_SECS}s, possible orphaned child process",
                ),
            );
        }

        // Drain stderr — use remaining time from same deadline
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let stderr = stderr_rx.recv_timeout(remaining).unwrap_or_default();

        let (exit_code, stderr) = if killed_by_timeout.load(Ordering::SeqCst) {
            (EXIT_CODE_TIMEOUT, b"Timeout".to_vec())
        } else {
            match status {
                Ok(s) => (extract_exit_code(s), stderr),
                Err(e) => (1, format!("Failed to wait: {}", e).into_bytes()),
            }
        };

        log(
            "INFO",
            &format!(
                "spawn_watch: pid={} exited with code={}, stderr_len={} (streamed)",
                pid,
                exit_code,
                stderr.len()
            ),
        );

        send_process_exit(pid, exit_code, &[], &stderr, &writer);
    });
}

/// Buffered monitor: waits for process exit, collects stdout/stderr at once.
fn spawn_buffered_monitor(
    pid: u32,
    child: std::process::Child,
    timeout_ms: u32,
    writer: Arc<Mutex<UnixStream>>,
) {
    thread::spawn(move || {
        let result = if timeout_ms > 0 {
            wait_with_timeout(child, timeout_ms)
        } else {
            match child.wait_with_output() {
                Ok(output) => (
                    extract_exit_code(output.status),
                    output.stdout,
                    output.stderr,
                ),
                Err(e) => (1, Vec::new(), format!("Failed to wait: {}", e).into_bytes()),
            }
        };

        log(
            "INFO",
            &format!(
                "spawn_watch: pid={} exited with code={}, stdout_len={}, stderr_len={}",
                pid,
                result.0,
                result.1.len(),
                result.2.len()
            ),
        );

        send_process_exit(pid, result.0, &result.1, &result.2, &writer);
    });
}

/// Send a process_exit notification over vsock (best-effort).
fn send_process_exit(
    pid: u32,
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
    writer: &Arc<Mutex<UnixStream>>,
) {
    let payload = vsock_proto::encode_process_exit(pid, exit_code, stdout, stderr);
    let exit_msg = match vsock_proto::encode(MSG_PROCESS_EXIT, 0, &payload) {
        Ok(msg) => msg,
        Err(e) => {
            log("ERROR", &format!("Failed to encode process_exit: {}", e));
            return;
        }
    };
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = w.write_all(&exit_msg) {
        log("ERROR", &format!("Failed to send process_exit: {}", e));
    }
}

/// Handle incoming message and return response.
///
/// `MSG_EXEC` and `MSG_SPAWN_WATCH` are handled separately in
/// `handle_connection` because they run in background threads.
fn handle_message(msg: &RawMessage) -> io::Result<Option<Vec<u8>>> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(Some(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_WRITE_FILE => {
            let (path, content, use_sudo) =
                vsock_proto::decode_write_file(&msg.payload).map_err(to_io_error)?;
            let (success, error) = handle_write_file(path, content, use_sudo);
            let payload = vsock_proto::encode_write_file_result(success, &error);
            Ok(Some(
                vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload)
                    .map_err(to_io_error)?,
            ))
        }
        MSG_SHUTDOWN => Ok(Some(handle_shutdown(msg.seq)?)),
        _ => {
            let payload =
                vsock_proto::encode_error(&format!("Unknown message type: 0x{:02X}", msg.msg_type));
            Ok(Some(
                vsock_proto::encode(MSG_ERROR, msg.seq, &payload).map_err(to_io_error)?,
            ))
        }
    }
}

/// Connect to vsock (Linux only - this binary runs inside Firecracker VM)
#[cfg(target_os = "linux")]
pub fn connect_vsock() -> io::Result<UnixStream> {
    use std::os::unix::io::FromRawFd;

    // SAFETY: Creating a vsock socket with valid constants. fd is checked for errors below.
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: vsock_proto::VSOCK_PORT,
        svm_cid: VSOCK_CID_HOST,
        svm_zero: [0; 4],
    };

    // SAFETY: fd is a valid socket from above, addr is properly initialized, and
    // size_of returns the correct sockaddr_vm size. Errors are checked below.
    let ret = unsafe {
        libc::connect(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as u32,
        )
    };

    if ret < 0 {
        // SAFETY: fd is a valid open socket descriptor, and we're about to return an error.
        unsafe { libc::close(fd) };
        return Err(io::Error::last_os_error());
    }

    // SAFETY: fd is a valid, connected socket descriptor. Ownership transfers to UnixStream.
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}

/// Stub for non-Linux platforms (for IDE support)
#[cfg(not(target_os = "linux"))]
pub fn connect_vsock() -> io::Result<UnixStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "vsock is only supported on Linux",
    ))
}

/// Connect to Unix socket (for testing)
pub fn connect_unix(path: &str) -> io::Result<UnixStream> {
    UnixStream::connect(path)
}

/// Handle connection - the main event loop
/// Uses separate reader/writer to avoid deadlock between main loop and background threads
pub fn handle_connection(stream: UnixStream) -> io::Result<()> {
    // Clone the stream to get separate reader and writer
    // This avoids deadlock: reader can block while writer sends process_exit
    let mut reader = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));

    let mut decoder = vsock_proto::Decoder::new();

    // Send ready signal
    {
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).map_err(to_io_error)?;
        // Recover from poisoned mutex: prefer sending ready over propagating a
        // panic from an unrelated thread.
        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(&ready)?;
    }
    log("INFO", "Sent ready signal");

    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        // Read from stream (reader is separate, no lock needed)
        let n = reader.read(&mut buf)?;

        if n == 0 {
            break;
        }

        // n <= buf.len() is guaranteed by read()
        for msg in decoder
            .decode(buf.get(..n).unwrap_or_default())
            .map_err(to_io_error)?
        {
            // MSG_EXEC and MSG_SPAWN_WATCH run in background threads to avoid
            // blocking the event loop. A blocking child process (e.g. reading a
            // pipe fd) would otherwise stall all subsequent messages.
            if msg.msg_type == MSG_SPAWN_WATCH {
                let d = vsock_proto::decode_spawn_watch(&msg.payload).map_err(to_io_error)?;
                // handle_spawn_watch writes the response itself (before
                // spawning the streaming thread) to prevent a race where
                // stdout chunks could arrive at the host before the result.
                handle_spawn_watch(
                    d.exec.timeout_ms,
                    d.exec.command,
                    &d.exec.env,
                    d.exec.sudo,
                    d.stdout_log_path,
                    msg.seq,
                    Arc::clone(&writer),
                )?;
            } else if msg.msg_type == MSG_EXEC {
                log(
                    "INFO",
                    &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
                );
                let d = vsock_proto::decode_exec(&msg.payload).map_err(to_io_error)?;
                let timeout_ms = d.timeout_ms;
                let command = d.command.to_owned();
                let env: Vec<(String, String)> = d
                    .env
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect();
                let sudo = d.sudo;
                let seq = msg.seq;
                let w = Arc::clone(&writer);
                thread::spawn(move || {
                    let env_refs: Vec<(&str, &str)> =
                        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                    let (exit_code, stdout, stderr) =
                        handle_exec(timeout_ms, &command, &env_refs, sudo);
                    let payload = vsock_proto::encode_exec_result(exit_code, &stdout, &stderr);
                    let encoded = match vsock_proto::encode(MSG_EXEC_RESULT, seq, &payload) {
                        Ok(msg) => msg,
                        Err(e) => {
                            log("ERROR", &format!("Failed to encode exec_result: {}", e));
                            return;
                        }
                    };
                    let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                    if let Err(e) = w.write_all(&encoded) {
                        log("ERROR", &format!("Failed to send exec_result: {}", e));
                    }
                });
            } else {
                let response = handle_message(&msg)?;
                if let Some(response) = response {
                    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                    w.write_all(&response)?;
                }
            }
        }
    }

    log("INFO", "Host disconnected");
    Ok(())
}

/// Maximum reconnection attempts before giving up
const MAX_RECONNECT_ATTEMPTS: u32 = 50;
/// Delay between reconnection attempts (10ms for fast reconnect after snapshot restore)
const RECONNECT_DELAY_MS: u64 = 10;

/// Run the vsock guest agent with the given options.
/// Includes reconnection logic for snapshot restore scenarios where
/// the connection is lost when VM is paused and resumed.
pub fn run(unix_socket: Option<&str>) -> io::Result<()> {
    log("INFO", "Starting vsock guest...");

    let mut attempts = 0u32;

    loop {
        let result = if let Some(path) = unix_socket {
            log("INFO", &format!("Connecting to Unix socket: {}...", path));
            connect_unix(path).and_then(|stream| {
                log("INFO", "Connected");
                // Reset attempts on successful connection
                attempts = 0;
                handle_connection(stream)
            })
        } else {
            log("INFO", "Connecting to host (CID=2)...");
            connect_vsock().and_then(|stream| {
                log("INFO", "Connected");
                // Reset attempts on successful connection
                attempts = 0;
                handle_connection(stream)
            })
        };

        attempts += 1;

        match result {
            Ok(()) => {
                // If shutdown was received, exit gracefully without reconnecting
                if SHUTDOWN_RECEIVED.load(Ordering::SeqCst) {
                    log("INFO", "Shutdown complete, exiting");
                    return Ok(());
                }
                // Connection closed gracefully, try to reconnect
                if attempts >= MAX_RECONNECT_ATTEMPTS {
                    log(
                        "ERROR",
                        &format!(
                            "Max reconnect attempts ({}) reached",
                            MAX_RECONNECT_ATTEMPTS
                        ),
                    );
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "Max reconnect attempts reached",
                    ));
                }
                log(
                    "INFO",
                    &format!(
                        "Connection closed, reconnecting ({}/{})...",
                        attempts, MAX_RECONNECT_ATTEMPTS
                    ),
                );
                std::thread::sleep(std::time::Duration::from_millis(RECONNECT_DELAY_MS));
            }
            Err(e) => {
                // Connection error, try to reconnect
                if attempts >= MAX_RECONNECT_ATTEMPTS {
                    log(
                        "ERROR",
                        &format!(
                            "Max reconnect attempts ({}) reached: {}",
                            MAX_RECONNECT_ATTEMPTS, e
                        ),
                    );
                    return Err(e);
                }
                log(
                    "WARN",
                    &format!(
                        "Connection error: {}, reconnecting ({}/{})...",
                        e, attempts, MAX_RECONNECT_ATTEMPTS
                    ),
                );
                std::thread::sleep(std::time::Duration::from_millis(RECONNECT_DELAY_MS));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_escape_simple() {
        assert_eq!(shell_escape_value("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_with_single_quotes() {
        assert_eq!(shell_escape_value("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_empty() {
        assert_eq!(shell_escape_value(""), "''");
    }

    #[test]
    fn prepend_env_empty() {
        assert_eq!(prepend_env("echo hi", &[]), "echo hi");
    }

    #[test]
    fn prepend_env_single() {
        assert_eq!(
            prepend_env("echo hi", &[("FOO", "bar")]),
            "export FOO='bar'; echo hi"
        );
    }

    #[test]
    fn prepend_env_multiple() {
        let result = prepend_env("cmd", &[("A", "1"), ("B", "2")]);
        assert_eq!(result, "export A='1' B='2'; cmd");
    }

    #[test]
    fn prepend_env_with_special_chars() {
        let result = prepend_env("cmd", &[("KEY", "it's a \"test\"")]);
        assert_eq!(result, "export KEY='it'\\''s a \"test\"'; cmd");
    }

    /// Helper: send a MSG_EXEC via the writer half, read MSG_EXEC_RESULT from the
    /// reader half, and return `(exit_code, stdout, stderr)`.
    fn send_exec_and_read_result(
        writer: &mut impl std::io::Write,
        reader: &mut impl std::io::Read,
        seq: u32,
        command: &str,
        timeout_ms: u32,
    ) -> (i32, Vec<u8>, Vec<u8>) {
        let payload = vsock_proto::encode_exec(timeout_ms, command, &[], false);
        let msg = vsock_proto::encode(MSG_EXEC, seq, &payload).unwrap();
        writer.write_all(&msg).unwrap();

        // Read response — first 4 bytes are length header
        let mut hdr = [0u8; 4];
        reader.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        reader.read_exact(&mut body).unwrap();

        // Decode
        let mut full = Vec::with_capacity(4 + body_len);
        full.extend_from_slice(&hdr);
        full.extend_from_slice(&body);
        let mut decoder = vsock_proto::Decoder::new();
        let msgs = decoder.decode(&full).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_EXEC_RESULT);
        assert_eq!(msgs[0].seq, seq);
        vsock_proto::decode_exec_result(&msgs[0].payload)
            .map(|(code, out, err)| (code, out.to_vec(), err.to_vec()))
            .unwrap()
    }

    /// Verify that a slow exec does not block a fast exec that arrives later.
    /// This is the core regression test for the non-blocking exec fix.
    #[test]
    fn slow_exec_does_not_block_fast_exec() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();

        // Run handle_connection in a background thread (it blocks on read)
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Read and discard the MSG_READY sent by handle_connection
        let mut hdr = [0u8; 4];
        host_stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        host_stream.read_exact(&mut body).unwrap();

        // Send a slow exec (sleep 5) — we won't wait for its result
        let slow_payload = vsock_proto::encode_exec(5000, "sleep 5", &[], false);
        let slow_msg = vsock_proto::encode(MSG_EXEC, 1, &slow_payload).unwrap();
        host_stream.write_all(&slow_msg).unwrap();

        // Give it a moment to start processing
        thread::sleep(Duration::from_millis(100));

        // Send a fast exec — this should return quickly despite the slow one
        let fast_payload = vsock_proto::encode_exec(5000, "echo ok", &[], false);
        let fast_msg = vsock_proto::encode(MSG_EXEC, 2, &fast_payload).unwrap();
        host_stream.write_all(&fast_msg).unwrap();

        // Read responses — we need to find seq=2 (the fast one) within 3 seconds.
        // Before the fix, this would block until sleep 30 finished.
        host_stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();

        let mut decoder = vsock_proto::Decoder::new();
        let mut found_fast = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);

        while std::time::Instant::now() < deadline {
            let mut buf = [0u8; 4096];
            match host_stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                        if msg.seq == 2 && msg.msg_type == MSG_EXEC_RESULT {
                            let (code, stdout, _) =
                                vsock_proto::decode_exec_result(&msg.payload).unwrap();
                            assert_eq!(code, 0);
                            assert_eq!(String::from_utf8_lossy(stdout).trim(), "ok");
                            found_fast = true;
                        }
                    }
                    if found_fast {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("read error: {e}"),
            }
        }

        assert!(
            found_fast,
            "fast exec (seq=2) should complete while slow exec is still running"
        );

        // Shut down: drop the stream so handle_connection sees EOF
        drop(host_stream);
        let _ = handle.join();
    }

    #[test]
    fn truncate_preview_short_string() {
        let s = "echo hello";
        assert_eq!(truncate_preview(s), "echo hello");
    }

    #[test]
    fn truncate_preview_exact_limit() {
        let s = "x".repeat(COMMAND_PREVIEW_MAX_LEN);
        assert_eq!(truncate_preview(&s), s);
    }

    #[test]
    fn truncate_preview_over_limit() {
        let s = "y".repeat(COMMAND_PREVIEW_MAX_LEN + 50);
        let result = truncate_preview(&s);
        // Single-byte ASCII: truncates to exactly COMMAND_PREVIEW_MAX_LEN + "..."
        assert_eq!(
            result,
            format!("{}{}", "y".repeat(COMMAND_PREVIEW_MAX_LEN), "...")
        );
    }

    #[test]
    fn truncate_preview_multibyte_utf8() {
        // Each '🔥' is 4 bytes. Fill to just over the limit.
        let emoji = "🔥".repeat(COMMAND_PREVIEW_MAX_LEN / 4 + 5);
        let result = truncate_preview(&emoji);
        assert!(result.ends_with("..."));
        // Must not panic from slicing in the middle of a UTF-8 sequence
        assert!(result.is_char_boundary(result.len() - 3));
    }

    #[test]
    fn build_exec_command_normal() {
        let cmd = build_exec_command("echo hello", false);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sh -c "echo hello"
        // In release builds: su - user -c "echo hello"
        assert!(
            (prog == "sh" && args == ["-c", "echo hello"])
                || (prog == "su" && args == ["-", "user", "-c", "echo hello"]),
            "unexpected command: {prog} {args:?}"
        );
    }

    #[test]
    fn build_exec_command_sudo() {
        let cmd = build_exec_command("reboot", true);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sudo sh -c "reboot"
        // In release builds: sh -c "reboot"
        assert!(
            (prog == "sudo" && args == ["sh", "-c", "reboot"])
                || (prog == "sh" && args == ["-c", "reboot"]),
            "unexpected sudo command: {prog} {args:?}"
        );
    }

    #[test]
    fn extract_exit_code_success() {
        let status = Command::new("true").status().unwrap();
        assert_eq!(extract_exit_code(status), 0);
    }

    #[test]
    fn extract_exit_code_failure() {
        let status = Command::new("false").status().unwrap();
        assert_eq!(extract_exit_code(status), 1);
    }

    #[test]
    fn extract_exit_code_specific() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("exit 42")
            .status()
            .unwrap();
        assert_eq!(extract_exit_code(status), 42);
    }

    #[test]
    fn extract_exit_code_signal_kill() {
        // Kill a process with SIGKILL and verify 128 + 9 = 137
        let mut child = Command::new("sleep").arg("60").spawn().unwrap();
        unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
        let status = child.wait().unwrap();
        assert_eq!(extract_exit_code(status), 137);
    }

    /// Verify that a normal exec still returns correct results.
    #[test]
    fn exec_returns_correct_result() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
        let mut host_writer = host_stream.try_clone().unwrap();
        let mut host_reader = host_stream;

        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        let mut hdr = [0u8; 4];
        host_reader.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        host_reader.read_exact(&mut body).unwrap();

        host_reader
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

        let (code, stdout, _stderr) =
            send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "echo hello", 5000);
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "hello");

        drop(host_writer);
        drop(host_reader);
        let _ = handle.join();
    }

    // -----------------------------------------------------------------------
    // Helpers for spawn_watch streaming tests
    // -----------------------------------------------------------------------

    /// Read one framed message from the stream and discard it.
    fn read_and_discard_message(stream: &mut impl std::io::Read) {
        let mut hdr = [0u8; 4];
        stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).unwrap();
    }

    /// Send a MSG_SPAWN_WATCH message with streaming enabled.
    fn send_spawn_watch(
        stream: &mut impl std::io::Write,
        seq: u32,
        command: &str,
        log_path: &str,
        timeout_ms: u32,
    ) {
        let payload =
            vsock_proto::encode_spawn_watch(timeout_ms, command, &[], false, Some(log_path));
        let msg = vsock_proto::encode(MSG_SPAWN_WATCH, seq, &payload).unwrap();
        stream.write_all(&msg).unwrap();
    }

    /// Read all streaming messages for a spawn_watch command in a single loop.
    /// Uses one decoder to avoid losing messages when the OS batches multiple
    /// protocol frames into a single read buffer.
    ///
    /// Returns `(pid, stdout_data, exit_code, stderr)`.
    fn read_streaming_result(
        stream: &mut impl std::io::Read,
        seq: u32,
    ) -> (u32, Vec<u8>, i32, Vec<u8>) {
        let mut decoder = vsock_proto::Decoder::new();
        let mut buf = [0u8; 4096];
        let mut pid: Option<u32> = None;
        let mut stdout_data = Vec::new();
        loop {
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0, "unexpected EOF waiting for streaming result");
            for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                // Pick up the PID from spawn_watch_result
                if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == seq {
                    pid = Some(vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap());
                    continue;
                }
                let Some(p) = pid else { continue };

                // Collect stdout chunks and return on process_exit
                if msg.msg_type == MSG_STDOUT_CHUNK
                    && let Ok((chunk_pid, data)) = vsock_proto::decode_stdout_chunk(&msg.payload)
                    && chunk_pid == p
                {
                    stdout_data.extend_from_slice(data);
                } else if msg.msg_type == MSG_PROCESS_EXIT
                    && let Ok((exit_pid, code, _stdout, stderr)) =
                        vsock_proto::decode_process_exit(&msg.payload)
                    && exit_pid == p
                {
                    return (p, stdout_data, code, stderr.to_vec());
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Streaming monitor integration tests
    // -----------------------------------------------------------------------

    /// Verify that streaming stdout works correctly for a normal command.
    #[test]
    fn streaming_monitor_normal_exit() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        let log_path = format!("/tmp/vsock-test-normal-{}.log", std::process::id());
        send_spawn_watch(&mut host_stream, 1, "echo hello", &log_path, 5000);

        host_stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout_data).trim(), "hello");

        // Cleanup
        let _ = std::fs::remove_file(&log_path);
        drop(host_stream);
        let _ = handle.join();
    }

    /// Regression test: if the main child exits but an orphaned background
    /// process holds the stdout fd open, `send_process_exit` must still arrive
    /// within the drain deadline (STDOUT_DRAIN_DEADLINE_SECS).
    ///
    /// Before the fix, the monitor thread blocked forever on `stdout.read()`
    /// because the orphaned process kept the pipe write end open.
    #[test]
    fn streaming_monitor_drains_on_orphaned_stdout() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        // Command that writes to stdout, then spawns a background process
        // that inherits (and holds open) the stdout fd. The main shell exits
        // immediately but the backgrounded `sleep` keeps the pipe alive.
        let log_path = format!("/tmp/vsock-test-orphan-{}.log", std::process::id());
        send_spawn_watch(
            &mut host_stream,
            1,
            "echo orphan-test; sleep 30 &",
            &log_path,
            0, // no timeout — relies entirely on drain deadline
        );

        // Set read timeout: drain deadline (5s) + generous margin (7s)
        host_stream
            .set_read_timeout(Some(Duration::from_secs(12)))
            .unwrap();

        let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, 0);
        assert!(
            String::from_utf8_lossy(&stdout_data).contains("orphan-test"),
            "expected stdout to contain 'orphan-test', got: {:?}",
            String::from_utf8_lossy(&stdout_data),
        );

        // Cleanup: kill the orphaned sleep process (best-effort)
        let _ = std::process::Command::new("pkill")
            .args(["-f", "sleep 30"])
            .status();
        let _ = std::fs::remove_file(&log_path);
        drop(host_stream);
        let _ = handle.join();
    }

    /// Verify that a streaming process killed by timeout returns exit code 124
    /// and delivers process_exit promptly.
    ///
    /// The timeout killer fires while the stdout thread is reading. SIGKILL
    /// breaks the pipe (EOF), the stdout thread exits, and the monitor thread
    /// reports exit_code = EXIT_CODE_TIMEOUT (124).
    #[test]
    fn streaming_monitor_timeout_kills_process() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        // Command that runs longer than the timeout.
        // timeout_ms = 1000 (1s), command sleeps 60s → killed after 1s.
        let log_path = format!("/tmp/vsock-test-timeout-{}.log", std::process::id());
        send_spawn_watch(
            &mut host_stream,
            1,
            "echo timeout-test; sleep 60",
            &log_path,
            1000, // 1 second timeout
        );

        // Timeout (1s) + drain (5s) + margin (4s)
        host_stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();

        let (pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, EXIT_CODE_TIMEOUT);
        assert_eq!(String::from_utf8_lossy(&stderr), "Timeout");
        assert!(
            String::from_utf8_lossy(&stdout_data).contains("timeout-test"),
            "expected stdout to contain 'timeout-test', got: {:?}",
            String::from_utf8_lossy(&stdout_data),
        );

        let _ = std::fs::remove_file(&log_path);
        drop(host_stream);
        let _ = handle.join();
    }
}
