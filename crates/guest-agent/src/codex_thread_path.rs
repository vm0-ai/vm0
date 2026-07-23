//! Resolve Codex's recorded rollout path through its app-server contract.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use guest_contracts::codex_thread_id::CodexThreadId;
use guest_contracts::codex_thread_path::CodexThreadPathLookupReport;
use serde::Deserialize;
use serde_json::json;

use crate::cli::codex_app_server::{
    CodexAppServerClient, CodexAppServerConfig, CodexAppServerError,
};
use crate::paths::CANONICAL_GUEST_HOME_DIR;

const CODEX_APP_SERVER_LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Error returned when Codex cannot authoritatively resolve a thread path.
#[derive(Debug, thiserror::Error)]
pub enum CodexThreadPathLookupError {
    /// Codex app-server could not complete the lookup protocol.
    #[error("Codex app-server lookup failed")]
    AppServer(#[source] Box<CodexAppServerError>),
    /// The lookup exceeded its internal deadline.
    #[error("Codex app-server lookup timed out")]
    Timeout,
    /// Codex returned metadata for a different thread.
    #[error("Codex app-server returned a different thread")]
    WrongThread,
    /// Codex returned a thread without an on-disk path.
    #[error("Codex app-server returned a thread without a rollout path")]
    MissingPath,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadReadResponse {
    thread: ThreadReadThread,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadReadThread {
    id: String,
    path: Option<String>,
}

/// Ask the sandbox's Codex installation for its recorded path for `thread_id`.
pub async fn resolve_codex_thread_path(
    thread_id: &CodexThreadId,
) -> Result<CodexThreadPathLookupReport, CodexThreadPathLookupError> {
    let codex_home = PathBuf::from(CANONICAL_GUEST_HOME_DIR).join(".codex");
    let config = CodexAppServerConfig::new("codex", codex_home).with_child_env(
        CANONICAL_GUEST_HOME_DIR,
        &HashMap::new(),
        "",
    );
    resolve_codex_thread_path_with_config(thread_id, config, CODEX_APP_SERVER_LOOKUP_TIMEOUT).await
}

/// Resolve a thread path using an explicit app-server configuration.
///
/// This remains public for integration tests that exercise the child-process
/// boundary with the mock Codex binary.
#[doc(hidden)]
pub async fn resolve_codex_thread_path_with_config(
    thread_id: &CodexThreadId,
    config: CodexAppServerConfig,
    timeout: Duration,
) -> Result<CodexThreadPathLookupReport, CodexThreadPathLookupError> {
    let mut client = CodexAppServerClient::spawn(config)
        .map_err(|error| CodexThreadPathLookupError::AppServer(Box::new(error)))?;
    let lookup = tokio::time::timeout(timeout, lookup_with_client(&mut client, thread_id)).await;

    match lookup {
        Ok(Ok(report)) => {
            client
                .shutdown()
                .await
                .map_err(|error| CodexThreadPathLookupError::AppServer(Box::new(error)))?;
            Ok(report)
        }
        Ok(Err(error)) => {
            let _ = client.terminate().await;
            Err(error)
        }
        Err(_) => {
            let _ = client.terminate().await;
            Err(CodexThreadPathLookupError::Timeout)
        }
    }
}

async fn lookup_with_client(
    client: &mut CodexAppServerClient,
    thread_id: &CodexThreadId,
) -> Result<CodexThreadPathLookupReport, CodexThreadPathLookupError> {
    client
        .initialize()
        .await
        .map_err(|error| CodexThreadPathLookupError::AppServer(Box::new(error)))?;

    let response = match client
        .request::<ThreadReadResponse>(
            "thread/read",
            json!({
                "threadId": thread_id.as_str(),
                "includeTurns": false,
            }),
        )
        .await
    {
        Ok(response) => response,
        Err(error) if is_thread_not_found(&error, thread_id) => {
            return Ok(CodexThreadPathLookupReport::NotFound {});
        }
        Err(error) => return Err(CodexThreadPathLookupError::AppServer(Box::new(error))),
    };

    if !CodexThreadId::parse(&response.thread.id)
        .is_some_and(|response_id| &response_id == thread_id)
    {
        return Err(CodexThreadPathLookupError::WrongThread);
    }
    let path = response
        .thread
        .path
        .filter(|path| !path.is_empty())
        .ok_or(CodexThreadPathLookupError::MissingPath)?;

    Ok(CodexThreadPathLookupReport::Found { path })
}

fn is_thread_not_found(error: &CodexAppServerError, thread_id: &CodexThreadId) -> bool {
    let CodexAppServerError::Rpc {
        method,
        error: rpc_error,
        ..
    } = error
    else {
        return false;
    };

    method == "thread/read"
        && rpc_error.code == -32600
        && rpc_error.message == format!("thread not loaded: {}", thread_id.as_str())
}
