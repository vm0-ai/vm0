use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;

use sandbox::SandboxId;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use api_contracts::generated::types::runners::storage::{
    ArtifactEntryMissingRootPolicy, StorageManifest,
};

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;

pub(crate) const MAX_HELD_SESSION_STATES: usize = 1024;

fn is_false(value: &bool) -> bool {
    !*value
}

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
    #[serde(default)]
    pub cli_agent_session_id: Option<String>,
    #[serde(default)]
    pub affinity_protected_until: Option<String>,
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
    // Local submit may explicitly allow raw provider secrets for local-only
    // runner testing. This marker is internal and must not be claimable via API JSON.
    #[serde(default, skip)]
    pub local_secret_env_keys: Option<HashSet<String>>,
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
    pub real_agent_in_preview: Option<bool>,
    #[serde(default)]
    pub api_start_time: Option<u64>,
    #[serde(default)]
    pub user_timezone: Option<String>,
    #[serde(default)]
    pub capture_network_bodies: Option<bool>,
    #[serde(default)]
    pub firewalls: Option<Vec<FirewallEntry>>,
    #[serde(default)]
    pub network_policies: Option<std::collections::HashMap<String, NetworkPolicy>>,
    #[serde(default)]
    pub network_policy_refreshes: Option<std::collections::HashMap<String, NetworkPolicyRefresh>>,
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
    #[serde(default)]
    pub codex_runtime_config: Option<CodexRuntimeConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeConfig {
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    pub env_key: String,
    pub wire_api: String,
    pub supports_websockets: bool,
    #[serde(default)]
    pub model_catalog: Option<serde_json::Value>,
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

/// Execution firewall entry supplied by the API.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub enum FirewallEntry {
    /// Built-in firewall resolved by the Python addon from the runner-written catalog cache.
    #[serde(rename = "builtin", rename_all = "camelCase")]
    Builtin {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url_vars: Option<HashMap<String, String>>,
    },
    /// Inline firewall body for org custom connectors.
    #[serde(rename = "inline", rename_all = "camelCase")]
    Inline { firewall: Firewall },
}

/// A single firewall config with its name and API entries.
/// `name` is the canonical identifier (also used as the networkPolicies map key).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Firewall {
    pub name: String,
    pub apis: Vec<FirewallApi>,
}

impl Firewall {
    pub(crate) fn validate_for_cache(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("firewall name must be non-empty".to_string());
        }
        if self.apis.is_empty() {
            return Err(format!("firewall {} must have at least one api", self.name));
        }
        for (index, api) in self.apis.iter().enumerate() {
            api.validate_for_cache()
                .map_err(|e| format!("firewall {} apis[{index}]: {e}", self.name))?;
        }
        Ok(())
    }
}

/// A single firewall API entry with base URL and auth headers for proxy-side matching.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FirewallApi {
    /// Stable API identifier used as one component of mitm-addon auth cache keys.
    /// Filled by the Python registry loader after built-in refs and inline firewalls
    /// are resolved.
    #[serde(default)]
    pub id: String,
    pub base: String,
    pub auth: FirewallAuth,
    #[serde(
        default,
        rename = "hostPolicy",
        skip_serializing_if = "Option::is_none"
    )]
    pub host_policy: Option<FirewallBaseHostPolicy>,
    #[serde(default)]
    pub permissions: Option<Vec<FirewallPermission>>,
}

impl FirewallApi {
    fn validate_for_cache(&self) -> Result<(), String> {
        if !self.id.is_empty() {
            return Err("id must be empty because the runner assigns api ids".to_string());
        }
        if self.base.is_empty() {
            return Err("base must be non-empty".to_string());
        }
        validate_firewall_base_for_cache(&self.base)?;
        self.auth.validate_for_cache()?;
        if let Some(host_policy) = &self.host_policy {
            host_policy.validate_for_cache()?;
        }
        if let Some(permissions) = &self.permissions {
            let mut seen_names = HashSet::new();
            for permission in permissions {
                permission.validate_for_cache()?;
                if !seen_names.insert(permission.name.as_str()) {
                    return Err(format!(
                        "permission name {:?} must be unique per api",
                        permission.name
                    ));
                }
            }
        }
        Ok(())
    }
}

/// A named permission group with matching rules for request authorization.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FirewallPermission {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub rules: Vec<String>,
}

impl FirewallPermission {
    fn validate_for_cache(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("permission name must be non-empty".to_string());
        }
        if self.name == "all" || self.name == "__unknown__" {
            return Err(format!("permission name {:?} is reserved", self.name));
        }
        if self.rules.is_empty() {
            return Err(format!(
                "permission {:?} must have at least one rule",
                self.name
            ));
        }
        if self.rules.iter().any(|rule| rule.is_empty()) {
            return Err(format!(
                "permission {:?} rules must be non-empty",
                self.name
            ));
        }
        for rule in &self.rules {
            validate_firewall_permission_rule(rule)
                .map_err(|e| format!("permission {:?} rule {:?}: {e}", self.name, rule))?;
        }
        Ok(())
    }
}

const VALID_FIREWALL_RULE_METHODS: &[&str] = &[
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY",
];

struct FirewallRuleSegmentParam<'a> {
    name: &'a str,
    greedy: bool,
    mixed_with_literal: bool,
}

