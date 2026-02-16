use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncBufReadExt;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};

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
    sandbox_token: String,
    registered_at: i64,
    firewall_rules: Vec<FirewallRule>,
    mitm_enabled: bool,
    seal_secrets_enabled: bool,
    network_log_path: String,
}

/// Firewall rule for network filtering (first-match-wins).
///
/// Variants:
/// - Domain rule: `{ "domain": "*.example.com", "action": "ALLOW" }`
/// - IP rule: `{ "ip": "10.0.0.0/8", "action": "DENY" }`
/// - Terminal rule: `{ "final": "DENY" }`
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirewallRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(rename = "final", skip_serializing_if = "Option::is_none")]
    pub terminal: Option<FirewallAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<FirewallAction>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FirewallAction {
    #[serde(rename = "ALLOW")]
    Allow,
    #[serde(rename = "DENY")]
    Deny,
}

/// Parameters for registering a VM in the proxy registry.
#[derive(Debug)]
pub struct VmRegistration<'a> {
    pub run_id: &'a str,
    pub sandbox_token: &'a str,
    pub firewall_rules: &'a [FirewallRule],
    pub mitm_enabled: bool,
    pub seal_secrets_enabled: bool,
    pub network_log_path: &'a std::path::Path,
}

/// Embedded mitmproxy addon script (compiled into the binary).
const MITM_ADDON: &str = include_str!("../scripts/mitm-addon.py");

/// Timeout for waiting for mitmdump to become ready after spawn.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Timeout for graceful shutdown before SIGKILL.
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

/// Configuration for starting the proxy.
#[derive(Clone)]
pub struct ProxyConfig {
    /// Path to the mitmdump binary.
    pub mitmdump_bin: PathBuf,
    /// Directory containing mitmproxy CA files (mitmproxy-ca.pem).
    pub ca_dir: PathBuf,
    /// Path where the addon script will be written.
    pub addon_path: PathBuf,
    /// Path where the proxy registry JSON will be written.
    pub registry_path: PathBuf,
    /// Lock file path for coordinating concurrent registry access.
    pub registry_lock_path: PathBuf,
    /// VM0 API URL passed to the addon (optional).
    pub api_url: Option<String>,
}

/// Manages the mitmdump process lifecycle and proxy registry.
pub struct MitmProxy {
    port: u16,
    config: ProxyConfig,
    child: Option<tokio::process::Child>,
    /// Sender used by the stdout monitor task to signal unexpected exit.
    crash_tx: mpsc::Sender<()>,
    /// Set to `true` during graceful `stop()` / `Drop` to suppress crash notifications.
    stopping: Arc<AtomicBool>,
}

impl MitmProxy {
    /// Prepare the proxy: allocate a port, write addon script and empty registry.
    ///
    /// Returns `(proxy, crash_rx)`. The caller should select on `crash_rx` to
    /// detect unexpected mitmdump exits and trigger a restart.
    pub async fn new(config: ProxyConfig) -> RunnerResult<(Self, mpsc::Receiver<()>)> {
        let port = find_available_port()?;

        // Write addon script.
        tokio::fs::write(&config.addon_path, MITM_ADDON)
            .await
            .map_err(|e| RunnerError::Internal(format!("write addon: {e}")))?;

        // Write empty registry file.
        let empty_registry = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        write_registry(&config.registry_path, &empty_registry).await?;

        let (crash_tx, crash_rx) = mpsc::channel(1);

        Ok((
            Self {
                port,
                config,
                child: None,
                crash_tx,
                stopping: Arc::new(AtomicBool::new(false)),
            },
            crash_rx,
        ))
    }

    /// Spawn the mitmdump process.
    pub async fn start(&mut self) -> RunnerResult<()> {
        let child = spawn_mitmdump(&self.config, self.port, &self.crash_tx, &self.stopping).await?;
        self.child = Some(child);
        info!(port = self.port, "mitmdump started");
        Ok(())
    }

    /// The port mitmdump is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Create a cloneable handle for registry operations (register/unregister VMs).
    ///
    /// The handle is `Clone + Send + Sync` and uses file locking for concurrent
    /// access, making it safe to share across executor tasks.
    pub fn registry_handle(&self) -> ProxyRegistryHandle {
        ProxyRegistryHandle {
            registry_path: self.config.registry_path.clone(),
            lock_path: self.config.registry_lock_path.clone(),
        }
    }

