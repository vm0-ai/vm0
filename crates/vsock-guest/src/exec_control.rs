use std::collections::HashMap;
use std::io;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use process_control_ipc::{ControlRequest, ControlResponseStatus};
use vsock_proto::{ExecControlNonce, ExecControlStatus, MSG_EXEC_CONTROL_RESULT};

use crate::error::to_io_error;
use crate::log::log;
use crate::writer::GuestWriter;

const CONTROL_ACCEPT_POLL_TIMEOUT: Duration = Duration::from_millis(100);
const CONTROL_SINK_IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_CONTROL_REQUESTS: usize = 8;
const EXEC_CONTROL_LOG_NAME: &str = "exec_control";
const EXEC_REQUEST_TIMEOUT_DIAGNOSTIC: &str = "exec control request timed out";
const EXEC_OPERATION_ALREADY_ACTIVE_MESSAGE: &str = "exec operation already active";
const EXEC_OPERATION_INACTIVE_MESSAGE: &str = "exec operation is not active";
const EXEC_OPERATION_NONCE_MISMATCH_MESSAGE: &str = "exec operation nonce mismatch";
const EXEC_CONTROL_SINK_NOT_CONFIGURED_MESSAGE: &str = "exec control sink is not configured";
const EXEC_CONTROL_QUEUE_FULL_MESSAGE: &str = "exec control queue is full";
const EXEC_CONTROL_CLONE_SINK_ERROR_PREFIX: &str = "failed to clone exec control sink";
const EXEC_CONTROL_WORKER_START_ERROR_PREFIX: &str = "failed to start exec control worker";
const EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX: &str = "exec control sink message id mismatch";

const THREAD_EXEC_CONTROL_ACCEPT: &str = "vsock-exec-control-accept";
const THREAD_EXEC_CONTROL_FORWARD: &str = "vsock-exec-control-forward";

#[derive(Clone)]
pub(crate) struct ExecControlRegistry {
    inner: Arc<Mutex<HashMap<u32, ExecControlEntry>>>,
}

impl Default for ExecControlRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct ExecControlEntry {
    nonce: ExecControlNonce,
    sink: Option<Arc<ControlSinkState>>,
}

pub(crate) struct ExecControlRegistration {
    pub(crate) guard: ExecControlGuard,
    pub(crate) bootstrap_endpoint: Option<String>,
}

pub(crate) struct ExecControlGuard {
    registry: ExecControlRegistry,
    seq: u32,
    released: AtomicBool,
}

struct ControlSinkState {
    inner: Mutex<ControlSinkInner>,
    ready: Condvar,
    active: AtomicBool,
    pending: AtomicUsize,
}

struct ConnectedControlSink {
    stream: Arc<ControlStreamState>,
    shutdown: UnixStream,
}

struct ControlStreamState {
    stream: Mutex<UnixStream>,
    locked: Mutex<bool>,
    ready: Condvar,
}

struct ControlStreamGuard<'a> {
    state: &'a ControlStreamState,
    stream: MutexGuard<'a, UnixStream>,
}

enum ControlSinkInner {
    Waiting,
    Handshaking(UnixStream),
    Connected(ConnectedControlSink),
    Failed(String),
    Closed,
}

struct OwnedExecControlRequest {
    response_seq: u32,
    target_seq: u32,
    deadline: Instant,
    control_nonce: ExecControlNonce,
    message_id: String,
    payload: Vec<u8>,
}

struct PendingControlSlot {
    sink: Arc<ControlSinkState>,
}

impl PendingControlSlot {
    fn new(sink: Arc<ControlSinkState>) -> Self {
        Self { sink }
    }
}

impl Drop for PendingControlSlot {
    fn drop(&mut self) {
        self.sink.pending.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ExecControlRegistry {
    pub(crate) fn register(
        &self,
        seq: u32,
        control_nonce: ExecControlNonce,
        control_sink: bool,
    ) -> io::Result<ExecControlRegistration> {
        let (bootstrap_endpoint, accept_sink) = if control_sink {
            let endpoint = process_control_ipc::endpoint_name(seq, &control_nonce);
            let sink = Arc::new(ControlSinkState::new());
            self.insert(
                seq,
                ExecControlEntry {
                    nonce: control_nonce,
                    sink: Some(Arc::clone(&sink)),
                },
            )?;
            (Some(endpoint), Some(sink))
        } else {
            self.insert(
                seq,
                ExecControlEntry {
                    nonce: control_nonce,
                    sink: None,
                },
            )?;
            (None, None)
        };

        let start_result = match (&bootstrap_endpoint, accept_sink) {
            (Some(endpoint), Some(sink)) => start_control_sink_accept_thread(endpoint, sink),
            _ => Ok(()),
        };
        if let Err(error) = start_result {
            self.remove(seq);
            return Err(error);
        }

        Ok(ExecControlRegistration {
            guard: ExecControlGuard {
                registry: self.clone(),
                seq,
                released: AtomicBool::new(false),
            },
            bootstrap_endpoint,
        })
    }

    fn insert(&self, seq: u32, entry: ExecControlEntry) -> io::Result<()> {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&seq) {
            return Err(operation_already_active_error());
        }
        active.insert(seq, entry);
        Ok(())
    }

    fn remove(&self, seq: u32) {
        let entry = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&seq);
        if let Some(entry) = entry {
            entry.close();
        }
    }

    fn resolve(
        &self,
        target_seq: u32,
        control_nonce: ExecControlNonce,
    ) -> Result<Arc<ControlSinkState>, (ExecControlStatus, &'static str)> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = guard.get(&target_seq) else {
            return Err((ExecControlStatus::Inactive, EXEC_OPERATION_INACTIVE_MESSAGE));
        };
        if entry.nonce != control_nonce {
            return Err((
                ExecControlStatus::NonceMismatch,
                EXEC_OPERATION_NONCE_MISMATCH_MESSAGE,
            ));
        }
        let Some(sink) = &entry.sink else {
            return Err((
                ExecControlStatus::Unsupported,
                EXEC_CONTROL_SINK_NOT_CONFIGURED_MESSAGE,
            ));
        };
        Ok(Arc::clone(sink))
    }
}

