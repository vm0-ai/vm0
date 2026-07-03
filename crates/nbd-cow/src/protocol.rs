//! NBD transmission protocol constants and types.
//!
//! When using netlink + socketpair, no handshake is needed.
//! The kernel NBD client communicates directly using the transmission protocol.

/// Magic number in every NBD request (client -> server).
pub(crate) const REQUEST_MAGIC: u32 = 0x2560_9513;

/// Magic number in every NBD reply (server -> client).
pub(crate) const REPLY_MAGIC: u32 = 0x6744_6698;

/// Size of the request header in bytes (excluding payload).
pub(crate) const REQUEST_HEADER_SIZE: usize = 28;

/// Size of the reply header in bytes (excluding payload).
pub(crate) const REPLY_HEADER_SIZE: usize = 16;

const REQUEST_MAGIC_OFFSET: usize = 0;
#[cfg(test)]
const REQUEST_FLAGS_OFFSET: usize = 4;
const REQUEST_COMMAND_OFFSET: usize = 6;
const REQUEST_HANDLE_OFFSET: usize = 8;
const REQUEST_OFFSET_FIELD_OFFSET: usize = 16;
const REQUEST_LENGTH_OFFSET: usize = 24;

const REPLY_MAGIC_OFFSET: usize = 0;
const REPLY_ERROR_OFFSET: usize = 4;
const REPLY_HANDLE_OFFSET: usize = 8;

/// NBD command types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub(crate) enum Command {
    Read = 0,
    Write = 1,
    Disconnect = 2,
    Flush = 3,
    Trim = 4,
}

impl Command {
    pub(crate) fn from_u16(val: u16) -> Result<Self, ProtocolError> {
        match val {
            0 => Ok(Self::Read),
            1 => Ok(Self::Write),
            2 => Ok(Self::Disconnect),
            3 => Ok(Self::Flush),
            4 => Ok(Self::Trim),
            other => Err(ProtocolError::UnknownCommand(other)),
        }
    }
}

/// NBD request header (28 bytes, client -> server).
#[derive(Debug, Clone)]
pub(crate) struct NbdRequest {
    /// Decoded command type. The wire encoding is `u16`; see [`Command`].
    pub(crate) command: Command,
    /// Opaque request identifier echoed back in [`NbdReply::handle`]. The
    /// dispatcher uses this to correlate replies with in-flight requests;
    /// the server does not interpret the value.
    pub(crate) handle: u64,
    /// Byte offset into the device where the operation applies (Read /
    /// Write / Trim). Ignored for Flush and Disconnect.
    pub(crate) offset: u64,
    /// Payload length in bytes. Requests exceeding the server's
    /// `MAX_REQUEST_LENGTH` (see `server.rs`) are rejected with `EIO`.
    pub(crate) length: u32,
}

/// NBD reply header (16 bytes, server -> client).
#[derive(Debug, Clone)]
pub(crate) struct NbdReply {
    /// NBD error code: `0` means success; a non-zero value is an errno
    /// the kernel maps back to the originating I/O (e.g. `libc::EIO`).
    pub(crate) error: u32,
    /// Echoes [`NbdRequest::handle`] from the originating request so the
    /// client can match this reply to the pending operation.
    pub(crate) handle: u64,
}

/// Errors returned while decoding fixed-size NBD transmission headers.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// The request header magic field did not match the NBD request magic.
    ///
    /// The payload is the invalid big-endian `u32` value read from the first
    /// four bytes of the request header.
    #[error("invalid request magic: expected {REQUEST_MAGIC:#x}, got {0:#x}")]
    InvalidRequestMagic(u32),

    /// The request command field contained an unsupported NBD command value.
    ///
    /// The payload is the raw big-endian `u16` command value from the request
    /// header. Supported values are `0` through `4`.
    #[error("unknown NBD command: {0}")]
    UnknownCommand(u16),

    /// The input buffer was too short to contain a complete request header.
    ///
    /// `expected` is the fixed NBD request header size and `actual` is the
    /// number of bytes provided by the caller.
    #[error("buffer too short: need {expected} bytes, got {actual}")]
    BufferTooShort { expected: usize, actual: usize },
}

fn read_bytes<const N: usize>(buf: &[u8], offset: usize) -> [u8; N] {
    let mut bytes = [0u8; N];
    let copied = if let Some(slice) = offset.checked_add(N).and_then(|end| buf.get(offset..end)) {
        bytes.copy_from_slice(slice);
        true
    } else {
        false
    };
    assert!(copied, "NBD field offset must fit fixed header");
    bytes
}