    /// Register a VM in the proxy registry so the addon can identify its traffic.
    pub async fn register_vm(
        &self,
        source_ip: &str,
        registration: &VmRegistration<'_>,
    ) -> RunnerResult<()> {
        self.registry_handle()
            .register_vm(source_ip, registration)
            .await
    }

    /// Unregister a VM from the proxy registry.
    pub async fn unregister_vm(&self, source_ip: &str) -> RunnerResult<()> {
        self.registry_handle().unregister_vm(source_ip).await
    }

    /// Prepare for restart: reset `stopping`, kill any lingering child, and
    /// return the parameters needed for [`spawn_mitmdump`].
    ///
    /// The caller should spawn the mitmdump process (potentially in a
    /// background task) and then call [`complete_restart`] with the result.
    pub async fn begin_restart(&mut self) -> MitmRestartParams {
        self.stopping.store(false, Ordering::Release);
        // Kill old child if somehow still running.
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
            self.child = None;
        }
        MitmRestartParams {
            config: self.config.clone(),
            port: self.port,
            crash_tx: self.crash_tx.clone(),
            stopping: Arc::clone(&self.stopping),
        }
    }

    /// Finish a restart by storing the newly spawned child process.
    pub fn complete_restart(&mut self, child: tokio::process::Child) {
        self.child = Some(child);
    }

    /// Gracefully stop mitmdump (SIGTERM → timeout → SIGKILL).
    pub async fn stop(&mut self) -> RunnerResult<()> {
        self.stopping.store(true, Ordering::Release);
        let Some(ref mut child) = self.child else {
            return Ok(());
        };
        info!("stopping mitmdump");
        send_sigterm(child);

        match tokio::time::timeout(STOP_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => {
                info!(code = status.code(), "mitmdump stopped");
            }
            Ok(Err(e)) => {
                warn!(error = %e, "mitmdump wait failed");
            }
            Err(_) => {
                warn!("mitmdump did not exit in time, sending SIGKILL");
                let _ = child.kill().await;
            }
        }
        self.child = None;
        Ok(())
    }
}

impl Drop for MitmProxy {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        // Best-effort kill if still running.
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
    }
}

/// Parameters needed to spawn a mitmdump process, returned by
/// [`MitmProxy::begin_restart`]. All fields are owned/cloned so the spawn
/// can happen in a background task without borrowing `MitmProxy`.
pub(crate) struct MitmRestartParams {
    config: ProxyConfig,
    port: u16,
    crash_tx: mpsc::Sender<()>,
    stopping: Arc<AtomicBool>,
}

impl MitmRestartParams {
    /// Spawn mitmdump using these parameters. Suitable for `tokio::spawn`.
    pub(crate) async fn spawn(self) -> RunnerResult<tokio::process::Child> {
        spawn_mitmdump(&self.config, self.port, &self.crash_tx, &self.stopping).await
    }
}

/// Spawn a mitmdump process, wire up stdout/stderr monitors, and wait for
/// it to become ready. This is a free function so it can run in a
/// `tokio::spawn` without borrowing `MitmProxy`.
pub(crate) async fn spawn_mitmdump(
    config: &ProxyConfig,
    port: u16,
    crash_tx: &mpsc::Sender<()>,
    stopping: &Arc<AtomicBool>,
) -> RunnerResult<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(&config.mitmdump_bin);
    cmd.arg("--mode")
        .arg("transparent")
        .arg("--listen-port")
        .arg(port.to_string())
        .arg("--set")
        .arg(format!("confdir={}", config.ca_dir.display()))
        .arg("--set")
        .arg(format!(
            "vm0_proxy_registry_path={}",
            config.registry_path.display()
        ))
        .arg("--scripts")
        .arg(&config.addon_path)
        .arg("--quiet");
    if let Some(url) = &config.api_url {
        cmd.arg("--set").arg(format!("vm0_api_url={url}"));
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    info!(port, bin = %config.mitmdump_bin.display(), "starting mitmdump");

    let mut child = cmd
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("spawn mitmdump: {e}")))?;

    // Stream stdout to tracing; when the pipe closes (process exited),
    // send a crash notification unless we're in a graceful stop.
    if let Some(stdout) = child.stdout.take() {
        let crash_tx = crash_tx.clone();
        let stopping = Arc::clone(stopping);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    info!(target: "mitmdump", "{line}");
                }
            }
            // Pipe closed — process exited.
            if !stopping.load(Ordering::Acquire) {
                let _ = crash_tx.send(()).await;
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    warn!(target: "mitmdump", "stderr: {line}");
                }
            }
        });
    }

    // Wait for process to be alive (poll liveness).
    wait_for_ready(&mut child, port, READY_TIMEOUT).await?;

    Ok(child)
}

