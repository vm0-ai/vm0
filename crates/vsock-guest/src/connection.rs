use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED, MSG_QUIESCE_OPERATIONS, MSG_READY, MSG_RESUME_OPERATIONS,
    MSG_WRITE_FILE, RawMessage,
};

use crate::error::to_io_error;
use crate::exec_control::{ExecControlRegistry, handle_exec_control as route_exec_control};
use crate::exec_operation::{
    ExecOperationRegistry, ExecOperationWorkerRequest, cancel_exec_operation, send_error_response,
    start_exec_operation,
};
use crate::handlers::{
    MessageOutcome, decode_write_file_message, handle_basic_message,
    handle_decoded_write_file_message,
};
use crate::log::log;
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

enum ReconnectFailure {
    Closed,
    Error(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchOutcome {
    Continue,
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

fn require_non_zero_sequence(
    seq: u32,
    operation_name: &'static str,
    writer: &GuestWriter,
) -> io::Result<bool> {
    if seq == 0 {
        send_error_response(
            0,
            &format!("{operation_name} requires non-zero sequence"),
            writer,
        )?;
        Ok(false)
    } else {
        Ok(true)
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

struct ConnectionDispatcher {
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    exec_operation_registry: ExecOperationRegistry,
    exec_control_registry: ExecControlRegistry,
    operation_state: OperationState,
}

impl ConnectionDispatcher {
    fn new(writer: GuestWriter, connection_cancel: Arc<AtomicBool>) -> Self {
        Self {
            writer,
            connection_cancel,
            exec_operation_registry: ExecOperationRegistry::default(),
            exec_control_registry: ExecControlRegistry::default(),
            operation_state: OperationState::default(),
        }
    }

    fn dispatch(&self, msg: &RawMessage) -> io::Result<DispatchOutcome> {
        match msg.msg_type {
            MSG_EXEC_START => self.handle_exec_start(msg)?,
            MSG_EXEC_CANCEL => self.handle_exec_cancel(msg)?,
            MSG_EXEC_CONTROL => self.handle_exec_control(msg)?,
            MSG_WRITE_FILE => self.handle_write_file(msg)?,
            MSG_QUIESCE_OPERATIONS => self.handle_quiesce_operations(msg)?,
            MSG_RESUME_OPERATIONS => self.handle_resume_operations(msg)?,
            _ => return self.handle_basic_message(msg),
        }

        Ok(DispatchOutcome::Continue)
    }

    fn handle_exec_start(&self, msg: &RawMessage) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "exec start", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let decoded = match vsock_proto::decode_exec_start(&msg.payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let mut request = match ExecOperationWorkerRequest::from_decoded(msg.seq, decoded) {
            Ok(request) => request,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        if let Some((control_nonce, control_sink)) = request.exec_control_registration() {
            let registration =
                match self
                    .exec_control_registry
                    .register(msg.seq, control_nonce, control_sink)
                {
                    Ok(registration) => registration,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        operation_guard.release();
                        send_error_response(
                            msg.seq,
                            "exec operation already active",
                            &self.writer,
                        )?;
                        return Ok(());
                    }
                    Err(error) => {
                        operation_guard.release();
                        send_error_response(
                            msg.seq,
                            &format!("exec control setup failed: {error}"),
                            &self.writer,
                        )?;
                        return Ok(());
                    }
                };
            request.attach_exec_control(registration.guard, registration.bootstrap_endpoint);
        }
        start_exec_operation(
            request,
            operation_guard,
            self.writer.clone(),
            self.connection_cancel.clone(),
            self.exec_operation_registry.clone(),
        )
    }

    fn handle_exec_cancel(&self, msg: &RawMessage) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "exec cancel", &self.writer)? {
            return Ok(());
        }
        vsock_proto::decode_exec_cancel(&msg.payload).map_err(to_io_error)?;
        cancel_exec_operation(&self.exec_operation_registry, msg.seq);
        Ok(())
    }

    fn handle_exec_control(&self, msg: &RawMessage) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "exec control", &self.writer)? {
            return Ok(());
        }
        route_exec_control(
            msg.seq,
            &msg.payload,
            &self.exec_control_registry,
            &self.writer,
        )
    }

    fn handle_write_file(&self, msg: &RawMessage) -> io::Result<()> {
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let decoded = decode_write_file_message(msg)?;
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        let response = handle_decoded_write_file_message(msg.seq, decoded)?;
        self.writer.write_frame_after_lock(&response, || {
            operation_guard.release();
        })
    }

    fn handle_quiesce_operations(&self, msg: &RawMessage) -> io::Result<()> {
        handle_quiesce_operations(msg.seq, &msg.payload, &self.operation_state, &self.writer)
    }

    fn handle_resume_operations(&self, msg: &RawMessage) -> io::Result<()> {
        handle_resume_operations(msg.seq, &msg.payload, &self.operation_state, &self.writer)
    }

    fn handle_basic_message(&self, msg: &RawMessage) -> io::Result<DispatchOutcome> {
        match handle_basic_message(msg)? {
            MessageOutcome::Response(response) => {
                self.writer.write_frame(&response)?;
                Ok(DispatchOutcome::Continue)
            }
            MessageOutcome::Shutdown(response) => {
                if let Err(e) = self.writer.write_frame(&response) {
                    log("WARN", &format!("Failed to send shutdown_ack: {e}"));
                }
                log("INFO", "Shutdown complete, exiting");
                Ok(DispatchOutcome::Shutdown)
            }
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
    handle_connection_with_outcome(stream).map(|_| ())
}

fn handle_connection_with_outcome(stream: UnixStream) -> io::Result<ConnectionEnd> {
    // Clone the stream to get separate reader and writer
    // This avoids deadlock: reader can block while worker threads write results.
    let mut reader = stream.try_clone()?;
    let writer = GuestWriter::new(stream);
    let connection_cancel = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = ConnectionCancelGuard(connection_cancel.clone());

    let mut decoder = vsock_proto::Decoder::new();

    // Send ready signal
    {
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).map_err(to_io_error)?;
        writer.write_frame(&ready)?;
    }
    log("INFO", "Sent ready signal");

    let dispatcher = ConnectionDispatcher::new(writer, connection_cancel.clone());
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
            if dispatcher.dispatch(&msg)? == DispatchOutcome::Shutdown {
                return Ok(ConnectionEnd::Shutdown);
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

fn retry_or_fail(failure: ReconnectFailure, attempts: u32) -> io::Result<()> {
    if attempts >= MAX_RECONNECT_ATTEMPTS {
        return match failure {
            ReconnectFailure::Closed => {
                log(
                    "ERROR",
                    &format!(
                        "Max reconnect attempts ({}) reached",
                        MAX_RECONNECT_ATTEMPTS
                    ),
                );
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "Max reconnect attempts reached",
                ))
            }
            ReconnectFailure::Error(error) => {
                log(
                    "ERROR",
                    &format!(
                        "Max reconnect attempts ({}) reached: {}",
                        MAX_RECONNECT_ATTEMPTS, error
                    ),
                );
                Err(error)
            }
        };
    }

    match failure {
        ReconnectFailure::Closed => {
            log(
                "INFO",
                &format!(
                    "Connection closed, reconnecting ({}/{})...",
                    attempts, MAX_RECONNECT_ATTEMPTS
                ),
            );
        }
        ReconnectFailure::Error(error) => {
            log(
                "WARN",
                &format!(
                    "Connection error: {}, reconnecting ({}/{})...",
                    error, attempts, MAX_RECONNECT_ATTEMPTS
                ),
            );
        }
    }

    thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS));
    Ok(())
}

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
            Ok(ConnectionEnd::Closed) => retry_or_fail(ReconnectFailure::Closed, attempts)?,
            Err(error) => retry_or_fail(ReconnectFailure::Error(error), attempts)?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_closed_failure_returns_connection_reset_when_exhausted() {
        let result = retry_or_fail(ReconnectFailure::Closed, MAX_RECONNECT_ATTEMPTS);

        assert!(result.is_err());
        if let Err(error) = result {
            assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
            assert_eq!(error.to_string(), "Max reconnect attempts reached");
        }
    }

    #[test]
    fn retry_error_failure_returns_original_error_when_exhausted() {
        let result = retry_or_fail(
            ReconnectFailure::Error(io::Error::new(
                io::ErrorKind::TimedOut,
                "connection timed out",
            )),
            MAX_RECONNECT_ATTEMPTS,
        );

        assert!(result.is_err());
        if let Err(error) = result {
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            assert_eq!(error.to_string(), "connection timed out");
        }
    }
}
