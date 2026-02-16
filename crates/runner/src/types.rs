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
    // TODO: remove allow(dead_code) when consumed by compose pipeline
    #[allow(dead_code)]
    #[serde(default)]
    pub agent_compose_version_id: Option<String>,
    #[serde(default)]
    pub vars: Option<HashMap<String, String>>,
    // TODO: remove allow(dead_code) when secret injection is implemented
    #[allow(dead_code)]
    #[serde(default)]
    pub secret_names: Option<Vec<String>>,
    // TODO: remove allow(dead_code) when checkpoint resume is implemented
    #[allow(dead_code)]
    #[serde(default)]
    pub checkpoint_id: Option<Uuid>,
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
    pub experimental_firewall: Option<ExperimentalFirewall>,
    // TODO: remove allow(dead_code) when mock-claude bypass is implemented
    #[allow(dead_code)]
    #[serde(default)]
    pub debug_no_mock_claude: Option<bool>,
    #[serde(default)]
    pub api_start_time: Option<f64>,
    #[serde(default)]
    pub user_timezone: Option<String>,
}

/// Firewall and proxy configuration attached to each execution.
///
/// Field names use snake_case in JSON (matching the TS zod schema).
#[derive(Debug, Deserialize)]
pub struct ExperimentalFirewall {
    pub enabled: bool,
    #[serde(default)]
    pub rules: Option<Vec<crate::proxy::FirewallRule>>,
    #[serde(default)]
    pub experimental_mitm: Option<bool>,
    #[serde(default)]
    pub experimental_seal_secrets: Option<bool>,
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
