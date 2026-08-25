//! Versioned binary responses for control-socket exec requests.
//!
//! Every payload starts with `VM0E`, a version byte, and a kind byte. A success
//! then carries a structured termination, truncation flags, three big-endian
//! lengths, and contiguous stdout, stderr, and UTF-8 diagnostic bytes. An error
//! carries one big-endian length followed by its UTF-8 message.

use std::io;

use sandbox::ExecTermination;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::protocol::{read_frame_payload_len, write_frame_payload_len};

pub(super) const RAW_EXEC_RESPONSE_VERSION: u8 = 1;

const RAW_EXEC_MAGIC: [u8; 4] = *b"VM0E";
const RAW_EXEC_KIND_SUCCESS: u8 = 0;
const RAW_EXEC_KIND_ERROR: u8 = 1;

const TERMINATION_EXITED: u8 = 0;
const TERMINATION_TIMED_OUT: u8 = 1;
const TERMINATION_CANCELLED: u8 = 2;
const TERMINATION_START_FAILED: u8 = 3;
const TERMINATION_WAIT_FAILED: u8 = 4;

const FLAG_STDOUT_TRUNCATED: u8 = 1 << 0;
const FLAG_STDERR_TRUNCATED: u8 = 1 << 1;
const KNOWN_FLAGS: u8 = FLAG_STDOUT_TRUNCATED | FLAG_STDERR_TRUNCATED;

const COMMON_HEADER_LEN: usize = RAW_EXEC_MAGIC.len() + 1 + 1;
const SUCCESS_LENGTH_FIELDS_LEN: usize = 4 + 4 + 4;
const ERROR_LENGTH_FIELD_LEN: usize = 4;

#[derive(Debug, Eq, PartialEq)]
pub(super) enum ExecResult {
    Success {
        termination: ExecTermination,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        stdout_truncated: bool,
        stderr_truncated: bool,
        diagnostic: String,
    },
    Error {
        error: String,
    },
}

pub(super) async fn write_raw_exec_response(
    stream: &mut UnixStream,
    response: &ExecResult,
) -> io::Result<()> {
    match response {
        ExecResult::Success {
            termination,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            diagnostic,
        } => {
            let stdout_len = wire_len("stdout", stdout.len())?;
            let stderr_len = wire_len("stderr", stderr.len())?;
            let diagnostic_len = wire_len("diagnostic", diagnostic.len())?;
            let header_len = COMMON_HEADER_LEN
                .checked_add(termination_wire_len(*termination))
                .and_then(|len| len.checked_add(1 + SUCCESS_LENGTH_FIELDS_LEN))
                .ok_or_else(|| invalid_data("raw exec success header length overflowed"))?;
            let payload_len =
                checked_payload_len(header_len, &[stdout.len(), stderr.len(), diagnostic.len()])?;

            let mut header = Vec::with_capacity(header_len);
            append_common_header(&mut header, RAW_EXEC_KIND_SUCCESS);
            append_termination(&mut header, *termination);
            header.push(
                (u8::from(*stdout_truncated) * FLAG_STDOUT_TRUNCATED)
                    | (u8::from(*stderr_truncated) * FLAG_STDERR_TRUNCATED),
            );
            header.extend_from_slice(&stdout_len.to_be_bytes());
            header.extend_from_slice(&stderr_len.to_be_bytes());
            header.extend_from_slice(&diagnostic_len.to_be_bytes());

            write_frame_payload_len(stream, payload_len).await?;
            stream.write_all(&header).await?;
            stream.write_all(stdout).await?;
            stream.write_all(stderr).await?;
            stream.write_all(diagnostic.as_bytes()).await?;
        }
        ExecResult::Error { error } => {
            let error_len = wire_len("error", error.len())?;
            let header_len = COMMON_HEADER_LEN + ERROR_LENGTH_FIELD_LEN;
            let payload_len = checked_payload_len(header_len, &[error.len()])?;

            let mut header = Vec::with_capacity(header_len);
            append_common_header(&mut header, RAW_EXEC_KIND_ERROR);
            header.extend_from_slice(&error_len.to_be_bytes());

            write_frame_payload_len(stream, payload_len).await?;
            stream.write_all(&header).await?;
            stream.write_all(error.as_bytes()).await?;
        }
    }

    stream.flush().await
}