/// Wait for mitmdump to start listening on `port` (TCP connect probe).
async fn wait_for_ready(
    child: &mut tokio::process::Child,
    port: u16,
    timeout: Duration,
) -> RunnerResult<()> {
    let poll_interval = Duration::from_millis(200);
    let start = std::time::Instant::now();
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

    while start.elapsed() < timeout {
        // Check if process died.
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(RunnerError::Internal(format!(
                    "mitmdump exited immediately with {}",
                    status
                        .code()
                        .map_or("unknown".to_string(), |c| c.to_string()),
                )));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "mitmdump process check: {e}"
                )));
            }
        }
        // Probe TCP port.
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(poll_interval).await;
    }

    Err(RunnerError::Internal(format!(
        "mitmdump did not start listening on port {port} within {}s",
        timeout.as_secs()
    )))
}

/// Find an available TCP port by binding to port 0.
fn find_available_port() -> RunnerResult<u16> {
    let listener = std::net::TcpListener::bind("0.0.0.0:0")
        .map_err(|e| RunnerError::Internal(format!("bind port 0: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| RunnerError::Internal(format!("local_addr: {e}")))?
        .port();
    Ok(port)
}

/// Read the proxy registry JSON file.
async fn read_registry(path: &std::path::Path) -> RunnerResult<ProxyRegistry> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("read registry: {e}")))?;
    serde_json::from_str(&content)
        .map_err(|e| RunnerError::Internal(format!("parse registry: {e}")))
}

