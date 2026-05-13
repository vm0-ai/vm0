use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::Instant;
use vsock_proto::{MSG_ERROR, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT};

use crate::{ConnectionState, Shared, request_raw_on_shared};

type StdoutSenderMap = HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>;

/// Event emitted when a spawned process exits.
#[derive(Debug, Clone)]
pub struct ProcessExitEvent {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Process lifecycle state while the vsock connection is open.
pub(crate) struct ConnectedProcessState {
    /// Pre-registered stdout senders: request seq -> channel sender.
    ///
    /// `spawn_watch` inserts here before sending the request so the reader loop
    /// can move the sender to `stdout_senders` when it processes the
    /// `spawn_watch_result`, before any stdout chunk for that pid is handled.
    pending_stdout: StdoutSenderMap,
    /// Stdout chunk senders: pid -> channel sender.
    stdout_senders: StdoutSenderMap,
    /// Cached process exit events (unsolicited, seq=0).
    exits: HashMap<u32, ProcessExitEvent>,
}

impl ConnectedProcessState {
    pub(crate) fn new() -> Self {
        Self {
            pending_stdout: HashMap::new(),
            stdout_senders: HashMap::new(),
            exits: HashMap::new(),
        }
    }

    pub(crate) fn close(self) -> (ClosedProcessState, ProcessSenderMaps) {
        let Self {
            pending_stdout,
            stdout_senders,
            exits,
        } = self;
        (
            ClosedProcessState { exits },
            ProcessSenderMaps {
                pending_stdout,
                stdout_senders,
            },
        )
    }

    fn insert_pending_stdout(&mut self, seq: u32, tx: mpsc::UnboundedSender<Vec<u8>>) {
        self.pending_stdout.insert(seq, tx);
    }

    fn remove_pending_stdout(&mut self, seq: u32) {
        self.pending_stdout.remove(&seq);
    }

    fn stdout_sender(&self, pid: u32) -> Option<mpsc::UnboundedSender<Vec<u8>>> {
        self.stdout_senders.get(&pid).cloned()
    }

    fn remove_stdout_sender(&mut self, pid: u32) {
        self.stdout_senders.remove(&pid);
    }

    fn insert_exit(&mut self, event: ProcessExitEvent) {
        self.stdout_senders.remove(&event.pid);
        self.exits.insert(event.pid, event);
    }

    fn take_exit(&mut self, pid: u32) -> Option<ProcessExitEvent> {
        self.exits.remove(&pid)
    }

    #[cfg(test)]
    pub(crate) fn registration_counts(&self) -> (usize, usize) {
        (self.pending_stdout.len(), self.stdout_senders.len())
    }
}

/// Process lifecycle state after the vsock connection has closed.
pub(crate) struct ClosedProcessState {
    /// Preserved across the close transition: callers of `wait_for_exit` can
    /// still retrieve an exit event that was cached before close.
    exits: HashMap<u32, ProcessExitEvent>,
}

impl ClosedProcessState {
    pub(crate) fn empty() -> Self {
        Self {
            exits: HashMap::new(),
        }
    }

    fn take_exit(&mut self, pid: u32) -> Option<ProcessExitEvent> {
        self.exits.remove(&pid)
    }
}

/// Sender maps moved out during close so drops happen outside `Shared.state`.
pub(crate) struct ProcessSenderMaps {
    pending_stdout: StdoutSenderMap,
    stdout_senders: StdoutSenderMap,
}

impl ProcessSenderMaps {
    pub(crate) fn into_inner(self) -> (StdoutSenderMap, StdoutSenderMap) {
        (self.pending_stdout, self.stdout_senders)
    }
}

struct PendingStdoutGuard {
    shared: Arc<Shared>,
    seq: u32,
}

impl PendingStdoutGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self { shared, seq }
    }
}

impl Drop for PendingStdoutGuard {
    fn drop(&mut self) {
        remove_pending_stdout(&self.shared, self.seq);
    }
}

pub(crate) fn remove_pending_stdout(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { process, .. } = &mut *guard {
        process.remove_pending_stdout(seq);
    }
}

