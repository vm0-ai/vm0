//! HTTP client with retry logic for webhook calls and S3 uploads.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::urls;
use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_GUEST_AGENT;
use bytes::{Bytes, BytesMut};
use guest_common::log_warn;
use http_body::{Frame, SizeHint};
use pin_project_lite::pin_project;
use reqwest::header::CONTENT_TYPE;
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
use tokio::time::Instant;
use uuid::Uuid;

const LOG_TAG: &str = "sandbox:guest-agent";
const HTTP_TOO_MANY_REQUESTS: u16 = 429;
const DEFAULT_RETRY_DELAY: Duration = Duration::from_secs(1);
#[cfg(debug_assertions)]
const TEST_DISABLE_HTTP_RETRY_DELAY_ENV: &str = "VM0_TEST_DISABLE_HTTP_RETRY_DELAY";
const GUEST_AGENT_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Content-safe facts published before one event request is awaited.
#[derive(Debug, Clone)]
pub(crate) struct HttpAttemptStarted {
    pub attempt: u32,
    pub client_request_id: String,
    pub started_at: Instant,
}

/// Content-safe facts published after one event request completes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpAttemptFinished {
    pub attempt: u32,
    pub client_request_id: String,
    pub elapsed_ms: u64,
    pub outcome: HttpAttemptOutcome,
}

/// Transport outcome for an observed event request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpAttemptOutcome {
    Success,
    Failure {
        kind: HttpAttemptFailureKind,
        http_status: Option<u16>,
    },
}

/// Content-safe failure classification for an observed request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpAttemptFailureKind {
    Timeout,
    Connect,
    HttpStatus,
    Transport,
}

/// Synchronous observer for the event delivery request path.
pub(crate) trait HttpAttemptObserver: Send + Sync {
    fn attempt_started(&self, attempt: HttpAttemptStarted) -> Result<(), AgentError>;
    fn attempt_finished(&self, attempt: HttpAttemptFinished) -> Result<(), AgentError>;
}

fn format_reqwest_error(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

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
    retry_delay: Duration,
    api: Option<Arc<ApiHttpConfig>>,
}

struct ApiHttpConfig {
    urls: ApiUrls,
    token: String,
    vercel_bypass: String,
    client_session_id: String,
}

#[derive(Clone)]
struct ApiUrls {
    events: String,
    checkpoint: String,
    complete: String,
    heartbeat: String,
    telemetry: String,
    checkpoint_prepare_history: String,
    storage_prepare: String,
    storage_commit: String,
}

impl HttpClient {
    /// Build an HTTP transport client without API webhook configuration.
    ///
    /// This constructor always initializes the underlying `reqwest` client and
    /// does not check `VM0_API_TOKEN`. It can send presigned uploads, but
    /// webhook JSON posts require API config from [`Self::with_api_config`],
    /// or [`Self::for_config`].
    /// Production guest-agent initialization should use [`Self::for_config`]
    /// so API settings come from the captured runtime config.
    pub fn new() -> Result<Self, AgentError> {
        Self::with_retry_delay(DEFAULT_RETRY_DELAY)
    }

    /// Build an enabled client with a custom retry delay.
    ///
    /// Integration tests use this to cover real retry behavior without paying
    /// production backoff time. This constructor does not enable API webhook
    /// auth by itself; use [`Self::with_api_config`] for explicit API tests or
    /// [`Self::for_config`] for production guest-agent initialization.
    #[doc(hidden)]
    pub fn with_retry_delay(retry_delay: Duration) -> Result<Self, AgentError> {
        Self::build(None, retry_delay)
    }

    #[doc(hidden)]
    pub fn with_api_config(
        base_url: impl Into<String>,
        token: impl Into<String>,
        vercel_bypass: impl Into<String>,
        client_session_id: impl Into<String>,
        retry_delay: Duration,
    ) -> Result<Self, AgentError> {
        Self::build(
            Some(ApiHttpConfig::new(
                base_url.into(),
                token.into(),
                vercel_bypass.into(),
                client_session_id.into(),
            )?),
            retry_delay,
        )
    }

