use std::collections::{HashMap, VecDeque};
use std::io::{self, Read};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, ControlQuiesceStatus, MSG_BOUNDED_EXEC, MSG_BOUNDED_EXEC_CANCEL, MSG_CONTROL_HELLO,
    MSG_CONTROL_HELLO_ACK, MSG_CONTROL_QUIESCE, MSG_CONTROL_QUIESCE_ACK, MSG_ERROR, MSG_EXEC,
    MSG_EXEC_RESULT, MSG_READY, MSG_SPAWN_WATCH, MSG_WRITE_FILE, RawMessage,
};

use crate::boot::read_boot_generation;
use crate::bounded_exec::{
    BoundedExecCleanup, BoundedExecWorkerRequest, spawn_bounded_exec_worker,
};
use crate::error::to_io_error;
use crate::handlers::{MessageOutcome, handle_exec, handle_message};
use crate::log::log;
use crate::monitor::{SpawnWatchRequest, handle_spawn_watch};
use crate::session::{PendingWorkGuard, PendingWorkSlot, SessionWorkTracker};
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::writer::GuestWriter;

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;
#[cfg(target_os = "linux")]
const VMADDR_CID_ANY: u32 = 0xFFFF_FFFF;

#[cfg(target_os = "linux")]
struct VsockListener {
    fd: OwnedFd,
}

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB
const THREAD_EXEC_WORKER: &str = "vsock-exec-worker";

#[derive(Debug)]
enum ConnectionEnd {
    Closed,
    Shutdown,
}

enum ControlMessageAction {
    Continue,
    CloseSession,
    Shutdown,
}

struct ExecWorkerRequest {
    timeout_ms: u32,
    command: String,
    env: Vec<(String, String)>,
    sudo: bool,
    seq: u32,
}

/// Signals all command work spawned for this host connection when the
/// connection loop exits. `run()` may reconnect after a close, but in-flight
/// commands belong to the old connection and should not survive into the next
/// one.
struct ConnectionCancelGuard(Arc<AtomicBool>);

type BoundedExecCancelMap = Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>;

impl Drop for ConnectionCancelGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn prepare_bounded_exec_cleanup(
    seq: u32,
    bounded_exec_cancels: &BoundedExecCancelMap,
) -> (Arc<AtomicBool>, BoundedExecCleanup) {
    let request_cancel = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = bounded_exec_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = cancels.insert(seq, request_cancel.clone()) {
            previous.store(true, Ordering::Release);
        }
    }

    let cleanup_cancels = Arc::clone(bounded_exec_cancels);
    let cleanup_cancel = Arc::clone(&request_cancel);
    let cleanup: BoundedExecCleanup = Box::new(move || {
        let mut cancels = cleanup_cancels.lock().unwrap_or_else(|e| e.into_inner());
        if cancels
            .get(&seq)
            .is_some_and(|current| Arc::ptr_eq(current, &cleanup_cancel))
        {
            cancels.remove(&seq);
        }
    });

    (request_cancel, cleanup)
}

