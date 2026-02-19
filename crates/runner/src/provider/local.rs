//! [`JobProvider`] backed by a local Unix domain socket.
//!
//! Each client connection represents a single job: the client sends a JSON
//! [`JobRequest`], shuts down its write end (EOF), and waits for a JSON
//! [`JobResponse`] containing the execution result.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::net::unix::OwnedWriteHalf;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use super::JobProvider;
use crate::types::ExecutionContext;

/// Max request size (64 KB).
const MAX_REQUEST_SIZE: u64 = 64 * 1024;
/// Timeout for reading job request from client.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Job request sent by the client over the Unix socket.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobRequest {
    pub(crate) prompt: String,
    pub(crate) working_dir: String,
    pub(crate) cli_agent_type: String,
    #[serde(default)]
    pub(crate) vars: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) user_timezone: Option<String>,
}

/// Job response written back to the client.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobResponse {
    pub(crate) run_id: Uuid,
    pub(crate) exit_code: i32,
    pub(crate) error: Option<String>,
}

/// [`JobProvider`] that accepts jobs over a local Unix domain socket.
///
/// Each incoming connection is treated as a single job request. The client
/// writes a JSON-encoded [`JobRequest`], shuts down its write end (EOF),
/// and waits for a JSON-encoded [`JobResponse`].
/// Lock ordering: always acquire `state` before `streams`.
/// `discover()` holds `state` for its entire loop and briefly locks `streams`
/// to insert write halves. `claim()` only locks `state`. `complete()` only
/// locks `streams`. Never acquire `state` while holding `streams`.
pub struct LocalProvider {
    state: tokio::sync::Mutex<LocalState>,
    streams: tokio::sync::Mutex<HashMap<Uuid, OwnedWriteHalf>>,
    cancel: CancellationToken,
    sock_path: PathBuf,
}

struct LocalState {
    listener: UnixListener,
    pending: HashMap<Uuid, ExecutionContext>,
}

impl LocalProvider {
    /// Create a new local provider listening on the given Unix socket path.
    ///
    /// Removes any stale socket file before binding.
    pub async fn new(
        sock_path: PathBuf,
        cancel: CancellationToken,
    ) -> crate::error::RunnerResult<Arc<Self>> {
        // Remove stale socket file (ignore not-found)
        let _ = std::fs::remove_file(&sock_path);

        let listener = UnixListener::bind(&sock_path).map_err(|e| {
            crate::error::RunnerError::Config(format!(
                "bind local socket {}: {e}",
                sock_path.display()
            ))
        })?;

        info!(path = %sock_path.display(), "local provider listening");

        Ok(Arc::new(Self {
            state: tokio::sync::Mutex::new(LocalState {
                listener,
                pending: HashMap::new(),
            }),
            streams: tokio::sync::Mutex::new(HashMap::new()),
            cancel,
            sock_path,
        }))
    }
}

#[async_trait::async_trait]
impl JobProvider for LocalProvider {
    async fn discover(&self) -> Option<Uuid> {
        let mut state = self.state.lock().await;
        loop {
            if self.cancel.is_cancelled() {
                return None;
            }

            let stream = tokio::select! {
                () = self.cancel.cancelled() => return None,
                result = state.listener.accept() => {
                    match result {
                        Ok((stream, _addr)) => stream,
                        Err(e) => {
                            warn!(error = %e, "local: accept failed");
                            continue;
                        }
                    }
                }
            };

            // Read request with timeout + size limit.
            // Client must send JSON then shut down its write end (EOF).
            let (read_half, write_half) = stream.into_split();
            let read_result = tokio::time::timeout(READ_TIMEOUT, async {
                let mut buf = Vec::with_capacity(4096);
                read_half
                    .take(MAX_REQUEST_SIZE)
                    .read_to_end(&mut buf)
                    .await
                    .map(|_| buf)
            })
            .await;

            let buf = match read_result {
                Ok(Ok(buf)) => buf,
                Ok(Err(e)) => {
                    warn!(error = %e, "local: read failed");
                    continue;
                }
                Err(_) => {
                    warn!("local: read timed out");
                    continue;
                }
            };

            let req: JobRequest = match serde_json::from_slice(&buf) {
                Ok(r) => r,
                Err(e) => {
                    warn!(error = %e, "local: invalid request JSON");
                    continue;
                }
            };

            let run_id = Uuid::new_v4();
            let context = ExecutionContext {
                run_id,
                prompt: req.prompt,
                agent_compose_version_id: None,
                vars: req.vars,
                secret_names: None,
                checkpoint_id: None,
                sandbox_token: String::new(),
                working_dir: req.working_dir,
                storage_manifest: None,
                environment: req.environment,
                resume_session: None,
                secret_values: None,
                cli_agent_type: req.cli_agent_type,
                experimental_firewall: None,
                debug_no_mock_claude: None,
                api_start_time: None,
                user_timezone: req.user_timezone,
            };

            info!(run_id = %run_id, "local: job received");
            state.pending.insert(run_id, context);
            self.streams.lock().await.insert(run_id, write_half);
            return Some(run_id);
        }
    }

    async fn claim(&self, run_id: Uuid) -> Option<ExecutionContext> {
        self.state.lock().await.pending.remove(&run_id)
    }

