use std::collections::HashMap;
use std::io;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use process_control_ipc::{ControlRequest, ControlResponseStatus};
use vsock_proto::{MSG_PROCESS_CONTROL_RESULT, ProcessControlNonce, ProcessControlStatus};

use crate::error::to_io_error;
use crate::log::log;
use crate::writer::GuestWriter;

const THREAD_PROCESS_CONTROL_ACCEPT: &str = "vsock-process-control-accept";
const THREAD_PROCESS_CONTROL_FORWARD: &str = "vsock-process-control-forward";
const CONTROL_ACCEPT_POLL_TIMEOUT: Duration = Duration::from_millis(100);
const CONTROL_SINK_IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_CONTROL_REQUESTS: usize = 8;
const REQUEST_TIMEOUT_DIAGNOSTIC: &str = "process control request timed out";

#[derive(Clone, Default)]
pub(crate) struct ProcessControlRegistry {
    inner: Arc<Mutex<HashMap<u32, ProcessControlEntry>>>,
}

/// Active `spawn_process` registration for a seq.
///
/// Operations without a control nonce still reserve their seq so malformed or
/// duplicate spawn requests cannot run concurrently under the same routing key.
enum ProcessControlEntry {
    NoControl,
    WithNonce {
        nonce: ProcessControlNonce,
        sink: Option<Arc<ControlSinkState>>,
    },
}

pub(crate) struct ProcessControlRegistration {
    pub(crate) guard: ProcessControlGuard,
    pub(crate) bootstrap_endpoint: Option<String>,
}

pub(crate) struct ProcessControlGuard {
    registry: ProcessControlRegistry,
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

struct OwnedProcessControlRequest {
    response_seq: u32,
    target_seq: u32,
    deadline: Instant,
    control_nonce: ProcessControlNonce,
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

impl ProcessControlRegistry {
    pub(crate) fn register(
        &self,
        seq: u32,
        control_nonce: Option<ProcessControlNonce>,
        control_sink: bool,
    ) -> io::Result<ProcessControlRegistration> {
        let (bootstrap_endpoint, accept_sink) = match control_nonce {
            Some(nonce) if control_sink => {
                let endpoint = process_control_ipc::endpoint_name(seq, &nonce);
                let sink = Arc::new(ControlSinkState::new());
                self.insert(
                    seq,
                    ProcessControlEntry::WithNonce {
                        nonce,
                        sink: Some(Arc::clone(&sink)),
                    },
                )?;
                (Some(endpoint), Some(sink))
            }
            Some(nonce) => {
                self.insert(seq, ProcessControlEntry::WithNonce { nonce, sink: None })?;
                (None, None)
            }
            None => {
                self.insert(seq, ProcessControlEntry::NoControl)?;
                (None, None)
            }
        };

        let start_result = match (&bootstrap_endpoint, accept_sink) {
            (Some(endpoint), Some(sink)) => start_control_sink_accept_thread(endpoint, sink),
            _ => Ok(()),
        };
        if let Err(error) = start_result {
            self.remove(seq);
            return Err(error);
        }

        Ok(ProcessControlRegistration {
            guard: ProcessControlGuard {
                registry: self.clone(),
                seq,
                released: AtomicBool::new(false),
            },
            bootstrap_endpoint,
        })
    }

    fn insert(&self, seq: u32, entry: ProcessControlEntry) -> io::Result<()> {
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

    #[cfg(test)]
    pub(crate) fn contains(&self, seq: u32) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&seq)
    }

    fn resolve(
        &self,
        target_seq: u32,
        control_nonce: ProcessControlNonce,
    ) -> Result<Arc<ControlSinkState>, (ProcessControlStatus, &'static str)> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = guard.get(&target_seq) else {
            return Err((
                ProcessControlStatus::Inactive,
                "process operation is not active",
            ));
        };
        let ProcessControlEntry::WithNonce { nonce, sink } = entry else {
            return Err((
                ProcessControlStatus::Inactive,
                "process operation is not active",
            ));
        };
        if *nonce != control_nonce {
            return Err((
                ProcessControlStatus::NonceMismatch,
                "process operation nonce mismatch",
            ));
        }
        let Some(sink) = sink else {
            return Err((
                ProcessControlStatus::Unsupported,
                "process control sink is not configured",
            ));
        };
        Ok(Arc::clone(sink))
    }
}

