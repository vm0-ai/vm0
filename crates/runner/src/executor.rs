use std::collections::HashMap;
use std::time::{Duration, Instant};

use sandbox::{ExecRequest, Sandbox, SandboxConfig, SandboxFactory};
use tracing::{error, info, warn};
use uuid::Uuid;

/// Maximum wall-clock time for a single job (2 hours).
const JOB_TIMEOUT: Duration = Duration::from_secs(7200);
/// Exit code when a process is killed by SIGKILL (128 + 9).
const EXIT_SIGKILL: i32 = 137;
/// Raw SIGKILL signal number.
const EXIT_SIGNAL_KILL: i32 = 9;
/// Default timeout for guest commands (5 minutes).
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(300);

use crate::error::RunnerResult;
use crate::http::HttpClient;
use crate::paths::{LogPaths, guest};
use crate::proxy::{self, ProxyRegistryHandle};
use crate::telemetry::JobTelemetry;
use crate::types::ExecutionContext;

/// Configuration for a single execution.
pub struct ExecutorConfig {
    pub api_url: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub is_snapshot: bool,
    pub registry: ProxyRegistryHandle,
    pub http: HttpClient,
    pub log_paths: LogPaths,
}

/// Execute a single job inside a Firecracker VM.
///
/// Returns `(exit_code, error_message)`. The caller is responsible for
/// reporting completion to the API — this keeps `claim` and `complete`
/// in the same function for structural pairing.
pub async fn execute_job(
    factory: &dyn SandboxFactory,
    context: ExecutionContext,
    config: &ExecutorConfig,
) -> (i32, Option<String>) {
    let run_id = context.run_id;
    let mut telemetry =
        JobTelemetry::new(config.http.clone(), run_id, context.sandbox_token.clone());

    // Record api_to_vm_start: elapsed time from the API-side timestamp to now.
    // api_start_time is milliseconds since Unix epoch (Date.now() in TS).
    if let Some(api_start_ms) = context.api_start_time {
        let now_ms = chrono::Utc::now().timestamp_millis() as f64;
        let elapsed_ms = (now_ms - api_start_ms).max(0.0);
        telemetry.record(
            "api_to_vm_start",
            Duration::from_millis(elapsed_ms as u64),
            true,
            None,
        );
    }

    let (exit_code, err) = match execute_inner(factory, &context, config, &mut telemetry).await {
        Ok((code, stderr)) => (code, stderr),
        Err(e) => {
            error!(run_id = %run_id, error = %e, "job execution failed");
            (1, Some(e.to_string()))
        }
    };

    info!(run_id = %run_id, exit_code, "job finished");
    telemetry.flush().await;

    (exit_code, err)
}

