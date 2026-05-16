use std::collections::HashMap;
use std::io;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use process_control_ipc::{ControlRequest, ControlResponseStatus};
use vsock_proto::{MSG_PROCESS_CONTROL_RESULT, ProcessControlNonce, ProcessControlStatus};

use crate::error::to_io_error;
use crate::log::log;
use crate::writer::GuestWriter;

const THREAD_PROCESS_CONTROL_ACCEPT: &str = "vsock-process-control-accept";
const THREAD_PROCESS_CONTROL_FORWARD: &str = "vsock-process-control-forward";
const CONTROL_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROL_IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_CONTROL_REQUESTS: usize = 8;

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

enum ControlSinkInner {
    Waiting,
    Connected(Arc<Mutex<UnixStream>>),
    Failed(String),
    Closed,
}

struct OwnedProcessControlRequest {
    response_seq: u32,
    target_seq: u32,
    control_nonce: ProcessControlNonce,
    message_id: String,
    payload: Vec<u8>,
}

impl ProcessControlRegistry {
    pub(crate) fn register(
        &self,
        seq: u32,
        control_nonce: Option<ProcessControlNonce>,
        control_sink: bool,
    ) -> io::Result<ProcessControlRegistration> {
        let (entry, bootstrap_endpoint) = match control_nonce {
            Some(nonce) if control_sink => {
                let endpoint = process_control_ipc::endpoint_name(seq, &nonce);
                let listener = process_control_ipc::bind_abstract_listener(&endpoint)?;
                let sink = Arc::new(ControlSinkState::new());
                let accept_sink = Arc::clone(&sink);
                thread::Builder::new()
                    .name(THREAD_PROCESS_CONTROL_ACCEPT.to_owned())
                    .spawn(move || accept_control_sink(listener, accept_sink))?;
                (
                    ProcessControlEntry::WithNonce {
                        nonce,
                        sink: Some(sink),
                    },
                    Some(endpoint),
                )
            }
            Some(nonce) => (ProcessControlEntry::WithNonce { nonce, sink: None }, None),
            None => (ProcessControlEntry::NoControl, None),
        };

        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&seq) {
            if let ProcessControlEntry::WithNonce {
                sink: Some(sink), ..
            } = &entry
            {
                sink.close();
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "process operation already active",
            ));
        }
        active.insert(seq, entry);
        Ok(ProcessControlRegistration {
            guard: ProcessControlGuard {
                registry: self.clone(),
                seq,
                released: AtomicBool::new(false),
            },
            bootstrap_endpoint,
        })
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

    #[cfg(test)]
    fn sink_is_connected(&self, seq: u32) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ProcessControlEntry::WithNonce {
            sink: Some(sink), ..
        }) = guard.get(&seq)
        else {
            return false;
        };
        matches!(
            *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
            ControlSinkInner::Connected(_)
        )
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
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !self.active.load(Ordering::Acquire) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            *guard = ControlSinkInner::Closed;
            self.ready.notify_all();
            return;
        }
        *guard = ControlSinkInner::Connected(Arc::new(Mutex::new(stream)));
        self.ready.notify_all();
    }

    fn fail(&self, message: String) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        let stream = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let stream = match &*guard {
                ControlSinkInner::Connected(stream) => Some(Arc::clone(stream)),
                ControlSinkInner::Waiting
                | ControlSinkInner::Failed(_)
                | ControlSinkInner::Closed => None,
            };
            if !matches!(*guard, ControlSinkInner::Closed) {
                *guard = ControlSinkInner::Failed(message);
            }
            self.ready.notify_all();
            stream
        };
        if let Some(stream) = stream {
            shutdown_stream_if_unlocked(&stream);
        }
    }

    fn close(&self) {
        self.active.store(false, Ordering::Release);
        let stream = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let stream = match &*guard {
                ControlSinkInner::Connected(stream) => Some(Arc::clone(stream)),
                ControlSinkInner::Waiting
                | ControlSinkInner::Failed(_)
                | ControlSinkInner::Closed => None,
            };
            *guard = ControlSinkInner::Closed;
            self.ready.notify_all();
            stream
        };
        if let Some(stream) = stream {
            shutdown_stream_if_unlocked(&stream);
        }
    }

    fn wait_for_stream(
        &self,
        timeout: Duration,
    ) -> Result<Arc<Mutex<UnixStream>>, (ProcessControlStatus, String)> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !self.active.load(Ordering::Acquire) {
                return Err((
                    ProcessControlStatus::Inactive,
                    "process operation is not active".to_owned(),
                ));
            }
            match &*guard {
                ControlSinkInner::Connected(stream) => return Ok(Arc::clone(stream)),
                ControlSinkInner::Waiting => {
                    let now = Instant::now();
                    if now >= deadline {
                        return Err((
                            ProcessControlStatus::SinkUnavailable,
                            "process control sink is not connected".to_owned(),
                        ));
                    }
                    let wait = deadline.duration_since(now);
                    let (next_guard, wait_result) = self
                        .ready
                        .wait_timeout(guard, wait)
                        .unwrap_or_else(|e| e.into_inner());
                    guard = next_guard;
                    if wait_result.timed_out() {
                        return Err((
                            ProcessControlStatus::SinkUnavailable,
                            "process control sink is not connected".to_owned(),
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
        if !self.active.load(Ordering::Acquire) {
            return Some((
                ProcessControlStatus::Inactive,
                "process operation is not active".to_owned(),
            ));
        }

        let previous = self.pending.fetch_add(1, Ordering::AcqRel);
        if previous >= MAX_PENDING_CONTROL_REQUESTS {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            return Some((
                ProcessControlStatus::QueueFull,
                "process control queue is full".to_owned(),
            ));
        }

        let sink = Arc::clone(self);
        match thread::Builder::new()
            .name(THREAD_PROCESS_CONTROL_FORWARD.to_owned())
            .spawn(move || forward_control_request(sink, request, writer))
        {
            Ok(_) => None,
            Err(error) => {
                self.pending.fetch_sub(1, Ordering::AcqRel);
                Some((
                    ProcessControlStatus::SinkError,
                    format!("failed to start process control worker: {error}"),
                ))
            }
        }
    }
}

fn shutdown_stream_if_unlocked(stream: &Arc<Mutex<UnixStream>>) {
    match stream.try_lock() {
        Ok(stream) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        Err(TryLockError::Poisoned(error)) => {
            let stream = error.into_inner();
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        Err(TryLockError::WouldBlock) => {}
    }
}

fn accept_control_sink(listener: std::os::unix::net::UnixListener, sink: Arc<ControlSinkState>) {
    let deadline = Instant::now()
        .checked_add(CONTROL_ACCEPT_TIMEOUT)
        .unwrap_or_else(Instant::now);
    let result = loop {
        if !sink.active.load(Ordering::Acquire) {
            return;
        }
        let now = Instant::now();
        if now >= deadline {
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "control endpoint accept timed out",
            ));
        }
        let poll_timeout = deadline.duration_since(now).min(Duration::from_millis(100));
        match process_control_ipc::accept_with_timeout(&listener, poll_timeout) {
            Ok(mut stream) => {
                break stream
                    .set_read_timeout(Some(CONTROL_IO_TIMEOUT))
                    .and_then(|()| stream.set_write_timeout(Some(CONTROL_IO_TIMEOUT)))
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
    request: OwnedProcessControlRequest,
    writer: GuestWriter,
) {
    let (status, diagnostic, mark_failed) = {
        match sink.wait_for_stream(CONTROL_IO_TIMEOUT) {
            Ok(stream) => {
                let mut stream = stream.lock().unwrap_or_else(|e| e.into_inner());
                let request_frame = ControlRequest {
                    message_id: request.message_id.clone(),
                    payload: request.payload.clone(),
                };
                match process_control_ipc::write_request(&mut stream, &request_frame)
                    .and_then(|()| process_control_ipc::read_response(&mut stream))
                {
                    Ok(response) if response.message_id != request.message_id => (
                        ProcessControlStatus::SinkError,
                        format!(
                            "process control sink message id mismatch: expected {}, got {}",
                            request.message_id, response.message_id
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
            Err((status, diagnostic)) => (status, diagnostic, false),
        }
    };

    sink.pending.fetch_sub(1, Ordering::AcqRel);
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
            request.target_seq,
            request.control_nonce,
            &request.message_id,
            status,
            diagnostic,
        )
        .map_err(to_io_error)?;
        vsock_proto::encode(
            MSG_PROCESS_CONTROL_RESULT,
            request.response_seq,
            &result_payload,
        )
        .map_err(to_io_error)
    });
    if let Err(error) = result {
        log(
            "WARN",
            &format!("process_control: failed to send control result: {error}"),
        );
    }
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
        let deadline = Instant::now() + Duration::from_secs(1);
        while !registry.sink_is_connected(8) {
            assert!(
                Instant::now() < deadline,
                "control sink should connect before forwarding"
            );
            std::thread::yield_now();
        }

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let payload =
            vsock_proto::encode_process_control(8, FORWARD_NONCE, "msg-1", b"payload").unwrap();

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
            vsock_proto::encode_process_control(9, FORWARD_NONCE, "msg-1", b"payload").unwrap();

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
    fn timed_out_control_sink_is_marked_failed() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, _peer) = UnixStream::pair().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(1)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        sink.connect(stream);
        sink.pending.fetch_add(1, Ordering::AcqRel);

        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        forward_control_request(
            Arc::clone(&sink),
            OwnedProcessControlRequest {
                response_seq: 12,
                target_seq: 8,
                control_nonce: NONCE,
                message_id: "msg-timeout".to_owned(),
                payload: b"payload".to_vec(),
            },
            GuestWriter::new(guest),
        );

        let (msg_type, seq, status, message_id, diagnostic) =
            read_process_control_result(&mut host);
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
    fn close_does_not_wait_for_busy_control_stream_lock() {
        let sink = Arc::new(ControlSinkState::new());
        let (stream, _peer) = UnixStream::pair().unwrap();
        sink.connect(stream);
        let stream = match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
            ControlSinkInner::Connected(stream) => Arc::clone(stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream.lock().unwrap_or_else(|e| e.into_inner());
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
            ControlSinkInner::Connected(stream) => Arc::clone(stream),
            _ => panic!("sink should be connected"),
        };
        let stream_guard = stream.lock().unwrap_or_else(|e| e.into_inner());
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
}