impl ExecControlEntry {
    fn close(self) {
        if let Some(sink) = self.sink {
            sink.close();
        }
    }
}

fn operation_already_active_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        EXEC_OPERATION_ALREADY_ACTIVE_MESSAGE,
    )
}

fn start_control_sink_accept_thread(endpoint: &str, sink: Arc<ControlSinkState>) -> io::Result<()> {
    let listener = process_control_ipc::bind_abstract_listener(endpoint)?;
    thread::Builder::new()
        .name(THREAD_EXEC_CONTROL_ACCEPT.to_owned())
        .spawn(move || accept_control_sink(listener, sink))?;
    Ok(())
}

impl ExecControlGuard {
    pub(crate) fn release(&self) {
        self.release_once();
    }

    fn release_once(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.registry.remove(self.seq);
        }
    }
}

impl Drop for ExecControlGuard {
    fn drop(&mut self) {
        self.release_once();
    }
}

impl ControlSinkState {
    fn new() -> Self {
        Self {
            inner: Mutex::new(ControlSinkInner::Waiting),
            ready: Condvar::new(),
            active: AtomicBool::new(true),
            pending: AtomicUsize::new(0),
        }
    }

    fn connect(&self, stream: UnixStream) {
        if !self.active.load(Ordering::Acquire) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        }
        let connected = match ConnectedControlSink::new(stream) {
            Ok(connected) => connected,
            Err(error) => {
                let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if !matches!(*guard, ControlSinkInner::Closed) {
                    *guard = ControlSinkInner::Failed(format!(
                        "{}: {error}",
                        EXEC_CONTROL_CLONE_SINK_ERROR_PREFIX
                    ));
                }
                self.ready.notify_all();
                return;
            }
        };
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !self.active.load(Ordering::Acquire) {
            connected.shutdown();
            *guard = ControlSinkInner::Closed;
            self.ready.notify_all();
            return;
        }
        *guard = ControlSinkInner::Connected(connected);
        self.ready.notify_all();
    }

    fn begin_handshake(&self, stream: &UnixStream) -> io::Result<bool> {
        let shutdown = stream.try_clone()?;
        if !self.active.load(Ordering::Acquire) {
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
            return Ok(false);
        }

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !self.active.load(Ordering::Acquire) {
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
            *guard = ControlSinkInner::Closed;
            self.ready.notify_all();
            return Ok(false);
        }
        if !matches!(*guard, ControlSinkInner::Waiting) {
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
            return Ok(false);
        }

        *guard = ControlSinkInner::Handshaking(shutdown);
        self.ready.notify_all();
        Ok(true)
    }

    fn fail(&self, message: String) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        shutdown_sink_stream(&guard);
        {
            if !matches!(*guard, ControlSinkInner::Closed) {
                *guard = ControlSinkInner::Failed(message);
            }
            self.ready.notify_all();
        }
    }

    fn close(&self) {
        self.active.store(false, Ordering::Release);
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        shutdown_sink_stream(&guard);
        *guard = ControlSinkInner::Closed;
        self.ready.notify_all();
    }

    fn wait_for_stream(
        &self,
        deadline: Instant,
    ) -> Result<Arc<ControlStreamState>, (ExecControlStatus, String)> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !self.active.load(Ordering::Acquire) {
                return Err((
                    ExecControlStatus::Inactive,
                    EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                ));
            }
            match &*guard {
                ControlSinkInner::Connected(connected) => return Ok(Arc::clone(&connected.stream)),
                ControlSinkInner::Waiting | ControlSinkInner::Handshaking(_) => {
                    let Some(wait) = duration_until(deadline) else {
                        return Err((
                            ExecControlStatus::SinkTimeout,
                            EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                        ));
                    };
                    let (next_guard, wait_result) = self
                        .ready
                        .wait_timeout(guard, wait)
                        .unwrap_or_else(|e| e.into_inner());
                    guard = next_guard;
                    // A timeout can race with a notify; re-check the condition
                    // unless the request deadline has actually elapsed.
                    if wait_result.timed_out() && duration_until(deadline).is_none() {
                        return Err((
                            ExecControlStatus::SinkTimeout,
                            EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                        ));
                    }
                }
                ControlSinkInner::Failed(message) => {
                    return Err((ExecControlStatus::SinkError, message.clone()));
                }
                ControlSinkInner::Closed => {
                    return Err((
                        ExecControlStatus::Inactive,
                        EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                    ));
                }
            }
        }
    }

    fn try_forward(
        self: &Arc<Self>,
        request: OwnedExecControlRequest,
        writer: GuestWriter,
    ) -> Option<(ExecControlStatus, String)> {
        let pending_slot = match self.reserve_pending_slot() {
            Ok(pending_slot) => pending_slot,
            Err(error) => return Some(error),
        };

        let sink = Arc::clone(self);
        match thread::Builder::new()
            .name(THREAD_EXEC_CONTROL_FORWARD.to_owned())
            .spawn(move || forward_control_request(sink, pending_slot, request, writer))
        {
            Ok(_) => None,
            Err(error) => Some((
                ExecControlStatus::SinkError,
                format!("{}: {error}", EXEC_CONTROL_WORKER_START_ERROR_PREFIX),
            )),
        }
    }

    fn reserve_pending_slot(
        self: &Arc<Self>,
    ) -> Result<PendingControlSlot, (ExecControlStatus, String)> {
        if !self.active.load(Ordering::Acquire) {
            return Err((
                ExecControlStatus::Inactive,
                EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
            ));
        }

        let previous = self.pending.fetch_add(1, Ordering::AcqRel);
        if previous >= MAX_PENDING_CONTROL_REQUESTS {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            return Err((
                ExecControlStatus::QueueFull,
                EXEC_CONTROL_QUEUE_FULL_MESSAGE.to_owned(),
            ));
        }

        Ok(PendingControlSlot::new(Arc::clone(self)))
    }
}

fn shutdown_sink_stream(inner: &ControlSinkInner) {
    match inner {
        ControlSinkInner::Handshaking(stream) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        ControlSinkInner::Connected(connected) => connected.shutdown(),
        ControlSinkInner::Waiting | ControlSinkInner::Failed(_) | ControlSinkInner::Closed => {}
    }
}

