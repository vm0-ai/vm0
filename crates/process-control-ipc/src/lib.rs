//! Local process-control IPC channel.
//!
//! This crate is intentionally std-only. `vsock-guest` uses it from blocking
//! worker threads, while `guest-agent` can use it without introducing another
//! async protocol implementation.

use std::io::{self, Read, Write};
use std::mem::{MaybeUninit, size_of};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::{Duration, Instant};

pub const BOOTSTRAP_ENV: &str = "VM0_PROCESS_CONTROL_ENDPOINT";

pub const MAX_CONTROL_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const MAX_MESSAGE_ID_BYTES: usize = u16::MAX as usize;
const MAX_FRAME_BYTES: usize = 1 + 1 + 2 + MAX_MESSAGE_ID_BYTES + 4 + MAX_CONTROL_PAYLOAD_BYTES;
const FRAME_VERSION: u8 = 1;

const FRAME_HELLO: u8 = 0x01;
const FRAME_REQUEST: u8 = 0x02;
const FRAME_RESPONSE: u8 = 0x03;

const RESPONSE_ACCEPTED: u8 = 0x00;
const RESPONSE_REJECTED: u8 = 0x01;
const RESPONSE_ERROR: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlRequest {
    pub message_id: String,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlResponse {
    pub message_id: String,
    pub status: ControlResponseStatus,
    pub diagnostic: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlResponseStatus {
    Accepted,
    Rejected,
    Error,
}

pub fn endpoint_name(seq: u32, nonce: &[u8; 16]) -> String {
    let mut out = format!("vm0-process-control-{seq}-");
    for byte in nonce {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn bind_abstract_listener(name: &str) -> io::Result<UnixListener> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe { libc::bind(fd, &addr as *const _ as *const libc::sockaddr, len) };
    if ret != 0 {
        let err = io::Error::last_os_error();
        // SAFETY: fd is owned by this function on this error path.
        unsafe { libc::close(fd) };
        return Err(err);
    }
    // SAFETY: fd is a valid bound AF_UNIX socket.
    let ret = unsafe { libc::listen(fd, 1) };
    if ret != 0 {
        let err = io::Error::last_os_error();
        // SAFETY: fd is owned by this function on this error path.
        unsafe { libc::close(fd) };
        return Err(err);
    }
    // SAFETY: fd is a valid listener and ownership is transferred.
    Ok(unsafe { UnixListener::from_raw_fd(fd) })
}

pub fn connect_abstract(name: &str) -> io::Result<UnixStream> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe { libc::connect(fd, &addr as *const _ as *const libc::sockaddr, len) };
    if ret != 0 {
        let err = io::Error::last_os_error();
        // SAFETY: fd is owned by this function on this error path.
        unsafe { libc::close(fd) };
        return Err(err);
    }
    // SAFETY: fd is a valid connected stream and ownership is transferred.
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}

pub fn accept_with_timeout(listener: &UnixListener, timeout: Duration) -> io::Result<UnixStream> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "accept timeout overflowed"))?;
    loop {
        match poll_fd(listener.as_raw_fd(), libc::POLLIN, deadline)? {
            true => {
                // SAFETY: listener fd is valid and accept4 initializes addr/len.
                let fd = unsafe {
                    libc::accept4(
                        listener.as_raw_fd(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        libc::SOCK_CLOEXEC,
                    )
                };
                if fd >= 0 {
                    // SAFETY: fd is a connected stream returned by accept4.
                    return Ok(unsafe { UnixStream::from_raw_fd(fd) });
                }
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(err);
            }
            false => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control endpoint accept timed out",
                ));
            }
        }
    }
}

pub fn write_hello(stream: &mut UnixStream) -> io::Result<()> {
    write_frame(stream, FRAME_HELLO, &[])
}

pub fn read_hello(stream: &mut UnixStream) -> io::Result<()> {
    let frame = read_frame(stream)?;
    if frame.kind != FRAME_HELLO || !frame.payload.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid control hello frame",
        ));
    }
    Ok(())
}

pub fn write_request(stream: &mut UnixStream, request: &ControlRequest) -> io::Result<()> {
    let message_id = request.message_id.as_bytes();
    if message_id.is_empty() || message_id.len() > MAX_MESSAGE_ID_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid control message id length",
        ));
    }
    if request.payload.len() > MAX_CONTROL_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control payload too large",
        ));
    }
    let mut payload = Vec::with_capacity(2 + message_id.len() + 4 + request.payload.len());
    payload.extend_from_slice(&(message_id.len() as u16).to_be_bytes());
    payload.extend_from_slice(message_id);
    payload.extend_from_slice(&(request.payload.len() as u32).to_be_bytes());
    payload.extend_from_slice(&request.payload);
    write_frame(stream, FRAME_REQUEST, &payload)
}