#[cfg(target_os = "linux")]
fn listen_vsock() -> io::Result<VsockListener> {
    // SAFETY: Creating a vsock socket with valid constants. fd is checked for errors below.
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: vsock_proto::VSOCK_PORT,
        svm_cid: VMADDR_CID_ANY,
        svm_zero: [0; 4],
    };

    // SAFETY: fd is a valid socket from above, addr is initialized, and length
    // matches sockaddr_vm. Errors are handled below.
    let ret = unsafe {
        libc::bind(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if ret < 0 {
        let err = io::Error::last_os_error();
        // SAFETY: fd is open and not owned by a Rust object yet.
        unsafe { libc::close(fd) };
        return Err(err);
    }

    // SAFETY: fd is a valid bound stream socket.
    let ret = unsafe { libc::listen(fd, 16) };
    if ret < 0 {
        let err = io::Error::last_os_error();
        // SAFETY: fd is open and not owned by a Rust object yet.
        unsafe { libc::close(fd) };
        return Err(err);
    }

    // SAFETY: fd is a valid listening stream socket owned by this function.
    Ok(VsockListener {
        fd: unsafe { OwnedFd::from_raw_fd(fd) },
    })
}

#[cfg(target_os = "linux")]
impl VsockListener {
    fn accept(&self) -> io::Result<UnixStream> {
        let mut addr = libc::sockaddr_vm {
            svm_family: 0,
            svm_reserved1: 0,
            svm_port: 0,
            svm_cid: 0,
            svm_zero: [0; 4],
        };
        let mut len = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
        // SAFETY: `addr` and `len` point to valid writable storage for the
        // kernel-reported sockaddr_vm. The returned fd is checked before use.
        let fd = unsafe {
            libc::accept4(
                self.fd.as_raw_fd(),
                &mut addr as *mut libc::sockaddr_vm as *mut libc::sockaddr,
                &mut len,
                libc::SOCK_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: fd is a valid connected stream socket returned by accept4.
        Ok(unsafe { UnixStream::from_raw_fd(fd) })
    }
}

#[cfg(target_os = "linux")]
fn validate_host_peer(stream: &UnixStream) -> io::Result<()> {
    let mut addr = libc::sockaddr_vm {
        svm_family: 0,
        svm_reserved1: 0,
        svm_port: 0,
        svm_cid: 0,
        svm_zero: [0; 4],
    };
    let mut len = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
    // SAFETY: `addr` points to valid writable storage and `len` is initialized
    // to the sockaddr_vm size. getpeername does not retain the pointer.
    let ret = unsafe {
        libc::getpeername(
            stream.as_raw_fd(),
            &mut addr as *mut libc::sockaddr_vm as *mut libc::sockaddr,
            &mut len,
        )
    };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    if addr.svm_family != libc::AF_VSOCK as u16 || addr.svm_cid != VSOCK_CID_HOST {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("unexpected vsock peer cid {}", addr.svm_cid),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn is_recoverable_accept_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Interrupted || error.raw_os_error() == Some(libc::ECONNABORTED)
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
    let bounded_exec_cancels = BoundedExecCancelMap::default();

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
            // Command-style messages run in background threads to avoid
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
                    writer.clone(),
                    connection_cancel.clone(),
                    None,
                )?;
            } else if msg.msg_type == MSG_BOUNDED_EXEC {
                log(
                    "INFO",
                    &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
                );
                let decoded =
                    vsock_proto::decode_bounded_exec(&msg.payload).map_err(to_io_error)?;
                let (request_cancel, cleanup) =
                    prepare_bounded_exec_cleanup(msg.seq, &bounded_exec_cancels);
                spawn_bounded_exec_worker(
                    BoundedExecWorkerRequest::from_decoded(msg.seq, decoded),
                    writer.clone(),
                    connection_cancel.clone(),
                    request_cancel,
                    cleanup,
                    None,
                )?;
            } else if msg.msg_type == MSG_BOUNDED_EXEC_CANCEL {
                if let Some(cancel) = bounded_exec_cancels
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&msg.seq)
                {
                    cancel.store(true, Ordering::Release);
                }
            } else if msg.msg_type == MSG_EXEC {
                // Legacy buffered exec path. New request/response command
                // execution should use MSG_BOUNDED_EXEC.
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
                spawn_exec_worker(
                    ExecWorkerRequest {
                        timeout_ms,
                        command,
                        env,
                        sudo,
                        seq,
                    },
                    writer.clone(),
                    connection_cancel.clone(),
                    None,
                )?;
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

pub fn handle_control_connection(
    stream: UnixStream,
    boot_generation: Option<&str>,
) -> io::Result<()> {
    handle_control_connection_with_outcome(stream, boot_generation).map(|_| ())
}

fn handle_control_connection_with_outcome(
    stream: UnixStream,
    boot_generation: Option<&str>,
) -> io::Result<ConnectionEnd> {
    let mut reader = stream.try_clone()?;
    let writer = GuestWriter::new(stream);
    let connection_cancel = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = ConnectionCancelGuard(connection_cancel.clone());
    let tracker = Arc::new(SessionWorkTracker::default());
    let bounded_exec_cancels = BoundedExecCancelMap::default();

    let mut decoder = vsock_proto::Decoder::new();
    let mut pending = control_handshake(&mut reader, &writer, &mut decoder, boot_generation)?;

    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        while let Some(msg) = pending.pop_front() {
            match handle_control_message(
                &msg,
                &writer,
                &connection_cancel,
                &tracker,
                &bounded_exec_cancels,
            )? {
                ControlMessageAction::Continue => {}
                ControlMessageAction::CloseSession => return Ok(ConnectionEnd::Closed),
                ControlMessageAction::Shutdown => return Ok(ConnectionEnd::Shutdown),
            }
        }

        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }

        pending.extend(
            decoder
                .decode(buf.get(..n).unwrap_or_default())
                .map_err(to_io_error)?,
        );
    }

    log("INFO", "Host disconnected");
    Ok(ConnectionEnd::Closed)
}

fn control_handshake(
    reader: &mut UnixStream,
    writer: &GuestWriter,
    decoder: &mut vsock_proto::Decoder,
    boot_generation: Option<&str>,
) -> io::Result<VecDeque<RawMessage>> {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "host disconnected before control hello",
            ));
        }

        let mut messages = VecDeque::from(
            decoder
                .decode(buf.get(..n).unwrap_or_default())
                .map_err(to_io_error)?,
        );
        let Some(msg) = messages.pop_front() else {
            continue;
        };
        if msg.msg_type != MSG_CONTROL_HELLO {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("expected control hello, got 0x{:02X}", msg.msg_type),
            ));
        }

        let decoded = vsock_proto::decode_control_hello(&msg.payload).map_err(to_io_error)?;
        if decoded.version != vsock_proto::CONTROL_PROTOCOL_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported control protocol version {}", decoded.version),
            ));
        }
        if let Some(provided) = decoded.boot_generation
            && boot_generation != Some(provided)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "control hello boot generation mismatch",
            ));
        }

        let ack_payload = vsock_proto::encode_control_hello_ack(decoded.version, &decoded.nonce);
        let ack = vsock_proto::encode(MSG_CONTROL_HELLO_ACK, msg.seq, &ack_payload)
            .map_err(to_io_error)?;
        writer.write_frame(&ack)?;
        log("INFO", "Control handshake complete");
        return Ok(messages);
    }
}

