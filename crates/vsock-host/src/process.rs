use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use vsock_proto::{
    MSG_ERROR, MSG_PROCESS_CONTROL, MSG_PROCESS_CONTROL_RESULT, MSG_SPAWN_PROCESS,
    MSG_SPAWN_PROCESS_RESULT, ProcessControlNonce, ProcessControlStatus, RawMessage,
};

use crate::{ConnectionState, Shared, request_on_shared, request_raw_on_shared};

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
    disarmed: bool,
}

impl ProcessOperationRegistrationGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self {
            shared,
            seq,
            disarmed: false,
        }
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for ProcessOperationRegistrationGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            remove_process_operation(&self.shared, self.seq);
        }
    }
}

/// Handle for a spawn_process operation.
///
/// Dropping the handle removes the host-side operation registration. It does
/// not send a guest-side cancellation request; this matches the previous
/// host-side wait timeout/drop behavior.
///
/// If stdout streaming is enabled, call [`take_stdout_receiver`](Self::take_stdout_receiver)
/// before [`wait`](Self::wait). Waiting consumes the handle and drops any
/// unclaimed stdout receiver so streamed output is not buffered without a
/// reader.
pub struct GuestProcessHandle {
    shared: Arc<Shared>,
    seq: Option<u32>,
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
            .field("seq", &self.seq)
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
        // longer be observed by the caller. Drop it before waiting to avoid
        // buffering streamed stdout in an unbounded channel with no reader.
        drop(self.stdout_rx.take());

        let event = rx
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::ConnectionReset, "connection closed"))?;
        self.seq = None;
        Ok(event)
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
        let request = vsock_proto::encode_process_control(
            self.target_seq,
            self.control_nonce,
            message_id,
            payload,
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
        }
    }
}

impl Drop for GuestProcessHandle {
    fn drop(&mut self) {
        if let Some(seq) = self.seq.take() {
            remove_process_operation(&self.shared, seq);
        }
    }
}

fn remove_process_operation(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { process, .. } = &mut *guard {
        process.remove_operation(seq);
    }
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

        let pid = match vsock_proto::decode_spawn_process_result(&msg.payload) {
            Ok(pid) => pid,
            // Initial malformed responses are still delivered to the pending
            // request path, which returns InvalidData and drops the operation.
            Err(_) => return Ok(()),
        };
        operation.pid = Some(pid);
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
    let (operation, pid, exit_code, stdout, stderr) = {
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
        (operation, pid, exit_code, stdout, stderr)
    };

    let event = ProcessExitEvent {
        pid,
        exit_code,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    };

    let _ = operation.exit_tx.send(event);

    Ok(())
}

pub(crate) async fn spawn_process_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    stream_stdout: bool,
    stdout_log_path: Option<&str>,
) -> io::Result<GuestProcessHandle> {
    let control_nonce = *uuid::Uuid::new_v4().as_bytes();
    let payload = vsock_proto::encode_spawn_process_with_control_nonce(
        timeout_ms,
        command,
        env,
        sudo,
        stream_stdout,
        control_nonce,
        stdout_log_path,
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    let (stdout_tx, stdout_rx) = if stream_stdout {
        let (tx, rx) = mpsc::unbounded_channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let (exit_tx, exit_rx) = oneshot::channel();
    let seq = shared.next_seq();
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { process, .. } => {
                process.insert_operation(
                    seq,
                    ProcessOperation {
                        pid: None,
                        streams_stdout: stream_stdout,
                        stdout_tx,
                        exit_tx,
                    },
                );
            }
        }
    }
    let mut registration_guard = ProcessOperationRegistrationGuard::new(Arc::clone(shared), seq);

    let resp = request_raw_on_shared(
        shared,
        MSG_SPAWN_PROCESS,
        seq,
        &payload,
        Duration::from_secs(30),
    )
    .await?;

    if resp.msg_type == MSG_ERROR {
        let msg = vsock_proto::decode_error(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        return Err(io::Error::other(msg));
    }

    if resp.msg_type != MSG_SPAWN_PROCESS_RESULT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected response type: 0x{:02X}", resp.msg_type),
        ));
    }

    let pid = vsock_proto::decode_spawn_process_result(&resp.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    registration_guard.disarm();

    Ok(GuestProcessHandle {
        shared: Arc::clone(shared),
        seq: Some(seq),
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
