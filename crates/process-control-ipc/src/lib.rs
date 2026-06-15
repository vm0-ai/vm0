#![deny(missing_docs)]

//! Local process-control IPC channel for a guest operation control sink.
//!
//! This crate defines the local, blocking protocol used after `vsock-guest`
//! exposes an operation-control endpoint and `guest-agent` connects back to it.
//! The transport is a Linux abstract Unix stream socket. Endpoint names are
//! abstract-socket names, not filesystem paths.
//!
//! The endpoint is bootstrapped through [`BOOTSTRAP_ENV`]. `vsock-guest`
//! creates the endpoint name with [`endpoint_name`], binds it with
//! [`bind_abstract_listener`], accepts a single control sink connection, and
//! then drives request/response exchange. `guest-agent` reads the endpoint name
//! from the environment, connects with [`connect_abstract`], sends a hello
//! frame, then reads requests and writes responses.
//!
//! ## Frame format
//!
//! Every frame uses this envelope:
//!
//! ```text
//! [4B body_len][1B version][1B kind][payload]
//! ```
//!
//! All integer fields are big-endian. `body_len` is the byte length of
//! `[version][kind][payload]`; it does not include the 4-byte `body_len` field.
//! The current version byte is `1`.
//!
//! Frame kinds:
//!
//! | Kind | Name     | Payload |
//! |------|----------|---------|
//! | 0x01 | hello    | empty |
//! | 0x02 | request  | `[2B message_id_len][message_id][4B payload_len][payload]` |
//! | 0x03 | response | `[2B message_id_len][message_id][1B status][2B diagnostic_len][diagnostic]` |
//!
//! Response status values:
//!
//! | Status | Name     | Meaning |
//! |--------|----------|---------|
//! | 0x00   | accepted | sink handled the request |
//! | 0x01   | rejected | sink understood the request but declined it |
//! | 0x02   | error    | sink failed while processing the request |
//!
//! ## Expected sequence
//!
//! ```text
//! vsock-guest: bind_abstract_listener -> accept_with_timeout -> read_hello
//! guest-agent:                         connect_abstract     -> write_hello
//! vsock-guest: write_request
//! guest-agent: read_request -> write_response
//! vsock-guest: read_response
//! ```
//!
//! The request and response exchange can repeat on the connected stream until
//! either endpoint closes it. Message ids are non-empty UTF-8 strings. Request
//! payloads are bounded by [`MAX_CONTROL_PAYLOAD_BYTES`], and response
//! diagnostics are bounded by [`MAX_DIAGNOSTIC_BYTES`].

use std::io::{self, Read, Write};
use std::mem::{MaybeUninit, size_of};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::{Duration, Instant};

/// Environment variable carrying the operation-control abstract socket name.
///
/// `vsock-guest` sets this value to the output of [`endpoint_name`] when it
/// starts a guest operation that supports a local control sink. `guest-agent`
/// reads it during startup and connects to that abstract socket. Child agent
/// CLI processes must not inherit this variable.
pub const BOOTSTRAP_ENV: &str = "VM0_PROCESS_CONTROL_ENDPOINT";

/// Maximum request payload size carried by a local control request frame.
///
/// [`write_request`] returns `InvalidInput` when a request payload exceeds this
/// limit. [`read_request`] returns `InvalidData` when an incoming request frame
/// declares a payload larger than this limit.
pub const MAX_CONTROL_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Maximum diagnostic string size carried by a local control response frame.
///
/// [`write_response`] returns `InvalidInput` when a response diagnostic exceeds
/// this limit. [`read_response`] returns `InvalidData` when an incoming response
/// frame declares a diagnostic larger than this limit.
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