fn validate_firewall_permission_rule(rule: &str) -> Result<(), String> {
    let Some((method, path)) = rule.split_once(' ') else {
        return Err("must be \"METHOD /path\"".to_string());
    };
    if method.is_empty() || path.is_empty() {
        return Err("must be \"METHOD /path\"".to_string());
    }
    if !VALID_FIREWALL_RULE_METHODS.contains(&method) {
        return Err(format!("unknown method {method:?}"));
    }
    if !path.starts_with('/') {
        return Err("path must start with \"/\"".to_string());
    }
    if path.chars().any(is_raw_whitespace) {
        return Err("path must not contain whitespace".to_string());
    }
    if path.chars().any(is_unsafe_url_codepoint) {
        return Err("path must not contain control characters".to_string());
    }
    if path.contains('\\') {
        return Err("path must not contain backslash".to_string());
    }
    if path.contains('?') || path.contains('#') {
        return Err("path must not contain query string or fragment".to_string());
    }

    let segments: Vec<&str> = split_firewall_rule_path_segments(path).collect();
    let last_index = segments.len().saturating_sub(1);
    let mut param_names = HashSet::new();
    for (index, segment) in segments.iter().enumerate() {
        let Some(param) = parse_firewall_rule_segment(segment)? else {
            continue;
        };
        if !param_names.insert(param.name) {
            return Err(format!("duplicate parameter name {:?}", param.name));
        }
        if param.greedy && index != last_index {
            return Err(format!(
                "greedy parameter {:?} must be the last segment",
                param.name
            ));
        }
        if param.greedy && param.mixed_with_literal {
            return Err(format!(
                "greedy parameter {:?} cannot be combined with a literal prefix or suffix",
                param.name
            ));
        }
    }
    Ok(())
}

fn split_firewall_rule_path_segments(path: &str) -> impl Iterator<Item = &str> {
    let path_without_leading_slash = path.strip_prefix('/').unwrap_or(path);
    path_without_leading_slash
        .split('/')
        .filter(|segment| !path_without_leading_slash.is_empty() || !segment.is_empty())
}

fn parse_firewall_rule_segment(
    segment: &str,
) -> Result<Option<FirewallRuleSegmentParam<'_>>, String> {
    let open_count = segment.matches('{').count();
    let close_count = segment.matches('}').count();

    if open_count == 0 && close_count == 0 {
        return Ok(None);
    }
    if open_count != close_count {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    }

    let Some(open_index) = segment.find('{') else {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    };
    let Some(close_index) = segment.find('}') else {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    };
    if close_index < open_index {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    }

    if open_count >= 2 {
        let open_after_close = segment[close_index + 1..]
            .find('{')
            .map(|index| close_index + 1 + index);
        if open_after_close == Some(close_index + 1) {
            return Err(format!("adjacent parameters in segment {segment:?}"));
        }
        return Err(format!(
            "literal-separated parameters in segment {segment:?}"
        ));
    }

    let prefix = &segment[..open_index];
    let content = &segment[open_index + 1..close_index];
    let suffix = &segment[close_index + 1..];
    if prefix.contains('{') || prefix.contains('}') || suffix.contains('{') || suffix.contains('}')
    {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    }

    let (name, greedy) = content
        .strip_suffix('+')
        .map(|name| (name, true))
        .or_else(|| content.strip_suffix('*').map(|name| (name, true)))
        .unwrap_or((content, false));
    if name.is_empty() {
        return Err(format!("empty parameter name in segment {segment:?}"));
    }

    Ok(Some(FirewallRuleSegmentParam {
        name,
        greedy,
        mixed_with_literal: !prefix.is_empty() || !suffix.is_empty(),
    }))
}

fn is_raw_whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{000c}' | '\u{000b}')
}

fn is_unsafe_url_codepoint(ch: char) -> bool {
    ch < '\u{0020}' || ch == '\u{007f}'
}

fn validate_firewall_base_for_cache(base: &str) -> Result<(), String> {
    let template_syntax_target = base_url_template_syntax_target_for_cache(base)?;
    let raw_syntax_target = template_syntax_target.as_deref().unwrap_or(base);
    if raw_syntax_target.contains('\\') {
        return Err("base URL must not contain backslash".to_string());
    }
    if raw_syntax_target.chars().any(is_raw_whitespace) {
        return Err("base URL must not contain whitespace".to_string());
    }
    if raw_syntax_target.chars().any(is_unsafe_url_codepoint) {
        return Err("base URL must not contain control characters".to_string());
    }
    if raw_syntax_target.contains('?') {
        return Err("base URL must not contain query string".to_string());
    }
    if raw_syntax_target.contains('#') {
        return Err("base URL must not contain fragment".to_string());
    }
    if template_syntax_target.is_some() {
        if (raw_syntax_target.contains('{') || raw_syntax_target.contains('}'))
            && raw_syntax_target.contains("://")
        {
            validate_parameterized_firewall_base_for_cache(raw_syntax_target)?;
        }
        return Ok(());
    }
    if base.contains('{') || base.contains('}') {
        return validate_parameterized_firewall_base_for_cache(base);
    }
    let parsed = url::Url::parse(base).map_err(|_| "base URL is invalid".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("base URL scheme must be http or https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("base URL must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("base URL must not contain userinfo".to_string());
    }
    if parsed.query().is_some() {
        return Err("base URL must not contain query string".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("base URL must not contain fragment".to_string());
    }
    Ok(())
}

fn base_url_template_syntax_target_for_cache(base: &str) -> Result<Option<String>, String> {
    let mut search_start = 0;
    let mut result = String::new();
    let mut found = false;
    while let Some(relative_start) = base[search_start..].find("${{") {
        found = true;
        let start = search_start + relative_start;
        let content_start = start + "${{".len();
        let Some(relative_end) = base[content_start..].find("}}") else {
            return Err("base URL template reference is unterminated".to_string());
        };
        let end = content_start + relative_end;
        validate_base_url_var_reference(&base[content_start..end])?;
        result.push_str(&base[search_start..start]);
        result.push_str("template");
        search_start = end + "}}".len();
    }
    if !found {
        return Ok(None);
    }
    result.push_str(&base[search_start..]);
    Ok(Some(result))
}

fn validate_base_url_var_reference(content: &str) -> Result<(), String> {
    let trimmed = content.trim();
    let Some(name) = trimmed.strip_prefix("vars.") else {
        return Err("base URL template reference must use vars".to_string());
    };
    validate_template_identifier(name, "base URL template variable")
}

fn validate_template_identifier(name: &str, label: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err(format!("{label} name must be non-empty"));
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return Err(format!(
            "{label} name must start with a letter or underscore"
        ));
    }
    if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return Err(format!("{label} name must be alphanumeric"));
    }
    Ok(())
}

