//! Secret-free, one-request SSH transport. This is not an SSH implementation.
//!
//! Each wire frame is a big-endian u32 length followed by strict JSON. Bounds
//! are checked before allocating the body. Output uses base64 so the same
//! validated response can be emitted as NDJSON by the guest helper.

use std::io;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

pub const VERSION: u16 = 1;
pub const VSOCK_PORT: u32 = 52001;
pub const HOST_CID: u32 = 2;
pub const MAX_COMMAND_BYTES: usize = 64 * 1024;
pub const MAX_CHUNK_BYTES: usize = 16 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// Includes the worst-case JSON escaping of every command byte.
pub const MAX_REQUEST_BYTES: usize = MAX_COMMAND_BYTES * 6 + 256;
pub const MAX_RESPONSE_BYTES: usize = 24 * 1024;

/// The guest cannot supply host, credential, or Run/Runner identity fields.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u16,
    pub ssh_connection_id: Uuid,
    pub command: String,
}

impl Request {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != VERSION
            || self.ssh_connection_id.is_nil()
            || self.command.is_empty()
            || self.command.len() > MAX_COMMAND_BYTES
        {
            return Err(invalid("invalid SSH request"));
        }
        Ok(())
    }
}

pub fn parse_request(bytes: &[u8]) -> io::Result<Request> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(invalid("SSH request too large"));
    }
    let request: Request = parse(bytes)?;
    request.validate()?;
    Ok(request)
}

pub async fn read_request(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Request> {
    let bytes = read_frame(reader, MAX_REQUEST_BYTES)
        .await?
        .ok_or_else(|| invalid("missing SSH request"))?;
    let request = parse_request(&bytes)?;
    let mut trailing = [0u8; 1];
    if reader.read(&mut trailing).await? != 0 {
        return Err(invalid("trailing SSH request data"));
    }
    Ok(request)
}

pub async fn write_request(
    writer: &mut (impl AsyncWrite + Unpin),
    request: &Request,
) -> io::Result<()> {
    request.validate()?;
    write_frame(writer, request, MAX_REQUEST_BYTES).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unavailable,
    InvalidRequest,
    Protocol,
    TimedOut,
    Transport,
}

/// No acceptance observed is NOT proof that the remote command did not start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    NotStarted,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExitStatus {
    Exit { code: u32 },
    Signal { name: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    /// The handler has observed SSH exec-success, not merely a connected socket.
    /// An empty struct (not unit) variant makes serde reject unknown fields.
    Accepted {},
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    Finished {
        status: ExitStatus,
        stdout_truncated: bool,
        stderr_truncated: bool,
    },
    Error {
        code: ErrorCode,
        effect: Effect,
        stdout_truncated: bool,
        stderr_truncated: bool,
    },
}

impl Response {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Finished { .. } | Self::Error { .. })
    }

    pub fn error(code: ErrorCode, effect: Effect) -> Self {
        Self::Error {
            code,
            effect,
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }
}

/// Encode one bounded binary output chunk (empty chunks are not frames).
pub fn encode_output(bytes: &[u8]) -> io::Result<String> {
    if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
        return Err(invalid("invalid SSH output chunk size"));
    }
    Ok(STANDARD.encode(bytes))
}