impl ConnectedControlSink {
    fn new(stream: UnixStream) -> io::Result<Self> {
        let shutdown = stream.try_clone()?;
        Ok(Self {
            stream: Arc::new(ControlStreamState::new(stream)),
            shutdown,
        })
    }

    fn shutdown(&self) {
        let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
        self.stream.notify_waiters();
    }
}

impl ControlStreamState {
    fn new(stream: UnixStream) -> Self {
        Self {
            stream: Mutex::new(stream),
            locked: Mutex::new(false),
            ready: Condvar::new(),
        }
    }

    fn lock_until(
        &self,
        deadline: Instant,
        active: &AtomicBool,
    ) -> io::Result<ControlStreamGuard<'_>> {
        let mut locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !active.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    EXEC_OPERATION_INACTIVE_MESSAGE,
                ));
            }
            if !*locked {
                *locked = true;
                drop(locked);
                let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
                return Ok(ControlStreamGuard {
                    state: self,
                    stream,
                });
            }
            let Some(wait) = duration_until(deadline) else {
                return Err(request_timeout_error());
            };
            let (next_locked, wait_result) = self
                .ready
                .wait_timeout(locked, wait)
                .unwrap_or_else(|e| e.into_inner());
            locked = next_locked;
            // A timeout can race with unlock notification; re-check the locked
            // flag unless the request deadline has actually elapsed.
            if wait_result.timed_out() && duration_until(deadline).is_none() {
                return Err(request_timeout_error());
            }
        }
    }

    fn notify_waiters(&self) {
        let _locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        self.ready.notify_all();
    }
}

impl std::ops::Deref for ControlStreamGuard<'_> {
    type Target = UnixStream;

    fn deref(&self) -> &Self::Target {
        &self.stream
    }
}

impl std::ops::DerefMut for ControlStreamGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.stream
    }
}

impl Drop for ControlStreamGuard<'_> {
    fn drop(&mut self) {
        let mut locked = self.state.locked.lock().unwrap_or_else(|e| e.into_inner());
        *locked = false;
        self.state.ready.notify_one();
    }
}

fn accept_control_sink(listener: std::os::unix::net::UnixListener, sink: Arc<ControlSinkState>) {
    let result = loop {
        if !sink.active.load(Ordering::Acquire) {
            return;
        }
        match process_control_ipc::accept_with_timeout(&listener, CONTROL_ACCEPT_POLL_TIMEOUT) {
            Ok(mut stream) => {
                match sink.begin_handshake(&stream) {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(error) => break Err(error),
                }
                break stream
                    .set_read_timeout(Some(CONTROL_SINK_IO_TIMEOUT))
                    .and_then(|()| stream.set_write_timeout(Some(CONTROL_SINK_IO_TIMEOUT)))
                    .and_then(|()| process_control_ipc::read_hello(&mut stream))
                    .map(|()| stream);
            }
            Err(error) if is_timeout(&error) => continue,
            Err(error) => break Err(error),
        }
    };
    match result {
        Ok(stream) => {
            log(
                "INFO",
                &format!("{EXEC_CONTROL_LOG_NAME}: control sink connected"),
            );
            sink.connect(stream);
        }
        Err(error) => {
            log(
                "WARN",
                &format!("{EXEC_CONTROL_LOG_NAME}: control sink accept failed: {error}"),
            );
            sink.fail(error.to_string());
        }
    }
}

fn forward_control_request(
    sink: Arc<ControlSinkState>,
    _pending_slot: PendingControlSlot,
    request: OwnedExecControlRequest,
    writer: GuestWriter,
) {
    let OwnedExecControlRequest {
        response_seq,
        target_seq,
        deadline,
        control_nonce,
        message_id,
        payload,
    } = request;
    let (status, diagnostic, mark_failed) = {
        match sink.wait_for_stream(deadline) {
            Ok(stream) => match stream.lock_until(deadline, &sink.active) {
                Ok(mut stream) => {
                    if !sink.active.load(Ordering::Acquire) {
                        (
                            ExecControlStatus::Inactive,
                            EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                            false,
                        )
                    } else if request_expired(deadline) {
                        (
                            ExecControlStatus::SinkTimeout,
                            EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                            false,
                        )
                    } else {
                        forward_to_connected_sink(&mut stream, &message_id, payload, deadline)
                    }
                }
                Err(error) if is_timeout(&error) => {
                    (ExecControlStatus::SinkTimeout, error.to_string(), false)
                }
                Err(error) => (ExecControlStatus::SinkError, error.to_string(), false),
            },
            Err((status, diagnostic)) => (status, diagnostic, false),
        }
    };

    if mark_failed {
        sink.fail(diagnostic.clone());
    }

    let result = writer.write_generated_frame_after_lock(|| {
        let (status, diagnostic) = if sink.active.load(Ordering::Acquire) {
            (status, diagnostic.as_str())
        } else {
            (ExecControlStatus::Inactive, EXEC_OPERATION_INACTIVE_MESSAGE)
        };
        let result_payload =
            encode_control_result(target_seq, control_nonce, &message_id, status, diagnostic)
                .map_err(to_io_error)?;
        vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, response_seq, &result_payload)
            .map_err(to_io_error)
    });
    if let Err(error) = result {
        log(
            "WARN",
            &format!("{EXEC_CONTROL_LOG_NAME}: failed to send control result: {error}"),
        );
    }
}