    async fn complete(&self, run_id: Uuid, exit_code: i32, error: Option<&str>) {
        let write_half = self.streams.lock().await.remove(&run_id);
        let Some(mut writer) = write_half else {
            warn!(run_id = %run_id, "local: no stream for completion");
            return;
        };

        let response = JobResponse {
            run_id,
            exit_code,
            error: error.map(String::from),
        };

        let json = match serde_json::to_vec(&response) {
            Ok(j) => j,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to serialize response");
                return;
            }
        };

        if let Err(e) = writer.write_all(&json).await {
            warn!(run_id = %run_id, error = %e, "local: write response failed");
            return;
        }
        if let Err(e) = writer.shutdown().await {
            warn!(run_id = %run_id, error = %e, "local: shutdown write failed");
        }
    }

    /// # Ordering requirement
    ///
    /// `discover()` holds the state Mutex for its entire loop.
    /// Callers must cancel the `CancellationToken` *before* calling
    /// `shutdown()` so that `discover()` observes the cancellation,
    /// returns `None`, and releases the lock.
    async fn shutdown(&self) {
        let _ = std::fs::remove_file(&self.sock_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    #[tokio::test]
    async fn local_provider_discover_claim_complete() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(sock_path.clone(), cancel).await.unwrap();

        // Client connects and sends request
        let client = tokio::spawn({
            let sock_path = sock_path.clone();
            async move {
                let mut stream = UnixStream::connect(&sock_path).await.unwrap();
                let req = serde_json::json!({
                    "prompt": "hello world",
                    "working_dir": "/tmp/test",
                    "cli_agent_type": "test-agent"
                });
                stream
                    .write_all(serde_json::to_string(&req).unwrap().as_bytes())
                    .await
                    .unwrap();
                stream.shutdown().await.unwrap();

                // Read response
                let mut buf = Vec::new();
                stream.read_to_end(&mut buf).await.unwrap();
                serde_json::from_slice::<JobResponse>(&buf).unwrap()
            }
        });

        // Provider discovers and claims
        let run_id = provider.discover().await.unwrap();
        let ctx = provider.claim(run_id).await.unwrap();
        assert_eq!(ctx.run_id, run_id);
        assert_eq!(ctx.prompt, "hello world");
        assert_eq!(ctx.working_dir, "/tmp/test");
        assert_eq!(ctx.cli_agent_type, "test-agent");

        // Complete the job
        provider.complete(run_id, 0, None).await;

        // Verify client received response
        let response = client.await.unwrap();
        assert_eq!(response.run_id, run_id);
        assert_eq!(response.exit_code, 0);
        assert!(response.error.is_none());
    }

    #[tokio::test]
    async fn local_provider_shutdown_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(sock_path, cancel.clone()).await.unwrap();

        cancel.cancel();
        assert!(provider.discover().await.is_none());
    }

    #[tokio::test]
    async fn local_provider_invalid_json_continues() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(sock_path.clone(), cancel).await.unwrap();

        // First client sends garbage
        let sock = sock_path.clone();
        tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            stream.write_all(b"not json at all").await.unwrap();
            stream.shutdown().await.unwrap();
        });

        // Second client sends valid request (delayed to ensure ordering)
        let sock = sock_path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            let req = serde_json::json!({"prompt": "valid", "working_dir": "/workspace", "cli_agent_type": "claude-code"});
            stream
                .write_all(serde_json::to_string(&req).unwrap().as_bytes())
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
        });

        let run_id = provider.discover().await.unwrap();
        let ctx = provider.claim(run_id).await.unwrap();
        assert_eq!(ctx.prompt, "valid");
    }

    #[tokio::test]
    async fn local_provider_concurrent_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let cancel = CancellationToken::new();
        let provider = LocalProvider::new(sock_path.clone(), cancel).await.unwrap();

        // Client 1
        let sock = sock_path.clone();
        let client1 = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            let req = serde_json::json!({"prompt": "job1", "working_dir": "/workspace", "cli_agent_type": "claude-code"});
            stream
                .write_all(serde_json::to_string(&req).unwrap().as_bytes())
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            serde_json::from_slice::<JobResponse>(&buf).unwrap()
        });

        // Discover + claim job 1
        let run_id1 = provider.discover().await.unwrap();
        let ctx1 = provider.claim(run_id1).await.unwrap();
        assert_eq!(ctx1.prompt, "job1");

        // Client 2
        let sock = sock_path.clone();
        let client2 = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            let req = serde_json::json!({"prompt": "job2", "working_dir": "/workspace", "cli_agent_type": "claude-code"});
            stream
                .write_all(serde_json::to_string(&req).unwrap().as_bytes())
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            serde_json::from_slice::<JobResponse>(&buf).unwrap()
        });

        // Discover + claim job 2
        let run_id2 = provider.discover().await.unwrap();
        let ctx2 = provider.claim(run_id2).await.unwrap();
        assert_eq!(ctx2.prompt, "job2");
        assert_ne!(run_id1, run_id2);

        // Complete both
        provider.complete(run_id1, 0, None).await;
        provider.complete(run_id2, 1, Some("test error")).await;

        let resp1 = client1.await.unwrap();
        assert_eq!(resp1.exit_code, 0);
        assert!(resp1.error.is_none());

        let resp2 = client2.await.unwrap();
        assert_eq!(resp2.exit_code, 1);
        assert_eq!(resp2.error.as_deref(), Some("test error"));
    }
}
