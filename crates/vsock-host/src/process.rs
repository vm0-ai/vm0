use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use vsock_proto::{MSG_ERROR, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, RawMessage};

use crate::{ConnectionState, Shared, request_raw_on_shared};

/// Event emitted when a spawned process exits.
#[derive(Debug, Clone)]
pub struct ProcessExitEvent {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

struct SpawnOperation {
    stdout_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
    exit_tx: oneshot::Sender<io::Result<ProcessExitEvent>>,
}

/// Process lifecycle state while the vsock connection is open.
pub(crate) struct ConnectedProcessState {
    /// Active spawn_watch operations keyed by request sequence number.
    operations: HashMap<u32, SpawnOperation>,
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

    fn insert_operation(&mut self, seq: u32, operation: SpawnOperation) {
        self.operations.insert(seq, operation);
    }

    fn remove_operation(&mut self, seq: u32) {
        self.operations.remove(&seq);
    }

    fn operation_mut(&mut self, seq: u32) -> Option<&mut SpawnOperation> {
        self.operations.get_mut(&seq)
    }

    fn contains_operation(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq)
    }

    fn take_operation(&mut self, seq: u32) -> Option<SpawnOperation> {
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

/// Process lifecycle state after the vsock connection has closed.
pub(crate) struct ClosedProcessState;

impl ClosedProcessState {
    pub(crate) fn empty() -> Self {
        Self
    }
}

/// Spawn operation map moved out during close so drops happen outside
/// `Shared.state`.
pub(crate) struct ProcessOperationMap {
    _operations: HashMap<u32, SpawnOperation>,
}

struct SpawnOperationRegistrationGuard {
    shared: Arc<Shared>,
    seq: u32,
    disarmed: bool,
}

impl SpawnOperationRegistrationGuard {
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

impl Drop for SpawnOperationRegistrationGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            remove_spawn_operation(&self.shared, self.seq);
        }
    }
}

/// Handle for a spawn_watch operation.
///
/// Dropping the handle removes the host-side operation registration. It does
/// not send a guest-side cancellation request; this matches the previous
/// host-side wait timeout/drop behavior.
pub struct SpawnWatchHandle {
    shared: Arc<Shared>,
    seq: Option<u32>,
    pid: u32,
    stdout_rx: Option<mpsc::UnboundedReceiver<Vec<u8>>>,
    exit_rx: Option<oneshot::Receiver<io::Result<ProcessExitEvent>>>,
}

impl fmt::Debug for SpawnWatchHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnWatchHandle")
            .field("seq", &self.seq)
            .field("pid", &self.pid)
            .field("has_stdout_receiver", &self.stdout_rx.is_some())
            .field("has_exit_receiver", &self.exit_rx.is_some())
            .finish_non_exhaustive()
    }
}

impl SpawnWatchHandle {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn take_stdout_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
        self.stdout_rx.take()
    }

    pub async fn wait(mut self) -> io::Result<ProcessExitEvent> {
        let rx = self.exit_rx.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                "spawn_watch operation closed",
            )
        })?;

        let result = rx
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::ConnectionReset, "connection closed"))?;
        self.seq = None;
        result
    }
}

impl Drop for SpawnWatchHandle {
    fn drop(&mut self) {
        if let Some(seq) = self.seq.take() {
            remove_spawn_operation(&self.shared, seq);
        }
    }
}

fn remove_spawn_operation(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { process, .. } = &mut *guard {
        process.remove_operation(seq);
    }
}

pub(crate) fn dispatch_stdout_chunk(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let active = {
        let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        matches!(
            &*guard,
            ConnectionState::Connected { process, .. } if process.contains_operation(msg.seq)
        )
    };
    if !active {
        return Ok(());
    }

    let (_pid, data) = vsock_proto::decode_stdout_chunk(&msg.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    let sender = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { process, .. } => process
                .operation_mut(msg.seq)
                .and_then(|operation| operation.stdout_tx.clone()),
            ConnectionState::Closed { .. } => None,
        }
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
    let active = {
        let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        matches!(
            &*guard,
            ConnectionState::Connected { process, .. } if process.contains_operation(msg.seq)
        )
    };
    if !active {
        return Ok(());
    }

    let (pid, exit_code, stdout, stderr) = vsock_proto::decode_process_exit(&msg.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    let event = ProcessExitEvent {
        pid,
        exit_code,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    };

    let operation = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { process, .. } => process.take_operation(msg.seq),
            ConnectionState::Closed { .. } => None,
        }
    };

    if let Some(operation) = operation {
        let _ = operation.exit_tx.send(Ok(event));
    }

    Ok(())
}

pub(crate) async fn spawn_watch_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    stream_stdout: bool,
    stdout_log_path: Option<&str>,
) -> io::Result<SpawnWatchHandle> {
    let payload = vsock_proto::encode_spawn_watch(
        timeout_ms,
        command,
        env,
        sudo,
        stream_stdout,
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
                process.insert_operation(seq, SpawnOperation { stdout_tx, exit_tx });
            }
        }
    }
    let mut registration_guard = SpawnOperationRegistrationGuard::new(Arc::clone(shared), seq);

    let resp = request_raw_on_shared(
        shared,
        MSG_SPAWN_WATCH,
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

    if resp.msg_type != MSG_SPAWN_WATCH_RESULT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected response type: 0x{:02X}", resp.msg_type),
        ));
    }

    let pid = vsock_proto::decode_spawn_watch_result(&resp.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    registration_guard.disarm();

    Ok(SpawnWatchHandle {
        shared: Arc::clone(shared),
        seq: Some(seq),
        pid,
        stdout_rx,
        exit_rx: Some(exit_rx),
    })
}
