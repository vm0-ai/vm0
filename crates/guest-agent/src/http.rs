//! HTTP client with retry logic for webhook calls and S3 uploads.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use bytes::{Bytes, BytesMut};
use guest_common::log_warn;
use http_body::{Frame, SizeHint};
use pin_project_lite::pin_project;
use reqwest::{Client, RequestBuilder, Response};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncSeekExt, ReadBuf};

const LOG_TAG: &str = "sandbox:guest-agent";
const HTTP_TOO_MANY_REQUESTS: u16 = 429;

/// Shared guest-agent HTTP client.
///
/// API-enabled runs build this during initialization and pass cheap clones to
/// background tasks. That keeps webhook/S3 timeout configuration consistent
/// across all HTTP calls and makes client-construction failures explicit at
/// startup. Local/test runs without `VM0_API_TOKEN` use a disabled client so
/// they do not fail on HTTP stack setup they will never use.
#[derive(Clone)]
pub struct HttpClient {
    inner: Option<Client>,
}

impl HttpClient {
    pub fn new() -> Result<Self, AgentError> {
        let inner = Client::builder()
            .connect_timeout(Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(constants::HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| {
                AgentError::Http(format!("failed to build guest-agent HTTP client: {e}"))
            })?;

        Ok(Self { inner: Some(inner) })
    }

    pub fn for_current_env() -> Result<Self, AgentError> {
        if env::has_api() {
            Self::new()
        } else {
            Ok(Self { inner: None })
        }
    }

    fn inner(&self) -> Result<&Client, AgentError> {
        self.inner.as_ref().ok_or_else(|| {
            AgentError::Http(
                "guest-agent HTTP client is disabled because VM0_API_TOKEN is unset".into(),
            )
        })
    }
}

async fn send_with_retry<BuildRequest, BuildRequestFuture, BuildClientError, ClientErrorFuture>(
    label: &str,
    max_retries: u32,
    final_error: String,
    mut build_request: BuildRequest,
    mut build_client_error: BuildClientError,
) -> Result<Response, AgentError>
where
    BuildRequest: FnMut() -> BuildRequestFuture,
    BuildRequestFuture: Future<Output = Result<RequestBuilder, AgentError>>,
    BuildClientError: FnMut(Response, u32, u32) -> ClientErrorFuture,
    ClientErrorFuture: Future<Output = AgentError>,
{
    for attempt in 1..=max_retries {
        match build_request().await?.send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                let status = resp.status();
                // 4xx errors are deterministic except for rate limits.
                if status.is_client_error() && status.as_u16() != HTTP_TOO_MANY_REQUESTS {
                    return Err(build_client_error(resp, attempt, max_retries).await);
                }
                log_warn!(
                    LOG_TAG,
                    "HTTP {label} failed (attempt {attempt}/{max_retries}): HTTP {status}",
                );
            }
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "HTTP {label} failed (attempt {attempt}/{max_retries}): {e}"
                );
            }
        }

        if attempt < max_retries {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    Err(AgentError::Http(final_error))
}

impl HttpClient {
    /// POST JSON to a webhook endpoint with Bearer auth, Vercel bypass, and retry.
    ///
    /// Returns the parsed JSON response on success, or `None` if the response body
    /// is empty. Returns `Err` immediately on non-retriable 4xx errors (except 429),
    /// or after all retries are exhausted for 5xx / 429 / network errors.
    pub async fn post_json(
        &self,
        url: &str,
        body: &impl Serialize,
        max_retries: u32,
    ) -> Result<Option<Value>, AgentError> {
        let client = self.inner()?;
        let resp = send_with_retry(
            "POST",
            max_retries,
            format!("POST failed after {max_retries} attempts to {url}"),
            || {
                let mut req = client
                    .post(url)
                    .header("Authorization", format!("Bearer {}", env::api_token()))
                    .json(body);

                let bypass = env::vercel_bypass();
                if !bypass.is_empty() {
                    req = req.header("x-vercel-protection-bypass", bypass);
                }

                std::future::ready(Ok(req))
            },
            |resp, attempt, max_retries| {
                let url = url.to_owned();
                async move {
                    let status = resp.status();
                    let error_msg = resp
                        .text()
                        .await
                        .ok()
                        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                        .and_then(|v| v.get("error")?.get("message")?.as_str().map(String::from));

                    match error_msg {
                        Some(msg) => {
                            log_warn!(LOG_TAG, "HTTP POST failed: HTTP {status} — {msg}",);
                            AgentError::Http(format!("POST {url}: {msg}"))
                        }
                        None => {
                            log_warn!(
                                LOG_TAG,
                                "HTTP POST failed (attempt {attempt}/{max_retries}): HTTP {status}",
                            );
                            AgentError::Http(format!("POST {url}: HTTP {status}"))
                        }
                    }
                }
            },
        )
        .await?;

        let text = resp
            .text()
            .await
            .map_err(|e| AgentError::Http(e.to_string()))?;
        if text.is_empty() {
            return Ok(None);
        }
        let val: Value =
            serde_json::from_str(&text).map_err(|e| AgentError::Http(e.to_string()))?;
        Ok(Some(val))
    }

