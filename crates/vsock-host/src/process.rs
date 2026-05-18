use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};
use vsock_proto::{
    MSG_ERROR, MSG_PROCESS_CONTROL, MSG_PROCESS_CONTROL_RESULT, MSG_SPAWN_PROCESS,
    MSG_SPAWN_PROCESS_RESULT, ProcessControlNonce, ProcessControlStatus, RawMessage,
};

use crate::{
    ConnectionState, FrameWriteObserver, PendingRequestGuard, PendingResponse, Shared,
    operation_tracker::NormalOperationToken, request_on_shared,
};

const SPAWN_PROCESS_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Event emitted when a spawned process exits.
#[derive(Debug, Clone)]
pub struct ProcessExitEvent {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Host-side result of a process-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessControlAck {
    pub target_seq: u32,
    pub message_id: String,
}

struct ProcessOperation {
    pid: Option<u32>,
    streams_stdout: bool,
    stdout_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
    exit_tx: oneshot::Sender<ProcessExitEvent>,
    normal_operation: NormalOperationToken,
}

pub(crate) struct SpawnProcessOnSharedRequest<'a> {
    pub(crate) command: &'a str,
    pub(crate) timeout_ms: u32,
    pub(crate) env: &'a [(&'a str, &'a str)],
    pub(crate) sudo: bool,
    pub(crate) stream_stdout: bool,
    pub(crate) stdout_log_path: Option<&'a str>,
    pub(crate) control_sink: bool,
    pub(crate) write_observer: FrameWriteObserver,
}

/// Process lifecycle state while the vsock connection is open.
pub(crate) struct ConnectedProcessState {
    /// Active spawn_process operations keyed by request sequence number.
    operations: HashMap<u32, ProcessOperation>,
}

impl ConnectedProcessState {
    pub(crate) fn new() -> Self {
        Self {
            operations: HashMap::new(),
        }
    }

    pub(crate) fn close(self) -> (ClosedProcessState, ProcessOperationMap) {
        (
            ClosedProcessState,
            ProcessOperationMap {
                _operations: self.operations,
            },
        )
    }

    fn insert_operation(&mut self, seq: u32, operation: ProcessOperation) {
        self.operations.insert(seq, operation);
    }

    fn remove_operation(&mut self, seq: u32) {
        self.operations.remove(&seq);
    }

    fn operation_mut(&mut self, seq: u32) -> Option<&mut ProcessOperation> {
        self.operations.get_mut(&seq)
    }

    fn contains_operation(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq)
    }

    fn take_operation(&mut self, seq: u32) -> Option<ProcessOperation> {
        self.operations.remove(&seq)
    }

    #[cfg(test)]
    pub(crate) fn registration_counts(&self) -> (usize, usize) {
        let stdout_senders = self
            .operations
            .values()
            .filter(|operation| operation.stdout_tx.is_some())
            .count();
        (self.operations.len(), stdout_senders)
    }
}

fn validate_lifecycle_pid(
    frame: &'static str,
    expected: Option<u32>,
    actual: u32,
) -> io::Result<()> {
    if let Some(expected) = expected
        && expected != actual
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{frame} pid mismatch: expected {expected}, got {actual}"),
        ));
    }
    Ok(())
}

fn require_recorded_lifecycle_pid(
    frame: &'static str,
    expected: Option<u32>,
    actual: u32,
) -> io::Result<u32> {
    let expected = expected.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{frame} arrived before spawn_process_result for pid {actual}"),
        )
    })?;
    validate_lifecycle_pid(frame, Some(expected), actual)?;
    Ok(expected)
}

/// Process lifecycle state after the vsock connection has closed.
pub(crate) struct ClosedProcessState;

impl ClosedProcessState {
    pub(crate) fn empty() -> Self {
        Self
    }
}

/// Process operation map moved out during close so drops happen outside
/// `Shared.state`.
pub(crate) struct ProcessOperationMap {
    _operations: HashMap<u32, ProcessOperation>,
}

