//! Bounded per-run model-provider failure state.

use std::path::Path;

use api_contracts::generated::types::runners::runs::model_provider_failures::{
    Request, RequestFailureKind,
};
use serde::Deserialize;

use crate::error::{RunnerError, RunnerResult};
use crate::state_file::{self, OwnerCheck};

const MODEL_PROVIDER_FAILURE_MAX_BYTES: u64 = 1024;
const RETRY_AFTER_MAX_SECONDS: i64 = 300;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailureSummary {
    failure_kind: RequestFailureKind,
    #[serde(default)]
    retry_after_seconds: Option<i64>,
}

pub(crate) async fn take(path: &Path) -> RunnerResult<Option<Request>> {
    let content = state_file::read_to_string(
        path,
        MODEL_PROVIDER_FAILURE_MAX_BYTES,
        OwnerCheck::CurrentEuid,
    )
    .await;
    remove(path).await?;
    let Some(content) = content? else {
        return Ok(None);
    };
    let summary: FailureSummary = serde_json::from_str(&content).map_err(|error| {
        RunnerError::Internal(format!(
            "parse model provider failure state {}: {error}",
            path.display()
        ))
    })?;
    if summary
        .retry_after_seconds
        .is_some_and(|seconds| !(1..=RETRY_AFTER_MAX_SECONDS).contains(&seconds))
    {
        return Err(RunnerError::Internal(format!(
            "model provider failure state {} has retryAfterSeconds outside 1..={RETRY_AFTER_MAX_SECONDS}",
            path.display()
        )));
    }
    Ok(Some(Request {
        failure_kind: summary.failure_kind,
        retry_after_seconds: summary.retry_after_seconds,
    }))
}

pub(crate) async fn remove(path: &Path) -> RunnerResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RunnerError::Internal(format!(
            "remove model provider failure state {}: {error}",
            path.display()
        ))),
    }
}