    /// PUT raw bytes to a presigned S3 URL with retry.
    ///
    /// No auth headers — the URL itself carries the authorization.
    /// Uses a per-request timeout override for longer uploads.
    /// Accepts `Bytes` for O(1) clone on retry.
    pub async fn put_presigned(
        &self,
        url: &str,
        data: Bytes,
        content_type: &str,
    ) -> Result<(), AgentError> {
        let max_retries = constants::HTTP_MAX_RETRIES;
        let client = self.inner()?;

        send_with_retry(
            "PUT presigned",
            max_retries,
            format!("PUT presigned failed after {max_retries} attempts"),
            move || {
                let data = data.clone();
                std::future::ready(Ok(client
                    .put(url)
                    .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
                    .header("Content-Type", content_type)
                    .body(data)))
            },
            |resp, attempt, max_retries| async move {
                let status = resp.status();
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): HTTP {status}",
                );
                AgentError::Http(format!("PUT presigned: HTTP {status}"))
            },
        )
        .await?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Streaming file upload
// ---------------------------------------------------------------------------

/// Chunk size for streaming file reads (256 KB).
const STREAM_CHUNK_SIZE: usize = 256 * 1024;

fn next_chunk_size(remaining: u64) -> usize {
    usize::try_from(remaining)
        .unwrap_or(usize::MAX)
        .min(STREAM_CHUNK_SIZE)
}

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
        buffer: BytesMut,
    }
}

impl SizedBody {
    fn new(reader: tokio::fs::File, remaining: u64) -> Self {
        Self {
            reader,
            remaining,
            buffer: BytesMut::with_capacity(next_chunk_size(remaining)),
        }
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

        let buffer_len = this.buffer.len();
        let to_read = next_chunk_size(*this.remaining);
        let spare_capacity = this.buffer.capacity() - buffer_len;
        if spare_capacity < to_read {
            this.buffer.reserve(to_read - spare_capacity);
        }

        let Some(spare) = this.buffer.spare_capacity_mut().get_mut(..to_read) else {
            return Poll::Ready(Some(Err(std::io::Error::other(
                "failed to reserve streaming upload buffer",
            ))));
        };
        let mut read_buf = ReadBuf::uninit(spare);
        match this.reader.poll_read(cx, &mut read_buf) {
            Poll::Ready(Ok(())) => {
                let n = read_buf.filled().len();
                if n == 0 {
                    let missing = *this.remaining;
                    *this.remaining = 0;
                    return Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        format!("streaming upload source ended {missing} bytes early"),
                    ))));
                }
                // SAFETY: `poll_read` initialized exactly `n` bytes in the spare
                // capacity exposed to `ReadBuf` above.
                unsafe {
                    this.buffer.set_len(buffer_len + n);
                }
                let frame_data = this.buffer.split_to(n).freeze();
                debug_assert!((n as u64) <= *this.remaining);
                *this.remaining -= n as u64;
                Poll::Ready(Some(Ok(Frame::data(frame_data))))
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