pub(super) async fn read_raw_exec_response(stream: &mut UnixStream) -> io::Result<ExecResult> {
    let payload_len = read_frame_payload_len(stream).await?;
    let mut reader = RawFrameReader::new(stream, payload_len);

    let magic = reader.read_array::<4>().await?;
    if magic != RAW_EXEC_MAGIC {
        return Err(invalid_data("invalid raw exec response magic"));
    }

    let version = reader.read_u8().await?;
    if version != RAW_EXEC_RESPONSE_VERSION {
        return Err(invalid_data(format!(
            "unsupported raw exec response version: {version}"
        )));
    }

    match reader.read_u8().await? {
        RAW_EXEC_KIND_SUCCESS => read_raw_success(&mut reader).await,
        RAW_EXEC_KIND_ERROR => read_raw_error(&mut reader).await,
        kind => Err(invalid_data(format!(
            "unknown raw exec response kind: {kind}"
        ))),
    }
}

async fn read_raw_success(reader: &mut RawFrameReader<'_>) -> io::Result<ExecResult> {
    let termination = read_termination(reader).await?;
    let flags = reader.read_u8().await?;
    if flags & !KNOWN_FLAGS != 0 {
        return Err(invalid_data(format!(
            "unknown raw exec response flags: {flags:#04x}"
        )));
    }

    let stdout_len = reader.read_u32().await? as usize;
    let stderr_len = reader.read_u32().await? as usize;
    let diagnostic_len = reader.read_u32().await? as usize;
    let body_len = checked_payload_len(0, &[stdout_len, stderr_len, diagnostic_len])?;
    if reader.remaining() != body_len {
        return Err(invalid_data(format!(
            "raw exec success lengths declare {body_len} bytes with {} bytes remaining",
            reader.remaining()
        )));
    }

    let stdout = reader.read_vec(stdout_len).await?;
    let stderr = reader.read_vec(stderr_len).await?;
    let diagnostic = String::from_utf8(reader.read_vec(diagnostic_len).await?)
        .map_err(|error| invalid_data(format!("raw exec diagnostic is not UTF-8: {error}")))?;

    Ok(ExecResult::Success {
        termination,
        stdout,
        stderr,
        stdout_truncated: flags & FLAG_STDOUT_TRUNCATED != 0,
        stderr_truncated: flags & FLAG_STDERR_TRUNCATED != 0,
        diagnostic,
    })
}

async fn read_raw_error(reader: &mut RawFrameReader<'_>) -> io::Result<ExecResult> {
    let error_len = reader.read_u32().await? as usize;
    if reader.remaining() != error_len {
        return Err(invalid_data(format!(
            "raw exec error length declares {error_len} bytes with {} bytes remaining",
            reader.remaining()
        )));
    }

    let error = String::from_utf8(reader.read_vec(error_len).await?)
        .map_err(|error| invalid_data(format!("raw exec error is not UTF-8: {error}")))?;
    Ok(ExecResult::Error { error })
}

async fn read_termination(reader: &mut RawFrameReader<'_>) -> io::Result<ExecTermination> {
    match reader.read_u8().await? {
        TERMINATION_EXITED => Ok(ExecTermination::Exited {
            exit_code: i32::from_be_bytes(reader.read_array::<4>().await?),
        }),
        TERMINATION_TIMED_OUT => Ok(ExecTermination::TimedOut),
        TERMINATION_CANCELLED => Ok(ExecTermination::Cancelled),
        TERMINATION_START_FAILED => Ok(ExecTermination::StartFailed),
        TERMINATION_WAIT_FAILED => Ok(ExecTermination::WaitFailed),
        termination => Err(invalid_data(format!(
            "unknown raw exec termination: {termination}"
        ))),
    }
}

fn append_common_header(header: &mut Vec<u8>, kind: u8) {
    header.extend_from_slice(&RAW_EXEC_MAGIC);
    header.push(RAW_EXEC_RESPONSE_VERSION);
    header.push(kind);
}

fn termination_wire_len(termination: ExecTermination) -> usize {
    match termination {
        ExecTermination::Exited { .. } => 5,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => 1,
    }
}

