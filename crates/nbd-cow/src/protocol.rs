//! NBD transmission protocol constants and types.
//!
//! When using netlink + socketpair, no handshake is needed.
//! The kernel NBD client communicates directly using the transmission protocol.

use std::io::{Cursor, Read, Write};

/// Magic number in every NBD request (client -> server).
pub const REQUEST_MAGIC: u32 = 0x2560_9513;

/// Magic number in every NBD reply (server -> client).
pub const REPLY_MAGIC: u32 = 0x6744_6698;

/// Size of the request header in bytes (excluding payload).
pub const REQUEST_HEADER_SIZE: usize = 28;

/// Size of the reply header in bytes (excluding payload).
pub const REPLY_HEADER_SIZE: usize = 16;

/// NBD command types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum Command {
    Read = 0,
    Write = 1,
    Disconnect = 2,
    Flush = 3,
    Trim = 4,
}

impl Command {
    pub fn from_u16(val: u16) -> Result<Self, ProtocolError> {
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
pub struct NbdRequest {
    /// Per-command flags bitmask (e.g. `NBD_CMD_FLAG_FUA = 0x0001`).
    pub flags: u16,
    /// Decoded command type. The wire encoding is `u16`; see [`Command`].
    pub command: Command,
    /// Opaque request identifier echoed back in [`NbdReply::handle`]. The
    /// dispatcher uses this to correlate replies with in-flight requests;
    /// the server does not interpret the value.
    pub handle: u64,
    /// Byte offset into the device where the operation applies (Read /
    /// Write / Trim). Ignored for Flush and Disconnect.
    pub offset: u64,
    /// Payload length in bytes. Requests exceeding the server's
    /// `MAX_REQUEST_LENGTH` (see `server.rs`) are rejected with `EIO`.
    pub length: u32,
}

/// NBD reply header (16 bytes, server -> client).
#[derive(Debug, Clone)]
pub struct NbdReply {
    /// NBD error code: `0` means success; a non-zero value is an errno
    /// the kernel maps back to the originating I/O (e.g. `libc::EIO`).
    pub error: u32,
    /// Echoes [`NbdRequest::handle`] from the originating request so the
    /// client can match this reply to the pending operation.
    pub handle: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("invalid request magic: expected {REQUEST_MAGIC:#x}, got {0:#x}")]
    InvalidRequestMagic(u32),

    #[error("unknown NBD command: {0}")]
    UnknownCommand(u16),

    #[error("buffer too short: need {expected} bytes, got {actual}")]
    BufferTooShort { expected: usize, actual: usize },
}

/// Parse a 28-byte NBD request header.
pub fn parse_request(buf: &[u8]) -> Result<NbdRequest, ProtocolError> {
    if buf.len() < REQUEST_HEADER_SIZE {
        return Err(ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        });
    }

    let mut cursor = Cursor::new(buf);
    let mut b4 = [0u8; 4];
    let mut b2 = [0u8; 2];
    let mut b8 = [0u8; 8];

    // We already checked buf.len() >= 28, so all reads will succeed.
    let _: () = cursor
        .read_exact(&mut b4)
        .map_err(|_| ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;
    let magic = u32::from_be_bytes(b4);
    if magic != REQUEST_MAGIC {
        return Err(ProtocolError::InvalidRequestMagic(magic));
    }

    let _: () = cursor
        .read_exact(&mut b2)
        .map_err(|_| ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;
    let flags = u16::from_be_bytes(b2);

    let _: () = cursor
        .read_exact(&mut b2)
        .map_err(|_| ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;
    let cmd_type = u16::from_be_bytes(b2);
    let command = Command::from_u16(cmd_type)?;

    let _: () = cursor
        .read_exact(&mut b8)
        .map_err(|_| ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;
    let handle = u64::from_be_bytes(b8);

    let _: () = cursor
        .read_exact(&mut b8)
        .map_err(|_| ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;
    let offset = u64::from_be_bytes(b8);

    let _: () = cursor
        .read_exact(&mut b4)
        .map_err(|_| ProtocolError::BufferTooShort {
            expected: REQUEST_HEADER_SIZE,
            actual: buf.len(),
        })?;
    let length = u32::from_be_bytes(b4);

    Ok(NbdRequest {
        flags,
        command,
        handle,
        offset,
        length,
    })
}

/// Serialize a 16-byte NBD reply header.
pub fn serialize_reply(reply: &NbdReply) -> [u8; REPLY_HEADER_SIZE] {
    let mut buf = [0u8; REPLY_HEADER_SIZE];
    let mut cursor = Cursor::new(buf.as_mut_slice());
    // All writes fit within the 16-byte buffer, so write_all cannot fail.
    let _ = cursor.write_all(&REPLY_MAGIC.to_be_bytes());
    let _ = cursor.write_all(&reply.error.to_be_bytes());
    let _ = cursor.write_all(&reply.handle.to_be_bytes());
    buf
}

/// Serialize a 28-byte NBD request header (for testing).
#[cfg(test)]
pub(crate) fn serialize_request(req: &NbdRequest) -> [u8; REQUEST_HEADER_SIZE] {
    let mut buf = [0u8; REQUEST_HEADER_SIZE];
    let mut cursor = Cursor::new(buf.as_mut_slice());
    // All writes fit within the 28-byte buffer, so write_all cannot fail.
    let _ = cursor.write_all(&REQUEST_MAGIC.to_be_bytes());
    let _ = cursor.write_all(&req.flags.to_be_bytes());
    let _ = cursor.write_all(&(req.command as u16).to_be_bytes());
    let _ = cursor.write_all(&req.handle.to_be_bytes());
    let _ = cursor.write_all(&req.offset.to_be_bytes());
    let _ = cursor.write_all(&req.length.to_be_bytes());
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_request() {
        let req = NbdRequest {
            flags: 0,
            command: Command::Write,
            handle: 0xDEAD_BEEF_CAFE_BABE,
            offset: 4096,
            length: 512,
        };

        let buf = serialize_request(&req);
        let parsed = parse_request(&buf).unwrap();

        assert_eq!(parsed.flags, req.flags);
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
                flags: 0,
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
            flags: 0,
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
    fn round_trip_request_with_flags() {
        let req = NbdRequest {
            flags: 0x0001, // FUA
            command: Command::Write,
            handle: 42,
            offset: 8192,
            length: 1024,
        };
        let buf = serialize_request(&req);
        let parsed = parse_request(&buf).unwrap();
        assert_eq!(parsed.flags, 0x0001);
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
