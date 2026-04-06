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

    loop {
        // Wait for either a request or shutdown signal
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                // Graceful shutdown: flush remaining data
                let mut cow = cow.write().await;
                cow.sync()?;
                return Ok(());
            }
            result = reader.read_exact(&mut header_buf) => {
                match result {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        // Connection closed
                        return Ok(());
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }

        let request = protocol::parse_request(&header_buf)?;

        match request.command {
            Command::Read => {
                handle_read(&request, &cow, &mut writer).await?;
            }
            Command::Write => {
                handle_write(&request, &mut reader, &cow, &mut writer).await?;
            }
            Command::Flush => {
                handle_flush(&request, &cow, &mut writer).await?;
            }
            Command::Trim => {
                // Trim is a no-op for now (COW file is sparse, unused blocks are holes)
                send_reply(
                    &mut writer,
                    &NbdReply {
                        error: 0,
                        handle: request.handle,
                    },
                )
                .await?;
            }
            Command::Disconnect => {
                let mut cow = cow.write().await;
                cow.sync()?;
                return Ok(());
            }
        }
    }
}

async fn handle_read(
    request: &NbdRequest,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    if request.length > MAX_REQUEST_LENGTH {
        send_error_reply(writer, request.handle, libc::EIO as u32).await?;
        return Ok(());
    }
    let mut data = vec![0u8; request.length as usize];
    {
        let cow = cow.read().await;
        if let Err(e) = cow.read(request.offset, &mut data) {
            tracing::warn!(
                offset = request.offset,
                len = request.length,
                "read error: {e}"
            );
            send_error_reply(writer, request.handle, libc::EIO as u32).await?;
            return Ok(());
        }
    }

    let reply = NbdReply {
        error: 0,
        handle: request.handle,
    };
    let reply_buf = protocol::serialize_reply(&reply);
    writer.write_all(&reply_buf).await?;
    writer.write_all(&data).await?;
    Ok(())
}

async fn handle_write(
    request: &NbdRequest,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    if request.length > MAX_REQUEST_LENGTH {
        // Must consume the payload to keep the protocol stream in sync
        discard_bytes(reader, request.length as u64).await?;
        send_error_reply(writer, request.handle, libc::EIO as u32).await?;
        return Ok(());
    }
    // Read the write payload from the socket
    let mut data = vec![0u8; request.length as usize];
    reader.read_exact(&mut data).await?;

    {
        let mut cow = cow.write().await;
        match cow.write(request.offset, &data) {
            Ok(needs_flush) => {
                if needs_flush && let Err(e) = cow.flush() {
                    tracing::warn!("flush error after write: {e}");
                    send_error_reply(writer, request.handle, libc::EIO as u32).await?;
                    return Ok(());
                }
            }
            Err(e) => {
                tracing::warn!(
                    offset = request.offset,
                    len = request.length,
                    "write error: {e}"
                );
                send_error_reply(writer, request.handle, libc::EIO as u32).await?;
                return Ok(());
            }
        }
    }

    let reply = NbdReply {
        error: 0,
        handle: request.handle,
    };
    send_reply(writer, &reply).await
}

async fn handle_flush(
    request: &NbdRequest,
    cow: &Arc<RwLock<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    {
        let mut cow = cow.write().await;
        if let Err(e) = cow.sync() {
            tracing::warn!("sync error: {e}");
            send_error_reply(writer, request.handle, libc::EIO as u32).await?;
            return Ok(());
        }
    }

    let reply = NbdReply {
        error: 0,
        handle: request.handle,
    };
    send_reply(writer, &reply).await
}

async fn send_reply(writer: &mut tokio::net::unix::OwnedWriteHalf, reply: &NbdReply) -> Result<()> {
    let buf = protocol::serialize_reply(reply);
    writer.write_all(&buf).await?;
    Ok(())
}

async fn send_error_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    handle: u64,
    error: u32,
) -> Result<()> {
    send_reply(writer, &NbdReply { error, handle }).await
}

/// Discard `n` bytes from the reader to keep the protocol stream in sync.
async fn discard_bytes(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    mut remaining: u64,
) -> Result<()> {
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let dest = buf
            .get_mut(..to_read)
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("discard slice error")))?;
        reader.read_exact(dest).await?;
        remaining -= to_read as u64;
    }
    Ok(())
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
