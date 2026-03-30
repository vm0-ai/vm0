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
}