struct ProcessOperationRegistrationGuard {
    shared: Arc<Shared>,
    seq: u32,
    state: ProcessOperationRegistrationState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessOperationRegistrationState {
    RemoveOnDrop,
    KeepOnDrop,
    Disarmed,
}

impl ProcessOperationRegistrationGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self {
            shared,
            seq,
            state: ProcessOperationRegistrationState::RemoveOnDrop,
        }
    }

    fn keep_on_drop(&mut self) {
        self.state = ProcessOperationRegistrationState::KeepOnDrop;
    }

    fn remove_on_drop(&mut self) {
        self.state = ProcessOperationRegistrationState::RemoveOnDrop;
    }

    fn disarm(&mut self) {
        self.state = ProcessOperationRegistrationState::Disarmed;
    }
}

impl Drop for ProcessOperationRegistrationGuard {
    fn drop(&mut self) {
        match self.state {
            ProcessOperationRegistrationState::RemoveOnDrop => {
                remove_process_operation(&self.shared, self.seq);
            }
            ProcessOperationRegistrationState::KeepOnDrop => {
                clear_process_stdout_sender(&self.shared, self.seq);
            }
            ProcessOperationRegistrationState::Disarmed => {}
        }
    }
}

struct ProcessOperationFrameWriteGuard {
    shared: Arc<Shared>,
    write_started: bool,
    write_returned: bool,
}

impl ProcessOperationFrameWriteGuard {
    fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            write_started: false,
            write_returned: false,
        }
    }

    fn mark_started(&mut self) {
        self.write_started = true;
    }

    fn mark_returned(&mut self) {
        self.write_returned = true;
    }
}

impl Drop for ProcessOperationFrameWriteGuard {
    fn drop(&mut self) {
        if self.write_started && !self.write_returned {
            self.shared.poison_connection();
        }
    }
}

/// Handle for a spawn_process operation.
///
/// Dropping the handle does not remove host-side process tracking or send a
/// guest-side cancellation request. The connection remains busy until the guest
/// reports a terminal process_exit frame or the connection closes.
///
/// If stdout streaming is enabled, call [`take_stdout_receiver`](Self::take_stdout_receiver)
/// before [`wait`](Self::wait). Waiting consumes the handle and drops any
/// unclaimed stdout receiver so streamed output is not buffered without a
/// reader.
pub struct GuestProcessHandle {
    pid: u32,
    control: GuestProcessControlHandle,
    stdout_rx: Option<mpsc::UnboundedReceiver<Vec<u8>>>,
    exit_rx: Option<oneshot::Receiver<ProcessExitEvent>>,
}

/// Cloneable handle for sending control messages to a live process operation.
#[derive(Clone)]
pub struct GuestProcessControlHandle {
    shared: Arc<Shared>,
    target_seq: u32,
    control_nonce: ProcessControlNonce,
}

impl fmt::Debug for GuestProcessHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GuestProcessHandle")
            .field("seq", &self.control.target_seq)
            .field("pid", &self.pid)
            .field("has_stdout_receiver", &self.stdout_rx.is_some())
            .field("has_exit_receiver", &self.exit_rx.is_some())
            .finish_non_exhaustive()
    }
}

impl GuestProcessHandle {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn control_handle(&self) -> GuestProcessControlHandle {
        self.control.clone()
    }

    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ProcessControlAck> {
        self.control.control(message_id, payload, timeout).await
    }

    pub fn take_stdout_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
        self.stdout_rx.take()
    }

    pub async fn wait(mut self) -> io::Result<ProcessExitEvent> {
        let rx = self.exit_rx.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                "spawn_process operation closed",
            )
        })?;

        // `wait` consumes the handle, so an unclaimed stdout receiver can no
        // longer be observed by the caller. Drop it before waiting and clear
        // the sender to avoid retaining an unused channel for long-lived
        // processes that never emit another stdout chunk.
        if self.stdout_rx.take().is_some() {
            clear_process_stdout_sender(&self.control.shared, self.control.target_seq);
        }

        let event = rx
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::ConnectionReset, "connection closed"))?;
        Ok(event)
    }
}

impl Drop for GuestProcessHandle {
    fn drop(&mut self) {
        if self.stdout_rx.is_some() {
            clear_process_stdout_sender(&self.control.shared, self.control.target_seq);
        }
    }
}

