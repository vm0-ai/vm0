use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use vsock_proto::{self, MSG_EXEC, MSG_EXEC_RESULT, MSG_READY, MSG_SPAWN_WATCH};

use crate::error::to_io_error;
use crate::handlers::{handle_exec, handle_message};
use crate::log::log;
use crate::monitor::{SpawnWatchRequest, handle_spawn_watch};
use crate::shutdown::shutdown_received;

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB

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
                    SpawnWatchRequest {
                        timeout_ms: d.exec.timeout_ms,
                        command: d.exec.command,
                        env: &d.exec.env,
                        sudo: d.exec.sudo,
                        stream_stdout: d.stream_stdout,
                        stdout_log_path: d.stdout_log_path,
                    },
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
                if shutdown_received() {
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
                thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS));
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
                thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS));
            }
        }
    }
}