    fn build(api: Option<ApiHttpConfig>, retry_delay: Duration) -> Result<Self, AgentError> {
        let inner = Client::builder()
            .connect_timeout(Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(constants::HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| {
                AgentError::Http(format!("failed to build guest-agent HTTP client: {e}"))
            })?;

        Ok(Self {
            inner: Some(inner),
            retry_delay,
            api: api.map(Arc::new),
        })
    }

    /// Build the HTTP client from an owned guest-agent config.
    pub fn for_config(config: &env::GuestConfig) -> Result<Self, AgentError> {
        let Some(api) = Self::api_config_from_values(
            &config.api_url,
            &config.api_token,
            &config.vercel_bypass,
            &config.run_id,
        )?
        else {
            return Ok(Self {
                inner: None,
                retry_delay: DEFAULT_RETRY_DELAY,
                api: None,
            });
        };
        let retry_delay = {
            #[cfg(debug_assertions)]
            {
                if std::env::var_os(TEST_DISABLE_HTTP_RETRY_DELAY_ENV).is_some() {
                    Duration::ZERO
                } else {
                    DEFAULT_RETRY_DELAY
                }
            }
            #[cfg(not(debug_assertions))]
            {
                DEFAULT_RETRY_DELAY
            }
        };
        Self::build(Some(api), retry_delay)
    }

    pub fn has_api(&self) -> bool {
        self.api.is_some()
    }

    fn inner(&self) -> Result<&Client, AgentError> {
        self.inner.as_ref().ok_or_else(|| {
            AgentError::Http(
                "guest-agent HTTP client is disabled because VM0_API_TOKEN is unset".into(),
            )
        })
    }

    fn api_config(&self) -> Result<&ApiHttpConfig, AgentError> {
        self.api
            .as_ref()
            .map(Arc::as_ref)
            .ok_or_else(|| {
                AgentError::Http(
                    "guest-agent API HTTP config is disabled; build the client with API config to send webhooks".into(),
                )
            })
    }

    fn api_config_from_values(
        base_url: &str,
        token: &str,
        vercel_bypass: &str,
        client_session_id: &str,
    ) -> Result<Option<ApiHttpConfig>, AgentError> {
        if token.is_empty() {
            return Ok(None);
        }

        Ok(Some(ApiHttpConfig::new(
            base_url.to_string(),
            token.to_string(),
            vercel_bypass.to_string(),
            client_session_id.to_string(),
        )?))
    }

    pub(crate) fn events_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.events)
    }

    pub(crate) fn checkpoint_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.checkpoint)
    }

    pub(crate) fn complete_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.complete)
    }

    pub(crate) fn heartbeat_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.heartbeat)
    }

    pub(crate) fn telemetry_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.telemetry)
    }

    pub(crate) fn checkpoint_prepare_history_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.checkpoint_prepare_history)
    }

    pub(crate) fn storage_prepare_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.storage_prepare)
    }

    pub(crate) fn storage_commit_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.storage_commit)
    }
}

impl ApiHttpConfig {
    fn new(
        base_url: String,
        token: String,
        vercel_bypass: String,
        client_session_id: String,
    ) -> Result<Self, AgentError> {
        if base_url.is_empty() {
            return Err(AgentError::Http(
                "VM0_API_BACKEND_URL is required when VM0_API_TOKEN is set".into(),
            ));
        }
        if token.is_empty() {
            return Err(AgentError::Http(
                "VM0_API_TOKEN is required for enabled API HTTP config".into(),
            ));
        }
        reqwest::header::HeaderValue::from_str(&client_session_id)
            .map_err(|e| AgentError::Http(format!("invalid client session id: {e}")))?;
        Ok(Self {
            urls: ApiUrls::new(&base_url),
            token,
            vercel_bypass,
            client_session_id,
        })
    }
}

impl ApiUrls {
    fn new(base_url: &str) -> Self {
        Self {
            events: urls::events_url(base_url),
            checkpoint: urls::checkpoint_url(base_url),
            complete: urls::complete_url(base_url),
            heartbeat: urls::heartbeat_url(base_url),
            telemetry: urls::telemetry_url(base_url),
            checkpoint_prepare_history: urls::checkpoint_prepare_history_url(base_url),
            storage_prepare: urls::storage_prepare_url(base_url),
            storage_commit: urls::storage_commit_url(base_url),
        }
    }
}

struct RetryRequest {
    builder: RequestBuilder,
    client_request_id: Option<String>,
}

impl RetryRequest {
    fn unobserved(builder: RequestBuilder) -> Self {
        Self {
            builder,
            client_request_id: None,
        }
    }

    fn observed(builder: RequestBuilder, client_request_id: String) -> Self {
        Self {
            builder,
            client_request_id: Some(client_request_id),
        }
    }
}

