use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;

use crate::{
    ControlRequest, ControlResponse, ControlResponseStatus, MAX_CONTROL_PAYLOAD_BYTES,
    MAX_DIAGNOSTIC_BYTES,
};

const MAX_MESSAGE_ID_BYTES: usize = u16::MAX as usize;
const MAX_FRAME_BYTES: usize = 1 + 1 + 2 + MAX_MESSAGE_ID_BYTES + 4 + MAX_CONTROL_PAYLOAD_BYTES;
const FRAME_VERSION: u8 = 1;

const FRAME_HELLO: u8 = 0x01;
const FRAME_REQUEST: u8 = 0x02;
const FRAME_RESPONSE: u8 = 0x03;

const RESPONSE_ACCEPTED: u8 = 0x00;
const RESPONSE_REJECTED: u8 = 0x01;
const RESPONSE_ERROR: u8 = 0x02;

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
/// fit in `u16`, or the payload exceeds [`crate::MAX_CONTROL_PAYLOAD_BYTES`].
/// Stream write failures are returned as standard library `io::Error` values.
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
/// [`crate::MAX_CONTROL_PAYLOAD_BYTES`]. Stream read failures are returned as
/// standard library `io::Error` values.
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
/// fit in `u16`, or the diagnostic exceeds [`crate::MAX_DIAGNOSTIC_BYTES`].
/// Stream write failures are returned as standard library `io::Error` values.
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
/// a diagnostic larger than [`crate::MAX_DIAGNOSTIC_BYTES`]. Stream read
/// failures are returned as standard library `io::Error` values.
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
    use std::io::{self, Write};
    use std::os::unix::net::UnixStream;

    use super::*;

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
}
