//! Proxy registry schema and file persistence.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::state_file::PROXY_REGISTRY_MAX_BYTES;
use crate::types::{FirewallEntry, NetworkPolicy, SecretConnectorMetadata};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyRegistry {
    vms: HashMap<String, VmEntry>,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VmEntry {
    run_id: String,
    cli_agent_type: String,
    sandbox_token: String,
    registered_at: i64,
    network_log_path: String,
    proxy_log_path: String,
    firewalls: Option<Vec<FirewallEntry>>,
    network_policies: Option<HashMap<String, NetworkPolicy>>,
    encrypted_secrets: Option<String>,
    secret_connector_map: Option<HashMap<String, String>>,
    secret_connector_metadata_map: Option<HashMap<String, SecretConnectorMetadata>>,
    vars: Option<HashMap<String, String>>,
    #[serde(default)]
    capture_network_bodies: bool,
    billable_firewalls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_usage_provider: Option<String>,
}

/// Parameters for registering a VM in the proxy registry.
#[derive(Debug)]
pub struct VmRegistration<'a> {
    pub run_id: &'a str,
    pub cli_agent_type: &'a str,
    pub sandbox_token: &'a str,
    pub network_log_path: &'a std::path::Path,
    pub proxy_log_path: &'a std::path::Path,
    pub firewalls: Option<&'a [FirewallEntry]>,
    pub network_policies: Option<&'a HashMap<String, NetworkPolicy>>,
    pub encrypted_secrets: Option<&'a str>,
    pub secret_connector_map: Option<&'a HashMap<String, String>>,
    pub secret_connector_metadata_map: Option<&'a HashMap<String, SecretConnectorMetadata>>,
    pub vars: Option<&'a HashMap<String, String>>,
    pub capture_network_bodies: bool,
    pub billable_firewalls: &'a [String],
    pub model_usage_provider: Option<&'a str>,
}

async fn read_registry(path: &std::path::Path) -> RunnerResult<ProxyRegistry> {
    let content = crate::state_file::read_to_string(
        path,
        PROXY_REGISTRY_MAX_BYTES,
        crate::state_file::OwnerCheck::CurrentEuid,
    )
    .await?
    .ok_or_else(|| RunnerError::Internal(format!("read registry {}: not found", path.display())))?;
    serde_json::from_str(&content)
        .map_err(|e| RunnerError::Internal(format!("parse registry: {e}")))
}

/// Write the proxy registry while preserving capacity for every stored policy
/// to transition to fail-closed.
///
/// On supported Unix runner hosts, this ensures the Python mitm-addon never
/// reads a partially-written file.
async fn write_registry(path: &std::path::Path, value: &ProxyRegistry) -> RunnerResult<()> {
    let fail_closed_reserve = fail_closed_capacity_bytes(value)?;
    write_registry_with_reserve(path, value, fail_closed_reserve).await
}

async fn write_registry_consuming_fail_closed_capacity(
    path: &Path,
    value: &ProxyRegistry,
) -> RunnerResult<()> {
    write_registry_with_reserve(path, value, 0).await
}

async fn write_registry_with_reserve(
    path: &Path,
    value: &ProxyRegistry,
    fail_closed_reserve: u64,
) -> RunnerResult<()> {
    let content = serde_json::to_vec(value)
        .map_err(|e| RunnerError::Internal(format!("serialize registry: {e}")))?;
    let content_bytes = content.len() as u64;
    let required_bytes = content_bytes
        .checked_add(fail_closed_reserve)
        .ok_or_else(|| RunnerError::Internal("proxy registry size overflow".to_string()))?;
    if required_bytes > PROXY_REGISTRY_MAX_BYTES {
        return Err(RunnerError::Internal(format!(
            "proxy registry {} requires {required_bytes} bytes ({content_bytes} serialized plus \
             {fail_closed_reserve} reserved for fail-closed policy updates), exceeds \
             {PROXY_REGISTRY_MAX_BYTES} bytes",
            path.display()
        )));
    }
    remove_legacy_registry_tmp(path).await?;
    crate::state_file::write_private_atomic(path, &content).await
}

fn fail_closed_capacity_bytes(value: &ProxyRegistry) -> RunnerResult<u64> {
    // Replacing a policy changes only that independent JSON object value. The
    // sum of positive per-policy deltas is therefore the maximum growth across
    // any subset of sequential fail-closed transitions.
    value
        .vms
        .values()
        .filter_map(|vm| vm.network_policies.as_ref())
        .flat_map(|policies| policies.values())
        .try_fold(0_u64, |reserve, policy| {
            let current_bytes = serde_json::to_vec(policy)
                .map_err(|e| RunnerError::Internal(format!("serialize network policy: {e}")))?
                .len() as u64;
            let fail_closed_bytes = serde_json::to_vec(&fail_closed_policy(policy))
                .map_err(|e| {
                    RunnerError::Internal(format!("serialize fail-closed network policy: {e}"))
                })?
                .len() as u64;
            reserve
                .checked_add(fail_closed_bytes.saturating_sub(current_bytes))
                .ok_or_else(|| {
                    RunnerError::Internal("proxy registry fail-closed reserve overflow".to_string())
                })
        })
}

