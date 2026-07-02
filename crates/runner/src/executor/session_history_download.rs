//! Resume-session history materialization for runner execution.
//!
//! Resume sessions can arrive with no history, inline history, or a hash-backed
//! history reference. This module owns the hash-backed materializer lifecycle:
//! no resume session, no download needed, or an in-flight download task. Inline
//! history stays on the original `ResumeSession`; `agent_run` restores it after
//! `finish` reports that no download was needed.
//!
//! Hash-backed downloads can be started before the final restore point so the
//! network fetch overlaps sandbox preparation and reuse checks. `finish` is the
//! single point that consumes the task result, and cancellation takes priority
//! over a completed download so cancelled runs do not proceed into restore.
//!
//! Download diagnostics must not expose presigned URL query strings, and the
//! downloaded bytes must satisfy the declared size, byte cap, and hash contract
//! before they are restored into the sandbox.

use std::io::Read;
use std::time::{Duration, Instant};

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use flate2::read::MultiGzDecoder;
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::session_restore::MaterializedResumeSession;
use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::types::{
    ResumeSession, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind,
};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct SessionHistoryMaterializer {
    state: SessionHistoryMaterializerState,
}

enum SessionHistoryMaterializerState {
    Missing,
    NoDownloadNeeded,
    Downloading {
        started_at: Instant,
        encoding: ResumeSessionHistoryEncoding,
        task: Option<JoinHandle<SessionHistoryDownloadTaskResult>>,
    },
}

pub(super) enum SessionHistoryMaterialization {
    Missing,
    NoDownloadNeeded,
    Downloaded {
        session: MaterializedResumeSession<'static>,
        elapsed: Duration,
        timings: SessionHistoryDownloadTimings,
    },
    Failed {
        elapsed: Duration,
        timings: SessionHistoryDownloadTimings,
        error: RunnerError,
    },
}

struct SessionHistoryDownloadTaskResult {
    elapsed: Duration,
    timings: SessionHistoryDownloadTimings,
    result: RunnerResult<MaterializedResumeSession<'static>>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SessionHistoryDownloadTimings {
    encoding: Option<ResumeSessionHistoryEncoding>,
    request_status: Option<SessionHistoryDownloadPhaseTiming>,
    body_read: Option<SessionHistoryDownloadPhaseTiming>,
    validation: Option<SessionHistoryDownloadPhaseTiming>,
    hash_verification: Option<SessionHistoryDownloadPhaseTiming>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct SessionHistoryDownloadPhaseTiming {
    elapsed: Duration,
    success: bool,
}

impl SessionHistoryDownloadTimings {
    pub(super) fn encoding(&self) -> Option<&'static str> {
        self.encoding
            .map(ResumeSessionHistoryEncoding::telemetry_value)
    }

    pub(super) fn request_status(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.request_status
    }

    pub(super) fn body_read(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.body_read
    }

    pub(super) fn validation(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.validation
    }

    pub(super) fn hash_verification(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.hash_verification
    }