fn validate_parameterized_firewall_base_for_cache(base: &str) -> Result<(), String> {
    let Some((scheme, rest)) = base.split_once("://") else {
        return Err("base URL missing scheme".to_string());
    };
    if scheme.contains('{') || scheme.contains('}') {
        return Err("base URL scheme must not contain parameters".to_string());
    }
    if scheme != "http" && scheme != "https" {
        return Err("base URL scheme must be http or https".to_string());
    }

    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, ""), |(authority, path)| (authority, path));
    if authority.is_empty() {
        return Err("base URL must include a host".to_string());
    }
    if authority.contains('@') {
        return Err("base URL must not contain userinfo".to_string());
    }

    let host = parameterized_base_host(authority)?;
    let mut param_names = HashSet::new();
    validate_parameterized_firewall_base_host(host, &mut param_names)?;
    validate_parameterized_firewall_base_path(path, &mut param_names)?;
    Ok(())
}

fn parameterized_base_host(authority: &str) -> Result<&str, String> {
    if authority.ends_with(':') {
        return Err("base URL authority must not include an empty port".to_string());
    }
    if authority.contains('[') || authority.contains(']') {
        return Err("parameterized base URL authority must not be bracketed".to_string());
    }
    if authority.contains('%') {
        return Err(
            "parameterized base URL authority must not contain percent encoding".to_string(),
        );
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return Ok(authority);
    };
    if !port.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("base URL authority has invalid port".to_string());
    }
    if host.is_empty() {
        return Err("base URL must include a host".to_string());
    }
    Ok(host)
}

fn validate_parameterized_firewall_base_host(
    host: &str,
    param_names: &mut HashSet<String>,
) -> Result<(), String> {
    let segments: Vec<&str> = host.split('.').collect();
    if segments.len() < 2 {
        return Err("base URL host must have at least two segments".to_string());
    }

    let mut has_static_segment = false;
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty() {
            return Err("base URL host segments must be non-empty".to_string());
        }
        let Some(param) = parse_firewall_rule_segment(segment)? else {
            has_static_segment = true;
            continue;
        };
        if !param_names.insert(param.name.to_string()) {
            return Err(format!(
                "duplicate parameter name {:?} in base URL host",
                param.name
            ));
        }
        if param.greedy && index != 0 {
            return Err(format!(
                "greedy parameter {:?} must be the first host segment",
                param.name
            ));
        }
        if param.greedy && param.mixed_with_literal {
            return Err(format!(
                "greedy parameter {:?} cannot be combined with a literal prefix or suffix in base URL host",
                param.name
            ));
        }
    }
    if !has_static_segment {
        return Err("base URL host must have at least one static segment".to_string());
    }
    Ok(())
}

fn validate_parameterized_firewall_base_path(
    path: &str,
    param_names: &mut HashSet<String>,
) -> Result<(), String> {
    for segment in path.split('/') {
        let Some(param) = parse_firewall_rule_segment(segment)? else {
            continue;
        };
        if param.greedy {
            return Err(format!(
                "greedy parameter {:?} is not allowed in base URL path",
                param.name
            ));
        }
        if !param_names.insert(param.name.to_string()) {
            return Err(format!(
                "duplicate parameter name {:?} in base URL path",
                param.name
            ));
        }
    }
    Ok(())
}

/// Base-host ownership policy for credentialed builtin firewall APIs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum FirewallBaseHostPolicy {
    #[serde(rename = "providerOwned", rename_all = "camelCase")]
    ProviderOwned {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        exact_hosts: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        suffixes: Vec<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        allow_non_default_port: bool,
    },
    #[serde(rename = "publicDestination")]
    PublicDestination,
}

impl FirewallBaseHostPolicy {
    fn validate_for_cache(&self) -> Result<(), String> {
        match self {
            Self::ProviderOwned {
                exact_hosts,
                suffixes,
                ..
            } => {
                if exact_hosts.is_empty() && suffixes.is_empty() {
                    return Err(
                        "providerOwned hostPolicy requires exactHosts or suffixes".to_string()
                    );
                }
                for host in exact_hosts {
                    validate_host_policy_hostname(host, false)?;
                }
                for suffix in suffixes {
                    validate_host_policy_hostname(suffix, true)?;
                }
                Ok(())
            }
            Self::PublicDestination => Ok(()),
        }
    }
}

fn validate_host_policy_hostname(value: &str, allow_leading_dot: bool) -> Result<(), String> {
    if value.is_empty() {
        return Err("hostPolicy host must be non-empty".to_string());
    }
    if !allow_leading_dot && value.starts_with('.') {
        return Err("hostPolicy exactHosts must not start with a dot".to_string());
    }
    if !value.is_ascii()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_ascii_control())
    {
        return Err(
            "hostPolicy hosts must be ASCII without whitespace or control characters".to_string(),
        );
    }
    const FORBIDDEN: &[char] = &['%', '*', '[', ']', '/', '?', '#', '@', '\\', ':', '{', '}'];
    if value.chars().any(|ch| FORBIDDEN.contains(&ch)) {
        return Err("hostPolicy hosts contain forbidden syntax characters".to_string());
    }

    let host = if allow_leading_dot && value.starts_with('.') {
        &value[1..]
    } else {
        value
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.is_empty() {
        return Err("hostPolicy host must be non-empty".to_string());
    }
    if host.parse::<IpAddr>().is_ok() {
        return Err("hostPolicy host must not be an IP address".to_string());
    }
    if is_ipv4_literal_like(host) {
        return Err("hostPolicy host must not look like an IPv4 address".to_string());
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return Err("hostPolicy host must have at least two non-empty labels".to_string());
    }
    Ok(())
}

