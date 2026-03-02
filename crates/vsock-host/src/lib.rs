//! Host-side vsock endpoint for Firecracker VM communication.
//!
//! Connects to a guest agent via Unix domain socket (Firecracker forwards
//! vsock connections to `{vsock_path}_{port}` UDS files).
//!
//! ## Connection Flow
//!
//! 1. Host creates UDS listener at `{vsock_path}_{port}`
//! 2. Guest boots and vsock-guest connects to CID=2
//! 3. Firecracker forwards connection to Host's UDS listener
//! 4. Host accepts, receives `ready`, sends `ping`, waits for `pong`
//! 5. Connection established — host can send commands
//!
//! ## Concurrency
//!
//! After connection, a background reader task owns the read half of the
//! stream exclusively. All public methods take `&self` and can be called
//! concurrently. Responses are dispatched to callers via oneshot channels
//! keyed by sequence number.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};

use vsock_proto::{
    Decoder, MSG_ERROR, MSG_EXEC, MSG_EXEC_RESULT, MSG_PING, MSG_PONG, MSG_PROCESS_EXIT, MSG_READY,
    MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, RawMessage,
};

const READ_BUF_SIZE: usize = 64 * 1024;

/// Result of executing a command on the guest.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Event emitted when a spawned process exits.
#[derive(Debug, Clone)]
pub struct ProcessExitEvent {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Shared state between the reader task and public API methods.
struct Shared {
    /// Serialises writes to the stream.
    writer: tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    /// Monotonically increasing sequence number (starts at 2, skips 0).
    /// Handshake uses seq=1 before Shared is created, so post-handshake
    /// sequences start at 2 to avoid collisions.
    seq: AtomicU32,
    /// Pending request responses: seq → oneshot sender.
    pending: std::sync::Mutex<HashMap<u32, oneshot::Sender<RawMessage>>>,
    /// Cached process exit events (unsolicited, seq=0).
    exits: std::sync::Mutex<HashMap<u32, ProcessExitEvent>>,
    /// Notified when a new exit event arrives.
    exit_notify: Notify,
    /// Set to `true` when the reader task exits (before `closed.notify_waiters()`).
    /// Checked by `request` and `wait_for_exit` to detect a close that happened
    /// before their `Notified` futures were created.
    is_closed: AtomicBool,
    /// Notified when the connection is lost (reader task exited).
    closed: Notify,
}

impl Shared {
    /// Get next sequence number, skipping 0 (reserved for unsolicited messages).
    fn next_seq(&self) -> u32 {
        loop {
            let seq = self.seq.fetch_add(1, Ordering::Relaxed);
            if seq != 0 {
                return seq;
            }
            // Wrapped to 0 — skip it.
        }
    }
}

/// Host-side vsock endpoint.
///
/// Maintains a persistent connection to the guest agent and provides
/// high-level methods for command execution, file operations, and
/// process lifecycle management.
///
/// All public methods take `&self` and can be called concurrently.
/// A background reader task dispatches incoming messages to the
/// appropriate caller.
pub struct VsockHost {
    shared: Arc<Shared>,
    _reader: JoinHandle<()>,
    /// Raw fd of the underlying socket, used for shutdown on Drop.
    ///
    /// `shutdown(SHUT_RDWR)` does NOT close the fd — it only signals EOF,
    /// unblocking the reader_loop's async read and any remote peer's
    /// blocking read. The fd itself is still owned by the read/write halves
    /// and is closed normally when they are dropped.
    fd: std::os::unix::io::RawFd,
}

impl Drop for VsockHost {
    fn drop(&mut self) {
        // Signal EOF on the socket so the reader_loop's `read()` and the
        // remote peer's blocking `read()` return immediately. Without this,
        // the split stream halves keep the fd alive until the reader task is
        // cancelled, which requires an async yield — not possible in Drop.
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
        self._reader.abort();
    }
}

/// Background reader task: owns the read half and decoder exclusively.
///
/// Dispatches responses to pending requests by seq number, and caches
/// unsolicited process_exit events for `wait_for_exit`.
async fn reader_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    mut decoder: Decoder,
    shared: Arc<Shared>,
) {
    let mut buf = Box::new([0u8; READ_BUF_SIZE]);
    loop {
        let n = match reader.read(buf.as_mut()).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // n <= READ_BUF_SIZE guaranteed by read()
        let messages = match decoder.decode(buf.get(..n).unwrap_or_default()) {
            Ok(msgs) => msgs,
            Err(_) => break,
        };
        for msg in messages {
            if msg.msg_type == MSG_PROCESS_EXIT && msg.seq == 0 {
                if let Ok((pid, exit_code, stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                {
                    let event = ProcessExitEvent {
                        pid,
                        exit_code,
                        stdout: stdout.to_vec(),
                        stderr: stderr.to_vec(),
                    };
                    {
                        let mut exits = shared.exits.lock().unwrap_or_else(|e| e.into_inner());
                        exits.insert(pid, event);
                    }
                    shared.exit_notify.notify_waiters();
                }
            } else {
                let sender = {
                    let mut pending = shared.pending.lock().unwrap_or_else(|e| e.into_inner());
                    pending.remove(&msg.seq)
                };
                if let Some(tx) = sender {
                    let _ = tx.send(msg);
                }
            }
        }
    }
    // Connection lost — drop all pending senders so receivers get RecvError.
    shared
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    // Set flag BEFORE notify so that callers who haven't registered yet
    // can detect the close via the flag.
    shared.is_closed.store(true, Ordering::Release);
    shared.closed.notify_waiters();
    shared.exit_notify.notify_waiters();
}

impl VsockHost {
    /// Wait for a guest to connect on the vsock UDS path.
    ///
    /// Creates a UDS listener at `{vsock_path}_{port}`, accepts the first
    /// connection, and performs the ready/ping/pong handshake.
    pub async fn wait_for_connection(vsock_path: &str, timeout: Duration) -> io::Result<Self> {
        let listener_path = format!("{vsock_path}_{}", vsock_proto::VSOCK_PORT);

        // Clean up stale socket
        let _ = std::fs::remove_file(&listener_path);

        let listener = UnixListener::bind(&listener_path)?;
        let deadline = Instant::now() + timeout;

        let accept_result = time::timeout_at(deadline, listener.accept()).await;

        // Clean up listener socket regardless of outcome — only one connection expected
        drop(listener);
        let _ = std::fs::remove_file(&listener_path);

        let (stream, _) = accept_result.map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("guest connection timeout after {}ms", timeout.as_millis()),
            )
        })??;

        Self::from_stream(stream, deadline).await
    }

    /// Build a `VsockHost` from an already-connected stream.
    ///
    /// Performs the handshake on the unsplit stream, then splits it and
    /// spawns the background reader task.
    async fn from_stream(stream: UnixStream, deadline: Instant) -> io::Result<Self> {
        // Handshake on the unsplit stream (reader task not running yet).
        let (stream, handshake_decoder) = Self::handshake(stream, deadline).await?;

        // Grab the raw fd BEFORE splitting — used by Drop to shutdown the
        // socket and unblock any pending reads (both our reader_loop and the
        // remote peer).
        let fd = {
            use std::os::unix::io::AsRawFd;
            stream.as_raw_fd()
        };

        // Split the stream and spawn the reader task.
        let (read_half, write_half) = stream.into_split();

        let shared = Arc::new(Shared {
            writer: tokio::sync::Mutex::new(write_half),
            seq: AtomicU32::new(2),
            pending: std::sync::Mutex::new(HashMap::new()),
            exits: std::sync::Mutex::new(HashMap::new()),
            exit_notify: Notify::new(),
            is_closed: AtomicBool::new(false),
            closed: Notify::new(),
        });

        let reader_shared = Arc::clone(&shared);
        let reader = tokio::spawn(reader_loop(read_half, handshake_decoder, reader_shared));

        Ok(Self {
            shared,
            _reader: reader,
            fd,
        })
    }

    /// Perform the connection handshake: ready → ping → pong.
    ///
    /// Returns the stream and decoder for reuse by the reader task.
    async fn handshake(
        mut stream: UnixStream,
        deadline: Instant,
    ) -> io::Result<(UnixStream, Decoder)> {
        let mut decoder = Decoder::new();
        let mut buf = Box::new([0u8; READ_BUF_SIZE]);

        // Wait for ready
        Self::read_until_handshake(&mut stream, &mut decoder, &mut buf, deadline, |m| {
            m.msg_type == MSG_READY
        })
        .await?;

        // Send ping with a fixed seq. Shared.seq starts at 2 to avoid collision.
        let ping_seq: u32 = 1;
        let ping = vsock_proto::encode(MSG_PING, ping_seq, &[])
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        stream.write_all(&ping).await?;

        // Wait for pong with matching seq
        Self::read_until_handshake(&mut stream, &mut decoder, &mut buf, deadline, |m| {
            m.msg_type == MSG_PONG && m.seq == ping_seq
        })
        .await?;

        Ok((stream, decoder))
    }

    /// Read messages until one matches the predicate (used during handshake only).
    async fn read_until_handshake(
        stream: &mut UnixStream,
        decoder: &mut Decoder,
        buf: &mut [u8; READ_BUF_SIZE],
        deadline: Instant,
        predicate: impl Fn(&RawMessage) -> bool,
    ) -> io::Result<RawMessage> {
        loop {
            let n = time::timeout_at(deadline, stream.read(buf.as_mut()))
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "handshake timeout"))??;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed during handshake",
                ));
            }
            let messages = decoder
                .decode(buf.get(..n).unwrap_or_default())
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            for msg in messages {
                if predicate(&msg) {
                    return Ok(msg);
                }
            }
        }
    }

    /// Send a request and wait for a response with matching sequence number.
    async fn request(
        &self,
        msg_type: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<RawMessage> {
        let seq = self.shared.next_seq();
        let data = vsock_proto::encode(msg_type, seq, payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

        // Register for close notification BEFORE inserting pending entry so
        // we don't miss a close that happens between insert and select!.
        let closed_notified = self.shared.closed.notified();
        tokio::pin!(closed_notified);
        closed_notified.as_mut().enable();

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pending.insert(seq, tx);
        }

        // Write to stream; clean up pending entry on failure.
        if let Err(e) = self.shared.writer.lock().await.write_all(&data).await {
            self.shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&seq);
            return Err(e);
        }

        // If the reader already exited before we registered, closed_notified
        // may never fire. The flag catches this case.
        if self.shared.is_closed.load(Ordering::Acquire) {
            self.shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&seq);
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        }

        // biased: prioritise the response channel over connection-closed so
        // that a response arriving just before EOF is not lost.
        tokio::select! {
            biased;
            result = rx => {
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
            }
            _ = tokio::time::sleep(timeout) => {
                self.shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&seq);
                Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
            }
            _ = closed_notified => {
                self.shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&seq);
                Err(io::Error::new(io::ErrorKind::ConnectionReset, "connection closed"))
            }
        }
    }

    /// Execute a command on the guest.
    pub async fn exec(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
    ) -> io::Result<ExecResult> {
        let payload = vsock_proto::encode_exec(timeout_ms, command, env, sudo);
        // Add 5s buffer for network latency
        let timeout = Duration::from_millis(timeout_ms as u64 + 5000);
        let resp = self.request(MSG_EXEC, &payload, timeout).await?;

        if resp.msg_type == MSG_ERROR {
            let msg = vsock_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Ok(ExecResult {
                exit_code: 1,
                stdout: Vec::new(),
                stderr: msg.as_bytes().to_vec(),
            });
        }

        if resp.msg_type != MSG_EXEC_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let (exit_code, stdout, stderr) = vsock_proto::decode_exec_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        Ok(ExecResult {
            exit_code,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        })
    }

    /// Write a file on the guest.
    pub async fn write_file(&self, path: &str, content: &[u8], sudo: bool) -> io::Result<()> {
        let payload = vsock_proto::encode_write_file(path, content, sudo)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        let timeout = Duration::from_secs(300);
        let resp = self.request(MSG_WRITE_FILE, &payload, timeout).await?;

        if resp.msg_type == MSG_ERROR {
            let msg = vsock_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(io::Error::other(msg));
        }

        if resp.msg_type != MSG_WRITE_FILE_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let (success, error) = vsock_proto::decode_write_file_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        if !success {
            return Err(io::Error::other(error));
        }

        Ok(())
    }

    /// Spawn a process on the guest and monitor for exit.
    ///
    /// Returns immediately with the PID. Use [`wait_for_exit`](Self::wait_for_exit)
    /// to wait for completion.
    pub async fn spawn_watch(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
    ) -> io::Result<u32> {
        let payload = vsock_proto::encode_exec(timeout_ms, command, env, sudo);
        let resp = self
            .request(MSG_SPAWN_WATCH, &payload, Duration::from_secs(30))
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

        vsock_proto::decode_spawn_watch_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
    }

    /// Wait for a spawned process to exit.
    ///
    /// Returns immediately if the exit event was already cached.
    pub async fn wait_for_exit(&self, pid: u32, timeout: Duration) -> io::Result<ProcessExitEvent> {
        let deadline = Instant::now() + timeout;
        loop {
            // Register interest in notifications BEFORE checking the cache.
            // `enable()` ensures that a `notify_waiters()` call between the
            // cache check and `select!` is not lost.
            let exit_notified = self.shared.exit_notify.notified();
            let closed_notified = self.shared.closed.notified();
            tokio::pin!(exit_notified, closed_notified);
            exit_notified.as_mut().enable();
            closed_notified.as_mut().enable();

            // Check cache after enabling — any notification from this point on
            // is guaranteed to wake us.
            {
                let mut exits = self.shared.exits.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(event) = exits.remove(&pid) {
                    return Ok(event);
                }
            }

            // If the reader already exited before we created the Notified
            // futures, notify_waiters() has already fired and won't fire
            // again. The is_closed flag catches this case.
            if self.shared.is_closed.load(Ordering::Acquire) {
                let mut exits = self.shared.exits.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(event) = exits.remove(&pid) {
                    return Ok(event);
                }
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }

            tokio::select! {
                biased;
                _ = exit_notified => {
                    // Notification received — re-check cache on next iteration.
                }
                _ = closed_notified => {
                    // Check one last time — event might have been cached before close.
                    let mut exits = self.shared.exits.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(event) = exits.remove(&pid) {
                        return Ok(event);
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "wait timeout"));
                }
            }
        }
    }

    /// Request graceful shutdown from guest.
    ///
    /// Returns `true` if guest acknowledged, `false` on timeout.
    pub async fn shutdown(&self, timeout: Duration) -> bool {
        let result = self.request(MSG_SHUTDOWN, &[], timeout).await;
        matches!(result, Ok(ref m) if m.msg_type == MSG_SHUTDOWN_ACK)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn make_pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    /// Perform mock guest handshake: send ready, receive ping, send pong.
    async fn mock_handshake(stream: &mut UnixStream, decoder: &mut Decoder) {
        // Send ready
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).unwrap();
        stream.write_all(&ready).await.unwrap();

        // Read ping
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_PING);

        // Send pong
        let pong = vsock_proto::encode(MSG_PONG, msgs[0].seq, &[]).unwrap();
        stream.write_all(&pong).await.unwrap();
    }

    async fn host_from_stream(stream: UnixStream) -> io::Result<VsockHost> {
        let deadline = Instant::now() + Duration::from_secs(5);
        VsockHost::from_stream(stream, deadline).await
    }

    #[tokio::test]
    async fn test_exec() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);

            let d = vsock_proto::decode_exec(&msgs[0].payload).unwrap();
            assert_eq!(d.command, "echo hello");
            assert_eq!(d.timeout_ms, 5000);
            assert!(d.env.is_empty());
            assert!(!d.sudo);

            let payload = vsock_proto::encode_exec_result(0, b"hello\n", b"");
            let resp = vsock_proto::encode(MSG_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("echo hello", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, b"hello\n");
        assert!(result.stderr.is_empty());
    }

    #[tokio::test]
    async fn test_exec_error_response() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();

            let payload = vsock_proto::encode_error("command not found");
            let resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("badcmd", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.stderr, b"command not found");
    }

    #[tokio::test]
    async fn test_write_file() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_WRITE_FILE);

            let (path, content, sudo) = vsock_proto::decode_write_file(&msgs[0].payload).unwrap();
            assert_eq!(path, "/tmp/test.txt");
            assert_eq!(content, b"hello");
            assert!(!sudo);

            let payload = vsock_proto::encode_write_file_result(true, "");
            let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        host.write_file("/tmp/test.txt", b"hello", false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_write_file_failure() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();

            let payload = vsock_proto::encode_write_file_result(false, "permission denied");
            let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host
            .write_file("/etc/shadow", b"bad", false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("permission denied"));
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

            // Send spawn_watch_result with pid=42
            let payload = vsock_proto::encode_spawn_watch_result(42);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Send process_exit (unsolicited, seq=0)
            let exit_payload = vsock_proto::encode_process_exit(42, 0, b"done", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            // Keep connection alive until host drops
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let pid = host.spawn_watch("sleep 1", 0, &[], false).await.unwrap();
        assert_eq!(pid, 42);

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

            // Send spawn_watch_result followed immediately by process_exit
            // in the same write, so they arrive together before wait_for_exit
            let payload = vsock_proto::encode_spawn_watch_result(99);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            let exit_payload = vsock_proto::encode_process_exit(99, 1, b"", b"error");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

            // Write both together
            let mut combined = resp;
            combined.extend_from_slice(&exit_msg);
            guest.write_all(&combined).await.unwrap();

            // Keep connection alive until host drops
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let pid = host.spawn_watch("false", 0, &[], false).await.unwrap();
        assert_eq!(pid, 99);

        let event = host
            .wait_for_exit(99, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.exit_code, 1);
        assert_eq!(event.stderr, b"error");
    }

    #[tokio::test]
    async fn test_shutdown() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SHUTDOWN);

            let resp = vsock_proto::encode(MSG_SHUTDOWN_ACK, msgs[0].seq, &[]).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        assert!(host.shutdown(Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn test_connection_closed_returns_error() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read the exec request then close the connection.
            let mut buf = [0u8; 4096];
            let _ = guest.read(&mut buf).await.unwrap();
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let err = host.exec("echo hi", 5000, &[], false).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    /// Request made after connection is already closed returns ConnectionReset
    /// immediately (not after timeout).
    #[tokio::test]
    async fn test_request_after_close_returns_immediately() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;
            // Close immediately after handshake.
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();

        // Wait for reader to detect close.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // This should fail quickly (via write error or is_closed check),
        // NOT wait for the 5s exec timeout.
        let start = Instant::now();
        let err = host.exec("echo hi", 5000, &[], false).await.unwrap_err();
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
            "request should fail immediately, took {:?}",
            start.elapsed()
        );
    }

    /// Two concurrent exec calls get the correct response matched by seq.
    #[tokio::test]
    async fn test_concurrent_execs() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read both exec requests (may arrive in one or two reads).
            let mut all_msgs = Vec::new();
            let mut buf = [0u8; 4096];
            while all_msgs.len() < 2 {
                let n = guest.read(&mut buf).await.unwrap();
                let msgs = decoder.decode(&buf[..n]).unwrap();
                all_msgs.extend(msgs);
            }
            assert_eq!(all_msgs.len(), 2);
            assert!(all_msgs.iter().all(|m| m.msg_type == MSG_EXEC));

            // Reply in reverse order to exercise seq-based dispatching.
            for msg in all_msgs.iter().rev() {
                let d = vsock_proto::decode_exec(&msg.payload).unwrap();
                let out = format!("reply:{}", d.command);
                let payload = vsock_proto::encode_exec_result(0, out.as_bytes(), b"");
                let resp = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
                guest.write_all(&resp).await.unwrap();
            }

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());

        let h1 = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.exec("cmd-a", 5000, &[], false).await })
        };
        let h2 = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.exec("cmd-b", 5000, &[], false).await })
        };

        let r1 = h1.await.unwrap().unwrap();
        let r2 = h2.await.unwrap().unwrap();

        // Each response matches its own command, regardless of reply order.
        let out1 = String::from_utf8_lossy(&r1.stdout);
        let out2 = String::from_utf8_lossy(&r2.stdout);
        assert_eq!(out1, "reply:cmd-a");
        assert_eq!(out2, "reply:cmd-b");
    }

    /// Verify that post-handshake request seq starts at 2 (seq=1 is used by handshake ping).
    #[tokio::test]
    async fn test_seq_starts_at_2() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read the first exec request and verify its seq.
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);
            // Handshake used seq=1, so first request must be seq=2.
            assert_eq!(msgs[0].seq, 2, "first post-handshake seq should be 2");

            let payload = vsock_proto::encode_exec_result(0, b"ok", b"");
            let resp = vsock_proto::encode(MSG_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("test", 5000, &[], false).await.unwrap();
        assert_eq!(result.exit_code, 0);
    }

    /// Exit event arrives between wait_for_exit registration and select! —
    /// the enable() pattern ensures the notification is not lost.
    #[tokio::test]
    async fn test_wait_for_exit_no_lost_notification() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch request
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Reply with pid=88
            let payload = vsock_proto::encode_spawn_watch_result(88);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Immediately send exit event — this races with host calling wait_for_exit
            let exit_payload = vsock_proto::encode_process_exit(88, 7, b"quick", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            // Keep alive
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let pid = host.spawn_watch("quick-exit", 0, &[], false).await.unwrap();
        assert_eq!(pid, 88);

        // The exit event may already be cached OR still in-flight. Either way
        // wait_for_exit must succeed (not hang or lose the notification).
        let event = host
            .wait_for_exit(88, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(event.pid, 88);
        assert_eq!(event.exit_code, 7);
        assert_eq!(event.stdout, b"quick");
    }

    /// wait_for_exit returns an error when the connection drops.
    #[tokio::test]
    async fn test_wait_for_exit_connection_closed() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch request
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            // Reply with pid=77
            let payload = vsock_proto::encode_spawn_watch_result(77);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Small delay then close the connection WITHOUT sending process_exit.
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(guest);
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let pid = host
            .spawn_watch("long-running", 0, &[], false)
            .await
            .unwrap();
        assert_eq!(pid, 77);

        let err = host
            .wait_for_exit(77, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    }

    /// Prove the core requirement: wait_for_exit and exec can run concurrently.
    #[tokio::test]
    async fn test_concurrent_exec_and_wait_exit() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read spawn_watch request
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            let spawn_seq = msgs[0].seq;

            // Reply with pid=50
            let payload = vsock_proto::encode_spawn_watch_result(50);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, spawn_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            // Now read the exec request (sent concurrently with wait_for_exit)
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);
            let exec_seq = msgs[0].seq;

            // Reply to exec first
            let exec_payload = vsock_proto::encode_exec_result(0, b"concurrent", b"");
            let exec_resp = vsock_proto::encode(MSG_EXEC_RESULT, exec_seq, &exec_payload).unwrap();
            guest.write_all(&exec_resp).await.unwrap();

            // Small delay then send process_exit
            tokio::time::sleep(Duration::from_millis(50)).await;
            let exit_payload = vsock_proto::encode_process_exit(50, 42, b"exited", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            // Keep alive
            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });

        let host = Arc::new(host_from_stream(host_stream).await.unwrap());
        let pid = host
            .spawn_watch("long-running", 0, &[], false)
            .await
            .unwrap();
        assert_eq!(pid, 50);

        // Start wait_for_exit in background
        let host2 = Arc::clone(&host);
        let wait_task =
            tokio::spawn(async move { host2.wait_for_exit(50, Duration::from_secs(5)).await });

        // Concurrently call exec — this should NOT block on wait_for_exit
        let exec_result = host
            .exec("echo concurrent", 5000, &[], false)
            .await
            .unwrap();
        assert_eq!(exec_result.exit_code, 0);
        assert_eq!(exec_result.stdout, b"concurrent");

        // wait_for_exit should also resolve
        let exit_event = wait_task.await.unwrap().unwrap();
        assert_eq!(exit_event.pid, 50);
        assert_eq!(exit_event.exit_code, 42);
        assert_eq!(exit_event.stdout, b"exited");
    }
}