    fn record_request_status(&mut self, elapsed: Duration, success: bool) {
        self.request_status = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    fn record_encoding(&mut self, encoding: ResumeSessionHistoryEncoding) {
        self.encoding = Some(encoding);
    }

    fn for_encoding(encoding: ResumeSessionHistoryEncoding) -> Self {
        Self {
            encoding: Some(encoding),
            ..Self::default()
        }
    }

    fn record_body_read(&mut self, elapsed: Duration, success: bool) {
        self.body_read = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    fn record_hash_verification(&mut self, elapsed: Duration, success: bool) {
        self.hash_verification = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    fn add_validation(&mut self, elapsed: Duration, success: bool) {
        merge_phase_timing(&mut self.validation, elapsed, success);
    }
}

impl SessionHistoryDownloadPhaseTiming {
    pub(super) fn elapsed(self) -> Duration {
        self.elapsed
    }

    pub(super) fn success(self) -> bool {
        self.success
    }
}

impl ResumeSessionHistoryEncoding {
    const fn telemetry_value(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Gzip => "gzip",
        }
    }
}

fn merge_phase_timing(
    phase: &mut Option<SessionHistoryDownloadPhaseTiming>,
    elapsed: Duration,
    success: bool,
) {
    match phase {
        Some(phase) => {
            phase.elapsed += elapsed;
            phase.success &= success;
        }
        None => {
            *phase = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
        }
    }
}

impl SessionHistoryMaterializer {
    pub(crate) fn start_cancellable(
        http: &HttpClient,
        session: Option<&ResumeSession>,
        cancel: CancellationToken,
    ) -> Self {
        let Some(session) = session else {
            return Self {
                state: SessionHistoryMaterializerState::Missing,
            };
        };
        let Some(history_ref) = session.history_ref() else {
            return Self {
                state: SessionHistoryMaterializerState::NoDownloadNeeded,
            };
        };
        let encoding = history_ref
            .encoding
            .unwrap_or(ResumeSessionHistoryEncoding::Identity);

        let http = http.clone();
        let session = session.clone();
        let started_at = Instant::now();
        // The spawned task observes cancellation even before `finish` runs, so
        // prestarted downloads do not need to wait for final materialization.
        Self {
            state: SessionHistoryMaterializerState::Downloading {
                started_at,
                encoding,
                task: Some(tokio::spawn(async move {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            SessionHistoryDownloadTaskResult::cancelled(started_at, encoding)
                        }
                        result = download_resume_session_history_timed(http, session) => result,
                    }
                })),
            },
        }
    }

    pub(super) fn is_downloading(&self) -> bool {
        matches!(
            self.state,
            SessionHistoryMaterializerState::Downloading { .. }
        )
    }

    pub(super) fn is_download_finished(&self) -> bool {
        matches!(
            &self.state,
            SessionHistoryMaterializerState::Downloading {
                task: Some(task),
                ..
            } if task.is_finished()
        )
    }

    pub(super) async fn finish(
        mut self,
        cancel: &CancellationToken,
    ) -> SessionHistoryMaterialization {
        // `finish` transfers ownership of the background task into final
        // materialization. Cancellation wins over any completed task result.
        match &mut self.state {
            SessionHistoryMaterializerState::Missing => SessionHistoryMaterialization::Missing,
            SessionHistoryMaterializerState::NoDownloadNeeded => {
                SessionHistoryMaterialization::NoDownloadNeeded
            }
            SessionHistoryMaterializerState::Downloading {
                started_at,
                encoding,
                task,
            } => {
                let started_at = *started_at;
                let encoding = *encoding;
                if cancel.is_cancelled() {
                    if let Some(task) = task.take() {
                        task.abort();
                        let _ = task.await;
                    }
                    return SessionHistoryDownloadTaskResult::cancelled(started_at, encoding)
                        .into_materialization();
                }
                let Some(mut task) = task.take() else {
                    return SessionHistoryMaterialization::Failed {
                        elapsed: Duration::ZERO,
                        timings: SessionHistoryDownloadTimings::for_encoding(encoding),
                        error: RunnerError::Internal(
                            "session history materializer lost download task".into(),
                        ),
                    };
                };
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        task.abort();
                        let _ = task.await;
                        SessionHistoryDownloadTaskResult::cancelled(started_at, encoding)
                    }
                    joined = &mut task => {
                        joined.unwrap_or_else(|error| {
                            SessionHistoryDownloadTaskResult {
                                elapsed: started_at.elapsed(),
                                timings: SessionHistoryDownloadTimings::for_encoding(encoding),
                                result: Err(RunnerError::Internal(format!(
                                    "session history download task failed: {error}"
                                ))),
                            }
                        })
                    }
                };
                // Re-check after joining because the task itself can observe
                // cancellation while still producing a successful result.
                if cancel.is_cancelled() {
                    return SessionHistoryDownloadTaskResult::cancelled(started_at, encoding)
                        .into_materialization();
                }
                result.into_materialization()
            }
        }
    }
}

