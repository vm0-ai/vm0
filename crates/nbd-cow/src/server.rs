//! In-process NBD request dispatch.
//!
//! [`dispatch`] owns one Unix socket connection passed to the kernel NBD device,
//! decodes requests with [`crate::protocol`], applies them to
//! [`crate::cow::CowLayer`], and writes NBD replies back to the kernel.

use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::cow::CowLayer;
use crate::error::{NbdCowError, Result};
use crate::protocol::{self, Command, NbdReply, NbdRequest, REQUEST_HEADER_SIZE};

/// Maximum allowed request length (32 MB). Requests exceeding this are rejected
/// with an I/O error to prevent OOM from malformed requests.
const MAX_REQUEST_LENGTH: u32 = 32 * 1024 * 1024;

/// Maximum reusable payload buffer capacity retained between requests.
/// Larger legal requests use temporary buffers to avoid long-lived 32 MB buffers.
const MAX_REUSABLE_PAYLOAD_LENGTH: usize = 1024 * 1024;

#[derive(Clone, Copy)]
enum IoOutcome {
    Complete,
    Shutdown,
}

#[derive(Clone, Copy)]
enum HandlerOutcome {
    Continue,
    Shutdown,
}

/// Run the NBD dispatch loop on a Unix stream.
///
/// Reads NBD requests from the socket, dispatches to the COW layer,
/// and sends replies back. Handles graceful shutdown via the cancellation token.
///
/// NOTE: CowLayer uses synchronous file I/O (pread/pwrite) while holding the
/// RwLock. This briefly blocks the tokio worker thread. For our workload
/// (4KB blocks, fast NVMe/EBS storage) this is acceptable. If latency becomes
/// an issue, consider `spawn_blocking` or async file I/O.
pub async fn dispatch(
    socket_fd: OwnedFd,
    cow: Arc<RwLock<CowLayer>>,
    shutdown: CancellationToken,
) -> Result<()> {
    let raw_fd = socket_fd.into_raw_fd();
    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(raw_fd) };
    std_stream.set_nonblocking(true)?;
    let stream = UnixStream::from_std(std_stream)?;

    let (mut reader, mut writer) = stream.into_split();

    let mut header_buf = [0u8; REQUEST_HEADER_SIZE];
    let mut payload_buf = Vec::with_capacity(crate::BLOCK_SIZE);

    loop {
        match read_exact_or_shutdown(&mut reader, &mut header_buf, &shutdown).await {
            Ok(IoOutcome::Complete) => {}
            Ok(IoOutcome::Shutdown) => {
                sync_cow_on_shutdown(&cow).await?;
                return Ok(());
            }
            Err(NbdCowError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(());
            }
            Err(e) => return Err(e),
        }

        let request = protocol::parse_request(&header_buf)?;

        let outcome = match request.command {
            Command::Read => {
                handle_read(&request, &cow, &mut writer, &mut payload_buf, &shutdown).await?
            }
            Command::Write => {
                handle_write(
                    &request,
                    &mut reader,
                    &cow,
                    &mut writer,
                    &mut payload_buf,
                    &shutdown,
                )
                .await?
            }
            Command::Flush => handle_flush(&request, &cow, &mut writer, &shutdown).await?,
            Command::Trim => handle_trim(&request, &mut writer, &shutdown).await?,
            Command::Disconnect => {
                sync_cow_on_shutdown(&cow).await?;
                return Ok(());
            }
        };

        if let HandlerOutcome::Shutdown = outcome {
            sync_cow_on_shutdown(&cow).await?;
            return Ok(());
        }
    }
}

async fn sync_cow_on_shutdown(cow: &Arc<RwLock<CowLayer>>) -> Result<()> {
    let mut cow = cow.write().await;
    cow.sync()
}

fn handler_outcome(outcome: IoOutcome) -> HandlerOutcome {
    match outcome {
        IoOutcome::Complete => HandlerOutcome::Continue,
        IoOutcome::Shutdown => HandlerOutcome::Shutdown,
    }
}

async fn read_exact_or_shutdown(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    buf: &mut [u8],
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let dest = buf.get_mut(filled..).ok_or_else(|| {
            NbdCowError::Io(std::io::Error::other("read buffer slice out of bounds"))
        })?;
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                return Ok(IoOutcome::Shutdown);
            }
            result = reader.read(dest) => {
                let count = result?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "failed to fill whole buffer",
                    ).into());
                }
                filled += count;
            }
        }
    }
    Ok(IoOutcome::Complete)
}

async fn write_all_or_shutdown(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    mut buf: &[u8],
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    while !buf.is_empty() {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                return Ok(IoOutcome::Shutdown);
            }
            result = writer.write(buf) => {
                let count = result?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "failed to write whole buffer",
                    ).into());
                }
                buf = buf.get(count..).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("write buffer slice out of bounds"))
                })?;
            }
        }
    }
    Ok(IoOutcome::Complete)
}