async fn remove_legacy_registry_tmp(path: &Path) -> RunnerResult<()> {
    let tmp = path.with_extension("json.tmp");
    match tokio::fs::remove_file(&tmp).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove stale registry tmp {}: {e}",
            tmp.display()
        ))),
    }
}

/// Lightweight, cloneable handle for proxy registry operations.
///
/// Uses file locking (`flock`) to ensure concurrent register/unregister calls
/// from multiple executor tasks don't corrupt the registry JSON.
#[derive(Clone)]
pub struct ProxyRegistryHandle {
    pub(super) registry_path: PathBuf,
    pub(super) lock_path: PathBuf,
}

impl ProxyRegistryHandle {
    /// Create a handle from explicit paths (for testing).
    #[cfg(test)]
    pub fn new(registry_path: PathBuf, lock_path: PathBuf) -> Self {
        Self {
            registry_path,
            lock_path,
        }
    }

    /// Register a VM in the proxy registry.
    pub async fn register_vm(
        &self,
        source_ip: &str,
        registration: &VmRegistration<'_>,
    ) -> RunnerResult<()> {
        let _guard = lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        let now = chrono::Utc::now().timestamp_millis();
        let firewalls = registration.firewalls.map(|s| s.to_vec());
        registry.vms.insert(
            source_ip.to_string(),
            VmEntry {
                run_id: registration.run_id.to_string(),
                cli_agent_type: registration.cli_agent_type.to_string(),
                sandbox_token: registration.sandbox_token.to_string(),
                registered_at: now,
                network_log_path: registration.network_log_path.to_string_lossy().into_owned(),
                proxy_log_path: registration.proxy_log_path.to_string_lossy().into_owned(),
                firewalls,
                network_policies: registration.network_policies.cloned(),
                encrypted_secrets: registration.encrypted_secrets.map(String::from),
                secret_connector_map: registration.secret_connector_map.cloned(),
                secret_connector_metadata_map: registration.secret_connector_metadata_map.cloned(),
                vars: registration.vars.cloned(),
                capture_network_bodies: registration.capture_network_bodies,
                billable_firewalls: registration.billable_firewalls.to_vec(),
                model_usage_provider: registration.model_usage_provider.map(String::from),
            },
        );
        registry.updated_at = now;
        write_registry(&self.registry_path, &registry).await?;
        info!(
            source_ip,
            run_id = registration.run_id,
            "registered VM in proxy registry"
        );
        Ok(())
    }

    /// Unregister a VM from the proxy registry.
    pub async fn unregister_vm(&self, source_ip: &str) -> RunnerResult<()> {
        let _guard = lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        registry.vms.remove(source_ip);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry(&self.registry_path, &registry).await?;
        info!(source_ip, "unregistered VM from proxy registry");
        Ok(())
    }

    /// Patch one network policy only if the source IP still belongs to `run_id`.
    ///
    /// Returns `Ok(false)` when the VM is gone, belongs to another run, or does
    /// not contain the requested connector firewall.
    pub async fn patch_network_policy_if_run_matches(
        &self,
        source_ip: &str,
        run_id: &str,
        connector_ref: &str,
        policy: NetworkPolicy,
    ) -> RunnerResult<bool> {
        self.patch_existing_network_policy(source_ip, run_id, connector_ref, policy)
            .await
    }

    /// Replace one network policy with deny-all if the source IP still belongs
    /// to `run_id`.
    pub async fn fail_closed_network_policy_if_run_matches(
        &self,
        source_ip: &str,
        run_id: &str,
        connector_ref: &str,
    ) -> RunnerResult<bool> {
        let _guard = lock::acquire(self.lock_path.clone()).await?;
        self.fail_closed_network_policy_locked(source_ip, run_id, connector_ref)
            .await
    }

    async fn fail_closed_network_policy_locked(
        &self,
        source_ip: &str,
        run_id: &str,
        connector_ref: &str,
    ) -> RunnerResult<bool> {
        let mut registry = read_registry(&self.registry_path).await?;
        let Some(vm) = registry.vms.get_mut(source_ip) else {
            return Ok(false);
        };
        if vm.run_id != run_id {
            return Ok(false);
        }

        if !vm_has_connector_firewall(vm, connector_ref) {
            return Ok(false);
        }
        let Some(policy) = vm
            .network_policies
            .as_mut()
            .and_then(|policies| policies.get_mut(connector_ref))
        else {
            return Ok(false);
        };
        *policy = fail_closed_policy(policy);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry_consuming_fail_closed_capacity(&self.registry_path, &registry).await?;
        info!(
            source_ip,
            run_id, connector_ref, "failed closed connector network policy in proxy registry"
        );
        Ok(true)
    }