impl SessionHistoryDownloadTaskResult {
    fn into_materialization(self) -> SessionHistoryMaterialization {
        match self.result {
            Ok(session) => SessionHistoryMaterialization::Downloaded {
                session,
                elapsed: self.elapsed,
                timings: self.timings,
            },
            Err(error) => SessionHistoryMaterialization::Failed {
                elapsed: self.elapsed,
                timings: self.timings,
                error,
            },
        }
    }

    fn cancelled(started_at: Instant, encoding: ResumeSessionHistoryEncoding) -> Self {
        Self {
            elapsed: started_at.elapsed(),
            timings: SessionHistoryDownloadTimings::for_encoding(encoding),
            result: Err(RunnerError::Internal(
                "session history download cancelled".into(),
            )),
        }
    }
}

impl Drop for SessionHistoryMaterializer {
    fn drop(&mut self) {
        if let SessionHistoryMaterializerState::Downloading {
            task: Some(task), ..
        } = &mut self.state
        {
            // Dropping means no owner will call `finish`. Abort the task so an
            // abandoned prestarted download does not continue in the background.
            task.abort();
        }
    }
}

async fn download_resume_session_history_timed(
    http: HttpClient,
    session: ResumeSession,
) -> SessionHistoryDownloadTaskResult {
    let started_at = Instant::now();
    let mut timings = SessionHistoryDownloadTimings::default();
    let result = download_resume_session_history(http, session, &mut timings).await;
    SessionHistoryDownloadTaskResult {
        elapsed: started_at.elapsed(),
        timings,
        result,
    }
}

async fn download_resume_session_history(
    http: HttpClient,
    session: ResumeSession,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<MaterializedResumeSession<'static>> {
    // The history ref is treated as untrusted input. The request timeout and
    // 128 MiB cap bound resource use; declared size, HTTP content-length, final
    // byte count, and SHA-256 must all agree before the bytes become sandbox
    // session history. URL diagnostics redact query strings because the ref URL
    // can be presigned.
    let history_ref = session
        .history_ref()
        .ok_or_else(|| RunnerError::Internal("resume session history ref is missing".into()))?
        .clone();
    match history_ref.kind {
        ResumeSessionHistoryRefKind::Blob => {}
    }

    let encoding = history_ref
        .encoding
        .unwrap_or(ResumeSessionHistoryEncoding::Identity);
    timings.record_encoding(encoding);

    let bytes = match encoding {
        ResumeSessionHistoryEncoding::Identity => {
            validate_identity_ref(&history_ref, timings)?;
            let bytes = download_body(
                &http,
                &history_ref.url,
                Some(history_ref.encoded_size),
                timings,
            )
            .await?;
            validate_identity_body_size(&history_ref, bytes.len(), timings)?;
            bytes
        }
        ResumeSessionHistoryEncoding::Gzip => {
            let raw_size = validate_gzip_ref(&history_ref, timings)?;
            let encoded_bytes = download_body(
                &http,
                &history_ref.url,
                Some(history_ref.encoded_size),
                timings,
            )
            .await?;
            let raw_bytes = gunzip_session_history(&encoded_bytes, raw_size)?;
            validate_gzip_raw_size(raw_size, raw_bytes.len(), timings)?;
            raw_bytes
        }
    };

    let hash_started = Instant::now();
    let actual_hash = hex::encode(Sha256::digest(&bytes));
    if actual_hash != history_ref.hash {
        timings.record_hash_verification(hash_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "session history hash mismatch".into(),
        ));
    }
    timings.record_hash_verification(hash_started.elapsed(), true);

    Ok(MaterializedResumeSession::new(
        session.cli_agent_session_id,
        bytes,
    ))
}

fn validate_identity_ref(
    history_ref: &ResumeSessionHistoryRef,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<()> {
    let validation_started = Instant::now();
    if history_ref.raw_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "identity session history rawSize must be positive".into(),
        ));
    }
    if history_ref.encoded_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "identity session history encodedSize must be positive".into(),
        ));
    }
    if history_ref.raw_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history is too large: {} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
            history_ref.raw_size
        )));
    }
    if history_ref.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history encoded object is too large: {} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
            history_ref.encoded_size
        )));
    }
    if history_ref.raw_size != history_ref.encoded_size {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "identity session history rawSize must match encodedSize: rawSize={}, encodedSize={}",
            history_ref.raw_size, history_ref.encoded_size
        )));
    }
    Ok(())
}