async fn handle_read(
    request: &NbdRequest,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    payload_buf: &mut Vec<u8>,
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    if request.length > MAX_REQUEST_LENGTH {
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }
    let len = request.length as usize;
    if len <= MAX_REUSABLE_PAYLOAD_LENGTH {
        resize_reusable_payload(payload_buf, len);
        let result =
            read_and_reply(request, cow, writer, payload_buf.as_mut_slice(), shutdown).await;
        reset_reusable_payload_if_oversized(payload_buf);
        result
    } else {
        let mut data = vec![0u8; len];
        read_and_reply(request, cow, writer, data.as_mut_slice(), shutdown).await
    }
}

fn resize_reusable_payload(payload_buf: &mut Vec<u8>, len: usize) {
    debug_assert!(len <= MAX_REUSABLE_PAYLOAD_LENGTH);
    if payload_buf.capacity() < len {
        *payload_buf = vec![0u8; len];
    } else {
        payload_buf.resize(len, 0);
    }
}

fn reset_reusable_payload_if_oversized(payload_buf: &mut Vec<u8>) {
    if payload_buf.capacity() > MAX_REUSABLE_PAYLOAD_LENGTH {
        *payload_buf = Vec::with_capacity(crate::BLOCK_SIZE);
    }
}

async fn read_and_reply(
    request: &NbdRequest,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    data: &mut [u8],
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    let result = {
        let cow = cow.read().await;
        cow.read(request.offset, data)
    };
    if let Err(e) = result {
        tracing::warn!(
            offset = request.offset,
            len = request.length,
            "read error: {e}"
        );
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }

    let reply = success_reply(request.handle);
    let reply_buf = protocol::serialize_reply(&reply);
    if let IoOutcome::Shutdown = write_all_or_shutdown(writer, &reply_buf, shutdown).await? {
        return Ok(HandlerOutcome::Shutdown);
    }
    write_all_or_shutdown(writer, data, shutdown)
        .await
        .map(handler_outcome)
}

async fn handle_write(
    request: &NbdRequest,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    payload_buf: &mut Vec<u8>,
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    if request.length > MAX_REQUEST_LENGTH {
        // Must consume the payload to keep the protocol stream in sync
        if let IoOutcome::Shutdown = discard_bytes(reader, request.length as u64, shutdown).await? {
            return Ok(HandlerOutcome::Shutdown);
        }
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }
    let len = request.length as usize;
    if len <= MAX_REUSABLE_PAYLOAD_LENGTH {
        resize_reusable_payload(payload_buf, len);
        let result = read_and_apply_write(
            request,
            reader,
            cow,
            writer,
            payload_buf.as_mut_slice(),
            shutdown,
        )
        .await;
        reset_reusable_payload_if_oversized(payload_buf);
        result
    } else {
        let mut data = vec![0u8; len];
        read_and_apply_write(request, reader, cow, writer, data.as_mut_slice(), shutdown).await
    }
}

async fn read_and_apply_write(
    request: &NbdRequest,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    data: &mut [u8],
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    if let IoOutcome::Shutdown = read_exact_or_shutdown(reader, data, shutdown).await? {
        return Ok(HandlerOutcome::Shutdown);
    }

    let failed = {
        let mut cow = cow.write().await;
        match cow.write(request.offset, data) {
            Ok(needs_flush) => {
                if needs_flush && let Err(e) = cow.flush() {
                    tracing::warn!("flush error after write: {e}");
                    true
                } else {
                    false
                }
            }
            Err(e) => {
                tracing::warn!(
                    offset = request.offset,
                    len = request.length,
                    "write error: {e}"
                );
                true
            }
        }
    };
    if failed {
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }

    send_success_reply(writer, request.handle, shutdown)
        .await
        .map(handler_outcome)
}

async fn handle_flush(
    request: &NbdRequest,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    let result = {
        let mut cow = cow.write().await;
        cow.sync()
    };
    if let Err(e) = result {
        tracing::warn!("sync error: {e}");
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }

    send_success_reply(writer, request.handle, shutdown)
        .await
        .map(handler_outcome)
}

async fn handle_trim(
    request: &NbdRequest,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    // Trim is a no-op for now (COW file is sparse, unused blocks are holes)
    send_success_reply(writer, request.handle, shutdown)
        .await
        .map(handler_outcome)
}

fn success_reply(handle: u64) -> NbdReply {
    NbdReply { error: 0, handle }
}

async fn send_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    reply: &NbdReply,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    let buf = protocol::serialize_reply(reply);
    write_all_or_shutdown(writer, &buf, shutdown).await
}

async fn send_success_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    handle: u64,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    send_reply(writer, &success_reply(handle), shutdown).await
}

async fn send_error_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    handle: u64,
    error: u32,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    send_reply(writer, &NbdReply { error, handle }, shutdown).await
}

/// Discard `n` bytes from the reader to keep the protocol stream in sync.
async fn discard_bytes(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    mut remaining: u64,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let dest = buf
            .get_mut(..to_read)
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("discard slice error")))?;
        if let IoOutcome::Shutdown = read_exact_or_shutdown(reader, dest, shutdown).await? {
            return Ok(IoOutcome::Shutdown);
        }
        remaining -= to_read as u64;
    }
    Ok(IoOutcome::Complete)
}

#[cfg(test)]
mod tests;
