//! Vsock Agent library for Firecracker VM host-guest communication.
//!
//! This library provides the core functionality for host-guest IPC via vsock
//! or Unix sockets. It can be used standalone or embedded in other binaries
//! like vm-init.
//!
//! ## Binary Protocol
//!
//! ```text
//! [4-byte length][1-byte type][4-byte seq][payload]
//! ```
//!
//! - length: size of (type + seq + payload), big-endian
//! - type: message type
//! - seq: sequence number for request/response matching, big-endian
//! - payload: type-specific binary data
//!
//! ## Message Types
//!
//! - `0x00` ready (G→H): Agent is ready
//! - `0x01` ping (H→G): Keepalive request
//! - `0x02` pong (G→H): Keepalive response
//! - `0x03` exec (H→G): Execute command
//! - `0x04` exec_result (G→H): Command result
//! - `0x05` write_file (H→G): Write file
//! - `0x06` write_file_result (G→H): Write result
//! - `0x07` spawn_watch (H→G): Spawn process and monitor for exit
//! - `0x08` spawn_watch_result (G→H): Acknowledgment with PID
//! - `0x09` process_exit (G→H): Unsolicited notification when process exits
//! - `0x0A` shutdown (H→G): Request graceful shutdown
//! - `0x0B` shutdown_ack (G→H): Acknowledge shutdown after sync
//! - `0xFF` error (G→H): Error message

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::{fs, thread};

/// Flag indicating shutdown was received (don't reconnect after shutdown)
static SHUTDOWN_RECEIVED: AtomicBool = AtomicBool::new(false);

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_PORT: u32 = 1000;
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

// Protocol constants
const HEADER_SIZE: usize = 4;
const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16MB

// Message types
const MSG_READY: u8 = 0x00;
const MSG_PING: u8 = 0x01;
const MSG_PONG: u8 = 0x02;
const MSG_EXEC: u8 = 0x03;
const MSG_EXEC_RESULT: u8 = 0x04;
const MSG_WRITE_FILE: u8 = 0x05;
const MSG_WRITE_FILE_RESULT: u8 = 0x06;
const MSG_SPAWN_WATCH: u8 = 0x07;
const MSG_SPAWN_WATCH_RESULT: u8 = 0x08;
const MSG_PROCESS_EXIT: u8 = 0x09;
const MSG_SHUTDOWN: u8 = 0x0A;
const MSG_SHUTDOWN_ACK: u8 = 0x0B;
const MSG_ERROR: u8 = 0xFF;

/// Exit code returned when command times out (same as bash/Python)
const EXIT_CODE_TIMEOUT: i32 = 124;

static START_TIME: OnceLock<Instant> = OnceLock::new();

/// Log a message with timestamp
pub fn log(level: &str, msg: &str) {
    let start = START_TIME.get_or_init(Instant::now);
    let elapsed = start.elapsed();
    let total_ms = elapsed.as_millis() as u64;
    let minutes = total_ms / 60000;
    let seconds = (total_ms % 60000) / 1000;
    let millis = total_ms % 1000;
    eprintln!(
        "[{:02}:{:02}.{:03}] [vsock-agent] [{}] {}",
        minutes, seconds, millis, level, msg
    );
}

/// Encode a message with binary protocol
fn encode(msg_type: u8, seq: u32, payload: &[u8]) -> Vec<u8> {
    let body_len = 1 + 4 + payload.len(); // type + seq + payload
    let mut buf = Vec::with_capacity(4 + body_len);
    buf.extend_from_slice(&(body_len as u32).to_be_bytes());
    buf.push(msg_type);
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

/// Encode an error message
fn encode_error(seq: u32, error: &str) -> Vec<u8> {
    let error_bytes = error.as_bytes();
    let len = error_bytes.len().min(65535) as u16;
    let mut payload = Vec::with_capacity(2 + len as usize);
    payload.extend_from_slice(&len.to_be_bytes());
    payload.extend_from_slice(&error_bytes[..len as usize]);
    encode(MSG_ERROR, seq, &payload)
}

/// Encode exec_result message
fn encode_exec_result(seq: u32, exit_code: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + 4 + stdout.len() + 4 + stderr.len());
    payload.extend_from_slice(&exit_code.to_be_bytes());
    payload.extend_from_slice(&(stdout.len() as u32).to_be_bytes());
    payload.extend_from_slice(stdout);
    payload.extend_from_slice(&(stderr.len() as u32).to_be_bytes());
    payload.extend_from_slice(stderr);
    encode(MSG_EXEC_RESULT, seq, &payload)
}

