use std::collections::HashMap;

use sandbox::SandboxId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use api_contracts::generated::types::runners::storage::StorageManifest;

use crate::ids::RunId;

pub(crate) const MAX_HELD_SESSION_STATES: usize = 1024;
pub(crate) const SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG: &str = "sessionWorkspaceImageCache";

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
    pub run_id: RunId,
    #[serde(default)]
    pub experimental_profile: Option<String>,
}

// ---------------------------------------------------------------------------
// Claim (execution context)
// Keep in sync with TS: turbo/packages/api-contracts/src/contracts/runners.ts → executionContextSchema
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContext {
    pub run_id: RunId,
    pub prompt: String,
    #[serde(default)]
    pub append_system_prompt: Option<String>,
    // Agent compose version ID (full SHA-256 content hash).
    // Deserialized for forward compatibility but not consumed by runner.
    #[serde(default, rename = "agentComposeVersionId")]
    pub _agent_compose_version_id: Option<String>,
    // Vars are passed to the proxy registry for auth header template resolution.
    #[serde(default)]
    pub vars: Option<HashMap<String, String>>,
    // Checkpoint resume not yet implemented
    #[allow(dead_code)]
    #[serde(default)]
    pub checkpoint_id: Option<Uuid>,
    pub sandbox_token: String,
    #[serde(default)]
    pub storage_manifest: Option<StorageManifest>,
    #[serde(default)]
    pub environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub resume_session: Option<ResumeSession>,
    // Plain secret values used only for redaction. These are values, not names.
    #[serde(default)]
    pub secret_values: Option<Vec<String>>,
    // Encrypted runtime secret namespace forwarded to mitm-addon for auth
    // resolution. Decrypted keys match `${{ secrets.NAME }}` names; connector
    // and model-provider keys are env aliases, not storage secret names.
    #[serde(default)]
    pub encrypted_secrets: Option<String>,
    // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`)
    // to their connector or provider owner. Keys are env aliases, not storage secret names.
    #[serde(default)]
    pub secret_connector_map: Option<HashMap<String, String>>,
    // Same keys as secret_connector_map; adds source details when the owner
    // alone is not enough to locate access storage.
    #[serde(default)]
    pub secret_connector_metadata_map: Option<HashMap<String, SecretConnectorMetadata>>,
    pub cli_agent_type: String,
    #[serde(default)]
    pub debug_no_mock_claude: Option<bool>,
    #[serde(default)]
    pub debug_no_mock_codex: Option<bool>,
    #[serde(default)]
    pub api_start_time: Option<u64>,
    #[serde(default)]
    pub user_timezone: Option<String>,
    #[serde(default)]
    pub capture_network_bodies: Option<bool>,
    #[serde(default)]
    pub firewalls: Option<Vec<Firewall>>,
    #[serde(default)]
    pub network_policies: Option<std::collections::HashMap<String, NetworkPolicy>>,
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub settings: Option<String>,
    // Profile selection — handled by api provider at discover time, not read on ExecutionContext
    #[allow(dead_code)]
    #[serde(default)]
    pub experimental_profile: Option<String>,
    // Feature flags evaluated at job creation time (all switch states for user/org)
    #[serde(default)]
    pub feature_flags: Option<HashMap<String, bool>>,
    #[serde(default)]
    pub billable_firewalls: Vec<String>,
    #[serde(default)]
    pub model_usage_provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretConnectorMetadata {
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_key: Option<String>,
}

/// A single firewall config with its name and API entries.
/// `name` is the canonical identifier (also used as the networkPolicies map key).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Firewall {
    pub name: String,
    pub apis: Vec<FirewallApi>,
}

/// A single firewall API entry with base URL and auth headers for proxy-side matching.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FirewallApi {
    /// Unique identifier for cache keying in mitm-addon. Generated by the
    /// runner at registry-write time (not supplied by the web API).
    #[serde(default)]
    pub id: String,
    pub base: String,
    pub auth: FirewallAuth,
    #[serde(default)]
    pub permissions: Option<Vec<FirewallPermission>>,
}

/// A named permission group with matching rules for request authorization.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FirewallPermission {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub rules: Vec<String>,
}