/// Request forwarded from `vsock-guest` to the connected control sink.
///
/// The request payload is opaque to this crate. This crate only frames it,
/// enforces the payload size limit, and preserves the message id used to match
/// the response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlRequest {
    /// Non-empty UTF-8 message id used to correlate the response.
    ///
    /// On the wire this is encoded as `[2B message_id_len][message_id]`.
    pub message_id: String,

    /// Opaque request payload bytes.
    ///
    /// On the wire this is encoded after the message id as
    /// `[4B payload_len][payload]`.
    pub payload: Vec<u8>,
}

/// Response returned by the connected control sink.
///
/// `vsock-guest` maps this local response into the outer host/guest
/// control-result protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlResponse {
    /// Message id copied from the corresponding [`ControlRequest`].
    pub message_id: String,

    /// Local sink outcome.
    pub status: ControlResponseStatus,

    /// Optional diagnostic text for rejected or failed requests.
    ///
    /// The diagnostic may be empty and is bounded by [`MAX_DIAGNOSTIC_BYTES`].
    pub diagnostic: String,
}

/// Local control sink response status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlResponseStatus {
    /// The control sink accepted and handled the request.
    ///
    /// `vsock-guest` maps this to the outer delivered status.
    Accepted,

    /// The control sink understood the request but declined it as an
    /// application-level outcome.
    ///
    /// `vsock-guest` maps this to the outer rejected status without treating
    /// the sink connection as broken.
    Rejected,

    /// The control sink failed while processing the request.
    ///
    /// `vsock-guest` maps this to the outer sink-error status. This status is
    /// distinct from local transport or frame parsing errors, which are
    /// returned as `io::Error` by the read/write helpers.
    Error,
}