async fn send_with_retry<BuildRequest, BuildRequestFuture, BuildClientError, ClientErrorFuture>(
    label: &str,
    max_attempts: u32,
    retry_delay: Duration,
    final_error: String,
    mut build_request: BuildRequest,
    mut build_client_error: BuildClientError,
    observer: Option<&dyn HttpAttemptObserver>,
) -> Result<Response, AgentError>
where
    BuildRequest: FnMut() -> BuildRequestFuture,
    BuildRequestFuture: Future<Output = Result<RetryRequest, AgentError>>,
    BuildClientError: FnMut(Response, u32, u32) -> ClientErrorFuture,
    ClientErrorFuture: Future<Output = AgentError>,
{
    for attempt in 1..=max_attempts {
        let request = build_request().await?;
        let active_attempt =
            request
                .client_request_id
                .map(|client_request_id| HttpAttemptStarted {
                    attempt,
                    client_request_id,
                    started_at: Instant::now(),
                });
        if let Some(observer) = observer {
            let started = active_attempt.as_ref().ok_or_else(|| {
                AgentError::Execution(
                    "observed HTTP request omitted its client request ID".to_string(),
                )
            })?;
            observer.attempt_started(started.clone())?;
        }
        match request.builder.send().await {
            Ok(resp) if resp.status().is_success() => {
                observe_attempt_finished(observer, active_attempt, HttpAttemptOutcome::Success)?;
                return Ok(resp);
            }
            Ok(resp) => {
                let status = resp.status();
                observe_attempt_finished(
                    observer,
                    active_attempt,
                    HttpAttemptOutcome::Failure {
                        kind: HttpAttemptFailureKind::HttpStatus,
                        http_status: Some(status.as_u16()),
                    },
                )?;
                // 4xx errors are deterministic except for rate limits.
                if status.is_client_error() && status.as_u16() != HTTP_TOO_MANY_REQUESTS {
                    return Err(build_client_error(resp, attempt, max_attempts).await);
                }
                log_warn!(
                    LOG_TAG,
                    "HTTP {label} failed (attempt {attempt}/{max_attempts}): HTTP {status}",
                );
            }
            Err(error) => {
                let failure_kind = if error.is_timeout() {
                    HttpAttemptFailureKind::Timeout
                } else if error.is_connect() {
                    HttpAttemptFailureKind::Connect
                } else {
                    HttpAttemptFailureKind::Transport
                };
                observe_attempt_finished(
                    observer,
                    active_attempt,
                    HttpAttemptOutcome::Failure {
                        kind: failure_kind,
                        http_status: None,
                    },
                )?;
                let error = format_reqwest_error(error);
                log_warn!(
                    LOG_TAG,
                    "HTTP {label} failed (attempt {attempt}/{max_attempts}): {error}"
                );
            }
        }

        if attempt < max_attempts && !retry_delay.is_zero() {
            tokio::time::sleep(retry_delay).await;
        }
    }

    Err(AgentError::Http(final_error))
}

