//! HTTP client with retry logic for webhook calls and S3 uploads.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use bytes::Bytes;
use guest_common::log_warn;
use http_body::{Frame, SizeHint};
use pin_project_lite::pin_project;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::pin::Pin;
use std::sync::LazyLock;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, ReadBuf};

const LOG_TAG: &str = "sandbox:guest-agent";
const HTTP_TOO_MANY_REQUESTS: u16 = 429;

static HTTP_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(constants::HTTP_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| Client::new())
});

/// POST JSON to a webhook endpoint with Bearer auth, Vercel bypass, and retry.
///
/// Returns the parsed JSON response on success, or `None` if the response body
/// is empty. Returns `Err` immediately on non-retriable 4xx errors (except 429),
/// or after all retries are exhausted for 5xx / 429 / network errors.
pub async fn post_json(
    url: &str,
    body: &impl Serialize,
    max_retries: u32,
) -> Result<Option<Value>, AgentError> {
    for attempt in 1..=max_retries {
        let mut req = HTTP_CLIENT
            .post(url)
            .header("Authorization", format!("Bearer {}", env::api_token()))
            .json(body);

        let bypass = env::vercel_bypass();
        if !bypass.is_empty() {
            req = req.header("x-vercel-protection-bypass", bypass);
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                let text = resp
                    .text()
                    .await
                    .map_err(|e| AgentError::Http(e.to_string()))?;
                if text.is_empty() {
                    return Ok(None);
                }
                let val: Value =
                    serde_json::from_str(&text).map_err(|e| AgentError::Http(e.to_string()))?;
                return Ok(Some(val));
            }
            Ok(resp) => {
                let status = resp.status();
                // 4xx errors (except 429) are deterministic — retrying won't help
                if status.is_client_error() && status.as_u16() != HTTP_TOO_MANY_REQUESTS {
                    // Try to extract error message from response body
                    let error_msg = resp
                        .text()
                        .await
                        .ok()
                        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                        .and_then(|v| v.get("error")?.get("message")?.as_str().map(String::from));

                    return match error_msg {
                        Some(msg) => {
                            log_warn!(LOG_TAG, "HTTP POST failed: HTTP {status} — {msg}",);
                            Err(AgentError::Http(format!("POST {url}: {msg}")))
                        }
                        None => {
                            log_warn!(
                                LOG_TAG,
                                "HTTP POST failed (attempt {attempt}/{max_retries}): HTTP {status}",
                            );
                            Err(AgentError::Http(format!("POST {url}: HTTP {status}")))
                        }
                    };
                }
                log_warn!(
                    LOG_TAG,
                    "HTTP POST failed (attempt {attempt}/{max_retries}): HTTP {status}",
                );
            }
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "HTTP POST failed (attempt {attempt}/{max_retries}): {e}"
                );
            }
        }

        if attempt < max_retries {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    Err(AgentError::Http(format!(
        "POST failed after {max_retries} attempts to {url}"
    )))
}

/// PUT raw bytes to a presigned S3 URL with retry.
///
/// No auth headers — the URL itself carries the authorization.
/// Uses a per-request timeout override for longer uploads.
/// Accepts `Bytes` for O(1) clone on retry.
pub async fn put_presigned(url: &str, data: Bytes, content_type: &str) -> Result<(), AgentError> {
    let max_retries = constants::HTTP_MAX_RETRIES;

    for attempt in 1..=max_retries {
        match HTTP_CLIENT
            .put(url)
            .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
            .header("Content-Type", content_type)
            .body(data.clone())
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                let status = resp.status();
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): HTTP {status}",
                );
                // 4xx errors (except 429) are deterministic — retrying won't help
                if status.is_client_error() && status.as_u16() != HTTP_TOO_MANY_REQUESTS {
                    return Err(AgentError::Http(format!("PUT presigned: HTTP {status}")));
                }
            }
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): {e}"
                );
            }
        }

        if attempt < max_retries {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    Err(AgentError::Http(format!(
        "PUT presigned failed after {max_retries} attempts"
    )))
}

// ---------------------------------------------------------------------------
// Streaming file upload
// ---------------------------------------------------------------------------

/// Chunk size for streaming file reads (16 KB).
const STREAM_CHUNK_SIZE: usize = 16384;

pin_project! {
    /// HTTP body backed by an async file reader with a known size.
    ///
    /// Reports the remaining byte count via [`size_hint`](http_body::Body::size_hint),
    /// which lets hyper set `Content-Length` automatically — no chunked encoding,
    /// no manual header.
    struct SizedBody {
        #[pin]
        reader: tokio::fs::File,
        remaining: u64,
    }
}

impl http_body::Body for SizedBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.project();
        if *this.remaining == 0 {
            return Poll::Ready(None);
        }
        let to_read = (*this.remaining as usize).min(STREAM_CHUNK_SIZE);
        let mut buf = vec![0u8; to_read];
        let mut read_buf = ReadBuf::new(&mut buf);
        match this.reader.poll_read(cx, &mut read_buf) {
            Poll::Ready(Ok(())) => {
                let n = read_buf.filled().len();
                if n == 0 {
                    *this.remaining = 0;
                    return Poll::Ready(None);
                }
                buf.truncate(n);
                *this.remaining = this.remaining.saturating_sub(n as u64);
                Poll::Ready(Some(Ok(Frame::data(Bytes::from(buf)))))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

/// PUT a file to a presigned S3 URL by streaming from disk.
///
/// Unlike [`put_presigned`], this avoids loading the entire file into memory.
/// A [`SizedBody`] streams 16 KB chunks and reports the file size via
/// `size_hint`, so hyper sets `Content-Length` automatically.
/// On each retry the file is re-opened, producing a fresh body.
pub async fn put_presigned_file(
    url: &str,
    path: &Path,
    content_type: &str,
) -> Result<(), AgentError> {
    let max_retries = constants::HTTP_MAX_RETRIES;

    for attempt in 1..=max_retries {
        let file = tokio::fs::File::open(path).await?;
        let file_len = file.metadata().await?.len();
        let body = reqwest::Body::wrap(SizedBody {
            reader: file,
            remaining: file_len,
        });

        match HTTP_CLIENT
            .put(url)
            .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
            .header("Content-Type", content_type)
            .body(body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                let status = resp.status();
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): HTTP {status}",
                );
                if status.is_client_error() && status.as_u16() != HTTP_TOO_MANY_REQUESTS {
                    return Err(AgentError::Http(format!("PUT presigned: HTTP {status}")));
                }
            }
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): {e}"
                );
            }
        }

        if attempt < max_retries {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    Err(AgentError::Http(format!(
        "PUT presigned failed after {max_retries} attempts"
    )))
}
