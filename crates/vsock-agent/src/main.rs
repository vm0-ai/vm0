//! Vsock Agent for Firecracker VM host-guest communication.
//!
//! Binary Protocol:
//!   [4-byte length][1-byte type][4-byte seq][payload]
//!
//!   - length: size of (type + seq + payload), big-endian
//!   - type: message type
//!   - seq: sequence number for request/response matching, big-endian
//!   - payload: type-specific binary data
//!
//! Message Types:
//!   0x00 ready          G→H  (empty)
//!   0x01 ping           H→G  (empty)
//!   0x02 pong           G→H  (empty)
//!   0x03 exec           H→G  [4-byte timeout_ms][4-byte cmd_len][command]
//!   0x04 exec_result    G→H  [4-byte exit_code][4-byte stdout_len][stdout][4-byte stderr_len][stderr]
//!   0x05 write_file     H→G  [2-byte path_len][path][1-byte flags][4-byte content_len][content]
//!   0x06 write_file_result G→H [1-byte success][2-byte error_len][error]
//!   0xFF error          G→H  [2-byte error_len][error]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use std::{env, fs, thread};

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
const MSG_ERROR: u8 = 0xFF;

use std::sync::OnceLock;
use std::time::Instant;

static START_TIME: OnceLock<Instant> = OnceLock::new();

fn log(level: &str, msg: &str) {
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

/// Exit code returned when command times out (same as bash/Python)
const EXIT_CODE_TIMEOUT: i32 = 124;

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
            // Timeout reached, mark and kill the process
            killed_by_timeout_clone.store(true, Ordering::SeqCst);
            unsafe {
                libc::kill(child_id as i32, libc::SIGKILL);
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

    let child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match child {
        Ok(child) => wait_with_timeout(child, timeout_ms),
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
        Self { buf: Vec::new() }
    }

    fn decode(&mut self, data: &[u8]) -> Vec<(u8, u32, Vec<u8>)> {
        self.buf.extend_from_slice(data);
        let mut messages = Vec::new();

        while self.buf.len() >= HEADER_SIZE {
            let length =
                u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;

            if length > MAX_MESSAGE_SIZE {
                log("ERROR", &format!("Message too large: {}", length));
                self.buf.clear();
                break;
            }

            if length < 5 {
                log("ERROR", &format!("Message too small: {}", length));
                self.buf.clear();
                break;
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

        messages
    }
}

/// Connect to vsock (Linux only - this binary runs inside Firecracker VM)
#[cfg(target_os = "linux")]
fn connect_vsock() -> std::io::Result<UnixStream> {
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
fn connect_vsock() -> std::io::Result<UnixStream> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "vsock is only supported on Linux",
    ))
}

/// Connect to Unix socket (for testing)
fn connect_unix(path: &str) -> std::io::Result<UnixStream> {
    UnixStream::connect(path)
}

/// Handle connection
fn handle_connection<S: Read + Write>(mut stream: S) -> std::io::Result<()> {
    let mut decoder = Decoder::new();

    // Send ready signal
    let ready = encode(MSG_READY, 0, &[]);
    stream.write_all(&ready)?;
    log("INFO", "Sent ready signal");

    let mut buf = [0u8; 65536];
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }

        for (msg_type, seq, payload) in decoder.decode(&buf[..n]) {
            if let Some(response) = handle_message(msg_type, seq, &payload) {
                stream.write_all(&response)?;
            }
        }
    }

    log("INFO", "Host disconnected");
    Ok(())
}

fn main() {
    log("INFO", "Starting vsock agent...");

    let args: Vec<String> = env::args().collect();
    let unix_socket = args
        .iter()
        .position(|a| a == "--unix-socket")
        .and_then(|i| args.get(i + 1));

    let result = if let Some(path) = unix_socket {
        log("INFO", &format!("Connecting to Unix socket: {}...", path));
        connect_unix(path).and_then(|stream| {
            log("INFO", "Connected");
            handle_connection(stream)
        })
    } else {
        log("INFO", "Connecting to host (CID=2)...");
        connect_vsock().and_then(|stream| {
            log("INFO", "Connected");
            handle_connection(stream)
        })
    };

    if let Err(e) = result {
        log("ERROR", &format!("Fatal: {}", e));
        std::process::exit(1);
    }
}