fn observe_attempt_finished(
    observer: Option<&dyn HttpAttemptObserver>,
    started: Option<HttpAttemptStarted>,
    outcome: HttpAttemptOutcome,
) -> Result<(), AgentError> {
    let Some(observer) = observer else {
        return Ok(());
    };
    let started = started.ok_or_else(|| {
        AgentError::Execution("observed HTTP attempt lost its request context".to_string())
    })?;
    observer.attempt_finished(HttpAttemptFinished {
        attempt: started.attempt,
        client_request_id: started.client_request_id,
        elapsed_ms: u64::try_from(started.started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
        outcome,
    })
}

impl HttpClient {
    /// POST JSON to a webhook endpoint with Bearer auth, Vercel bypass, and retry.
    ///
    /// `max_attempts` is the total request budget, including the initial request.
    /// Returns the parsed JSON response on success, or `None` if the response body
    /// is empty. Returns `Err` immediately on non-retriable 4xx errors (except 429),
    /// or after the attempt budget is exhausted for 5xx / 429 / network errors.
    pub async fn post_json(
        &self,
        url: &str,
        body: &impl Serialize,
        max_attempts: u32,
    ) -> Result<Option<Value>, AgentError> {
        let body = Bytes::from(serde_json::to_vec(body)?);
        self.post_json_bytes(url, body, max_attempts).await
    }

    pub(crate) async fn post_json_bytes(
        &self,
        url: &str,
        body: Bytes,
        max_attempts: u32,
    ) -> Result<Option<Value>, AgentError> {
        let resp = self
            .post_json_response(url, body, max_attempts, None)
            .await?;

        let text = resp
            .text()
            .await
            .map_err(|error| AgentError::Http(format_reqwest_error(error)))?;
        if text.is_empty() {
            return Ok(None);
        }
        let val: Value =
            serde_json::from_str(&text).map_err(|e| AgentError::Http(e.to_string()))?;
        Ok(Some(val))
    }

    pub(crate) async fn post_event_bytes(
        &self,
        url: &str,
        body: Bytes,
        max_attempts: u32,
        observer: Option<&dyn HttpAttemptObserver>,
    ) -> Result<(), AgentError> {
        self.post_json_response(url, body, max_attempts, observer)
            .await?;
        Ok(())
    }

    async fn post_json_response(
        &self,
        url: &str,
        body: Bytes,
        max_attempts: u32,
        observer: Option<&dyn HttpAttemptObserver>,
    ) -> Result<Response, AgentError> {
        let client = self.inner()?;
        let api = self.api_config()?;
        send_with_retry(
            "POST",
            max_attempts,
            self.retry_delay,
            format!("POST failed after {max_attempts} attempts to {url}"),
            || {
                let request_id = Uuid::new_v4().to_string();
                let mut req = client
                    .post(url)
                    .header("Authorization", format!("Bearer {}", api.token))
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone());

                if !api.vercel_bypass.is_empty() {
                    req = req.header("x-vercel-protection-bypass", &api.vercel_bypass);
                }

                req = req
                    .header(CLIENT_VERSION_HEADER, GUEST_AGENT_CLIENT_VERSION)
                    .header(CLIENT_TYPE_HEADER, CLIENT_TYPE_GUEST_AGENT)
                    .header(CLIENT_SESSION_ID_HEADER, api.client_session_id.as_str())
                    .header(CLIENT_REQUEST_ID_HEADER, &request_id);

                std::future::ready(Ok(RetryRequest::observed(req, request_id)))
            },
            |resp, attempt, max_attempts| {
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
                            AgentError::HttpStatus {
                                status: status.as_u16(),
                                message: format!("POST {url}: {msg}"),
                            }
                        }
                        None => {
                            log_warn!(
                                LOG_TAG,
                                "HTTP POST failed (attempt {attempt}/{max_attempts}): HTTP {status}",
                            );
                            AgentError::HttpStatus {
                                status: status.as_u16(),
                                message: format!("POST {url}: HTTP {status}"),
                            }
                        }
                    }
                }
            },
            observer,
        )
        .await
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
        let max_attempts = constants::HTTP_MAX_ATTEMPTS;
        let client = self.inner()?;

        send_with_retry(
            "PUT presigned",
            max_attempts,
            self.retry_delay,
            format!("PUT presigned failed after {max_attempts} attempts"),
            move || {
                let data = data.clone();
                std::future::ready(Ok(RetryRequest::unobserved(
                    client
                        .put(url)
                        .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
                        .header("Content-Type", content_type)
                        .body(data),
                )))
            },
            |resp, attempt, max_attempts| async move {
                let status = resp.status();
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_attempts}): HTTP {status}",
                );
                AgentError::Http(format!("PUT presigned: HTTP {status}"))
            },
            None,
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
        let max_attempts = constants::HTTP_MAX_ATTEMPTS;
        let client = self.inner()?;
        let source_file = Arc::new(tokio::fs::File::open(path).await?);
        let file_len = source_file.metadata().await?.len();

        send_with_retry(
            "PUT presigned",
            max_attempts,
            self.retry_delay,
            format!("PUT presigned failed after {max_attempts} attempts"),
            move || {
                let source_file = Arc::clone(&source_file);
                async move {
                    let mut file = source_file.try_clone().await?;
                    file.seek(std::io::SeekFrom::Start(0)).await?;
                    let body = reqwest::Body::wrap(SizedBody::new(file, file_len));

                    Ok(RetryRequest::unobserved(
                        client
                            .put(url)
                            .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
                            .header("Content-Type", content_type)
                            .body(body),
                    ))
                }
            },
            |resp, attempt, max_attempts| async move {
                let status = resp.status();
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_attempts}): HTTP {status}",
                );
                AgentError::Http(format!("PUT presigned: HTTP {status}"))
            },
            None,
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
        let client = HttpClient {
            inner: None,
            retry_delay: DEFAULT_RETRY_DELAY,
            api: None,
        };
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
        let client = HttpClient {
            inner: None,
            retry_delay: DEFAULT_RETRY_DELAY,
            api: None,
        };
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
        let client = HttpClient {
            inner: None,
            retry_delay: DEFAULT_RETRY_DELAY,
            api: None,
        };
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