impl HttpClient {
    /// PUT a file to a presigned S3 URL by streaming from disk.
    ///
    /// Unlike [`Self::put_presigned`], this avoids loading the entire file into
    /// memory. A `SizedBody` streams bounded chunks and reports the file size via
    /// `size_hint`, so hyper sets `Content-Length` automatically. On each retry the
    /// original file handle is cloned, producing a fresh body with stable file
    /// identity and length.
    pub async fn put_presigned_file(
        &self,
        url: &str,
        path: &Path,
        content_type: &str,
    ) -> Result<(), AgentError> {
        let max_retries = constants::HTTP_MAX_RETRIES;
        let client = self.inner()?;
        let source_file = Arc::new(tokio::fs::File::open(path).await?);
        let file_len = source_file.metadata().await?.len();

        send_with_retry(
            "PUT presigned",
            max_retries,
            format!("PUT presigned failed after {max_retries} attempts"),
            move || {
                let source_file = Arc::clone(&source_file);
                async move {
                    let mut file = source_file.try_clone().await?;
                    file.seek(std::io::SeekFrom::Start(0)).await?;
                    let body = reqwest::Body::wrap(SizedBody::new(file, file_len));

                    Ok(client
                        .put(url)
                        .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
                        .header("Content-Type", content_type)
                        .body(body))
                }
            },
            |resp, attempt, max_retries| async move {
                let status = resp.status();
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): HTTP {status}",
                );
                AgentError::Http(format!("PUT presigned: HTTP {status}"))
            },
        )
        .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Body as _;
    use std::future::poll_fn;

    async fn sized_body_from_bytes(data: &[u8]) -> (tempfile::TempDir, SizedBody) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, data).await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        (dir, SizedBody::new(file, file_len))
    }

    async fn next_data(body: &mut SizedBody) -> Option<Bytes> {
        let frame = poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx))
            .await
            .transpose()
            .unwrap()?;
        match frame.into_data() {
            Ok(data) => Some(data),
            Err(_) => panic!("expected data frame"),
        }
    }

    #[tokio::test]
    async fn disabled_client_fails_before_request_build() {
        let client = HttpClient { inner: None };
        let result = client
            .post_json("http://127.0.0.1:1/test", &serde_json::json!({}), 1)
            .await;

        let Err(AgentError::Http(message)) = result else {
            panic!("expected disabled HTTP client error");
        };
        assert!(message.contains("HTTP client is disabled"));
    }

    #[tokio::test]
    async fn disabled_client_raw_upload_fails_before_request_build() {
        let client = HttpClient { inner: None };
        let result = client
            .put_presigned(
                "http://127.0.0.1:1/upload",
                Bytes::from_static(b"manifest"),
                "application/json",
            )
            .await;

        let Err(AgentError::Http(message)) = result else {
            panic!("expected disabled HTTP client error");
        };
        assert!(message.contains("HTTP client is disabled"));
    }

    #[tokio::test]
    async fn disabled_client_stream_upload_fails_before_file_open() {
        let client = HttpClient { inner: None };
        let result = client
            .put_presigned_file(
                "http://127.0.0.1:1/upload",
                Path::new("/definitely/missing/source.bin"),
                "application/octet-stream",
            )
            .await;

        let Err(AgentError::Http(message)) = result else {
            panic!("expected disabled HTTP client error");
        };
        assert!(message.contains("HTTP client is disabled"));
    }

    #[tokio::test]
    async fn sized_body_streams_large_file_in_bounded_chunks() {
        let data: Vec<u8> = (0..(STREAM_CHUNK_SIZE * 2 + 37))
            .map(|i| (i % 251) as u8)
            .collect();
        let (_dir, mut body) = sized_body_from_bytes(&data).await;

        let mut remaining = data.len() as u64;
        assert_eq!(body.size_hint().exact(), Some(remaining));

        let mut chunks = 0;
        let mut uploaded = Vec::with_capacity(data.len());
        while let Some(chunk) = next_data(&mut body).await {
            assert!(chunk.len() <= STREAM_CHUNK_SIZE);
            chunks += 1;
            remaining = remaining.saturating_sub(chunk.len() as u64);
            assert_eq!(body.size_hint().exact(), Some(remaining));
            uploaded.extend_from_slice(&chunk);
        }

        assert!(chunks > 1);
        assert_eq!(uploaded, data);
        assert_eq!(body.size_hint().exact(), Some(0));
    }

    #[tokio::test]
    async fn sized_body_streams_small_file_once() {
        let data = b"streaming body";
        let (_dir, mut body) = sized_body_from_bytes(data).await;

        assert_eq!(body.size_hint().exact(), Some(data.len() as u64));
        let chunk = next_data(&mut body).await.unwrap();

        assert_eq!(&chunk[..], data);
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(next_data(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn sized_body_streams_exact_chunk_once() {
        let data = vec![0x5Au8; STREAM_CHUNK_SIZE];
        let (_dir, mut body) = sized_body_from_bytes(&data).await;

        assert_eq!(body.size_hint().exact(), Some(STREAM_CHUNK_SIZE as u64));
        let chunk = next_data(&mut body).await.unwrap();

        assert_eq!(chunk.len(), STREAM_CHUNK_SIZE);
        assert_eq!(&chunk[..], &data[..]);
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(body.is_end_stream());
        assert!(next_data(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn sized_body_empty_file_has_no_frames() {
        let (_dir, mut body) = sized_body_from_bytes(&[]).await;

        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(next_data(&mut body).await.is_none());
        assert!(body.is_end_stream());
    }

    #[tokio::test]
    async fn sized_body_does_not_stream_bytes_added_after_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, b"initial").await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        let mut body = SizedBody::new(file, file_len);

        tokio::fs::write(&path, b"initial-extra").await.unwrap();

        let chunk = next_data(&mut body).await.unwrap();
        assert_eq!(&chunk[..], b"initial");
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(next_data(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn sized_body_errors_when_file_is_shorter_than_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, b"initial-extra").await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        let mut body = SizedBody::new(file, file_len);

        tokio::fs::write(&path, b"initial").await.unwrap();

        let chunk = next_data(&mut body).await.unwrap();
        assert_eq!(&chunk[..], b"initial");
        let error = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .expect("expected a frame")
            .expect_err("expected early EOF error");

        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(body.size_hint().exact(), Some(0));
    }

    #[tokio::test]
    async fn sized_body_errors_when_file_is_truncated_before_first_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, b"initial").await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        let mut body = SizedBody::new(file, file_len);

        tokio::fs::write(&path, &[]).await.unwrap();

        let error = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .expect("expected a frame")
            .expect_err("expected early EOF error");

        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(body.is_end_stream());
    }
}
