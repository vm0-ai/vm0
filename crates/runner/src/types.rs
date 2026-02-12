use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResponse {
    pub job: Option<Job>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub run_id: Uuid,
}

// ---------------------------------------------------------------------------
// Claim (execution context)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContext {
    pub run_id: Uuid,
    pub prompt: String,
    #[serde(default)]
    pub vars: Option<HashMap<String, String>>,
    pub sandbox_token: String,
    pub working_dir: String,
    #[serde(default)]
    pub storage_manifest: Option<StorageManifest>,
    #[serde(default)]
    pub environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub resume_session: Option<ResumeSession>,
    #[serde(default)]
    pub secret_values: Option<Vec<String>>,
    pub cli_agent_type: String,
    #[serde(default)]
    pub api_start_time: Option<f64>,
    /// User's timezone preference (IANA format, e.g., "Asia/Shanghai")
    #[serde(default)]
    pub user_timezone: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageManifest {
    pub storages: Vec<StorageEntry>,
    #[serde(default)]
    pub artifact: Option<ArtifactEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub mount_path: String,
    #[serde(default)]
    pub archive_url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub mount_path: String,
    #[serde(default)]
    pub archive_url: Option<String>,
    pub vas_storage_name: String,
    pub vas_version_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSession {
    pub session_id: String,
    pub session_history: String,
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRequest {
    pub run_id: Uuid,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