fn validate_identity_body_size(
    history_ref: &ResumeSessionHistoryRef,
    byte_count: usize,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<()> {
    let validation_started = Instant::now();
    if byte_count as u64 != history_ref.raw_size {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history size mismatch: expected {} bytes, got {byte_count} bytes",
            history_ref.raw_size
        )));
    }
    timings.add_validation(validation_started.elapsed(), true);
    Ok(())
}

fn validate_gzip_ref(
    history_ref: &ResumeSessionHistoryRef,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<u64> {
    let validation_started = Instant::now();
    let raw_size = history_ref.raw_size;
    if raw_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "gzip session history rawSize must be positive".into(),
        ));
    }
    if raw_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history is too large: {raw_size} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes"
        )));
    }
    if history_ref.encoded_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "gzip session history encodedSize must be positive".into(),
        ));
    }
    if history_ref.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history encoded object is too large: {} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
            history_ref.encoded_size
        )));
    }
    Ok(raw_size)
}

fn validate_gzip_raw_size(
    expected_size: u64,
    byte_count: usize,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<()> {
    let validation_started = Instant::now();
    if byte_count as u64 != expected_size {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history size mismatch: expected {expected_size} bytes after decompression, got {byte_count} bytes"
        )));
    }
    timings.add_validation(validation_started.elapsed(), true);
    Ok(())
}

fn gunzip_session_history(encoded_bytes: &[u8], max_raw_bytes: u64) -> RunnerResult<Vec<u8>> {
    let mut decoder = MultiGzDecoder::new(encoded_bytes);
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut decoded = 0u64;
    loop {
        let read = decoder.read(&mut buffer).map_err(|error| {
            RunnerError::Internal(format!("decompress gzip session history: {error}"))
        })?;
        if read == 0 {
            break;
        }
        decoded += read as u64;
        if decoded > max_raw_bytes {
            return Err(RunnerError::Internal(format!(
                "session history is too large after decompression: {decoded} bytes exceeds {max_raw_bytes} bytes"
            )));
        }
        let chunk = buffer
            .get(..read)
            .ok_or_else(|| RunnerError::Internal("invalid gzip read chunk length".into()))?;
        bytes.extend_from_slice(chunk);
    }
    Ok(bytes)
}

async fn download_body(
    http: &HttpClient,
    url: &str,
    expected_size: Option<u64>,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<Vec<u8>> {
    let request_started = Instant::now();
    let response_result = http
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            RunnerError::Internal(format!(
                "GET {}: {}",
                redact_url_query(url),
                error.without_url()
            ))
        })?
        .error_for_status()
        .map_err(|error| {
            RunnerError::Internal(format!(
                "GET status {}: {}",
                redact_url_query(url),
                error.without_url()
            ))
        });
    let mut response = match response_result {
        Ok(response) => {
            timings.record_request_status(request_started.elapsed(), true);
            response
        }
        Err(error) => {
            timings.record_request_status(request_started.elapsed(), false);
            return Err(error);
        }
    };

    let validation_started = Instant::now();
    if let Some(content_length) = response.content_length() {
        if content_length > RESUME_SESSION_HISTORY_MAX_BYTES {
            timings.add_validation(validation_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "session history is too large: {content_length} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes"
            )));
        }
        if let Some(expected_size) = expected_size
            && content_length != expected_size
        {
            timings.add_validation(validation_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "session history content-length mismatch: expected {expected_size} bytes, got {content_length} bytes"
            )));
        }
    }
    timings.add_validation(validation_started.elapsed(), true);

    let capacity = expected_size
        .unwrap_or(64 * 1024)
        .min(RESUME_SESSION_HISTORY_MAX_BYTES)
        .min(usize::MAX as u64) as usize;
    let mut body = Vec::with_capacity(capacity);
    let mut downloaded = 0u64;
    let body_started = Instant::now();
    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(error) => {
            timings.record_body_read(body_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "read {}: {}",
                redact_url_query(url),
                error.without_url()
            )));
        }
    } {
        downloaded += chunk.len() as u64;
        if let Some(expected_size) = expected_size
            && downloaded > expected_size
        {
            timings.record_body_read(body_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "session history downloaded size mismatch: expected {expected_size} bytes, got more than {expected_size} bytes"
            )));
        }
        if downloaded > RESUME_SESSION_HISTORY_MAX_BYTES {
            timings.record_body_read(body_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "session history is too large: {downloaded} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(expected_size) = expected_size
        && downloaded != expected_size
    {
        timings.record_body_read(body_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history downloaded size mismatch: expected {expected_size} bytes, got {downloaded} bytes"
        )));
    }
    timings.record_body_read(body_started.elapsed(), true);

    Ok(body)
}