/// Build the abstract socket name for an operation-control endpoint.
///
/// The name includes the guest operation sequence number and a hexadecimal
/// encoding of the 16-byte control nonce. The returned string is suitable for
/// [`bind_abstract_listener`], [`connect_abstract`], and [`BOOTSTRAP_ENV`].
pub fn endpoint_name(seq: u32, nonce: &[u8; 16]) -> String {
    let mut out = format!("vm0-process-control-{seq}-");
    for byte in nonce {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Bind a Linux abstract Unix listener for an operation-control endpoint name.
///
/// `name` is an abstract socket name, not a filesystem path. The resulting
/// listener is suitable for [`accept_with_timeout`].
///
/// # Errors
///
/// Returns `InvalidInput` when `name` is empty, contains a NUL byte, or does
/// not fit in `sockaddr_un.sun_path`. Socket creation, bind, and listen
/// failures are returned as operating-system `io::Error` values.
pub fn bind_abstract_listener(name: &str) -> io::Result<UnixListener> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            &addr as *const _ as *const libc::sockaddr,
            len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid bound AF_UNIX socket.
    let ret = unsafe { libc::listen(fd.as_raw_fd(), 1) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid listener and ownership is transferred.
    Ok(unsafe { UnixListener::from_raw_fd(fd.into_raw_fd()) })
}

/// Connect to a Linux abstract Unix operation-control endpoint.
///
/// `name` is an abstract socket name, not a filesystem path. A newly connected
/// guest-agent side stream must send [`write_hello`] before the server side
/// treats the sink as connected.
///
/// # Errors
///
/// Returns `InvalidInput` when `name` is empty, contains a NUL byte, or does
/// not fit in `sockaddr_un.sun_path`. Socket creation and connect failures are
/// returned as operating-system `io::Error` values.
pub fn connect_abstract(name: &str) -> io::Result<UnixStream> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            &addr as *const _ as *const libc::sockaddr,
            len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid connected stream and ownership is transferred.
    Ok(unsafe { UnixStream::from_raw_fd(fd.into_raw_fd()) })
}

/// Accept one stream from an operation-control listener before `timeout` elapses.
///
/// The listener is expected to come from [`bind_abstract_listener`].
///
/// # Errors
///
/// Returns `InvalidInput` if the timeout deadline overflows. Returns
/// `TimedOut` if no connection is accepted before the deadline. Poll and accept
/// failures are returned as operating-system `io::Error` values.
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

/// Write the required hello frame to a connected stream.
///
/// The hello frame has kind `0x01` and an empty payload. `guest-agent` writes
/// this immediately after connecting, and `vsock-guest` reads it before marking
/// the sink connected.
///
/// # Errors
///
/// Stream write failures are returned as standard library `io::Error` values.
pub fn write_hello(stream: &mut UnixStream) -> io::Result<()> {
    write_frame(stream, FRAME_HELLO, &[])
}

/// Read and validate the required hello frame from a connected stream.
///
/// # Errors
///
/// Returns `InvalidData` if the next frame is not a hello frame with an empty
/// payload, has an invalid length, or has an unsupported frame version. Stream
/// read failures are returned as standard library `io::Error` values.
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

/// Write a request frame to a connected control sink stream.
///
/// The request payload layout is:
///
/// ```text
/// [2B message_id_len][message_id][4B payload_len][payload]
/// ```
///
/// # Errors
///
/// Returns `InvalidInput` if the message id is empty, the message id does not
/// fit in `u16`, or the payload exceeds [`MAX_CONTROL_PAYLOAD_BYTES`]. Stream
/// write failures are returned as standard library `io::Error` values.
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

/// Read and decode a request frame from a connected control sink stream.
///
/// # Errors
///
/// Returns `InvalidData` if the next frame is not a request frame or if the
/// frame envelope or request payload is malformed, truncated, contains invalid
/// UTF-8, contains trailing bytes, or declares a payload larger than
/// [`MAX_CONTROL_PAYLOAD_BYTES`]. Stream read failures are returned as standard
/// library `io::Error` values.
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

/// Write a response frame to a connected control sink stream.
///
/// The response payload layout is:
///
/// ```text
/// [2B message_id_len][message_id][1B status][2B diagnostic_len][diagnostic]
/// ```
///
/// # Errors
///
/// Returns `InvalidInput` if the message id is empty, the message id does not
/// fit in `u16`, or the diagnostic exceeds [`MAX_DIAGNOSTIC_BYTES`]. Stream
/// write failures are returned as standard library `io::Error` values.
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

/// Read and decode a response frame from a connected control sink stream.
///
/// # Errors
///
/// Returns `InvalidData` if the next frame is not a response frame or if the
/// frame envelope or response payload is malformed, truncated, contains invalid
/// UTF-8, contains trailing bytes, contains an unknown status byte, or declares
/// a diagnostic larger than [`MAX_DIAGNOSTIC_BYTES`]. Stream read failures are
/// returned as standard library `io::Error` values.
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

fn create_unix_socket() -> io::Result<OwnedFd> {
    // SAFETY: socket arguments are constants for an AF_UNIX stream socket.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a newly-created socket owned by this function.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
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
    let bytes: [u8; 2] = read_bytes(payload, offset, 2, label)?
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("{label} truncated")))?;
    Ok(u16::from_be_bytes(bytes))
}

