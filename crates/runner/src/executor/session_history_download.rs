use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::types::{ResumeSession, ResumeSessionHistoryRefKind};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
// Must stay in sync with RESUME_SESSION_HISTORY_MAX_BYTES in the API contracts.
const MAX_SESSION_HISTORY_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) struct SessionHistoryMaterializer {
    state: SessionHistoryMaterializerState,
}

enum SessionHistoryMaterializerState {
    Missing,
    Ready,
    Downloading {
        started_at: Instant,
        task: Option<JoinHandle<SessionHistoryDownloadTaskResult>>,
    },
}

pub(super) enum SessionHistoryMaterialization {
    Missing,
    Ready,
    Downloaded {
        session: ResumeSession,
        elapsed: Duration,
    },
    Failed {
        elapsed: Duration,
        error: RunnerError,
    },
}

struct SessionHistoryDownloadTaskResult {
    elapsed: Duration,
    result: RunnerResult<ResumeSession>,
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
        if session.history_ref().is_none() {
            return Self {
                state: SessionHistoryMaterializerState::Ready,
            };
        }

        let http = http.clone();
        let session = session.clone();
        let started_at = Instant::now();
        Self {
            state: SessionHistoryMaterializerState::Downloading {
                started_at,
                task: Some(tokio::spawn(async move {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            SessionHistoryDownloadTaskResult::cancelled(started_at)
                        }
                        result = download_resume_session_history_timed(http, session) => result,
                    }
                })),
            },
        }
    }

    pub(crate) fn is_downloading(&self) -> bool {
        matches!(
            self.state,
            SessionHistoryMaterializerState::Downloading { .. }
        )
    }

    pub(super) async fn finish(
        mut self,
        cancel: &CancellationToken,
    ) -> SessionHistoryMaterialization {
        match &mut self.state {
            SessionHistoryMaterializerState::Missing => SessionHistoryMaterialization::Missing,
            SessionHistoryMaterializerState::Ready => SessionHistoryMaterialization::Ready,
            SessionHistoryMaterializerState::Downloading { started_at, task } => {
                let started_at = *started_at;
                if cancel.is_cancelled() {
                    return SessionHistoryDownloadTaskResult::cancelled(started_at)
                        .into_materialization();
                }
                let Some(mut task) = task.take() else {
                    return SessionHistoryMaterialization::Failed {
                        elapsed: Duration::ZERO,
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
                        SessionHistoryDownloadTaskResult::cancelled(started_at)
                    }
                    joined = &mut task => {
                        joined.unwrap_or_else(|error| {
                            SessionHistoryDownloadTaskResult {
                                elapsed: started_at.elapsed(),
                                result: Err(RunnerError::Internal(format!(
                                    "session history download task failed: {error}"
                                ))),
                            }
                        })
                    }
                };
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
            },
            Err(error) => SessionHistoryMaterialization::Failed {
                elapsed: self.elapsed,
                error,
            },
        }
    }

    fn cancelled(started_at: Instant) -> Self {
        Self {
            elapsed: started_at.elapsed(),
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
            task.abort();
        }
    }
}

async fn download_resume_session_history_timed(
    http: HttpClient,
    session: ResumeSession,
) -> SessionHistoryDownloadTaskResult {
    let started_at = Instant::now();
    let result = download_resume_session_history(http, session).await;
    SessionHistoryDownloadTaskResult {
        elapsed: started_at.elapsed(),
        result,
    }
}

async fn download_resume_session_history(
    http: HttpClient,
    session: ResumeSession,
) -> RunnerResult<ResumeSession> {
    let history_ref = session
        .history_ref()
        .ok_or_else(|| RunnerError::Internal("resume session history ref is missing".into()))?
        .clone();
    match history_ref.kind {
        ResumeSessionHistoryRefKind::Blob => {}
    }
    if let Some(expected_size) = history_ref.size
        && expected_size > MAX_SESSION_HISTORY_BYTES
    {
        return Err(RunnerError::Internal(format!(
            "session history is too large: {expected_size} bytes exceeds {MAX_SESSION_HISTORY_BYTES} bytes"
        )));
    }

    let bytes = download_body(&http, &history_ref.url, history_ref.size).await?;
    if let Some(expected_size) = history_ref.size
        && bytes.len() as u64 != expected_size
    {
        return Err(RunnerError::Internal(format!(
            "session history size mismatch: expected {expected_size} bytes, got {} bytes",
            bytes.len()
        )));
    }

    let actual_hash = hex::encode(Sha256::digest(&bytes));
    if actual_hash != history_ref.hash {
        return Err(RunnerError::Internal(
            "session history hash mismatch".into(),
        ));
    }

    let session_history = String::from_utf8(bytes)
        .map_err(|error| RunnerError::Internal(format!("session history is not utf-8: {error}")))?;
    Ok(ResumeSession::inline(
        session.cli_agent_session_id,
        session_history,
    ))
}

