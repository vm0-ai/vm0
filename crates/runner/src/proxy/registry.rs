//! Proxy registry schema and file persistence.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::types::{FirewallEntry, NetworkPolicy, SecretConnectorMetadata};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProxyRegistry {
    pub(super) vms: HashMap<String, VmEntry>,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VmEntry {
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

pub(super) async fn read_registry(path: &std::path::Path) -> RunnerResult<ProxyRegistry> {
    let content = crate::state_file::read_to_string(
        path,
        crate::state_file::PROXY_REGISTRY_MAX_BYTES,
        crate::state_file::OwnerCheck::CurrentEuid,
    )
    .await?
    .ok_or_else(|| RunnerError::Internal(format!("read registry {}: not found", path.display())))?;
    serde_json::from_str(&content)
        .map_err(|e| RunnerError::Internal(format!("parse registry: {e}")))
}

/// Write the proxy registry JSON file atomically (write tmp + rename).
///
/// This ensures the Python mitm-addon never reads a partially-written file.
pub(super) async fn write_registry(
    path: &std::path::Path,
    value: &ProxyRegistry,
) -> RunnerResult<()> {
    let content = serde_json::to_string(value)
        .map_err(|e| RunnerError::Internal(format!("serialize registry: {e}")))?;
    remove_legacy_registry_tmp(path).await?;
    crate::state_file::write_private_atomic(path, content.as_bytes()).await
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
    use crate::types::{Firewall, FirewallApi, FirewallAuth, FirewallEntry, FirewallPermission};
    use std::os::unix::fs::PermissionsExt;

    fn make_fifo(path: &Path) {
        let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );
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
    async fn read_registry_rejects_fifo_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        make_fifo(&registry_path);

        let error = read_registry(&registry_path)
            .await
            .err()
            .expect("expected fifo registry rejection");

        assert!(
            error.to_string().contains("not a regular state file"),
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
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.json.lock");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };

        // Register via handle.
        let registration = VmRegistration {
            run_id: "run-1",
            cli_agent_type: "claude-code",
            sandbox_token: "tok-1",
            network_log_path: std::path::Path::new("/tmp/network-run-1.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-1.jsonl"),
            firewalls: None,
            network_policies: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        };
        handle
            .register_vm("10.200.0.2", &registration)
            .await
            .unwrap();

        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "run-1");

        // Re-register same IP overwrites the entry.
        let registration2 = VmRegistration {
            run_id: "run-2",
            cli_agent_type: "codex",
            sandbox_token: "tok-2",
            network_log_path: std::path::Path::new("/tmp/network-run-2.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-2.jsonl"),
            firewalls: None,
            network_policies: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        };
        handle
            .register_vm("10.200.0.2", &registration2)
            .await
            .unwrap();
        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "run-2");
        assert_eq!(vm.cli_agent_type, "codex");

        // Unregister via handle.
        handle.unregister_vm("10.200.0.2").await.unwrap();

        let loaded = read_registry(&registry_path).await.unwrap();
        assert!(!loaded.vms.contains_key("10.200.0.2"));

        // Unregister non-existent IP is a no-op.
        handle.unregister_vm("10.200.0.99").await.unwrap();
    }

    #[tokio::test]
    async fn registry_handle_concurrent_access() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.json.lock");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };

        // Spawn 10 concurrent register tasks.
        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..10 {
            let h = handle.clone();
            let ip = format!("10.200.0.{}", i + 2);
            let run_id_owned = format!("run-{i}");
            tasks.spawn(async move {
                let log_path =
                    std::path::PathBuf::from(format!("/tmp/network-{run_id_owned}.jsonl"));
                let proxy_path =
                    std::path::PathBuf::from(format!("/tmp/proxy-{run_id_owned}.jsonl"));
                let registration = VmRegistration {
                    run_id: &run_id_owned,
                    cli_agent_type: "claude-code",
                    sandbox_token: "",
                    network_log_path: &log_path,
                    proxy_log_path: &proxy_path,
                    firewalls: None,
                    network_policies: None,
                    encrypted_secrets: None,
                    secret_connector_map: None,
                    secret_connector_metadata_map: None,
                    vars: None,
                    capture_network_bodies: false,
                    billable_firewalls: &[],
                    model_usage_provider: None,
                };
                h.register_vm(&ip, &registration).await.unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }

        // All 10 VMs should be registered (no lost updates).
        let loaded = read_registry(&registry_path).await.unwrap();
        assert_eq!(loaded.vms.len(), 10);
    }

    #[tokio::test]
    async fn registry_with_firewalls() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.json.lock");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };

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
                    },
                    permissions: Some(vec![FirewallPermission {
                        name: "mail-read".to_string(),
                        description: None,
                        rules: vec![
                            "GET /messages".to_string(),
                            "GET /messages/{id}".to_string(),
                        ],
                    }]),
                }],
            },
        }];

        let registration = VmRegistration {
            run_id: "run-fw",
            cli_agent_type: "claude-code",
            sandbox_token: "tok",
            network_log_path: std::path::Path::new("/tmp/network-run-fw.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-fw.jsonl"),
            firewalls: Some(&firewall_entries),
            network_policies: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        };
        handle
            .register_vm("10.200.0.5", &registration)
            .await
            .unwrap();

        // Verify firewall entries are stored in registry.
        let loaded = read_registry(&registry_path).await.unwrap();
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
        let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
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
    async fn registry_serializes_billable_firewalls() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.json.lock");
        write_registry(
            &registry_path,
            &ProxyRegistry {
                vms: HashMap::new(),
                updated_at: 0,
            },
        )
        .await
        .unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };
        let billable = ["model-provider:vm0".to_string()];
        let registration = VmRegistration {
            run_id: "run-billing",
            cli_agent_type: "codex",
            sandbox_token: "tok",
            network_log_path: std::path::Path::new("/tmp/network-run-billing.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-billing.jsonl"),
            firewalls: None,
            network_policies: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &billable,
            model_usage_provider: Some("claude-sonnet-4-6"),
        };
        handle
            .register_vm("10.200.0.9", &registration)
            .await
            .unwrap();

        // Guard the TS↔Rust↔Python wire contract: the camelCase key is what
        // mitm-addon reads via `vm_info["billableFirewalls"]`.
        let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.lock");

        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };

        let metadata = HashMap::from([(
            "CHATGPT_ACCESS_TOKEN".to_string(),
            SecretConnectorMetadata {
                source_type: "model-provider".to_string(),
                source_user_id: Some("user-123".to_string()),
                metadata_key: Some("codex-oauth-token".to_string()),
            },
        )]);
        let registration = VmRegistration {
            run_id: "run-enc",
            cli_agent_type: "claude-code",
            sandbox_token: "tok",
            network_log_path: std::path::Path::new("/tmp/network-run-enc.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-enc.jsonl"),
            firewalls: None,
            network_policies: None,
            encrypted_secrets: Some("iv_b64:tag_b64:data_b64"),
            secret_connector_map: None,
            secret_connector_metadata_map: Some(&metadata),
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        };
        handle
            .register_vm("10.200.0.6", &registration)
            .await
            .unwrap();

        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.6").unwrap();
        assert_eq!(
            vm.encrypted_secrets.as_deref(),
            Some("iv_b64:tag_b64:data_b64")
        );

        // Verify JSON key name matches what the Python addon expects.
        let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.lock");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };

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
                    },
                    permissions: None,
                }],
            },
        }];

        let registration = VmRegistration {
            run_id: "run-webhook",
            cli_agent_type: "claude-code",
            sandbox_token: "tok",
            network_log_path: std::path::Path::new("/tmp/network-run-webhook.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-webhook.jsonl"),
            firewalls: Some(&firewall_entries),
            network_policies: None,
            encrypted_secrets: Some("enc_data"),
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        };
        handle
            .register_vm("10.200.0.7", &registration)
            .await
            .unwrap();

        // Verify auth.base is preserved in the registry JSON.
        let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let api = &value["vms"]["10.200.0.7"]["firewalls"][0]["firewall"]["apis"][0];
        assert_eq!(api["auth"]["base"], "${{ secrets.DISCORD_WEBHOOK_URL }}");
        // headers should be empty object
        assert_eq!(api["auth"]["headers"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn registry_firewall_auth_query_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.lock");
        let empty = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&registry_path, &empty).await.unwrap();

        let handle = ProxyRegistryHandle {
            registry_path: registry_path.clone(),
            lock_path,
        };

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
                    },
                    permissions: None,
                }],
            },
        }];

        let registration = VmRegistration {
            run_id: "run-query-auth",
            cli_agent_type: "claude-code",
            sandbox_token: "tok",
            network_log_path: std::path::Path::new("/tmp/network-run-query.jsonl"),
            proxy_log_path: std::path::Path::new("/tmp/proxy-run-query.jsonl"),
            firewalls: Some(&firewall_entries),
            network_policies: None,
            encrypted_secrets: Some("enc_data"),
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: &[],
            model_usage_provider: None,
        };
        handle
            .register_vm("10.200.0.8", &registration)
            .await
            .unwrap();

        // Verify auth.query is preserved in the registry JSON.
        let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
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
