use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncBufReadExt;
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
    mitm_enabled: bool,
}

/// Embedded mitmproxy addon script (compiled into the binary).
const MITM_ADDON: &str = include_str!("../scripts/mitm-addon.py");

/// Timeout for waiting for mitmdump to become ready after spawn.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for graceful shutdown before SIGKILL.
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

/// Configuration for starting the proxy.
pub struct ProxyConfig {
    /// Path to the mitmdump binary.
    pub mitmdump_bin: PathBuf,
    /// Directory containing mitmproxy CA files (mitmproxy-ca.pem).
    pub ca_dir: PathBuf,
    /// Path where the addon script will be written.
    pub addon_path: PathBuf,
    /// Path where the proxy registry JSON will be written.
    pub registry_path: PathBuf,
    /// VM0 API URL passed to the addon (optional).
    pub api_url: Option<String>,
}

/// Manages the mitmdump process lifecycle and proxy registry.
pub struct MitmProxy {
    port: u16,
    config: ProxyConfig,
    child: Option<tokio::process::Child>,
}

impl MitmProxy {
    /// Prepare the proxy: allocate a port, write addon script and empty registry.
    pub async fn new(config: ProxyConfig) -> RunnerResult<Self> {
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

        Ok(Self {
            port,
            config,
            child: None,
        })
    }

    /// Spawn the mitmdump process.
    pub async fn start(&mut self) -> RunnerResult<()> {
        let mut cmd = tokio::process::Command::new(&self.config.mitmdump_bin);
        cmd.arg("--mode")
            .arg("transparent")
            .arg("--listen-port")
            .arg(self.port.to_string())
            .arg("--set")
            .arg(format!("confdir={}", self.config.ca_dir.display()))
            .arg("--set")
            .arg(format!(
                "vm0_proxy_registry_path={}",
                self.config.registry_path.display()
            ))
            .arg("--scripts")
            .arg(&self.config.addon_path)
            .arg("--quiet");
        if let Some(url) = &self.config.api_url {
            cmd.arg("--set").arg(format!("vm0_api_url={url}"));
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        info!(port = self.port, bin = %self.config.mitmdump_bin.display(), "starting mitmdump");

        let mut child = cmd
            .spawn()
            .map_err(|e| RunnerError::Internal(format!("spawn mitmdump: {e}")))?;

        // Stream stdout/stderr to tracing.
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.is_empty() {
                        info!(target: "mitmdump", "{line}");
                    }
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
        wait_for_ready(&mut child, READY_TIMEOUT).await?;

        self.child = Some(child);
        info!(port = self.port, "mitmdump started");
        Ok(())
    }

    /// The port mitmdump is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Register a VM in the proxy registry so the addon can identify its traffic.
    ///
    /// Note: the read-modify-write is not concurrent-safe. Current usage is
    /// single-sandbox (benchmark). If reused for multi-sandbox, add file locking.
    pub async fn register_vm(&self, source_ip: &str, run_id: &str) -> RunnerResult<()> {
        let mut registry = read_registry(&self.config.registry_path).await?;
        let now = chrono::Utc::now().timestamp_millis();
        registry.vms.insert(
            source_ip.to_string(),
            VmEntry {
                run_id: run_id.to_string(),
                sandbox_token: String::new(),
                registered_at: now,
                mitm_enabled: true,
            },
        );
        registry.updated_at = now;
        write_registry(&self.config.registry_path, &registry).await?;
        info!(source_ip, run_id, "registered VM in proxy registry");
        Ok(())
    }

    /// Unregister a VM from the proxy registry.
    ///
    /// Note: same concurrency caveat as [`Self::register_vm`].
    pub async fn unregister_vm(&self, source_ip: &str) -> RunnerResult<()> {
        let mut registry = read_registry(&self.config.registry_path).await?;
        registry.vms.remove(source_ip);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry(&self.config.registry_path, &registry).await?;
        info!(source_ip, "unregistered VM from proxy registry");
        Ok(())
    }

    /// Gracefully stop mitmdump (SIGTERM → timeout → SIGKILL).
    pub async fn stop(&mut self) -> RunnerResult<()> {
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
        // Best-effort kill if still running.
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
    }
}

/// Wait for the mitmdump process to be alive and not immediately exit.
async fn wait_for_ready(child: &mut tokio::process::Child, timeout: Duration) -> RunnerResult<()> {
    let poll_interval = Duration::from_millis(200);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(RunnerError::Internal(format!(
                    "mitmdump exited immediately with {}",
                    status
                        .code()
                        .map_or("unknown".to_string(), |c| c.to_string()),
                )));
            }
            Ok(None) => {
                // Still running — after first successful check, consider ready.
                if start.elapsed() >= poll_interval {
                    return Ok(());
                }
            }
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "mitmdump process check: {e}"
                )));
            }
        }
        tokio::time::sleep(poll_interval).await;
    }

    Ok(())
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

/// Write the proxy registry JSON file.
async fn write_registry(path: &std::path::Path, value: &ProxyRegistry) -> RunnerResult<()> {
    let content = serde_json::to_string(value)
        .map_err(|e| RunnerError::Internal(format!("serialize registry: {e}")))?;
    tokio::fs::write(path, content)
        .await
        .map_err(|e| RunnerError::Internal(format!("write registry: {e}")))
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
                mitm_enabled: true,
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
}