/// Encode write_file_result message
fn encode_write_file_result(seq: u32, success: bool, error: &str) -> Vec<u8> {
    let error_bytes = error.as_bytes();
    let len = error_bytes.len().min(65535) as u16;
    let mut payload = Vec::with_capacity(1 + 2 + len as usize);
    payload.push(if success { 1 } else { 0 });
    payload.extend_from_slice(&len.to_be_bytes());
    if len > 0 {
        payload.extend_from_slice(&error_bytes[..len as usize]);
    }
    encode(MSG_WRITE_FILE_RESULT, seq, &payload)
}

/// Encode spawn_watch_result message
fn encode_spawn_watch_result(seq: u32, pid: u32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4);
    payload.extend_from_slice(&pid.to_be_bytes());
    encode(MSG_SPAWN_WATCH_RESULT, seq, &payload)
}

/// Encode process_exit message (unsolicited notification, seq=0)
fn encode_process_exit(pid: u32, exit_code: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + 4 + 4 + stdout.len() + 4 + stderr.len());
    payload.extend_from_slice(&pid.to_be_bytes());
    payload.extend_from_slice(&exit_code.to_be_bytes());
    payload.extend_from_slice(&(stdout.len() as u32).to_be_bytes());
    payload.extend_from_slice(stdout);
    payload.extend_from_slice(&(stderr.len() as u32).to_be_bytes());
    payload.extend_from_slice(stderr);
    encode(MSG_PROCESS_EXIT, 0, &payload) // seq=0 for unsolicited messages
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
            unsafe {
                // Kill process group (negative pid) to clean up any child processes
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
            // Map exit status like tini does: normal exit returns code,
            // signal termination returns 128 + signal number
            #[cfg(unix)]
            let exit_code = {
                use std::os::unix::process::ExitStatusExt;
                output
                    .status
                    .code()
                    .unwrap_or_else(|| output.status.signal().map(|sig| 128 + sig).unwrap_or(1))
            };
            #[cfg(not(unix))]
            let exit_code = output.status.code().unwrap_or(1);
            (exit_code, output.stdout, output.stderr)
        }
        Err(e) => (1, Vec::new(), format!("Failed to wait: {}", e).into_bytes()),
    }
}

/// Handle exec message
fn handle_exec(payload: &[u8]) -> (i32, Vec<u8>, Vec<u8>) {
    if payload.len() < 8 {
        return (1, Vec::new(), b"Invalid exec payload".to_vec());
    }

    let timeout_ms = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let cmd_len = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;

    if payload.len() < 8 + cmd_len {
        return (1, Vec::new(), b"Invalid exec payload: truncated".to_vec());
    }

    let command = match std::str::from_utf8(&payload[8..8 + cmd_len]) {
        Ok(s) => s,
        Err(_) => return (1, Vec::new(), b"Invalid UTF-8 in command".to_vec()),
    };

    let preview = if command.len() > 100 {
        // Find a safe UTF-8 boundary at or before byte 100
        let end = command
            .char_indices()
            .take_while(|(i, _)| *i < 100)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(100);
        format!("{}...", &command[..end])
    } else {
        command.to_string()
    };
    log(
        "INFO",
        &format!("exec: {} (timeout={}ms)", preview, timeout_ms),
    );

    // Create new process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        Command::new("sh")
            .arg("-c")
            .arg(command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0) // Create new process group (like tini's setpgid(0,0))
            .spawn()
    };
    #[cfg(not(unix))]
    let child = Command::new("sh")
        .arg("-c")
        .arg(command)
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
fn handle_write_file(payload: &[u8]) -> (bool, String) {
    if payload.len() < 3 {
        return (false, "Invalid write_file payload".to_string());
    }

    let path_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    if payload.len() < 2 + path_len + 1 + 4 {
        return (false, "Invalid write_file payload: too short".to_string());
    }

    let path = match std::str::from_utf8(&payload[2..2 + path_len]) {
        Ok(s) => s,
        Err(_) => return (false, "Invalid UTF-8 in path".to_string()),
    };

    let flags = payload[2 + path_len];
    let content_len = u32::from_be_bytes([
        payload[3 + path_len],
        payload[4 + path_len],
        payload[5 + path_len],
        payload[6 + path_len],
    ]) as usize;

    if payload.len() < 7 + path_len + content_len {
        return (
            false,
            "Invalid write_file payload: content truncated".to_string(),
        );
    }

    let content = &payload[7 + path_len..7 + path_len + content_len];
    let use_sudo = (flags & 0x01) != 0;

    log(
        "INFO",
        &format!(
            "write_file: path={} size={} sudo={}",
            path,
            content.len(),
            use_sudo
        ),
    );

    if use_sudo {
        // Use sudo tee to write (30s timeout, same as Python)
        const SUDO_TEE_TIMEOUT_MS: u32 = 30_000;

        let mut child = match Command::new("sudo")
            .arg("tee")
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return (false, format!("Failed to spawn sudo tee: {}", e)),
        };

        // Write content to stdin and close it
        if let Some(mut stdin) = child.stdin.take()
            && let Err(e) = stdin.write_all(content)
        {
            let _ = child.kill();
            return (false, format!("Failed to write to stdin: {}", e));
        }
        // stdin is dropped here, closing the pipe

        // Wait with timeout
        let (exit_code, _, stderr) = wait_with_timeout(child, SUDO_TEE_TIMEOUT_MS);
        if exit_code == EXIT_CODE_TIMEOUT {
            return (false, "sudo tee timed out".to_string());
        }
        if exit_code != 0 {
            let stderr_str = String::from_utf8_lossy(&stderr);
            return (false, format!("sudo tee failed: {}", stderr_str));
        }
        (true, String::new())
    } else {
        // Direct write
        if let Some(parent) = std::path::Path::new(path).parent()
            && !parent.as_os_str().is_empty()
            && let Err(e) = fs::create_dir_all(parent)
        {
            return (false, format!("Failed to create directory: {}", e));
        }

        match fs::write(path, content) {
            Ok(_) => (true, String::new()),
            Err(e) => (false, format!("Failed to write file: {}", e)),
        }
    }
}

