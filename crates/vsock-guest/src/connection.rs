use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, MSG_EXEC_CANCEL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED,
    MSG_PROCESS_CONTROL, MSG_QUIESCE_OPERATIONS, MSG_READY, MSG_RESUME_OPERATIONS,
    MSG_SPAWN_PROCESS, MSG_WRITE_FILE,
};

use crate::error::to_io_error;
use crate::exec_operation::{
    ExecOperationRegistry, ExecOperationWorkerRequest, cancel_exec_operation, send_error_response,
    start_exec_operation,
};
use crate::handlers::{
    MessageOutcome, decode_write_file_message, handle_decoded_write_file_message, handle_message,
};
use crate::log::log;
use crate::monitor::{SpawnProcessRequest, handle_spawn_process};
use crate::process_control::{ProcessControlRegistry, handle_process_control};
use crate::quiesce::{AcquireOperationError, OperationGuard, OperationState, QuiesceResult};
use crate::writer::GuestWriter;

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB
enum ConnectionEnd {
    Closed,
    Shutdown,
}

/// Signals all exec operation work spawned for this host connection when the
/// connection loop exits. `run()` may reconnect after a close, but in-flight
/// exec operations belong to the old connection and should not survive into
/// the next one.
struct ConnectionCancelGuard(Arc<AtomicBool>);

impl Drop for ConnectionCancelGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn acquire_operation_guard(
    operation_state: &OperationState,
    seq: u32,
    writer: &GuestWriter,
) -> io::Result<Option<OperationGuard>> {
    match operation_state.acquire() {
        Ok(guard) => Ok(Some(guard)),
        Err(AcquireOperationError::Quiescing) => {
            send_error_response(seq, "guest operations are quiescing", writer)?;
            Ok(None)
        }
    }
}