async fn download_body(
    http: &HttpClient,
    url: &str,
    expected_size: Option<u64>,
) -> RunnerResult<Vec<u8>> {
    let mut response = http
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
        })?;

    if let Some(content_length) = response.content_length() {
        if content_length > MAX_SESSION_HISTORY_BYTES {
            return Err(RunnerError::Internal(format!(
                "session history is too large: {content_length} bytes exceeds {MAX_SESSION_HISTORY_BYTES} bytes"
            )));
        }
        if let Some(expected_size) = expected_size
            && content_length != expected_size
        {
            return Err(RunnerError::Internal(format!(
                "session history content-length mismatch: expected {expected_size} bytes, got {content_length} bytes"
            )));
        }
    }

    let capacity = expected_size
        .unwrap_or(64 * 1024)
        .min(MAX_SESSION_HISTORY_BYTES)
        .min(usize::MAX as u64) as usize;
    let mut body = Vec::with_capacity(capacity);
    let mut downloaded = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        RunnerError::Internal(format!(
            "read {}: {}",
            redact_url_query(url),
            error.without_url()
        ))
    })? {
        downloaded += chunk.len() as u64;
        if downloaded > MAX_SESSION_HISTORY_BYTES {
            return Err(RunnerError::Internal(format!(
                "session history is too large: {downloaded} bytes exceeds {MAX_SESSION_HISTORY_BYTES} bytes"
            )));
        }
        body.extend_from_slice(&chunk);
    }

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
    use std::io;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    use super::*;
    use crate::http::{HttpClient, HttpClientConfig};
    use crate::types::{
        ResumeSessionHistory, ResumeSessionHistoryRef, ResumeSessionHistoryRefKind,
    };

    fn http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://api.test".to_string(),
            vercel_bypass: None,
        })
        .unwrap()
    }

    fn ref_session(url: String, hash: String, size: Option<u64>) -> ResumeSession {
        ResumeSession {
            cli_agent_session_id: "sess-123".to_string(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash,
                    url,
                    size,
                },
            },
        }
    }

    fn start_materializer(session: &ResumeSession) -> SessionHistoryMaterializer {
        SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            Some(session),
            CancellationToken::new(),
        )
    }

    async fn serve_once(
        status: &'static str,
        body: &'static [u8],
        content_length: Option<u64>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let content_length = content_length.unwrap_or(body.len() as u64);
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
        });
        format!("http://{address}/history.blob?token=secret")
    }

    #[tokio::test]
    async fn materializer_downloads_and_verifies_hash() {
        let body = br#"{"type":"init"}"#;
        let hash = hex::encode(Sha256::digest(body));
        let session = ref_session(
            serve_once("200 OK", body, Some(body.len() as u64)).await,
            hash,
            Some(body.len() as u64),
        );

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded { session, .. } => {
                assert_eq!(session.cli_agent_session_id, "sess-123");
                assert_eq!(session.session_history(), Some(r#"{"type":"init"}"#));
            }
            _ => panic!("expected downloaded session"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_hash_mismatch_and_redacts_url_query() {
        let expected_hash = hex::encode(Sha256::digest(b"expected"));
        let actual_hash = hex::encode(Sha256::digest(b"actual"));
        let session = ref_session(
            serve_once("200 OK", b"actual", Some(6)).await,
            expected_hash.clone(),
            Some(6),
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                let message = error.to_string();
                assert!(message.contains("hash mismatch"));
                assert!(!message.contains("token=secret"));
                assert!(!message.contains(&expected_hash));
                assert!(!message.contains(&actual_hash));
            }
            _ => panic!("expected failed download"),
        }
    }

    #[tokio::test]
    async fn materializer_redacts_url_query_from_http_status_error() {
        let session = ref_session(
            serve_once("403 Forbidden", b"no", Some(2)).await,
            hex::encode(Sha256::digest(b"no")),
            Some(2),
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                let message = error.to_string();
                assert!(message.contains("history.blob?<redacted>"));
                assert!(!message.contains("token=secret"));
            }
            _ => panic!("expected failed download"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_oversized_content_length() {
        let session = ref_session(
            serve_once("200 OK", b"", Some(MAX_SESSION_HISTORY_BYTES + 1)).await,
            hex::encode(Sha256::digest(b"")),
            None,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("too large"));
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
            None,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();

        let result = start_materializer(&session).finish(&cancel).await;

        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("cancelled"));
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
            None,
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
            None,
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
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("cancelled"));
            }
            _ => panic!("expected cancelled download"),
        }
    }

    #[tokio::test]
    async fn cancellable_materializer_does_not_request_when_already_cancelled() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            None,
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
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("cancelled"));
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
                result: Ok(ResumeSession::inline(
                    "sess-123".to_string(),
                    r#"{"type":"init"}"#.to_string(),
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