/// Handle shutdown message - sync filesystems and acknowledge
fn handle_shutdown(seq: u32) -> Vec<u8> {
    log("INFO", "Shutdown requested, syncing filesystems...");
    unsafe {
        libc::sync();
    }
    log("INFO", "Sync complete");
    // Set flag so run() knows not to reconnect after connection closes
    SHUTDOWN_RECEIVED.store(true, Ordering::SeqCst);
    encode(MSG_SHUTDOWN_ACK, seq, &[])
}

/// Handle spawn_watch message - spawn process and monitor in background
/// Returns immediate acknowledgment with PID, then sends process_exit when done
fn handle_spawn_watch(payload: &[u8], seq: u32, writer: Arc<Mutex<UnixStream>>) -> Vec<u8> {
    if payload.len() < 8 {
        return encode_error(seq, "Invalid spawn_watch payload");
    }

    let timeout_ms = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let cmd_len = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;

    if payload.len() < 8 + cmd_len {
        return encode_error(seq, "Invalid spawn_watch payload: truncated");
    }

    let command = match std::str::from_utf8(&payload[8..8 + cmd_len]) {
        Ok(s) => s.to_string(),
        Err(_) => return encode_error(seq, "Invalid UTF-8 in command"),
    };

    let preview = if command.len() > 100 {
        let end = command
            .char_indices()
            .take_while(|(i, _)| *i < 100)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(100);
        format!("{}...", &command[..end])
    } else {
        command.clone()
    };
    log(
        "INFO",
        &format!("spawn_watch: {} (timeout={}ms)", preview, timeout_ms),
    );

    // Create new process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        Command::new("sh")
            .arg("-c")
            .arg(&command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
    };
    #[cfg(not(unix))]
    let child = Command::new("sh")
        .arg("-c")
        .arg(&command)
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
                        Ok(output) => {
                            #[cfg(unix)]
                            let exit_code = {
                                use std::os::unix::process::ExitStatusExt;
                                output.status.code().unwrap_or_else(|| {
                                    output.status.signal().map(|sig| 128 + sig).unwrap_or(1)
                                })
                            };
                            #[cfg(not(unix))]
                            let exit_code = output.status.code().unwrap_or(1);
                            (exit_code, output.stdout, output.stderr)
                        }
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
                let exit_msg = encode_process_exit(pid, result.0, &result.1, &result.2);
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(e) = w.write_all(&exit_msg) {
                    log("ERROR", &format!("Failed to send process_exit: {}", e));
                }
            });

            // Return immediate acknowledgment with PID
            encode_spawn_watch_result(seq, pid)
        }
        Err(e) => encode_error(seq, &format!("Failed to spawn: {}", e)),
    }
}

