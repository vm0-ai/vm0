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
    let sandbox_id = Uuid::new_v4();
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

    // Register VM in proxy registry (only when firewall is enabled)
    let source_ip = sandbox.source_ip().to_string();
    let firewall_enabled = context
        .experimental_firewall
        .as_ref()
        .is_some_and(|fw| fw.enabled);
    let network_log_path = config.log_paths.network_log(context.run_id);

    if let Some(fw) = &context.experimental_firewall
        && fw.enabled
    {
        let run_id_str = context.run_id.to_string();
        let registration = proxy::VmRegistration {
            run_id: &run_id_str,
            sandbox_token: &context.sandbox_token,
            firewall_rules: fw.rules.as_deref().unwrap_or(&[]),
            mitm_enabled: fw.experimental_mitm.unwrap_or(false),
            seal_secrets_enabled: fw.experimental_seal_secrets.unwrap_or(false),
            network_log_path: &network_log_path,
        };
        if let Err(e) = config.registry.register_vm(&source_ip, &registration).await {
            warn!(run_id = %context.run_id, error = %e, "failed to register VM in proxy");
        }
    }

    // Run job inside sandbox, then destroy regardless of outcome
    let result = run_in_sandbox(sandbox.as_ref(), context, config, telemetry).await;

    // Unregister VM from proxy + upload network logs before cleanup timer.
    // Unregister first ensures the addon writes no more log entries.
    if firewall_enabled {
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
    // 1. Fix guest clock after snapshot restore (must happen before HTTPS calls)
    if config.is_snapshot {
        fix_guest_clock(sandbox).await?;
    }

    // 2. Download storages
    if let Some(manifest) = &context.storage_manifest {
        let t = Instant::now();
        let result = download_storages(sandbox, context, manifest).await;
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

    // 5. Spawn agent — redirect stdout+stderr to system log file
    //    (guest-agent reads this back via telemetry for incremental upload)
    let log_file = format!("/tmp/vm0-system-{}.log", context.run_id);
    let agent_cmd = format!("{} > {log_file} 2>&1", guest::RUN_AGENT);
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
        Some(stderr).filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok((exit.exit_code, error_msg))
}

/// Returns true if dmesg output indicates an OOM kill.
fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory")
        || lower.contains("oom-kill")
        || lower.contains("oom_reaper")
        || lower.contains("killed process")
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
) -> RunnerResult<()> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|e| crate::error::RunnerError::Internal(format!("manifest json: {e}")))?;
    sandbox
        .write_file(guest::STORAGE_MANIFEST, &manifest_json)
        .await?;

    let download_cmd = format!("{} {}", guest::DOWNLOAD_BIN, guest::STORAGE_MANIFEST);
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
            "storage download failed: {}",
            String::from_utf8_lossy(&result.stderr)
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
    let session_path = format!("{session_dir}/{}.jsonl", session.session_id);

    let mkdir_cmd = format!("mkdir -p \"{session_dir}\"");
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