pub(crate) fn move_stdout_registration_to_pid_before_response_dispatch(
    process: &mut ConnectedProcessState,
    seq: u32,
    payload: &[u8],
) {
    if let Ok(pid) = vsock_proto::decode_spawn_watch_result(payload)
        && let Some(tx) = process.pending_stdout.remove(&seq)
    {
        process.stdout_senders.insert(pid, tx);
    }
}

pub(crate) fn dispatch_stdout_chunk(shared: &Arc<Shared>, payload: &[u8]) {
    let Ok((pid, data)) = vsock_proto::decode_stdout_chunk(payload) else {
        return;
    };

    let sender = {
        let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            ConnectionState::Connected { process, .. } => process.stdout_sender(pid),
            ConnectionState::Closed { .. } => None,
        }
    };

    if let Some(tx) = sender {
        // Best-effort: if receiver is dropped, remove sender.
        if tx.send(data.to_vec()).is_err() {
            let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if let ConnectionState::Connected { process, .. } = &mut *guard {
                process.remove_stdout_sender(pid);
            }
        }
    }
}

pub(crate) fn dispatch_process_exit(shared: &Arc<Shared>, payload: &[u8]) {
    let Ok((pid, exit_code, stdout, stderr)) = vsock_proto::decode_process_exit(payload) else {
        return;
    };

    let event = ProcessExitEvent {
        pid,
        exit_code,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    };

    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { process, .. } = &mut *guard {
            process.insert_exit(event);
        }
    }
    shared.exit_notify.notify_waiters();
}

pub(crate) async fn spawn_watch_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    stream_stdout: bool,
    stdout_log_path: Option<&str>,
) -> io::Result<(u32, mpsc::UnboundedReceiver<Vec<u8>>)> {
    let payload = vsock_proto::encode_spawn_watch(
        timeout_ms,
        command,
        env,
        sudo,
        stream_stdout,
        stdout_log_path,
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    // Pre-create the stdout channel. In streaming mode, register it by seq
    // number before sending the request. The reader loop will atomically move
    // it from pending_stdout[seq] to stdout_senders[pid] when it processes the
    // spawn_watch_result, before any stdout_chunk for that pid.
    let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();
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
            ConnectionState::Connected { process, .. } if stream_stdout => {
                process.insert_pending_stdout(seq, stdout_tx);
            }
            ConnectionState::Connected { .. } => {}
        }
    }
    let _pending_stdout_guard =
        stream_stdout.then(|| PendingStdoutGuard::new(Arc::clone(shared), seq));

    let resp = request_raw_on_shared(
        shared,
        MSG_SPAWN_WATCH,
        seq,
        &payload,
        Duration::from_secs(30),
    )
    .await?;

    if resp.msg_type == MSG_ERROR {
        // No pid assigned — clean up pending stdout sender.
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

    // If decode fails here, the reader's identical decode also failed and did
    // not move `pending_stdout[seq]` to `stdout_senders[pid]`; the guard still
    // owns cleanup of the pending registration.
    let pid = vsock_proto::decode_spawn_watch_result(&resp.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    // Channel already moved from pending_stdout to stdout_senders by reader_loop.
    Ok((pid, stdout_rx))
}

pub(crate) async fn wait_for_exit_on_shared(
    shared: &Arc<Shared>,
    pid: u32,
    timeout: Duration,
) -> io::Result<ProcessExitEvent> {
    let deadline = Instant::now() + timeout;
    loop {
        // Register interest BEFORE checking the cache so a `notify_waiters`
        // firing between the cache check and `select!` still wakes us.
        let exit_notified = shared.exit_notify.notified();
        tokio::pin!(exit_notified);
        exit_notified.as_mut().enable();

        {
            let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *guard {
                ConnectionState::Connected { process, .. } => {
                    if let Some(event) = process.take_exit(pid) {
                        return Ok(event);
                    }
                }
                ConnectionState::Closed { process } => {
                    if let Some(event) = process.take_exit(pid) {
                        return Ok(event);
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
            }
        }

        tokio::select! {
            biased;
            _ = exit_notified => {
                // Either a new exit event, or `close()` fired its
                // `exit_notify.notify_waiters()` — re-check on next iter.
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "wait timeout"));
            }
        }
    }
}