    async fn patch_existing_network_policy(
        &self,
        source_ip: &str,
        run_id: &str,
        connector_ref: &str,
        policy: NetworkPolicy,
    ) -> RunnerResult<bool> {
        let _guard = lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        let Some(vm) = registry.vms.get_mut(source_ip) else {
            return Ok(false);
        };
        if vm.run_id != run_id || !vm_has_connector_firewall(vm, connector_ref) {
            return Ok(false);
        }

        vm.network_policies
            .get_or_insert_with(HashMap::new)
            .insert(connector_ref.to_string(), policy);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry(&self.registry_path, &registry).await?;
        info!(
            source_ip,
            run_id, connector_ref, "patched connector network policy in proxy registry"
        );
        Ok(true)
    }
}

fn fail_closed_policy(policy: &NetworkPolicy) -> NetworkPolicy {
    let mut permission_names = policy.allow.clone();
    permission_names.extend(policy.deny.iter().cloned());
    permission_names.extend(policy.ask.iter().cloned());
    permission_names.sort();
    permission_names.dedup();
    NetworkPolicy {
        allow: Vec::new(),
        deny: permission_names,
        ask: Vec::new(),
        unknown_policy: "deny".to_string(),
    }
}

fn vm_has_connector_firewall(vm: &VmEntry, connector_ref: &str) -> bool {
    vm.firewalls.as_deref().is_some_and(|firewalls| {
        firewalls
            .iter()
            .any(|entry| firewall_entry_matches(entry, connector_ref))
    })
}

fn firewall_entry_matches(entry: &FirewallEntry, connector_ref: &str) -> bool {
    match entry {
        FirewallEntry::Builtin { name, .. } => name == connector_ref,
        FirewallEntry::Inline { firewall } => firewall.name == connector_ref,
    }
}