impl fmt::Debug for GuestProcessControlHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GuestProcessControlHandle")
            .field("target_seq", &self.target_seq)
            .finish_non_exhaustive()
    }
}

impl GuestProcessControlHandle {
    fn protocol_error(&self, message: impl ToString) -> io::Error {
        self.shared.poison_connection();
        io::Error::new(io::ErrorKind::InvalidData, message.to_string())
    }

    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ProcessControlAck> {
        let request_timeout_ms = duration_to_request_timeout_ms(timeout);
        let request = vsock_proto::encode_process_control(
            self.target_seq,
            self.control_nonce,
            message_id,
            payload,
            request_timeout_ms,
        )
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        let response =
            request_on_shared(&self.shared, MSG_PROCESS_CONTROL, &request, timeout).await?;
        self.decode_control_response(message_id, response)
    }

    fn decode_control_response(
        &self,
        message_id: &str,
        response: RawMessage,
    ) -> io::Result<ProcessControlAck> {
        if response.msg_type == MSG_ERROR {
            let msg =
                vsock_proto::decode_error(&response.payload).map_err(|e| self.protocol_error(e))?;
            return Err(io::Error::other(msg.to_owned()));
        }
        if response.msg_type != MSG_PROCESS_CONTROL_RESULT {
            return Err(self.protocol_error(format!(
                "unexpected response type: 0x{:02X}",
                response.msg_type
            )));
        }
        let result = vsock_proto::decode_process_control_result(&response.payload)
            .map_err(|e| self.protocol_error(e))?;
        if result.target_seq != self.target_seq {
            return Err(self.protocol_error(format!(
                "process_control_result target seq mismatch: expected {}, got {}",
                self.target_seq, result.target_seq
            )));
        }
        if result.control_nonce != self.control_nonce {
            return Err(self.protocol_error("process_control_result nonce mismatch"));
        }
        if result.message_id != message_id {
            return Err(self.protocol_error(format!(
                "process_control_result message_id mismatch: expected {message_id}, got {}",
                result.message_id
            )));
        }
        match result.status {
            ProcessControlStatus::Delivered => Ok(ProcessControlAck {
                target_seq: result.target_seq,
                message_id: result.message_id.to_owned(),
            }),
            ProcessControlStatus::Inactive => Err(io::Error::new(
                io::ErrorKind::NotFound,
                if result.diagnostic.is_empty() {
                    "process operation is not active".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::NonceMismatch => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                if result.diagnostic.is_empty() {
                    "process operation nonce mismatch".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::Unsupported => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                if result.diagnostic.is_empty() {
                    "process control is not supported by this operation".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::Rejected => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                if result.diagnostic.is_empty() {
                    "process control request rejected".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::SinkUnavailable => Err(io::Error::new(
                io::ErrorKind::NotConnected,
                if result.diagnostic.is_empty() {
                    "process control sink is not connected".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::SinkTimeout => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                if result.diagnostic.is_empty() {
                    "process control sink timed out".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::QueueFull => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                if result.diagnostic.is_empty() {
                    "process control queue is full".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
            ProcessControlStatus::SinkError => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                if result.diagnostic.is_empty() {
                    "process control sink error".to_owned()
                } else {
                    result.diagnostic.to_owned()
                },
            )),
        }
    }
}

fn duration_to_request_timeout_ms(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }

    u32::try_from(timeout.as_millis())
        .unwrap_or(u32::MAX)
        .max(1)
}

fn remove_process_operation(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { process, .. } = &mut *guard {
        process.remove_operation(seq);
    }
}

fn clear_process_stdout_sender(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { process, .. } = &mut *guard
        && let Some(operation) = process.operation_mut(seq)
    {
        operation.stdout_tx = None;
    }
}

fn mark_process_operation_possible_guest_write(shared: &Arc<Shared>, seq: u32) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { process, .. } => {
            let Some(operation) = process.operation_mut(seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "spawn_process operation closed before frame write",
                ));
            };
            operation
                .normal_operation
                .mark_possible_guest_write_started()
                .map_err(crate::normal_operation_transition_error)
        }
        ConnectionState::Closed { .. } => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

pub(crate) fn record_spawn_process_error(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    let ConnectionState::Connected { process, .. } = &mut *guard else {
        return Ok(());
    };
    let Some(operation) = process.operation_mut(msg.seq) else {
        return Ok(());
    };
    if operation.pid.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "error response arrived after spawn_process_result",
        ));
    }
    vsock_proto::decode_error(&msg.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    let Some(operation) = process.take_operation(msg.seq) else {
        return Ok(());
    };
    operation
        .normal_operation
        .complete()
        .map_err(crate::normal_operation_transition_error)?;
    Ok(())
}

pub(crate) fn record_spawn_process_result(
    shared: &Arc<Shared>,
    msg: &RawMessage,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { process, .. } = &mut *guard
        && let Some(operation) = process.operation_mut(msg.seq)
    {
        if let Some(expected) = operation.pid {
            let pid = vsock_proto::decode_spawn_process_result(&msg.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            validate_lifecycle_pid("spawn_process_result", Some(expected), pid)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("duplicate spawn_process_result for pid {pid}"),
            ));
        }

        let pid = vsock_proto::decode_spawn_process_result(&msg.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        operation.pid = Some(pid);
    }
    Ok(())
}

pub(crate) fn reject_unexpected_process_response(
    shared: &Arc<Shared>,
    seq: u32,
    msg_type: u8,
) -> io::Result<()> {
    let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    let ConnectionState::Connected { process, .. } = &*guard else {
        return Ok(());
    };
    if process.contains_operation(seq) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected response type for spawn_process: 0x{msg_type:02X}"),
        ));
    }
    Ok(())
}

pub(crate) fn dispatch_stdout_chunk(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let (sender, data) = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let ConnectionState::Connected { process, .. } = &mut *guard else {
            return Ok(());
        };
        let Some(operation) = process.operation_mut(msg.seq) else {
            return Ok(());
        };
        let (pid, data) = vsock_proto::decode_stdout_chunk(&msg.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        require_recorded_lifecycle_pid("stdout_chunk", operation.pid, pid)?;
        if !operation.streams_stdout {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("stdout_chunk for non-streaming spawn_process pid {pid}"),
            ));
        }
        (operation.stdout_tx.clone(), data)
    };

    if let Some(tx) = sender
        && tx.send(data.to_vec()).is_err()
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { process, .. } = &mut *guard
            && let Some(operation) = process.operation_mut(msg.seq)
        {
            operation.stdout_tx = None;
        }
    }

    Ok(())
}

