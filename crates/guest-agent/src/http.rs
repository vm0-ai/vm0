//! HTTP client with retry logic for webhook calls and S3 uploads.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use bytes::Bytes;
use guest_common::log_warn;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;
use std::time::Duration;

const LOG_TAG: &str = "sandbox:guest-agent";

static HTTP_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(constants::HTTP_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| Client::new())
});

static UPLOAD_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| Client::new())
});

/// POST JSON to a webhook endpoint with Bearer auth, Vercel bypass, and retry.
///
/// Returns the parsed JSON response on success, or `None` if the response body
/// is empty. Returns `Err` only after all retries are exhausted.
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
                log_warn!(
                    LOG_TAG,
                    "HTTP POST failed (attempt {attempt}/{max_retries}): HTTP {}",
                    resp.status()
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
/// Uses a dedicated upload client with longer timeout.
/// Accepts `Bytes` for O(1) clone on retry.
pub async fn put_presigned(url: &str, data: Bytes, content_type: &str) -> Result<(), AgentError> {
    let max_retries = constants::HTTP_MAX_RETRIES;

    for attempt in 1..=max_retries {
        match UPLOAD_CLIENT
            .put(url)
            .header("Content-Type", content_type)
            .body(data.clone())
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                log_warn!(
                    LOG_TAG,
                    "HTTP PUT presigned failed (attempt {attempt}/{max_retries}): HTTP {}",
                    resp.status()
                );
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