fn is_ipv4_literal_like(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    !labels.is_empty()
        && labels.len() <= 4
        && labels.iter().all(|label| {
            let Some(rest) = label
                .strip_prefix("0x")
                .or_else(|| label.strip_prefix("0X"))
            else {
                return !label.is_empty() && label.chars().all(|ch| ch.is_ascii_digit());
            };
            !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_hexdigit())
        })
}

/// Auth configuration for a firewall API entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
    /// Optional AWS SigV4 auth template.
    #[serde(default, rename = "awsSigv4", skip_serializing_if = "Option::is_none")]
    pub aws_sigv4: Option<FirewallAwsSigv4Auth>,
}

impl FirewallAuth {
    fn validate_for_cache(&self) -> Result<(), String> {
        if let Some(base) = &self.base {
            validate_auth_base_for_cache(base)?;
        }
        let Some(aws_sigv4) = &self.aws_sigv4 else {
            return Ok(());
        };
        aws_sigv4.validate_for_cache()?;
        if !self.headers.is_empty() {
            return Err("auth.headers cannot be combined with auth.awsSigv4".to_string());
        }
        if self.query.as_ref().is_some_and(|query| !query.is_empty()) {
            return Err("auth.query cannot be combined with auth.awsSigv4".to_string());
        }
        Ok(())
    }
}

struct AuthBaseStaticValidationTarget {
    url: Option<String>,
    dynamic_prefix_suffix: String,
}