pub(crate) fn dispatch_process_exit(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let (exit_tx, pid, exit_code, stdout, stderr) = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let ConnectionState::Connected { process, .. } = &mut *guard else {
            return Ok(());
        };
        let Some(operation) = process.operation_mut(msg.seq) else {
            return Ok(());
        };
        let expected_pid = operation.pid;
        let (pid, exit_code, stdout, stderr) = vsock_proto::decode_process_exit(&msg.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        let pid = require_recorded_lifecycle_pid("process_exit", expected_pid, pid)?;
        let Some(operation) = process.take_operation(msg.seq) else {
            return Ok(());
        };
        let ProcessOperation {
            exit_tx,
            normal_operation,
            ..
        } = operation;
        normal_operation
            .complete()
            .map_err(crate::normal_operation_transition_error)?;
        (exit_tx, pid, exit_code, stdout, stderr)
    };

    let event = ProcessExitEvent {
        pid,
        exit_code,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    };

    let _ = exit_tx.send(event);

    Ok(())
}

pub(crate) async fn spawn_process_on_shared(
    shared: &Arc<Shared>,
    request: SpawnProcessOnSharedRequest<'_>,
) -> io::Result<GuestProcessHandle> {
    spawn_process_on_shared_with_response_timeout(shared, request, SPAWN_PROCESS_RESPONSE_TIMEOUT)
        .await
}

