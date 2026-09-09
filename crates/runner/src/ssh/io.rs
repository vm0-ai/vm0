//! Shared ownership preserves the provider's reservation during blocking work.

use sandbox::GuestRpcStream;
use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::OwnedSemaphorePermit,
};

pub(super) struct Lease {
    stream: Mutex<Box<dyn GuestRpcStream>>,
    _sandbox: OwnedSemaphorePermit,
    _runner: OwnedSemaphorePermit,
}
impl Lease {
    pub(super) fn new(
        stream: Box<dyn GuestRpcStream>,
        sandbox: OwnedSemaphorePermit,
        runner: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            stream: Mutex::new(stream),
            _sandbox: sandbox,
            _runner: runner,
        }
    }
}

pub(super) struct GuestIo(pub(super) Arc<Lease>);
impl AsyncRead for GuestIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(
            &mut *self
                .0
                .stream
                .lock()
                .map_err(|_| io::Error::other("SSH stream unavailable"))?,
        )
        .poll_read(cx, buf)
    }
}
impl AsyncWrite for GuestIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(
            &mut *self
                .0
                .stream
                .lock()
                .map_err(|_| io::Error::other("SSH stream unavailable"))?,
        )
        .poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(
            &mut *self
                .0
                .stream
                .lock()
                .map_err(|_| io::Error::other("SSH stream unavailable"))?,
        )
        .poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(
            &mut *self
                .0
                .stream
                .lock()
                .map_err(|_| io::Error::other("SSH stream unavailable"))?,
        )
        .poll_shutdown(cx)
    }
}

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