pub fn read_request(stream: &mut UnixStream) -> io::Result<ControlRequest> {
    let frame = read_frame(stream)?;
    if frame.kind != FRAME_REQUEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected control request frame",
        ));
    }
    decode_request(&frame.payload)
}

pub fn write_response(stream: &mut UnixStream, response: &ControlResponse) -> io::Result<()> {
    let message_id = response.message_id.as_bytes();
    let diagnostic = response.diagnostic.as_bytes();
    if message_id.is_empty() || message_id.len() > MAX_MESSAGE_ID_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid control message id length",
        ));
    }
    if diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control diagnostic too large",
        ));
    }
    let mut payload = Vec::with_capacity(2 + message_id.len() + 1 + 2 + diagnostic.len());
    payload.extend_from_slice(&(message_id.len() as u16).to_be_bytes());
    payload.extend_from_slice(message_id);
    payload.push(match response.status {
        ControlResponseStatus::Accepted => RESPONSE_ACCEPTED,
        ControlResponseStatus::Rejected => RESPONSE_REJECTED,
        ControlResponseStatus::Error => RESPONSE_ERROR,
    });
    payload.extend_from_slice(&(diagnostic.len() as u16).to_be_bytes());
    payload.extend_from_slice(diagnostic);
    write_frame(stream, FRAME_RESPONSE, &payload)
}

pub fn read_response(stream: &mut UnixStream) -> io::Result<ControlResponse> {
    let frame = read_frame(stream)?;
    if frame.kind != FRAME_RESPONSE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected control response frame",
        ));
    }
    decode_response(&frame.payload)
}

fn create_unix_socket() -> io::Result<libc::c_int> {
    // SAFETY: socket arguments are constants for an AF_UNIX stream socket.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fd)
}

fn abstract_sockaddr(name: &str) -> io::Result<libc::sockaddr_un> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() + 1 > sockaddr_un_path_len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid abstract socket name",
        ));
    }

    // SAFETY: zeroed sockaddr_un is a valid starting point before fields are set.
    let mut addr = unsafe { MaybeUninit::<libc::sockaddr_un>::zeroed().assume_init() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    addr.sun_path[0] = 0;
    for (index, byte) in bytes.iter().enumerate() {
        let Some(slot) = addr.sun_path.get_mut(index + 1) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid abstract socket name",
            ));
        };
        *slot = *byte as libc::c_char;
    }
    Ok(addr)
}

fn sockaddr_un_path_len() -> usize {
    // SAFETY: zeroed sockaddr_un is only used to inspect array length.
    let addr = unsafe { MaybeUninit::<libc::sockaddr_un>::zeroed().assume_init() };
    addr.sun_path.len()
}

fn sockaddr_len(name: &str) -> libc::socklen_t {
    (size_of::<libc::sa_family_t>() + 1 + name.len()) as libc::socklen_t
}

fn poll_fd(fd: libc::c_int, events: libc::c_short, deadline: Instant) -> io::Result<bool> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let remaining = deadline.duration_since(now);
        let timeout_ms = i32::try_from(remaining.as_millis())
            .unwrap_or(i32::MAX)
            .max(1);
        let mut pfd = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: pfd points to a valid pollfd for one descriptor.
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret > 0 {
            return Ok((pfd.revents & events) != 0);
        }
        if ret == 0 {
            return Ok(false);
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

struct Frame {
    kind: u8,
    payload: Vec<u8>,
}

fn write_frame(stream: &mut UnixStream, kind: u8, payload: &[u8]) -> io::Result<()> {
    let body_len = 2usize
        .checked_add(payload.len())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "control frame too large"))?;
    if body_len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control frame too large",
        ));
    }
    let mut frame = Vec::with_capacity(4 + body_len);
    frame.extend_from_slice(&(body_len as u32).to_be_bytes());
    frame.push(FRAME_VERSION);
    frame.push(kind);
    frame.extend_from_slice(payload);
    stream.write_all(&frame)
}

fn read_frame(stream: &mut UnixStream) -> io::Result<Frame> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len)?;
    let body_len = u32::from_be_bytes(len) as usize;
    if !(2..=MAX_FRAME_BYTES).contains(&body_len) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid control frame length",
        ));
    }
    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body)?;
    let Some((&version, rest)) = body.split_first() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid control frame length",
        ));
    };
    let Some((&kind, payload)) = rest.split_first() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid control frame length",
        ));
    };
    if version != FRAME_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid control frame version",
        ));
    }
    Ok(Frame {
        kind,
        payload: payload.to_vec(),
    })
}

