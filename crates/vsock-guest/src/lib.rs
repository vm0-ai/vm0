//! Vsock Guest library for Firecracker VM host-guest communication.
//!
//! This library provides the core functionality for host-guest IPC via vsock
//! or Unix sockets. It can be used standalone or embedded in other binaries
//! like guest-init.
//!
//! Protocol encoding/decoding is handled by the `vsock-proto` crate.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, MSG_ERROR, MSG_EXEC, MSG_EXEC_RESULT, MSG_PING, MSG_PONG, MSG_PROCESS_EXIT, MSG_READY,
    MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, ProtocolError, RawMessage,
};

/// Flag indicating shutdown was received (don't reconnect after shutdown).
///
/// Process-level static: safe because integration tests use `handle_connection` per-thread
/// (not `run()`), and each test gets its own connection. Only `run()` reads this flag.
static SHUTDOWN_RECEIVED: AtomicBool = AtomicBool::new(false);

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_PORT: u32 = 1000;
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB

/// Exit code returned when command times out (same as bash/Python)
const EXIT_CODE_TIMEOUT: i32 = 124;

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;

/// Convert a ProtocolError to an io::Error
fn to_io_error(e: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Get the user to execute commands as
/// - Debug builds: None (run as current user via sh -c)
/// - Release builds: Some("user") (run as user via su - user -c)
///
/// The rootfs must have the "user" account (UID 1000) configured with passwordless sudo.
/// See: turbo/apps/runner/scripts/deploy/Dockerfile for user account setup.
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

/// Build a Command to execute a shell command as the appropriate user
fn build_exec_command(command: &str) -> Command {
    match get_exec_user() {
        Some(user) => {
            let mut c = Command::new("su");
            c.arg("-").arg(user).arg("-c").arg(command);
            c
        }
        None => {
            let mut c = Command::new("sh");
            c.arg("-c").arg(command);
            c
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
fn wait_with_timeout(child: Child, timeout_ms: u32) -> (i32, Vec<u8>, Vec<u8>) {
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
            // Timeout reached, mark and kill the entire process group
            // Using negative pid kills all processes in the group (like tini does)
            killed_by_timeout_clone.store(true, Ordering::SeqCst);
            // SAFETY: child_id is a valid PID from Command::spawn (Linux PIDs < 4M,
            // so u32→i32 cast never overflows). Negative pid kills the process group.
            unsafe {
                libc::kill(-(child_id as i32), libc::SIGKILL);
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
fn handle_exec(timeout_ms: u32, command: &str) -> (i32, Vec<u8>, Vec<u8>) {
    log(
        "INFO",
        &format!(
            "exec: {} (timeout={}ms)",
            truncate_preview(command),
            timeout_ms
        ),
    );

    // Create new process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        build_exec_command(command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
    };
    #[cfg(not(unix))]
    let child = build_exec_command(command)
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

    // Build the write command: use sudo tee for privileged writes, cat for normal writes
    let write_cmd = if use_sudo {
        format!("sudo tee '{}'", path.replace('\'', "'\\''"))
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

    let mut child = match build_exec_command(&write_cmd)
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

/// Handle spawn_watch message - spawn process and monitor in background
/// Returns immediate acknowledgment with PID, then sends process_exit when done
fn handle_spawn_watch(
    timeout_ms: u32,
    command: &str,
    seq: u32,
    writer: Arc<Mutex<UnixStream>>,
) -> io::Result<Vec<u8>> {
    log(
        "INFO",
        &format!(
            "spawn_watch: {} (timeout={}ms)",
            truncate_preview(command),
            timeout_ms
        ),
    );

    // Create new process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        build_exec_command(command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
    };
    #[cfg(not(unix))]
    let child = build_exec_command(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match child {
        Ok(child) => {
            let pid = child.id();
            log("INFO", &format!("spawn_watch: started pid={}", pid));

            // Spawn background thread to monitor process exit
            thread::spawn(move || {
                let result = if timeout_ms > 0 {
                    wait_with_timeout(child, timeout_ms)
                } else {
                    // No timeout - wait indefinitely
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

                // Send process_exit notification
                let payload = vsock_proto::encode_process_exit(pid, result.0, &result.1, &result.2);
                // seq=0 for unsolicited messages
                let exit_msg = match vsock_proto::encode(MSG_PROCESS_EXIT, 0, &payload) {
                    Ok(msg) => msg,
                    Err(e) => {
                        log("ERROR", &format!("Failed to encode process_exit: {}", e));
                        return;
                    }
                };
                // Recover from poisoned mutex: a panicked thread shouldn't prevent
                // us from sending the exit notification on a best-effort basis.
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(e) = w.write_all(&exit_msg) {
                    log("ERROR", &format!("Failed to send process_exit: {}", e));
                }
            });

            // Return immediate acknowledgment with PID
            let payload = vsock_proto::encode_spawn_watch_result(pid);
            vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, seq, &payload).map_err(to_io_error)
        }
        Err(e) => {
            let payload = vsock_proto::encode_error(&format!("Failed to spawn: {}", e));
            vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)
        }
    }
}

/// Handle incoming message and return response.
///
/// `MSG_SPAWN_WATCH` is handled separately in `handle_connection` because it
/// needs the writer `Arc` for background process-exit notifications.
fn handle_message(msg: &RawMessage) -> io::Result<Option<Vec<u8>>> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(Some(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_EXEC => {
            let (timeout_ms, command) =
                vsock_proto::decode_exec(&msg.payload).map_err(to_io_error)?;
            let (exit_code, stdout, stderr) = handle_exec(timeout_ms, command);
            let payload = vsock_proto::encode_exec_result(exit_code, &stdout, &stderr);
            Ok(Some(
                vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).map_err(to_io_error)?,
            ))
        }
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
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: VSOCK_PORT,
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

        for msg in decoder.decode(&buf[..n]).map_err(to_io_error)? {
            // Handle spawn_watch separately since it needs the writer Arc
            let response = if msg.msg_type == MSG_SPAWN_WATCH {
                let (timeout_ms, command) =
                    vsock_proto::decode_exec(&msg.payload).map_err(to_io_error)?;
                Some(handle_spawn_watch(
                    timeout_ms,
                    command,
                    msg.seq,
                    Arc::clone(&writer),
                )?)
            } else {
                handle_message(&msg)?
            };

            if let Some(response) = response {
                // Recover from poisoned mutex: a panicked spawn_watch thread
                // shouldn't block the main event loop from sending responses.
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                w.write_all(&response)?;
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