pub fn decode_output(data: &str) -> io::Result<Vec<u8>> {
    if data.is_empty() || data.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(invalid("invalid SSH output chunk size"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| invalid("invalid SSH output encoding"))?;
    if bytes.len() > MAX_CHUNK_BYTES {
        return Err(invalid("invalid SSH output chunk size"));
    }
    Ok(bytes)
}

#[derive(Clone, Default)]
struct ResponseState {
    accepted: bool,
    terminal: bool,
    stdout_bytes: usize,
    stderr_bytes: usize,
}

impl ResponseState {
    fn observe(&mut self, response: &Response) -> io::Result<()> {
        if self.terminal {
            return Err(invalid("SSH response after terminal"));
        }
        match response {
            Response::Accepted {} if !self.accepted => self.accepted = true,
            Response::Stdout { data } | Response::Stderr { data } if self.accepted => {
                let total = if matches!(response, Response::Stdout { .. }) {
                    &mut self.stdout_bytes
                } else {
                    &mut self.stderr_bytes
                };
                let size = decode_output(data)?.len();
                if size > MAX_OUTPUT_BYTES - *total {
                    return Err(invalid("SSH output limit exceeded"));
                }
                *total += size;
            }
            Response::Finished { status, .. } if self.accepted => {
                if let ExitStatus::Signal { name } = status
                    && (name.is_empty()
                        || name.len() > 32
                        || !name
                            .bytes()
                            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
                {
                    return Err(invalid("invalid SSH exit signal"));
                }
                self.terminal = true;
            }
            Response::Error { effect, .. } if !self.accepted || *effect == Effect::Unknown => {
                self.terminal = true;
            }
            _ => return Err(invalid("invalid SSH response order")),
        }
        Ok(())
    }
}

/// Stateful bounded response reader. Call through EOF to verify terminal uniqueness.
pub struct ResponseReader<R> {
    reader: R,
    state: ResponseState,
    failed: bool,
}

impl<R: AsyncRead + Unpin> ResponseReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            state: ResponseState::default(),
            failed: false,
        }
    }

    pub async fn next(&mut self) -> io::Result<Option<Response>> {
        if self.failed {
            return Err(invalid("SSH response reader failed"));
        }
        // Cancellation of a partial frame must not allow resuming mid-frame.
        self.failed = true;
        let Some(bytes) = read_frame(&mut self.reader, MAX_RESPONSE_BYTES).await? else {
            if !self.state.terminal {
                return Err(invalid("missing SSH terminal response"));
            }
            self.failed = false;
            return Ok(None);
        };
        let response = parse(&bytes)?;
        self.state.observe(&response)?;
        self.failed = false;
        Ok(Some(response))
    }
}

/// Handler-side stateful writer. A terminal response shuts down the write side.
///
/// The handler must observe real SSH exec-success before sending Accepted. It
/// must retain its sandbox reservation and select lifecycle cancellation until
/// the complete operation is dropped. This writer never starts or retries SSH.
pub struct ResponseWriter<W> {
    writer: W,
    state: ResponseState,
    failed: bool,
}

impl<W: AsyncWrite + Unpin> ResponseWriter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer,
            state: ResponseState::default(),
            failed: false,
        }
    }

    pub async fn send(&mut self, response: &Response) -> io::Result<()> {
        if self.failed {
            return Err(invalid("SSH response writer failed"));
        }
        let mut next = self.state.clone();
        next.observe(response)?;
        self.failed = true;
        write_frame(&mut self.writer, response, MAX_RESPONSE_BYTES).await?;
        if next.terminal {
            self.writer.shutdown().await?;
        }
        self.state = next;
        self.failed = false;
        Ok(())
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> io::Result<T> {
    // Do not expose serde's untrusted field/value excerpts in diagnostics.
    serde_json::from_slice(bytes).map_err(|_| invalid("invalid SSH frame JSON"))
}

async fn read_frame(
    reader: &mut (impl AsyncRead + Unpin),
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    let (first, rest) = header.split_at_mut(1);
    if reader.read(first).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(rest).await?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > max {
        return Err(invalid("invalid SSH frame length"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(bytes))
}

async fn write_frame(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &impl Serialize,
    max: usize,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid("invalid SSH frame"))?;
    if bytes.len() > max {
        return Err(invalid("SSH frame too large"));
    }
    let size = u32::try_from(bytes.len()).map_err(|_| invalid("SSH frame too large"))?;
    writer.write_all(&size.to_be_bytes()).await?;
    writer.write_all(&bytes).await?;
    writer.flush().await
}