/// Build the environment variables JSON, matching the TS `buildEnvironmentVariables`.
fn build_env_json(context: &ExecutionContext, api_url: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();

    env.insert("VM0_API_URL".into(), api_url.into());
    env.insert("VM0_RUN_ID".into(), context.run_id.to_string());
    env.insert("VM0_API_TOKEN".into(), context.sandbox_token.clone());
    env.insert("VM0_PROMPT".into(), context.prompt.clone());
    env.insert("VM0_WORKING_DIR".into(), context.working_dir.clone());
    env.insert(
        "VM0_API_START_TIME".into(),
        context
            .api_start_time
            .map(|t| t.to_string())
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

    // Tell Node.js to trust the proxy CA when MITM mode is enabled.
    // The certificate is pre-baked into the rootfs at build time.
    if let Some(fw) = &context.experimental_firewall
        && fw.experimental_mitm.unwrap_or(false)
    {
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

    // Resume session ID
    if let Some(session) = &context.resume_session {
        env.insert("VM0_RESUME_SESSION_ID".into(), session.session_id.clone());
    }

    // User timezone as TZ env var (if not already set in user environment)
    if let Some(tz) = &context.user_timezone {
        let has_tz = context
            .environment
            .as_ref()
            .is_some_and(|e| e.contains_key("TZ"));
        if !has_tz {
            env.insert("TZ".into(), tz.clone());
        }
    }

    // User environment variables
    if let Some(user_env) = &context.environment {
        for (k, v) in user_env {
            env.insert(k.clone(), v.clone());
        }
    }

    // Secret values (base64-encoded, comma-separated)
    if let Some(secrets) = &context.secret_values
        && !secrets.is_empty()
    {
        use base64::Engine as _;
        let encoded: Vec<String> = secrets
            .iter()
            .map(|s| base64::engine::general_purpose::STANDARD.encode(s))
            .collect();
        env.insert("VM0_SECRET_VALUES".into(), encoded.join(","));
    }

    // User vars (may override anything above, matching TS behavior)
    if let Some(vars) = &context.vars {
        for (k, v) in vars {
            env.insert(k.clone(), v.clone());
        }
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ArtifactEntry, ResumeSession, StorageEntry, StorageManifest};

    fn minimal_context() -> ExecutionContext {
        ExecutionContext {
            run_id: Uuid::nil(),
            prompt: "test prompt".into(),
            agent_compose_version_id: None,
            vars: None,
            secret_names: None,
            checkpoint_id: None,
            sandbox_token: "tok".into(),
            working_dir: "/workspace".into(),
            storage_manifest: None,
            environment: None,
            resume_session: None,
            secret_values: None,
            cli_agent_type: String::new(),
            experimental_firewall: None,
            debug_no_mock_claude: None,
            api_start_time: None,
            user_timezone: None,
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
    fn build_env_json_user_vars_override() {
        let mut ctx = minimal_context();
        ctx.vars = Some(HashMap::from([
            ("VM0_PROMPT".into(), "overridden".into()),
            ("CUSTOM".into(), "value".into()),
        ]));

        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "overridden");
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
        assert_eq!(env.get("VM0_API_START_TIME").unwrap(), "1700000000.5");
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

    /// Verify ExecutionContext deserializes from JSON matching the TS schema,
    /// including the snake_case `experimentalFirewall` inner fields.
    #[test]
    fn deserialize_execution_context_with_firewall() {
        let json = r#"{
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "hello",
            "agentComposeVersionId": null,
            "vars": null,
            "secretNames": null,
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
                ],
                "experimental_mitm": true,
                "experimental_seal_secrets": false
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
        assert_eq!(fw.experimental_mitm, Some(true));
        assert_eq!(fw.experimental_seal_secrets, Some(false));

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
    fn build_env_json_with_mitm_sets_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_firewall = Some(crate::types::ExperimentalFirewall {
            enabled: true,
            rules: None,
            experimental_mitm: Some(true),
            experimental_seal_secrets: None,
        });
        let env = build_env_json(&ctx, "http://localhost");
        assert_eq!(env.get("NODE_EXTRA_CA_CERTS").unwrap(), VM_PROXY_CA_PATH);
    }

    #[test]
    fn build_env_json_without_mitm_no_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_firewall = Some(crate::types::ExperimentalFirewall {
            enabled: true,
            rules: None,
            experimental_mitm: Some(false),
            experimental_seal_secrets: None,
        });
        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("NODE_EXTRA_CA_CERTS"));
    }

    #[test]
    fn build_env_json_mitm_none_no_ca_certs() {
        let mut ctx = minimal_context();
        ctx.experimental_firewall = Some(crate::types::ExperimentalFirewall {
            enabled: true,
            rules: None,
            experimental_mitm: None,
            experimental_seal_secrets: None,
        });
        let env = build_env_json(&ctx, "http://localhost");
        assert!(!env.contains_key("NODE_EXTRA_CA_CERTS"));
    }

    #[test]
    fn dmesg_oom_positive() {
        assert!(dmesg_indicates_oom(
            "[  12.345] Out of memory: Killed process 1234 (claude)"
        ));
        assert!(dmesg_indicates_oom("oom-kill:constraint=CONSTRAINT_MEMCG"));
        assert!(dmesg_indicates_oom("oom_reaper: reaped process 42"));
        assert!(dmesg_indicates_oom("Killed process 42 (node)"));
    }

    #[test]
    fn dmesg_oom_negative() {
        assert!(!dmesg_indicates_oom(""));
        assert!(!dmesg_indicates_oom("normal kernel log output"));
        assert!(!dmesg_indicates_oom("[  1.000] eth0: link up"));
        // "killed" alone should not match — requires "killed process"
        assert!(!dmesg_indicates_oom("task killed by signal 15"));
        // substring "oom" in unrelated words should not match
        assert!(!dmesg_indicates_oom("the room is full"));
    }

    #[test]
    fn dmesg_oom_case_insensitive() {
        assert!(dmesg_indicates_oom("Out Of Memory: killed process 99"));
        assert!(dmesg_indicates_oom("Killed process 99 (agent)"));
        assert!(dmesg_indicates_oom("OOM-kill: constraint=MEMCG"));
    }
}