fn reject_operation_if_quiescing(
    operation_state: &OperationState,
    seq: u32,
    writer: &GuestWriter,
) -> io::Result<bool> {
    if operation_state.is_quiescing() {
        send_error_response(seq, "guest operations are quiescing", writer)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn send_empty_response(msg_type: u8, seq: u32, writer: &GuestWriter) -> io::Result<()> {
    let response = vsock_proto::encode(msg_type, seq, &[]).map_err(to_io_error)?;
    writer.write_frame(&response)
}

fn validate_empty_control_payload(
    seq: u32,
    payload_name: &'static str,
    payload: &[u8],
    writer: &GuestWriter,
) -> io::Result<bool> {
    match vsock_proto::decode_empty_payload(payload_name, payload) {
        Ok(()) => Ok(true),
        Err(error) => {
            send_error_response(seq, &error.to_string(), writer)?;
            Ok(false)
        }
    }
}

fn handle_quiesce_operations(
    seq: u32,
    payload: &[u8],
    operation_state: &OperationState,
    writer: &GuestWriter,
) -> io::Result<()> {
    if !validate_empty_control_payload(
        seq,
        "quiesce_operations payload must be empty",
        payload,
        writer,
    )? {
        return Ok(());
    }

    match operation_state.enter_quiescing() {
        QuiesceResult::Quiesced => send_empty_response(MSG_OPERATIONS_QUIESCED, seq, writer),
        QuiesceResult::Busy { pending } => send_error_response(
            seq,
            &format!("guest operations still pending: {pending}"),
            writer,
        ),
    }
}

fn handle_resume_operations(
    seq: u32,
    payload: &[u8],
    operation_state: &OperationState,
    writer: &GuestWriter,
) -> io::Result<()> {
    if !validate_empty_control_payload(
        seq,
        "resume_operations payload must be empty",
        payload,
        writer,
    )? {
        return Ok(());
    }

    operation_state.resume();
    send_empty_response(MSG_OPERATIONS_RESUMED, seq, writer)
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
    handle_connection_with_outcome(stream).map(|_| ())
}

fn handle_connection_with_outcome(stream: UnixStream) -> io::Result<ConnectionEnd> {
    // Clone the stream to get separate reader and writer
    // This avoids deadlock: reader can block while writer sends process_exit
    let mut reader = stream.try_clone()?;
    let writer = GuestWriter::new(stream);
    let connection_cancel = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = ConnectionCancelGuard(connection_cancel.clone());
    let exec_operation_registry = ExecOperationRegistry::default();
    let process_control_registry = ProcessControlRegistry::default();
    let operation_state = OperationState::default();

    let mut decoder = vsock_proto::Decoder::new();

    // Send ready signal
    {
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).map_err(to_io_error)?;
        writer.write_frame(&ready)?;
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
            // Exec operation messages run in background threads to avoid
            // blocking the event loop. A blocking child process (e.g. reading a
            // pipe fd) would otherwise stall all subsequent messages.
            if msg.msg_type == MSG_EXEC_START {
                if msg.seq == 0 {
                    send_error_response(0, "exec start requires non-zero sequence", &writer)?;
                    continue;
                }
                if reject_operation_if_quiescing(&operation_state, msg.seq, &writer)? {
                    continue;
                }
                let decoded = vsock_proto::decode_exec_start(&msg.payload).map_err(to_io_error)?;
                let Some(operation_guard) =
                    acquire_operation_guard(&operation_state, msg.seq, &writer)?
                else {
                    continue;
                };
                start_exec_operation(
                    ExecOperationWorkerRequest::from_decoded(msg.seq, decoded),
                    operation_guard,
                    writer.clone(),
                    connection_cancel.clone(),
                    exec_operation_registry.clone(),
                )?;
            } else if msg.msg_type == MSG_EXEC_CANCEL {
                if msg.seq == 0 {
                    send_error_response(0, "exec cancel requires non-zero sequence", &writer)?;
                    continue;
                }
                vsock_proto::decode_exec_cancel(&msg.payload).map_err(to_io_error)?;
                cancel_exec_operation(&exec_operation_registry, msg.seq);
            } else if msg.msg_type == MSG_SPAWN_PROCESS {
                if msg.seq == 0 {
                    send_error_response(0, "spawn process requires non-zero sequence", &writer)?;
                    continue;
                }
                if reject_operation_if_quiescing(&operation_state, msg.seq, &writer)? {
                    continue;
                }
                let d = vsock_proto::decode_spawn_process(&msg.payload).map_err(to_io_error)?;
                let Some(operation_guard) =
                    acquire_operation_guard(&operation_state, msg.seq, &writer)?
                else {
                    continue;
                };
                let process_control_guard = match process_control_registry
                    .register(msg.seq, d.control_nonce)
                {
                    Ok(guard) => Some(guard),
                    Err(()) => {
                        send_error_response(msg.seq, "process operation already active", &writer)?;
                        continue;
                    }
                };
                // handle_spawn_process writes the response itself (before
                // spawning the streaming thread) to prevent a race where
                // stdout chunks could arrive at the host before the result.
                handle_spawn_process(
                    SpawnProcessRequest {
                        timeout_ms: d.timeout_ms,
                        command: d.command,
                        env: &d.env,
                        sudo: d.sudo,
                        stream_stdout: d.stream_stdout,
                        stdout_log_path: d.stdout_log_path,
                        process_control_guard,
                    },
                    msg.seq,
                    operation_guard,
                    writer.clone(),
                    connection_cancel.clone(),
                )?;
            } else if msg.msg_type == MSG_PROCESS_CONTROL {
                if msg.seq == 0 {
                    send_error_response(0, "process control requires non-zero sequence", &writer)?;
                    continue;
                }
                handle_process_control(msg.seq, &msg.payload, &process_control_registry, &writer)?;
            } else if msg.msg_type == MSG_WRITE_FILE {
                if reject_operation_if_quiescing(&operation_state, msg.seq, &writer)? {
                    continue;
                }
                let decoded = decode_write_file_message(&msg)?;
                let Some(operation_guard) =
                    acquire_operation_guard(&operation_state, msg.seq, &writer)?
                else {
                    continue;
                };
                let response = handle_decoded_write_file_message(msg.seq, decoded)?;
                let result = writer.write_frame_after_lock(&response, || {
                    operation_guard.release();
                });
                result?;
            } else if msg.msg_type == MSG_QUIESCE_OPERATIONS {
                handle_quiesce_operations(msg.seq, &msg.payload, &operation_state, &writer)?;
            } else if msg.msg_type == MSG_RESUME_OPERATIONS {
                handle_resume_operations(msg.seq, &msg.payload, &operation_state, &writer)?;
            } else {
                match handle_message(&msg)? {
                    MessageOutcome::Response(response) => {
                        writer.write_frame(&response)?;
                    }
                    MessageOutcome::Shutdown(response) => {
                        if let Err(e) = writer.write_frame(&response) {
                            log("WARN", &format!("Failed to send shutdown_ack: {e}"));
                        }
                        log("INFO", "Shutdown complete, exiting");
                        return Ok(ConnectionEnd::Shutdown);
                    }
                }
            }
        }
    }

    log("INFO", "Host disconnected");
    Ok(ConnectionEnd::Closed)
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
                handle_connection_with_outcome(stream)
            })
        } else {
            log("INFO", "Connecting to host (CID=2)...");
            connect_vsock().and_then(|stream| {
                log("INFO", "Connected");
                // Reset attempts on successful connection
                attempts = 0;
                handle_connection_with_outcome(stream)
            })
        };

        attempts += 1;

        match result {
            Ok(ConnectionEnd::Shutdown) => return Ok(()),
            Ok(ConnectionEnd::Closed) => {
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