pub(super) async fn write_empty_registry(path: &Path) -> RunnerResult<()> {
    let empty_registry = ProxyRegistry {
        vms: HashMap::new(),
        updated_at: 0,
    };
    write_registry(path, &empty_registry).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Firewall, FirewallApi, FirewallAuth, FirewallBaseHostPolicy, FirewallEntry,
        FirewallMcpPolicy, FirewallMcpToolPolicy, FirewallPermission,
    };
    use std::os::unix::fs::PermissionsExt;

    struct RegistryHarness {
        _dir: tempfile::TempDir,
        registry_path: PathBuf,
        handle: ProxyRegistryHandle,
    }

    impl RegistryHarness {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let registry_path = dir.path().join("proxy-registry.json");
            let lock_path = dir.path().join("proxy-registry.lock");
            write_empty_registry(&registry_path).await.unwrap();
            let handle = ProxyRegistryHandle::new(registry_path.clone(), lock_path);

            Self {
                _dir: dir,
                registry_path,
                handle,
            }
        }

        fn registry_path(&self) -> &Path {
            &self.registry_path
        }
    }

    fn base_registration<'a>() -> VmRegistration<'a> {
        VmRegistration {
            run_id: "run-test",
            cli_agent_type: "claude-code",
            sandbox_token: "tok",
            network_log_path: Path::new("/tmp/network-run-test.jsonl"),
            proxy_log_path: Path::new("/tmp/proxy-run-test.jsonl"),
            firewalls: None,
            network_policies: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        }
    }

    fn test_firewalls(connector_refs: &[&str]) -> Vec<FirewallEntry> {
        connector_refs
            .iter()
            .map(|connector_ref| FirewallEntry::Inline {
                firewall: Firewall {
                    name: (*connector_ref).to_string(),
                    apis: vec![FirewallApi {
                        id: format!("{connector_ref}-rest"),
                        base: format!("https://api.{connector_ref}.com"),
                        auth: FirewallAuth {
                            headers: HashMap::new(),
                            base: None,
                            query: None,
                            aws_sigv4: None,
                        },
                        host_policy: None,
                        permissions: Some(vec![
                            FirewallPermission {
                                name: "repos.read".to_string(),
                                description: None,
                                rules: vec!["GET /repos/{owner}/{repo}".to_string()],
                            },
                            FirewallPermission {
                                name: "issues.write".to_string(),
                                description: None,
                                rules: vec!["POST /repos/{owner}/{repo}/issues".to_string()],
                            },
                        ]),
                        mcp: None,
                        suppress_body_capture: false,
                    }],
                },
            })
            .collect()
    }

    fn policy(allow: &[&str], deny: &[&str], ask: &[&str], unknown_policy: &str) -> NetworkPolicy {
        NetworkPolicy {
            allow: allow.iter().map(|value| (*value).to_string()).collect(),
            deny: deny.iter().map(|value| (*value).to_string()).collect(),
            ask: ask.iter().map(|value| (*value).to_string()).collect(),
            unknown_policy: unknown_policy.to_string(),
        }
    }

    #[tokio::test]
    async fn registry_register_and_unregister() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        // Register a VM.
        let mut registry = read_registry(&registry_path).await.unwrap();
        registry.vms.insert(
            "10.200.0.2".to_string(),
            VmEntry {
                run_id: "test-run".to_string(),
                cli_agent_type: "claude-code".to_string(),
                sandbox_token: String::new(),
                registered_at: 1000,
                network_log_path: "/tmp/network-test-run.jsonl".to_string(),
                proxy_log_path: "/tmp/proxy-test-run.jsonl".to_string(),
                firewalls: None,
                network_policies: None,
                encrypted_secrets: None,
                secret_connector_map: None,
                secret_connector_metadata_map: None,
                vars: None,
                capture_network_bodies: false,
                billable_firewalls: vec![],
                model_usage_provider: None,
            },
        );
        write_registry(&registry_path, &registry).await.unwrap();

        // Verify registration.
        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "test-run");

        // Unregister the VM.
        let mut registry = read_registry(&registry_path).await.unwrap();
        registry.vms.remove("10.200.0.2");
        write_registry(&registry_path, &registry).await.unwrap();

        // Verify unregistration.
        let loaded = read_registry(&registry_path).await.unwrap();
        assert!(
            !loaded.vms.contains_key("10.200.0.2"),
            "VM should be removed from registry"
        );
    }

    #[tokio::test]
    async fn write_registry_writes_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };

        write_registry(&registry_path, &empty).await.unwrap();

        assert_eq!(
            std::fs::metadata(&registry_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn write_registry_repairs_existing_wide_file_mode() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        std::fs::write(&registry_path, r#"{"vms":{},"updatedAt":0}"#).unwrap();
        let mut permissions = std::fs::metadata(&registry_path).unwrap().permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&registry_path, permissions).unwrap();
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };

        write_registry(&registry_path, &empty).await.unwrap();

        assert_eq!(
            std::fs::metadata(&registry_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn write_registry_removes_stale_fixed_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let legacy_tmp = registry_path.with_extension("json.tmp");
        std::fs::write(&legacy_tmp, b"stale").unwrap();
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };

        write_registry(&registry_path, &empty).await.unwrap();

        assert!(
            !legacy_tmp.exists(),
            "stale fixed registry tmp was not removed"
        );
        read_registry(&registry_path).await.unwrap();
    }

    #[tokio::test]
    async fn write_registry_removes_stale_fixed_tmp_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let legacy_tmp = registry_path.with_extension("json.tmp");
        let outside = dir.path().join("outside-target");
        std::fs::write(&outside, b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, &legacy_tmp).unwrap();
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };

        write_registry(&registry_path, &empty).await.unwrap();

        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
        assert!(
            std::fs::symlink_metadata(&legacy_tmp).is_err(),
            "stale fixed registry tmp symlink was not removed"
        );
    }

    #[tokio::test]
    async fn read_registry_rejects_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let outside = dir.path().join("outside-registry.json");
        std::fs::write(&outside, r#"{"vms":{},"updatedAt":0}"#).unwrap();
        std::os::unix::fs::symlink(&outside, &registry_path).unwrap();

        let error = read_registry(&registry_path)
            .await
            .err()
            .expect("expected symlink registry rejection");

        assert!(
            error.to_string().contains("open state file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_registry_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        std::fs::create_dir(&registry_path).unwrap();

        let error = read_registry(&registry_path)
            .await
            .err()
            .expect("expected directory registry rejection");

        assert!(
            error.to_string().contains("not a regular state file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_registry_rejects_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        std::fs::write(
            &registry_path,
            vec![b' '; crate::state_file::PROXY_REGISTRY_MAX_BYTES as usize + 1],
        )
        .unwrap();

        let error = read_registry(&registry_path)
            .await
            .err()
            .expect("expected oversized registry rejection");

        assert!(
            error.to_string().contains("exceeds"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn registry_handle_register_and_unregister() {
        let harness = RegistryHarness::new().await;

        // Register via handle.
        let registration = VmRegistration {
            run_id: "run-1",
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &registration)
            .await
            .unwrap();

        let loaded = read_registry(harness.registry_path()).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "run-1");

        // Re-register same IP overwrites the entry.
        let registration2 = VmRegistration {
            run_id: "run-2",
            cli_agent_type: "codex",
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &registration2)
            .await
            .unwrap();
        let loaded = read_registry(harness.registry_path()).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "run-2");
        assert_eq!(vm.cli_agent_type, "codex");

        // Unregister via handle.
        harness.handle.unregister_vm("10.200.0.2").await.unwrap();

        let loaded = read_registry(harness.registry_path()).await.unwrap();
        assert!(!loaded.vms.contains_key("10.200.0.2"));

        // Unregister non-existent IP is a no-op.
        harness.handle.unregister_vm("10.200.0.99").await.unwrap();
    }

    #[tokio::test]
    async fn oversized_registration_preserves_readable_registry() {
        let harness = RegistryHarness::new().await;
        let existing = VmRegistration {
            run_id: "run-existing",
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &existing)
            .await
            .unwrap();
        let previous_bytes = tokio::fs::read(harness.registry_path()).await.unwrap();

        let oversized_vars = HashMap::from([(
            "OVERSIZED".to_string(),
            "x".repeat(PROXY_REGISTRY_MAX_BYTES as usize),
        )]);
        let oversized = VmRegistration {
            run_id: "run-oversized",
            vars: Some(&oversized_vars),
            ..base_registration()
        };
        let error = harness
            .handle
            .register_vm("10.200.0.3", &oversized)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains(&format!("exceeds {PROXY_REGISTRY_MAX_BYTES} bytes")),
            "unexpected error: {error}"
        );
        assert_eq!(
            tokio::fs::read(harness.registry_path()).await.unwrap(),
            previous_bytes,
            "a rejected registration must not replace the readable registry"
        );
        let loaded = read_registry(harness.registry_path()).await.unwrap();
        assert!(loaded.vms.contains_key("10.200.0.2"));
        assert!(!loaded.vms.contains_key("10.200.0.3"));

        harness.handle.unregister_vm("10.200.0.2").await.unwrap();
        let later = VmRegistration {
            run_id: "run-later",
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.3", &later)
            .await
            .unwrap();
        harness.handle.unregister_vm("10.200.0.3").await.unwrap();
        assert!(
            read_registry(harness.registry_path())
                .await
                .unwrap()
                .vms
                .is_empty()
        );
    }

    #[tokio::test]
    async fn near_limit_registry_preserves_fail_closed_capacity() {
        let harness = RegistryHarness::new().await;
        let firewalls = test_firewalls(&["github", "slack"]);
        let initial_policy = policy(
            &["allow.permission"],
            &["deny.permission"],
            &["ask.permission"],
            "ask",
        );
        let network_policies = HashMap::from([
            ("github".to_string(), initial_policy.clone()),
            ("slack".to_string(), initial_policy),
        ]);
        let empty_padding = HashMap::from([("PADDING".to_string(), String::new())]);
        let measured = VmRegistration {
            run_id: "run-near-limit",
            firewalls: Some(&firewalls),
            network_policies: Some(&network_policies),
            vars: Some(&empty_padding),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &measured)
            .await
            .unwrap();
        let normal_bytes = tokio::fs::read(harness.registry_path()).await.unwrap();
        harness
            .handle
            .fail_closed_network_policy_if_run_matches("10.200.0.2", "run-near-limit", "github")
            .await
            .unwrap();
        let after_first_fail_closed = tokio::fs::read(harness.registry_path()).await.unwrap();
        let first_fail_closed_growth = after_first_fail_closed
            .len()
            .checked_sub(normal_bytes.len())
            .expect("test policy should grow when failed closed");
        assert!(first_fail_closed_growth > 0);
        harness
            .handle
            .fail_closed_network_policy_if_run_matches("10.200.0.2", "run-near-limit", "slack")
            .await
            .unwrap();
        let after_all_fail_closed = tokio::fs::read(harness.registry_path()).await.unwrap();
        let second_fail_closed_growth = after_all_fail_closed
            .len()
            .checked_sub(after_first_fail_closed.len())
            .expect("second test policy should grow when failed closed");
        assert!(second_fail_closed_growth > 0);
        let total_fail_closed_growth = first_fail_closed_growth + second_fail_closed_growth;
        harness.handle.unregister_vm("10.200.0.2").await.unwrap();

        let max_bytes = PROXY_REGISTRY_MAX_BYTES as usize;
        let padding_len = max_bytes
            .checked_sub(normal_bytes.len() + total_fail_closed_growth)
            .expect("measured registry should leave room for padding");
        let padding = HashMap::from([("PADDING".to_string(), "x".repeat(padding_len))]);
        let near_limit = VmRegistration {
            run_id: "run-near-limit",
            firewalls: Some(&firewalls),
            network_policies: Some(&network_policies),
            vars: Some(&padding),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &near_limit)
            .await
            .unwrap();
        let before_patch = tokio::fs::read(harness.registry_path()).await.unwrap();
        assert_eq!(before_patch.len() + total_fail_closed_growth, max_bytes);

        let error = harness
            .handle
            .patch_network_policy_if_run_matches(
                "10.200.0.2",
                "run-near-limit",
                "github",
                policy(
                    &["allow.permission", "additional.permission"],
                    &["deny.permission"],
                    &["ask.permission"],
                    "ask",
                ),
            )
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(&format!("exceeds {PROXY_REGISTRY_MAX_BYTES} bytes")),
            "unexpected error: {error}"
        );
        assert_eq!(
            tokio::fs::read(harness.registry_path()).await.unwrap(),
            before_patch,
            "a policy update that consumes fail-closed capacity must be rejected"
        );

        let updated = harness
            .handle
            .fail_closed_network_policy_if_run_matches("10.200.0.2", "run-near-limit", "github")
            .await
            .unwrap();
        assert!(updated);
        let after_first_fail_closed = tokio::fs::read(harness.registry_path()).await.unwrap();
        assert_eq!(
            after_first_fail_closed.len() + second_fail_closed_growth,
            max_bytes
        );
        read_registry(harness.registry_path()).await.unwrap();

        let updated = harness
            .handle
            .fail_closed_network_policy_if_run_matches("10.200.0.2", "run-near-limit", "slack")
            .await
            .unwrap();
        assert!(updated);
        let final_bytes = tokio::fs::read(harness.registry_path()).await.unwrap();
        assert_eq!(final_bytes.len(), max_bytes);
        read_registry(harness.registry_path()).await.unwrap();
    }

    #[tokio::test]
    async fn patch_network_policy_requires_matching_run_and_connector() {
        let harness = RegistryHarness::new().await;
        let firewalls = test_firewalls(&["github"]);
        let mut network_policies = HashMap::new();
        network_policies.insert(
            "github".to_string(),
            policy(&["repos.read"], &[], &[], "ask"),
        );
        let registration = VmRegistration {
            run_id: "run-1",
            firewalls: Some(&firewalls),
            network_policies: Some(&network_policies),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &registration)
            .await
            .unwrap();

        let updated = harness
            .handle
            .patch_network_policy_if_run_matches(
                "10.200.0.2",
                "run-2",
                "github",
                policy(&[], &["repos.read"], &[], "deny"),
            )
            .await
            .unwrap();
        assert!(!updated);

        let updated = harness
            .handle
            .patch_network_policy_if_run_matches(
                "10.200.0.2",
                "run-1",
                "slack",
                policy(&[], &["chat.write"], &[], "deny"),
            )
            .await
            .unwrap();
        assert!(!updated);

        let updated = harness
            .handle
            .patch_network_policy_if_run_matches(
                "10.200.0.2",
                "run-1",
                "github",
                policy(&[], &["repos.read"], &["issues.write"], "deny"),
            )
            .await
            .unwrap();
        assert!(updated);

        let loaded = read_registry(harness.registry_path()).await.unwrap();
        let policy = loaded
            .vms
            .get("10.200.0.2")
            .and_then(|vm| vm.network_policies.as_ref())
            .and_then(|policies| policies.get("github"))
            .unwrap();
        assert_eq!(policy.allow, Vec::<String>::new());
        assert_eq!(policy.deny, vec!["repos.read"]);
        assert_eq!(policy.ask, vec!["issues.write"]);
        assert_eq!(policy.unknown_policy, "deny");
    }

    #[tokio::test]
    async fn fail_closed_network_policy_uses_existing_policy_names() {
        let harness = RegistryHarness::new().await;
        let firewalls = test_firewalls(&["github"]);
        let without_policy = VmRegistration {
            run_id: "run-1",
            firewalls: Some(&firewalls),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &without_policy)
            .await
            .unwrap();
        let updated = harness
            .handle
            .fail_closed_network_policy_if_run_matches("10.200.0.2", "run-1", "github")
            .await
            .unwrap();
        assert!(!updated);

        let mut network_policies = HashMap::new();
        network_policies.insert(
            "github".to_string(),
            policy(&["repos.read"], &["issues.write"], &[], "allow"),
        );
        let registration = VmRegistration {
            run_id: "run-1",
            firewalls: Some(&firewalls),
            network_policies: Some(&network_policies),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.2", &registration)
            .await
            .unwrap();

        let updated = harness
            .handle
            .fail_closed_network_policy_if_run_matches("10.200.0.2", "run-1", "github")
            .await
            .unwrap();
        assert!(updated);

        let loaded = read_registry(harness.registry_path()).await.unwrap();
        let policy = loaded
            .vms
            .get("10.200.0.2")
            .and_then(|vm| vm.network_policies.as_ref())
            .and_then(|policies| policies.get("github"))
            .unwrap();
        assert_eq!(policy.allow, Vec::<String>::new());
        assert_eq!(policy.deny, vec!["issues.write", "repos.read"]);
        assert_eq!(policy.ask, Vec::<String>::new());
        assert_eq!(policy.unknown_policy, "deny");
    }

    #[tokio::test]
    async fn registry_handle_concurrent_access() {
        let harness = RegistryHarness::new().await;

        // Spawn 10 concurrent register tasks.
        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..10 {
            let h = harness.handle.clone();
            let ip = format!("10.200.0.{}", i + 2);
            let run_id_owned = format!("run-{i}");
            tasks.spawn(async move {
                let log_path =
                    std::path::PathBuf::from(format!("/tmp/network-{run_id_owned}.jsonl"));
                let proxy_path =
                    std::path::PathBuf::from(format!("/tmp/proxy-{run_id_owned}.jsonl"));
                let registration = VmRegistration {
                    run_id: &run_id_owned,
                    network_log_path: &log_path,
                    proxy_log_path: &proxy_path,
                    ..base_registration()
                };
                h.register_vm(&ip, &registration).await.unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }

        // All 10 VMs should be registered (no lost updates).
        let loaded = read_registry(harness.registry_path()).await.unwrap();
        assert_eq!(loaded.vms.len(), 10);
    }

    #[tokio::test]
    async fn registry_with_firewalls() {
        let harness = RegistryHarness::new().await;

        let firewall_entries = vec![FirewallEntry::Inline {
            firewall: Firewall {
                name: "gmail".to_string(),
                apis: vec![FirewallApi {
                    id: String::new(),
                    base: "https://gmail.googleapis.com/gmail/v1/users/me".to_string(),
                    auth: FirewallAuth {
                        headers: std::collections::HashMap::from([(
                            "Authorization".to_string(),
                            "Bearer ${{ secrets.GMAIL_TOKEN }}".to_string(),
                        )]),
                        base: None,
                        query: None,
                        aws_sigv4: None,
                    },
                    host_policy: None,
                    permissions: Some(vec![FirewallPermission {
                        name: "mail-read".to_string(),
                        description: None,
                        rules: vec![
                            "GET /messages".to_string(),
                            "GET /messages/{id}".to_string(),
                        ],
                    }]),
                    mcp: None,
                    suppress_body_capture: false,
                }],
            },
        }];

        let registration = VmRegistration {
            firewalls: Some(&firewall_entries),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.5", &registration)
            .await
            .unwrap();

        // Verify firewall entries are stored in registry.
        let loaded = read_registry(harness.registry_path()).await.unwrap();
        let vm = loaded.vms.get("10.200.0.5").unwrap();
        let stored = vm.firewalls.as_ref().unwrap();
        assert_eq!(stored.len(), 1);
        let FirewallEntry::Inline { firewall } = &stored[0] else {
            panic!("expected inline firewall entry");
        };
        assert_eq!(firewall.apis.len(), 1);
        assert_eq!(
            firewall.apis[0].base,
            "https://gmail.googleapis.com/gmail/v1/users/me"
        );
        assert_eq!(firewall.apis[0].id, "");

        // Verify JSON shape matches what the Python addon expects.
        let raw = tokio::fs::read_to_string(harness.registry_path())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let vm_json = &value["vms"]["10.200.0.5"];
        let fw = &vm_json["firewalls"][0];
        assert_eq!(fw["kind"], "inline");
        assert_eq!(fw["firewall"]["name"], "gmail");
        assert_eq!(
            fw["firewall"]["apis"][0]["base"],
            "https://gmail.googleapis.com/gmail/v1/users/me"
        );
        assert_eq!(fw["firewall"]["apis"][0]["id"], "");

        // Verify permissions are preserved in JSON for the Python addon.
        let perms = &fw["firewall"]["apis"][0]["permissions"];
        assert_eq!(perms[0]["name"], "mail-read");
        assert_eq!(perms[0]["rules"][0], "GET /messages");
        assert_eq!(perms[0]["rules"][1], "GET /messages/{id}");

        // Empty billableFirewalls round-trips as [] (Python reads vm_info["billableFirewalls"]).
        assert_eq!(vm_json["billableFirewalls"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn registry_preserves_mcp_enforcement_policy() {
        let harness = RegistryHarness::new().await;
        let firewall_entries = vec![FirewallEntry::Inline {
            firewall: Firewall {
                name: "remote-mcp".to_string(),
                apis: vec![FirewallApi {
                    id: String::new(),
                    base: "https://mcp.example.com/v1/mcp".to_string(),
                    auth: FirewallAuth {
                        headers: HashMap::new(),
                        base: None,
                        query: None,
                        aws_sigv4: None,
                    },
                    host_policy: Some(FirewallBaseHostPolicy::PublicDestination),
                    permissions: None,
                    mcp: Some(FirewallMcpPolicy {
                        tool_policy: FirewallMcpToolPolicy::Exact {
                            tool_names: vec!["search".to_string()],
                        },
                    }),
                    suppress_body_capture: true,
                }],
            },
        }];
        let registration = VmRegistration {
            firewalls: Some(&firewall_entries),
            ..base_registration()
        };

        harness
            .handle
            .register_vm("10.200.0.5", &registration)
            .await
            .unwrap();

        let raw = tokio::fs::read_to_string(harness.registry_path())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let api = &value["vms"]["10.200.0.5"]["firewalls"][0]["firewall"]["apis"][0];
        assert_eq!(api["hostPolicy"]["kind"], "publicDestination");
        assert_eq!(api["mcp"]["toolPolicy"]["kind"], "exact");
        assert_eq!(api["mcp"]["toolPolicy"]["toolNames"][0], "search");
        assert_eq!(api["suppressBodyCapture"], true);
    }

    #[tokio::test]
    async fn registry_serializes_billable_firewalls() {
        let harness = RegistryHarness::new().await;
        let billable = ["model-provider:vm0".to_string()];
        let registration = VmRegistration {
            cli_agent_type: "codex",
            billable_firewalls: &billable,
            model_usage_provider: Some("claude-sonnet-4-6"),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.9", &registration)
            .await
            .unwrap();

        // Guard the TS↔Rust↔Python wire contract: the camelCase key is what
        // mitm-addon reads via `vm_info["billableFirewalls"]`.
        let raw = tokio::fs::read_to_string(harness.registry_path())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["vms"]["10.200.0.9"]["billableFirewalls"],
            serde_json::json!(["model-provider:vm0"])
        );
        assert_eq!(
            value["vms"]["10.200.0.9"]["cliAgentType"],
            serde_json::json!("codex")
        );
        assert_eq!(
            value["vms"]["10.200.0.9"]["modelUsageProvider"],
            serde_json::json!("claude-sonnet-4-6")
        );
    }

    #[tokio::test]
    async fn register_vm_stores_encrypted_secrets() {
        let harness = RegistryHarness::new().await;

        let metadata = HashMap::from([(
            "CHATGPT_ACCESS_TOKEN".to_string(),
            SecretConnectorMetadata {
                source_type: "model-provider".to_string(),
                source_user_id: Some("user-123".to_string()),
                metadata_key: Some("codex-oauth-token".to_string()),
            },
        )]);
        let registration = VmRegistration {
            encrypted_secrets: Some("iv_b64:tag_b64:data_b64"),
            secret_connector_metadata_map: Some(&metadata),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.6", &registration)
            .await
            .unwrap();

        let loaded = read_registry(harness.registry_path()).await.unwrap();
        let vm = loaded.vms.get("10.200.0.6").unwrap();
        assert_eq!(
            vm.encrypted_secrets.as_deref(),
            Some("iv_b64:tag_b64:data_b64")
        );

        // Verify JSON key name matches what the Python addon expects.
        let raw = tokio::fs::read_to_string(harness.registry_path())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["vms"]["10.200.0.6"]["encryptedSecrets"],
            "iv_b64:tag_b64:data_b64"
        );
        assert_eq!(
            value["vms"]["10.200.0.6"]["secretConnectorMetadataMap"]["CHATGPT_ACCESS_TOKEN"]["sourceUserId"],
            "user-123"
        );
    }

    #[tokio::test]
    async fn registry_firewall_auth_base_serialized() {
        let harness = RegistryHarness::new().await;

        let firewall_entries = vec![FirewallEntry::Inline {
            firewall: Firewall {
                name: "discord-webhook".to_string(),
                apis: vec![FirewallApi {
                    id: String::new(),
                    base: "https://firewall-placeholder.vm3.ai/discord-webhook/hook".to_string(),
                    auth: FirewallAuth {
                        headers: std::collections::HashMap::new(),
                        base: Some("${{ secrets.DISCORD_WEBHOOK_URL }}".to_string()),
                        query: None,
                        aws_sigv4: None,
                    },
                    host_policy: None,
                    permissions: None,
                    mcp: None,
                    suppress_body_capture: false,
                }],
            },
        }];

        let registration = VmRegistration {
            firewalls: Some(&firewall_entries),
            encrypted_secrets: Some("enc_data"),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.7", &registration)
            .await
            .unwrap();

        // Verify auth.base is preserved in the registry JSON.
        let raw = tokio::fs::read_to_string(harness.registry_path())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let api = &value["vms"]["10.200.0.7"]["firewalls"][0]["firewall"]["apis"][0];
        assert_eq!(api["auth"]["base"], "${{ secrets.DISCORD_WEBHOOK_URL }}");
        // headers should be empty object
        assert_eq!(api["auth"]["headers"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn registry_firewall_auth_query_serialized() {
        let harness = RegistryHarness::new().await;

        let firewall_entries = vec![FirewallEntry::Inline {
            firewall: Firewall {
                name: "serpapi".to_string(),
                apis: vec![FirewallApi {
                    id: String::new(),
                    base: "https://serpapi.com".to_string(),
                    auth: FirewallAuth {
                        headers: std::collections::HashMap::new(),
                        base: None,
                        query: Some(
                            [(
                                "api_key".to_string(),
                                "${{ secrets.SERPAPI_TOKEN }}".to_string(),
                            )]
                            .into_iter()
                            .collect(),
                        ),
                        aws_sigv4: None,
                    },
                    host_policy: None,
                    permissions: None,
                    mcp: None,
                    suppress_body_capture: false,
                }],
            },
        }];

        let registration = VmRegistration {
            firewalls: Some(&firewall_entries),
            encrypted_secrets: Some("enc_data"),
            ..base_registration()
        };
        harness
            .handle
            .register_vm("10.200.0.8", &registration)
            .await
            .unwrap();

        // Verify auth.query is preserved in the registry JSON.
        let raw = tokio::fs::read_to_string(harness.registry_path())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let api = &value["vms"]["10.200.0.8"]["firewalls"][0]["firewall"]["apis"][0];
        assert_eq!(
            api["auth"]["query"],
            serde_json::json!({"api_key": "${{ secrets.SERPAPI_TOKEN }}"})
        );
        // headers should be empty object, base should be absent
        assert_eq!(api["auth"]["headers"], serde_json::json!({}));
        assert_eq!(api["auth"]["base"], serde_json::Value::Null);
    }
}