fn forward_to_connected_sink(
    stream: &mut UnixStream,
    message_id: &str,
    payload: Vec<u8>,
    deadline: Instant,
) -> (ExecControlStatus, String, bool) {
    let request_frame = ControlRequest {
        message_id: message_id.to_owned(),
        payload,
    };
    let write_timeout = match control_sink_io_timeout(deadline) {
        Ok(timeout) => timeout,
        Err(error) if is_timeout(&error) => {
            return return_control_result(ExecControlStatus::SinkTimeout, error, false);
        }
        Err(error) => return return_control_result(ExecControlStatus::SinkError, error, false),
    };
    if let Err(error) = write_control_request(stream, &request_frame, write_timeout) {
        return if is_timeout(&error) {
            return_control_result(ExecControlStatus::SinkTimeout, error, true)
        } else {
            return_control_result(ExecControlStatus::SinkError, error, true)
        };
    }

    let read_timeout = match control_sink_io_timeout(deadline) {
        Ok(timeout) => timeout,
        Err(error) if is_timeout(&error) => {
            return return_control_result(ExecControlStatus::SinkTimeout, error, true);
        }
        Err(error) => return return_control_result(ExecControlStatus::SinkError, error, true),
    };
    match read_control_response(stream, read_timeout) {
        Ok(response) if response.message_id != message_id => (
            ExecControlStatus::SinkError,
            format!(
                "{}: expected {}, got {}",
                EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX, message_id, response.message_id
            ),
            true,
        ),
        Ok(response) => match response.status {
            ControlResponseStatus::Accepted => {
                (ExecControlStatus::Delivered, response.diagnostic, false)
            }
            ControlResponseStatus::Rejected => {
                (ExecControlStatus::Rejected, response.diagnostic, false)
            }
            ControlResponseStatus::Error => {
                (ExecControlStatus::SinkError, response.diagnostic, false)
            }
        },
        Err(error) if is_timeout(&error) => {
            (ExecControlStatus::SinkTimeout, error.to_string(), true)
        }
        Err(error) => (ExecControlStatus::SinkError, error.to_string(), true),
    }
}

fn return_control_result(
    status: ExecControlStatus,
    error: io::Error,
    mark_failed: bool,
) -> (ExecControlStatus, String, bool) {
    (status, error.to_string(), mark_failed)
}

fn request_deadline(request_timeout_ms: u32) -> Instant {
    Instant::now()
        .checked_add(Duration::from_millis(u64::from(request_timeout_ms)))
        .unwrap_or_else(Instant::now)
}

fn request_expired(deadline: Instant) -> bool {
    duration_until(deadline).is_none()
}

fn duration_until(deadline: Instant) -> Option<Duration> {
    let now = Instant::now();
    (now < deadline).then(|| deadline.duration_since(now))
}

fn control_sink_io_timeout(deadline: Instant) -> io::Result<Duration> {
    duration_until(deadline)
        .map(|remaining| remaining.min(CONTROL_SINK_IO_TIMEOUT))
        .filter(|timeout| !timeout.is_zero())
        .ok_or_else(request_timeout_error)
}

fn request_timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC)
}

fn write_control_request(
    stream: &mut UnixStream,
    request: &ControlRequest,
    timeout: Duration,
) -> io::Result<()> {
    stream.set_write_timeout(Some(timeout))?;
    process_control_ipc::write_request(stream, request)
}