/// Handle incoming message and return response
fn handle_message(msg_type: u8, seq: u32, payload: &[u8]) -> Option<Vec<u8>> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg_type, seq),
    );

    match msg_type {
        MSG_PING => Some(encode(MSG_PONG, seq, &[])),
        MSG_EXEC => {
            let (exit_code, stdout, stderr) = handle_exec(payload);
            Some(encode_exec_result(seq, exit_code, &stdout, &stderr))
        }
        MSG_WRITE_FILE => {
            let (success, error) = handle_write_file(payload);
            Some(encode_write_file_result(seq, success, &error))
        }
        MSG_SHUTDOWN => Some(handle_shutdown(seq)),
        _ => Some(encode_error(
            seq,
            &format!("Unknown message type: 0x{:02X}", msg_type),
        )),
    }
}

/// Message decoder with buffering
struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    fn new() -> Self {
        // Pre-allocate buffer to avoid frequent reallocations
        // 64KB matches the read buffer size in handle_connection
        Self {
            buf: Vec::with_capacity(65536),
        }
    }

    /// Decode messages from data. Returns Err on protocol error (caller should reconnect).
    fn decode(&mut self, data: &[u8]) -> std::io::Result<Vec<(u8, u32, Vec<u8>)>> {
        self.buf.extend_from_slice(data);
        let mut messages = Vec::new();

        while self.buf.len() >= HEADER_SIZE {
            let length =
                u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;

            if length > MAX_MESSAGE_SIZE {
                log("ERROR", &format!("Message too large: {}", length));
                self.buf.clear();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Message too large: {}", length),
                ));
            }

            if length < 5 {
                log("ERROR", &format!("Message too small: {}", length));
                self.buf.clear();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Message too small: {}", length),
                ));
            }

            let total = HEADER_SIZE + length;
            if self.buf.len() < total {
                break;
            }

            let msg_type = self.buf[4];
            let seq = u32::from_be_bytes([self.buf[5], self.buf[6], self.buf[7], self.buf[8]]);
            let payload = self.buf[9..total].to_vec();

            messages.push((msg_type, seq, payload));
            self.buf.drain(..total);
        }

        Ok(messages)
    }
}

/// Connect to vsock (Linux only - this binary runs inside Firecracker VM)
#[cfg(target_os = "linux")]
pub fn connect_vsock() -> std::io::Result<UnixStream> {
    use std::os::unix::io::FromRawFd;

    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }

    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: VSOCK_PORT,
        svm_cid: VSOCK_CID_HOST,
        svm_zero: [0; 4],
    };

    let ret = unsafe {
        libc::connect(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as u32,
        )
    };

    if ret < 0 {
        unsafe { libc::close(fd) };
        return Err(std::io::Error::last_os_error());
    }

    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}

/// Stub for non-Linux platforms (for IDE support)
#[cfg(not(target_os = "linux"))]
pub fn connect_vsock() -> std::io::Result<UnixStream> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "vsock is only supported on Linux",
    ))
}

/// Connect to Unix socket (for testing)
pub fn connect_unix(path: &str) -> std::io::Result<UnixStream> {
    UnixStream::connect(path)
}

/// Handle connection - the main event loop
/// Uses separate reader/writer to avoid deadlock between main loop and background threads
pub fn handle_connection(stream: UnixStream) -> std::io::Result<()> {
    // Clone the stream to get separate reader and writer
    // This avoids deadlock: reader can block while writer sends process_exit
    let mut reader = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));

    let mut decoder = Decoder::new();

    // Send ready signal
    {
        let ready = encode(MSG_READY, 0, &[]);
        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(&ready)?;
    }
    log("INFO", "Sent ready signal");

    let mut buf = [0u8; 65536];
    loop {
        // Read from stream (reader is separate, no lock needed)
        let n = reader.read(&mut buf)?;

        if n == 0 {
            break;
        }

        for (msg_type, seq, payload) in decoder.decode(&buf[..n])? {
            // Handle spawn_watch separately since it needs the writer Arc
            let response = if msg_type == MSG_SPAWN_WATCH {
                Some(handle_spawn_watch(&payload, seq, Arc::clone(&writer)))
            } else {
                handle_message(msg_type, seq, &payload)
            };

            if let Some(msg) = response {
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                w.write_all(&msg)?;
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

/// Run the vsock agent with the given options.
/// Includes reconnection logic for snapshot restore scenarios where
/// the connection is lost when VM is paused and resumed.
pub fn run(unix_socket: Option<&str>) -> std::io::Result<()> {
    log("INFO", "Starting vsock agent...");

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
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
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