async fn execute_inner(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<(i32, Option<String>)> {
    let sandbox_id = context.run_id;
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: config.vcpu,
            memory_mb: config.memory_mb,
        },
        use_proxy: true,
    };

    // Create and start sandbox
    info!(run_id = %context.run_id, sandbox_id = %sandbox_id, "creating sandbox");
    let t = Instant::now();
    let mut sandbox = match factory.create(sandbox_config).await {
        Ok(s) => s,
        Err(e) => {
            telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

    if let Err(e) = sandbox.start().await {
        telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
        factory.destroy(sandbox).await;
        return Err(e.into());
    }
    telemetry.record("vm_create", t.elapsed(), true, None);

    // Register VM in proxy registry when firewall is enabled or services are present
    let source_ip = sandbox.source_ip().to_string();
    let firewall_enabled = context
        .experimental_firewall
        .as_ref()
        .is_some_and(|fw| fw.enabled);
    let has_services = context
        .experimental_services
        .as_ref()
        .is_some_and(|s| s.iter().any(|svc| !svc.apis.is_empty()));
    let proxy_registered = firewall_enabled || has_services;
    let network_log_path = config.log_paths.network_log(context.run_id);

    if proxy_registered {
        let fw = context.experimental_firewall.as_ref();
        let run_id_str = context.run_id.to_string();
        let registration = proxy::VmRegistration {
            run_id: &run_id_str,
            sandbox_token: &context.sandbox_token,
            firewall_rules: fw.and_then(|f| f.rules.as_deref()).unwrap_or(&[]),
            network_log_path: &network_log_path,
            services: context.experimental_services.as_deref(),
            encrypted_secrets: context.encrypted_secrets.as_deref(),
        };
        if let Err(e) = config.registry.register_vm(&source_ip, &registration).await {
            warn!(run_id = %context.run_id, error = %e, "failed to register VM in proxy");
        }
    }

    // Run job inside sandbox, then destroy regardless of outcome
    let result = run_in_sandbox(sandbox.as_ref(), context, config, telemetry).await;

    // Copy guest logs to host log directory (best-effort).
    copy_guest_logs(sandbox.as_ref(), context, &config.log_paths).await;

    // Unregister VM from proxy + upload network logs before cleanup timer.
    // Unregister first ensures the addon writes no more log entries.
    if proxy_registered {
        if let Err(e) = config.registry.unregister_vm(&source_ip).await {
            warn!(run_id = %context.run_id, error = %e, "failed to unregister VM from proxy");
        }
        crate::network_logs::upload_network_logs(
            &config.http,
            context.run_id,
            &context.sandbox_token,
            &network_log_path,
        )
        .await;
    }

    // Cleanup: stop + destroy
    let t = Instant::now();

    // Best-effort stop
    let stop_err = match sandbox.stop().await {
        Ok(()) => None,
        Err(e) => {
            warn!(sandbox_id = %sandbox_id, error = %e, "sandbox stop failed");
            Some(e.to_string())
        }
    };
    factory.destroy(sandbox).await;

    telemetry.record(
        "cleanup",
        t.elapsed(),
        stop_err.is_none(),
        stop_err.as_deref(),
    );

    result
}

async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<(i32, Option<String>)> {
    // System log file — all guest process output goes here for telemetry upload.
    let log_file = format!("/tmp/vm0-system-{}.log", context.run_id);

    // 1. Fix guest clock after snapshot restore (must happen before HTTPS calls)
    if config.is_snapshot {
        fix_guest_clock(sandbox).await?;
    }

    // 2. Download storages
    if let Some(manifest) = &context.storage_manifest {
        let t = Instant::now();
        let result = download_storages(sandbox, context, manifest, &log_file).await;
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "storage_download",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 3. Restore session history
    if let Some(session) = &context.resume_session {
        let t = Instant::now();
        let result = restore_session(sandbox, context, session).await;
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "session_restore",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 4. Build env vars (passed directly via vsock protocol)
    let env_map = build_env_json(context, &config.api_url);
    let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

    // 5. Spawn agent — append stdout+stderr to system log file
    //    (guest-agent reads this back via telemetry for incremental upload)
    let agent_cmd = format!("{} >> {log_file} 2>&1", guest::RUN_AGENT);
    info!(run_id = %context.run_id, "spawning agent");

    // JOB_TIMEOUT is used for both spawn_watch (guest-side kill) and wait_exit
    // (host-side watchdog) so neither side outlives the other.
    let t = Instant::now();
    let handle = sandbox
        .spawn_watch(&ExecRequest {
            cmd: &agent_cmd,
            timeout: JOB_TIMEOUT,
            env: &env_refs,
            sudo: false,
        })
        .await;

    let handle = match handle {
        Ok(h) => h,
        Err(e) => {
            telemetry.record("agent_execute", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

    // 6. Wait for exit
    let result = sandbox.wait_exit(handle, JOB_TIMEOUT).await;
    let success = result.as_ref().is_ok_and(|exit| exit.exit_code == 0);
    let err = result.as_ref().err().map(|e| e.to_string());
    telemetry.record("agent_execute", t.elapsed(), success, err.as_deref());
    let exit = result?;

    info!(
        run_id = %context.run_id,
        exit_code = exit.exit_code,
        "agent exited"
    );

    // Check for OOM kill when process was terminated by SIGKILL
    if exit.exit_code == EXIT_SIGKILL || exit.exit_code == EXIT_SIGNAL_KILL {
        let dmesg_req = ExecRequest {
            cmd: "dmesg | tail -20 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
        };
        match sandbox.exec(&dmesg_req).await {
            Ok(dmesg) if dmesg_indicates_oom(&String::from_utf8_lossy(&dmesg.stdout)) => {
                warn!(run_id = %context.run_id, "OOM kill detected via dmesg");
                // Return exit code 1 with descriptive message instead of raw 137,
                // so callers see a clear error rather than an opaque signal code.
                return Ok((1, Some("Agent process killed by OOM killer".into())));
            }
            Err(e) => {
                warn!(run_id = %context.run_id, error = %e, "failed to exec dmesg for OOM check");
            }
            _ => {}
        }
    }

    let error_msg = if exit.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&exit.stderr).to_string();
        if !stderr.is_empty() {
            Some(stderr)
        } else {
            // Stderr is empty (redirected to log file). Check for a structured
            // error file written by the guest-agent (e.g. checkpoint failures).
            read_guest_error_file(sandbox, context.run_id).await
        }
    } else {
        None
    };

    Ok((exit.exit_code, error_msg))
}

/// Read a structured error file from the guest filesystem.
///
/// The guest-agent writes checkpoint errors to `/tmp/vm0-checkpoint-error-{run_id}`
/// so the runner can surface them even though stdout/stderr are redirected to the
/// system log file.
///
/// NOTE: This path must match the convention in `crates/guest-agent/src/paths.rs`
/// (`checkpoint_error_file()`). The runner and guest-agent are separate binaries
/// running in different processes, so the path is duplicated by design.
async fn read_guest_error_file(sandbox: &dyn Sandbox, run_id: Uuid) -> Option<String> {
    // Mirror of guest-agent paths::checkpoint_error_file()
    let error_path = format!("/tmp/vm0-checkpoint-error-{run_id}");
    let cat_cmd = format!("cat {error_path} 2>/dev/null");
    match sandbox
        .exec(&ExecRequest {
            cmd: &cat_cmd,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
        })
        .await
    {
        Ok(result) if result.exit_code == 0 && !result.stdout.is_empty() => {
            let msg = String::from_utf8_lossy(&result.stdout).trim().to_string();
            Some(msg).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Returns true if dmesg output indicates an OOM kill.
fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Copy guest log files to the host log directory.
///
/// Best-effort: failures are logged but do not affect job outcome.
async fn copy_guest_logs(sandbox: &dyn Sandbox, context: &ExecutionContext, log_paths: &LogPaths) {
    let run_id = context.run_id;
    let files = [
        (
            format!("/tmp/vm0-system-{run_id}.log"),
            log_paths.system_log(run_id),
        ),
        (
            format!("/tmp/vm0-metrics-{run_id}.jsonl"),
            log_paths.metrics_log(run_id),
        ),
    ];

    for (guest_path, host_path) in &files {
        let cat_cmd = format!("cat '{guest_path}'");
        let result = sandbox
            .exec(&ExecRequest {
                cmd: &cat_cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &[],
                sudo: false,
            })
            .await;

        let output = match result {
            Ok(r) if r.exit_code == 0 => r.stdout,
            Ok(_) => continue,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, path = %guest_path, "failed to read guest log");
                continue;
            }
        };

        if let Err(e) = tokio::fs::write(host_path, &output).await {
            warn!(run_id = %run_id, error = %e, path = %host_path.display(), "failed to write guest log to host");
        }
    }
}

/// Sync guest clock to host time after snapshot restore.
///
/// Must run before any HTTPS calls — stale clock breaks TLS cert validation.
pub(crate) async fn fix_guest_clock(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    let timestamp = format!(
        "{:.3}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    );
    let date_cmd = format!("date -s \"@{timestamp}\"");
    sandbox
        .exec(&ExecRequest {
            cmd: &date_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
        })
        .await?;
    Ok(())
}

/// Download storage volumes into the guest.
async fn download_storages(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: &crate::types::StorageManifest,
    log_file: &str,
) -> RunnerResult<()> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|e| crate::error::RunnerError::Internal(format!("manifest json: {e}")))?;
    sandbox
        .write_file(guest::STORAGE_MANIFEST, &manifest_json)
        .await?;

    let download_cmd = format!(
        "{} {} >> {log_file} 2>&1",
        guest::DOWNLOAD_BIN,
        guest::STORAGE_MANIFEST
    );
    info!(run_id = %context.run_id, "downloading storages");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &download_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: false,
        })
        .await?;

    if result.exit_code != 0 {
        return Err(crate::error::RunnerError::Internal(format!(
            "storage download failed (exit code {})",
            result.exit_code
        )));
    }
    Ok(())
}

/// Write Claude Code session history into the guest filesystem.
///
/// Only Claude Code uses `.jsonl` session files; other agent types are skipped.
async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &crate::types::ResumeSession,
) -> RunnerResult<()> {
    if !(context.cli_agent_type.is_empty() || context.cli_agent_type == "claude-code") {
        return Ok(());
    }

    let project_name = context
        .working_dir
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("/home/user/.claude/projects/-{project_name}");

    // Validate session_id to prevent path traversal (only allow alnum, dash, underscore)
    if !is_valid_session_id(&session.session_id) {
        return Err(crate::error::RunnerError::Internal(format!(
            "invalid session_id: {}",
            session.session_id
        )));
    }
    let session_path = format!("{session_dir}/{}.jsonl", session.session_id);

    let mkdir_cmd = format!("mkdir -p '{}'", session_dir.replace('\'', "'\\''"));
    sandbox
        .exec(&ExecRequest {
            cmd: &mkdir_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: false,
        })
        .await?;
    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;
    info!(run_id = %context.run_id, path = %session_path, "restored session history");
    Ok(())
}

/// Proxy CA certificate path inside the guest rootfs (pre-baked at build time).
const VM_PROXY_CA_PATH: &str = "/usr/local/share/ca-certificates/vm0-proxy-ca.crt";

/// Returns true if the session ID contains only safe characters (alphanumeric, dash, underscore).
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Build the environment variables JSON.
///
/// Priority (lowest → highest):
///   1. `environment` (user-provided env, includes expanded vars)
///   2. `user_timezone` TZ (unless `environment` already sets TZ)
///   3. System variables (VM0_*, secrets, etc.) — always win
fn build_env_json(context: &ExecutionContext, api_url: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();

    // --- User-provided environment ---
    if let Some(user_env) = &context.environment {
        for (k, v) in user_env {
            env.insert(k.clone(), v.clone());
        }
    }

    // --- User timezone ---
    // Respects explicit TZ in user environment.
    if let Some(tz) = &context.user_timezone {
        let has_tz = context
            .environment
            .as_ref()
            .is_some_and(|e| e.contains_key("TZ"));
        if !has_tz {
            env.insert("TZ".into(), tz.clone());
        }
    }

    // --- System variables below (override user values) ---

    env.insert("VM0_API_URL".into(), api_url.into());
    env.insert("VM0_RUN_ID".into(), context.run_id.to_string());
    env.insert("VM0_API_TOKEN".into(), context.sandbox_token.clone());
    env.insert("VM0_PROMPT".into(), context.prompt.clone());
    env.insert("VM0_WORKING_DIR".into(), context.working_dir.clone());
    env.insert(
        "VM0_API_START_TIME".into(),
        context
            .api_start_time
            .map(|t| (t as u64).to_string())
            .unwrap_or_default(),
    );
    // The API omits cli_agent_type for claude-code agents (the default).
    env.insert(
        "CLI_AGENT_TYPE".into(),
        if context.cli_agent_type.is_empty() {
            "claude-code".into()
        } else {
            context.cli_agent_type.clone()
        },
    );

    // Vercel bypass
    if let Ok(bypass) = std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET") {
        env.insert("VERCEL_PROTECTION_BYPASS".into(), bypass);
    }

    // Pass USE_MOCK_CLAUDE from host environment for testing
    // (skip if debugNoMockClaude is set in execution context)
    if let Ok(val) = std::env::var("USE_MOCK_CLAUDE")
        && !context.debug_no_mock_claude.unwrap_or(false)
    {
        env.insert("USE_MOCK_CLAUDE".into(), val);
    }

    // Tell Node.js to trust the proxy CA when MITM proxy is active.
    // MITM is always enabled when firewall or services are configured.
    // The certificate is pre-baked into the rootfs at build time.
    let proxy_active = context
        .experimental_firewall
        .as_ref()
        .is_some_and(|fw| fw.enabled)
        || context
            .experimental_services
            .as_ref()
            .is_some_and(|s| s.iter().any(|svc| !svc.apis.is_empty()));
    if proxy_active {
        env.insert("NODE_EXTRA_CA_CERTS".into(), VM_PROXY_CA_PATH.into());
    }

    // Artifact config
    if let Some(manifest) = &context.storage_manifest
        && let Some(artifact) = &manifest.artifact
    {
        env.insert("VM0_ARTIFACT_DRIVER".into(), "vas".into());
        env.insert(
            "VM0_ARTIFACT_MOUNT_PATH".into(),
            artifact.mount_path.clone(),
        );
        env.insert(
            "VM0_ARTIFACT_VOLUME_NAME".into(),
            artifact.vas_storage_name.clone(),
        );
        env.insert(
            "VM0_ARTIFACT_VERSION_ID".into(),
            artifact.vas_version_id.clone(),
        );
    }

    // Memory config
    if let Some(manifest) = &context.storage_manifest
        && let Some(memory) = &manifest.memory
    {
        env.insert("VM0_MEMORY_DRIVER".into(), "vas".into());
        env.insert("VM0_MEMORY_MOUNT_PATH".into(), memory.mount_path.clone());
        env.insert("VM0_MEMORY_NAME".into(), memory.vas_storage_name.clone());
        env.insert(
            "VM0_MEMORY_VERSION_ID".into(),
            memory.vas_version_id.clone(),
        );
    }

    // Resume session ID
    if let Some(session) = &context.resume_session {
        env.insert("VM0_RESUME_SESSION_ID".into(), session.session_id.clone());
    }

    // Note: Connector placeholder env vars (e.g., GITHUB_TOKEN=gho_vm0placeholder...)
    // are injected by the web API into `context.environment` directly.

    // Secret values (base64-encoded, comma-separated)
    if let Some(secret_values) = &context.secret_values
        && !secret_values.is_empty()
    {
        use base64::Engine as _;
        let encoded: Vec<String> = secret_values
            .iter()
            .map(|s| base64::engine::general_purpose::STANDARD.encode(s))
            .collect();
        env.insert("VM0_SECRET_VALUES".into(), encoded.join(","));
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ArtifactEntry, ResumeSession, StorageEntry, StorageManifest};
    use uuid::Uuid;

    fn minimal_context() -> ExecutionContext {
        ExecutionContext {
            run_id: Uuid::nil(),
            prompt: "test prompt".into(),
            agent_compose_version_id: None,
            vars: None,
            checkpoint_id: None,
            sandbox_token: "tok".into(),
            working_dir: "/workspace".into(),
            storage_manifest: None,
            environment: None,
            resume_session: None,
            secret_values: None,
            encrypted_secrets: None,
            cli_agent_type: String::new(),
            experimental_firewall: None,
            debug_no_mock_claude: None,
            api_start_time: None,
            user_timezone: None,
            agent_name: None,
            agent_org_slug: None,
            memory_name: None,
            experimental_services: None,
        }
    }

    #[test]
    fn build_env_json_required_keys() {
        let ctx = minimal_context();
        let env = build_env_json(&ctx, "https://api.example.com");

        assert_eq!(env.get("VM0_API_URL").unwrap(), "https://api.example.com");
        assert_eq!(env.get("VM0_RUN_ID").unwrap(), &Uuid::nil().to_string());
        assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("VM0_WORKING_DIR").unwrap(), "/workspace");
    }

    #[test]
    fn build_env_json_empty_cli_agent_type_defaults_to_claude_code() {
        let ctx = minimal_context();
        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "claude-code");
    }

    #[test]
    fn build_env_json_custom_cli_agent_type() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "custom-agent".into();
        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
    }

    #[test]
    fn build_env_json_with_artifact() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: None,
            }],
            artifact: Some(ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: None,
                vas_storage_name: "my-vol".into(),
                vas_version_id: "v1".into(),
            }),
            memory: None,
        });

        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_ARTIFACT_DRIVER").unwrap(), "vas");
        assert_eq!(env.get("VM0_ARTIFACT_MOUNT_PATH").unwrap(), "/artifacts");
        assert_eq!(env.get("VM0_ARTIFACT_VOLUME_NAME").unwrap(), "my-vol");
        assert_eq!(env.get("VM0_ARTIFACT_VERSION_ID").unwrap(), "v1");
    }

    #[test]
    fn build_env_json_with_secrets() {
        let mut ctx = minimal_context();
        ctx.secret_values = Some(vec!["secret1".into(), "secret2".into()]);

        let env = build_env_json(&ctx, "http://localhost");
        let val = env.get("VM0_SECRET_VALUES").unwrap();

        use base64::Engine as _;
        let parts: Vec<&str> = val.split(',').collect();
        assert_eq!(parts.len(), 2);
        let decoded0 = base64::engine::general_purpose::STANDARD
            .decode(parts[0])
            .unwrap();
        assert_eq!(decoded0, b"secret1");
    }

    #[test]
    fn build_env_json_with_resume_session() {
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-123".into(),
            session_history: "{}".into(),
        });

        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_RESUME_SESSION_ID").unwrap(), "sess-123");
    }

    #[test]
    fn build_env_json_user_vars_cannot_override_system() {
        let mut ctx = minimal_context();
        // vars are expanded into environment at compose time, so test via environment
        ctx.environment = Some(HashMap::from([
            ("VM0_PROMPT".into(), "overridden".into()),
            ("CUSTOM".into(), "value".into()),
        ]));

        let env = build_env_json(&ctx, "http://localhost");
        // System variables take precedence over user environment
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("CUSTOM").unwrap(), "value");
    }

    #[test]
    fn build_env_json_with_environment() {
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([
            ("MY_VAR".into(), "123".into()),
            ("OTHER".into(), "abc".into()),
        ]));

        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("MY_VAR").unwrap(), "123");
        assert_eq!(env.get("OTHER").unwrap(), "abc");
    }

    #[test]
    fn build_env_json_with_api_start_time() {
        let mut ctx = minimal_context();
        ctx.api_start_time = Some(1_700_000_000.5);

        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_API_START_TIME").unwrap(), "1700000000");
    }

    #[test]
    fn build_env_json_empty_secrets_omitted() {
        let mut ctx = minimal_context();
        ctx.secret_values = Some(vec![]);

        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_SECRET_VALUES"));
    }

    #[test]
    fn build_env_json_with_user_timezone() {
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("Asia/Shanghai".into());

        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("TZ").unwrap(), "Asia/Shanghai");
    }

    #[test]
    fn build_env_json_user_timezone_not_override_environment() {
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("Asia/Shanghai".into());
        ctx.environment = Some(HashMap::from([("TZ".into(), "America/New_York".into())]));

        let env = build_env_json(&ctx, "http://localhost");
        // User environment TZ takes precedence
        assert_eq!(env.get("TZ").unwrap(), "America/New_York");
    }

    #[test]
    fn build_env_json_environment_cannot_override_system() {
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([
            ("VM0_PROMPT".into(), "hacked".into()),
            ("VM0_API_TOKEN".into(), "stolen".into()),
            ("CUSTOM_ENV".into(), "kept".into()),
        ]));

        let env = build_env_json(&ctx, "http://localhost");
        // System variables take precedence over user environment
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
        assert_eq!(env.get("CUSTOM_ENV").unwrap(), "kept");
    }

    #[test]
    fn build_env_json_vars_not_injected_directly() {
        let mut ctx = minimal_context();
        // vars should NOT be injected as env vars — they are expanded into
        // environment at compose time via ${{ vars.XXX }} templates.
        ctx.vars = Some(HashMap::from([("ONLY_VARS".into(), "vars-value".into())]));
        ctx.environment = Some(HashMap::from([("ONLY_ENV".into(), "env-value".into())]));

        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("ONLY_VARS"));
        assert_eq!(env.get("ONLY_ENV").unwrap(), "env-value");
    }

    /// Verify ExecutionContext deserializes from JSON matching the TS schema,
    /// including the snake_case `experimentalFirewall` inner fields.
    #[test]
    fn deserialize_execution_context_with_firewall() {
        let json = r#"{
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "hello",
            "agentComposeVersionId": null,
            "vars": null,
            "checkpointId": null,
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "storageManifest": null,
            "environment": null,
            "resumeSession": null,
            "secretValues": null,
            "cliAgentType": "claude-code",
            "experimentalFirewall": {
                "enabled": true,
                "rules": [
                    {"domain": "*.example.com", "action": "ALLOW"},
                    {"final": "DENY"}
                ]
            },
            "debugNoMockClaude": true,
            "apiStartTime": 1700000000.5,
            "userTimezone": "Asia/Shanghai"
        }"#;

        let ctx: ExecutionContext = serde_json::from_str(json).unwrap();
        assert_eq!(
            ctx.run_id.to_string(),
            "00000000-0000-0000-0000-000000000001"
        );
        assert_eq!(ctx.prompt, "hello");
        assert_eq!(ctx.cli_agent_type, "claude-code");

        let fw = ctx.experimental_firewall.as_ref().unwrap();
        assert!(fw.enabled);
        let rules = fw.rules.as_ref().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(ctx.api_start_time, Some(1700000000.5));
        assert_eq!(ctx.user_timezone.as_deref(), Some("Asia/Shanghai"));
    }

    /// SAFETY: set_var/remove_var are unsafe in edition 2024 due to potential
    /// data races. These tests are acceptable because cargo test runs each
    /// test in its own thread by default, and no other tests read this var.
    #[test]
    fn build_env_json_with_mock_claude() {
        let saved = std::env::var("USE_MOCK_CLAUDE").ok();
        // SAFETY: no concurrent tests read USE_MOCK_CLAUDE.
        unsafe { std::env::set_var("USE_MOCK_CLAUDE", "true") };

        let ctx = minimal_context();
        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");

        // Restore
        match saved {
            Some(v) => unsafe { std::env::set_var("USE_MOCK_CLAUDE", v) },
            None => unsafe { std::env::remove_var("USE_MOCK_CLAUDE") },
        }
    }

    #[test]
    fn build_env_json_mock_claude_suppressed_by_debug_flag() {
        let saved = std::env::var("USE_MOCK_CLAUDE").ok();
        // SAFETY: no concurrent tests read USE_MOCK_CLAUDE.
        unsafe { std::env::set_var("USE_MOCK_CLAUDE", "true") };

        let mut ctx = minimal_context();
        ctx.debug_no_mock_claude = Some(true);
        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("USE_MOCK_CLAUDE"));

        // Restore
        match saved {
            Some(v) => unsafe { std::env::set_var("USE_MOCK_CLAUDE", v) },
            None => unsafe { std::env::remove_var("USE_MOCK_CLAUDE") },
        }
    }

    #[test]
    fn build_env_json_with_firewall_sets_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_firewall = Some(crate::types::ExperimentalFirewall {
            enabled: true,
            rules: None,
        });
        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("NODE_EXTRA_CA_CERTS").unwrap(), VM_PROXY_CA_PATH);
    }

    #[test]
    fn build_env_json_firewall_disabled_no_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_firewall = Some(crate::types::ExperimentalFirewall {
            enabled: false,
            rules: None,
        });
        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("NODE_EXTRA_CA_CERTS"));
    }

    #[test]
    fn build_env_json_no_firewall_no_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_firewall = None;
        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("NODE_EXTRA_CA_CERTS"));
    }

    #[test]
    fn build_env_json_services_enable_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_services = Some(vec![crate::types::ServiceEntry {
            name: "gmail".into(),
            ref_key: "gmail".into(),
            apis: vec![crate::types::ServiceApiEntry {
                id: String::new(),
                base: "https://gmail.googleapis.com/gmail/v1/users/me".into(),
                auth: crate::types::ServiceApiAuth {
                    headers: std::collections::HashMap::from([(
                        "Authorization".into(),
                        "Bearer ${secrets.GMAIL_TOKEN}".into(),
                    )]),
                },
                permissions: None,
            }],
        }]);
        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("NODE_EXTRA_CA_CERTS").unwrap(), VM_PROXY_CA_PATH);
    }

    #[test]
    fn build_env_json_empty_services_no_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_services = Some(vec![]);
        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("NODE_EXTRA_CA_CERTS"));
    }

    #[test]
    fn execution_context_deserializes_with_services() {
        let json = serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "test",
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "cliAgentType": "claude-code",
            "experimentalServices": [{
                "name": "github",
                "ref": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {
                        "headers": {
                            "Authorization": "Bearer ${secrets.GITHUB_TOKEN}"
                        }
                    },
                    "permissions": [
                        {
                            "name": "issues-read",
                            "rules": [
                                "GET /repos/{owner}/{repo}/issues",
                                "GET /repos/{owner}/{repo}/issues/{issue_number}"
                            ]
                        }
                    ]
                }]
            }]
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let svcs = ctx.experimental_services.unwrap();
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].name, "github");
        assert_eq!(svcs[0].ref_key, "github");
        assert_eq!(svcs[0].apis.len(), 1);
        assert_eq!(svcs[0].apis[0].base, "https://api.github.com");
        let perms = svcs[0].apis[0].permissions.as_ref().unwrap();
        assert_eq!(perms.len(), 1);
        assert_eq!(perms[0].name, "issues-read");
        assert_eq!(perms[0].rules.len(), 2);
        assert_eq!(perms[0].rules[0], "GET /repos/{owner}/{repo}/issues");
    }

    #[test]
    fn execution_context_deserializes_without_services() {
        let json = serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "test",
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "cliAgentType": "claude-code"
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert!(ctx.experimental_services.is_none());
    }

    #[test]
    fn dmesg_oom_positive() {
        assert!(dmesg_indicates_oom(
            "[  12.345] Out of memory: Killed process 1234 (claude)"
        ));
        assert!(dmesg_indicates_oom("oom-kill:constraint=CONSTRAINT_MEMCG"));
        assert!(dmesg_indicates_oom("oom_reaper: reaped process 42"));
    }

    #[test]
    fn dmesg_oom_negative() {
        assert!(!dmesg_indicates_oom(""));
        // "Killed process" alone (without OOM context) should NOT match
        assert!(!dmesg_indicates_oom("Killed process 42 (node)"));
        assert!(!dmesg_indicates_oom("normal kernel log output"));
        assert!(!dmesg_indicates_oom("[  1.000] eth0: link up"));
        assert!(!dmesg_indicates_oom("task killed by signal 15"));
        // substring "oom" in unrelated words should not match
        assert!(!dmesg_indicates_oom("the room is full"));
    }

    #[test]
    fn dmesg_oom_case_insensitive() {
        assert!(dmesg_indicates_oom("Out Of Memory: killed process 99"));
        assert!(!dmesg_indicates_oom("Killed process 99 (agent)"));
        assert!(dmesg_indicates_oom("OOM-kill: constraint=MEMCG"));
    }

    #[test]
    fn session_id_validation_rejects_path_traversal() {
        let invalid_ids = [
            "../../etc/passwd",
            "foo/bar",
            "a b",
            "id;rm -rf /",
            "a\nb",
            "",
        ];
        for id in invalid_ids {
            assert!(!is_valid_session_id(id), "expected rejection for: {id:?}");
        }
    }

    #[test]
    fn session_id_validation_accepts_valid_ids() {
        let valid_ids = [
            "abc-123",
            "sess_456",
            "a1b2c3",
            "01961d3a-c0ab-7891-a6d3-9b52cd28716c",
        ];
        for id in valid_ids {
            assert!(is_valid_session_id(id), "expected acceptance for: {id:?}");
        }
    }
}
