use std::os::unix::io::{FromRawFd, OwnedFd};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::cow::CowLayer;
use crate::error::Result;
use crate::protocol::{self, Command, NbdReply, NbdRequest, REQUEST_HEADER_SIZE};

/// Run the NBD dispatch loop on a Unix stream.
///
/// Reads NBD requests from the socket, dispatches to the COW layer,
/// and sends replies back. Handles graceful shutdown via the cancellation token.
pub async fn dispatch(
    socket_fd: OwnedFd,
    cow: Arc<Mutex<CowLayer>>,
    shutdown: CancellationToken,
) -> Result<()> {
    let raw_fd = std::os::unix::io::AsRawFd::as_raw_fd(&socket_fd);
    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(raw_fd) };
    std_stream.set_nonblocking(true)?;
    let stream = UnixStream::from_std(std_stream)?;
    // Prevent double-close: the UnixStream now owns the fd
    std::mem::forget(socket_fd);

    let (mut reader, mut writer) = stream.into_split();

    let mut header_buf = [0u8; REQUEST_HEADER_SIZE];

    loop {
        // Wait for either a request or shutdown signal
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                // Graceful shutdown: flush remaining data
                let mut cow = cow.lock().await;
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
                let mut cow = cow.lock().await;
                cow.sync()?;
                return Ok(());
            }
        }
    }
}

async fn handle_read(
    request: &NbdRequest,
    cow: &Arc<Mutex<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    let mut data = vec![0u8; request.length as usize];
    {
        let cow = cow.lock().await;
        cow.read(request.offset, &mut data)?;
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
    cow: &Arc<Mutex<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    // Read the write payload from the socket
    let mut data = vec![0u8; request.length as usize];
    reader.read_exact(&mut data).await?;

    let needs_flush = {
        let mut cow = cow.lock().await;
        cow.write(request.offset, &data)?
    };

    if needs_flush {
        let mut cow = cow.lock().await;
        cow.flush()?;
    }

    let reply = NbdReply {
        error: 0,
        handle: request.handle,
    };
    send_reply(writer, &reply).await
}

async fn handle_flush(
    request: &NbdRequest,
    cow: &Arc<Mutex<CowLayer>>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    {
        let mut cow = cow.lock().await;
        cow.sync()?;
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
        let mut cow =
            CowLayer::new(base.path(), base_data.len() as u64, 4096, 4 * 1024 * 1024).unwrap();
        cow.set_cow_path(cow_file.path());
        (base, cow_file, cow)
    }

    #[tokio::test]
    async fn dispatch_read_write_disconnect() {
        let base_data = vec![0xAA; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(Mutex::new(cow));
        let shutdown = CancellationToken::new();

        // Create a socketpair
        let (client_fd, server_fd) = {
            let mut fds = [0i32; 2];
            let ret =
                unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
            assert_eq!(ret, 0);
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
        };

        // Spawn the dispatch task
        let cow_clone = cow.clone();
        let shutdown_clone = shutdown.clone();
        let server_task =
            tokio::spawn(async move { dispatch(server_fd, cow_clone, shutdown_clone).await });

        // Use the client side
        let client_std = unsafe {
            std::os::unix::net::UnixStream::from_raw_fd(std::os::unix::io::AsRawFd::as_raw_fd(
                &client_fd,
            ))
        };
        client_std.set_nonblocking(true).unwrap();
        let client_stream = UnixStream::from_std(client_std).unwrap();
        std::mem::forget(client_fd);

        let (mut client_reader, mut client_writer) = client_stream.into_split();

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
        cow: Arc<Mutex<CowLayer>>,
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

        let client_std = unsafe {
            std::os::unix::net::UnixStream::from_raw_fd(std::os::unix::io::AsRawFd::as_raw_fd(
                &client_fd,
            ))
        };
        client_std.set_nonblocking(true).unwrap();
        let client_stream = UnixStream::from_std(client_std).unwrap();
        std::mem::forget(client_fd);

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
        let cow = Arc::new(Mutex::new(cow));

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
            let cow = cow.lock().await;
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
        let cow = Arc::new(Mutex::new(cow));

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
    async fn dispatch_shutdown_flushes_data() {
        let base_data = vec![0x00; 8192];
        let (_base, _cow_file, cow) = create_test_cow(&base_data);
        let cow = Arc::new(Mutex::new(cow));

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
            let cow = cow.lock().await;
            assert_eq!(cow.buffered_block_count(), 1);
        }

        // Signal shutdown (should flush)
        shutdown.cancel();
        task.await.unwrap().unwrap();

        // After shutdown, buffer should be flushed
        {
            let cow = cow.lock().await;
            assert_eq!(
                cow.buffered_block_count(),
                0,
                "shutdown should flush buffer"
            );
        }
    }
}
