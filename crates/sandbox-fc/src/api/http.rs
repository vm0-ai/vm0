use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::client::ApiError;

/// Send a raw HTTP/1.1 request over a Unix domain socket.
///
/// Returns the response body on 2xx success, or an `ApiError` containing the
/// status code and Firecracker `fault_message` on failure.
pub(super) async fn send_request(
    socket_path: &Path,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<String, ApiError> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(ApiError::Connect)?;

    let header = if let Some(b) = body {
        format!(
            "{method} {path} HTTP/1.1\r\n\
             Host: localhost\r\n\
             Accept: application/json\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             \r\n",
            b.len(),
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\n\
             Host: localhost\r\n\
             Accept: application/json\r\n\
             \r\n"
        )
    };

    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|e| ApiError::Other(format!("write header: {e}")))?;

    if let Some(b) = body {
        stream
            .write_all(b)
            .await
            .map_err(|e| ApiError::Other(format!("write body: {e}")))?;
    }

    // Read response into a buffer. Firecracker uses keep-alive so we
    // cannot rely on connection close; instead we read until we find the
    // header/body boundary (\r\n\r\n), parse Content-Length, then read
    // exactly that many remaining body bytes.
    let mut reader = tokio::io::BufReader::new(stream);
    let mut buf = Vec::with_capacity(4096);

    // Phase 1: read until we have the full header block.
    loop {
        let n = reader
            .read_buf(&mut buf)
            .await
            .map_err(|e| ApiError::Other(format!("read response: {e}")))?;
        if n == 0 || buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }

    let response = String::from_utf8_lossy(&buf);

    // Find where headers end.
    let header_end = response.find("\r\n\r\n").unwrap_or(response.len());

    // Parse status code from "HTTP/1.1 204 No Content\r\n..."
    let status = response
        .get(9..12)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    // Parse Content-Length from headers.
    let content_length = response
        .get(..header_end)
        .unwrap_or_default()
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    // Body bytes already read (past the \r\n\r\n separator).
    let body_start = header_end + 4;
    let already_read = buf.len().saturating_sub(body_start);
    let body_str = if content_length > 0 {
        if already_read < content_length {
            // Need to read remaining body bytes from the stream.
            let remaining = content_length - already_read;
            let mut tail = vec![0u8; remaining];
            reader
                .read_exact(&mut tail)
                .await
                .map_err(|e| ApiError::Other(format!("read body: {e}")))?;
            buf.extend_from_slice(&tail);
        }
        let end = body_start + content_length;
        String::from_utf8_lossy(buf.get(body_start..end).unwrap_or_default()).to_string()
    } else {
        String::new()
    };

    if (200..300).contains(&status) {
        Ok(body_str)
    } else {
        // Try to extract fault_message from Firecracker error JSON.
        let message = serde_json::from_str::<serde_json::Value>(&body_str)
            .ok()
            .and_then(|v| v.get("fault_message")?.as_str().map(String::from))
            .unwrap_or(body_str);
        Err(ApiError::Http {
            status,
            body: message,
        })
    }
}
