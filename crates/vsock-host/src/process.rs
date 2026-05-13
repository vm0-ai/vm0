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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::support::{host_from_stream, make_pair, mock_handshake, send_command_result};
    use crate::{ConnectionState, VsockHost};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{Notify, oneshot};
    use vsock_proto::{
        CommandTermination, Decoder, MSG_COMMAND_START, MSG_ERROR, MSG_PROCESS_EXIT,
        MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK,
    };

    fn registration_counts(host: &VsockHost) -> (usize, usize, usize) {
        let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            ConnectionState::Connected {
                pending, process, ..
            } => {
                let (pending_stdout, stdout_senders) = process.registration_counts();
                (pending.len(), pending_stdout, stdout_senders)
            }
            ConnectionState::Closed { .. } => (0, 0, 0),
        }
    }

    #[tokio::test]
    async fn test_spawn_watch_and_wait() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let payload = vsock_proto::encode_spawn_watch_result(42);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let exit_payload = vsock_proto::encode_process_exit(42, 0, b"done", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, mut stdout_rx) = host
            .spawn_watch("sleep 1", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 42);
        assert!(
            stdout_rx.recv().await.is_none(),
            "buffered spawn_watch must not keep a stdout stream registered",
        );

        let event = host
            .wait_for_exit(42, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.pid, 42);
        assert_eq!(event.exit_code, 0);
        assert_eq!(event.stdout, b"done");
    }

    #[tokio::test]
    async fn test_cached_exit_event() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let payload = vsock_proto::encode_spawn_watch_result(99);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            let exit_payload = vsock_proto::encode_process_exit(99, 1, b"", b"error");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

            let mut combined = resp;
            combined.extend_from_slice(&exit_msg);
            guest.write_all(&combined).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("false", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 99);

        let event = host
            .wait_for_exit(99, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.exit_code, 1);
        assert_eq!(event.stderr, b"error");
    }

    #[tokio::test]
    async fn test_spawn_watch_error_response_cleans_up() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let err_payload = vsock_proto::encode_error("no such command");
            let err_resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &err_payload).unwrap();
            guest.write_all(&err_resp).await.unwrap();

            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let ok_payload = vsock_proto::encode_spawn_watch_result(222);
            let ok_resp =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &ok_payload).unwrap();
            guest.write_all(&ok_resp).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();

        let err = host
            .spawn_watch("bad-cmd", 0, &[], false, true, None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no such command"));
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0),
            "streaming spawn_watch error must clean pending stdout registration",
        );

        let (pid, _stdout_rx) = host
            .spawn_watch("good-cmd", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 222);
    }

    #[tokio::test]
    async fn test_spawn_watch_malformed_result_cleans_up() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            let bad_payload = b"\x00\x01\x02";
            let bad_resp =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, bad_payload).unwrap();
            guest.write_all(&bad_resp).await.unwrap();

            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            let ok_payload = vsock_proto::encode_spawn_watch_result(333);
            let ok_resp =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &ok_payload).unwrap();
            guest.write_all(&ok_resp).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();

        let err = host
            .spawn_watch("bad-payload-cmd", 0, &[], false, true, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0),
            "malformed streaming spawn_watch result must clean pending stdout registration",
        );

        let (pid, _stdout_rx) = host
            .spawn_watch("good-cmd", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 333);
    }

    #[tokio::test]
    async fn test_malformed_unsolicited_process_frames_are_ignored() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let bad_stdout = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, b"\x00\x01").unwrap();
            let bad_exit = vsock_proto::encode(MSG_PROCESS_EXIT, 0, b"\x00\x01").unwrap();
            let mut combined = bad_stdout;
            combined.extend_from_slice(&bad_exit);
            guest.write_all(&combined).await.unwrap();

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let payload = vsock_proto::encode_spawn_watch_result(444);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let exit_payload = vsock_proto::encode_process_exit(444, 0, b"after-malformed", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("after-malformed", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 444);

        let event = host
            .wait_for_exit(pid, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.exit_code, 0);
        assert_eq!(event.stdout, b"after-malformed");
    }

    #[tokio::test]
    async fn test_dropped_stdout_receiver_removes_stream_registration() {
        let (host_stream, mut guest) = make_pair();
        let send_chunk = Arc::new(Notify::new());
        let send_exit = Arc::new(Notify::new());

        {
            let send_chunk = Arc::clone(&send_chunk);
            let send_exit = Arc::clone(&send_exit);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

                let payload = vsock_proto::encode_spawn_watch_result(555);
                let resp =
                    vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
                guest.write_all(&resp).await.unwrap();

                send_chunk.notified().await;
                let chunk_payload = vsock_proto::encode_stdout_chunk(555, b"orphaned chunk");
                let chunk = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, &chunk_payload).unwrap();
                guest.write_all(&chunk).await.unwrap();

                send_exit.notified().await;
                let exit_payload = vsock_proto::encode_process_exit(555, 0, b"", b"");
                let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
                guest.write_all(&exit_msg).await.unwrap();

                let mut discard = [0u8; 1];
                let _ = guest.read(&mut discard).await;
            });
        }

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, stdout_rx) = host
            .spawn_watch("streaming", 0, &[], false, true, None)
            .await
            .unwrap();
        assert_eq!(pid, 555);
        assert_eq!(registration_counts(&host), (0, 0, 1));

        drop(stdout_rx);
        send_chunk.notify_one();

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if registration_counts(&host) == (0, 0, 0) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped stdout receiver should remove stream registration");

        send_exit.notify_one();
        let event = host
            .wait_for_exit(pid, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.exit_code, 0);
    }

    #[tokio::test]
    async fn test_spawn_watch_cancel_cleans_up_registrations() {
        let (host_stream, mut guest) = make_pair();
        let request_seen = Arc::new(Notify::new());
        let release_guest = Arc::new(Notify::new());

        {
            let request_seen = Arc::clone(&request_seen);
            let release_guest = Arc::clone(&release_guest);
            tokio::spawn(async move {
                let mut decoder = Decoder::new();
                mock_handshake(&mut guest, &mut decoder).await;

                let mut buf = [0u8; 4096];
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
                request_seen.notify_one();

                release_guest.notified().await;
            });
        }

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());
        let task_host = Arc::clone(&host);
        let task = tokio::spawn(async move {
            task_host
                .spawn_watch("long-running", 0, &[], false, true, None)
                .await
        });

        tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
            .await
            .expect("guest should receive spawn_watch request");
        assert_eq!(registration_counts(&host), (1, 1, 0));

        task.abort();
        let _ = task.await;
        assert_eq!(
            registration_counts(&host),
            (0, 0, 0),
            "aborted spawn_watch future must clean pending registrations",
        );

        release_guest.notify_one();
    }

    #[tokio::test]
    async fn test_spawn_watch_after_close_returns_immediately() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();

        let start = Instant::now();
        let err = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
            ),
            "expected ConnectionReset or BrokenPipe, got {:?}",
            err.kind()
        );
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "spawn_watch should fail immediately, took {:?}",
            start.elapsed()
        );
    }

    #[tokio::test]
    async fn test_wait_for_exit_no_lost_notification() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let payload = vsock_proto::encode_spawn_watch_result(88);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let exit_payload = vsock_proto::encode_process_exit(88, 7, b"quick", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("quick-exit", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 88);

        let event = host
            .wait_for_exit(88, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.pid, 88);
        assert_eq!(event.exit_code, 7);
        assert_eq!(event.stdout, b"quick");
    }

    #[tokio::test]
    async fn test_wait_for_exit_connection_closed() {
        let (host_stream, mut guest) = make_pair();
        let (close_tx, close_rx) = oneshot::channel();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let payload = vsock_proto::encode_spawn_watch_result(77);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let _ = close_rx.await;
            drop(guest);
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 77);

        let host_for_wait = Arc::clone(&host);
        let wait_task = tokio::spawn(async move {
            host_for_wait
                .wait_for_exit(77, Duration::from_secs(5))
                .await
        });
        close_tx.send(()).unwrap();

        let err = wait_task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    #[tokio::test]
    async fn test_wait_for_exit_returns_cached_event_after_close() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let result_payload = vsock_proto::encode_spawn_watch_result(111);
            let result =
                vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &result_payload).unwrap();
            let exit_payload = vsock_proto::encode_process_exit(111, 3, b"cached-output", b"err");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

            let mut combined = result;
            combined.extend_from_slice(&exit_msg);
            guest.write_all(&combined).await.unwrap();
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("quick-exit", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 111);

        host.wait_until_closed(Duration::from_secs(5))
            .await
            .unwrap();

        let event = host
            .wait_for_exit(pid, Duration::from_secs(5))
            .await
            .expect("cached exit event must survive the Connected -> Closed transition");
        assert_eq!(event.pid, 111);
        assert_eq!(event.exit_code, 3);
        assert_eq!(event.stdout, b"cached-output");
        assert_eq!(event.stderr, b"err");
    }

    #[tokio::test]
    async fn test_wait_for_exit_timeout() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            let payload = vsock_proto::encode_spawn_watch_result(55);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 55);

        let err = host
            .wait_for_exit(pid, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn test_concurrent_exec_and_wait_exit() {
        let (host_stream, mut guest) = make_pair();
        let (send_exit, exit_after_exec) = oneshot::channel();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let spawn_seq = msgs[0].seq;

            let payload = vsock_proto::encode_spawn_watch_result(50);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, spawn_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);
            let exec_seq = msgs[0].seq;

            send_command_result(
                &mut guest,
                exec_seq,
                CommandTermination::Exited { exit_code: 0 },
                b"concurrent",
                b"",
            )
            .await;

            let _ = exit_after_exec.await;
            let exit_payload = vsock_proto::encode_process_exit(50, 42, b"exited", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());
        let (pid, _stdout_rx) = host
            .spawn_watch("long-running", 0, &[], false, false, None)
            .await
            .unwrap();
        assert_eq!(pid, 50);

        let host2 = Arc::clone(&host);
        let wait_task =
            tokio::spawn(async move { host2.wait_for_exit(50, Duration::from_secs(5)).await });

        let exec_result = host
            .exec("echo concurrent", 5000, &[], false)
            .await
            .unwrap();
        assert_eq!(exec_result.exit_code, 0);
        assert_eq!(exec_result.stdout, b"concurrent");

        send_exit.send(()).unwrap();

        let exit_event = wait_task.await.unwrap().unwrap();
        assert_eq!(exit_event.pid, 50);
        assert_eq!(exit_event.exit_code, 42);
        assert_eq!(exit_event.stdout, b"exited");
    }
}