async fn spawn_process_on_shared_with_response_timeout(
    shared: &Arc<Shared>,
    request: SpawnProcessOnSharedRequest<'_>,
    response_timeout: Duration,
) -> io::Result<GuestProcessHandle> {
    let SpawnProcessOnSharedRequest {
        command,
        timeout_ms,
        env,
        sudo,
        stream_stdout,
        stdout_log_path,
        control_sink,
        write_observer,
    } = request;
    let control_nonce = *uuid::Uuid::new_v4().as_bytes();
    let payload = if control_sink {
        vsock_proto::encode_spawn_process_with_control_sink(
            timeout_ms,
            command,
            env,
            sudo,
            stream_stdout,
            control_nonce,
            stdout_log_path,
        )
    } else {
        vsock_proto::encode_spawn_process_with_control_nonce(
            timeout_ms,
            command,
            env,
            sudo,
            stream_stdout,
            control_nonce,
            stdout_log_path,
        )
    }
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    let (stdout_tx, stdout_rx) = if stream_stdout {
        let (tx, rx) = mpsc::unbounded_channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let (exit_tx, exit_rx) = oneshot::channel();
    let seq = shared.next_seq();
    let normal_operation = shared.reserve_normal_operation()?;
    let (tx, rx) = oneshot::channel();
    let data = vsock_proto::encode(MSG_SPAWN_PROCESS, seq, &payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected {
                pending, process, ..
            } => {
                process.insert_operation(
                    seq,
                    ProcessOperation {
                        pid: None,
                        streams_stdout: stream_stdout,
                        stdout_tx,
                        exit_tx,
                        normal_operation,
                    },
                );
                pending.insert(
                    seq,
                    PendingResponse {
                        response_tx: tx,
                        normal_operation: None,
                        normal_terminal_msg_types: &[],
                    },
                );
            }
        }
    }
    let mut registration_guard = ProcessOperationRegistrationGuard::new(Arc::clone(shared), seq);
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    let resp = {
        let mut write_guard = ProcessOperationFrameWriteGuard::new(Arc::clone(shared));
        let mut writer = shared.writer.lock().await;
        mark_process_operation_possible_guest_write(shared, seq)?;
        write_observer.record_write_start()?;
        write_guard.mark_started();
        registration_guard.keep_on_drop();
        if let Err(error) = writer.write_all(&data).await {
            write_guard.mark_returned();
            shared.poison_connection();
            return Err(error);
        }
        write_guard.mark_returned();
        drop(writer);
        drop(write_guard);

        tokio::select! {
            biased;
            result = rx => {
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))?
            }
            _ = tokio::time::sleep(response_timeout) => {
                registration_guard.remove_on_drop();
                return Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"));
            }
        }
    };

    if resp.msg_type == MSG_ERROR {
        let msg = vsock_proto::decode_error(&resp.payload).map_err(|e| {
            shared.poison_connection();
            io::Error::new(io::ErrorKind::InvalidData, e.to_string())
        })?;
        return Err(io::Error::other(msg));
    }

    if resp.msg_type != MSG_SPAWN_PROCESS_RESULT {
        shared.poison_connection();
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected response type: 0x{:02X}", resp.msg_type),
        ));
    }

    let pid = vsock_proto::decode_spawn_process_result(&resp.payload).map_err(|e| {
        shared.poison_connection();
        io::Error::new(io::ErrorKind::InvalidData, e.to_string())
    })?;

    registration_guard.disarm();

    Ok(GuestProcessHandle {
        pid,
        control: GuestProcessControlHandle {
            shared: Arc::clone(shared),
            target_seq: seq,
            control_nonce,
        },
        stdout_rx,
        exit_rx: Some(exit_rx),
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) async fn spawn_process_with_response_timeout(
        shared: &Arc<Shared>,
        command: &str,
        stream_stdout: bool,
        response_timeout: Duration,
    ) -> io::Result<GuestProcessHandle> {
        spawn_process_on_shared_with_response_timeout(
            shared,
            SpawnProcessOnSharedRequest {
                command,
                timeout_ms: 0,
                env: &[],
                sudo: false,
                stream_stdout,
                stdout_log_path: None,
                control_sink: false,
                write_observer: FrameWriteObserver::default(),
            },
            response_timeout,
        )
        .await
    }

    pub(crate) fn drop_started_frame_write_guard(shared: Arc<Shared>) {
        let mut guard = ProcessOperationFrameWriteGuard::new(shared);
        guard.mark_started();
        drop(guard);
    }
}
