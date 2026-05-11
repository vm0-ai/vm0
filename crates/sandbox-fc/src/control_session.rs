use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use uuid::Uuid;
use vsock_host::{ControlHandshake, VsockHost};

const QUIESCE_BUSY_RETRY_DELAY: Duration = Duration::from_millis(10);

#[derive(Clone)]
pub(crate) struct ControlSessionManager {
    inner: Arc<Mutex<ControlSessionState>>,
}

enum ControlSessionState {
    Disconnected,
    Dialing,
    Active {
        host: Arc<VsockHost>,
        active_ops: usize,
    },
    Quiescing {
        host: Arc<VsockHost>,
    },
    Closed,
}

pub(crate) struct ControlOperation {
    manager: ControlSessionManager,
    host: Arc<VsockHost>,
}

struct DialingGuard {
    manager: ControlSessionManager,
    armed: bool,
}

struct QuiescingGuard {
    manager: ControlSessionManager,
    armed: bool,
}

impl ControlOperation {
    pub(crate) fn host(&self) -> &VsockHost {
        &self.host
    }
}

impl DialingGuard {
    fn new(manager: ControlSessionManager) -> Self {
        Self {
            manager,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DialingGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.manager.inner.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(&*state, ControlSessionState::Dialing) {
            *state = ControlSessionState::Disconnected;
        }
    }
}

impl QuiescingGuard {
    fn new(manager: ControlSessionManager) -> Self {
        Self {
            manager,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for QuiescingGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.manager.inner.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(&*state, ControlSessionState::Quiescing { .. }) {
            *state = ControlSessionState::Closed;
        }
    }
}

impl Drop for ControlOperation {
    fn drop(&mut self) {
        self.manager.release_operation();
    }
}

impl Default for ControlSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlSessionManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ControlSessionState::Disconnected)),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_active_host(host: Arc<VsockHost>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ControlSessionState::Active {
                host,
                active_ops: 0,
            })),
        }
    }

    pub(crate) async fn connect(
        &self,
        vsock_path: &str,
        timeout: Duration,
        boot_generation: Option<&str>,
    ) -> io::Result<()> {
        {
            let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            match &*state {
                ControlSessionState::Disconnected => {
                    *state = ControlSessionState::Dialing;
                }
                ControlSessionState::Dialing => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session already dialing",
                    ));
                }
                ControlSessionState::Active { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "control session already active",
                    ));
                }
                ControlSessionState::Quiescing { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session is quiescing",
                    ));
                }
                ControlSessionState::Closed => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "control session manager closed",
                    ));
                }
            }
        }
        let mut dialing_guard = DialingGuard::new(self.clone());

        let nonce = *Uuid::new_v4().as_bytes();
        let result = VsockHost::connect_host_initiated(
            vsock_path,
            timeout,
            ControlHandshake {
                session_nonce: &nonce,
                boot_generation,
            },
        )
        .await
        .map(Arc::new);

        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let result = match (&*state, result) {
            (ControlSessionState::Dialing, Ok(host)) => {
                *state = ControlSessionState::Active {
                    host,
                    active_ops: 0,
                };
                Ok(())
            }
            (ControlSessionState::Dialing, Err(error)) => {
                *state = ControlSessionState::Disconnected;
                Err(error)
            }
            (_, Ok(_host)) => Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "control session connect completed after manager state changed",
            )),
            (_, Err(error)) => Err(error),
        };
        dialing_guard.disarm();
        result
    }

    pub(crate) fn acquire(&self) -> io::Result<ControlOperation> {
        let host = {
            let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *state {
                ControlSessionState::Active { host, active_ops } => {
                    *active_ops += 1;
                    Arc::clone(host)
                }
                ControlSessionState::Disconnected => {
                    return Err(io::Error::new(
                        io::ErrorKind::NotConnected,
                        "control session is not connected",
                    ));
                }
                ControlSessionState::Dialing => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session is dialing",
                    ));
                }
                ControlSessionState::Quiescing { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session is quiescing",
                    ));
                }
                ControlSessionState::Closed => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "control session manager closed",
                    ));
                }
            }
        };

        Ok(ControlOperation {
            manager: self.clone(),
            host,
        })
    }

    pub(crate) async fn quiesce(&self, timeout: Duration) -> io::Result<()> {
        let host = {
            let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            match &*state {
                ControlSessionState::Disconnected => return Ok(()),
                ControlSessionState::Active { active_ops, .. } if *active_ops > 0 => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session has active host operations",
                    ));
                }
                ControlSessionState::Active { host, .. } => {
                    let host = Arc::clone(host);
                    *state = ControlSessionState::Quiescing {
                        host: Arc::clone(&host),
                    };
                    host
                }
                ControlSessionState::Dialing => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session is dialing",
                    ));
                }
                ControlSessionState::Quiescing { .. } => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "control session already quiescing",
                    ));
                }
                ControlSessionState::Closed => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "control session manager closed",
                    ));
                }
            }
        };

        let mut quiescing_guard = QuiescingGuard::new(self.clone());
        let deadline = tokio::time::Instant::now() + timeout;
        let result = loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control session quiesce timed out",
                ));
            }

            let remaining = deadline.duration_since(now);
            match host.quiesce(remaining).await {
                Ok(()) => break Ok(()),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        break Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "control session quiesce timed out",
                        ));
                    }
                    tokio::time::sleep(std::cmp::min(
                        QUIESCE_BUSY_RETRY_DELAY,
                        deadline.duration_since(now),
                    ))
                    .await;
                }
                Err(error) => break Err(error),
            }
        };
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let result = match (&*state, result) {
            (ControlSessionState::Quiescing { .. }, Ok(())) => {
                *state = ControlSessionState::Disconnected;
                Ok(())
            }
            (ControlSessionState::Quiescing { .. }, Err(error)) => {
                *state = ControlSessionState::Closed;
                Err(error)
            }
            (_, Ok(())) => Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "control session quiesce completed after manager state changed",
            )),
            (_, Err(error)) => Err(error),
        };
        quiescing_guard.disarm();
        result
    }

    pub(crate) fn take_for_shutdown(&self) -> Option<Arc<VsockHost>> {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match std::mem::replace(&mut *state, ControlSessionState::Closed) {
            ControlSessionState::Active { host, .. } | ControlSessionState::Quiescing { host } => {
                Some(host)
            }
            ControlSessionState::Disconnected
            | ControlSessionState::Dialing
            | ControlSessionState::Closed => None,
        }
    }

    pub(crate) fn close(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *state = ControlSessionState::Closed;
    }

    fn release_operation(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let ControlSessionState::Active { active_ops, .. } = &mut *state {
            *active_ops = active_ops.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_line(stream: &mut tokio::net::UnixStream) -> Vec<u8> {
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let n = stream.read(&mut byte).await.unwrap();
            assert_ne!(n, 0, "connection closed before line completed");
            line.push(byte[0]);
            if byte[0] == b'\n' {
                return line;
            }
        }
    }

    async fn read_one_message(
        stream: &mut tokio::net::UnixStream,
        decoder: &mut vsock_proto::Decoder,
    ) -> vsock_proto::RawMessage {
        let mut buf = [0u8; 1024];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0, "connection closed before frame completed");
            let mut messages = decoder.decode(&buf[..n]).unwrap();
            if !messages.is_empty() {
                return messages.remove(0);
            }
        }
    }

    async fn write_quiesce_ack(
        stream: &mut tokio::net::UnixStream,
        seq: u32,
        status: vsock_proto::ControlQuiesceStatus,
    ) {
        let payload = vsock_proto::encode_control_quiesce_ack(status);
        let ack = vsock_proto::encode(vsock_proto::MSG_CONTROL_QUIESCE_ACK, seq, &payload).unwrap();
        stream.write_all(&ack).await.unwrap();
    }

    async fn active_manager() -> (ControlSessionManager, tokio::task::JoinHandle<()>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vsock.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let path_string = path.display().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(
                read_line(&mut stream).await,
                format!("CONNECT {}\n", vsock_proto::VSOCK_PORT).as_bytes()
            );
            stream.write_all(b"OK 1073741824\n").await.unwrap();

            let mut decoder = vsock_proto::Decoder::new();
            let hello = read_one_message(&mut stream, &mut decoder).await;
            assert_eq!(hello.msg_type, vsock_proto::MSG_CONTROL_HELLO);
            let decoded = vsock_proto::decode_control_hello(&hello.payload).unwrap();
            let ack_payload =
                vsock_proto::encode_control_hello_ack(decoded.version, &decoded.nonce);
            let ack =
                vsock_proto::encode(vsock_proto::MSG_CONTROL_HELLO_ACK, hello.seq, &ack_payload)
                    .unwrap();
            stream.write_all(&ack).await.unwrap();
            std::future::pending::<()>().await;
        });

        let manager = ControlSessionManager::new();
        manager
            .connect(&path_string, Duration::from_secs(5), None)
            .await
            .unwrap();
        (manager, server)
    }

    #[tokio::test]
    async fn cancelled_connect_resets_dialing_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vsock.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let manager = ControlSessionManager::new();

        let task = tokio::spawn({
            let manager = manager.clone();
            let path = path.display().to_string();
            async move { manager.connect(&path, Duration::from_secs(30), None).await }
        });
        let (_stream, _) = listener.accept().await.unwrap();

        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());

        let err = match manager.acquire() {
            Ok(_) => panic!("cancelled connect must not leave an active session"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);
    }

    #[tokio::test]
    async fn active_operation_blocks_quiesce() {
        let (manager, server) = active_manager().await;
        let operation = manager.acquire().unwrap();

        let err = manager.quiesce(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

        drop(operation);
        manager.close();
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn quiesce_retries_busy_until_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vsock.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let path_string = path.display().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(
                read_line(&mut stream).await,
                format!("CONNECT {}\n", vsock_proto::VSOCK_PORT).as_bytes()
            );
            stream.write_all(b"OK 1073741824\n").await.unwrap();

            let mut decoder = vsock_proto::Decoder::new();
            let hello = read_one_message(&mut stream, &mut decoder).await;
            let decoded = vsock_proto::decode_control_hello(&hello.payload).unwrap();
            let ack_payload =
                vsock_proto::encode_control_hello_ack(decoded.version, &decoded.nonce);
            let ack =
                vsock_proto::encode(vsock_proto::MSG_CONTROL_HELLO_ACK, hello.seq, &ack_payload)
                    .unwrap();
            stream.write_all(&ack).await.unwrap();

            let busy = read_one_message(&mut stream, &mut decoder).await;
            assert_eq!(busy.msg_type, vsock_proto::MSG_CONTROL_QUIESCE);
            write_quiesce_ack(
                &mut stream,
                busy.seq,
                vsock_proto::ControlQuiesceStatus::Busy,
            )
            .await;

            let ready = read_one_message(&mut stream, &mut decoder).await;
            assert_eq!(ready.msg_type, vsock_proto::MSG_CONTROL_QUIESCE);
            write_quiesce_ack(
                &mut stream,
                ready.seq,
                vsock_proto::ControlQuiesceStatus::Ready,
            )
            .await;
        });

        let manager = ControlSessionManager::new();
        manager
            .connect(&path_string, Duration::from_secs(5), None)
            .await
            .unwrap();
        manager.quiesce(Duration::from_secs(5)).await.unwrap();

        let err = match manager.acquire() {
            Ok(_) => panic!("quiesced manager must not allow operations"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_quiesce_closes_manager() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vsock.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let path_string = path.display().to_string();
        let (quiesce_seen_tx, quiesce_seen_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(
                read_line(&mut stream).await,
                format!("CONNECT {}\n", vsock_proto::VSOCK_PORT).as_bytes()
            );
            stream.write_all(b"OK 1073741824\n").await.unwrap();

            let mut decoder = vsock_proto::Decoder::new();
            let hello = read_one_message(&mut stream, &mut decoder).await;
            let decoded = vsock_proto::decode_control_hello(&hello.payload).unwrap();
            let ack_payload =
                vsock_proto::encode_control_hello_ack(decoded.version, &decoded.nonce);
            let ack =
                vsock_proto::encode(vsock_proto::MSG_CONTROL_HELLO_ACK, hello.seq, &ack_payload)
                    .unwrap();
            stream.write_all(&ack).await.unwrap();

            let quiesce = read_one_message(&mut stream, &mut decoder).await;
            assert_eq!(quiesce.msg_type, vsock_proto::MSG_CONTROL_QUIESCE);
            let _ = quiesce_seen_tx.send(());
            let mut byte = [0u8; 1];
            let _ = stream.read(&mut byte).await;
        });

        let manager = ControlSessionManager::new();
        manager
            .connect(&path_string, Duration::from_secs(5), None)
            .await
            .unwrap();

        let quiesce_task = tokio::spawn({
            let manager = manager.clone();
            async move { manager.quiesce(Duration::from_secs(30)).await }
        });
        quiesce_seen_rx.await.unwrap();
        quiesce_task.abort();
        assert!(quiesce_task.await.unwrap_err().is_cancelled());

        let err = match manager.acquire() {
            Ok(_) => panic!("cancelled quiesce must close the manager"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
        server.await.unwrap();
    }
}