fn append_termination(header: &mut Vec<u8>, termination: ExecTermination) {
    match termination {
        ExecTermination::Exited { exit_code } => {
            header.push(TERMINATION_EXITED);
            header.extend_from_slice(&exit_code.to_be_bytes());
        }
        ExecTermination::TimedOut => header.push(TERMINATION_TIMED_OUT),
        ExecTermination::Cancelled => header.push(TERMINATION_CANCELLED),
        ExecTermination::StartFailed => header.push(TERMINATION_START_FAILED),
        ExecTermination::WaitFailed => header.push(TERMINATION_WAIT_FAILED),
    }
}

fn wire_len(field: &'static str, len: usize) -> io::Result<u32> {
    u32::try_from(len)
        .map_err(|_| invalid_data(format!("raw exec {field} is too large: {len} bytes")))
}

fn checked_payload_len(header_len: usize, fields: &[usize]) -> io::Result<usize> {
    fields.iter().try_fold(header_len, |len, field_len| {
        len.checked_add(*field_len)
            .ok_or_else(|| invalid_data("raw exec response length overflowed"))
    })
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

struct RawFrameReader<'a> {
    stream: &'a mut UnixStream,
    remaining: usize,
}

impl<'a> RawFrameReader<'a> {
    fn new(stream: &'a mut UnixStream, remaining: usize) -> Self {
        Self { stream, remaining }
    }

    fn remaining(&self) -> usize {
        self.remaining
    }

    async fn read_u8(&mut self) -> io::Result<u8> {
        Ok(self.read_array::<1>().await?[0])
    }

