use std::error::Error;
use std::io::Write as _;
use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use nbd_cow::cow::CowLayer;
use nbd_cow::error::Result as NbdResult;
use nbd_cow::protocol::{
    Command, NbdReply, NbdRequest, REPLY_HEADER_SIZE, REPLY_MAGIC, REQUEST_HEADER_SIZE,
    REQUEST_MAGIC,
};
use nbd_cow::server::dispatch;
use nbd_cow::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD};
use tempfile::NamedTempFile;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub type TestResult<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

pub struct DispatchClient {
    reader: OwnedReadHalf,
    writer: OwnedWriteHalf,
}

impl DispatchClient {
    pub async fn read(&mut self, handle: u64, offset: u64, length: u32) -> TestResult<Vec<u8>> {
        let request = request(Command::Read, handle, offset, length);
        self.send_request(&request).await?;
        let reply = self.read_reply().await?;
        assert_success(&reply, handle);
        self.read_payload(length as usize).await
    }

    pub async fn write(&mut self, handle: u64, offset: u64, data: &[u8]) -> TestResult<NbdReply> {
        let length = u32::try_from(data.len())?;
        let request = request(Command::Write, handle, offset, length);
        self.send_request(&request).await?;
        self.write_payload(data).await?;
        self.read_reply().await
    }

    pub async fn flush(&mut self, handle: u64) -> TestResult<NbdReply> {
        let request = request(Command::Flush, handle, 0, 0);
        self.send_request(&request).await?;
        self.read_reply().await
    }

    pub async fn trim(&mut self, handle: u64, offset: u64, length: u32) -> TestResult<NbdReply> {
        let request = request(Command::Trim, handle, offset, length);
        self.send_request(&request).await?;
        self.read_reply().await
    }

    pub async fn disconnect(&mut self, handle: u64) -> TestResult<()> {
        let request = request(Command::Disconnect, handle, 0, 0);
        self.send_request(&request).await
    }

    pub async fn send_request(&mut self, request: &NbdRequest) -> TestResult<()> {
        self.writer.write_all(&serialize_request(request)).await?;
        Ok(())
    }

    pub async fn write_payload(&mut self, data: &[u8]) -> TestResult<()> {
        self.writer.write_all(data).await?;
        Ok(())
    }

    pub async fn write_repeated_payload(
        &mut self,
        byte: u8,
        total: usize,
        chunk_size: usize,
    ) -> TestResult<()> {
        if total > 0 && chunk_size == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "payload chunk size must be non-zero",
            )
            .into());
        }

        if total == 0 {
            return Ok(());
        }

        let chunk = vec![byte; chunk_size.min(total)];
        let mut sent = 0usize;
        while sent < total {
            let to_send = chunk.len().min(total - sent);
            let payload = chunk
                .get(..to_send)
                .ok_or_else(|| std::io::Error::other("payload chunk slice out of bounds"))?;
            self.write_payload(payload).await?;
            sent += to_send;
        }
        Ok(())
    }

    pub async fn read_reply(&mut self) -> TestResult<NbdReply> {
        let mut reply_buf = [0u8; REPLY_HEADER_SIZE];
        self.reader.read_exact(&mut reply_buf).await?;
        let [
            magic_0,
            magic_1,
            magic_2,
            magic_3,
            error_0,
            error_1,
            error_2,
            error_3,
            handle_0,
            handle_1,
            handle_2,
            handle_3,
            handle_4,
            handle_5,
            handle_6,
            handle_7,
        ] = reply_buf;
        let magic = u32::from_be_bytes([magic_0, magic_1, magic_2, magic_3]);
        assert_eq!(magic, REPLY_MAGIC);

        Ok(NbdReply {
            error: u32::from_be_bytes([error_0, error_1, error_2, error_3]),
            handle: u64::from_be_bytes([
                handle_0, handle_1, handle_2, handle_3, handle_4, handle_5, handle_6, handle_7,
            ]),
        })
    }

    pub async fn read_payload(&mut self, len: usize) -> TestResult<Vec<u8>> {
        let mut data = vec![0u8; len];
        self.reader.read_exact(&mut data).await?;
        Ok(data)
    }
}

pub fn request(command: Command, handle: u64, offset: u64, length: u32) -> NbdRequest {
    NbdRequest {
        flags: 0,
        command,
        handle,
        offset,
        length,
    }
}

pub fn assert_success(reply: &NbdReply, expected_handle: u64) {
    assert_eq!(reply.handle, expected_handle);
    assert_eq!(reply.error, 0);
}