fn read_u16(buf: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes(read_bytes(buf, offset))
}

fn read_u32(buf: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(read_bytes(buf, offset))
}

fn read_u64(buf: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(read_bytes(buf, offset))
}

#[cfg(test)]
fn write_u16(buf: &mut [u8], offset: usize, value: u16) {
    write_bytes(buf, offset, value.to_be_bytes());
}

fn write_u32(buf: &mut [u8], offset: usize, value: u32) {
    write_bytes(buf, offset, value.to_be_bytes());
}

fn write_u64(buf: &mut [u8], offset: usize, value: u64) {
    write_bytes(buf, offset, value.to_be_bytes());
}

fn write_bytes<const N: usize>(buf: &mut [u8], offset: usize, bytes: [u8; N]) {
    let copied = if let Some(dest) = offset
        .checked_add(N)
        .and_then(|end| buf.get_mut(offset..end))
    {
        dest.copy_from_slice(&bytes);
        true
    } else {
        false
    };
    assert!(copied, "NBD field offset must fit fixed header");
}

/// Parse a 28-byte NBD request header.
pub(crate) fn parse_request(buf: &[u8]) -> Result<NbdRequest, ProtocolError> {
    let header = buf
        .get(..REQUEST_HEADER_SIZE)
        .ok_or(ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;

    let magic = read_u32(header, REQUEST_MAGIC_OFFSET);
    if magic != REQUEST_MAGIC {
        return Err(ProtocolError::InvalidRequestMagic(magic));
    }

    let cmd_type = read_u16(header, REQUEST_COMMAND_OFFSET);
    let command = Command::from_u16(cmd_type)?;
    let handle = read_u64(header, REQUEST_HANDLE_OFFSET);
    let offset = read_u64(header, REQUEST_OFFSET_FIELD_OFFSET);
    let length = read_u32(header, REQUEST_LENGTH_OFFSET);

    Ok(NbdRequest {
        command,
        handle,
        offset,
        length,
    })
}

/// Serialize a 16-byte NBD reply header.
pub(crate) fn serialize_reply(reply: &NbdReply) -> [u8; REPLY_HEADER_SIZE] {
    let mut buf = [0u8; REPLY_HEADER_SIZE];
    write_u32(&mut buf, REPLY_MAGIC_OFFSET, REPLY_MAGIC);
    write_u32(&mut buf, REPLY_ERROR_OFFSET, reply.error);
    write_u64(&mut buf, REPLY_HANDLE_OFFSET, reply.handle);
    buf
}

/// Serialize a 28-byte NBD request header (for testing).
#[cfg(test)]
pub(crate) fn serialize_request(req: &NbdRequest) -> [u8; REQUEST_HEADER_SIZE] {
    let mut buf = [0u8; REQUEST_HEADER_SIZE];
    write_u32(&mut buf, REQUEST_MAGIC_OFFSET, REQUEST_MAGIC);
    write_u16(&mut buf, REQUEST_COMMAND_OFFSET, req.command as u16);
    write_u64(&mut buf, REQUEST_HANDLE_OFFSET, req.handle);
    write_u64(&mut buf, REQUEST_OFFSET_FIELD_OFFSET, req.offset);
    write_u32(&mut buf, REQUEST_LENGTH_OFFSET, req.length);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_request() {
        let req = NbdRequest {
            command: Command::Write,
            handle: 0xDEAD_BEEF_CAFE_BABE,
            offset: 4096,
            length: 512,
        };

        let buf = serialize_request(&req);
        let parsed = parse_request(&buf).unwrap();
        assert_eq!(parsed.command, req.command);
        assert_eq!(parsed.handle, req.handle);
        assert_eq!(parsed.offset, req.offset);
        assert_eq!(parsed.length, req.length);
    }

    #[test]
    fn parse_request_ignores_trailing_bytes() {
        let req = NbdRequest {
            command: Command::Trim,
            handle: 0xCAFE_BABE_DEAD_BEEF,
            offset: 16_384,
            length: 4096,
        };

        let mut buf = serialize_request(&req).to_vec();
        buf.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);

        let parsed = parse_request(&buf).unwrap();
        assert_eq!(parsed.command, req.command);
        assert_eq!(parsed.handle, req.handle);
        assert_eq!(parsed.offset, req.offset);
        assert_eq!(parsed.length, req.length);
    }

    #[test]
    fn round_trip_reply() {
        let reply = NbdReply {
            error: 0,
            handle: 0x1234_5678_9ABC_DEF0,
        };

        let buf = serialize_reply(&reply);

        assert_eq!(
            u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]),
            REPLY_MAGIC
        );
        assert_eq!(u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]), 0);
        assert_eq!(
            u64::from_be_bytes([
                buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
            ]),
            0x1234_5678_9ABC_DEF0
        );
    }

    #[test]
    fn parse_all_commands() {
        for (cmd, val) in [
            (Command::Read, 0u16),
            (Command::Write, 1),
            (Command::Disconnect, 2),
            (Command::Flush, 3),
            (Command::Trim, 4),
        ] {
            let req = NbdRequest {
                command: cmd,
                handle: 1,
                offset: 0,
                length: 0,
            };
            let buf = serialize_request(&req);
            let parsed = parse_request(&buf).unwrap();
            assert_eq!(parsed.command, cmd);
            assert_eq!(parsed.command as u16, val);
        }
    }

    #[test]
    fn invalid_magic() {
        let mut buf = [0u8; REQUEST_HEADER_SIZE];
        buf[0..4].copy_from_slice(&0xBAD_0000u32.to_be_bytes());

        let err = parse_request(&buf).unwrap_err();
        assert!(matches!(err, ProtocolError::InvalidRequestMagic(_)));
    }

    #[test]
    fn unknown_command() {
        let req = NbdRequest {
            command: Command::Read,
            handle: 0,
            offset: 0,
            length: 0,
        };
        let mut buf = serialize_request(&req);
        // Overwrite command with invalid value
        buf[6..8].copy_from_slice(&99u16.to_be_bytes());

        let err = parse_request(&buf).unwrap_err();
        assert!(matches!(err, ProtocolError::UnknownCommand(99)));
    }

    #[test]
    fn buffer_too_short() {
        let buf = [0u8; 10];
        let err = parse_request(&buf).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::BufferTooShort {
                expected: 28,
                actual: 10
            }
        ));
    }

    #[test]
    fn empty_buffer() {
        let err = parse_request(&[]).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::BufferTooShort {
                expected: 28,
                actual: 0
            }
        ));
    }

    #[test]
    fn error_display_invalid_magic() {
        let err = ProtocolError::InvalidRequestMagic(0xBAD);
        let msg = err.to_string();
        assert!(msg.contains("invalid request magic"), "got: {msg}");
    }

    #[test]
    fn error_display_unknown_command() {
        let err = ProtocolError::UnknownCommand(99);
        let msg = err.to_string();
        assert!(msg.contains("unknown NBD command"), "got: {msg}");
        assert!(msg.contains("99"), "got: {msg}");
    }

    #[test]
    fn error_display_buffer_too_short() {
        let err = ProtocolError::BufferTooShort {
            expected: 28,
            actual: 10,
        };
        let msg = err.to_string();
        assert!(msg.contains("28") && msg.contains("10"), "got: {msg}");
    }

    #[test]
    fn round_trip_reply_with_error() {
        let reply = NbdReply {
            error: 5, // EIO
            handle: 0xAAAA_BBBB_CCCC_DDDD,
        };
        let buf = serialize_reply(&reply);
        assert_eq!(
            u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]),
            REPLY_MAGIC
        );
        assert_eq!(u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]), 5);
        assert_eq!(
            u64::from_be_bytes([
                buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
            ]),
            0xAAAA_BBBB_CCCC_DDDD
        );
    }

    #[test]
    fn parse_request_ignores_flags() {
        let req = NbdRequest {
            command: Command::Write,
            handle: 42,
            offset: 8192,
            length: 1024,
        };
        let mut buf = serialize_request(&req);
        write_u16(&mut buf, REQUEST_FLAGS_OFFSET, 0x0001);

        let parsed = parse_request(&buf).unwrap();
        assert_eq!(parsed.command, Command::Write);
        assert_eq!(parsed.handle, 42);
        assert_eq!(parsed.offset, 8192);
        assert_eq!(parsed.length, 1024);
    }

    #[test]
    fn command_from_u16_boundary_values() {
        assert!(Command::from_u16(0).is_ok());
        assert!(Command::from_u16(4).is_ok());
        assert!(Command::from_u16(5).is_err());
        assert!(Command::from_u16(u16::MAX).is_err());
    }
}