fn handle_control_message(
    msg: &RawMessage,
    writer: &GuestWriter,
    connection_cancel: &Arc<AtomicBool>,
    tracker: &Arc<SessionWorkTracker>,
    bounded_exec_cancels: &BoundedExecCancelMap,
) -> io::Result<ControlMessageAction> {
    match msg.msg_type {
        MSG_CONTROL_QUIESCE => {
            let status = if tracker.begin_quiesce() {
                ControlQuiesceStatus::Ready
            } else {
                ControlQuiesceStatus::Busy
            };
            let payload = vsock_proto::encode_control_quiesce_ack(status);
            let response = vsock_proto::encode(MSG_CONTROL_QUIESCE_ACK, msg.seq, &payload)
                .map_err(to_io_error)?;
            writer.write_frame(&response)?;
            return Ok(if status == ControlQuiesceStatus::Ready {
                ControlMessageAction::CloseSession
            } else {
                ControlMessageAction::Continue
            });
        }
        MSG_SPAWN_WATCH => {
            let pending = match tracker.begin_work() {
                Ok(pending) => pending,
                Err(e) => {
                    send_error(msg.seq, &e.to_string(), writer)?;
                    return Ok(ControlMessageAction::Continue);
                }
            };
            let d = vsock_proto::decode_spawn_watch(&msg.payload).map_err(to_io_error)?;
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
                writer.clone(),
                connection_cancel.clone(),
                Some(pending),
            )?;
        }
        MSG_BOUNDED_EXEC => {
            let pending = match tracker.begin_work() {
                Ok(pending) => pending,
                Err(e) => {
                    send_error(msg.seq, &e.to_string(), writer)?;
                    return Ok(ControlMessageAction::Continue);
                }
            };
            log(
                "INFO",
                &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
            );
            let decoded = vsock_proto::decode_bounded_exec(&msg.payload).map_err(to_io_error)?;
            let (request_cancel, cleanup) =
                prepare_bounded_exec_cleanup(msg.seq, bounded_exec_cancels);
            spawn_bounded_exec_worker(
                BoundedExecWorkerRequest::from_decoded(msg.seq, decoded),
                writer.clone(),
                connection_cancel.clone(),
                request_cancel,
                cleanup,
                Some(pending),
            )?;
        }
        MSG_BOUNDED_EXEC_CANCEL => {
            if let Some(cancel) = bounded_exec_cancels
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&msg.seq)
            {
                cancel.store(true, Ordering::Release);
            }
        }
        MSG_EXEC => {
            let pending = match tracker.begin_work() {
                Ok(pending) => pending,
                Err(e) => {
                    send_error(msg.seq, &e.to_string(), writer)?;
                    return Ok(ControlMessageAction::Continue);
                }
            };
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
            spawn_exec_worker(
                ExecWorkerRequest {
                    timeout_ms,
                    command,
                    env,
                    sudo: d.sudo,
                    seq: msg.seq,
                },
                writer.clone(),
                connection_cancel.clone(),
                Some(pending),
            )?;
        }
        MSG_WRITE_FILE => {
            let _pending = match tracker.begin_work() {
                Ok(pending) => pending,
                Err(e) => {
                    send_error(msg.seq, &e.to_string(), writer)?;
                    return Ok(ControlMessageAction::Continue);
                }
            };
            if write_message_response(msg, writer)? {
                return Ok(ControlMessageAction::Shutdown);
            }
        }
        _ => {
            if write_message_response(msg, writer)? {
                return Ok(ControlMessageAction::Shutdown);
            }
        }
    }

    Ok(ControlMessageAction::Continue)
}