fn read_u32(payload: &[u8], offset: &mut usize, label: &'static str) -> io::Result<u32> {
    let bytes: [u8; 4] = read_bytes(payload, offset, 4, label)?
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("{label} truncated")))?;
    Ok(u32::from_be_bytes(bytes))
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
    fn request_rejects_invalid_message_id_lengths() {
        let (mut stream, _peer) = UnixStream::pair().unwrap();

        for message_id in ["".to_owned(), "x".repeat(MAX_MESSAGE_ID_BYTES + 1)] {
            let err = write_request(
                &mut stream,
                &ControlRequest {
                    message_id,
                    payload: Vec::new(),
                },
            )
            .unwrap_err();

            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
            assert_eq!(err.to_string(), "invalid control message id length");
        }
    }

    #[test]
    fn response_rejects_invalid_message_id_and_large_diagnostic() {
        let (mut stream, _peer) = UnixStream::pair().unwrap();

        for message_id in ["".to_owned(), "x".repeat(MAX_MESSAGE_ID_BYTES + 1)] {
            let err = write_response(
                &mut stream,
                &ControlResponse {
                    message_id,
                    status: ControlResponseStatus::Accepted,
                    diagnostic: String::new(),
                },
            )
            .unwrap_err();

            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
            assert_eq!(err.to_string(), "invalid control message id length");
        }

        let err = write_response(
            &mut stream,
            &ControlResponse {
                message_id: "msg-1".to_owned(),
                status: ControlResponseStatus::Error,
                diagnostic: "x".repeat(MAX_DIAGNOSTIC_BYTES + 1),
            },
        )
        .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), "control diagnostic too large");
    }

    #[test]
    fn abstract_socket_rejects_invalid_names() {
        for name in ["", "bad\0name"] {
            let err = bind_abstract_listener(name).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

            let err = connect_abstract(name).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        }

        let too_long = "x".repeat(sockaddr_un_path_len());
        let err = bind_abstract_listener(&too_long).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let err = connect_abstract(&too_long).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn read_request_rejects_oversized_frame_before_body() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        a.write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
            .unwrap();

        let err = read_request(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "invalid control frame length");
    }

    #[test]
    fn read_request_rejects_wrong_frame_kind() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        write_frame(&mut a, FRAME_RESPONSE, &[]).unwrap();

        let err = read_request(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "expected control request frame");
    }

    #[test]
    fn read_request_rejects_wrong_frame_version() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let body = [FRAME_VERSION + 1, FRAME_REQUEST];
        a.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        a.write_all(&body).unwrap();

        let err = read_request(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "invalid control frame version");
    }

    #[test]
    fn read_request_rejects_trailing_bytes() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&5u16.to_be_bytes());
        payload.extend_from_slice(b"msg-1");
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.push(0);
        write_frame(&mut a, FRAME_REQUEST, &payload).unwrap();

        let err = read_request(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "control frame trailing bytes");
    }

    #[test]
    fn read_request_rejects_empty_and_invalid_utf8_message_id() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&0u16.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        write_frame(&mut a, FRAME_REQUEST, &payload).unwrap();

        let err = read_request(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "control request message id empty");

        let (mut a, mut b) = UnixStream::pair().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&1u16.to_be_bytes());
        payload.push(0xFF);
        payload.extend_from_slice(&0u32.to_be_bytes());
        write_frame(&mut a, FRAME_REQUEST, &payload).unwrap();

        let err = read_request(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "control request message id invalid utf-8");
    }

    #[test]
    fn read_response_rejects_unknown_status() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&5u16.to_be_bytes());
        payload.extend_from_slice(b"msg-1");
        payload.push(0xFF);
        payload.extend_from_slice(&0u16.to_be_bytes());
        write_frame(&mut a, FRAME_RESPONSE, &payload).unwrap();

        let err = read_response(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "invalid control response status");
    }

    #[test]
    fn read_response_rejects_large_and_invalid_utf8_diagnostic() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let diagnostic = "x".repeat(MAX_DIAGNOSTIC_BYTES + 1);
        let mut payload = Vec::new();
        payload.extend_from_slice(&5u16.to_be_bytes());
        payload.extend_from_slice(b"msg-1");
        payload.push(RESPONSE_ERROR);
        payload.extend_from_slice(&(diagnostic.len() as u16).to_be_bytes());
        payload.extend_from_slice(diagnostic.as_bytes());
        write_frame(&mut a, FRAME_RESPONSE, &payload).unwrap();

        let err = read_response(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "control response diagnostic too large");

        let (mut a, mut b) = UnixStream::pair().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&5u16.to_be_bytes());
        payload.extend_from_slice(b"msg-1");
        payload.push(RESPONSE_ERROR);
        payload.extend_from_slice(&1u16.to_be_bytes());
        payload.push(0xFF);
        write_frame(&mut a, FRAME_RESPONSE, &payload).unwrap();

        let err = read_response(&mut b).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "control response diagnostic invalid utf-8");
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