impl ProcessControlEntry {
    fn close(self) {
        if let ProcessControlEntry::WithNonce {
            sink: Some(sink), ..
        } = self
        {
            sink.close();
        }
    }
}

fn operation_already_active_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "process operation already active",
    )
}

fn start_control_sink_accept_thread(endpoint: &str, sink: Arc<ControlSinkState>) -> io::Result<()> {
    let listener = process_control_ipc::bind_abstract_listener(endpoint)?;
    thread::Builder::new()
        .name(THREAD_PROCESS_CONTROL_ACCEPT.to_owned())
        .spawn(move || accept_control_sink(listener, sink))?;
    Ok(())
}

impl ProcessControlGuard {
    pub(crate) fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.registry.remove(self.seq);
        }
    }
}

impl Drop for ProcessControlGuard {
    fn drop(&mut self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.registry.remove(self.seq);
        }
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
                        "failed to clone process control sink: {error}"
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
    ) -> Result<Arc<ControlStreamState>, (ProcessControlStatus, String)> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !self.active.load(Ordering::Acquire) {
                return Err((
                    ProcessControlStatus::Inactive,
                    "process operation is not active".to_owned(),
                ));
            }
            match &*guard {
                ControlSinkInner::Connected(connected) => return Ok(Arc::clone(&connected.stream)),
                ControlSinkInner::Waiting | ControlSinkInner::Handshaking(_) => {
                    let Some(wait) = duration_until(deadline) else {
                        return Err((
                            ProcessControlStatus::SinkTimeout,
                            REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                        ));
                    };
                    let (next_guard, wait_result) = self
                        .ready
                        .wait_timeout(guard, wait)
                        .unwrap_or_else(|e| e.into_inner());
                    guard = next_guard;
                    if wait_result.timed_out() {
                        return Err((
                            ProcessControlStatus::SinkTimeout,
                            REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                        ));
                    }
                }
                ControlSinkInner::Failed(message) => {
                    return Err((ProcessControlStatus::SinkError, message.clone()));
                }
                ControlSinkInner::Closed => {
                    return Err((
                        ProcessControlStatus::Inactive,
                        "process operation is not active".to_owned(),
                    ));
                }
            }
        }
    }

    fn try_forward(
        self: &Arc<Self>,
        request: OwnedProcessControlRequest,
        writer: GuestWriter,
    ) -> Option<(ProcessControlStatus, String)> {
        let pending_slot = match self.reserve_pending_slot() {
            Ok(pending_slot) => pending_slot,
            Err(error) => return Some(error),
        };

        let sink = Arc::clone(self);
        match thread::Builder::new()
            .name(THREAD_PROCESS_CONTROL_FORWARD.to_owned())
            .spawn(move || forward_control_request(sink, pending_slot, request, writer))
        {
            Ok(_) => None,
            Err(error) => Some((
                ProcessControlStatus::SinkError,
                format!("failed to start process control worker: {error}"),
            )),
        }
    }

    fn reserve_pending_slot(
        self: &Arc<Self>,
    ) -> Result<PendingControlSlot, (ProcessControlStatus, String)> {
        if !self.active.load(Ordering::Acquire) {
            return Err((
                ProcessControlStatus::Inactive,
                "process operation is not active".to_owned(),
            ));
        }

        let previous = self.pending.fetch_add(1, Ordering::AcqRel);
        if previous >= MAX_PENDING_CONTROL_REQUESTS {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            return Err((
                ProcessControlStatus::QueueFull,
                "process control queue is full".to_owned(),
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

    fn lock_until(&self, deadline: Instant) -> io::Result<ControlStreamGuard<'_>> {
        let mut locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        loop {
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
            if wait_result.timed_out() {
                return Err(request_timeout_error());
            }
        }
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
            log("INFO", "process_control: control sink connected");
            sink.connect(stream);
        }
        Err(error) => {
            log(
                "WARN",
                &format!("process_control: control sink accept failed: {error}"),
            );
            sink.fail(error.to_string());
        }
    }
}

fn forward_control_request(
    sink: Arc<ControlSinkState>,
    _pending_slot: PendingControlSlot,
    request: OwnedProcessControlRequest,
    writer: GuestWriter,
) {
    let OwnedProcessControlRequest {
        response_seq,
        target_seq,
        deadline,
        control_nonce,
        message_id,
        payload,
    } = request;
    let (status, diagnostic, mark_failed) = {
        match sink.wait_for_stream(deadline) {
            Ok(stream) => match stream.lock_until(deadline) {
                Ok(mut stream) => {
                    if !sink.active.load(Ordering::Acquire) {
                        (
                            ProcessControlStatus::Inactive,
                            "process operation is not active".to_owned(),
                            false,
                        )
                    } else if request_expired(deadline) {
                        (
                            ProcessControlStatus::SinkTimeout,
                            REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                            false,
                        )
                    } else {
                        forward_to_connected_sink(&mut stream, &message_id, payload, deadline)
                    }
                }
                Err(error) if is_timeout(&error) => {
                    (ProcessControlStatus::SinkTimeout, error.to_string(), false)
                }
                Err(error) => (ProcessControlStatus::SinkError, error.to_string(), false),
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
            (
                ProcessControlStatus::Inactive,
                "process operation is not active",
            )
        };
        let result_payload = vsock_proto::encode_process_control_result(
            target_seq,
            control_nonce,
            &message_id,
            status,
            diagnostic,
        )
        .map_err(to_io_error)?;
        vsock_proto::encode(MSG_PROCESS_CONTROL_RESULT, response_seq, &result_payload)
            .map_err(to_io_error)
    });
    if let Err(error) = result {
        log(
            "WARN",
            &format!("process_control: failed to send control result: {error}"),
        );
    }
}

fn forward_to_connected_sink(
    stream: &mut UnixStream,
    message_id: &str,
    payload: Vec<u8>,
    deadline: Instant,
) -> (ProcessControlStatus, String, bool) {
    let request_frame = ControlRequest {
        message_id: message_id.to_owned(),
        payload,
    };
    let write_timeout = match control_sink_io_timeout(deadline) {
        Ok(timeout) => timeout,
        Err(error) if is_timeout(&error) => {
            return return_control_result(ProcessControlStatus::SinkTimeout, error, false);
        }
        Err(error) => return return_control_result(ProcessControlStatus::SinkError, error, false),
    };
    if let Err(error) = write_control_request(stream, &request_frame, write_timeout) {
        return if is_timeout(&error) {
            return_control_result(ProcessControlStatus::SinkTimeout, error, true)
        } else {
            return_control_result(ProcessControlStatus::SinkError, error, true)
        };
    }

    let read_timeout = match control_sink_io_timeout(deadline) {
        Ok(timeout) => timeout,
        Err(error) if is_timeout(&error) => {
            return return_control_result(ProcessControlStatus::SinkTimeout, error, true);
        }
        Err(error) => return return_control_result(ProcessControlStatus::SinkError, error, true),
    };
    match read_control_response(stream, read_timeout) {
        Ok(response) if response.message_id != message_id => (
            ProcessControlStatus::SinkError,
            format!(
                "process control sink message id mismatch: expected {}, got {}",
                message_id, response.message_id
            ),
            true,
        ),
        Ok(response) => match response.status {
            ControlResponseStatus::Accepted => {
                (ProcessControlStatus::Delivered, response.diagnostic, false)
            }
            ControlResponseStatus::Rejected => {
                (ProcessControlStatus::Rejected, response.diagnostic, false)
            }
            ControlResponseStatus::Error => {
                (ProcessControlStatus::SinkError, response.diagnostic, false)
            }
        },
        Err(error) if is_timeout(&error) => {
            (ProcessControlStatus::SinkTimeout, error.to_string(), true)
        }
        Err(error) => (ProcessControlStatus::SinkError, error.to_string(), true),
    }
}

fn return_control_result(
    status: ProcessControlStatus,
    error: io::Error,
    mark_failed: bool,
) -> (ProcessControlStatus, String, bool) {
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
    io::Error::new(io::ErrorKind::TimedOut, REQUEST_TIMEOUT_DIAGNOSTIC)
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

pub(crate) fn handle_process_control(
    seq: u32,
    payload: &[u8],
    registry: &ProcessControlRegistry,
    writer: &GuestWriter,
) -> io::Result<()> {
    let request = vsock_proto::decode_process_control(payload).map_err(to_io_error)?;
    let owned = OwnedProcessControlRequest {
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
            let result_payload = vsock_proto::encode_process_control_result(
                request.target_seq,
                request.control_nonce,
                request.message_id,
                status,
                &diagnostic,
            )
            .map_err(to_io_error)?;
            vsock_proto::encode(MSG_PROCESS_CONTROL_RESULT, seq, &result_payload)
                .map_err(to_io_error)
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    const NONCE: ProcessControlNonce = *b"0123456789abcdef";

    fn resolve_error(
        registry: &ProcessControlRegistry,
        target_seq: u32,
        nonce: ProcessControlNonce,
    ) -> (ProcessControlStatus, &'static str) {
        match registry.resolve(target_seq, nonce) {
            Ok(_) => panic!("expected process control resolve to fail"),
            Err(error) => error,
        }
    }

    fn read_process_control_result(
        stream: &mut UnixStream,
    ) -> (u8, u32, ProcessControlStatus, String, String) {
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
        let result = vsock_proto::decode_process_control_result(&messages[0].payload).unwrap();
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
        let registry = ProcessControlRegistry::default();
        let _registration = registry.register(7, Some(NONCE), false).unwrap();
        let wrong_nonce = *b"fedcba9876543210";

        let (status, diagnostic) = resolve_error(&registry, 7, wrong_nonce);

        assert_eq!(status, ProcessControlStatus::NonceMismatch);
        assert_eq!(diagnostic, "process operation nonce mismatch");
    }

    #[test]
    fn released_operation_is_inactive() {
        let registry = ProcessControlRegistry::default();
        let registration = registry.register(7, Some(NONCE), false).unwrap();

        registration.guard.release();
        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);

        assert_eq!(status, ProcessControlStatus::Inactive);
        assert_eq!(diagnostic, "process operation is not active");
    }

    #[test]
    fn valid_operation_without_sink_is_unsupported() {
        let registry = ProcessControlRegistry::default();
        let _registration = registry.register(7, Some(NONCE), false).unwrap();

        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);

        assert_eq!(status, ProcessControlStatus::Unsupported);
        assert_eq!(diagnostic, "process control sink is not configured");
    }

    #[test]
    fn duplicate_active_sequence_is_rejected_until_guard_releases() {
        let registry = ProcessControlRegistry::default();
        let first = registry.register(7, Some(NONCE), false).unwrap();

        assert!(
            registry
                .register(7, Some(*b"fedcba9876543210"), false)
                .is_err()
        );
        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
        assert_eq!(status, ProcessControlStatus::Unsupported);
        assert_eq!(diagnostic, "process control sink is not configured");

        first.guard.release();
        assert!(registry.register(7, None, false).is_ok());
    }

    #[test]
    fn duplicate_control_sink_sequence_is_rejected_without_rebinding_endpoint() {
        const SINK_NONCE: ProcessControlNonce = *b"8899aabbccddeeff";

        let registry = ProcessControlRegistry::default();
        let first = registry.register(14, Some(SINK_NONCE), true).unwrap();

        let error = match registry.register(14, Some(SINK_NONCE), true) {
            Ok(_) => panic!("expected duplicate process control registration to fail"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(error.to_string(), "process operation already active");
        assert!(registry.resolve(14, SINK_NONCE).is_ok());

        first.guard.release();
    }

    #[test]
    fn operation_without_control_nonce_still_reserves_sequence() {
        let registry = ProcessControlRegistry::default();
        let registration = registry.register(7, None, false).unwrap();

        assert!(registry.register(7, Some(NONCE), false).is_err());
        let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
        assert_eq!(status, ProcessControlStatus::Inactive);
        assert_eq!(diagnostic, "process operation is not active");

        drop(registration);
        assert!(registry.register(7, Some(NONCE), false).is_ok());
    }

    #[test]
    fn control_sink_registration_exports_bootstrap_endpoint() {
        let registry = ProcessControlRegistry::default();
        let registration = registry.register(7, Some(NONCE), true).unwrap();

        assert!(registration.bootstrap_endpoint.is_some());
        assert!(registry.resolve(7, NONCE).is_ok());
    }

    #[test]
    fn handle_process_control_forwards_to_connected_sink() {
        const FORWARD_NONCE: ProcessControlNonce = *b"fedcba9876543210";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(8, Some(FORWARD_NONCE), true).unwrap();
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
            vsock_proto::encode_process_control(8, FORWARD_NONCE, "msg-1", b"payload", 5000)
                .unwrap();

        handle_process_control(11, &payload, &registry, &writer).unwrap();

        let (msg_type, seq, status, message_id, _) = read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 11);
        assert_eq!(status, ProcessControlStatus::Delivered);
        assert_eq!(message_id, "msg-1");

        client.join().unwrap();
    }

    #[test]
    fn handle_process_control_waits_for_sink_connection() {
        const FORWARD_NONCE: ProcessControlNonce = *b"0123456789fedcba";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(9, Some(FORWARD_NONCE), true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_process_control(9, FORWARD_NONCE, "msg-1", b"payload", 5000)
                .unwrap();

        handle_process_control(11, &payload, &registry, &writer).unwrap();

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

        let (msg_type, seq, status, message_id, _) = read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 11);
        assert_eq!(status, ProcessControlStatus::Delivered);
        assert_eq!(message_id, "msg-1");
    }

    #[test]
    fn pending_process_control_timeout_before_sink_connection_releases_slot() {
        let sink = Arc::new(ControlSinkState::new());
        let pending_slot = sink.reserve_pending_slot().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        forward_control_request(
            Arc::clone(&sink),
            pending_slot,
            OwnedProcessControlRequest {
                response_seq: 29,
                target_seq: 19,
                deadline: request_deadline(0),
                control_nonce: NONCE,
                message_id: "msg-timeout".to_owned(),
                payload: b"payload".to_vec(),
            },
            GuestWriter::new(guest),
        );

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 29);
        assert_eq!(status, ProcessControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-timeout");
        assert_eq!(diagnostic, REQUEST_TIMEOUT_DIAGNOSTIC);
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn timeout_before_sink_connection_does_not_poison_later_delivery() {
        const FORWARD_NONCE: ProcessControlNonce = *b"77889900aabbccdd";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(16, Some(FORWARD_NONCE), true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload = vsock_proto::encode_process_control(
            16,
            FORWARD_NONCE,
            "msg-before-connect",
            b"payload",
            0,
        )
        .unwrap();

        handle_process_control(41, &payload, &registry, &writer).unwrap();
        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 41);
        assert_eq!(status, ProcessControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-before-connect");
        assert_eq!(diagnostic, REQUEST_TIMEOUT_DIAGNOSTIC);

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

        let payload = vsock_proto::encode_process_control(
            16,
            FORWARD_NONCE,
            "msg-after-timeout",
            b"payload",
            5000,
        )
        .unwrap();
        handle_process_control(42, &payload, &registry, &writer).unwrap();
        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 42);
        assert_eq!(status, ProcessControlStatus::Delivered);
        assert_eq!(message_id, "msg-after-timeout");
        assert_eq!(diagnostic, "");

        client.join().unwrap();
    }

    #[test]
    fn non_terminal_control_responses_do_not_close_sink() {
        const FORWARD_NONCE: ProcessControlNonce = *b"aa22cc44ee66ff88";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(11, Some(FORWARD_NONCE), true).unwrap();
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

        let payload = vsock_proto::encode_process_control(
            11,
            FORWARD_NONCE,
            "msg-rejected",
            b"payload",
            5000,
        )
        .unwrap();
        handle_process_control(21, &payload, &registry, &writer).unwrap();
        let (_, seq, status, message_id, diagnostic) = read_process_control_result(&mut host);
        assert_eq!(seq, 21);
        assert_eq!(status, ProcessControlStatus::Rejected);
        assert_eq!(message_id, "msg-rejected");
        assert_eq!(diagnostic, "denied");

        let payload =
            vsock_proto::encode_process_control(11, FORWARD_NONCE, "msg-error", b"payload", 5000)
                .unwrap();
        handle_process_control(22, &payload, &registry, &writer).unwrap();
        let (_, seq, status, message_id, diagnostic) = read_process_control_result(&mut host);
        assert_eq!(seq, 22);
        assert_eq!(status, ProcessControlStatus::SinkError);
        assert_eq!(message_id, "msg-error");
        assert_eq!(diagnostic, "temporary error");

        let payload = vsock_proto::encode_process_control(
            11,
            FORWARD_NONCE,
            "msg-after-error",
            b"payload",
            5000,
        )
        .unwrap();
        handle_process_control(23, &payload, &registry, &writer).unwrap();
        let (_, seq, status, message_id, diagnostic) = read_process_control_result(&mut host);
        assert_eq!(seq, 23);
        assert_eq!(status, ProcessControlStatus::Delivered);
        assert_eq!(message_id, "msg-after-error");
        assert_eq!(diagnostic, "");

        client.join().unwrap();
    }

    #[test]
    fn pending_process_control_returns_inactive_when_operation_releases() {
        const FORWARD_NONCE: ProcessControlNonce = *b"0011223344556677";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(10, Some(FORWARD_NONCE), true).unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_process_control(10, FORWARD_NONCE, "msg-release", b"payload", 5000)
                .unwrap();

        handle_process_control(13, &payload, &registry, &writer).unwrap();
        registration.guard.release();

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 13);
        assert_eq!(status, ProcessControlStatus::Inactive);
        assert_eq!(message_id, "msg-release");
        assert_eq!(diagnostic, "process operation is not active");
    }

    #[test]
    fn process_control_queue_full_rejects_without_leaking_pending_slots() {
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
                OwnedProcessControlRequest {
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
        assert_eq!(immediate.0, ProcessControlStatus::QueueFull);
        assert_eq!(immediate.1, "process control queue is full");
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
            OwnedProcessControlRequest {
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
            OwnedProcessControlRequest {
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
        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 12);
        assert_eq!(status, ProcessControlStatus::SinkError);
        assert_eq!(message_id, "msg-original");
        assert_eq!(
            diagnostic,
            "process control sink message id mismatch: expected msg-original, got msg-other"
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
                    OwnedProcessControlRequest {
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

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        worker.join().unwrap();
        let _ = release_peer_tx.send(());
        client.join().unwrap();

        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 12);
        assert_eq!(status, ProcessControlStatus::SinkTimeout);
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
        const FORWARD_NONCE: ProcessControlNonce = *b"cc22dd44ee66aa88";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(13, Some(FORWARD_NONCE), true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let sink = registry.resolve(13, FORWARD_NONCE).unwrap();

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
        let payload = vsock_proto::encode_process_control(
            13,
            FORWARD_NONCE,
            "msg-handshake-failed",
            b"payload",
            5000,
        )
        .unwrap();

        handle_process_control(31, &payload, &registry, &writer).unwrap();

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 31);
        assert_eq!(status, ProcessControlStatus::SinkError);
        assert_eq!(message_id, "msg-handshake-failed");
        assert!(!diagnostic.is_empty());
    }

    #[test]
    fn operation_release_interrupts_control_sink_handshake() {
        const HANDSHAKE_NONCE: ProcessControlNonce = *b"dd33ee55ff77aa99";

        let registry = ProcessControlRegistry::default();
        let registration = registry.register(15, Some(HANDSHAKE_NONCE), true).unwrap();
        let endpoint = registration.bootstrap_endpoint.clone().unwrap();
        let sink = registry.resolve(15, HANDSHAKE_NONCE).unwrap();
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
    fn close_does_not_wait_for_busy_control_stream_lock() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, _peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let stream = match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
            ControlSinkInner::Connected(connected) => Arc::clone(&connected.stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream.lock_until(request_deadline(5000)).unwrap();
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
        let stream_guard = stream.lock_until(request_deadline(5000)).unwrap();
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
        let stream_guard = stream.lock_until(request_deadline(5000)).unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        assert!(
            sink.try_forward(
                OwnedProcessControlRequest {
                    response_seq: 17,
                    target_seq: 9,
                    deadline: request_deadline(5000),
                    control_nonce: NONCE,
                    message_id: "msg-after-close".to_owned(),
                    payload: b"payload".to_vec(),
                },
                GuestWriter::new(guest),
            )
            .is_none()
        );

        sink.close();
        drop(stream_guard);

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 17);
        assert_eq!(status, ProcessControlStatus::Inactive);
        assert_eq!(message_id, "msg-after-close");
        assert_eq!(diagnostic, "process operation is not active");

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
        let stream_guard = stream.lock_until(request_deadline(5000)).unwrap();
        let pending_slot = sink.reserve_pending_slot().unwrap();
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        let worker = std::thread::spawn({
            let sink = Arc::clone(&sink);
            move || {
                forward_control_request(
                    sink,
                    pending_slot,
                    OwnedProcessControlRequest {
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

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        worker.join().unwrap();

        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 19);
        assert_eq!(status, ProcessControlStatus::SinkTimeout);
        assert_eq!(message_id, "msg-expired-behind-lock");
        assert_eq!(diagnostic, REQUEST_TIMEOUT_DIAGNOSTIC);
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
                    OwnedProcessControlRequest {
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

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
        assert_eq!(msg_type, MSG_PROCESS_CONTROL_RESULT);
        assert_eq!(seq, 18);
        assert_eq!(status, ProcessControlStatus::Inactive);
        assert_eq!(message_id, "msg-inflight-close");
        assert_eq!(diagnostic, "process operation is not active");
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    }
}
