//! Work retains provider admission and capacity independently of guest I/O.

use sandbox::{GuestRpcOperation, GuestRpcStream};
use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::OwnedSemaphorePermit,
};

pub(super) struct Lease {
    _operation: GuestRpcOperation,
    _sandbox: OwnedSemaphorePermit,
    _runner: OwnedSemaphorePermit,
}
impl Lease {
    pub(super) fn new(
        operation: GuestRpcOperation,
        sandbox: OwnedSemaphorePermit,
        runner: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            _operation: operation,
            _sandbox: sandbox,
            _runner: runner,
        }
    }
}

pub(super) type GuestIo = Box<dyn GuestRpcStream>;

pub(super) struct SshSocket {
    stream: tokio::net::TcpStream,
    _lease: Arc<Lease>,
}

pub(super) struct SocketGuard(std::net::TcpStream);

impl SshSocket {
    pub(super) fn new(
        stream: tokio::net::TcpStream,
        lease: Arc<Lease>,
    ) -> io::Result<(Self, SocketGuard)> {
        let stream = stream.into_std()?;
        let guard = SocketGuard(stream.try_clone()?);
        let stream = tokio::net::TcpStream::from_std(stream)?;
        Ok((
            Self {
                stream,
                _lease: lease,
            },
            guard,
        ))
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

impl AsyncRead for SshSocket {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for SshSocket {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}