/// Auth configuration for a firewall API entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FirewallAuth {
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    /// Optional base URL template for URL rewriting (e.g. webhook-url connectors).
    /// When set, the proxy rewrites the request URL instead of injecting headers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Optional query parameters with secret/var templates for query-param auth.
    /// When set, the proxy injects resolved query params into the request URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<std::collections::HashMap<String, String>>,
}

/// Per-firewall grant configuration: which permissions are authorized and
/// what policy applies to unknown endpoints (not matching any rule).
/// Refs absent from the map are fully permissive (all granted + allow unknown).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    /// Permission names granted by the user.
    pub allow: Vec<String>,
    /// Permission names explicitly denied by the admin.
    pub deny: Vec<String>,
    /// Permission names requiring user approval before use.
    pub ask: Vec<String>,
    /// Policy for requests not matching any known permission rule.
    /// Values: "allow", "deny", "ask"
    pub unknown_policy: String,
}

/// Runner-derived manifest written to `guest-download`.
///
/// This is intentionally separate from the API `StorageManifest`: `cached`,
/// nullable `archive_url`, and `cleanup_paths` are computed by the runner.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDownloadManifest {
    pub storages: Vec<GuestDownloadStorageEntry>,
    #[serde(default)]
    pub artifacts: Vec<GuestDownloadArtifactEntry>,
    /// Paths to clean before downloading (computed from previous fingerprints).
    /// Used on VM reuse to remove stale files from changed/removed storages.
    #[serde(default)]
    pub cleanup_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDownloadStorageEntry {
    pub mount_path: String,
    pub archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions_target_filename: Option<String>,
    /// Whether this entry is cached from a previous turn (fingerprint matched).
    /// When true, `archive_url` is intentionally `None` — the guest should
    /// preserve existing files at this mount path during cleanup.
    pub cached: bool,
    pub vas_storage_name: String,
    pub vas_version_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDownloadArtifactEntry {
    pub mount_path: String,
    pub archive_url: Option<String>,
    /// Whether this entry is cached from a previous turn (fingerprint matched).
    pub cached: bool,
    pub vas_storage_name: String,
    pub vas_storage_id: String,
    pub vas_version_id: String,
}

impl From<&StorageManifest> for GuestDownloadManifest {
    fn from(manifest: &StorageManifest) -> Self {
        Self {
            storages: manifest
                .storages
                .iter()
                .map(|storage| GuestDownloadStorageEntry {
                    mount_path: storage.mount_path.clone(),
                    archive_url: Some(storage.archive_url.clone()),
                    instructions_target_filename: storage.instructions_target_filename.clone(),
                    cached: false,
                    vas_storage_name: storage.vas_storage_name.clone(),
                    vas_version_id: storage.vas_version_id.clone(),
                })
                .collect(),
            artifacts: manifest
                .artifacts
                .iter()
                .map(|artifact| GuestDownloadArtifactEntry {
                    mount_path: artifact.mount_path.clone(),
                    archive_url: Some(artifact.archive_url.clone()),
                    cached: false,
                    vas_storage_name: artifact.vas_storage_name.clone(),
                    vas_storage_id: artifact.vas_storage_id.clone(),
                    vas_version_id: artifact.vas_version_id.clone(),
                })
                .collect(),
            cleanup_paths: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSession {
    pub session_id: String,
    pub session_history: String,
}

impl ExecutionContext {
    /// Extract the session ID from `resume_session` for sandbox reuse.
    ///
    /// Returns `Some` for continued sessions. For first runs this returns
    /// `None`; the executor reads the CLI-generated session ID from the
    /// guest filesystem post-execution (see `read_guest_session_id`).
    pub fn session_id(&self) -> Option<&str> {
        self.resume_session.as_ref().map(|r| r.session_id.as_str())
    }

    pub fn session_workspace_image_cache_enabled(&self) -> bool {
        self.feature_flags
            .as_ref()
            .and_then(|flags| flags.get(SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG))
            .copied()
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/// Runner state snapshot sent to the server via heartbeat.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeldSessionState {
    pub session_id: String,
    pub last_completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatState {
    pub runner_id: String,
    pub runner_name: String,
    pub group: String,
    pub profiles: Vec<String>,
    pub total_vcpu: u32,
    pub total_memory_mb: u32,
    pub max_concurrent: usize,
    pub allocated_vcpu: u32,
    pub allocated_memory_mb: u32,
    pub running_count: usize,
    pub held_session_states: Vec<HeldSessionState>,
    pub mode: String,
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRequest {
    pub run_id: RunId,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Sandbox the run executed against. `None` when no sandbox was
    /// provisioned (e.g. a pre-claim failure); otherwise set on every
    /// completion regardless of reuse status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<SandboxId>,
    /// Outcome of the sandbox-reuse decision made before this run started.
    /// `None` is reserved for callers that cannot determine it (tests, future
    /// transports); the runner itself always sets this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_reuse_result: Option<SandboxReuseResult>,
}

/// Outcome of the sandbox-reuse decision made at job dispatch time. `Reused`
/// means the VM was unparked from the idle pool; the other variants name the
/// branch that caused a fresh create. Wire name: `sandboxReuseResult`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SandboxReuseResult {
    Reused,
    NoSessionId,
    PoolMiss,
    ProfileMismatch,
    DeviceLimitMismatch,
    UnparkFailed,
}

impl SandboxReuseResult {
    /// Wire-format string, kept lockstep with the `#[serde(rename_all =
    /// "camelCase")]` derive via `as_wire_matches_serde_serialization`.
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Reused => "reused",
            Self::NoSessionId => "noSessionId",
            Self::PoolMiss => "poolMiss",
            Self::ProfileMismatch => "profileMismatch",
            Self::DeviceLimitMismatch => "deviceLimitMismatch",
            Self::UnparkFailed => "unparkFailed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::types::runners::storage::{ArtifactEntry, StorageEntry};
    use serde_json::json;

    #[test]
    fn poll_response_with_job() {
        let json = json!({
            "job": {
                "runId": "550e8400-e29b-41d4-a716-446655440000",
                "experimentalProfile": "browser"
            }
        });
        let resp: PollResponse = serde_json::from_value(json).unwrap();
        let job = resp.job.unwrap();
        assert_eq!(
            job.run_id,
            "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap()
        );
        assert_eq!(job.experimental_profile.as_deref(), Some("browser"));
    }

    #[test]
    fn poll_response_no_job() {
        let json = json!({ "job": null });
        let resp: PollResponse = serde_json::from_value(json).unwrap();
        assert!(resp.job.is_none());
    }

    #[test]
    fn job_optional_profile_defaults_to_none() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000"
        });
        let job: Job = serde_json::from_value(json).unwrap();
        assert!(job.experimental_profile.is_none());
    }

    #[test]
    fn execution_context_minimal() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok-123",
            "cliAgentType": "claude_code",
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert_eq!(ctx.prompt, "hello");
        assert_eq!(ctx.sandbox_token, "tok-123");
        assert_eq!(ctx.cli_agent_type, "claude_code");
        assert!(ctx.append_system_prompt.is_none());
        assert!(ctx.vars.is_none());
        assert!(ctx.firewalls.is_none());
        assert!(ctx.secret_values.is_none());
        assert!(ctx.billable_firewalls.is_empty());
        assert!(ctx.model_usage_provider.is_none());
    }

    #[test]
    fn execution_context_all_optional_fields() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "analyze code",
            "sandboxToken": "tok-456",
            "cliAgentType": "claude_code",
            "appendSystemPrompt": "be concise",
            "agentComposeVersionId": "sha256-abc",
            "vars": {"API_KEY": "secret"},
            "checkpointId": "660e8400-e29b-41d4-a716-446655440000",
            "storageManifest": {
                "storages": [{
                    "name": "data",
                    "mountPath": "/data",
                    "vasStorageName": "data",
                    "vasVersionId": "v1",
                    "archiveUrl": "https://s3/archive.tar.gz"
                }],
                "artifacts": [{
                    "mountPath": "/artifacts",
                    "archiveUrl": "https://s3/artifact.tar.gz",
                    "vasStorageName": "art-1",
                    "vasStorageId": "sid-1",
                    "vasVersionId": "v1"
                }]
            },
            "environment": {"NODE_ENV": "production"},
            "resumeSession": {"sessionId": "sess-1", "sessionHistory": "/tmp/history"},
            "secretValues": ["s1", "s2"],
            "encryptedSecrets": "enc-blob",
            "secretConnectorMap": {"GITHUB_TOKEN": "github"},
            "secretConnectorMetadataMap": {
                "CHATGPT_ACCESS_TOKEN": {
                    "sourceType": "model-provider",
                    "sourceUserId": "user-123",
                    "metadataKey": "codex-oauth-token"
                }
            },
            "debugNoMockClaude": true,
            "debugNoMockCodex": true,
            "apiStartTime": 1_700_000_000_000u64,
            "userTimezone": "America/New_York",
            "firewalls": [{
                "name": "github",
                "apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}]
            }],
            "disallowedTools": ["CronCreate"],
            "tools": ["Bash", "Read"],
            "settings": "{\"hooks\":{}}",
            "experimentalProfile": "browser",
            "featureFlags": {"computerUse": true, "audioOutput": false},
            "billableFirewalls": ["model-provider:vm0"],
            "modelUsageProvider": "claude-sonnet-4-6"
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert_eq!(ctx.append_system_prompt.as_deref(), Some("be concise"));
        assert_eq!(ctx.vars.as_ref().unwrap()["API_KEY"], "secret");
        assert_eq!(ctx.environment.as_ref().unwrap()["NODE_ENV"], "production");
        assert_eq!(ctx.resume_session.as_ref().unwrap().session_id, "sess-1");
        assert_eq!(ctx.secret_values.as_ref().unwrap().len(), 2);
        assert_eq!(ctx.encrypted_secrets.as_deref(), Some("enc-blob"));
        let metadata = ctx.secret_connector_metadata_map.as_ref().unwrap();
        assert_eq!(
            metadata["CHATGPT_ACCESS_TOKEN"].source_user_id.as_deref(),
            Some("user-123")
        );
        assert!(ctx.debug_no_mock_claude.unwrap());
        assert!(ctx.debug_no_mock_codex.unwrap());
        assert_eq!(ctx.api_start_time, Some(1_700_000_000_000));
        assert_eq!(ctx.firewalls.as_ref().unwrap()[0].name, "github");
        assert_eq!(ctx.disallowed_tools.as_ref().unwrap(), &["CronCreate"]);
        assert_eq!(ctx.tools.as_ref().unwrap(), &["Bash", "Read"]);
        assert_eq!(ctx.settings.as_deref(), Some("{\"hooks\":{}}"));
        assert!(ctx.storage_manifest.is_some());
        let flags = ctx.feature_flags.as_ref().unwrap();
        assert_eq!(flags.get("computerUse"), Some(&true));
        assert_eq!(flags.get("audioOutput"), Some(&false));
        assert_eq!(
            ctx.billable_firewalls,
            vec!["model-provider:vm0".to_string()]
        );
        assert_eq!(
            ctx.model_usage_provider.as_deref(),
            Some("claude-sonnet-4-6")
        );
    }

    #[test]
    fn firewall_round_trip() {
        let fw = Firewall {
            name: "github".into(),
            apis: vec![FirewallApi {
                id: "api-1".into(),
                base: "https://api.github.com".into(),
                auth: FirewallAuth {
                    headers: [("Authorization".into(), "Bearer tok".into())]
                        .into_iter()
                        .collect(),
                    base: None,
                    query: None,
                },
                permissions: Some(vec![FirewallPermission {
                    name: "metadata:read".into(),
                    description: Some("read repo metadata".into()),
                    rules: vec!["GET /repos/{owner}/{repo}".into()],
                }]),
            }],
        };
        let json = serde_json::to_value(&fw).unwrap();
        assert_eq!(json["name"], "github");
        // round-trip
        let deserialized: Firewall = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "github");
        assert_eq!(
            deserialized.apis[0].permissions.as_ref().unwrap()[0].name,
            "metadata:read"
        );
    }

    #[test]
    fn firewall_auth_base_omitted_when_none() {
        let auth = FirewallAuth {
            headers: HashMap::new(),
            base: None,
            query: None,
        };
        let json = serde_json::to_value(&auth).unwrap();
        assert!(json.get("base").is_none());
    }

    #[test]
    fn complete_request_camel_case() {
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 0,
            error: None,
            sandbox_id: None,
            sandbox_reuse_result: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("runId").is_some());
        assert!(json.get("exitCode").is_some());
        // optionals omitted when None
        assert!(json.get("error").is_none());
        assert!(json.get("sandboxId").is_none());
        assert!(json.get("sandboxReuseResult").is_none());
    }

    #[test]
    fn complete_request_with_error() {
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 1,
            error: Some("timeout".into()),
            sandbox_id: None,
            sandbox_reuse_result: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["error"], "timeout");
    }

    #[test]
    fn complete_request_with_reuse_fields() {
        let sid: SandboxId = "11111111-2222-3333-4444-555555555555".parse().unwrap();
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 0,
            error: None,
            sandbox_id: Some(sid),
            sandbox_reuse_result: Some(SandboxReuseResult::Reused),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["sandboxId"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(json["sandboxReuseResult"], "reused");
    }

    #[test]
    fn sandbox_reuse_result_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::NoSessionId).unwrap(),
            serde_json::json!("noSessionId"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::PoolMiss).unwrap(),
            serde_json::json!("poolMiss"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::ProfileMismatch).unwrap(),
            serde_json::json!("profileMismatch"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::DeviceLimitMismatch).unwrap(),
            serde_json::json!("deviceLimitMismatch"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::UnparkFailed).unwrap(),
            serde_json::json!("unparkFailed"),
        );
    }

    /// `as_wire` is hand-written; pin it to the serde derive so adding a
    /// variant forces both sides to stay in sync.
    #[test]
    fn as_wire_matches_serde_serialization() {
        for variant in [
            SandboxReuseResult::Reused,
            SandboxReuseResult::NoSessionId,
            SandboxReuseResult::PoolMiss,
            SandboxReuseResult::ProfileMismatch,
            SandboxReuseResult::DeviceLimitMismatch,
            SandboxReuseResult::UnparkFailed,
        ] {
            assert_eq!(
                serde_json::to_value(variant).unwrap(),
                serde_json::Value::String(variant.as_wire().to_string()),
            );
        }
    }

    #[test]
    fn session_id_returns_none_without_resume() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert!(ctx.session_id().is_none());
    }

    #[test]
    fn session_id_returns_id_from_resume_session() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-abc-123",
                "sessionHistory": "{}"
            },
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert_eq!(ctx.session_id(), Some("sess-abc-123"));
    }

    #[test]
    fn storage_manifest_camel_case() {
        let json = json!({
            "storages": [{
                "name": "workspace",
                "mountPath": "/workspace",
                "archiveUrl": "https://example.com/workspace.tar.gz",
                "vasStorageName": "workspace",
                "vasVersionId": "v1"
            }],
            "artifacts": [{
                "mountPath": "/artifacts",
                "archiveUrl": "https://example.com/artifacts.tar.gz",
                "vasStorageName": "my-artifact",
                "vasStorageId": "sid-1",
                "vasVersionId": "v1",
                "manifestUrl": "https://example.com/manifest.json"
            }]
        });
        let manifest: StorageManifest = serde_json::from_value(json).unwrap();
        assert_eq!(manifest.storages[0].mount_path, "/workspace");
        assert_eq!(manifest.storages[0].name, "workspace");
        assert_eq!(manifest.artifacts.len(), 1);
        assert_eq!(manifest.artifacts[0].vas_storage_name, "my-artifact");
        assert_eq!(
            manifest.artifacts[0].manifest_url.as_deref(),
            Some("https://example.com/manifest.json")
        );
    }

    #[test]
    fn storage_manifest_multiple_artifacts() {
        let json = json!({
            "storages": [],
            "artifacts": [
                {
                    "mountPath": "/workspace",
                    "archiveUrl": "https://example.com/a.tar.gz",
                    "vasStorageName": "art-a",
                    "vasStorageId": "sid-a",
                    "vasVersionId": "v1"
                },
                {
                    "mountPath": "/data",
                    "archiveUrl": "https://example.com/b.tar.gz",
                    "vasStorageName": "art-b",
                    "vasStorageId": "sid-b",
                    "vasVersionId": "v2"
                }
            ]
        });
        let manifest: StorageManifest = serde_json::from_value(json).unwrap();
        assert_eq!(manifest.artifacts.len(), 2);
        assert_eq!(manifest.artifacts[0].mount_path, "/workspace");
        assert_eq!(manifest.artifacts[1].vas_storage_name, "art-b");
    }

    #[test]
    fn storage_manifest_requires_artifacts_field() {
        let json = json!({
            "storages": []
        });
        assert!(serde_json::from_value::<StorageManifest>(json).is_err());
    }

    #[test]
    fn storage_manifest_conversion_initializes_guest_download_fields() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                name: "workspace".into(),
                mount_path: "/workspace".into(),
                archive_url: "https://example.com/workspace.tar.gz".into(),
                vas_storage_name: "workspace".into(),
                vas_version_id: "v1".into(),
                instructions_target_filename: Some("AGENTS.md".into()),
            }],
            artifacts: vec![ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: "https://example.com/artifact.tar.gz".into(),
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v2".into(),
                manifest_url: Some("https://example.com/manifest.json".into()),
            }],
        };

        let guest_manifest = GuestDownloadManifest::from(&manifest);

        assert!(guest_manifest.cleanup_paths.is_empty());
        assert!(!guest_manifest.storages[0].cached);
        assert_eq!(
            guest_manifest.storages[0].archive_url.as_deref(),
            Some("https://example.com/workspace.tar.gz")
        );
        assert_eq!(
            guest_manifest.storages[0]
                .instructions_target_filename
                .as_deref(),
            Some("AGENTS.md")
        );
        assert!(!guest_manifest.artifacts[0].cached);
        assert_eq!(
            guest_manifest.artifacts[0].archive_url.as_deref(),
            Some("https://example.com/artifact.tar.gz")
        );
    }

    #[test]
    fn guest_download_manifest_serialization_omits_api_only_fields() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                name: "workspace".into(),
                mount_path: "/workspace".into(),
                archive_url: "https://example.com/workspace.tar.gz".into(),
                vas_storage_name: "workspace".into(),
                vas_version_id: "v1".into(),
                instructions_target_filename: None,
            }],
            artifacts: vec![ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: "https://example.com/artifact.tar.gz".into(),
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v2".into(),
                manifest_url: Some("https://example.com/manifest.json".into()),
            }],
        };

        let value = serde_json::to_value(GuestDownloadManifest::from(&manifest)).unwrap();

        assert!(value["cleanupPaths"].is_array());
        assert_eq!(value["storages"][0]["cached"], false);
        assert!(value["storages"][0].get("name").is_none());
        assert_eq!(value["artifacts"][0]["cached"], false);
        assert!(value["artifacts"][0].get("manifestUrl").is_none());
    }

    #[test]
    fn heartbeat_state_serializes_camel_case() {
        let state = HeartbeatState {
            runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            runner_name: "runner-1".into(),
            group: "vm0/production".into(),
            profiles: vec!["vm0/default".into()],
            total_vcpu: 16,
            total_memory_mb: 32768,
            max_concurrent: 8,
            allocated_vcpu: 6,
            allocated_memory_mb: 6144,
            running_count: 2,
            held_session_states: vec![HeldSessionState {
                session_id: "session-abc".into(),
                last_completed_at: "2026-05-28T00:00:00.000Z".into(),
            }],
            mode: "running".into(),
        };
        let json: serde_json::Value = serde_json::to_value(&state).unwrap();
        assert_eq!(json["runnerId"], "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(json["runnerName"], "runner-1");
        assert_eq!(json["totalVcpu"], 16);
        assert_eq!(json["totalMemoryMb"], 32768);
        assert_eq!(json["maxConcurrent"], 8);
        assert_eq!(json["allocatedVcpu"], 6);
        assert_eq!(json["allocatedMemoryMb"], 6144);
        assert_eq!(json["runningCount"], 2);
        assert_eq!(
            json["heldSessionStates"],
            json!([{
                "sessionId": "session-abc",
                "lastCompletedAt": "2026-05-28T00:00:00.000Z"
            }])
        );
        assert_eq!(json["mode"], "running");
    }
}