/// Write the proxy registry JSON file atomically (write tmp + rename).
///
/// This ensures the Python mitm-addon never reads a partially-written file.
async fn write_registry(path: &std::path::Path, value: &ProxyRegistry) -> RunnerResult<()> {
    let content = serde_json::to_string(value)
        .map_err(|e| RunnerError::Internal(format!("serialize registry: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| RunnerError::Internal(format!("write registry tmp: {e}")))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| RunnerError::Internal(format!("rename registry: {e}")))
}

/// Lightweight, cloneable handle for proxy registry operations.
///
/// Uses file locking (`flock`) to ensure concurrent register/unregister calls
/// from multiple executor tasks don't corrupt the registry JSON.
#[derive(Clone)]
pub struct ProxyRegistryHandle {
    registry_path: PathBuf,
    lock_path: PathBuf,
}

impl ProxyRegistryHandle {
    /// Register a VM in the proxy registry.
    pub async fn register_vm(
        &self,
        source_ip: &str,
        registration: &VmRegistration<'_>,
    ) -> RunnerResult<()> {
        let _guard = crate::lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        let now = chrono::Utc::now().timestamp_millis();
        registry.vms.insert(
            source_ip.to_string(),
            VmEntry {
                run_id: registration.run_id.to_string(),
                sandbox_token: registration.sandbox_token.to_string(),
                registered_at: now,
                firewall_rules: registration.firewall_rules.to_vec(),
                mitm_enabled: registration.mitm_enabled,
                seal_secrets_enabled: registration.seal_secrets_enabled,
                network_log_path: registration.network_log_path.to_string_lossy().into_owned(),
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
        let _guard = crate::lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        registry.vms.remove(source_ip);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry(&self.registry_path, &registry).await?;
        info!(source_ip, "unregistered VM from proxy registry");
        Ok(())
    }
}

/// Send SIGTERM to a child process.
fn send_sigterm(child: &tokio::process::Child) {
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_port_returns_nonzero() {
        let port = find_available_port().unwrap();
        assert!(port > 0, "expected non-zero port, got {port}");
    }

    #[test]
    fn addon_script_is_embedded() {
        assert!(
            MITM_ADDON.contains("mitmproxy addon"),
            "addon script should contain expected header"
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
                sandbox_token: String::new(),
                registered_at: 1000,
                firewall_rules: Vec::new(),
                mitm_enabled: true,
                seal_secrets_enabled: false,
                network_log_path: "/tmp/network-test-run.jsonl".to_string(),
            },
        );
        write_registry(&registry_path, &registry).await.unwrap();

        // Verify registration.
        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "test-run");
        assert!(vm.mitm_enabled);

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

    #[test]
    fn firewall_rule_serializes_to_ts_format() {
        let rules = vec![
            FirewallRule {
                domain: Some("*.example.com".to_string()),
                ip: None,
                terminal: None,
                action: Some(FirewallAction::Allow),
            },
            FirewallRule {
                domain: None,
                ip: Some("10.0.0.0/8".to_string()),
                terminal: None,
                action: Some(FirewallAction::Deny),
            },
            FirewallRule {
                domain: None,
                ip: None,
                terminal: Some(FirewallAction::Deny),
                action: None,
            },
        ];
        let json = serde_json::to_value(&rules).unwrap();
        let arr = json.as_array().unwrap();

        // Domain rule
        assert_eq!(arr[0]["domain"], "*.example.com");
        assert_eq!(arr[0]["action"], "ALLOW");
        assert!(arr[0].get("ip").is_none());
        assert!(arr[0].get("final").is_none());

        // IP rule
        assert_eq!(arr[1]["ip"], "10.0.0.0/8");
        assert_eq!(arr[1]["action"], "DENY");

        // Terminal rule (field name is "final" in JSON)
        assert_eq!(arr[2]["final"], "DENY");
        assert!(arr[2].get("action").is_none());
    }

    #[test]
    fn firewall_rule_round_trip() {
        let json = r#"[
            {"domain": "example.com", "action": "ALLOW"},
            {"ip": "192.168.0.0/16", "action": "DENY"},
            {"final": "DENY"}
        ]"#;
        let rules: Vec<FirewallRule> = serde_json::from_str(json).unwrap();
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].domain.as_deref(), Some("example.com"));
        assert!(matches!(rules[0].action, Some(FirewallAction::Allow)));
        assert_eq!(rules[1].ip.as_deref(), Some("192.168.0.0/16"));
        assert!(matches!(rules[1].action, Some(FirewallAction::Deny)));
        assert!(matches!(rules[2].terminal, Some(FirewallAction::Deny)));
        assert!(rules[2].action.is_none());
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
            sandbox_token: "tok-1",
            firewall_rules: &[],
            mitm_enabled: true,
            seal_secrets_enabled: false,
            network_log_path: std::path::Path::new("/tmp/network-run-1.jsonl"),
        };
        handle
            .register_vm("10.200.0.2", &registration)
            .await
            .unwrap();

        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "run-1");
        assert!(vm.mitm_enabled);

        // Re-register same IP overwrites the entry.
        let registration2 = VmRegistration {
            run_id: "run-2",
            sandbox_token: "tok-2",
            firewall_rules: &[],
            mitm_enabled: false,
            seal_secrets_enabled: true,
            network_log_path: std::path::Path::new("/tmp/network-run-2.jsonl"),
        };
        handle
            .register_vm("10.200.0.2", &registration2)
            .await
            .unwrap();
        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.run_id, "run-2");
        assert!(!vm.mitm_enabled);
        assert!(vm.seal_secrets_enabled);

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
                let registration = VmRegistration {
                    run_id: &run_id_owned,
                    sandbox_token: "",
                    firewall_rules: &[],
                    mitm_enabled: false,
                    seal_secrets_enabled: false,
                    network_log_path: &log_path,
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
    async fn registry_with_firewall_rules() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");

        let mut registry = ProxyRegistry {
            vms: HashMap::new(),
            updated_at: 0,
        };
        registry.vms.insert(
            "10.200.0.2".to_string(),
            VmEntry {
                run_id: "run-1".to_string(),
                sandbox_token: "tok".to_string(),
                registered_at: 1000,
                firewall_rules: vec![
                    FirewallRule {
                        domain: Some("*.allowed.com".to_string()),
                        ip: None,
                        terminal: None,
                        action: Some(FirewallAction::Allow),
                    },
                    FirewallRule {
                        domain: None,
                        ip: None,
                        terminal: Some(FirewallAction::Deny),
                        action: None,
                    },
                ],
                mitm_enabled: true,
                seal_secrets_enabled: true,
                network_log_path: "/tmp/network-run-1.jsonl".to_string(),
            },
        );
        write_registry(&registry_path, &registry).await.unwrap();

        let loaded = read_registry(&registry_path).await.unwrap();
        let vm = loaded.vms.get("10.200.0.2").unwrap();
        assert_eq!(vm.firewall_rules.len(), 2);
        assert!(vm.seal_secrets_enabled);

        // Verify JSON field names match TS/Python format.
        let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let vm_json = &value["vms"]["10.200.0.2"];
        assert!(vm_json["firewallRules"].is_array());
        assert_eq!(vm_json["sealSecretsEnabled"], true);
        assert_eq!(vm_json["mitmEnabled"], true);
    }
}