fn validate_auth_base_for_cache(auth_base: &str) -> Result<(), String> {
    if auth_base.is_empty() {
        return Err("auth.base must be non-empty when present".to_string());
    }
    if auth_base.contains('\\') {
        return Err("auth.base must not contain backslash".to_string());
    }
    let target = auth_base_static_validation_target_for_cache(auth_base)?;
    validate_dynamic_auth_base_suffix_for_cache(&target.dynamic_prefix_suffix)?;
    let Some(validation_url) = target.url else {
        return Ok(());
    };
    if validation_url.contains("${{") {
        return Err("auth.base contains unsupported template reference".to_string());
    }
    if validation_url.chars().any(is_raw_whitespace) {
        return Err("auth.base must not contain whitespace".to_string());
    }
    if validation_url.chars().any(is_unsafe_url_codepoint) {
        return Err("auth.base must not contain control characters".to_string());
    }
    if !validation_url.contains("://") {
        return Err("auth.base URL must include a scheme".to_string());
    }
    let parsed =
        url::Url::parse(&validation_url).map_err(|_| "auth.base URL is invalid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("auth.base scheme must be https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("auth.base URL must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("auth.base must not contain userinfo".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("auth.base must not contain fragment".to_string());
    }
    if raw_authority_has_empty_port(&validation_url) {
        return Err("auth.base URL authority must not include an empty port".to_string());
    }
    if path_has_unsafe_segments_for_cache(raw_url_path(&validation_url)) {
        return Err("auth.base must not contain unsafe path".to_string());
    }
    Ok(())
}

fn auth_base_static_validation_target_for_cache(
    auth_base: &str,
) -> Result<AuthBaseStaticValidationTarget, String> {
    let mut search_start = 0;
    let mut result = String::new();
    let mut first_template_end = None;
    let mut found = false;
    while let Some(relative_start) = auth_base[search_start..].find("${{") {
        found = true;
        let start = search_start + relative_start;
        let content_start = start + "${{".len();
        let Some(relative_end) = auth_base[content_start..].find("}}") else {
            return Err("auth.base template reference is unterminated".to_string());
        };
        let end = content_start + relative_end;
        validate_auth_base_template_reference(&auth_base[content_start..end])?;
        result.push_str(&auth_base[search_start..start]);
        result.push_str("placeholder");
        search_start = end + "}}".len();
        if start == 0 && first_template_end.is_none() {
            first_template_end = Some(result.len());
        }
    }
    if !found {
        return Ok(AuthBaseStaticValidationTarget {
            url: Some(auth_base.to_string()),
            dynamic_prefix_suffix: String::new(),
        });
    }
    result.push_str(&auth_base[search_start..]);
    if let Some(end) = first_template_end {
        return Ok(AuthBaseStaticValidationTarget {
            url: None,
            dynamic_prefix_suffix: result[end..].to_string(),
        });
    }
    Ok(AuthBaseStaticValidationTarget {
        url: Some(result),
        dynamic_prefix_suffix: String::new(),
    })
}

fn validate_auth_base_template_reference(content: &str) -> Result<(), String> {
    let trimmed = content.trim();
    let name = trimmed
        .strip_prefix("secrets.")
        .or_else(|| trimmed.strip_prefix("vars."))
        .ok_or_else(|| "auth.base template reference must use secrets or vars".to_string())?;
    validate_template_identifier(name, "auth.base template variable")
}

fn validate_dynamic_auth_base_suffix_for_cache(suffix: &str) -> Result<(), String> {
    if suffix.contains("${{") {
        return Err("auth.base contains unsupported template reference".to_string());
    }
    if suffix.chars().any(is_raw_whitespace) {
        return Err("auth.base dynamic URL suffix must not contain whitespace".to_string());
    }
    if suffix.chars().any(is_unsafe_url_codepoint) {
        return Err("auth.base dynamic URL suffix must not contain control characters".to_string());
    }
    if suffix.contains('#') {
        return Err("auth.base must not contain fragment".to_string());
    }
    if !suffix.is_empty() && !suffix.starts_with('/') && !suffix.starts_with('?') {
        return Err("auth.base dynamic URL suffix must start with / or ?".to_string());
    }
    if suffix.starts_with('/') {
        let path = suffix.split_once('?').map_or(suffix, |(path, _)| path);
        if path_has_unsafe_segments_for_cache(path) {
            return Err("auth.base dynamic URL suffix must not contain unsafe path".to_string());
        }
    }
    Ok(())
}

fn path_has_unsafe_segments_for_cache(path: &str) -> bool {
    path.contains('\\') || path.split('/').any(segment_has_unsafe_path_for_cache)
}

fn segment_has_unsafe_path_for_cache(raw_segment: &str) -> bool {
    const MAX_PERCENT_DECODE_PASSES: usize = 5;

    let mut segment = raw_segment.to_string();
    for _ in 0..MAX_PERCENT_DECODE_PASSES {
        if segment_has_unsafe_syntax_for_cache(&segment) {
            return true;
        }
        let Some(decoded) = percent_decode_segment(&segment) else {
            return true;
        };
        if decoded == segment {
            return false;
        }
        segment = decoded;
    }

    if segment_has_unsafe_syntax_for_cache(&segment) {
        return true;
    }
    percent_decode_segment(&segment).is_none_or(|decoded| decoded != segment)
}

fn segment_has_unsafe_syntax_for_cache(segment: &str) -> bool {
    if segment_has_unsafe_syntax_parts_for_cache(segment) {
        return true;
    }

    let normalized: String = segment.nfkc().collect();
    normalized != segment
        && (normalized.contains('%') || segment_has_unsafe_syntax_parts_for_cache(&normalized))
}

fn segment_has_unsafe_syntax_parts_for_cache(segment: &str) -> bool {
    segment.chars().any(is_unsafe_url_codepoint)
        || segment.contains('\\')
        || path_part_is_dot_segment_for_cache(segment)
        || segment.split('/').any(path_part_is_dot_segment_for_cache)
}

fn path_part_is_dot_segment_for_cache(segment: &str) -> bool {
    let path_part = segment.split_once(';').map_or(segment, |(part, _)| part);
    path_part == "." || path_part == ".."
}

fn percent_decode_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte != b'%' {
            decoded.push(byte);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        decoded.push((hex_value(high)? << 4) | hex_value(low)?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn raw_authority_has_empty_port(value: &str) -> bool {
    let Some(rest) = value.split_once("://").map(|(_, rest)| rest) else {
        return false;
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    rest[..authority_end].ends_with(':')
}

fn raw_url_path(value: &str) -> &str {
    let Some(rest) = value.split_once("://").map(|(_, rest)| rest) else {
        return "";
    };
    let Some(path_start) = rest.find('/') else {
        return "";
    };
    let path_and_after = &rest[path_start..];
    let path_end = path_and_after
        .find(['?', '#'])
        .unwrap_or(path_and_after.len());
    &path_and_after[..path_end]
}

/// AWS SigV4 auth template for firewall auth injection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FirewallAwsSigv4Auth {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

impl FirewallAwsSigv4Auth {
    fn validate_for_cache(&self) -> Result<(), String> {
        if self.access_key_id.is_empty() {
            return Err("auth.awsSigv4.accessKeyId must be non-empty".to_string());
        }
        if self.secret_access_key.is_empty() {
            return Err("auth.awsSigv4.secretAccessKey must be non-empty".to_string());
        }
        if self.session_token.as_deref() == Some("") {
            return Err("auth.awsSigv4.sessionToken must be non-empty when present".to_string());
        }
        Ok(())
    }
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

/// Per-connector runtime network policy refresh boundary supplied by the API.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyRefresh {
    pub next_refresh_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyRefreshResponse {
    pub connector_ref: String,
    pub network_policy: NetworkPolicy,
    pub next_refresh_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyRefreshBatchResponse {
    pub refreshes: Vec<NetworkPolicyRefreshResponse>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruction_cleanups: Vec<GuestDownloadInstructionCleanupEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDownloadStorageEntry {
    pub mount_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_path: Option<String>,
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
pub struct GuestDownloadInstructionCleanupEntry {
    pub mount_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_filename: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDownloadArtifactEntry {
    pub mount_path: String,
    pub archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub empty: bool,
    /// Whether this entry is cached from a previous turn (fingerprint matched).
    pub cached: bool,
    pub vas_storage_name: String,
    pub vas_storage_id: String,
    pub vas_version_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
}

impl GuestDownloadManifest {
    pub(crate) fn from_storage_manifest_for_run(
        manifest: &StorageManifest,
        runtime_dir: &str,
    ) -> RunnerResult<Self> {
        Self::try_from_storage_manifest(manifest, Some(runtime_dir))
    }

    pub(crate) fn try_from_storage_manifest(
        manifest: &StorageManifest,
        runtime_dir: Option<&str>,
    ) -> RunnerResult<Self> {
        let artifacts = manifest
            .artifacts
            .iter()
            .map(|artifact| {
                let empty = artifact.empty.unwrap_or(false);
                let archive_url = if empty {
                    None
                } else {
                    Some(artifact.archive_url.clone().ok_or_else(|| {
                        RunnerError::Internal(format!(
                            "storage manifest artifact {} version {} is missing archiveUrl",
                            artifact.vas_storage_name, artifact.vas_version_id
                        ))
                    })?)
                };
                Ok(GuestDownloadArtifactEntry {
                    mount_path: artifact.mount_path.clone(),
                    archive_url,
                    empty,
                    cached: false,
                    vas_storage_name: artifact.vas_storage_name.clone(),
                    vas_storage_id: artifact.vas_storage_id.clone(),
                    vas_version_id: artifact.vas_version_id.clone(),
                    missing_root_policy: artifact.missing_root_policy,
                })
            })
            .collect::<RunnerResult<Vec<_>>>()?;

        Ok(Self {
            storages: manifest
                .storages
                .iter()
                .enumerate()
                .map(|(index, storage)| {
                    let extract_path = storage
                        .instructions_target_filename
                        .as_ref()
                        .and_then(|_| runtime_dir.map(|dir| instruction_extract_path(dir, index)));
                    GuestDownloadStorageEntry {
                        mount_path: storage.mount_path.clone(),
                        extract_path,
                        archive_url: Some(storage.archive_url.clone()),
                        instructions_target_filename: storage.instructions_target_filename.clone(),
                        cached: false,
                        vas_storage_name: storage.vas_storage_name.clone(),
                        vas_version_id: storage.vas_version_id.clone(),
                    }
                })
                .collect(),
            artifacts,
            cleanup_paths: Vec::new(),
            instruction_cleanups: Vec::new(),
        })
    }
}

fn instruction_extract_path(runtime_dir: &str, index: usize) -> String {
    let mut path = PathBuf::from(runtime_dir);
    path.push("storage-instructions");
    path.push(index.to_string());
    path.to_string_lossy().into_owned()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSession {
    #[serde(rename = "sessionId")]
    pub cli_agent_session_id: String,
    #[serde(flatten)]
    pub history: ResumeSessionHistory,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum ResumeSessionHistory {
    Inline {
        #[serde(rename = "sessionHistory")]
        session_history: String,
    },
    Ref {
        #[serde(rename = "historyRef")]
        history_ref: ResumeSessionHistoryRef,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionHistoryRef {
    pub kind: ResumeSessionHistoryRefKind,
    pub hash: String,
    pub url: String,
    #[serde(default)]
    pub encoding: Option<ResumeSessionHistoryEncoding>,
    #[serde(rename = "rawSize")]
    pub raw_size: u64,
    #[serde(rename = "encodedSize")]
    pub encoded_size: u64,
    #[serde(rename = "downloadSource", default)]
    pub download_source: Option<ResumeSessionHistoryDownloadSource>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum ResumeSessionHistoryRefKind {
    #[serde(rename = "blob")]
    Blob,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
pub enum ResumeSessionHistoryEncoding {
    #[serde(rename = "identity")]
    Identity,
    #[serde(rename = "gzip")]
    Gzip,
    #[serde(rename = "zstd")]
    Zstd,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum ResumeSessionHistoryDownloadSource {
    #[serde(rename = "configured_public_endpoint")]
    ConfiguredPublicEndpoint,
    #[serde(rename = "default_r2_endpoint")]
    DefaultR2Endpoint,
    #[serde(other)]
    Unknown,
}

impl ResumeSession {
    pub fn inline(cli_agent_session_id: String, session_history: String) -> Self {
        Self {
            cli_agent_session_id,
            history: ResumeSessionHistory::Inline { session_history },
        }
    }

    pub fn session_history(&self) -> Option<&str> {
        match &self.history {
            ResumeSessionHistory::Inline { session_history } => Some(session_history),
            ResumeSessionHistory::Ref { .. } => None,
        }
    }

    pub fn history_ref(&self) -> Option<&ResumeSessionHistoryRef> {
        match &self.history {
            ResumeSessionHistory::Inline { .. } => None,
            ResumeSessionHistory::Ref { history_ref } => Some(history_ref),
        }
    }
}

impl ExecutionContext {
    /// Extract the Claude/Codex CLI agent session id from `resume_session`.
    ///
    /// Returns `Some` for continued sessions. For first runs this returns
    /// `None`; the executor reads the CLI-generated session id from the
    /// guest filesystem post-execution (see `read_guest_cli_agent_session_id`).
    pub fn cli_agent_session_id(&self) -> Option<&str> {
        self.resume_session
            .as_ref()
            .map(|r| r.cli_agent_session_id.as_str())
    }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/// Runner state snapshot sent to the server via heartbeat.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeldSessionState {
    /// Compatibility wire name is `sessionId`; semantically this is the
    /// Claude/Codex CLI agent session id used for sandbox reuse affinity.
    pub session_id: String,
    pub last_completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatState {
    pub runner_id: String,
    pub runner_name: String,
    pub group: String,
    pub total_vcpu: u32,
    pub total_memory_mb: u32,
    pub max_concurrent: usize,
    pub allocated_vcpu: u32,
    pub allocated_memory_mb: u32,
    pub running_count: usize,
    pub admittable_profiles: Vec<String>,
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
    use api_contracts::generated::types::runners::storage::{
        ArtifactEntry, ArtifactEntryMissingRootPolicy, StorageEntry,
    };
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
        assert!(ctx.local_secret_env_keys.is_none());
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
            "localSecretEnvKeys": ["ANTHROPIC_API_KEY"],
            "encryptedSecrets": "enc-blob",
            "secretConnectorMap": {"GITHUB_TOKEN": "github"},
            "secretConnectorMetadataMap": {
                "CHATGPT_ACCESS_TOKEN": {
                    "sourceType": "model-provider",
                    "sourceUserId": "user-123",
                    "metadataKey": "codex-oauth-token"
                }
            },
            "realAgentInPreview": true,
            "apiStartTime": 1_700_000_000_000u64,
            "userTimezone": "America/New_York",
            "firewalls": [{"kind": "builtin", "name": "github"}],
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
        assert_eq!(
            ctx.resume_session.as_ref().unwrap().cli_agent_session_id,
            "sess-1"
        );
        assert_eq!(ctx.secret_values.as_ref().unwrap().len(), 2);
        assert!(ctx.local_secret_env_keys.is_none());
        assert_eq!(ctx.encrypted_secrets.as_deref(), Some("enc-blob"));
        let metadata = ctx.secret_connector_metadata_map.as_ref().unwrap();
        assert_eq!(
            metadata["CHATGPT_ACCESS_TOKEN"].source_user_id.as_deref(),
            Some("user-123")
        );
        assert!(ctx.real_agent_in_preview.unwrap());
        assert_eq!(ctx.api_start_time, Some(1_700_000_000_000));
        let FirewallEntry::Builtin { name, .. } = &ctx.firewalls.as_ref().unwrap()[0] else {
            panic!("expected builtin firewall entry");
        };
        assert_eq!(name, "github");
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
    fn execution_context_rejects_legacy_expanded_firewall_entry() {
        let json = serde_json::json!({
            "runId": "11111111-1111-4111-8111-111111111111",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude-code",
            "firewalls": [{
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{
                        "name": "issues-read",
                        "rules": ["GET /repos/{owner}/{repo}/issues"]
                    }]
                }]
            }]
        });

        let result = serde_json::from_value::<ExecutionContext>(json);
        assert!(result.is_err());
    }

    #[test]
    fn execution_context_rejects_unknown_firewall_kind() {
        let json = serde_json::json!({
            "runId": "11111111-1111-4111-8111-111111111111",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude-code",
            "firewalls": [{
                "kind": "unknown",
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {"headers": {}}
                }]
            }]
        });

        let result = serde_json::from_value::<ExecutionContext>(json);
        assert!(result.is_err());
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
                    aws_sigv4: None,
                },
                host_policy: None,
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
            aws_sigv4: None,
        };
        let json = serde_json::to_value(&auth).unwrap();
        assert!(json.get("base").is_none());
    }

    #[test]
    fn firewall_preserves_host_policy_and_aws_sigv4() {
        let json = serde_json::json!({
            "name": "aws",
            "apis": [{
                "base": "https://s3.amazonaws.com",
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": ["s3.amazonaws.com"],
                    "allowNonDefaultPort": false
                },
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}"
                    }
                },
                "permissions": [{
                    "name": "read",
                    "rules": ["GET /{bucket}"]
                }]
            }]
        });

        let firewall: Firewall = serde_json::from_value(json).unwrap();
        firewall.validate_for_cache().unwrap();
        let round_trip = serde_json::to_value(&firewall).unwrap();

        assert_eq!(
            round_trip["apis"][0]["hostPolicy"]["exactHosts"][0],
            "s3.amazonaws.com"
        );
        assert_eq!(
            round_trip["apis"][0]["auth"]["awsSigv4"]["accessKeyId"],
            "${{ secrets.AWS_ACCESS_KEY_ID }}"
        );
    }

    #[test]
    fn firewall_validation_rejects_aws_sigv4_with_headers() {
        let firewall: Firewall = serde_json::from_value(serde_json::json!({
            "name": "aws",
            "apis": [{
                "base": "https://s3.amazonaws.com",
                "auth": {
                    "headers": {"Authorization": "Bearer token"},
                    "awsSigv4": {
                        "accessKeyId": "key",
                        "secretAccessKey": "secret"
                    }
                }
            }]
        }))
        .unwrap();

        let error = firewall.validate_for_cache().unwrap_err();

        assert!(
            error.contains("auth.headers cannot be combined with auth.awsSigv4"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_validation_rejects_empty_provider_owned_host_policy() {
        let firewall: Firewall = serde_json::from_value(serde_json::json!({
            "name": "example",
            "apis": [{
                "base": "https://api.example.com",
                "hostPolicy": {"kind": "providerOwned"},
                "auth": {"headers": {}}
            }]
        }))
        .unwrap();

        let error = firewall.validate_for_cache().unwrap_err();

        assert!(
            error.contains("providerOwned hostPolicy requires exactHosts or suffixes"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_validation_rejects_empty_apis() {
        let firewall: Firewall = serde_json::from_value(serde_json::json!({
            "name": "empty",
            "apis": []
        }))
        .unwrap();

        let error = firewall.validate_for_cache().unwrap_err();

        assert!(
            error.contains("must have at least one api"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_deserialization_rejects_unsupported_host_policy_fields() {
        let error = serde_json::from_value::<Firewall>(serde_json::json!({
            "name": "example",
            "apis": [{
                "base": "https://api.example.com",
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": ["api.example.com"],
                    "unexpected": true
                },
                "auth": {"headers": {}}
            }]
        }))
        .unwrap_err();

        assert!(
            error.to_string().contains("unknown field"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_deserialization_rejects_unsupported_aws_sigv4_fields() {
        let error = serde_json::from_value::<Firewall>(serde_json::json!({
            "name": "aws",
            "apis": [{
                "base": "https://s3.amazonaws.com",
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "key",
                        "secretAccessKey": "secret",
                        "unexpected": true
                    }
                }
            }]
        }))
        .unwrap_err();

        assert!(
            error.to_string().contains("unknown field"),
            "unexpected error: {error}"
        );
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
    fn cli_agent_session_id_returns_none_without_resume() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert!(ctx.cli_agent_session_id().is_none());
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_resume_session() {
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
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-abc-123"));
        assert_eq!(
            ctx.resume_session.as_ref().unwrap().session_history(),
            Some("{}")
        );
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_resume_session_history_ref() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob?sig=secret",
                    "rawSize": 42,
                    "encodedSize": 42
                }
            },
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert!(session.session_history().is_none());
        assert_eq!(history_ref.kind, ResumeSessionHistoryRefKind::Blob);
        assert_eq!(history_ref.raw_size, 42);
        assert_eq!(history_ref.encoded_size, 42);
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_gzip_resume_session_history_ref() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob.gz?sig=secret",
                    "encoding": "gzip",
                    "rawSize": 42,
                    "encodedSize": 24,
                    "downloadSource": "configured_public_endpoint"
                }
            },
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert!(session.session_history().is_none());
        assert_eq!(history_ref.kind, ResumeSessionHistoryRefKind::Blob);
        assert_eq!(
            history_ref.encoding,
            Some(ResumeSessionHistoryEncoding::Gzip)
        );
        assert_eq!(history_ref.raw_size, 42);
        assert_eq!(history_ref.encoded_size, 24);
        assert_eq!(
            history_ref.download_source,
            Some(ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint)
        );
    }

    #[test]
    fn cli_agent_session_id_tolerates_unknown_resume_session_history_download_source() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob.gz?sig=secret",
                    "encoding": "gzip",
                    "rawSize": 42,
                    "encodedSize": 24,
                    "downloadSource": "future_edge_cache"
                }
            },
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert_eq!(
            history_ref.download_source,
            Some(ResumeSessionHistoryDownloadSource::Unknown)
        );
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_zstd_resume_session_history_ref() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob.zst?sig=secret",
                    "encoding": "zstd",
                    "rawSize": 42,
                    "encodedSize": 18
                }
            },
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert!(session.session_history().is_none());
        assert_eq!(history_ref.kind, ResumeSessionHistoryRefKind::Blob);
        assert_eq!(
            history_ref.encoding,
            Some(ResumeSessionHistoryEncoding::Zstd)
        );
        assert_eq!(history_ref.raw_size, 42);
        assert_eq!(history_ref.encoded_size, 18);
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
                "vasVersionId": "v1"
            }]
        });
        let manifest: StorageManifest = serde_json::from_value(json).unwrap();
        assert_eq!(manifest.storages[0].mount_path, "/workspace");
        assert_eq!(manifest.storages[0].name, "workspace");
        assert_eq!(manifest.artifacts.len(), 1);
        assert_eq!(manifest.artifacts[0].vas_storage_name, "my-artifact");
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
                archive_url: Some("https://example.com/artifact.tar.gz".into()),
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v2".into(),
                empty: None,
                missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
            }],
        };

        let guest_manifest =
            GuestDownloadManifest::try_from_storage_manifest(&manifest, None).unwrap();

        assert!(guest_manifest.cleanup_paths.is_empty());
        assert!(guest_manifest.instruction_cleanups.is_empty());
        assert!(!guest_manifest.storages[0].cached);
        assert!(guest_manifest.storages[0].extract_path.is_none());
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
        assert!(!guest_manifest.artifacts[0].empty);
        assert_eq!(
            guest_manifest.artifacts[0].archive_url.as_deref(),
            Some("https://example.com/artifact.tar.gz")
        );
        assert_eq!(
            guest_manifest.artifacts[0].missing_root_policy,
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion)
        );
    }

    #[test]
    fn storage_manifest_conversion_marks_explicit_empty_artifacts_without_archive_urls() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: Some("https://example.com/compat-empty-artifact.tar.gz".into()),
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v-empty".into(),
                empty: Some(true),
                missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
            }],
        };

        let guest_manifest =
            GuestDownloadManifest::try_from_storage_manifest(&manifest, None).unwrap();

        assert!(guest_manifest.artifacts[0].empty);
        assert!(guest_manifest.artifacts[0].archive_url.is_none());
        assert_eq!(
            guest_manifest.artifacts[0].missing_root_policy,
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion)
        );
    }

    #[test]
    fn storage_manifest_conversion_accepts_empty_artifacts_without_archive_urls() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: None,
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v-empty".into(),
                empty: Some(true),
                missing_root_policy: None,
            }],
        };

        let guest_manifest =
            GuestDownloadManifest::try_from_storage_manifest(&manifest, None).unwrap();

        assert!(guest_manifest.artifacts[0].empty);
        assert!(guest_manifest.artifacts[0].archive_url.is_none());
    }

    #[test]
    fn storage_manifest_conversion_rejects_non_empty_artifacts_without_archive_urls() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: None,
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v2".into(),
                empty: None,
                missing_root_policy: None,
            }],
        };

        let error = GuestDownloadManifest::try_from_storage_manifest(&manifest, None).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("storage manifest artifact memory version v2 is missing archiveUrl"),
            "got: {error}"
        );
    }

    #[test]
    fn storage_manifest_for_run_stages_instruction_storages_only() {
        let manifest = StorageManifest {
            storages: vec![
                StorageEntry {
                    name: "instructions".into(),
                    mount_path: "/home/user/.codex".into(),
                    archive_url: "https://example.com/instructions.tar.gz".into(),
                    vas_storage_name: "instructions".into(),
                    vas_version_id: "v1".into(),
                    instructions_target_filename: Some("AGENTS.md".into()),
                },
                StorageEntry {
                    name: "skill".into(),
                    mount_path: "/home/user/.codex/skills/workflow".into(),
                    archive_url: "https://example.com/skill.tar.gz".into(),
                    vas_storage_name: "skill".into(),
                    vas_version_id: "v1".into(),
                    instructions_target_filename: None,
                },
            ],
            artifacts: vec![],
        };

        let guest_manifest = GuestDownloadManifest::from_storage_manifest_for_run(
            &manifest,
            "/home/user/.vm0/guest-agent/runs/run-1",
        )
        .unwrap();

        assert_eq!(guest_manifest.storages[0].mount_path, "/home/user/.codex");
        assert_eq!(
            guest_manifest.storages[0].extract_path.as_deref(),
            Some("/home/user/.vm0/guest-agent/runs/run-1/storage-instructions/0")
        );
        assert_eq!(
            guest_manifest.storages[1].mount_path,
            "/home/user/.codex/skills/workflow"
        );
        assert!(guest_manifest.storages[1].extract_path.is_none());
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
                archive_url: Some("https://example.com/artifact.tar.gz".into()),
                vas_storage_name: "memory".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v2".into(),
                empty: None,
                missing_root_policy: None,
            }],
        };

        let value = serde_json::to_value(
            GuestDownloadManifest::try_from_storage_manifest(&manifest, None).unwrap(),
        )
        .unwrap();

        assert!(value["cleanupPaths"].is_array());
        assert!(value.get("instructionCleanups").is_none());
        assert_eq!(value["storages"][0]["cached"], false);
        assert!(value["storages"][0].get("extractPath").is_none());
        assert!(value["storages"][0].get("name").is_none());
        assert_eq!(value["artifacts"][0]["cached"], false);
        assert!(value["artifacts"][0].get("empty").is_none());
        assert!(value["artifacts"][0].get("manifestUrl").is_none());
        assert!(value["artifacts"][0].get("missingRootPolicy").is_none());
    }

    #[test]
    fn heartbeat_state_serializes_camel_case() {
        let state = HeartbeatState {
            runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            runner_name: "runner-1".into(),
            group: "vm0/production".into(),
            total_vcpu: 16,
            total_memory_mb: 32768,
            max_concurrent: 8,
            allocated_vcpu: 6,
            allocated_memory_mb: 6144,
            running_count: 2,
            admittable_profiles: vec!["vm0/default".into()],
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
        assert_eq!(json["admittableProfiles"], json!(["vm0/default"]));
        assert!(json.get("profiles").is_none());
        assert!(json.get("availableProfiles").is_none());
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