fn read_control_response(
    stream: &mut UnixStream,
    timeout: Duration,
) -> io::Result<process_control_ipc::ControlResponse> {
    stream.set_read_timeout(Some(timeout))?;
    process_control_ipc::read_response(stream)
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

fn encode_control_result(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
) -> Result<Vec<u8>, vsock_proto::ProtocolError> {
    vsock_proto::encode_exec_control_result(
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    )
}

pub(crate) fn handle_exec_control(
    seq: u32,
    payload: &[u8],
    registry: &ExecControlRegistry,
    writer: &GuestWriter,
) -> io::Result<()> {
    let request = vsock_proto::decode_exec_control(payload).map_err(to_io_error)?;
    let owned = OwnedExecControlRequest {
        response_seq: seq,
        target_seq: request.target_seq,
        deadline: request_deadline(request.request_timeout_ms),
        control_nonce: request.control_nonce,
        message_id: request.message_id.to_owned(),
        payload: request.payload.to_vec(),
    };

    let immediate = match registry.resolve(owned.target_seq, owned.control_nonce) {
        Ok(sink) => sink.try_forward(owned, writer.clone()),
        Err((status, diagnostic)) => Some((status, diagnostic.to_owned())),
    };

    if let Some((status, diagnostic)) = immediate {
        writer.write_generated_frame_after_lock(|| {
            let result_payload = encode_control_result(
                request.target_seq,
                request.control_nonce,
                request.message_id,
                status,
                &diagnostic,
            )
            .map_err(to_io_error)?;
            vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, seq, &result_payload).map_err(to_io_error)
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    const NONCE: ExecControlNonce = *b"0123456789abcdef";

    fn unique_test_nonce(seed: u64) -> ExecControlNonce {
        let mut nonce = [0u8; 16];
        nonce[..8].copy_from_slice(&u64::from(std::process::id()).to_be_bytes());
        nonce[8..].copy_from_slice(&seed.to_be_bytes());
        nonce
    }

    fn resolve_error(
        registry: &ExecControlRegistry,
        target_seq: u32,
        nonce: ExecControlNonce,
    ) -> (ExecControlStatus, &'static str) {
        match registry.resolve(target_seq, nonce) {
            Ok(_) => panic!("expected exec control resolve to fail"),
            Err(error) => error,
        }
    }

    fn read_exec_control_result(
        stream: &mut UnixStream,
    ) -> (u8, u32, ExecControlStatus, String, String) {
        let mut hdr = [0u8; 4];
        stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).unwrap();
        let mut full = Vec::with_capacity(4 + body_len);
        full.extend_from_slice(&hdr);
        full.extend_from_slice(&body);
        let mut decoder = vsock_proto::Decoder::new();
        let messages = decoder.decode(&full).unwrap();
        assert_eq!(messages.len(), 1);
        let result = vsock_proto::decode_exec_control_result(&messages[0].payload).unwrap();
        (
            messages[0].msg_type,
            messages[0].seq,
            result.status,
            result.message_id.to_owned(),
            result.diagnostic.to_owned(),
        )
    }

    #[test]
    fn registered_operation_rejects_nonce_mismatch() {
        let registry = ExecControlRegistry::default();
        let _registration = registry.register(7, NONCE, false).unwrap();
        let wrong_nonce = *b"fedcba9876543210";

        let (status, diagnostic) = resolve_error(&registry, 7, wrong_nonce);

        assert_eq!(status, ExecControlStatus::NonceMismatch);
        assert_eq!(diagnostic, "exec operation nonce mismatch");
    }

    #[test]
    fn released_operation_is_inactive() {
        let registry = ExecControlRegistry::default();
        let registration = registry.register(7, NONCE, false).unwrap();

        registration.guard.release();
        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);

        assert_eq!(status, ExecControlStatus::Inactive);
        assert_eq!(diagnostic, "exec operation is not active");
    }

    #[test]
    fn dropped_operation_allows_sequence_reuse() {
        let registry = ExecControlRegistry::default();
        {
            let _registration = registry.register(7, NONCE, false).unwrap();
            assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
        }

        assert!(registry.register(7, NONCE, false).is_ok());
    }

    #[test]
    fn dropped_operation_closes_control_sink() {
        let nonce = unique_test_nonce(20);
        let registry = ExecControlRegistry::default();
        let registration = registry.register(20, nonce, true).unwrap();
        let sink = registry.resolve(20, nonce).unwrap();

        drop(registration);

        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Closed
        ));
        let (status, diagnostic) = resolve_error(&registry, 20, nonce);
        assert_eq!(status, ExecControlStatus::Inactive);
        assert_eq!(diagnostic, "exec operation is not active");
    }

    #[test]
    fn dropped_operation_closes_connected_control_sink() {
        let nonce = unique_test_nonce(19);
        let registry = ExecControlRegistry::default();
        let registration = registry.register(19, nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let sink = registry.resolve(19, nonce).unwrap();
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();

        let mut guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !matches!(&*guard, ControlSinkInner::Connected(_)) {
            let now = Instant::now();
            assert!(now < deadline, "control sink should connect after hello");
            let (next_guard, _) = sink
                .ready
                .wait_timeout(guard, deadline.duration_since(now))
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;
        }
        drop(guard);

        drop(registration);

        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Closed
        ));
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let error = process_control_ipc::read_request(&mut stream).unwrap_err();
        assert!(
            !is_timeout(&error),
            "operation drop should interrupt the connected control sink stream"
        );
    }

    #[test]
    fn valid_operation_without_sink_is_unsupported() {
        let registry = ExecControlRegistry::default();
        let _registration = registry.register(7, NONCE, false).unwrap();

        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);

        assert_eq!(status, ExecControlStatus::Unsupported);
        assert_eq!(diagnostic, "exec control sink is not configured");
    }

    #[test]
    fn duplicate_active_sequence_is_rejected_until_guard_releases() {
        let registry = ExecControlRegistry::default();
        let first = registry.register(7, NONCE, false).unwrap();

        assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
        assert_eq!(status, ExecControlStatus::Unsupported);
        assert_eq!(diagnostic, "exec control sink is not configured");

        first.guard.release();
        assert!(registry.register(7, NONCE, false).is_ok());
    }

    #[test]
    fn released_guard_drop_does_not_remove_reused_sequence() {
        let registry = ExecControlRegistry::default();
        let first = registry.register(7, NONCE, false).unwrap();

        first.guard.release();
        let _second = registry.register(7, NONCE, false).unwrap();
        drop(first);

        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
        assert_eq!(status, ExecControlStatus::Unsupported);
        assert_eq!(diagnostic, "exec control sink is not configured");
        assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
    }

    #[test]
    fn second_release_does_not_remove_reused_sequence() {
        let registry = ExecControlRegistry::default();
        let first = registry.register(7, NONCE, false).unwrap();

        first.guard.release();
        let _second = registry.register(7, NONCE, false).unwrap();
        first.guard.release();

        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
        assert_eq!(status, ExecControlStatus::Unsupported);
        assert_eq!(diagnostic, "exec control sink is not configured");
        assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
    }

    #[test]
    fn duplicate_control_sink_sequence_is_rejected_without_rebinding_endpoint() {
        let sink_nonce = unique_test_nonce(14);

        let registry = ExecControlRegistry::default();
        let first = registry.register(14, sink_nonce, true).unwrap();

        let error = match registry.register(14, sink_nonce, true) {
            Ok(_) => panic!("expected duplicate exec control registration to fail"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(error.to_string(), "exec operation already active");
        assert!(registry.resolve(14, sink_nonce).is_ok());

        first.guard.release();
    }

    #[test]
    fn control_sink_registration_exports_bootstrap_endpoint() {
        let nonce = unique_test_nonce(7);
        let registry = ExecControlRegistry::default();
        let registration = registry.register(7, nonce, true).unwrap();

        assert!(registration.bootstrap_endpoint.is_some());
        assert!(registry.resolve(7, nonce).is_ok());
    }

    #[test]
    fn handle_exec_control_forwards_to_connected_sink() {
        let forward_nonce = unique_test_nonce(8);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(8, forward_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
            process_control_ipc::write_hello(&mut stream).unwrap();
            let request = process_control_ipc::read_request(&mut stream).unwrap();
            assert_eq!(request.message_id, "msg-1");
            assert_eq!(request.payload, b"payload");
            process_control_ipc::write_response(
                &mut stream,
                &process_control_ipc::ControlResponse {
                    message_id: request.message_id,
                    status: process_control_ipc::ControlResponseStatus::Accepted,
                    diagnostic: String::new(),
                },
            )
            .unwrap();
        });

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_exec_control(8, forward_nonce, "msg-1", b"payload", 5000).unwrap();

        handle_exec_control(11, &payload, &registry, &writer).unwrap();

        let (msg_type, seq, status, message_id, _) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 11);
        assert_eq!(status, ExecControlStatus::Delivered);
        assert_eq!(message_id, "msg-1");

        client.join().unwrap();
    }

    #[test]
    fn handle_exec_control_waits_for_sink_connection() {
        let forward_nonce = unique_test_nonce(9);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(9, forward_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_exec_control(9, forward_nonce, "msg-1", b"payload", 5000).unwrap();

        handle_exec_control(11, &payload, &registry, &writer).unwrap();

        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();
        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-1");
        assert_eq!(request.payload, b"payload");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();

        let (msg_type, seq, status, message_id, _) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 11);
        assert_eq!(status, ExecControlStatus::Delivered);
        assert_eq!(message_id, "msg-1");
    }

    #[test]
    fn pending_exec_control_timeout_before_sink_connection_releases_slot() {
        let sink = Arc::new(ControlSinkState::new());
        let pending_slot = sink.reserve_pending_slot().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        forward_control_request(
            Arc::clone(&sink),
            pending_slot,
            OwnedExecControlRequest {
                response_seq: 29,
                target_seq: 19,
                deadline: request_deadline(0),
                control_nonce: NONCE,
                message_id: "msg-timeout".to_owned(),
                payload: b"payload".to_vec(),
            },
            GuestWriter::new(guest),
        );

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 29);
        assert_eq!(status, ExecControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-timeout");
        assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn timeout_before_sink_connection_does_not_poison_later_delivery() {
        let forward_nonce = unique_test_nonce(16);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(16, forward_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload = vsock_proto::encode_exec_control(
            16,
            forward_nonce,
            "msg-before-connect",
            b"payload",
            0,
        )
        .unwrap();

        handle_exec_control(41, &payload, &registry, &writer).unwrap();
        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 41);
        assert_eq!(status, ExecControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-before-connect");
        assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);

        let client = std::thread::spawn(move || {
            let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
            process_control_ipc::write_hello(&mut stream).unwrap();
            let request = process_control_ipc::read_request(&mut stream).unwrap();
            assert_eq!(request.message_id, "msg-after-timeout");
            assert_eq!(request.payload, b"payload");
            process_control_ipc::write_response(
                &mut stream,
                &process_control_ipc::ControlResponse {
                    message_id: request.message_id,
                    status: process_control_ipc::ControlResponseStatus::Accepted,
                    diagnostic: String::new(),
                },
            )
            .unwrap();
        });

        let payload = vsock_proto::encode_exec_control(
            16,
            forward_nonce,
            "msg-after-timeout",
            b"payload",
            5000,
        )
        .unwrap();
        handle_exec_control(42, &payload, &registry, &writer).unwrap();
        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 42);
        assert_eq!(status, ExecControlStatus::Delivered);
        assert_eq!(message_id, "msg-after-timeout");
        assert_eq!(diagnostic, "");

        client.join().unwrap();
    }

    #[test]
    fn non_terminal_control_responses_do_not_close_sink() {
        let forward_nonce = unique_test_nonce(11);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(11, forward_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
            process_control_ipc::write_hello(&mut stream).unwrap();

            let request = process_control_ipc::read_request(&mut stream).unwrap();
            assert_eq!(request.message_id, "msg-rejected");
            process_control_ipc::write_response(
                &mut stream,
                &process_control_ipc::ControlResponse {
                    message_id: request.message_id,
                    status: process_control_ipc::ControlResponseStatus::Rejected,
                    diagnostic: "denied".to_owned(),
                },
            )
            .unwrap();

            let request = process_control_ipc::read_request(&mut stream).unwrap();
            assert_eq!(request.message_id, "msg-error");
            process_control_ipc::write_response(
                &mut stream,
                &process_control_ipc::ControlResponse {
                    message_id: request.message_id,
                    status: process_control_ipc::ControlResponseStatus::Error,
                    diagnostic: "temporary error".to_owned(),
                },
            )
            .unwrap();

            let request = process_control_ipc::read_request(&mut stream).unwrap();
            assert_eq!(request.message_id, "msg-after-error");
            process_control_ipc::write_response(
                &mut stream,
                &process_control_ipc::ControlResponse {
                    message_id: request.message_id,
                    status: process_control_ipc::ControlResponseStatus::Accepted,
                    diagnostic: String::new(),
                },
            )
            .unwrap();
        });

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);

        let payload =
            vsock_proto::encode_exec_control(11, forward_nonce, "msg-rejected", b"payload", 5000)
                .unwrap();
        handle_exec_control(21, &payload, &registry, &writer).unwrap();
        let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(seq, 21);
        assert_eq!(status, ExecControlStatus::Rejected);
        assert_eq!(message_id, "msg-rejected");
        assert_eq!(diagnostic, "denied");

        let payload =
            vsock_proto::encode_exec_control(11, forward_nonce, "msg-error", b"payload", 5000)
                .unwrap();
        handle_exec_control(22, &payload, &registry, &writer).unwrap();
        let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(seq, 22);
        assert_eq!(status, ExecControlStatus::SinkError);
        assert_eq!(message_id, "msg-error");
        assert_eq!(diagnostic, "temporary error");

        let payload = vsock_proto::encode_exec_control(
            11,
            forward_nonce,
            "msg-after-error",
            b"payload",
            5000,
        )
        .unwrap();
        handle_exec_control(23, &payload, &registry, &writer).unwrap();
        let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(seq, 23);
        assert_eq!(status, ExecControlStatus::Delivered);
        assert_eq!(message_id, "msg-after-error");
        assert_eq!(diagnostic, "");

        client.join().unwrap();
    }

    #[test]
    fn pending_exec_control_returns_inactive_when_operation_releases() {
        let forward_nonce = unique_test_nonce(10);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(10, forward_nonce, true).unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_exec_control(10, forward_nonce, "msg-release", b"payload", 5000)
                .unwrap();

        handle_exec_control(13, &payload, &registry, &writer).unwrap();
        registration.guard.release();

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 13);
        assert_eq!(status, ExecControlStatus::Inactive);
        assert_eq!(message_id, "msg-release");
        assert_eq!(diagnostic, "exec operation is not active");
    }

    #[test]
    fn pending_exec_control_returns_inactive_when_operation_drops() {
        let forward_nonce = unique_test_nonce(17);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(17, forward_nonce, true).unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_exec_control(17, forward_nonce, "msg-drop", b"payload", 5000)
                .unwrap();

        handle_exec_control(33, &payload, &registry, &writer).unwrap();
        drop(registration);

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 33);
        assert_eq!(status, ExecControlStatus::Inactive);
        assert_eq!(message_id, "msg-drop");
        assert_eq!(diagnostic, "exec operation is not active");
    }

    #[test]
    fn exec_control_queue_full_rejects_without_leaking_pending_slots() {
        let sink = Arc::new(ControlSinkState::new());
        let (guest, _host) = UnixStream::pair().unwrap();
        let writer = GuestWriter::new(guest);
        let mut pending_slots = Vec::new();

        for _ in 0..MAX_PENDING_CONTROL_REQUESTS {
            pending_slots.push(sink.reserve_pending_slot().unwrap());
        }
        assert_eq!(
            sink.pending.load(Ordering::Acquire),
            MAX_PENDING_CONTROL_REQUESTS
        );

        let immediate = sink
            .try_forward(
                OwnedExecControlRequest {
                    response_seq: 199,
                    target_seq: 12,
                    deadline: request_deadline(5000),
                    control_nonce: NONCE,
                    message_id: "msg-overflow".to_owned(),
                    payload: b"payload".to_vec(),
                },
                writer,
            )
            .expect("overflow request should be rejected synchronously");
        assert_eq!(immediate.0, ExecControlStatus::QueueFull);
        assert_eq!(immediate.1, "exec control queue is full");
        assert_eq!(
            sink.pending.load(Ordering::Acquire),
            MAX_PENDING_CONTROL_REQUESTS
        );

        drop(pending_slots);
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn pending_control_slot_holds_existing_slot_until_drop() {
        let sink = Arc::new(ControlSinkState::new());

        {
            let _slot = sink.reserve_pending_slot().unwrap();
            assert_eq!(sink.pending.load(Ordering::Acquire), 1);
        }

        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn pending_control_slot_releases_when_result_send_fails() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let pending_slot = sink.reserve_pending_slot().unwrap();

        let client = std::thread::spawn(move || {
            let mut peer = peer;
            let request = process_control_ipc::read_request(&mut peer).unwrap();
            process_control_ipc::write_response(
                &mut peer,
                &process_control_ipc::ControlResponse {
                    message_id: request.message_id,
                    status: process_control_ipc::ControlResponseStatus::Accepted,
                    diagnostic: String::new(),
                },
            )
            .unwrap();
        });

        let (guest, host) = UnixStream::pair().unwrap();
        drop(host);
        forward_control_request(
            Arc::clone(&sink),
            pending_slot,
            OwnedExecControlRequest {
                response_seq: 12,
                target_seq: 8,
                deadline: request_deadline(5000),
                control_nonce: NONCE,
                message_id: "msg-send-fails".to_owned(),
                payload: b"payload".to_vec(),
            },
            GuestWriter::new(guest),
        );

        client.join().unwrap();
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn mismatched_control_response_message_id_marks_sink_failed() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let pending_slot = sink.reserve_pending_slot().unwrap();

        let client = std::thread::spawn(move || {
            let mut peer = peer;
            let request = process_control_ipc::read_request(&mut peer).unwrap();
            assert_eq!(request.message_id, "msg-original");
            process_control_ipc::write_response(
                &mut peer,
                &process_control_ipc::ControlResponse {
                    message_id: "msg-other".to_owned(),
                    status: process_control_ipc::ControlResponseStatus::Accepted,
                    diagnostic: String::new(),
                },
            )
            .unwrap();
        });

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        forward_control_request(
            Arc::clone(&sink),
            pending_slot,
            OwnedExecControlRequest {
                response_seq: 12,
                target_seq: 8,
                deadline: request_deadline(5000),
                control_nonce: NONCE,
                message_id: "msg-original".to_owned(),
                payload: b"payload".to_vec(),
            },
            GuestWriter::new(guest),
        );

        client.join().unwrap();
        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 12);
        assert_eq!(status, ExecControlStatus::SinkError);
        assert_eq!(message_id, "msg-original");
        assert_eq!(
            diagnostic,
            "exec control sink message id mismatch: expected msg-original, got msg-other"
        );
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Failed(_)
        ));
    }

    #[test]
    fn timed_out_control_sink_is_marked_failed() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let pending_slot = sink.reserve_pending_slot().unwrap();
        let (request_read_tx, request_read_rx) = std::sync::mpsc::channel();
        let (release_peer_tx, release_peer_rx) = std::sync::mpsc::channel();
        let client = std::thread::spawn(move || {
            let mut peer = peer;
            let request = process_control_ipc::read_request(&mut peer).unwrap();
            assert_eq!(request.message_id, "msg-timeout");
            assert_eq!(request.payload, b"payload");
            request_read_tx.send(()).unwrap();
            let _ = release_peer_rx.recv_timeout(Duration::from_secs(3));
        });

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                forward_control_request(
                    sink,
                    pending_slot,
                    OwnedExecControlRequest {
                        response_seq: 12,
                        target_seq: 8,
                        deadline: request_deadline(250),
                        control_nonce: NONCE,
                        message_id: "msg-timeout".to_owned(),
                        payload: b"payload".to_vec(),
                    },
                    GuestWriter::new(guest),
                );
            }
        });

        request_read_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("control request should be delivered before response timeout");

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        worker.join().unwrap();
        let _ = release_peer_tx.send(());
        client.join().unwrap();

        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 12);
        assert_eq!(status, ExecControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-timeout");
        assert!(!diagnostic.is_empty());
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Failed(_)
        ));
    }

    #[test]
    fn failed_control_sink_handshake_returns_sink_error() {
        let forward_nonce = unique_test_nonce(13);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(13, forward_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let sink = registry.resolve(13, forward_nonce).unwrap();

        let stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        drop(stream);

        let mut guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !matches!(&*guard, ControlSinkInner::Failed(_)) {
            let now = Instant::now();
            assert!(
                now < deadline,
                "control sink should mark failed when peer disconnects before hello"
            );
            let (next_guard, _) = sink
                .ready
                .wait_timeout(guard, deadline.duration_since(now))
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;
        }
        drop(guard);

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload = vsock_proto::encode_exec_control(
            13,
            forward_nonce,
            "msg-handshake-failed",
            b"payload",
            5000,
        )
        .unwrap();

        handle_exec_control(31, &payload, &registry, &writer).unwrap();

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 31);
        assert_eq!(status, ExecControlStatus::SinkError);
        assert_eq!(message_id, "msg-handshake-failed");
        assert!(!diagnostic.is_empty());
    }

    #[test]
    fn operation_release_interrupts_control_sink_handshake() {
        let handshake_nonce = unique_test_nonce(15);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(15, handshake_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let sink = registry.resolve(15, handshake_nonce).unwrap();
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();

        let mut guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !matches!(&*guard, ControlSinkInner::Handshaking(_)) {
            let now = Instant::now();
            assert!(
                now < deadline,
                "control sink should enter handshaking after accept"
            );
            let (next_guard, _) = sink
                .ready
                .wait_timeout(guard, deadline.duration_since(now))
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;
        }
        drop(guard);

        registration.guard.release();

        let guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
        assert!(matches!(*guard, ControlSinkInner::Closed));
        drop(guard);

        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let error = process_control_ipc::read_request(&mut stream).unwrap_err();
        assert!(
            !is_timeout(&error),
            "operation release should interrupt the accepted handshake stream"
        );
    }

    #[test]
    fn operation_drop_interrupts_control_sink_handshake() {
        let handshake_nonce = unique_test_nonce(18);

        let registry = ExecControlRegistry::default();
        let registration = registry.register(18, handshake_nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let sink = registry.resolve(18, handshake_nonce).unwrap();
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();

        let mut guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !matches!(&*guard, ControlSinkInner::Handshaking(_)) {
            let now = Instant::now();
            assert!(
                now < deadline,
                "control sink should enter handshaking after accept"
            );
            let (next_guard, _) = sink
                .ready
                .wait_timeout(guard, deadline.duration_since(now))
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;
        }
        drop(guard);

        drop(registration);

        let guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
        assert!(matches!(*guard, ControlSinkInner::Closed));
        drop(guard);

        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let error = process_control_ipc::read_request(&mut stream).unwrap_err();
        assert!(
            !is_timeout(&error),
            "operation drop should interrupt the accepted handshake stream"
        );
    }

    #[test]
    fn close_does_not_wait_for_busy_control_stream_lock() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, _peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let stream = match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
            ControlSinkInner::Connected(connected) => Arc::clone(&connected.stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream
            .lock_until(request_deadline(5000), &sink.active)
            .unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();

        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                sink.close();
                done_tx.send(()).unwrap();
            }
        });

        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("close should not wait for the control stream lock");
        drop(stream_guard);
        worker.join().unwrap();

        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Closed
        ));
    }

    #[test]
    fn fail_does_not_wait_for_busy_control_stream_lock() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, _peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let stream = match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
            ControlSinkInner::Connected(connected) => Arc::clone(&connected.stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream
            .lock_until(request_deadline(5000), &sink.active)
            .unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();

        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                sink.fail("failed".to_owned());
                done_tx.send(()).unwrap();
            }
        });

        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("fail should not wait for the control stream lock");
        drop(stream_guard);
        worker.join().unwrap();

        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Failed(_)
        ));
    }

    #[test]
    fn queued_control_request_is_not_delivered_after_close() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, mut peer) = UnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        sink.connect(stream);
        let stream = match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
            ControlSinkInner::Connected(connected) => Arc::clone(&connected.stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream
            .lock_until(request_deadline(5000), &sink.active)
            .unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        let pending_slot = sink.reserve_pending_slot().unwrap();
        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                forward_control_request(
                    sink,
                    pending_slot,
                    OwnedExecControlRequest {
                        response_seq: 17,
                        target_seq: 9,
                        deadline: request_deadline(5000),
                        control_nonce: NONCE,
                        message_id: "msg-after-close".to_owned(),
                        payload: b"payload".to_vec(),
                    },
                    GuestWriter::new(guest),
                );
            }
        });

        sink.close();

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 17);
        assert_eq!(status, ExecControlStatus::Inactive);
        assert_eq!(message_id, "msg-after-close");
        assert_eq!(diagnostic, "exec operation is not active");
        worker.join().unwrap();
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
        drop(stream_guard);

        let err = process_control_ipc::read_request(&mut peer).unwrap_err();
        assert!(matches!(
            err.kind(),
            io::ErrorKind::WouldBlock
                | io::ErrorKind::UnexpectedEof
                | io::ErrorKind::ConnectionReset
        ));
    }

    #[test]
    fn expired_connected_control_request_is_not_delivered() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, mut peer) = UnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        sink.connect(stream);
        let stream = match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
            ControlSinkInner::Connected(connected) => Arc::clone(&connected.stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream
            .lock_until(request_deadline(5000), &sink.active)
            .unwrap();
        let pending_slot = sink.reserve_pending_slot().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                forward_control_request(
                    sink,
                    pending_slot,
                    OwnedExecControlRequest {
                        response_seq: 19,
                        target_seq: 9,
                        deadline: request_deadline(0),
                        control_nonce: NONCE,
                        message_id: "msg-expired-behind-lock".to_owned(),
                        payload: b"payload".to_vec(),
                    },
                    GuestWriter::new(guest),
                );
            }
        });

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        worker.join().unwrap();

        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 19);
        assert_eq!(status, ExecControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-expired-behind-lock");
        assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
        assert!(matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Connected(_)
        ));

        let err = process_control_ipc::read_request(&mut peer).unwrap_err();
        assert!(matches!(
            err.kind(),
            io::ErrorKind::WouldBlock
                | io::ErrorKind::UnexpectedEof
                | io::ErrorKind::ConnectionReset
        ));
        drop(stream_guard);
    }

    #[test]
    fn close_interrupts_inflight_control_request() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, mut peer) = UnixStream::pair().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        sink.connect(stream);
        let pending_slot = sink.reserve_pending_slot().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();

        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                forward_control_request(
                    sink,
                    pending_slot,
                    OwnedExecControlRequest {
                        response_seq: 18,
                        target_seq: 9,
                        deadline: request_deadline(5000),
                        control_nonce: NONCE,
                        message_id: "msg-inflight-close".to_owned(),
                        payload: b"payload".to_vec(),
                    },
                    GuestWriter::new(guest),
                );
                done_tx.send(()).unwrap();
            }
        });

        let request = process_control_ipc::read_request(&mut peer).unwrap();
        assert_eq!(request.message_id, "msg-inflight-close");

        sink.close();
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("close should interrupt an in-flight control read");
        worker.join().unwrap();

        let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
        assert_eq!(seq, 18);
        assert_eq!(status, ExecControlStatus::Inactive);
        assert_eq!(message_id, "msg-inflight-close");
        assert_eq!(diagnostic, "exec operation is not active");
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }
}
