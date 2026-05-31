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
mod tests {
    use super::*;
    use crate::cow::CowLayer;
    use crate::protocol::{Command, NbdRequest, serialize_request};
    use std::io::Write as _;
    use std::os::unix::fs::MetadataExt;
    use tempfile::NamedTempFile;

    fn create_test_cow(base_data: &[u8]) -> (NamedTempFile, NamedTempFile, CowLayer) {
        let mut base = NamedTempFile::new().unwrap();
        base.write_all(base_data).unwrap();
        base.flush().unwrap();
        let cow_file = NamedTempFile::new().unwrap();
        let cow = CowLayer::new(
            base.path(),
            cow_file.path(),
            base_data.len() as u64,
            4096,
            4 * 1024 * 1024,
        )
        .unwrap();
        (base, cow_file, cow)
    }

    #[tokio::test]
    async fn dispatch_read_write_disconnect() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut client_reader, mut client_writer, server_task, _shutdown) =
            setup_dispatch(cow).await;

        // 1. Send a READ request for first block
        let read_req = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        client_writer
            .write_all(&serialize_request(&read_req))
            .await
            .unwrap();

        // Read reply header + data
        let mut reply_buf = [0u8; 16];
        client_reader.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[0], reply_buf[1], reply_buf[2], reply_buf[3]]),
            protocol::REPLY_MAGIC
        );
        assert_eq!(
            u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
            0 // no error
        );

        let mut data = vec![0u8; 4096];
        client_reader.read_exact(&mut data).await.unwrap();
        assert!(data.iter().all(|&b| b == 0xAA));

        // 2. Send a WRITE request
        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 2,
            offset: 0,
            length: 4096,
        };
        let write_data = vec![0xBB; 4096];
        client_writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        client_writer.write_all(&write_data).await.unwrap();

        // Read write reply
        client_reader.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
            0 // no error
        );

        // 3. Read back the written data
        let read_req2 = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 3,
            offset: 0,
            length: 4096,
        };
        client_writer
            .write_all(&serialize_request(&read_req2))
            .await
            .unwrap();

        client_reader.read_exact(&mut reply_buf).await.unwrap();
        let mut data2 = vec![0u8; 4096];
        client_reader.read_exact(&mut data2).await.unwrap();
        assert!(data2.iter().all(|&b| b == 0xBB));

        // 4. Send DISCONNECT
        let disc_req = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 4,
            offset: 0,
            length: 0,
        };
        client_writer
            .write_all(&serialize_request(&disc_req))
            .await
            .unwrap();

        // Server should exit cleanly
        server_task.await.unwrap().unwrap();
    }

    /// Helper: create socketpair, spawn dispatch, return client stream halves.
    async fn setup_dispatch(
        cow: Arc<RwLock<CowLayer>>,
    ) -> (
        tokio::net::unix::OwnedReadHalf,
        tokio::net::unix::OwnedWriteHalf,
        tokio::task::JoinHandle<crate::error::Result<()>>,
        CancellationToken,
    ) {
        let shutdown = CancellationToken::new();
        let (client_fd, server_fd) = {
            let mut fds = [0i32; 2];
            let ret =
                unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
            assert_eq!(ret, 0);
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
        };

        let cow_clone = cow.clone();
        let shutdown_clone = shutdown.clone();
        let task =
            tokio::spawn(async move { dispatch(server_fd, cow_clone, shutdown_clone).await });

        let client_std =
            unsafe { std::os::unix::net::UnixStream::from_raw_fd(client_fd.into_raw_fd()) };
        client_std.set_nonblocking(true).unwrap();
        let client_stream = UnixStream::from_std(client_std).unwrap();

        let (reader, writer) = client_stream.into_split();
        (reader, writer, task, shutdown)
    }

    /// Helper: send a request and read the reply header, return the error field.
    async fn send_and_recv_reply(
        reader: &mut tokio::net::unix::OwnedReadHalf,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
        req: &NbdRequest,
    ) -> u32 {
        writer.write_all(&serialize_request(req)).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[0], reply_buf[1], reply_buf[2], reply_buf[3]]),
            protocol::REPLY_MAGIC
        );
        u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]])
    }

    async fn send_write_and_recv_reply(
        reader: &mut tokio::net::unix::OwnedReadHalf,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
        req: &NbdRequest,
        data: &[u8],
    ) -> u32 {
        assert_eq!(data.len(), req.length as usize);
        writer.write_all(&serialize_request(req)).await.unwrap();
        writer.write_all(data).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[0], reply_buf[1], reply_buf[2], reply_buf[3]]),
            protocol::REPLY_MAGIC
        );
        u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]])
    }

    async fn read_payload(reader: &mut tokio::net::unix::OwnedReadHalf, len: usize) -> Vec<u8> {
        let mut data = vec![0u8; len];
        reader.read_exact(&mut data).await.unwrap();
        data
    }

    #[tokio::test]
    async fn dispatch_large_then_small_requests_keep_stream_aligned() {
        let large_len = MAX_REUSABLE_PAYLOAD_LENGTH + crate::BLOCK_SIZE;
        let small_len = 512usize;
        let small_offset = large_len as u64;
        let alignment_offset = (large_len + crate::BLOCK_SIZE) as u64;
        let mut base_data = vec![0x11; large_len + 2 * crate::BLOCK_SIZE];
        base_data[large_len + crate::BLOCK_SIZE..].fill(0x33);
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        let large_write = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: large_len as u32,
        };
        let large_write_data = vec![0x44; large_len];
        let error =
            send_write_and_recv_reply(&mut reader, &mut writer, &large_write, &large_write_data)
                .await;
        assert_eq!(error, 0, "large write should succeed");

        let small_write = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 2,
            offset: small_offset,
            length: small_len as u32,
        };
        let small_write_data = vec![0x55; small_len];
        let error =
            send_write_and_recv_reply(&mut reader, &mut writer, &small_write, &small_write_data)
                .await;
        assert_eq!(error, 0, "small write after large write should succeed");

        let large_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 3,
            offset: 0,
            length: large_len as u32,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &large_read).await;
        assert_eq!(error, 0, "large read should succeed");
        let large_read_data = read_payload(&mut reader, large_len).await;
        assert!(large_read_data.iter().all(|&b| b == 0x44));

        let small_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 4,
            offset: small_offset,
            length: small_len as u32,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &small_read).await;
        assert_eq!(error, 0, "small read after large read should succeed");
        let small_read_data = read_payload(&mut reader, small_len).await;
        assert_eq!(small_read_data, small_write_data);

        let max_reusable_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 5,
            offset: 0,
            length: MAX_REUSABLE_PAYLOAD_LENGTH as u32,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &max_reusable_read).await;
        assert_eq!(error, 0, "max reusable read should succeed");
        let max_reusable_data = read_payload(&mut reader, MAX_REUSABLE_PAYLOAD_LENGTH).await;
        assert!(max_reusable_data.iter().all(|&b| b == 0x44));

        // The max reusable request above proves the stream stayed aligned after
        // the small read. This next request proves it also stays aligned after
        // a max-size reusable payload.
        let alignment_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 6,
            offset: alignment_offset,
            length: crate::BLOCK_SIZE as u32,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &alignment_read).await;
        assert_eq!(error, 0, "read after max reusable read should stay aligned");
        let alignment_data = read_payload(&mut reader, crate::BLOCK_SIZE).await;
        assert!(alignment_data.iter().all(|&b| b == 0x33));

        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 7,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dispatch_flush_persists_to_cow_file() {
        let base_data = vec![0x00; 8192];
        let (_base, cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow.clone()).await;

        // Write data
        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer.write_all(&vec![0xCC; 4096]).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();

        // Send FLUSH
        let flush_req = NbdRequest {
            flags: 0,
            command: Command::Flush,
            handle: 2,
            offset: 0,
            length: 0,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &flush_req).await;
        assert_eq!(error, 0, "flush should succeed");

        // Verify data was flushed to COW file
        {
            let cow = cow.read().await;
            assert_eq!(
                cow.buffered_block_count(),
                0,
                "buffer should be empty after flush"
            );
            assert!(
                cow.dirty_block_count() > 0,
                "should have dirty blocks in COW file"
            );
        }

        // Verify COW file has data
        let cow_meta = std::fs::metadata(cow_file.path()).unwrap();
        assert!(
            cow_meta.blocks() > 0,
            "COW file should have allocated blocks after flush"
        );

        // Disconnect
        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 3,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dispatch_trim_succeeds() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        // Send TRIM
        let trim_req = NbdRequest {
            flags: 0,
            command: Command::Trim,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &trim_req).await;
        assert_eq!(error, 0, "trim should succeed (no-op)");

        // Disconnect
        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 2,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dispatch_oversized_read_returns_error() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        // Send a read request exceeding MAX_REQUEST_LENGTH (32 MB)
        let big_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 1,
            offset: 0,
            length: 33 * 1024 * 1024, // 33 MB > 32 MB limit
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &big_read).await;
        assert_ne!(error, 0, "oversized read should return error");

        // A normal read should still work afterwards
        let normal_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 2,
            offset: 0,
            length: 4096,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &normal_read).await;
        assert_eq!(error, 0, "normal read after oversized should succeed");
        // Consume the data payload
        let mut data = vec![0u8; 4096];
        reader.read_exact(&mut data).await.unwrap();
        assert!(data.iter().all(|&b| b == 0xAA));

        // Disconnect
        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 3,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dispatch_oversized_write_discards_and_returns_error() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        // Send a write request header claiming 33 MB, but only send a small payload
        // to test that discard_bytes works correctly.
        // We use a small oversized value to keep the test fast.
        let big_write = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 33 * 1024 * 1024, // claimed 33 MB
        };
        writer
            .write_all(&serialize_request(&big_write))
            .await
            .unwrap();
        // Send 33 MB of data (the server must discard all of it)
        // To keep the test fast, we send in chunks
        let chunk = vec![0xFFu8; 64 * 1024];
        let total = 33 * 1024 * 1024;
        let mut sent = 0usize;
        while sent < total {
            let to_send = chunk.len().min(total - sent);
            writer
                .write_all(chunk.get(..to_send).unwrap())
                .await
                .unwrap();
            sent += to_send;
        }

        // Should get an error reply
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        let error = u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]);
        assert_ne!(error, 0, "oversized write should return error");

        // Protocol should still be in sync — a normal read should work
        let normal_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 2,
            offset: 0,
            length: 4096,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &normal_read).await;
        assert_eq!(error, 0, "normal read after oversized write should succeed");
        let mut data = vec![0u8; 4096];
        reader.read_exact(&mut data).await.unwrap();
        // Data should still be original base data (oversized write was rejected)
        assert!(data.iter().all(|&b| b == 0xAA));

        // Disconnect
        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 3,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dispatch_shutdown_flushes_data() {
        let base_data = vec![0x00; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, shutdown) = setup_dispatch(cow.clone()).await;

        // Write data (stays in buffer)
        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer.write_all(&vec![0xDD; 4096]).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();

        // Verify data is in buffer
        {
            let cow = cow.read().await;
            assert_eq!(cow.buffered_block_count(), 1);
        }

        // Signal shutdown (should flush)
        shutdown.cancel();
        task.await.unwrap().unwrap();

        // After shutdown, buffer should be flushed
        {
            let cow = cow.read().await;
            assert_eq!(
                cow.buffered_block_count(),
                0,
                "shutdown should flush buffer"
            );
        }
    }

    async fn assert_dispatch_exits_after_shutdown(
        task: tokio::task::JoinHandle<crate::error::Result<()>>,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("dispatch should exit after shutdown")
            .expect("dispatch task should join")
            .expect("dispatch should not fail");
    }

    async fn yield_to_dispatch() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn dispatch_shutdown_while_write_payload_pending_exits() {
        let base_data = vec![0x00; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (_reader, mut writer, task, shutdown) = setup_dispatch(cow).await;

        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer.write_all(&vec![0xAA; 512]).await.unwrap();
        yield_to_dispatch().await;

        shutdown.cancel();
        assert_dispatch_exits_after_shutdown(task).await;
    }

    #[tokio::test]
    async fn dispatch_shutdown_while_oversized_write_discard_pending_exits() {
        let base_data = vec![0x00; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (_reader, mut writer, task, shutdown) = setup_dispatch(cow).await;

        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 33 * 1024 * 1024,
        };
        writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer.write_all(&vec![0xAA; 64 * 1024]).await.unwrap();
        yield_to_dispatch().await;

        shutdown.cancel();
        assert_dispatch_exits_after_shutdown(task).await;
    }

    #[tokio::test]
    async fn dispatch_shutdown_during_partial_write_flushes_accepted_data() {
        let base_data = vec![0x00; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, shutdown) = setup_dispatch(cow.clone()).await;

        let accepted_write = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&accepted_write))
            .await
            .unwrap();
        writer.write_all(&vec![0xDD; 4096]).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
            0,
            "accepted write should succeed"
        );
        {
            let cow = cow.read().await;
            assert_eq!(cow.buffered_block_count(), 1);
        }

        let partial_write = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 2,
            offset: 4096,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&partial_write))
            .await
            .unwrap();
        writer.write_all(&vec![0xEE; 512]).await.unwrap();
        yield_to_dispatch().await;

        shutdown.cancel();
        assert_dispatch_exits_after_shutdown(task).await;

        let cow = cow.read().await;
        assert_eq!(cow.buffered_block_count(), 0);
        assert_eq!(cow.dirty_block_count(), 1);
    }

    #[tokio::test]
    async fn dispatch_out_of_bounds_read_returns_error() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        // Send a read request beyond the device size (8192 bytes)
        let oob_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 1,
            offset: 8192, // at EOF
            length: 4096, // reading past end
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &oob_read).await;
        assert_ne!(error, 0, "out-of-bounds read should return error");

        // Connection should still be alive — a normal read should work
        let normal_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 2,
            offset: 0,
            length: 4096,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &normal_read).await;
        assert_eq!(error, 0, "normal read after out-of-bounds should succeed");
        let mut data = vec![0u8; 4096];
        reader.read_exact(&mut data).await.unwrap();
        assert!(data.iter().all(|&b| b == 0xAA));

        // Disconnect
        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 3,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dispatch_out_of_bounds_write_returns_error() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        // Send a write request beyond the device size
        let oob_write = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 8192,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&oob_write))
            .await
            .unwrap();
        writer.write_all(&vec![0xFF; 4096]).await.unwrap();

        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        let error = u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]);
        assert_ne!(error, 0, "out-of-bounds write should return error");

        // Connection should still be alive — verify with a normal read
        let normal_read = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 2,
            offset: 0,
            length: 4096,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &normal_read).await;
        assert_eq!(
            error, 0,
            "normal read after out-of-bounds write should succeed"
        );
        let mut data = vec![0u8; 4096];
        reader.read_exact(&mut data).await.unwrap();
        assert!(data.iter().all(|&b| b == 0xAA));

        // Disconnect
        let disc = NbdRequest {
            flags: 0,
            command: Command::Disconnect,
            handle: 3,
            offset: 0,
            length: 0,
        };
        writer.write_all(&serialize_request(&disc)).await.unwrap();
        task.await.unwrap().unwrap();
    }

    /// Constructs a CowLayer whose COW file is `/dev/full` — every write to it
    /// returns ENOSPC, letting us trigger `cow.flush()` / `cow.sync()` failures
    /// deterministically without filesystem tricks.
    fn create_cow_with_full_device(base: &NamedTempFile, flush_threshold: usize) -> CowLayer {
        CowLayer::new(
            base.path(),
            std::path::Path::new("/dev/full"),
            8192,
            4096,
            flush_threshold,
        )
        .unwrap()
    }

    /// Covers the `handle_write` flush-error branch: `cow.write()` succeeds but
    /// the triggered `cow.flush()` fails — the branch preserved in the fix to
    /// keep the "flush error after write" log distinct from the write-error log.
    #[tokio::test]
    async fn dispatch_write_flush_failure_returns_error() {
        let mut base = NamedTempFile::new().unwrap();
        base.write_all(&vec![0xAA; 8192]).unwrap();
        base.flush().unwrap();
        // flush_threshold = block_size → one write forces an immediate flush.
        let cow = Arc::new(RwLock::new(create_cow_with_full_device(&base, 4096)));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer.write_all(&vec![0xBB; 4096]).await.unwrap();

        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        let error = u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]);
        assert_eq!(
            error,
            libc::EIO as u32,
            "flush failure should return EIO reply"
        );

        // Drop client halves so the server sees EOF and exits cleanly.
        drop(writer);
        drop(reader);
        task.await.unwrap().unwrap();
    }

    /// Covers the `handle_flush` sync-error branch: buffered data exists, a
    /// Flush command triggers `cow.sync()` which calls `flush()` which writes
    /// to `/dev/full` and fails.
    #[tokio::test]
    async fn dispatch_sync_failure_returns_error() {
        let mut base = NamedTempFile::new().unwrap();
        base.write_all(&vec![0xAA; 8192]).unwrap();
        base.flush().unwrap();
        // High threshold → the initial write stays buffered and succeeds;
        // the failure lands on the subsequent Flush command.
        let cow = Arc::new(RwLock::new(create_cow_with_full_device(
            &base,
            4 * 1024 * 1024,
        )));

        let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

        // Buffered write — succeeds without touching the COW file.
        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 1,
            offset: 0,
            length: 4096,
        };
        writer
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer.write_all(&vec![0xBB; 4096]).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
            0,
            "buffered write should succeed"
        );

        // Flush drains the buffer to /dev/full → ENOSPC.
        let flush_req = NbdRequest {
            flags: 0,
            command: Command::Flush,
            handle: 2,
            offset: 0,
            length: 0,
        };
        let error = send_and_recv_reply(&mut reader, &mut writer, &flush_req).await;
        assert_eq!(
            error,
            libc::EIO as u32,
            "sync failure should return EIO reply"
        );

        drop(writer);
        drop(reader);
        task.await.unwrap().unwrap();
    }

    /// Two dispatch tasks sharing the same COW layer handle concurrent
    /// read+write without deadlock or data corruption.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn dispatch_concurrent_read_write() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(RwLock::new(cow));
        let shutdown = CancellationToken::new();

        // Spawn two dispatch tasks sharing the same COW layer (mimics production NUM_CONNECTIONS).
        let mut clients = Vec::new();
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let (client_fd, server_fd) = {
                let mut fds = [0i32; 2];
                let ret = unsafe {
                    libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr())
                };
                assert_eq!(ret, 0);
                unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
            };
            let cow_clone = cow.clone();
            let token = shutdown.clone();
            tasks.push(tokio::spawn(async move {
                dispatch(server_fd, cow_clone, token).await
            }));
            let client_std =
                unsafe { std::os::unix::net::UnixStream::from_raw_fd(client_fd.into_raw_fd()) };
            client_std.set_nonblocking(true).unwrap();
            let stream = UnixStream::from_std(client_std).unwrap();
            clients.push(stream);
        }

        let (mut reader0, mut writer0) = clients.remove(0).into_split();
        let (mut reader1, mut writer1) = clients.remove(0).into_split();

        // Connection 0: write block 0
        let write_req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 10,
            offset: 0,
            length: 4096,
        };
        writer0
            .write_all(&serialize_request(&write_req))
            .await
            .unwrap();
        writer0.write_all(&vec![0xBB; 4096]).await.unwrap();
        let mut reply_buf = [0u8; 16];
        reader0.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
            0
        );

        // Connection 1: read block 0 concurrently — should see the written data
        let read_req = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 20,
            offset: 0,
            length: 4096,
        };
        writer1
            .write_all(&serialize_request(&read_req))
            .await
            .unwrap();
        reader1.read_exact(&mut reply_buf).await.unwrap();
        assert_eq!(
            u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
            0
        );
        let mut data = vec![0u8; 4096];
        reader1.read_exact(&mut data).await.unwrap();
        assert!(
            data.iter().all(|&b| b == 0xBB),
            "connection 1 should read data written by connection 0"
        );

        // Connection 1: write block 1 while connection 0 reads block 1 concurrently
        let write_req2 = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 21,
            offset: 4096,
            length: 4096,
        };
        let read_req2 = NbdRequest {
            flags: 0,
            command: Command::Read,
            handle: 11,
            offset: 4096,
            length: 4096,
        };

        // Send both requests concurrently
        let (write_result, read_result) = tokio::join!(
            async {
                writer1
                    .write_all(&serialize_request(&write_req2))
                    .await
                    .unwrap();
                writer1.write_all(&vec![0xCC; 4096]).await.unwrap();
                let mut buf = [0u8; 16];
                reader1.read_exact(&mut buf).await.unwrap();
                u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]])
            },
            async {
                writer0
                    .write_all(&serialize_request(&read_req2))
                    .await
                    .unwrap();
                let mut buf = [0u8; 16];
                reader0.read_exact(&mut buf).await.unwrap();
                let error = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
                let mut data = vec![0u8; 4096];
                reader0.read_exact(&mut data).await.unwrap();
                (error, data)
            }
        );

        assert_eq!(write_result, 0, "concurrent write should succeed");
        assert_eq!(read_result.0, 0, "concurrent read should succeed");
        // Read may return either base data (0xAA) or written data (0xCC)
        // depending on scheduling — both are valid. The key assertion is no
        // deadlock, no error, and no data corruption (all bytes the same).
        let byte = read_result.1[0];
        assert!(
            byte == 0xAA || byte == 0xCC,
            "data should be base (0xAA) or written (0xCC), got {byte:#x}"
        );
        assert!(
            read_result.1.iter().all(|&b| b == byte),
            "all bytes in block should be consistent"
        );

        // Shutdown both connections
        shutdown.cancel();
        for task in tasks {
            task.await.unwrap().unwrap();
        }
    }
}
