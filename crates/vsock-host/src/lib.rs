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

use std::collections::HashMap;
use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
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

/// Host-side vsock endpoint.
///
/// Maintains a persistent connection to the guest agent and provides
/// high-level methods for command execution, file operations, and
/// process lifecycle management.
pub struct VsockHost {
    stream: UnixStream,
    decoder: Decoder,
    next_seq: u32,
    /// Cached exit events for processes that exited before `wait_for_exit` was called.
    cached_exits: HashMap<u32, ProcessExitEvent>,
    /// Reusable read buffer (avoids inflating async Future size).
    read_buf: Box<[u8; READ_BUF_SIZE]>,
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

        let mut host = Self {
            stream,
            decoder: Decoder::new(),
            next_seq: 1,
            cached_exits: HashMap::new(),
            read_buf: Box::new([0u8; READ_BUF_SIZE]),
        };

        host.handshake(deadline).await?;

        Ok(host)
    }

    /// Read one batch of messages from the stream.
    ///
    /// Blocks until data is available (respecting the deadline). Returns all
    /// decoded messages. Caches any unsolicited process_exit events.
    async fn read_and_dispatch(&mut self, deadline: Instant) -> io::Result<Vec<RawMessage>> {
        let n = time::timeout_at(deadline, self.stream.read(self.read_buf.as_mut()))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "read timeout"))??;

        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        }

        let messages = self
            .decoder
            // n <= read_buf.len() is guaranteed by read()
            .decode(self.read_buf.get(..n).unwrap_or_default())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        // Cache all unsolicited process_exit events, return remaining messages.
        let mut result = Vec::with_capacity(messages.len());
        for msg in messages {
            if msg.msg_type == MSG_PROCESS_EXIT && msg.seq == 0 {
                self.cache_exit_event(&msg)?;
            } else {
                result.push(msg);
            }
        }
        Ok(result)
    }

    /// Parse and cache a process_exit event from a raw message.
    fn cache_exit_event(&mut self, msg: &RawMessage) -> io::Result<()> {
        let (pid, exit_code, stdout, stderr) = vsock_proto::decode_process_exit(&msg.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        self.cached_exits.insert(
            pid,
            ProcessExitEvent {
                pid,
                exit_code,
                stdout: stdout.to_vec(),
                stderr: stderr.to_vec(),
            },
        );
        Ok(())
    }

    /// Perform the connection handshake: ready → ping → pong.
    async fn handshake(&mut self, deadline: Instant) -> io::Result<()> {
        // Wait for ready
        self.read_until(deadline, |m| m.msg_type == MSG_READY)
            .await?;

        // Send ping
        let seq = self.next_seq();
        let ping = vsock_proto::encode(MSG_PING, seq, &[])
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        self.stream.write_all(&ping).await?;

        // Wait for pong with matching seq
        self.read_until(deadline, |m| m.msg_type == MSG_PONG && m.seq == seq)
            .await?;

        Ok(())
    }

    /// Read messages until one matches the predicate or deadline is reached.
    ///
    /// All messages in each batch are fully processed (exit events cached)
    /// before returning.
    async fn read_until(
        &mut self,
        deadline: Instant,
        predicate: impl Fn(&RawMessage) -> bool,
    ) -> io::Result<RawMessage> {
        loop {
            let messages = self.read_and_dispatch(deadline).await?;
            for msg in messages {
                if predicate(&msg) {
                    return Ok(msg);
                }
            }
        }
    }

    /// Get next sequence number, wrapping around and skipping 0.
    fn next_seq(&mut self) -> u32 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        if self.next_seq == 0 {
            self.next_seq = 1;
        }
        seq
    }

    /// Send a request and wait for a response with matching sequence number.
    async fn request(
        &mut self,
        msg_type: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<RawMessage> {
        let seq = self.next_seq();
        let data = vsock_proto::encode(msg_type, seq, payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        self.stream.write_all(&data).await?;

        let deadline = Instant::now() + timeout;
        self.read_until(deadline, |m| m.seq == seq).await
    }

    /// Execute a command on the guest.
    pub async fn exec(&mut self, command: &str, timeout_ms: u32) -> io::Result<ExecResult> {
        let payload = vsock_proto::encode_exec(timeout_ms, command);
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
    pub async fn write_file(&mut self, path: &str, content: &[u8], sudo: bool) -> io::Result<()> {
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
    pub async fn spawn_watch(&mut self, command: &str, timeout_ms: u32) -> io::Result<u32> {
        let payload = vsock_proto::encode_exec(timeout_ms, command);
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
    pub async fn wait_for_exit(
        &mut self,
        pid: u32,
        timeout: Duration,
    ) -> io::Result<ProcessExitEvent> {
        // Check cache first
        if let Some(event) = self.cached_exits.remove(&pid) {
            return Ok(event);
        }

        let deadline = Instant::now() + timeout;
        loop {
            // read_and_dispatch caches all exit events from this batch
            self.read_and_dispatch(deadline).await?;

            // Check if our PID was among them
            if let Some(event) = self.cached_exits.remove(&pid) {
                return Ok(event);
            }
        }
    }

    /// Request graceful shutdown from guest.
    ///
    /// Returns `true` if guest acknowledged, `false` on timeout.
    pub async fn shutdown(&mut self, timeout: Duration) -> bool {
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
        let mut host = VsockHost {
            stream,
            decoder: Decoder::new(),
            next_seq: 1,
            cached_exits: HashMap::new(),
            read_buf: Box::new([0u8; READ_BUF_SIZE]),
        };

        let deadline = Instant::now() + Duration::from_secs(5);
        host.handshake(deadline).await?;
        Ok(host)
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

            let (timeout, cmd) = vsock_proto::decode_exec(&msgs[0].payload).unwrap();
            assert_eq!(cmd, "echo hello");
            assert_eq!(timeout, 5000);

            let payload = vsock_proto::encode_exec_result(0, b"hello\n", b"");
            let resp = vsock_proto::encode(MSG_EXEC_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
        });

        let mut host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("echo hello", 5000).await.unwrap();
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

        let mut host = host_from_stream(host_stream).await.unwrap();
        let result = host.exec("badcmd", 5000).await.unwrap();
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

        let mut host = host_from_stream(host_stream).await.unwrap();
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

        let mut host = host_from_stream(host_stream).await.unwrap();
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

        let mut host = host_from_stream(host_stream).await.unwrap();
        let pid = host.spawn_watch("sleep 1", 0).await.unwrap();
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

        let mut host = host_from_stream(host_stream).await.unwrap();
        let pid = host.spawn_watch("false", 0).await.unwrap();
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

        let mut host = host_from_stream(host_stream).await.unwrap();
        assert!(host.shutdown(Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn test_corrupted_process_exit_returns_error() {
        let (host_stream, mut guest) = make_pair();

        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            // Read the exec request from host
            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_EXEC);

            // Send a corrupted process_exit (truncated payload) before the exec response.
            // This exercises cache_exit_event's error path during read_and_dispatch.
            let corrupted = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &[0x00, 0x01]).unwrap();
            guest.write_all(&corrupted).await.unwrap();
        });

        let mut host = host_from_stream(host_stream).await.unwrap();

        // exec triggers read_and_dispatch which encounters the corrupted process_exit
        let err = host.exec("echo hi", 5000).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