fn write_message_response(msg: &RawMessage, writer: &GuestWriter) -> io::Result<bool> {
    match handle_message(msg)? {
        MessageOutcome::Response(response) => {
            writer.write_frame(&response)?;
            Ok(false)
        }
        MessageOutcome::Shutdown(response) => {
            if let Err(e) = writer.write_frame(&response) {
                log("WARN", &format!("Failed to send shutdown_ack: {e}"));
            }
            log("INFO", "Shutdown complete, exiting");
            Ok(true)
        }
    }
}

fn send_error(seq: u32, message: &str, writer: &GuestWriter) -> io::Result<()> {
    let payload = vsock_proto::encode_error(message);
    let response = vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&response)
}

fn spawn_exec_worker(
    request: ExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    pending_work: Option<PendingWorkGuard>,
) -> io::Result<()> {
    spawn_exec_worker_with_spawner(
        request,
        writer,
        connection_cancel,
        pending_work,
        SystemThreadSpawner,
    )
}

fn spawn_exec_worker_with_spawner<S>(
    request: ExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    pending_work: Option<PendingWorkGuard>,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let worker_writer = writer.clone();
    let seq = request.seq;
    let pending_slot = PendingWorkSlot::new(pending_work);
    let worker_pending_slot = pending_slot.clone();
    let result = spawner.spawn_unit(
        THREAD_EXEC_WORKER,
        Box::new(move || {
            let _pending_work = worker_pending_slot.take();
            let env_refs: Vec<(&str, &str)> = request
                .env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            let (exit_code, stdout, stderr) = handle_exec(
                request.timeout_ms,
                &request.command,
                &env_refs,
                request.sudo,
                &connection_cancel,
            );
            if let Err(e) = send_exec_result(seq, exit_code, &stdout, &stderr, &worker_writer) {
                log("ERROR", &format!("Failed to send exec_result: {e}"));
            }
        }),
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let stderr = format!("Failed to spawn exec worker thread: {e}");
            let _pending_work = pending_slot.take();
            send_exec_result(seq, 1, &[], stderr.as_bytes(), &writer)
        }
    }
}

fn send_exec_result(
    seq: u32,
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
    writer: &GuestWriter,
) -> io::Result<()> {
    let payload = vsock_proto::encode_exec_result(exit_code, stdout, stderr);
    let encoded = vsock_proto::encode(MSG_EXEC_RESULT, seq, &payload).map_err(to_io_error)?;
    if let Err(e) = writer.write_frame(&encoded) {
        log("ERROR", &format!("Failed to send exec_result: {}", e));
        return Err(e);
    }
    Ok(())
}

/// Maximum reconnection attempts before giving up
const MAX_RECONNECT_ATTEMPTS: u32 = 50;
/// Delay between reconnection attempts (10ms for fast reconnect after snapshot restore)
const RECONNECT_DELAY_MS: u64 = 10;