    async fn read_u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_be_bytes(self.read_array::<4>().await?))
    }

    async fn read_array<const N: usize>(&mut self) -> io::Result<[u8; N]> {
        self.reserve(N)?;
        let mut bytes = [0; N];
        self.stream.read_exact(&mut bytes).await?;
        Ok(bytes)
    }

    async fn read_vec(&mut self, len: usize) -> io::Result<Vec<u8>> {
        self.reserve(len)?;
        let mut bytes = vec![0; len];
        self.stream.read_exact(&mut bytes).await?;
        Ok(bytes)
    }

    fn reserve(&mut self, len: usize) -> io::Result<()> {
        self.remaining = self.remaining.checked_sub(len).ok_or_else(|| {
            invalid_data(format!(
                "raw exec response needs {len} bytes with only {} remaining",
                self.remaining
            ))
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sandbox::EXEC_OUTPUT_LIMIT_7_MIB;

    use super::super::protocol::MAX_FRAME_PAYLOAD_SIZE;
    use super::*;

    async fn round_trip(response: ExecResult) {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let write = tokio::spawn(async move {
            write_raw_exec_response(&mut writer, &response)
                .await
                .unwrap();
            response
        });

        let decoded = read_raw_exec_response(&mut reader).await.unwrap();
        let expected = write.await.unwrap();
        assert_eq!(decoded, expected);
    }

    async fn encoded_payload(response: ExecResult) -> Vec<u8> {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let write = tokio::spawn(async move {
            write_raw_exec_response(&mut writer, &response)
                .await
                .unwrap();
        });

        let len = reader.read_u32().await.unwrap() as usize;
        let mut payload = vec![0; len];
        reader.read_exact(&mut payload).await.unwrap();
        write.await.unwrap();
        payload
    }

    async fn decode_payload(payload: &[u8]) -> io::Result<ExecResult> {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let payload = payload.to_vec();
        let write = tokio::spawn(async move {
            writer.write_u32(payload.len() as u32).await.unwrap();
            writer.write_all(&payload).await.unwrap();
        });

        let result = read_raw_exec_response(&mut reader).await;
        write.await.unwrap();
        result
    }

    fn success_payload() -> Vec<u8> {
        let mut payload = Vec::new();
        append_common_header(&mut payload, RAW_EXEC_KIND_SUCCESS);
        append_termination(&mut payload, ExecTermination::Exited { exit_code: 7 });
        payload.push(FLAG_STDOUT_TRUNCATED);
        payload.extend_from_slice(&3u32.to_be_bytes());
        payload.extend_from_slice(&2u32.to_be_bytes());
        payload.extend_from_slice(&4u32.to_be_bytes());
        payload.extend_from_slice(b"out");
        payload.extend_from_slice(b"er");
        payload.extend_from_slice(b"diag");
        payload
    }

    #[tokio::test]
    async fn raw_exec_success_round_trips_all_terminal_shapes() {
        for termination in [
            ExecTermination::Exited { exit_code: -17 },
            ExecTermination::TimedOut,
            ExecTermination::Cancelled,
            ExecTermination::StartFailed,
            ExecTermination::WaitFailed,
        ] {
            round_trip(ExecResult::Success {
                termination,
                stdout: vec![0, 0xff, b'\n'],
                stderr: b"stderr".to_vec(),
                stdout_truncated: true,
                stderr_truncated: true,
                diagnostic: "diagnostic 边界".into(),
            })
            .await;
        }
    }

    #[tokio::test]
    async fn raw_exec_error_round_trips() {
        round_trip(ExecResult::Error {
            error: "sandbox unavailable 边界".into(),
        })
        .await;
    }

    #[tokio::test]
    async fn maximum_control_capture_avoids_base64_wire_expansion() {
        let stdout_len = EXEC_OUTPUT_LIMIT_7_MIB.stdout_limit_bytes as usize;
        let stderr_len = EXEC_OUTPUT_LIMIT_7_MIB.stderr_limit_bytes as usize;
        let payload = encoded_payload(ExecResult::Success {
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout: vec![b'o'; stdout_len],
            stderr: vec![b'e'; stderr_len],
            stdout_truncated: true,
            stderr_truncated: true,
            diagnostic: String::new(),
        })
        .await;

        assert_eq!(payload.len(), 24 + stdout_len + stderr_len);
        let base64_len = stdout_len.div_ceil(3) * 4 + stderr_len.div_ceil(3) * 4;
        assert!(payload.len() < base64_len);
    }

    #[tokio::test]
    async fn raw_exec_reader_rejects_invalid_header_fields() {
        let valid = success_payload();
        for (offset, value, expected) in [
            (0, b'X', "magic"),
            (4, RAW_EXEC_RESPONSE_VERSION + 1, "version"),
            (5, 0xff, "kind"),
            (6, 0xff, "termination"),
            (11, 0x80, "flags"),
        ] {
            let mut malformed = valid.clone();
            malformed[offset] = value;
            let error = decode_payload(&malformed).await.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[tokio::test]
    async fn raw_exec_reader_rejects_inconsistent_lengths_and_trailing_bytes() {
        let mut inconsistent = success_payload();
        inconsistent[12..16].copy_from_slice(&4u32.to_be_bytes());
        let error = decode_payload(&inconsistent).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("lengths declare"));

        let mut trailing = success_payload();
        trailing.push(0);
        let error = decode_payload(&trailing).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("lengths declare"));
    }

    #[tokio::test]
    async fn raw_exec_reader_rejects_invalid_utf8() {
        let mut success = success_payload();
        *success.last_mut().unwrap() = 0xff;
        let error = decode_payload(&success).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("diagnostic is not UTF-8"));

        let mut error_payload = Vec::new();
        append_common_header(&mut error_payload, RAW_EXEC_KIND_ERROR);
        error_payload.extend_from_slice(&1u32.to_be_bytes());
        error_payload.push(0xff);
        let error = decode_payload(&error_payload).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("error is not UTF-8"));
    }

    #[tokio::test]
    async fn raw_exec_reader_preserves_truncated_transport_error() {
        let payload = success_payload();
        let declared_len = payload.len();
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let write = tokio::spawn(async move {
            writer.write_u32(declared_len as u32).await.unwrap();
            writer
                .write_all(&payload[..payload.len() - 1])
                .await
                .unwrap();
        });

        let error = read_raw_exec_response(&mut reader).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        write.await.unwrap();
    }

    #[tokio::test]
    async fn raw_exec_reader_rejects_oversized_frame_before_payload_read() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_u32(MAX_FRAME_PAYLOAD_SIZE + 1).await.unwrap();

        let error = read_raw_exec_response(&mut reader).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("frame too large"));
    }
}