fn redact_url_query(url: &str) -> String {
    let Some(query_start) = url.find('?') else {
        return url.to_string();
    };
    let fragment = url[query_start + 1..].find('#').map(|index| {
        let fragment_start = query_start + 1 + index;
        &url[fragment_start..]
    });
    match fragment {
        Some(fragment) => format!("{}?<redacted>{fragment}", &url[..query_start]),
        None => format!("{}?<redacted>", &url[..query_start]),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};

    use flate2::{Compression, write::GzEncoder};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    use super::*;
    use crate::http::{HttpClient, HttpClientConfig};
    use crate::types::{
        ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
        ResumeSessionHistoryRefKind,
    };

    fn http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://api.test".to_string(),
            vercel_bypass: None,
        })
        .unwrap()
    }

    fn ref_session(url: String, hash: String, raw_size: u64, encoded_size: u64) -> ResumeSession {
        ResumeSession {
            cli_agent_session_id: "sess-123".to_string(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash,
                    url,
                    encoding: None,
                    raw_size,
                    encoded_size,
                },
            },
        }
    }

    fn gzip_ref_session(
        url: String,
        hash: String,
        raw_size: u64,
        encoded_size: u64,
    ) -> ResumeSession {
        ResumeSession {
            cli_agent_session_id: "sess-123".to_string(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash,
                    url,
                    encoding: Some(ResumeSessionHistoryEncoding::Gzip),
                    raw_size,
                    encoded_size,
                },
            },
        }
    }

    fn gzip_bytes(raw: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    fn start_materializer(session: &ResumeSession) -> SessionHistoryMaterializer {
        SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            Some(session),
            CancellationToken::new(),
        )
    }

    fn assert_phase_success(phase: Option<SessionHistoryDownloadPhaseTiming>) {
        let phase = phase.expect("phase should be recorded");
        assert!(phase.success(), "phase should succeed: {phase:?}");
    }

    fn assert_phase_failure(phase: Option<SessionHistoryDownloadPhaseTiming>) {
        let phase = phase.expect("phase should be recorded");
        assert!(!phase.success(), "phase should fail: {phase:?}");
    }

    fn assert_no_phase(phase: Option<SessionHistoryDownloadPhaseTiming>) {
        assert!(phase.is_none(), "phase should not be recorded: {phase:?}");
    }

    async fn serve_once(
        status: &'static str,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
    ) -> String {
        let body = body.into();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let content_length_header = content_length
                .map(|content_length| format!("Content-Length: {content_length}\r\n"))
                .unwrap_or_default();
            let response =
                format!("HTTP/1.1 {status}\r\n{content_length_header}Connection: close\r\n\r\n");
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        });
        format!("http://{address}/history.blob?token=secret")
    }

    #[tokio::test]
    async fn materializer_downloads_and_verifies_hash() {
        let body = b"{\"type\":\"init\"}\n\xff\n";
        let hash = hex::encode(Sha256::digest(body));
        let session = ref_session(
            serve_once("200 OK", body, Some(body.len() as u64)).await,
            hash,
            body.len() as u64,
            body.len() as u64,
        );

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.cli_agent_session_id(), "sess-123");
                assert_eq!(session.history_bytes(), body);
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_success(timings.hash_verification());
            }
            _ => panic!("expected downloaded session"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_identity_ref_with_zero_size() {
        let hash = hex::encode(Sha256::digest([]));
        let session = ref_session(
            "http://127.0.0.1:9/history.blob?token=secret".to_string(),
            hash,
            0,
            0,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("rawSize must be positive"),
                    "unexpected error: {error}"
                );
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_phase_failure(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
    }

    #[tokio::test]
    async fn materializer_downloads_decompresses_and_verifies_gzip_hash() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let session = gzip_ref_session(
            serve_once("200 OK", compressed, None).await,
            hash,
            body.len() as u64,
            encoded_size,
        );

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.cli_agent_session_id(), "sess-123");
                assert_eq!(session.history_bytes(), body);
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_success(timings.hash_verification());
            }
            _ => panic!("expected downloaded session"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_gzip_body_under_declared_encoded_size_without_content_length() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let session = gzip_ref_session(
            serve_once("200 OK", compressed, None).await,
            hash,
            body.len() as u64,
            encoded_size + 1,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("downloaded size mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_body_over_declared_size_without_content_length() {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let session = ref_session(serve_once("200 OK", body, None).await, hash, 1, 1);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("downloaded size mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
    }

    #[tokio::test]
    async fn materializer_decompresses_multi_member_gzip_history() {
        let first = b"{\"type\":\"init\"}\n";
        let second = b"{\"type\":\"user\",\"message\":\"hello\"}\n";
        let body = [first.as_slice(), second.as_slice()].concat();
        let compressed = [gzip_bytes(first), gzip_bytes(second)].concat();
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(&body));
        let session = gzip_ref_session(
            serve_once("200 OK", compressed, None).await,
            hash,
            body.len() as u64,
            encoded_size,
        );

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded { session, .. } => {
                assert_eq!(session.history_bytes(), body);
            }
            _ => panic!("expected downloaded session"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_gzip_body_over_declared_raw_size() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let session = gzip_ref_session(
            serve_once("200 OK", compressed, None).await,
            hash,
            1,
            encoded_size,
        );

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error
                        .to_string()
                        .contains("session history is too large after decompression"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
            }
            _ => panic!("expected failed materialization"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_hash_mismatch_and_redacts_url_query() {
        let expected_hash = hex::encode(Sha256::digest(b"expected"));
        let actual_hash = hex::encode(Sha256::digest(b"actual"));
        let session = ref_session(
            serve_once("200 OK", b"actual", Some(6)).await,
            expected_hash.clone(),
            6,
            6,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                let message = error.to_string();
                assert!(message.contains("hash mismatch"));
                assert!(!message.contains("token=secret"));
                assert!(!message.contains(&expected_hash));
                assert!(!message.contains(&actual_hash));
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_failure(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
    }

    #[tokio::test]
    async fn materializer_redacts_url_query_from_http_status_error() {
        let session = ref_session(
            serve_once("403 Forbidden", b"no", Some(2)).await,
            hex::encode(Sha256::digest(b"no")),
            2,
            2,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                let message = error.to_string();
                assert!(message.contains("history.blob?<redacted>"));
                assert!(!message.contains("token=secret"));
                assert_phase_failure(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_oversized_content_length() {
        let session = ref_session(
            serve_once("200 OK", b"", Some(RESUME_SESSION_HISTORY_MAX_BYTES + 1)).await,
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(error.to_string().contains("too large"));
                assert_phase_success(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_phase_failure(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
    }

    #[tokio::test]
    async fn materializer_records_body_read_failure_timing() {
        let session = ref_session(
            serve_once("200 OK", b"short", Some(999)).await,
            hex::encode(Sha256::digest(b"short")),
            999,
            999,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { timings, .. } => {
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
    }

    #[test]
    fn redact_url_query_preserves_fragment() {
        assert_eq!(
            redact_url_query("https://r2.example.com/blob?sig=secret#frag"),
            "https://r2.example.com/blob?<redacted>#frag"
        );
    }

    #[tokio::test]
    async fn materializer_reports_cancelled_download() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let shutdown_for_server = shutdown.clone();
        let server = tokio::spawn(async move {
            tokio::select! {
                accepted = listener.accept() => {
                    let (_stream, _) = accepted.unwrap();
                    shutdown_for_server.cancelled().await;
                }
                _ = shutdown_for_server.cancelled() => {}
            }
        });
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();

        let result = start_materializer(&session).finish(&cancel).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(error.to_string().contains("cancelled"));
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected cancelled download"),
        }
        shutdown.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropping_materializer_aborts_pending_download() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_received_tx, request_received_rx) = oneshot::channel();
        let (connection_closed_tx, connection_closed_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let _ = request_received_tx.send(());
            let mut buf = [0u8; 1];
            let closed = stream.read(&mut buf).await;
            let _ = connection_closed_tx.send(closed);
        });
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );

        let materializer = start_materializer(&session);
        tokio::time::timeout(Duration::from_secs(5), request_received_rx)
            .await
            .unwrap()
            .unwrap();
        drop(materializer);

        let closed = tokio::time::timeout(Duration::from_secs(5), connection_closed_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(closed, 0);
    }

    #[tokio::test]
    async fn cancellable_materializer_aborts_pending_download_before_finish() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_received_tx, request_received_rx) = oneshot::channel();
        let (connection_closed_tx, connection_closed_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let _ = request_received_tx.send(());
            let mut buf = [0u8; 1];
            let closed = stream.read(&mut buf).await;
            let _ = connection_closed_tx.send(closed);
        });
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );
        let cancel = CancellationToken::new();

        let materializer = SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            Some(&session),
            cancel.clone(),
        );
        tokio::time::timeout(Duration::from_secs(5), request_received_rx)
            .await
            .unwrap()
            .unwrap();
        cancel.cancel();

        let closed = tokio::time::timeout(Duration::from_secs(5), connection_closed_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(closed, 0);
        let result = materializer.finish(&CancellationToken::new()).await;
        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(error.to_string().contains("cancelled"));
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected cancelled download"),
        }
    }

    #[tokio::test]
    async fn cancellable_materializer_does_not_request_when_already_cancelled() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let session = gzip_ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            0,
            0,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();

        let materializer = SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            Some(&session),
            cancel.clone(),
        );
        let result = materializer.finish(&cancel).await;
        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(error.to_string().contains("cancelled"));
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.hash_verification());
                assert_eq!(timings.encoding(), Some("gzip"));
            }
            _ => panic!("expected cancelled download"),
        }
        let accept_error = listener.accept().unwrap_err();
        assert_eq!(accept_error.kind(), io::ErrorKind::WouldBlock);
    }

    #[tokio::test]
    async fn finish_prefers_cancel_over_completed_download_task() {
        let task = tokio::spawn(async {
            SessionHistoryDownloadTaskResult {
                elapsed: Duration::from_millis(1),
                timings: SessionHistoryDownloadTimings::default(),
                result: Ok(MaterializedResumeSession::new(
                    "sess-123".to_string(),
                    br#"{"type":"init"}"#.to_vec(),
                )),
            }
        });
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let materializer = SessionHistoryMaterializer {
            state: SessionHistoryMaterializerState::Downloading {
                started_at: Instant::now(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                task: Some(task),
            },
        };

        let result = materializer.finish(&cancel).await;
        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("cancelled"));
            }
            _ => panic!("expected cancelled download"),
        }
    }

    #[tokio::test]
    async fn finish_prefers_cancel_when_task_cancels_during_join() {
        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        let task = tokio::spawn(async move {
            cancel_for_task.cancel();
            SessionHistoryDownloadTaskResult {
                elapsed: Duration::from_millis(1),
                timings: SessionHistoryDownloadTimings::default(),
                result: Ok(MaterializedResumeSession::new(
                    "sess-123".to_string(),
                    br#"{"type":"init"}"#.to_vec(),
                )),
            }
        });
        let materializer = SessionHistoryMaterializer {
            state: SessionHistoryMaterializerState::Downloading {
                started_at: Instant::now(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                task: Some(task),
            },
        };

        let result = materializer.finish(&cancel).await;
        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("cancelled"));
            }
            _ => panic!("expected cancelled download"),
        }
    }
}