/// Run the vsock guest control service.
///
/// Production mode listens on the fixed vsock control port. Passing a Unix
/// socket path keeps the legacy guest-initiated handshake available for tests.
pub fn run(unix_socket: Option<&str>) -> io::Result<()> {
    log("INFO", "Starting vsock guest...");

    let Some(path) = unix_socket else {
        return run_vsock_listener();
    };

    let mut attempts = 0u32;

    loop {
        log("INFO", &format!("Connecting to Unix socket: {}...", path));
        let result = connect_unix(path).and_then(|stream| {
            log("INFO", "Connected");
            // Reset attempts on successful connection
            attempts = 0;
            handle_connection_with_outcome(stream)
        });

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

#[cfg(target_os = "linux")]
fn run_vsock_listener() -> io::Result<()> {
    let boot_generation = match read_boot_generation() {
        Ok(value) => value,
        Err(e) => {
            log("WARN", &format!("Failed to read boot generation: {e}"));
            None
        }
    };
    let listener = listen_vsock()?;
    log(
        "INFO",
        &format!(
            "Listening for host control sessions on port {}",
            vsock_proto::VSOCK_PORT
        ),
    );

    loop {
        let stream = match listener.accept() {
            Ok(stream) => stream,
            Err(e) if is_recoverable_accept_error(&e) => {
                log("WARN", &format!("Control session accept error: {e}"));
                continue;
            }
            Err(e) => return Err(e),
        };
        if let Err(e) = validate_host_peer(&stream) {
            log("WARN", &format!("Rejected control session: {e}"));
            continue;
        }

        match handle_control_connection_with_outcome(stream, boot_generation.as_deref()) {
            Ok(ConnectionEnd::Shutdown) => return Ok(()),
            Ok(ConnectionEnd::Closed) => {
                log("INFO", "Control session closed, returning to listen");
            }
            Err(e) => {
                log("WARN", &format!("Control session error: {e}"));
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run_vsock_listener() -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "vsock listener is only supported on Linux",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    fn read_message(stream: &mut UnixStream) -> vsock_proto::RawMessage {
        let mut hdr = [0u8; 4];
        stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).unwrap();

        let mut full = Vec::with_capacity(4 + body_len);
        full.extend_from_slice(&hdr);
        full.extend_from_slice(&body);
        let mut decoder = vsock_proto::Decoder::new();
        let mut messages = decoder.decode(&full).unwrap();
        assert_eq!(messages.len(), 1);
        messages.remove(0)
    }

    fn send_control_hello(stream: &mut UnixStream, seq: u32, boot_generation: Option<&str>) {
        let nonce = *b"0123456789abcdef";
        let payload = vsock_proto::encode_control_hello(
            vsock_proto::CONTROL_PROTOCOL_VERSION,
            &nonce,
            boot_generation,
        )
        .unwrap();
        let frame = vsock_proto::encode(MSG_CONTROL_HELLO, seq, &payload).unwrap();
        stream.write_all(&frame).unwrap();
    }

    fn send_control_quiesce(stream: &mut UnixStream, seq: u32) {
        let frame = vsock_proto::encode(MSG_CONTROL_QUIESCE, seq, &[]).unwrap();
        stream.write_all(&frame).unwrap();
    }

    #[test]
    fn control_connection_accepts_matching_boot_generation_and_quiesces() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let handle =
            thread::spawn(move || handle_control_connection_with_outcome(guest, Some("boot-1")));

        send_control_hello(&mut host, 1, Some("boot-1"));
        let ack = read_message(&mut host);
        assert_eq!(ack.msg_type, MSG_CONTROL_HELLO_ACK);
        assert_eq!(ack.seq, 1);

        send_control_quiesce(&mut host, 2);
        let ack = read_message(&mut host);
        assert_eq!(ack.msg_type, MSG_CONTROL_QUIESCE_ACK);
        assert_eq!(ack.seq, 2);
        assert_eq!(
            vsock_proto::decode_control_quiesce_ack(&ack.payload).unwrap(),
            ControlQuiesceStatus::Ready
        );

        assert!(matches!(
            handle.join().unwrap().unwrap(),
            ConnectionEnd::Closed
        ));
    }

    #[test]
    fn control_connection_accepts_absent_boot_generation_for_restored_session() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let handle =
            thread::spawn(move || handle_control_connection_with_outcome(guest, Some("boot-1")));

        send_control_hello(&mut host, 1, None);
        let ack = read_message(&mut host);
        assert_eq!(ack.msg_type, MSG_CONTROL_HELLO_ACK);
        assert_eq!(ack.seq, 1);

        send_control_quiesce(&mut host, 2);
        let ack = read_message(&mut host);
        assert_eq!(
            vsock_proto::decode_control_quiesce_ack(&ack.payload).unwrap(),
            ControlQuiesceStatus::Ready
        );

        assert!(matches!(
            handle.join().unwrap().unwrap(),
            ConnectionEnd::Closed
        ));
    }

    #[test]
    fn control_connection_rejects_mismatched_boot_generation() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let handle =
            thread::spawn(move || handle_control_connection_with_outcome(guest, Some("boot-1")));

        send_control_hello(&mut host, 1, Some("boot-2"));

        let err = handle.join().unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("boot generation mismatch"));
    }

    #[test]
    fn exec_worker_spawn_failure_returns_exec_result() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);

        spawn_exec_worker_with_spawner(
            ExecWorkerRequest {
                timeout_ms: 0,
                command: "echo should-not-run".to_string(),
                env: Vec::new(),
                sudo: false,
                seq: 42,
            },
            writer,
            Arc::new(AtomicBool::new(false)),
            None,
            FailingThreadSpawner::fail_once(THREAD_EXEC_WORKER),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 42);
        let (code, stdout, stderr) = vsock_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            String::from_utf8_lossy(stderr).contains("exec worker thread"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(stderr),
        );
    }
}