fn decode_request(payload: &[u8]) -> io::Result<ControlRequest> {
    let mut offset = 0usize;
    let message_id = read_string_u16(payload, &mut offset, "control request message id")?;
    let payload_len = read_u32(payload, &mut offset, "control request payload length")? as usize;
    if payload_len > MAX_CONTROL_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control request payload too large",
        ));
    }
    let message_payload = read_bytes(payload, &mut offset, payload_len, "control request payload")?;
    expect_consumed(payload, offset)?;
    Ok(ControlRequest {
        message_id,
        payload: message_payload.to_vec(),
    })
}

fn decode_response(payload: &[u8]) -> io::Result<ControlResponse> {
    let mut offset = 0usize;
    let message_id = read_string_u16(payload, &mut offset, "control response message id")?;
    let raw_status = read_u8(payload, &mut offset, "control response status")?;
    let diagnostic =
        read_string_u16_allow_empty(payload, &mut offset, "control response diagnostic")?;
    if diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control response diagnostic too large",
        ));
    }
    expect_consumed(payload, offset)?;
    let status = match raw_status {
        RESPONSE_ACCEPTED => ControlResponseStatus::Accepted,
        RESPONSE_REJECTED => ControlResponseStatus::Rejected,
        RESPONSE_ERROR => ControlResponseStatus::Error,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid control response status",
            ));
        }
    };
    Ok(ControlResponse {
        message_id,
        status,
        diagnostic,
    })
}

fn read_string_u16(payload: &[u8], offset: &mut usize, label: &'static str) -> io::Result<String> {
    let len = read_u16(payload, offset, label)? as usize;
    if len == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} empty"),
        ));
    }
    let bytes = read_bytes(payload, offset, len, label)?;
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("{label} invalid utf-8")))
}

fn read_string_u16_allow_empty(
    payload: &[u8],
    offset: &mut usize,
    label: &'static str,
) -> io::Result<String> {
    let len = read_u16(payload, offset, label)? as usize;
    let bytes = read_bytes(payload, offset, len, label)?;
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("{label} invalid utf-8")))
}

fn read_u8(payload: &[u8], offset: &mut usize, label: &'static str) -> io::Result<u8> {
    let Some(value) = payload.get(*offset).copied() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} truncated"),
        ));
    };
    *offset += 1;
    Ok(value)
}

fn read_u16(payload: &[u8], offset: &mut usize, label: &'static str) -> io::Result<u16> {
    let bytes = read_bytes(payload, offset, 2, label)?;
    Ok(u16::from_be_bytes(bytes.try_into().unwrap_or([0; 2])))
}

fn read_u32(payload: &[u8], offset: &mut usize, label: &'static str) -> io::Result<u32> {
    let bytes = read_bytes(payload, offset, 4, label)?;
    Ok(u32::from_be_bytes(bytes.try_into().unwrap_or([0; 4])))
}

fn read_bytes<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len: usize,
    label: &'static str,
) -> io::Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("{label} truncated")))?;
    let Some(bytes) = payload.get(*offset..end) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} truncated"),
        ));
    };
    *offset = end;
    Ok(bytes)
}

fn expect_consumed(payload: &[u8], offset: usize) -> io::Result<()> {
    if offset != payload.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control frame trailing bytes",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_name_includes_seq_and_nonce() {
        let nonce = *b"0123456789abcdef";
        assert_eq!(
            endpoint_name(7, &nonce),
            "vm0-process-control-7-30313233343536373839616263646566"
        );
    }

    #[test]
    fn request_response_roundtrip() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let request = ControlRequest {
            message_id: "msg-1".to_string(),
            payload: b"hello".to_vec(),
        };
        write_request(&mut a, &request).unwrap();
        assert_eq!(read_request(&mut b).unwrap(), request);

        let response = ControlResponse {
            message_id: "msg-1".to_string(),
            status: ControlResponseStatus::Rejected,
            diagnostic: "no".to_string(),
        };
        write_response(&mut b, &response).unwrap();
        assert_eq!(read_response(&mut a).unwrap(), response);
    }

    #[test]
    fn hello_roundtrip() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        write_hello(&mut a).unwrap();
        read_hello(&mut b).unwrap();
    }

    #[test]
    fn request_rejects_too_large_payload() {
        let (mut a, _b) = UnixStream::pair().unwrap();
        let request = ControlRequest {
            message_id: "msg-1".to_string(),
            payload: vec![0; MAX_CONTROL_PAYLOAD_BYTES + 1],
        };
        assert!(write_request(&mut a, &request).is_err());
    }

    #[test]
    fn abstract_socket_connects() {
        let name = format!(
            "vm0-test-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        );
        let listener = bind_abstract_listener(&name).unwrap();
        let client = std::thread::spawn({
            let name = name.clone();
            move || connect_abstract(&name).unwrap()
        });
        let server = accept_with_timeout(&listener, Duration::from_secs(1)).unwrap();
        let _client = client.join().unwrap();
        drop(server);
    }
}
