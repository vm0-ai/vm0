use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;
use tokio::time::{self, Instant};
use vsock_proto::{Decoder, MSG_PING, MSG_PONG, MSG_READY, RawMessage};

use crate::operation_tracker::NormalOperationTracker;
use crate::{VsockHost, exec_operation, file};

use super::request::deadline_after;
use super::{ConnectionState, READ_BUF_SIZE, Shared, reader_loop};

struct ListenerSocketGuard {
    path: Option<String>,
}

impl ListenerSocketGuard {
    fn remove(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for ListenerSocketGuard {
    fn drop(&mut self) {
        self.remove();
    }
}

impl VsockHost {
    /// Wait for a guest to connect on the vsock UDS path.
    ///
    /// Creates a UDS listener at `{vsock_path}_{port}`, accepts the first
    /// connection, and performs the ready/ping/pong handshake.
    ///
    /// Returns [`io::ErrorKind::InvalidInput`] if `timeout` cannot be
    /// represented as a Tokio deadline.
    pub async fn wait_for_connection(vsock_path: &str, timeout: Duration) -> io::Result<Self> {
        let deadline = deadline_after(timeout, "guest connection timeout overflowed")?;
        let listener_path = format!("{vsock_path}_{}", vsock_proto::VSOCK_PORT);

        // Clean up stale socket
        let _ = std::fs::remove_file(&listener_path);

        let listener = UnixListener::bind(&listener_path)?;
        let mut listener_socket = ListenerSocketGuard {
            path: Some(listener_path.clone()),
        };

        let accept_result = time::timeout_at(deadline, listener.accept()).await;

        // Stop accepting and unlink the listener socket before the accepted
        // stream is handed off. The guard still covers cancellation before
        // this point.
        drop(listener);
        listener_socket.remove();

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
    pub(crate) async fn from_stream(stream: UnixStream, deadline: Instant) -> io::Result<Self> {
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
            frame_builder: tokio::sync::Mutex::new(()),
            file_write_gate: tokio::sync::Mutex::new(()),
            fd,
            seq: AtomicU32::new(2),
            state: std::sync::Mutex::new(ConnectionState::Connected {
                pending: HashMap::new(),
                operations: exec_operation::Operations::new(),
            }),
            normal_operations: NormalOperationTracker::new(),
            close_notify: Notify::new(),
            #[cfg(test)]
            exec_output_before_copy_hook: std::sync::Mutex::new(None),
        });

        let reader_shared = Arc::clone(&shared);
        let reader = tokio::spawn(reader_loop(read_half, handshake_decoder, reader_shared));

        Ok(Self {
            shared,
            file_write_path_locks: file::FileWritePathLocks::default(),
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
}
