use std::collections::HashMap;

use crate::ids::RunId;

/// Job request written by `runner local submit` as a `{job_id}.job` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobRequest {
    pub(crate) job_id: RunId,
    pub(crate) prompt: String,
    pub(crate) cli_agent_type: String,
    #[serde(default)]
    pub(crate) vars: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) user_timezone: Option<String>,
    #[serde(default)]
    pub(crate) profile: Option<String>,
    /// Session ID for sandbox reuse across conversation turns.
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) feature_flags: Option<HashMap<String, bool>>,
}

/// Job response written by the runner as a `{job_id}.result` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobResponse {
    pub(crate) run_id: RunId,
    pub(crate) exit_code: i32,
    pub(crate) error: Option<String>,
}