pub fn assert_error(reply: &NbdReply, expected_handle: u64) {
    assert_eq!(reply.handle, expected_handle);
    assert_ne!(reply.error, 0);
}

pub fn assert_error_code(reply: &NbdReply, expected_handle: u64, expected_error: u32) {
    assert_eq!(reply.handle, expected_handle);
    assert_eq!(reply.error, expected_error);
}

pub fn create_test_cow(base_data: &[u8]) -> TestResult<(NamedTempFile, NamedTempFile, CowLayer)> {
    create_test_cow_with_flush_threshold(base_data, DEFAULT_FLUSH_THRESHOLD)
}

pub fn create_test_cow_with_flush_threshold(
    base_data: &[u8],
    flush_threshold: usize,
) -> TestResult<(NamedTempFile, NamedTempFile, CowLayer)> {
    let mut base = NamedTempFile::new()?;
    base.write_all(base_data)?;
    base.flush()?;

    let cow_file = NamedTempFile::new()?;
    let cow = CowLayer::new(
        base.path(),
        cow_file.path(),
        base_data.len() as u64,
        BLOCK_SIZE,
        flush_threshold,
    )?;

    Ok((base, cow_file, cow))
}

pub fn create_base_file(base_data: &[u8]) -> TestResult<NamedTempFile> {
    let mut base = NamedTempFile::new()?;
    base.write_all(base_data)?;
    base.flush()?;
    Ok(base)
}

pub fn create_cow_with_full_device(
    base: &NamedTempFile,
    flush_threshold: usize,
) -> TestResult<CowLayer> {
    let size = base.as_file().metadata()?.len();
    let cow = CowLayer::new(
        base.path(),
        Path::new("/dev/full"),
        size,
        BLOCK_SIZE,
        flush_threshold,
    )?;
    Ok(cow)
}

pub async fn spawn_dispatch(
    cow: Arc<RwLock<CowLayer>>,
) -> TestResult<(DispatchClient, JoinHandle<NbdResult<()>>, CancellationToken)> {
    let shutdown = CancellationToken::new();
    let (client, task) = spawn_dispatch_with_shutdown(cow, shutdown.clone()).await?;
    Ok((client, task, shutdown))
}

pub async fn spawn_dispatch_with_shutdown(
    cow: Arc<RwLock<CowLayer>>,
    shutdown: CancellationToken,
) -> TestResult<(DispatchClient, JoinHandle<NbdResult<()>>)> {
    let (client_fd, server_fd) = socketpair()?;

    let client_std =
        unsafe { std::os::unix::net::UnixStream::from_raw_fd(client_fd.into_raw_fd()) };
    client_std.set_nonblocking(true)?;
    let client_stream = UnixStream::from_std(client_std)?;
    let (reader, writer) = client_stream.into_split();

    let cow_clone = cow.clone();
    let shutdown_clone = shutdown.clone();
    let task = tokio::spawn(async move { dispatch(server_fd, cow_clone, shutdown_clone).await });

    Ok((DispatchClient { reader, writer }, task))
}

pub async fn wait_for_dispatch(task: JoinHandle<NbdResult<()>>) -> TestResult<()> {
    tokio::time::timeout(Duration::from_secs(1), task).await???;
    Ok(())
}

fn socketpair() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn serialize_request(request: &NbdRequest) -> [u8; REQUEST_HEADER_SIZE] {
    let [magic_0, magic_1, magic_2, magic_3] = REQUEST_MAGIC.to_be_bytes();
    let [flags_0, flags_1] = request.flags.to_be_bytes();
    let [command_0, command_1] = (request.command as u16).to_be_bytes();
    let [
        handle_0,
        handle_1,
        handle_2,
        handle_3,
        handle_4,
        handle_5,
        handle_6,
        handle_7,
    ] = request.handle.to_be_bytes();
    let [
        offset_0,
        offset_1,
        offset_2,
        offset_3,
        offset_4,
        offset_5,
        offset_6,
        offset_7,
    ] = request.offset.to_be_bytes();
    let [length_0, length_1, length_2, length_3] = request.length.to_be_bytes();

    [
        magic_0, magic_1, magic_2, magic_3, flags_0, flags_1, command_0, command_1, handle_0,
        handle_1, handle_2, handle_3, handle_4, handle_5, handle_6, handle_7, offset_0, offset_1,
        offset_2, offset_3, offset_4, offset_5, offset_6, offset_7, length_0, length_1, length_2,
        length_3,
    ]
}
