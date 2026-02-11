use std::collections::HashMap;
use std::time::Duration;

use sandbox::{ExecRequest, Sandbox, SandboxConfig, SandboxFactory};
use tracing::{error, info, warn};
use uuid::Uuid;

/// Maximum wall-clock time for a single job (2 hours).
const JOB_TIMEOUT: Duration = Duration::from_secs(7200);
/// Default timeout for guest commands (5 minutes).
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(300);

use crate::api::ApiClient;
use crate::error::RunnerResult;
use crate::paths::guest;
use crate::types::ExecutionContext;

/// Configuration for a single execution.
pub struct ExecutorConfig {
    pub api_url: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub is_snapshot: bool,
}

/// Execute a single job inside a Firecracker VM.
///
/// On failure before agent spawn, reports completion with `exit_code = 1`.
/// Always calls `factory.destroy()` on the sandbox when done.
pub async fn execute_job(
    api: &ApiClient,
    factory: &dyn SandboxFactory,
    context: ExecutionContext,
    config: &ExecutorConfig,
) {
    let run_id = context.run_id;

    let (exit_code, err) = match execute_inner(factory, &context, config).await {
        Ok((code, stderr)) => (code, stderr),
        Err(e) => {
            error!(run_id = %run_id, error = %e, "job execution failed");
            (1, Some(e.to_string()))
        }
    };

    info!(run_id = %run_id, exit_code, "job finished, reporting completion");

    if let Err(e) = api
        .complete(&context.sandbox_token, run_id, exit_code, err.as_deref())
        .await
    {
        warn!(run_id = %run_id, error = %e, "completion report failed, retrying");
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Err(e) = api
            .complete(&context.sandbox_token, run_id, exit_code, err.as_deref())
            .await
        {
            error!(run_id = %run_id, error = %e, "failed to report completion after retry");
        }
    }
}

async fn execute_inner(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    config: &ExecutorConfig,
) -> RunnerResult<(i32, Option<String>)> {
    let sandbox_id = Uuid::new_v4();
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: config.vcpu,
            memory_mb: config.memory_mb,
        },
    };

    // Create and start sandbox
    info!(run_id = %context.run_id, sandbox_id = %sandbox_id, "creating sandbox");
    let mut sandbox = factory.create(sandbox_config).await?;

    if let Err(e) = sandbox.start().await {
        factory.destroy(sandbox).await;
        return Err(e.into());
    }

    // Run job inside sandbox, then destroy regardless of outcome
    let result = run_in_sandbox(sandbox.as_ref(), context, config).await;

    // Best-effort stop
    if let Err(e) = sandbox.stop().await {
        warn!(sandbox_id = %sandbox_id, error = %e, "sandbox stop failed");
    }
    factory.destroy(sandbox).await;

    result
}

async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
) -> RunnerResult<(i32, Option<String>)> {
    // 1. Fix guest clock after snapshot restore (must happen before HTTPS calls)
    if config.is_snapshot {
        fix_guest_clock(sandbox).await?;
    }

    // 2. Download storages
    if let Some(manifest) = &context.storage_manifest {
        download_storages(sandbox, context, manifest).await?;
    }

    // 3. Restore session history
    if let Some(session) = &context.resume_session {
        restore_session(sandbox, context, session).await?;
    }

    // 4. Build env vars (passed directly via vsock protocol)
    let env_map = build_env_json(context, &config.api_url);
    let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

    // 5. Spawn agent
    let log_file = format!("/tmp/vm0-main-{}.log", context.run_id);
    let agent_cmd = format!("{} > {log_file} 2>&1", guest::RUN_AGENT);
    info!(run_id = %context.run_id, "spawning agent");

    // JOB_TIMEOUT is used for both spawn_watch (guest-side kill) and wait_exit
    // (host-side watchdog) so neither side outlives the other.
    let handle = sandbox
        .spawn_watch(&ExecRequest {
            cmd: &agent_cmd,
            timeout: JOB_TIMEOUT,
            env: &env_refs,
        })
        .await?;

    // 6. Wait for exit
    let exit = sandbox.wait_exit(handle, JOB_TIMEOUT).await?;
    let stderr = String::from_utf8_lossy(&exit.stderr).to_string();

    info!(
        run_id = %context.run_id,
        exit_code = exit.exit_code,
        "agent exited"
    );

    let error_msg = if exit.exit_code != 0 {
        Some(stderr).filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok((exit.exit_code, error_msg))
}

/// Sync guest clock to host time after snapshot restore.
///
/// Must run before any HTTPS calls — stale clock breaks TLS cert validation.
async fn fix_guest_clock(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    let timestamp = format!(
        "{:.3}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    );
    let date_cmd = format!("sudo date -s \"@{timestamp}\"");
    sandbox
        .exec(&ExecRequest {
            cmd: &date_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
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
        })
        .await?;
    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;
    info!(run_id = %context.run_id, path = %session_path, "restored session history");
    Ok(())
}

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
            vars: None,
            sandbox_token: "tok".into(),
            working_dir: "/workspace".into(),
            storage_manifest: None,
            environment: None,
            resume_session: None,
            secret_values: None,
            cli_agent_type: String::new(),
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
}
