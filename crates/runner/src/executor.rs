//! In-process job execution for the runner.
//!
//! `cmd/start/job_spawn.rs::spawn_job` calls this module after a provider claim and
//! budget reservation. The executor owns the sandbox-side run flow, while the
//! caller owns provider completion and the final sandbox lifecycle decision.
//!
//! There are two public entry points:
//! - `execute_job` starts a fresh Firecracker VM.
//! - `execute_job_reuse` runs in a kept-alive idle VM.
//!
//! Both entry points return `ExecuteOutcome` plus a pending `JobTelemetry`
//! buffer. When `ExecuteOutcome::sandbox` is `Some`, the sandbox is still alive
//! and the caller decides whether to park it for reuse or destroy it. The
//! caller also flushes telemetry after firing `provider.complete`, so the
//! user-visible completion signal is not blocked on best-effort uploads.

use std::collections::HashMap;
use std::io::{self, SeekFrom};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use agent_diagnostics::{
    FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FailureDiagnostic, failure_diagnostic_file,
};
use futures_util::FutureExt;
use sandbox::{
    CopyFileOptions, EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest,
    ProcessControlMode, ProcessOutputMode, ProcessOutputReceiver, Sandbox, SandboxConfig,
    SandboxFactory, SandboxId, StartProcessRequest,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use api_contracts::generated::model_providers::model_provider_env::placeholders as model_provider_placeholders;

use crate::ids::RunId;

/// Maximum wall-clock time for a single job (2 hours).
const JOB_TIMEOUT: Duration = Duration::from_secs(7200);
/// Maximum time to spend writing the guest cancel frame after a user cancel.
const PROCESS_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
/// Grace period for the guest to report a terminal status after cancel is sent.
/// This covers vsock-guest's 5s stdout/stderr drain deadline after it kills
/// the cancelled process.
const PROCESS_CANCEL_TERMINAL_GRACE_TIMEOUT: Duration = Duration::from_secs(6);
const PROCESS_CANCEL_TIMEOUTS: ProcessCancelTimeouts = ProcessCancelTimeouts {
    write: PROCESS_CANCEL_WRITE_TIMEOUT,
    terminal_grace: PROCESS_CANCEL_TERMINAL_GRACE_TIMEOUT,
};
/// Exit code when a process is killed by SIGKILL (128 + 9).
const EXIT_SIGKILL: i32 = 137;
/// Raw SIGKILL signal number.
const EXIT_SIGNAL_KILL: i32 = 9;
/// Default timeout for guest commands (5 minutes).
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(300);
const SMALL_GUEST_FILE_MAX_BYTES: u64 = 64 * 1024;
const GUEST_LOG_COPY_MAX_BYTES: u64 = 64 * 1024 * 1024;
const GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES: usize = 8 * 1024;
const STDOUT_STREAM_LIMIT_MARKER: &[u8] =
    b"[vm0] stdout stream reached the guest stream limit; later output was omitted\n";
const STDOUT_STREAM_OVERFLOW_MARKER: &[u8] =
    b"[vm0] stdout stream overflowed the host queue; some output was dropped\n";
const MIN_EPOCH_MS_TIMESTAMP: u64 = 1_000_000_000_000;
static INVALID_API_START_TIME_WARNED: AtomicBool = AtomicBool::new(false);

use crate::error::{RunnerError, RunnerResult};
use crate::host_env::{
    RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV, RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV,
};
use crate::http::HttpClient;
use crate::idle_pool::ReusableIdleSandbox;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogManager;
use crate::network_log_manager::NetworkLogSession;
use crate::paths::{HomePaths, LogPaths, guest};
use crate::proxy::{self, ProxyRegistryHandle};
use crate::telemetry::JobTelemetry;
use crate::types::{
    ExecutionContext, GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry,
    ResumeSession, SandboxReuseResult,
};

/// Shared configuration for all executions (profile-independent).
pub struct ExecutorConfig {
    pub api_url: String,
    pub registry: ProxyRegistryHandle,
    pub http: HttpClient,
    pub log_paths: LogPaths,
    pub network_log_manager: NetworkLogManager,
    pub network_log_drain: NetworkLogDrainCoordinator,
    pub home: HomePaths,
}

/// Per-job VM parameters resolved from the profile config.
pub struct JobParams {
    pub vcpu: u32,
    pub memory_mb: u32,
    pub restore_guest_state: bool,
    pub device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

/// Outcome of a job execution, including the sandbox for possible reuse.
pub struct ExecuteOutcome {
    pub failure: Option<ExecutionFailure>,
    /// The sandbox after execution. `Some` when the sandbox is still alive
    /// and eligible for keep-alive parking. `None` when execution failed
    /// during create/start (sandbox was destroyed inline).
    pub sandbox: Option<Box<dyn Sandbox>>,
    pub source_ip: String,
    pub network_log_session: Option<NetworkLogSession>,
    /// CLI-generated session ID read from the guest after execution.
    /// Used for first-run VM parking when `resume_session` is absent.
    pub guest_session_id: Option<String>,
}

impl ExecuteOutcome {
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        self.failure.as_ref().map_or(0, |failure| failure.exit_code)
    }

    #[must_use]
    pub fn error(&self) -> Option<&str> {
        self.failure.as_ref().map(|failure| failure.error.as_str())
    }

    pub fn mark_cancelled(&mut self) {
        self.failure = Some(ExecutionFailure::cancelled());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionFailure {
    pub exit_code: i32,
    pub error: String,
    pub diagnostic: Option<FailureDiagnostic>,
}

impl ExecutionFailure {
    #[must_use]
    pub fn new(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        let error = non_empty_failure_error(exit_code, error.into());
        Self {
            exit_code,
            error,
            diagnostic,
        }
    }

    #[must_use]
    pub fn from_error(error: impl Into<String>) -> Self {
        Self::new(1, error, None)
    }

    #[must_use]
    pub fn cancelled() -> Self {
        Self::new(EXIT_SIGKILL, "cancelled by user", None)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct AgentStdoutStreamDiagnostics {
    chunk_truncated: bool,
    stream_overflowed: bool,
}

impl AgentStdoutStreamDiagnostics {
    fn is_empty(self) -> bool {
        !self.chunk_truncated && !self.stream_overflowed
    }
}

#[derive(Clone, Copy)]
struct ProcessCancelTimeouts {
    write: Duration,
    terminal_grace: Duration,
}

struct AgentExecutionResult {
    failure: Option<ExecutionFailure>,
    stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
}

impl AgentExecutionResult {
    fn success() -> Self {
        Self {
            failure: None,
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
        }
    }

    fn failure(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        Self {
            failure: Some(ExecutionFailure::new(exit_code, error, diagnostic)),
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
        }
    }

    fn failure_from_error(error: impl Into<String>) -> Self {
        Self::failure(1, error, None)
    }

    fn exit_code(&self) -> i32 {
        self.failure.as_ref().map_or(0, |failure| failure.exit_code)
    }

    fn with_stdout_stream_diagnostics(mut self, diagnostics: AgentStdoutStreamDiagnostics) -> Self {
        self.stdout_stream_diagnostics = diagnostics;
        self
    }
}

fn non_empty_failure_error(exit_code: i32, error: String) -> String {
    if error.trim().is_empty() {
        agent_exit_failure_message(exit_code)
    } else {
        error
    }
}

fn agent_exit_failure_message(exit_code: i32) -> String {
    format!("Agent exited with code {exit_code}")
}

fn cancelled_agent_process_exit(pid: u32, stream_overflowed: bool) -> sandbox::ProcessExit {
    let mut exit = sandbox::ProcessExit::new(pid, EXIT_SIGKILL, Vec::new(), Vec::new());
    exit.stream_overflowed = stream_overflowed;
    exit
}

/// Execute a single job inside a **new** Firecracker VM.
///
/// Returns [`ExecuteOutcome`] with the sandbox still alive (not stopped/destroyed)
/// plus the pending [`JobTelemetry`] buffer. The caller (`spawn_job` in
/// `cmd/start/job_spawn.rs`) decides whether to park the sandbox or destroy it, and
/// **must** flush the telemetry **after** firing `provider.complete` so the
/// user-visible run-complete signal isn't blocked on best-effort telemetry
/// uploads (~383 ms saved per job).
pub async fn execute_job(
    factory: &dyn SandboxFactory,
    context: ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    let run_id = context.run_id;
    let mut telemetry =
        JobTelemetry::new(config.http.clone(), run_id, context.sandbox_token.clone());

    record_reuse_result(&mut telemetry, dispatch.reuse_result);
    record_api_latency("api_to_vm_start", &context, &mut telemetry);

    let outcome = if let Err(error) = validate_execution_context_before_sandbox(&context) {
        ExecuteOutcome {
            failure: Some(ExecutionFailure::from_error(error)),
            sandbox: None,
            source_ip: String::new(),
            network_log_session: None,
            guest_session_id: None,
        }
    } else {
        match execute_new_sandbox(
            factory,
            &context,
            dispatch,
            config,
            params,
            &mut telemetry,
            cancel,
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(e) => ExecuteOutcome {
                failure: Some(ExecutionFailure::from_error(e.to_string())),
                sandbox: None,
                source_ip: String::new(),
                network_log_session: None,
                guest_session_id: None,
            },
        }
    };

    (outcome, telemetry)
}

/// Execute a single job inside a **reused** (kept-alive) VM.
///
/// Skips create + start. Re-registers proxy, fixes clock, then runs the agent.
/// Returns [`ExecuteOutcome`] with the sandbox still alive plus the pending
/// [`JobTelemetry`] buffer — the caller (`spawn_job` in `cmd/start/job_spawn.rs`)
/// must flush telemetry after firing `provider.complete` (see [`execute_job`] for
/// rationale).
pub async fn execute_job_reuse(
    idle_sandbox: ReusableIdleSandbox,
    context: ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    let run_id = context.run_id;
    let mut telemetry =
        JobTelemetry::new(config.http.clone(), run_id, context.sandbox_token.clone());

    record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
    record_api_latency("api_to_vm_start", &context, &mut telemetry);

    let idle_parts = idle_sandbox.into_parts();
    let source_ip = idle_parts.source_ip;
    let prev_storage = idle_parts.storage_fingerprints;
    let sandbox = idle_parts.sandbox;

    // execute_reused_sandbox never returns Err — it always returns the sandbox
    // in the outcome so the caller can stop + destroy it on failure.
    let outcome = if let Err(error) = validate_execution_context_before_sandbox(&context) {
        ExecuteOutcome {
            failure: Some(ExecutionFailure::from_error(error)),
            sandbox: Some(sandbox),
            source_ip,
            network_log_session: None,
            guest_session_id: None,
        }
    } else {
        execute_reused_sandbox(
            sandbox,
            &source_ip,
            &context,
            config,
            &prev_storage,
            &mut telemetry,
            cancel,
        )
        .await
    };

    (outcome, telemetry)
}

/// Emit a single telemetry event capturing the outcome of the reuse decision.
/// `Reused` emits `sandbox_reuse_hit`; every miss variant emits
/// `sandbox_reuse_miss`. Firing on every job makes
/// the reuse success rate queryable in Axiom as
/// `countif(op_type == "sandbox_reuse_hit") / countif(op_type startswith "sandbox_reuse_")`.
/// Miss-reason breakdown lives on the `agent_runs.sandbox_reuse_result`
/// column in Postgres, so it's not duplicated here. Duration is zero — this
/// is a marker, not a timing.
fn record_reuse_result(telemetry: &mut JobTelemetry, result: SandboxReuseResult) {
    let action_type = match result {
        SandboxReuseResult::Reused => "sandbox_reuse_hit",
        SandboxReuseResult::NoSessionId
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => "sandbox_reuse_miss",
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

fn record_api_latency(action_type: &str, context: &ExecutionContext, telemetry: &mut JobTelemetry) {
    if let Some(api_start_ms) = context.api_start_time {
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        if let Some(duration) = elapsed_since_api_start_ms(api_start_ms, now_ms) {
            telemetry.record(action_type, duration, true, None);
        } else {
            warn_invalid_api_start_time_once(action_type, context, api_start_ms);
        }
    }
}

fn warn_invalid_api_start_time_once(
    action_type: &str,
    context: &ExecutionContext,
    api_start_ms: u64,
) {
    if INVALID_API_START_TIME_WARNED.swap(true, Ordering::Relaxed) {
        return;
    }

    warn!(
        run_id = %context.run_id,
        api_start_ms,
        min_epoch_ms_timestamp = MIN_EPOCH_MS_TIMESTAMP,
        action_type,
        "skipping API latency telemetry for invalid epoch-ms start timestamp"
    );
}

fn elapsed_since_api_start_ms(api_start_ms: u64, now_ms: u64) -> Option<Duration> {
    if api_start_ms < MIN_EPOCH_MS_TIMESTAMP {
        return None;
    }

    Some(Duration::from_millis(now_ms.saturating_sub(api_start_ms)))
}

struct ProtectedModelProviderEnvKey {
    name: &'static str,
    placeholder: Option<&'static str>,
}

const CLAUDE_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[ProtectedModelProviderEnvKey] = &[
    ProtectedModelProviderEnvKey {
        name: "ANTHROPIC_API_KEY",
        placeholder: Some(model_provider_placeholders::ANTHROPIC_API_KEY),
    },
    ProtectedModelProviderEnvKey {
        name: "ANTHROPIC_AUTH_TOKEN",
        placeholder: Some(model_provider_placeholders::ANTHROPIC_AUTH_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        placeholder: Some(model_provider_placeholders::CLAUDE_CODE_OAUTH_TOKEN),
    },
];

const CODEX_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[ProtectedModelProviderEnvKey] = &[
    ProtectedModelProviderEnvKey {
        name: "OPENAI_API_KEY",
        placeholder: Some(model_provider_placeholders::OPENAI_API_KEY),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ACCESS_TOKEN",
        placeholder: Some(model_provider_placeholders::CHATGPT_ACCESS_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ACCOUNT_ID",
        placeholder: Some(model_provider_placeholders::CHATGPT_ACCOUNT_ID),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_REFRESH_TOKEN",
        placeholder: Some(model_provider_placeholders::CHATGPT_REFRESH_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ID_TOKEN",
        placeholder: None,
    },
];

const MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[&[ProtectedModelProviderEnvKey]] = &[
    CLAUDE_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS,
    CODEX_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS,
];

fn validate_model_provider_env_placeholders(context: &ExecutionContext) -> Result<(), String> {
    let Some(environment) = &context.environment else {
        return Ok(());
    };

    let invalid_keys: Vec<&str> = MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS
        .iter()
        .flat_map(|protected_keys| protected_keys.iter())
        .filter_map(|protected_key| {
            let value = environment.get(protected_key.name)?;
            if value.is_empty()
                || protected_key
                    .placeholder
                    .is_some_and(|placeholder| value == placeholder)
            {
                None
            } else {
                Some(protected_key.name)
            }
        })
        .collect();

    if invalid_keys.is_empty() {
        return Ok(());
    }

    Err(format!(
        "model provider environment contains non-placeholder values for: {}",
        invalid_keys.join(", ")
    ))
}

fn validate_execution_context_before_sandbox(context: &ExecutionContext) -> Result<(), String> {
    validate_model_provider_env_placeholders(context)?;
    validate_claude_tool_lists(context)?;
    Ok(())
}

fn validate_claude_tool_lists(context: &ExecutionContext) -> Result<(), String> {
    if effective_cli_framework(&context.cli_agent_type) != EffectiveCliFramework::ClaudeCode {
        return Ok(());
    }

    if let Some(tools) = &context.disallowed_tools {
        validate_claude_tool_env_entries("VM0_DISALLOWED_TOOLS", tools)?;
    }
    if let Some(tools) = &context.tools {
        validate_claude_tool_env_entries("VM0_TOOLS", tools)?;
    }

    Ok(())
}

/// Dispatch inputs for the fresh-create path. Holds the UUID for the new VM
/// and the categorized reason no idle VM was reused. The id is selected in job
/// discovery after the reuse decision, then forwarded by `job_spawn`; it becomes
/// the sandbox's identity, and the reuse result is forwarded to the guest for
/// /complete metadata.
#[derive(Clone, Copy)]
pub struct NewSandboxDispatch {
    pub id: SandboxId,
    pub reuse_result: SandboxReuseResult,
}

/// Create a new sandbox, run the job, and return the sandbox for possible reuse.
///
/// The caller is responsible for stop + destroy (or parking in the idle pool).
async fn execute_new_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> RunnerResult<ExecuteOutcome> {
    let NewSandboxDispatch {
        id: sandbox_id,
        reuse_result,
    } = dispatch;
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: params.vcpu,
            memory_mb: params.memory_mb,
        },
        device_rate_limits: params.device_rate_limits.clone(),
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

    let source_ip = sandbox.source_ip().to_string();

    // Register VM in proxy registry BEFORE starting the sandbox.
    let network_log_session = register_proxy(config, context, &source_ip).await;

    if let Err(e) = sandbox.start().await {
        telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
        unregister_proxy_registry(config, context, &source_ip).await;
        network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        destroy_sandbox_panic_safe(factory, sandbox).await;
        return Err(e.into());
    }
    telemetry.record("vm_create", t.elapsed(), true, None);

    Ok(execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        context,
        config,
        RunStart {
            restore_guest_state: params.restore_guest_state,
            reuse_result,
            prev_storage: None,
        },
        telemetry,
        cancel,
    )
    .await)
}

struct PreparedSandboxRun {
    sandbox: Box<dyn Sandbox>,
    source_ip: String,
    network_log_session: NetworkLogSession,
}

async fn destroy_sandbox_panic_safe(factory: &dyn SandboxFactory, sandbox: Box<dyn Sandbox>) {
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("sandbox destroy panicked after start failure");
    }
}

/// Run a job inside a reused (kept-alive) sandbox.
///
/// Skips create + start. Re-registers proxy, fixes clock/entropy, then runs.
async fn execute_reused_sandbox(
    sandbox: Box<dyn Sandbox>,
    source_ip: &str,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    prev_storage: &crate::idle_pool::StorageFingerprints,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> ExecuteOutcome {
    info!(
        run_id = %context.run_id,
        sandbox_id = %sandbox.id(),
        "reusing kept-alive sandbox"
    );

    let source_ip = source_ip.to_string();
    let network_log_session = register_proxy(config, context, &source_ip).await;

    execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        context,
        config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: Some(prev_storage),
        },
        telemetry,
        cancel,
    )
    .await
}

async fn execute_prepared_sandbox_run(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> ExecuteOutcome {
    let PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
    } = run;

    let result = run_in_sandbox(
        sandbox.as_ref(),
        context,
        config,
        start,
        telemetry,
        cancel.clone(),
    )
    .await;

    let stdout_stream_diagnostics = result.as_ref().map_or_else(
        |_| AgentStdoutStreamDiagnostics::default(),
        |result| result.stdout_stream_diagnostics,
    );

    post_job_cleanup(
        sandbox.as_ref(),
        config,
        context,
        &source_ip,
        cancel.is_cancelled(),
        stdout_stream_diagnostics,
    )
    .await;

    let agent_result = match result {
        Ok(result) => result,
        Err(e) => AgentExecutionResult::failure_from_error(e.to_string()),
    };

    // Read CLI-generated session ID for first-run parking.
    let guest_session_id = if agent_result.exit_code() == 0 && context.session_id().is_none() {
        let id = read_guest_session_id(sandbox.as_ref(), context.run_id).await;
        if let Some(ref sid) = id {
            info!(run_id = %context.run_id, session_id = %sid, "read guest session ID for parking");
        }
        id
    } else {
        None
    };

    ExecuteOutcome {
        failure: agent_result.failure,
        sandbox: Some(sandbox),
        source_ip,
        network_log_session: Some(network_log_session),
        guest_session_id,
    }
}

/// Register a VM in the proxy registry and network log manager.
async fn register_proxy(
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
) -> NetworkLogSession {
    let network_log_path = config.log_paths.network_log(context.run_id);
    let proxy_log_path = config.log_paths.proxy_log(context.run_id);
    let run_id_str = context.run_id.to_string();
    let cli_agent_type = normalized_cli_agent_type(&context.cli_agent_type);
    let registration = proxy::VmRegistration {
        run_id: &run_id_str,
        cli_agent_type,
        sandbox_token: &context.sandbox_token,
        network_log_path: &network_log_path,
        proxy_log_path: &proxy_log_path,
        firewalls: context.firewalls.as_deref(),
        network_policies: context.network_policies.as_ref(),
        encrypted_secrets: context.encrypted_secrets.as_deref(),
        secret_connector_map: context.secret_connector_map.as_ref(),
        secret_connector_metadata_map: context.secret_connector_metadata_map.as_ref(),
        vars: context.vars.as_ref(),
        capture_network_bodies: context.capture_network_bodies.unwrap_or(false),
        billable_firewalls: &context.billable_firewalls,
        model_usage_provider: context.model_usage_provider.as_deref(),
    };
    if let Err(e) = config.registry.register_vm(source_ip, &registration).await {
        warn!(run_id = %context.run_id, error = %e, "failed to register VM in proxy");
    }
    config
        .network_log_manager
        .register_source_ip(source_ip, network_log_path)
        .await
}

/// Unregister a VM from the proxy registry.
async fn unregister_proxy_registry(
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
) {
    if let Err(e) = config.registry.unregister_vm(source_ip).await {
        warn!(run_id = %context.run_id, error = %e, "failed to unregister VM from proxy");
    }
}

/// Post-job cleanup: copy logs, unregister proxy registry.
///
/// Called after `run_in_sandbox` completes, whether the sandbox will be
/// parked (keep-alive) or destroyed. Rust-side network-log attribution stays
/// open until `sandbox_finalization` quiesces the sandbox and closes the returned
/// `NetworkLogSession`; the HTTP upload remains deferred after `provider.complete`.
async fn post_job_cleanup(
    sandbox: &dyn Sandbox,
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
    cancelled: bool,
    stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
) {
    copy_guest_logs(sandbox, context, &config.log_paths, cancelled).await;
    append_stdout_stream_diagnostics_to_system_log(
        context.run_id,
        &config.log_paths.system_log(context.run_id),
        stdout_stream_diagnostics,
    )
    .await;
    unregister_proxy_registry(config, context, source_ip).await;
}

/// How this run is entering its sandbox. Each field feeds a distinct step:
/// `restore_guest_state` gates clock/entropy repair, `prev_storage` enables
/// the download-skip optimization on reuse, and `reuse_result` is forwarded
/// to the guest for /complete metadata.
struct RunStart<'a> {
    restore_guest_state: bool,
    reuse_result: SandboxReuseResult,
    prev_storage: Option<&'a crate::idle_pool::StorageFingerprints>,
}

async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> RunnerResult<AgentExecutionResult> {
    run_in_sandbox_with_process_cancel_timeouts(
        sandbox,
        context,
        config,
        start,
        telemetry,
        cancel,
        PROCESS_CANCEL_TIMEOUTS,
    )
    .await
}

async fn run_in_sandbox_with_process_cancel_timeouts(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> RunnerResult<AgentExecutionResult> {
    // 1. Fix guest clock and reseed entropy (must happen before HTTPS calls).
    //    Needed after snapshot restore (frozen clock) and after idle reuse (drifted clock).
    if start.restore_guest_state {
        fix_guest_clock(sandbox).await?;
        reseed_guest_entropy(sandbox).await?;
    }

    // 2. Set guest timezone from user preference (best-effort, never fails).
    sync_guest_timezone(sandbox, context).await;

    // 3. Download storages (skipping entries unchanged since the previous turn)
    if let Some(manifest) = &context.storage_manifest {
        let guest_manifest = GuestDownloadManifest::from(manifest);
        let mut effective: GuestDownloadManifest = match start.prev_storage {
            Some(prev) => filter_unchanged_storages(&guest_manifest, prev),
            None => guest_manifest,
        };
        // Short-circuit: skip the vsock exec if every entry was filtered out
        // and there are no paths to clean up.
        let has_work = effective.storages.iter().any(|s| s.archive_url.is_some())
            || effective.artifacts.iter().any(|a| a.archive_url.is_some())
            || !effective.cleanup_paths.is_empty();
        if !has_work {
            info!(run_id = %context.run_id, "all storages unchanged, skipping download");
        }
        let t = Instant::now();
        let result = if has_work {
            // Populate the runner-side cache first, rewriting eligible entries'
            // `archive_url` to `file:///tmp/vm0-storage-cache/...` so the guest
            // reads from its tmpfs instead of hitting R2 per turn.
            async {
                crate::storage_cache::populate_cache(
                    &mut effective,
                    sandbox,
                    &config.home,
                    telemetry,
                )
                .await?;
                download_storages(sandbox, context, &effective).await
            }
            .await
        } else {
            Ok(())
        };
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "storage_download",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 4. Restore session history
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

    // 5. Build env vars (passed directly via vsock protocol)
    let env_map = build_env_json(context, &config.api_url, sandbox.id(), start.reuse_result)?;
    let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

    // 6. Spawn agent — stdout streamed to host via vsock, stderr merged into stdout.
    //    guest-agent owns the guest-side system log for telemetry; the runner
    //    separately writes streamed chunks to the host log file in real time.
    let agent_cmd = format!("{} 2>&1", guest::RUN_AGENT);
    info!(run_id = %context.run_id, "spawning agent");

    // JOB_TIMEOUT configures both the guest-side process timeout and the
    // host-side wait watchdog. They remain separate protocol mechanisms.
    let t = Instant::now();
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: &agent_cmd,
            timeout: JOB_TIMEOUT,
            env: &env_refs,
            sudo: false,
            output: ProcessOutputMode::stream(),
            control: ProcessControlMode::Enabled,
        })
        .await;

    let mut handle = match handle {
        Ok(h) => h,
        Err(e) => {
            telemetry.record("agent_execute", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

    // Claude Code process has a PID now — record end-to-end startup latency.
    record_api_latency("api_to_spawn", context, telemetry);

    // Spawn background task to drain stdout chunks and write to host log file.
    let host_log_path = config.log_paths.system_log(context.run_id);
    let stream_task = handle
        .take_stdout_receiver()
        .map(|stdout_rx| tokio::spawn(drain_stdout_to_file(stdout_rx, host_log_path)));

    // 6. Wait for exit (or cancellation). On cancel, ask the guest to cancel the
    // supervised process and briefly wait for its terminal status so the vsock
    // operation can be removed before sandbox cleanup closes the connection.
    let process_pid = handle.pid;
    let process_cancel = handle.take_cancel_handle();
    let wait_process = sandbox.wait_process(handle, JOB_TIMEOUT);
    tokio::pin!(wait_process);
    let (result, wait_cancelled, abort_stdout_drain) = tokio::select! {
        biased;
        result = &mut wait_process => {
            let abort_stdout_drain = result.is_err();
            (result, false, abort_stdout_drain)
        }
        () = cancel.cancelled() => {
            info!(run_id = %context.run_id, "cancel received, cancelling guest process");
            let cancelled_exit = || -> sandbox::Result<sandbox::ProcessExit> {
                Ok(cancelled_agent_process_exit(process_pid, false))
            };
            match process_cancel {
                Some(process_cancel) => match process_cancel.cancel(process_cancel_timeouts.write).await {
                    Ok(()) => {
                        match tokio::time::timeout(
                            process_cancel_timeouts.terminal_grace,
                            &mut wait_process,
                        )
                        .await
                        {
                            Ok(Ok(exit)) => {
                                info!(
                                    run_id = %context.run_id,
                                    pid = process_pid,
                                    "cancelled guest process reached terminal status"
                                );
                                (
                                    Ok(cancelled_agent_process_exit(
                                        process_pid,
                                        exit.stream_overflowed,
                                    )),
                                    true,
                                    false,
                                )
                            }
                            Ok(Err(error)) => {
                                warn!(
                                    run_id = %context.run_id,
                                    pid = process_pid,
                                    error = %error,
                                    "guest process wait failed after cancellation"
                                );
                                (cancelled_exit(), true, true)
                            }
                            Err(_) => {
                                warn!(
                                    run_id = %context.run_id,
                                    pid = process_pid,
                                    timeout_ms = process_cancel_timeouts.terminal_grace.as_millis(),
                                    "timed out waiting for cancelled guest process"
                                );
                                (cancelled_exit(), true, true)
                            }
                        }
                    }
                    Err(error) => {
                        warn!(
                            run_id = %context.run_id,
                            pid = process_pid,
                            error = %error,
                            "failed to send guest process cancellation"
                        );
                        (cancelled_exit(), true, true)
                    }
                },
                None => {
                    warn!(
                        run_id = %context.run_id,
                        pid = process_pid,
                        "sandbox does not support guest process cancellation"
                    );
                    (cancelled_exit(), true, true)
                }
            }
        }
    };

    // Wait for streaming to finish (channel closes when process exits).
    // On cancel/timeout/crash the stream channel may not close — abort to
    // prevent blocking indefinitely on the drain task.
    let mut stdout_drain_report = StdoutDrainReport::default();
    if let Some(task) = stream_task {
        if abort_stdout_drain || result.is_err() {
            task.abort();
            let _ = task.await;
        } else {
            match task.await {
                Ok(Ok(report)) => {
                    stdout_drain_report = report;
                }
                Ok(Err(e)) => {
                    warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
                }
                Err(e) => {
                    warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
                }
            }
        }
    }
    let exit = match result {
        Ok(exit) => exit,
        Err(e) => {
            // Sandbox crashed — check host dmesg for cgroup OOM kill of the
            // firecracker process before propagating a generic error.
            if let Some(pid) = sandbox.process_pid()
                && check_host_oom(pid).await
            {
                warn!(run_id = %context.run_id, pid, "host OOM kill detected for firecracker");
                let error = "Firecracker VM killed by host OOM killer \
                             (cgroup memory limit exceeded)"
                    .to_string();
                telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
                return Ok(AgentExecutionResult::failure(1, error, None));
            }
            let error = e.to_string();
            telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
            return Err(e.into());
        }
    };
    if exit.stream_overflowed {
        warn!(run_id = %context.run_id, "agent stdout stream overflowed before process exit");
    }
    let stdout_stream_diagnostics = AgentStdoutStreamDiagnostics {
        chunk_truncated: stdout_drain_report.chunk_truncated,
        stream_overflowed: exit.stream_overflowed,
    };
    if !exit.diagnostic.is_empty() {
        warn!(
            run_id = %context.run_id,
            diagnostic = %exit.diagnostic,
            "agent process reported diagnostic"
        );
    }

    info!(
        run_id = %context.run_id,
        exit_code = exit.exit_code,
        "agent exited"
    );

    // Check for OOM kill when process was terminated by SIGKILL.
    // Skip when cancelled — the SIGKILL exit code is synthetic and dmesg
    // would run against a sandbox that hasn't been stopped yet.
    if !wait_cancelled && (exit.exit_code == EXIT_SIGKILL || exit.exit_code == EXIT_SIGNAL_KILL) {
        let dmesg_req = ExecRequest {
            cmd: "dmesg | tail -20 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        };
        match sandbox.exec(&dmesg_req).await {
            Ok(dmesg) if dmesg_indicates_oom(&String::from_utf8_lossy(&dmesg.stdout)) => {
                warn!(run_id = %context.run_id, "OOM kill detected via dmesg");
                // Return exit code 1 with descriptive message instead of raw 137,
                // so callers see a clear error rather than an opaque signal code.
                let error = "Agent process killed by OOM killer";
                telemetry.record("agent_execute", t.elapsed(), false, Some(error));
                return Ok(AgentExecutionResult::failure(1, error, None)
                    .with_stdout_stream_diagnostics(stdout_stream_diagnostics));
            }
            Err(e) => {
                warn!(run_id = %context.run_id, error = %e, "failed to exec dmesg for OOM check");
            }
            _ => {}
        }
    }

    let failure = if wait_cancelled {
        // Skip guest file reads — sandbox hasn't been stopped yet.
        Some(ExecutionFailure::cancelled())
    } else if exit.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&exit.stderr).to_string();
        let failure_diagnostic = read_guest_failure_diagnostic_file(sandbox, context.run_id).await;
        let error = if !stderr.is_empty() {
            stderr
        } else {
            // Stderr is empty (redirected to log file). Check for a structured
            // error file written by the guest-agent for final failure
            // handoff.
            read_guest_error_file(sandbox, context.run_id)
                .await
                .unwrap_or_else(|| agent_exit_failure_message(exit.exit_code))
        };
        Some(ExecutionFailure::new(
            exit.exit_code,
            error,
            failure_diagnostic,
        ))
    } else {
        None
    };

    let agent_result = match failure {
        Some(failure) => AgentExecutionResult {
            failure: Some(failure),
            stdout_stream_diagnostics,
        },
        None => AgentExecutionResult::success()
            .with_stdout_stream_diagnostics(stdout_stream_diagnostics),
    };
    telemetry.record(
        "agent_execute",
        t.elapsed(),
        agent_result.failure.is_none(),
        agent_result
            .failure
            .as_ref()
            .map(|failure| failure.error.as_str()),
    );
    Ok(agent_result)
}

/// Read a structured error file from the guest filesystem.
///
/// The guest-agent writes final failure messages to
/// `/tmp/vm0-checkpoint-error-{run_id}` so the runner can surface them through
/// `/complete` even though stdout/stderr are redirected to the system log file.
///
/// NOTE: This path must match the convention in `crates/guest-agent/src/paths.rs`
/// (`checkpoint_error_file()`). The runner and guest-agent are separate binaries
/// running in different processes, so the path is duplicated by design.
async fn read_guest_error_file(sandbox: &dyn Sandbox, run_id: RunId) -> Option<String> {
    // Mirror of guest-agent paths::checkpoint_error_file()
    let error_path = format!("/tmp/vm0-checkpoint-error-{run_id}");
    match sandbox
        .read_file(&error_path, SMALL_GUEST_FILE_MAX_BYTES)
        .await
    {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            let msg = String::from_utf8_lossy(&bytes).trim().to_string();
            Some(msg).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Read structured guest failure diagnostics from the guest filesystem.
///
/// Diagnostics are optional and best-effort. They must never change the
/// user-visible completion error or mask the original exit status.
async fn read_guest_failure_diagnostic_file(
    sandbox: &dyn Sandbox,
    run_id: RunId,
) -> Option<FailureDiagnostic> {
    let path = failure_diagnostic_file(&run_id.to_string());
    match sandbox.read_file(&path, SMALL_GUEST_FILE_MAX_BYTES).await {
        Ok(Some(bytes)) if !bytes.iter().all(|byte| byte.is_ascii_whitespace()) => {
            match serde_json::from_slice::<FailureDiagnostic>(&bytes) {
                Ok(diagnostic)
                    if diagnostic.schema_version == FAILURE_DIAGNOSTIC_SCHEMA_VERSION =>
                {
                    Some(diagnostic)
                }
                Ok(diagnostic) => {
                    warn!(
                        run_id = %run_id,
                        schema_version = diagnostic.schema_version,
                        "ignoring guest failure diagnostic with unsupported schema version"
                    );
                    None
                }
                Err(e) => {
                    warn!(run_id = %run_id, error = %e, "failed to parse guest failure diagnostic");
                    None
                }
            }
        }
        Ok(_) => None,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to read guest failure diagnostic");
            None
        }
    }
}

/// Read the CLI-generated session ID from the guest filesystem.
///
/// The guest-agent writes the session ID to `/tmp/vm0-session-{run_id}.txt`
/// after the CLI emits its `system/init` event. On first runs (no
/// `resume_session`), the runner uses this to park the VM for keep-alive.
///
/// NOTE: Path must match `crates/guest-agent/src/paths.rs` (`session_id_file()`).
async fn read_guest_session_id(sandbox: &dyn Sandbox, run_id: RunId) -> Option<String> {
    // Mirror of guest-agent paths::session_id_file()
    let path = format!("/tmp/vm0-session-{run_id}.txt");
    match sandbox.read_file(&path, SMALL_GUEST_FILE_MAX_BYTES).await {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            let id = String::from_utf8_lossy(&bytes).trim().to_string();
            Some(id).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Returns true if dmesg output indicates an OOM kill.
fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Check host dmesg for a cgroup OOM kill of a specific firecracker process.
/// Reads the entire ring buffer (~512KB) directly — no shell wrapper needed
/// since the pure function handles filtering.  Times out after 5s to avoid
/// blocking if sudo hangs.
async fn check_host_oom(pid: u32) -> bool {
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::process::Command::new("dmesg").output().await
    })
    .await;
    match result {
        Ok(Ok(out)) if out.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&out.stdout), pid)
        }
        Ok(Ok(out)) => {
            warn!(pid, exit_code = out.status.code(), "dmesg failed");
            false
        }
        Ok(Err(e)) => {
            warn!(pid, error = %e, "failed to run dmesg for OOM check");
            false
        }
        Err(_) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
    }
}

/// Returns true if host dmesg output contains an OOM kill record for the
/// given firecracker PID.  Checks that the character after the PID is not
/// a digit to avoid prefix matches (e.g. pid=1234 must not match pid=12345).
fn host_dmesg_indicates_oom(dmesg: &str, pid: u32) -> bool {
    if !dmesg.contains("oom-kill") {
        return false;
    }
    let needle = format!("task=firecracker,pid={pid}");
    let mut start = 0;
    while let Some(pos) = dmesg[start..].find(&needle) {
        let abs = start + pos + needle.len();
        // Accept if needle is at end of string or next char is not a digit.
        match dmesg.as_bytes().get(abs) {
            Some(c) if c.is_ascii_digit() => {
                // Prefix match (e.g. pid=1234 inside pid=12345) — keep searching.
                start = abs;
            }
            _ => return true,
        }
    }
    false
}

#[derive(Debug, thiserror::Error)]
enum StdoutDrainError {
    #[error("failed to open host log file {path}: {source}")]
    Open { path: PathBuf, source: io::Error },
    #[error("failed to write stdout chunk to host log {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("failed to flush stdout log {path}: {source}")]
    Flush { path: PathBuf, source: io::Error },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct StdoutDrainReport {
    chunk_truncated: bool,
}

/// Drain stdout chunks from the process receiver and write them to a host file.
async fn drain_stdout_to_file(
    mut rx: ProcessOutputReceiver,
    path: PathBuf,
) -> Result<StdoutDrainReport, StdoutDrainError> {
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await;
    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            return Err(StdoutDrainError::Open { path, source: e });
        }
    };
    let mut report = StdoutDrainReport::default();
    while let Some(chunk) = rx.recv().await {
        if chunk.truncated {
            report.chunk_truncated = true;
            warn!(path = %path.display(), "stdout stream chunk was truncated before host log write");
        }
        if let Err(e) = file.write_all(&chunk.bytes).await {
            return Err(StdoutDrainError::Write { path, source: e });
        }
    }
    // Flush to ensure the last blocking write completes before we return.
    // tokio::fs::File::poll_write returns Ready before the blocking write finishes,
    // so without flush the caller may observe incomplete file contents.
    if let Err(e) = file.flush().await {
        return Err(StdoutDrainError::Flush { path, source: e });
    }
    Ok(report)
}

async fn append_stdout_stream_diagnostics_to_system_log(
    run_id: RunId,
    path: &Path,
    diagnostics: AgentStdoutStreamDiagnostics,
) {
    if diagnostics.is_empty() {
        return;
    }

    if let Err(e) = append_stdout_stream_diagnostics(path, diagnostics).await {
        warn!(
            run_id = %run_id,
            path = %path.display(),
            error = %e,
            "failed to append stdout stream diagnostic marker to host system log"
        );
    }
}

async fn append_stdout_stream_diagnostics(
    path: &Path,
    diagnostics: AgentStdoutStreamDiagnostics,
) -> io::Result<()> {
    if diagnostics.is_empty() {
        return Ok(());
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(path)
        .await?;

    if file.metadata().await?.len() > 0 {
        file.seek(SeekFrom::End(-1)).await?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last).await?;
        if last[0] != b'\n' {
            file.write_all(b"\n").await?;
        }
    }
    if diagnostics.chunk_truncated {
        file.write_all(STDOUT_STREAM_LIMIT_MARKER).await?;
    }
    if diagnostics.stream_overflowed {
        file.write_all(STDOUT_STREAM_OVERFLOW_MARKER).await?;
    }
    file.flush().await
}

/// Guest log file path prefixes. Each turn creates files named
/// `{PREFIX}{run_id}{SUFFIX}` under `/tmp`. Used by `copy_guest_logs`.
const GUEST_SYSTEM_LOG_PREFIX: &str = "/tmp/vm0-system-";
const GUEST_SYSTEM_LOG_SUFFIX: &str = ".log";
const GUEST_METRICS_LOG_PREFIX: &str = "/tmp/vm0-metrics-";
const GUEST_METRICS_LOG_SUFFIX: &str = ".jsonl";
const GUEST_SANDBOX_OPS_LOG_PREFIX: &str = "/tmp/vm0-sandbox-ops-";
const GUEST_SANDBOX_OPS_LOG_SUFFIX: &str = ".jsonl";

/// Copy guest log files to host (best-effort, post-job).
///
/// The agent phase is streamed to the host in real time via vsock stdout
/// chunks. The final copy here overwrites with the complete guest-side file,
/// including setup output written before agent streaming starts. Agent stdout
/// that is not written by guest-agent's logger is intentionally not part of
/// the final system log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GuestLogCopyFailureKind {
    Failed,
    SkippedAfterCancellation,
}

fn guest_log_copy_failure_kind(cancelled: bool) -> GuestLogCopyFailureKind {
    if cancelled {
        GuestLogCopyFailureKind::SkippedAfterCancellation
    } else {
        GuestLogCopyFailureKind::Failed
    }
}

async fn copy_guest_logs(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    log_paths: &LogPaths,
    cancelled: bool,
) {
    let run_id = context.run_id;
    let files = [
        (
            format!("{GUEST_SYSTEM_LOG_PREFIX}{run_id}{GUEST_SYSTEM_LOG_SUFFIX}"),
            log_paths.system_log(run_id),
        ),
        (
            format!("{GUEST_METRICS_LOG_PREFIX}{run_id}{GUEST_METRICS_LOG_SUFFIX}"),
            log_paths.metrics_log(run_id),
        ),
        (
            format!("{GUEST_SANDBOX_OPS_LOG_PREFIX}{run_id}{GUEST_SANDBOX_OPS_LOG_SUFFIX}"),
            log_paths.sandbox_ops_log(run_id),
        ),
    ];

    for (guest_path, host_path) in &files {
        if let Err(e) = sandbox
            .copy_file(
                guest_path,
                host_path,
                CopyFileOptions {
                    max_bytes: GUEST_LOG_COPY_MAX_BYTES,
                    timeout: DEFAULT_EXEC_TIMEOUT,
                    missing_ok: true,
                },
            )
            .await
        {
            match guest_log_copy_failure_kind(cancelled) {
                GuestLogCopyFailureKind::SkippedAfterCancellation => {
                    info!(run_id = %run_id, error = %e, guest_path = %guest_path, host_path = %host_path.display(), "guest log copy skipped after cancellation");
                }
                GuestLogCopyFailureKind::Failed => {
                    warn!(run_id = %run_id, error = %e, guest_path = %guest_path, host_path = %host_path.display(), "failed to copy guest log");
                }
            }
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
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &date_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if result.exit_code != 0 {
        return Err(RunnerError::Internal(format_guest_exec_failure(
            "guest clock sync",
            &result,
        )));
    }
    Ok(())
}

/// Reseed guest CRNG after snapshot restore.
///
/// On ARM64 with kernel 6.1, VMGenID does not work (the driver only supports
/// ACPI; DeviceTree support requires kernel 6.10+). All VMs restored from the
/// same snapshot share identical CRNG state, producing identical random output.
///
/// This function injects fresh host entropy and forces an immediate CRNG reseed
/// so each VM produces unique random numbers from the first `getrandom()` call.
pub(crate) async fn reseed_guest_entropy(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    use std::io::Read;

    const ENTROPY_SIZE: usize = 256;

    let mut entropy = vec![0u8; ENTROPY_SIZE];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut entropy))
        .map_err(|e| RunnerError::Internal(format!("read host entropy: {e}")))?;

    let result = sandbox
        .exec(&ExecRequest {
            cmd: "guest-reseed",
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
            stdin_bytes: Some(&entropy),
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;

    if result.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(RunnerError::Internal(format!(
            "guest-reseed failed (exit code {}): {stderr}",
            result.exit_code
        )));
    }

    Ok(())
}

/// Set system timezone inside the guest to match the user's preference.
///
/// Configures timezone at two levels so every process sees the correct time:
///
/// - `/etc/timezone` + `/etc/localtime` — filesystem-level (read by libc)
/// - `TZ` in `/etc/environment` — inherited by all login shells via PAM
///
/// The agent process also receives `TZ` via the env vars in step 6.
/// Skipped when no user timezone is configured (falls back to image default UTC).
async fn sync_guest_timezone(sandbox: &dyn Sandbox, context: &ExecutionContext) {
    let tz = match &context.user_timezone {
        Some(tz) if !tz.is_empty() => tz,
        _ => return,
    };
    // Strict validation: timezone names are like "Asia/Shanghai" or "UTC".
    // Only allow alphanumeric, '/', '_', '-', '+'.  This prevents shell
    // injection since the value is interpolated into a sudo shell command.
    if !tz
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'_' || b == b'-' || b == b'+')
    {
        tracing::warn!(tz = %tz, "rejected invalid timezone name");
        return;
    }
    let cmd = format!(
        "if test -f /usr/share/zoneinfo/{tz}; then \
         echo '{tz}' > /etc/timezone && \
         ln -sf /usr/share/zoneinfo/{tz} /etc/localtime && \
         sed -i '/^TZ=/d' /etc/environment && \
         echo 'TZ={tz}' >> /etc/environment; \
         fi"
    );
    // Best-effort: don't fail the run if timezone setup fails.
    match sandbox
        .exec(&ExecRequest {
            cmd: &cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await
    {
        Ok(result) if result.exit_code != 0 => {
            let stderr_excerpt =
                format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated);
            let stdout_excerpt =
                format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated);
            tracing::warn!(
                run_id = %context.run_id,
                tz = %tz,
                exit_code = result.exit_code,
                stderr_excerpt = %stderr_excerpt.as_deref().unwrap_or(""),
                stdout_excerpt = %stdout_excerpt.as_deref().unwrap_or(""),
                "failed to set guest timezone"
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(run_id = %context.run_id, tz = %tz, error = %e, "failed to set guest timezone");
        }
    }
}

/// Filter a storage manifest by nulling `archive_url` for entries whose
/// version matches the previous turn's fingerprints. `guest-download`
/// skips entries without a valid URL, so unchanged storages stay on disk.
fn filter_unchanged_storages(
    manifest: &GuestDownloadManifest,
    prev: &crate::idle_pool::StorageFingerprints,
) -> GuestDownloadManifest {
    let mut skipped: usize = 0;
    let mut cleanup_paths: Vec<String> = Vec::new();

    let storages: Vec<GuestDownloadStorageEntry> = manifest
        .storages
        .iter()
        .map(|s| {
            let unchanged = prev
                .storages
                .get(&s.mount_path)
                .is_some_and(|(pn, pv)| pn == &s.vas_storage_name && pv == &s.vas_version_id);
            if unchanged {
                skipped += 1;
            } else {
                cleanup_paths.push(s.mount_path.clone());
            }
            GuestDownloadStorageEntry {
                archive_url: if unchanged {
                    None
                } else {
                    s.archive_url.clone()
                },
                instructions_target_filename: s.instructions_target_filename.clone(),
                cached: unchanged,
                ..s.clone()
            }
        })
        .collect();

    // Detect removed storages: paths in previous fingerprints not in current manifest.
    let current_paths: std::collections::HashSet<&str> = manifest
        .storages
        .iter()
        .map(|s| s.mount_path.as_str())
        .collect();
    for prev_path in prev.storages.keys() {
        if !current_paths.contains(prev_path.as_str()) {
            cleanup_paths.push(prev_path.clone());
        }
    }

    let filter_artifact = |a: &GuestDownloadArtifactEntry,
                           prev_ver: &Option<(String, String)>,
                           skipped: &mut usize,
                           cleanup: &mut Vec<String>| {
        let same = prev_ver
            .as_ref()
            .is_some_and(|(name, ver)| *name == a.vas_storage_name && *ver == a.vas_version_id);
        if same {
            *skipped += 1;
        } else {
            cleanup.push(a.mount_path.clone());
        }
        GuestDownloadArtifactEntry {
            archive_url: if same { None } else { a.archive_url.clone() },
            cached: same,
            ..a.clone()
        }
    };

    let artifacts: Vec<GuestDownloadArtifactEntry> = manifest
        .artifacts
        .iter()
        .map(|a| {
            let prev_ver = prev.artifacts.get(&a.mount_path).cloned();
            filter_artifact(a, &prev_ver, &mut skipped, &mut cleanup_paths)
        })
        .collect();
    // Detect removed artifacts: previous artifact mount_paths not in current manifest.
    let current_artifact_paths: std::collections::HashSet<&str> = manifest
        .artifacts
        .iter()
        .map(|a| a.mount_path.as_str())
        .collect();
    for prev_path in prev.artifacts.keys() {
        if !current_artifact_paths.contains(prev_path.as_str()) {
            cleanup_paths.push(prev_path.clone());
        }
    }
    if skipped > 0 {
        let total = manifest.storages.len() + manifest.artifacts.len();
        info!(skipped, total, "filtered unchanged storage entries");
    }

    if !cleanup_paths.is_empty() {
        info!(
            count = cleanup_paths.len(),
            "computed cleanup paths for stale file removal"
        );
    }

    GuestDownloadManifest {
        storages,
        artifacts,
        cleanup_paths,
    }
}

/// Download storage volumes into the guest.
fn guest_download_command() -> String {
    format!("{} {}", guest::DOWNLOAD_BIN, guest::STORAGE_MANIFEST)
}

fn guest_download_env(run_id: &str) -> [(&'static str, &str); 1] {
    [("VM0_RUN_ID", run_id)]
}

async fn download_storages(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: &GuestDownloadManifest,
) -> RunnerResult<()> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))?;
    sandbox
        .write_file(guest::STORAGE_MANIFEST, &manifest_json)
        .await?;

    let download_cmd = guest_download_command();
    let run_id = context.run_id.to_string();
    let download_env = guest_download_env(&run_id);
    info!(run_id = %context.run_id, "downloading storages");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &download_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &download_env,
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await?;

    if result.exit_code != 0 {
        return Err(RunnerError::Internal(format_guest_download_failure(
            &result,
        )));
    }
    Ok(())
}

fn format_guest_download_failure(result: &sandbox::ExecResult) -> String {
    format_guest_exec_failure("storage download", result)
}

fn format_guest_exec_failure(operation: &str, result: &sandbox::ExecResult) -> String {
    let mut message = format!("{operation} failed (exit code {})", result.exit_code);

    if let Some(stderr) =
        format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated)
    {
        message.push_str("; ");
        message.push_str(&stderr);
    }
    if let Some(stdout) =
        format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated)
    {
        message.push_str("; ");
        message.push_str(&stdout);
    }

    message
}

fn format_command_output_excerpt(
    label: &str,
    bytes: &[u8],
    sandbox_truncated: bool,
) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let omitted_prefix = bytes.len() > GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES;
    let excerpt_start = if omitted_prefix {
        bytes.len() - GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES
    } else {
        0
    };
    let excerpt_bytes = bytes.get(excerpt_start..)?;
    let excerpt = String::from_utf8_lossy(excerpt_bytes);
    let excerpt = redact_url_query_strings(excerpt.trim());
    if excerpt.is_empty() {
        return None;
    }

    let mut qualifiers = Vec::new();
    if omitted_prefix {
        qualifiers.push("last 8192 bytes");
    } else {
        qualifiers.push("captured");
    }
    if sandbox_truncated {
        qualifiers.push("sandbox-truncated");
    }

    Some(format!("{label} ({}): {excerpt}", qualifiers.join(", ")))
}

fn redact_url_query_strings(input: &str) -> String {
    input
        .split_whitespace()
        .map(redact_url_query_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_url_query_token(token: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some((prefix, candidate)) = token.split_once(scheme)
            && let Some((base_url, _)) = candidate.split_once('?')
        {
            return format!("{prefix}{scheme}{base_url}?<redacted>");
        }
    }

    token.to_owned()
}

/// Write CLI agent session history into the guest filesystem.
///
/// Dispatches on `cli_agent_type`:
/// - `claude-code` (or empty, the default) → plain `.jsonl` under `~/.claude/projects/-{project}/`.
/// - `codex` → plain `.jsonl` under `~/.codex/sessions/YYYY/MM/DD/`.
/// - anything else → skipped with a warning (forward-compatible with future agents).
async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    // Validate session_id to prevent path traversal (only allow alnum, dash, underscore).
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_session_id(&session.session_id) {
        return Err(RunnerError::Internal(format!(
            "invalid session_id: {}",
            session.session_id
        )));
    }

    match context.cli_agent_type.as_str() {
        "" | "claude-code" => restore_claude_session(sandbox, context, session).await,
        "codex" => restore_codex_session(sandbox, context, session).await,
        other => {
            warn!(
                run_id = %context.run_id,
                framework = %other,
                "skipping session restore for unknown framework"
            );
            Ok(())
        }
    }
}

/// Write a Claude Code session history file at `~/.claude/projects/-{project}/{id}.jsonl`.
async fn restore_claude_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    let project_name = context
        .working_dir
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("/home/user/.claude/projects/-{project_name}");
    let session_path = format!("{session_dir}/{}.jsonl", session.session_id);

    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;
    info!(run_id = %context.run_id, path = %session_path, "restored claude session history");
    Ok(())
}

/// Write a Codex session history file as plain JSONL at
/// `~/.codex/sessions/YYYY/MM/DD/{thread_id}.jsonl`.
///
/// The date partition uses today's UTC date — `codex exec resume` walks the
/// `sessions/` tree and resolves files by thread_id, so the partition is a
/// hint, not a lookup key.
async fn restore_codex_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    // Layout matches the real codex CLI (and `guest-mock-codex`):
    // `/home/user/.codex/sessions/YYYY/MM/DD/{thread_id}.jsonl`.
    let today = chrono::Utc::now().date_naive();
    let session_dir = format!(
        "/home/user/.codex/sessions/{}/{}/{}",
        today.format("%Y"),
        today.format("%m"),
        today.format("%d"),
    );
    let session_path = format!("{session_dir}/{}.jsonl", session.session_id);

    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;

    info!(
        run_id = %context.run_id,
        path = %session_path,
        bytes_in = session.session_history.len(),
        "restored codex session history",
    );
    Ok(())
}

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
///   2. scrub runner-owned keys from that copied user env
///   3. `user_timezone` TZ (unless `environment` already sets TZ)
///   4. System variables (VM0_*, secrets, etc.) — always win
fn build_env_json(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
) -> RunnerResult<HashMap<String, String>> {
    let host_env = HostEnv::from_process();
    build_env_json_with_host_env(context, api_url, sandbox_id, reuse_result, &host_env)
}

fn build_env_json_with_host_env(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let mut env = HashMap::new();

    // --- User-provided environment ---
    if let Some(user_env) = &context.environment {
        for (k, v) in user_env {
            env.insert(k.clone(), v.clone());
        }
    }
    scrub_runner_owned_env(&mut env);

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
    env.insert("VM0_SANDBOX_ID".into(), sandbox_id.into());
    env.insert(
        "VM0_SANDBOX_REUSE_RESULT".into(),
        reuse_result.as_wire().into(),
    );
    env.insert("VM0_PROMPT".into(), context.prompt.clone());
    if let Some(asp) = &context.append_system_prompt
        && !asp.is_empty()
    {
        env.insert("VM0_APPEND_SYSTEM_PROMPT".into(), asp.clone());
    }
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
        normalized_cli_agent_type(&context.cli_agent_type).into(),
    );

    // Vercel bypass
    if let Some(bypass) = &host_env.vercel_automation_bypass_secret {
        env.insert("VERCEL_PROTECTION_BYPASS".into(), bypass.clone());
    }

    // Artifacts config (multi-mount).
    //
    // Emit a single `VM0_ARTIFACTS` env var containing a JSON array of
    // `{name, mountPath, storageId, versionId}` objects. Guest-agent
    // parses this on startup and iterates the list when taking snapshots
    // at run end. The shape here must stay lockstep with guest-agent's
    // `ArtifactEnv` — the two ship as one unit via `include_bytes!`, and
    // `ArtifactEnv` deserializes strict (no `serde(default)`), so a
    // field drop here will panic the VM at startup instead of silently
    // producing empty strings.
    //
    // Empty-list case: do not set the env var at all (matches the prior
    // "unset = no artifact" convention).
    if let Some(manifest) = &context.storage_manifest
        && !manifest.artifacts.is_empty()
    {
        let payload: Vec<serde_json::Value> = manifest
            .artifacts
            .iter()
            .map(|a| {
                serde_json::json!({
                    "name": a.vas_storage_name,
                    "mountPath": a.mount_path,
                    "storageId": a.vas_storage_id,
                    "versionId": a.vas_version_id,
                })
            })
            .collect();
        // Serialization cannot fail — payload is a Vec of String-only JSON
        // objects. Use `.expect` to make the invariant explicit; falling
        // back to an empty string would silently produce a broken env.
        #[allow(clippy::expect_used)]
        let serialized = serde_json::to_string(&payload)
            .expect("VM0_ARTIFACTS payload must serialize (String-only Values)");
        env.insert("VM0_ARTIFACTS".into(), serialized);
    }

    // Resume session ID
    if let Some(session) = &context.resume_session {
        env.insert("VM0_RESUME_SESSION_ID".into(), session.session_id.clone());
    }

    // Note: Connector placeholder env vars (e.g., GITHUB_TOKEN=gho_CoffeeSafeLocal...)
    // are injected by the web API into `context.environment` directly.

    // Secret values (base64-encoded, comma-separated)
    // Always include the sandbox token so it gets redacted in logs.
    {
        use base64::Engine as _;
        let mut encoded: Vec<String> =
            vec![base64::engine::general_purpose::STANDARD.encode(&context.sandbox_token)];
        if let Some(secret_values) = &context.secret_values {
            encoded.extend(
                secret_values
                    .iter()
                    .map(|s| base64::engine::general_purpose::STANDARD.encode(s)),
            );
        }
        env.insert("VM0_SECRET_VALUES".into(), encoded.join(","));
    }

    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => insert_claude_code_env(&mut env, context, host_env)?,
        EffectiveCliFramework::Codex => insert_codex_env(&mut env, context, host_env),
    }

    // Feature flags (JSON-encoded map of flag name → enabled)
    if let Some(flags) = &context.feature_flags
        && !flags.is_empty()
        && let Ok(json) = serde_json::to_string(flags)
    {
        env.insert("VM0_FEATURE_FLAGS".into(), json);
    }

    Ok(env)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct HostEnv {
    vercel_automation_bypass_secret: Option<String>,
    use_mock_claude: Option<String>,
    use_mock_codex: Option<String>,
}

impl HostEnv {
    fn from_process() -> Self {
        Self {
            vercel_automation_bypass_secret: std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok(),
            use_mock_claude: std::env::var("USE_MOCK_CLAUDE").ok(),
            use_mock_codex: std::env::var("USE_MOCK_CODEX").ok(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EffectiveCliFramework {
    ClaudeCode,
    Codex,
}

fn effective_cli_framework(cli_agent_type: &str) -> EffectiveCliFramework {
    if normalized_cli_agent_type(cli_agent_type) == "codex" {
        EffectiveCliFramework::Codex
    } else {
        // Guest-agent currently falls back unknown CLI_AGENT_TYPE values to
        // Claude Code. Keep runner env gating aligned with that behavior.
        EffectiveCliFramework::ClaudeCode
    }
}

const RUNNER_OWNED_ENV_KEYS: &[&str] = &[
    "VM0_API_URL",
    "VM0_RUN_ID",
    "VM0_API_TOKEN",
    "VM0_SANDBOX_ID",
    "VM0_SANDBOX_REUSE_RESULT",
    "VM0_PROMPT",
    "VM0_APPEND_SYSTEM_PROMPT",
    "VM0_WORKING_DIR",
    "VM0_API_START_TIME",
    "CLI_AGENT_TYPE",
    "VM0_ARTIFACTS",
    "VM0_RESUME_SESSION_ID",
    "VM0_SECRET_VALUES",
    "VM0_FEATURE_FLAGS",
    RUNNER_CONCURRENCY_FACTOR_ENV,
    RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV,
    RUNNER_NET_TX_MIB_PER_SEC_ENV,
    "USE_MOCK_CLAUDE",
    "USE_MOCK_CODEX",
    "VM0_MOCK_CLAUDE_PATH",
    "VM0_MOCK_CODEX_PATH",
    "VERCEL_PROTECTION_BYPASS",
    "VM0_DISALLOWED_TOOLS",
    "VM0_TOOLS",
    "VM0_SETTINGS",
];

fn scrub_runner_owned_env(env: &mut HashMap<String, String>) {
    for key in RUNNER_OWNED_ENV_KEYS {
        env.remove(*key);
    }
}

fn insert_claude_code_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
) -> RunnerResult<()> {
    // Pass USE_MOCK_CLAUDE from host environment for testing
    // (skip if debugNoMockClaude is set in execution context)
    if let Some(val) = &host_env.use_mock_claude
        && !context.debug_no_mock_claude.unwrap_or(false)
    {
        env.insert("USE_MOCK_CLAUDE".into(), val.clone());
    }

    if let Some(tools) = &context.disallowed_tools
        && let Some(serialized) = serialize_claude_tool_env("VM0_DISALLOWED_TOOLS", tools)?
    {
        env.insert("VM0_DISALLOWED_TOOLS".into(), serialized);
    }

    if let Some(tools) = &context.tools
        && let Some(serialized) = serialize_claude_tool_env("VM0_TOOLS", tools)?
    {
        env.insert("VM0_TOOLS".into(), serialized);
    }

    // Settings JSON (passed directly as single string)
    if let Some(settings) = &context.settings
        && !settings.is_empty()
    {
        env.insert("VM0_SETTINGS".into(), settings.clone());
    }

    Ok(())
}

fn serialize_claude_tool_env(env_name: &str, tools: &[String]) -> RunnerResult<Option<String>> {
    if tools.is_empty() {
        return Ok(None);
    }

    validate_claude_tool_env_entries(env_name, tools).map_err(RunnerError::Internal)?;

    Ok(Some(tools.join(",")))
}

fn validate_claude_tool_env_entries(env_name: &str, tools: &[String]) -> Result<(), String> {
    for (index, tool) in tools.iter().enumerate() {
        if tool.trim().is_empty() {
            return Err(format!(
                "{env_name} entry at index {index} must not be empty"
            ));
        }
        if tool.contains(',') {
            return Err(format!(
                "{env_name} entry at index {index} must not contain commas"
            ));
        }
        if tool.trim_start().starts_with('-') {
            return Err(format!(
                "{env_name} entry at index {index} must not start with a hyphen"
            ));
        }
    }

    Ok(())
}

fn insert_codex_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
) {
    // Pass USE_MOCK_CODEX from host environment for testing
    // (skip if debugNoMockCodex is set in execution context).
    if let Some(val) = &host_env.use_mock_codex
        && !context.debug_no_mock_codex.unwrap_or(false)
    {
        env.insert("USE_MOCK_CODEX".into(), val.clone());
    }
}

fn normalized_cli_agent_type(cli_agent_type: &str) -> &str {
    if cli_agent_type.is_empty() {
        "claude-code"
    } else {
        cli_agent_type
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::HttpClientConfig;
    use crate::ids::RunId;
    use crate::types::{
        GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry, ResumeSession,
    };
    use api_contracts::generated::types::runners::storage::{
        ArtifactEntry, StorageEntry, StorageManifest,
    };
    use async_trait::async_trait;
    use sandbox_mock::MockSandboxFactory;
    use std::collections::BTreeMap;
    use std::fmt;
    use std::sync::{Arc, Mutex};
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Subscriber};
    use tracing_subscriber::layer::{Context, Layer};
    use tracing_subscriber::prelude::*;

    const RUN_IN_SANDBOX_TEST_TIMEOUT: Duration = Duration::from_secs(5);

    #[derive(Clone, Debug)]
    struct CapturedEvent {
        level: Level,
        fields: BTreeMap<String, String>,
    }

    #[derive(Clone, Default)]
    struct CapturedEvents {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl CapturedEvents {
        fn entries(&self) -> Vec<CapturedEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl<S> Layer<S> for CapturedEvents
    where
        S: Subscriber,
    {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = CapturedFields::default();
            event.record(&mut visitor);
            self.events.lock().unwrap().push(CapturedEvent {
                level: *event.metadata().level(),
                fields: visitor.fields,
            });
        }
    }

    #[derive(Default)]
    struct CapturedFields {
        fields: BTreeMap<String, String>,
    }

    impl Visit for CapturedFields {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_i64(&mut self, field: &Field, value: i64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_u64(&mut self, field: &Field, value: u64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
            self.fields
                .insert(field.name().to_string(), format!("{value:?}"));
        }
    }

    fn api_storage(name: &str, mount_path: &str, version: &str, archive_url: &str) -> StorageEntry {
        StorageEntry {
            name: name.into(),
            mount_path: mount_path.into(),
            archive_url: archive_url.into(),
            vas_storage_name: name.into(),
            vas_version_id: version.into(),
            instructions_target_filename: None,
        }
    }

    fn api_artifact(
        name: &str,
        mount_path: &str,
        storage_id: &str,
        version: &str,
        archive_url: &str,
    ) -> ArtifactEntry {
        ArtifactEntry {
            mount_path: mount_path.into(),
            archive_url: archive_url.into(),
            vas_storage_name: name.into(),
            vas_storage_id: storage_id.into(),
            vas_version_id: version.into(),
            manifest_url: None,
        }
    }

    struct DestroyPanicFactory {
        inner: MockSandboxFactory,
    }

    #[async_trait]
    impl SandboxFactory for DestroyPanicFactory {
        fn name(&self) -> &str {
            "destroy-panic"
        }

        fn config_hash(&self) -> String {
            "destroy-panic".into()
        }

        async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
            self.inner.create(config).await
        }

        #[allow(clippy::panic)]
        async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
            panic!("simulated destroy panic");
        }

        async fn shutdown(&mut self) {
            self.inner.shutdown().await;
        }
    }

    fn build_env_for_test(ctx: &ExecutionContext, api_url: &str) -> HashMap<String, String> {
        build_env_for_test_result(ctx, api_url).expect("test env should build")
    }

    fn build_env_for_test_result(
        ctx: &ExecutionContext,
        api_url: &str,
    ) -> RunnerResult<HashMap<String, String>> {
        build_env_for_test_with_host_env_result(ctx, api_url, &HostEnv::default())
    }

    fn build_env_for_test_with_host_env(
        ctx: &ExecutionContext,
        api_url: &str,
        host_env: &HostEnv,
    ) -> HashMap<String, String> {
        build_env_for_test_with_host_env_result(ctx, api_url, host_env)
            .expect("test env should build")
    }

    fn build_env_for_test_with_host_env_result(
        ctx: &ExecutionContext,
        api_url: &str,
        host_env: &HostEnv,
    ) -> RunnerResult<HashMap<String, String>> {
        let sid = SandboxId::new_v4().to_string();
        build_env_json_with_host_env(ctx, api_url, &sid, SandboxReuseResult::Reused, host_env)
    }

    fn minimal_context() -> ExecutionContext {
        ExecutionContext {
            run_id: RunId::nil(),
            prompt: "test prompt".into(),
            append_system_prompt: None,
            _agent_compose_version_id: None,
            vars: None,
            checkpoint_id: None,
            sandbox_token: "tok".into(),
            working_dir: "/workspace".into(),
            storage_manifest: None,
            environment: None,
            resume_session: None,
            secret_values: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            cli_agent_type: String::new(),
            debug_no_mock_claude: None,
            debug_no_mock_codex: None,
            api_start_time: None,
            user_timezone: None,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            disallowed_tools: None,
            tools: None,
            settings: None,
            experimental_profile: None,
            feature_flags: None,
            billable_firewalls: vec![],
            model_usage_provider: None,
        }
    }

    fn context_with_env(environment: HashMap<String, String>) -> ExecutionContext {
        let mut ctx = minimal_context();
        ctx.environment = Some(environment);
        ctx
    }

    #[test]
    fn model_provider_env_placeholder_validation_accepts_env_without_protected_keys() {
        let ctx = context_with_env(HashMap::from([("PROJECT_ID".into(), "vm0".into())]));

        assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
    }

    #[test]
    fn model_provider_env_placeholder_validation_accepts_anthropic_api_key_placeholder() {
        let ctx = context_with_env(HashMap::from([(
            "ANTHROPIC_API_KEY".into(),
            model_provider_placeholders::ANTHROPIC_API_KEY.into(),
        )]));

        assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
    }

    #[test]
    fn model_provider_env_placeholder_validation_rejects_real_anthropic_api_key() {
        let secret = "sk-ant-api03-real-secret-value";
        let ctx = context_with_env(HashMap::from([("ANTHROPIC_API_KEY".into(), secret.into())]));

        let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

        assert!(error.contains("ANTHROPIC_API_KEY"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn model_provider_env_placeholder_validation_accepts_empty_anthropic_api_key_with_auth_token() {
        let ctx = context_with_env(HashMap::from([
            ("ANTHROPIC_API_KEY".into(), String::new()),
            (
                "ANTHROPIC_AUTH_TOKEN".into(),
                model_provider_placeholders::ANTHROPIC_AUTH_TOKEN.into(),
            ),
        ]));

        assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
    }

    #[test]
    fn model_provider_env_placeholder_validation_rejects_real_anthropic_auth_token() {
        let secret = "sk-real-openrouter-token";
        let ctx = context_with_env(HashMap::from([(
            "ANTHROPIC_AUTH_TOKEN".into(),
            secret.into(),
        )]));

        let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

        assert!(error.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn model_provider_env_placeholder_validation_accepts_claude_oauth_placeholder() {
        let ctx = context_with_env(HashMap::from([(
            "CLAUDE_CODE_OAUTH_TOKEN".into(),
            model_provider_placeholders::CLAUDE_CODE_OAUTH_TOKEN.into(),
        )]));

        assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
    }

    #[test]
    fn model_provider_env_placeholder_validation_accepts_openai_api_key_placeholder() {
        let ctx = context_with_env(HashMap::from([(
            "OPENAI_API_KEY".into(),
            model_provider_placeholders::OPENAI_API_KEY.into(),
        )]));

        assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
    }

    #[test]
    fn model_provider_env_placeholder_validation_rejects_real_openai_api_key() {
        let secret = "sk-proj-real-openai-secret";
        let ctx = context_with_env(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

        let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

        assert!(error.contains("OPENAI_API_KEY"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn model_provider_env_placeholder_validation_accepts_codex_oauth_placeholders() {
        let ctx = context_with_env(HashMap::from([
            (
                "CHATGPT_ACCESS_TOKEN".into(),
                model_provider_placeholders::CHATGPT_ACCESS_TOKEN.into(),
            ),
            (
                "CHATGPT_ACCOUNT_ID".into(),
                model_provider_placeholders::CHATGPT_ACCOUNT_ID.into(),
            ),
            (
                "CHATGPT_REFRESH_TOKEN".into(),
                model_provider_placeholders::CHATGPT_REFRESH_TOKEN.into(),
            ),
        ]));

        assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
    }

    #[test]
    fn model_provider_env_placeholder_validation_rejects_real_chatgpt_access_token() {
        let secret = "ey-real-chatgpt-access-token";
        let ctx = context_with_env(HashMap::from([(
            "CHATGPT_ACCESS_TOKEN".into(),
            secret.into(),
        )]));

        let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

        assert!(error.contains("CHATGPT_ACCESS_TOKEN"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn model_provider_env_placeholder_validation_rejects_real_chatgpt_refresh_token() {
        let secret = "rt_real_chatgpt_refresh_token";
        let ctx = context_with_env(HashMap::from([(
            "CHATGPT_REFRESH_TOKEN".into(),
            secret.into(),
        )]));

        let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

        assert!(error.contains("CHATGPT_REFRESH_TOKEN"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn model_provider_env_placeholder_validation_rejects_chatgpt_id_token() {
        let secret = "hdr.real-chatgpt-id-token.sig";
        let ctx = context_with_env(HashMap::from([("CHATGPT_ID_TOKEN".into(), secret.into())]));

        let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

        assert!(error.contains("CHATGPT_ID_TOKEN"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn build_env_json_required_keys() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "https://api.example.com");

        assert_eq!(env.get("VM0_API_URL").unwrap(), "https://api.example.com");
        assert_eq!(env.get("VM0_RUN_ID").unwrap(), &RunId::nil().to_string());
        assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("VM0_WORKING_DIR").unwrap(), "/workspace");
        // Guest-agent needs these to post /complete with full metadata when
        // checkpoint lands before VM teardown.
        assert!(
            env.get("VM0_SANDBOX_ID")
                .unwrap()
                .parse::<uuid::Uuid>()
                .is_ok()
        );
        assert_eq!(env.get("VM0_SANDBOX_REUSE_RESULT").unwrap(), "reused");
    }

    #[test]
    fn build_env_json_sandbox_reuse_result_wire_format() {
        let ctx = minimal_context();
        let sid = SandboxId::new_v4().to_string();
        for (variant, expected) in [
            (SandboxReuseResult::Reused, "reused"),
            (SandboxReuseResult::NoSessionId, "noSessionId"),
            (SandboxReuseResult::PoolMiss, "poolMiss"),
            (SandboxReuseResult::ProfileMismatch, "profileMismatch"),
            (
                SandboxReuseResult::DeviceLimitMismatch,
                "deviceLimitMismatch",
            ),
            (SandboxReuseResult::UnparkFailed, "unparkFailed"),
        ] {
            let env = build_env_json_with_host_env(
                &ctx,
                "http://localhost",
                &sid,
                variant,
                &HostEnv::default(),
            )
            .expect("test env should build");
            assert_eq!(env.get("VM0_SANDBOX_REUSE_RESULT").unwrap(), expected);
        }
    }

    #[test]
    fn build_env_json_empty_cli_agent_type_defaults_to_claude_code() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "claude-code");
    }

    #[test]
    fn build_env_json_custom_cli_agent_type() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "custom-agent".into();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
    }

    #[test]
    fn build_env_json_claude_code_gets_only_claude_framework_env() {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
        ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
        ctx.settings = Some(r#"{"hooks":{}}"#.into());

        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_claude: Some("true".into()),
                use_mock_codex: Some("1".into()),
                ..HostEnv::default()
            },
        );

        assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
        assert_eq!(
            env.get("VM0_DISALLOWED_TOOLS").unwrap(),
            "CronCreate,CronDelete"
        );
        assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash,Edit");
        assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
        assert!(!env.contains_key("USE_MOCK_CODEX"));
    }

    #[test]
    fn build_env_json_codex_gets_only_codex_framework_env() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
        ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
        ctx.settings = Some(r#"{"hooks":{}}"#.into());

        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_claude: Some("true".into()),
                use_mock_codex: Some("1".into()),
                ..HostEnv::default()
            },
        );

        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
        assert_eq!(env.get("USE_MOCK_CODEX").unwrap(), "1");
        assert!(!env.contains_key("USE_MOCK_CLAUDE"));
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
        assert!(!env.contains_key("VM0_TOOLS"));
        assert!(!env.contains_key("VM0_SETTINGS"));
    }

    #[test]
    fn build_env_json_unknown_framework_preserves_claude_compatible_env() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "custom-agent".into();
        ctx.disallowed_tools = Some(vec!["CronCreate".into()]);
        ctx.tools = Some(vec!["Bash".into()]);
        ctx.settings = Some(r#"{"hooks":{}}"#.into());

        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_claude: Some("true".into()),
                use_mock_codex: Some("1".into()),
                ..HostEnv::default()
            },
        );

        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
        assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
        assert_eq!(env.get("VM0_DISALLOWED_TOOLS").unwrap(), "CronCreate");
        assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash");
        assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
        assert!(!env.contains_key("USE_MOCK_CODEX"));
    }

    #[test]
    fn build_env_json_scrubs_user_provided_runner_owned_env() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.environment = Some(HashMap::from([
            ("CUSTOM_ENV".into(), "kept".into()),
            ("VM0_PROMPT".into(), "user prompt".into()),
            ("VM0_API_TOKEN".into(), "stolen".into()),
            ("VM0_FEATURE_FLAGS".into(), r#"{"bad":true}"#.into()),
            (RUNNER_CONCURRENCY_FACTOR_ENV.into(), "99".into()),
            (RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV.into(), "999".into()),
            (RUNNER_DISK_IOPS_ENV.into(), "999".into()),
            (RUNNER_NET_RX_MIB_PER_SEC_ENV.into(), "999".into()),
            (RUNNER_NET_TX_MIB_PER_SEC_ENV.into(), "999".into()),
            ("CLI_AGENT_TYPE".into(), "claude-code".into()),
            ("USE_MOCK_CLAUDE".into(), "true".into()),
            ("USE_MOCK_CODEX".into(), "1".into()),
            ("VERCEL_PROTECTION_BYPASS".into(), "user-bypass".into()),
            ("VM0_DISALLOWED_TOOLS".into(), "CronCreate".into()),
            ("VM0_TOOLS".into(), "Bash".into()),
            ("VM0_SETTINGS".into(), r#"{"hooks":{}}"#.into()),
            ("VM0_MOCK_CLAUDE_PATH".into(), "/tmp/mock-claude".into()),
            ("VM0_MOCK_CODEX_PATH".into(), "/tmp/mock-codex".into()),
        ]));

        let env = build_env_for_test(&ctx, "http://localhost");

        assert_eq!(env.get("CUSTOM_ENV").unwrap(), "kept");
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
        assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
        assert!(!env.contains_key(RUNNER_CONCURRENCY_FACTOR_ENV));
        assert!(!env.contains_key(RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV));
        assert!(!env.contains_key(RUNNER_DISK_IOPS_ENV));
        assert!(!env.contains_key(RUNNER_NET_RX_MIB_PER_SEC_ENV));
        assert!(!env.contains_key(RUNNER_NET_TX_MIB_PER_SEC_ENV));
        assert!(!env.contains_key("USE_MOCK_CLAUDE"));
        assert!(!env.contains_key("USE_MOCK_CODEX"));
        assert!(!env.contains_key("VERCEL_PROTECTION_BYPASS"));
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
        assert!(!env.contains_key("VM0_TOOLS"));
        assert!(!env.contains_key("VM0_SETTINGS"));
        assert!(!env.contains_key("VM0_MOCK_CLAUDE_PATH"));
        assert!(!env.contains_key("VM0_MOCK_CODEX_PATH"));
    }

    #[test]
    fn build_env_json_preserves_guest_agent_tuning_env() {
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([
            ("VM0_STUCK_TOOL_TIMEOUT_SECS".into(), "3".into()),
            ("VM0_POST_RESULT_SIGTERM_GRACE_SECS".into(), "1".into()),
            ("VM0_POST_RESULT_SIGKILL_GRACE_SECS".into(), "2".into()),
        ]));

        let env = build_env_for_test(&ctx, "http://localhost");

        assert_eq!(env.get("VM0_STUCK_TOOL_TIMEOUT_SECS").unwrap(), "3");
        assert_eq!(env.get("VM0_POST_RESULT_SIGTERM_GRACE_SECS").unwrap(), "1");
        assert_eq!(env.get("VM0_POST_RESULT_SIGKILL_GRACE_SECS").unwrap(), "2");
    }

    #[test]
    fn build_env_json_codex_keeps_shared_runner_env() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.append_system_prompt = Some("Use terse answers.".into());
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-123".into(),
            session_history: "{}".into(),
        });

        let env = build_env_for_test(&ctx, "http://localhost");

        assert_eq!(
            env.get("VM0_APPEND_SYSTEM_PROMPT").unwrap(),
            "Use terse answers."
        );
        assert_eq!(env.get("VM0_RESUME_SESSION_ID").unwrap(), "sess-123");
        assert_eq!(env.get("VM0_WORKING_DIR").unwrap(), "/workspace");
    }

    #[test]
    fn build_env_json_with_single_artifact() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![api_storage(
                "data",
                "/data",
                "v1",
                "https://example.com/data.tar.gz",
            )],
            artifacts: vec![api_artifact(
                "my-vol",
                "/artifacts",
                "sid-1",
                "v1",
                "https://example.com/artifacts.tar.gz",
            )],
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        let raw = env.get("VM0_ARTIFACTS").expect("VM0_ARTIFACTS must be set");
        let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["name"], "my-vol");
        assert_eq!(parsed[0]["mountPath"], "/artifacts");
        assert_eq!(parsed[0]["storageId"], "sid-1");
        assert_eq!(parsed[0]["versionId"], "v1");
        // Legacy singleton env vars must no longer be emitted.
        assert!(!env.contains_key("VM0_ARTIFACT_DRIVER"));
        assert!(!env.contains_key("VM0_ARTIFACT_MOUNT_PATH"));
        assert!(!env.contains_key("VM0_ARTIFACT_VOLUME_NAME"));
        assert!(!env.contains_key("VM0_ARTIFACT_VERSION_ID"));
    }

    #[test]
    fn build_env_json_with_two_artifacts() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![],
            artifacts: vec![
                api_artifact(
                    "art-a",
                    "/workspace",
                    "sid-a",
                    "v1",
                    "https://example.com/art-a.tar.gz",
                ),
                api_artifact(
                    "art-b",
                    "/data",
                    "sid-b",
                    "v2",
                    "https://example.com/art-b.tar.gz",
                ),
            ],
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        let raw = env.get("VM0_ARTIFACTS").unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["name"], "art-a");
        assert_eq!(parsed[0]["mountPath"], "/workspace");
        assert_eq!(parsed[0]["storageId"], "sid-a");
        assert_eq!(parsed[1]["name"], "art-b");
        assert_eq!(parsed[1]["mountPath"], "/data");
        assert_eq!(parsed[1]["storageId"], "sid-b");
    }

    #[test]
    fn build_env_json_empty_artifacts_emits_no_env_var() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![],
            artifacts: vec![],
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_ARTIFACTS"));
    }

    #[test]
    fn build_env_json_with_secrets() {
        let mut ctx = minimal_context();
        ctx.secret_values = Some(vec!["secret1".into(), "secret2".into()]);

        let env = build_env_for_test(&ctx, "http://localhost");
        let val = env.get("VM0_SECRET_VALUES").unwrap();

        use base64::Engine as _;
        let parts: Vec<&str> = val.split(',').collect();
        // sandbox_token ("tok") + secret1 + secret2
        assert_eq!(parts.len(), 3);
        let decoded0 = base64::engine::general_purpose::STANDARD
            .decode(parts[0])
            .unwrap();
        assert_eq!(decoded0, b"tok");
        let decoded1 = base64::engine::general_purpose::STANDARD
            .decode(parts[1])
            .unwrap();
        assert_eq!(decoded1, b"secret1");
    }

    #[test]
    fn build_env_json_with_resume_session() {
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-123".into(),
            session_history: "{}".into(),
        });

        let env = build_env_for_test(&ctx, "http://localhost");
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

        let env = build_env_for_test(&ctx, "http://localhost");
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

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("MY_VAR").unwrap(), "123");
        assert_eq!(env.get("OTHER").unwrap(), "abc");
    }

    #[test]
    fn build_env_json_with_api_start_time() {
        let mut ctx = minimal_context();
        ctx.api_start_time = Some(1_700_000_000_500);

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_API_START_TIME").unwrap(), "1700000000500");
    }

    #[test]
    fn elapsed_since_api_start_ms_returns_elapsed_duration() {
        let duration = elapsed_since_api_start_ms(1_700_000_000_000, 1_700_000_001_250);

        assert_eq!(duration, Some(Duration::from_millis(1_250)));
    }

    #[test]
    fn elapsed_since_api_start_ms_clamps_future_start_to_zero() {
        let duration = elapsed_since_api_start_ms(1_700_000_001_250, 1_700_000_000_000);

        assert_eq!(duration, Some(Duration::ZERO));
    }

    #[test]
    fn elapsed_since_api_start_ms_rejects_seconds_shaped_start() {
        let duration = elapsed_since_api_start_ms(1_700_000_000, 1_700_000_001_250);

        assert_eq!(duration, None);
    }

    #[test]
    fn build_env_json_empty_secrets_still_has_sandbox_token() {
        let mut ctx = minimal_context();
        ctx.secret_values = Some(vec![]);

        let env = build_env_for_test(&ctx, "http://localhost");
        // VM0_SECRET_VALUES always present because sandbox_token is included
        let val = env.get("VM0_SECRET_VALUES").unwrap();
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(val)
            .unwrap();
        assert_eq!(decoded, b"tok");
    }

    #[test]
    fn build_env_json_with_append_system_prompt() {
        let mut ctx = minimal_context();
        ctx.append_system_prompt = Some("Your name is Aria.".into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(
            env.get("VM0_APPEND_SYSTEM_PROMPT").unwrap(),
            "Your name is Aria."
        );
    }

    #[test]
    fn build_env_json_without_append_system_prompt() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    }

    #[test]
    fn build_env_json_empty_append_system_prompt_omitted() {
        let mut ctx = minimal_context();
        ctx.append_system_prompt = Some("".into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    }

    #[test]
    fn build_env_json_with_user_timezone() {
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("Asia/Shanghai".into());

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("TZ").unwrap(), "Asia/Shanghai");
    }

    #[test]
    fn build_env_json_user_timezone_not_override_environment() {
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("Asia/Shanghai".into());
        ctx.environment = Some(HashMap::from([("TZ".into(), "America/New_York".into())]));

        let env = build_env_for_test(&ctx, "http://localhost");
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

        let env = build_env_for_test(&ctx, "http://localhost");
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

        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("ONLY_VARS"));
        assert_eq!(env.get("ONLY_ENV").unwrap(), "env-value");
    }

    #[test]
    fn build_env_json_with_mock_claude() {
        let ctx = minimal_context();
        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_claude: Some("true".into()),
                ..HostEnv::default()
            },
        );
        assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
        assert!(!env.contains_key("USE_MOCK_CODEX"));
    }

    #[test]
    fn build_env_json_mock_claude_suppressed_by_debug_flag() {
        let mut ctx = minimal_context();
        ctx.debug_no_mock_claude = Some(true);
        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_claude: Some("true".into()),
                ..HostEnv::default()
            },
        );
        assert!(!env.contains_key("USE_MOCK_CLAUDE"));
    }

    #[test]
    fn build_env_json_with_mock_codex() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_codex: Some("1".into()),
                ..HostEnv::default()
            },
        );
        assert_eq!(env.get("USE_MOCK_CODEX").unwrap(), "1");
        assert!(!env.contains_key("USE_MOCK_CLAUDE"));
    }

    #[test]
    fn build_env_json_mock_codex_suppressed_by_debug_flag() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.debug_no_mock_codex = Some(true);
        let env = build_env_for_test_with_host_env(
            &ctx,
            "http://localhost",
            &HostEnv {
                use_mock_codex: Some("1".into()),
                ..HostEnv::default()
            },
        );
        assert!(!env.contains_key("USE_MOCK_CODEX"));
    }

    #[test]
    fn build_env_json_does_not_inject_vm0_token() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_TOKEN"));
    }

    #[test]
    fn execution_context_deserializes_with_firewalls() {
        let json = serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "test",
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "cliAgentType": "claude-code",
            "billableFirewalls": [],
            "firewalls": [{
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {
                        "headers": {
                            "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
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
        let svcs = ctx.firewalls.unwrap();
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].name, "github");
        assert_eq!(svcs[0].apis.len(), 1);
        assert_eq!(svcs[0].apis[0].base, "https://api.github.com");
        let perms = svcs[0].apis[0].permissions.as_ref().unwrap();
        assert_eq!(perms.len(), 1);
        assert_eq!(perms[0].name, "issues-read");
        assert_eq!(perms[0].rules.len(), 2);
        assert_eq!(perms[0].rules[0], "GET /repos/{owner}/{repo}/issues");
    }

    #[test]
    fn execution_context_deserializes_without_firewalls() {
        let json = serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "test",
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "cliAgentType": "claude-code",
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert!(ctx.firewalls.is_none());
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

    /// Real `sudo dmesg | grep 'oom-kill'` output captured from prod-3.
    const PROD3_OOM_GREP: &str = "\
        [1718300.650867] fc_vcpu 0 invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0\n\
        [1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=vm0-runner-v0.45.6.service,mems_allowed=0,oom_memcg=/system.slice/vm0-runner-v0.45.6.service,task_memcg=/system.slice/vm0-runner-v0.45.6.service,task=firecracker,pid=586629,uid=1000";

    #[test]
    fn host_oom_matches_real_prod3_output() {
        assert!(host_dmesg_indicates_oom(PROD3_OOM_GREP, 586629));
    }

    #[test]
    fn host_oom_no_match_different_pid() {
        assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 12345));
    }

    #[test]
    fn host_oom_no_match_different_process() {
        // Same structure as prod-3 but task=node instead of task=firecracker
        let dmesg = "[1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,\
            task=node,pid=586629,uid=1000";
        assert!(!host_dmesg_indicates_oom(dmesg, 586629));
    }

    #[test]
    fn host_oom_no_match_empty() {
        assert!(!host_dmesg_indicates_oom("", 12345));
    }

    #[test]
    fn host_oom_no_match_without_oom_kill() {
        // Has the PID pattern but no oom-kill keyword
        let dmesg = "[1718300.651117] task=firecracker,pid=12345,uid=1000 started";
        assert!(!host_dmesg_indicates_oom(dmesg, 12345));
    }

    #[test]
    fn host_oom_no_prefix_match() {
        // pid=58662 must NOT match pid=586629
        assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 58662));
    }

    #[test]
    fn host_oom_pid_at_end_of_line() {
        // PID at end of string (no trailing comma) — edge case
        let dmesg = "[0.0] oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";
        assert!(host_dmesg_indicates_oom(dmesg, 42));
        assert!(!host_dmesg_indicates_oom(dmesg, 4));
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

    #[test]
    fn build_env_json_with_disallowed_tools() {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(
            env.get("VM0_DISALLOWED_TOOLS").unwrap(),
            "CronCreate,CronDelete"
        );
    }

    #[test]
    fn build_env_json_empty_disallowed_tools_omitted() {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec![]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    }

    #[test]
    fn build_env_json_no_disallowed_tools() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    }

    #[test]
    fn build_env_json_with_tools() {
        let mut ctx = minimal_context();
        ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash,Edit");
    }

    #[test]
    fn build_env_json_empty_tools_omitted() {
        let mut ctx = minimal_context();
        ctx.tools = Some(vec![]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_TOOLS"));
    }

    #[test]
    fn build_env_json_no_tools() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_TOOLS"));
    }

    fn assert_tool_env_error(
        result: RunnerResult<HashMap<String, String>>,
        env_name: &str,
        expected: &str,
    ) {
        let message = match result {
            Err(RunnerError::Internal(message)) => message,
            other => panic!("expected internal error, got {other:?}"),
        };
        assert!(message.contains(env_name), "message: {message}");
        assert!(message.contains(expected), "message: {message}");
    }

    #[test]
    fn build_env_json_rejects_invalid_disallowed_tools_entries() {
        for (tool, expected) in [
            ("", "must not be empty"),
            ("   ", "must not be empty"),
            ("CronCreate,CronDelete", "must not contain commas"),
            ("--help", "must not start with a hyphen"),
            (" -v", "must not start with a hyphen"),
        ] {
            let mut ctx = minimal_context();
            ctx.disallowed_tools = Some(vec![tool.into()]);
            let result = build_env_for_test_result(&ctx, "http://localhost");
            assert_tool_env_error(result, "VM0_DISALLOWED_TOOLS", expected);
        }
    }

    #[test]
    fn build_env_json_rejects_invalid_tools_entries() {
        for (tool, expected) in [
            ("", "must not be empty"),
            ("   ", "must not be empty"),
            ("Bash,Read", "must not contain commas"),
            ("--help", "must not start with a hyphen"),
            (" -x", "must not start with a hyphen"),
        ] {
            let mut ctx = minimal_context();
            ctx.tools = Some(vec![tool.into()]);
            let result = build_env_for_test_result(&ctx, "http://localhost");
            assert_tool_env_error(result, "VM0_TOOLS", expected);
        }
    }

    #[test]
    fn build_env_json_codex_ignores_claude_tool_lists() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.disallowed_tools = Some(vec!["".into()]);
        ctx.tools = Some(vec!["Bash,Read".into()]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
        assert!(!env.contains_key("VM0_TOOLS"));
    }

    #[test]
    fn build_env_json_with_settings() {
        let mut ctx = minimal_context();
        ctx.settings = Some(r#"{"hooks":{}}"#.into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
    }

    #[test]
    fn build_env_json_empty_settings_omitted() {
        let mut ctx = minimal_context();
        ctx.settings = Some("".into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_SETTINGS"));
    }

    #[test]
    fn build_env_json_no_settings() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_SETTINGS"));
    }

    #[test]
    fn build_env_json_with_feature_flags() {
        let mut ctx = minimal_context();
        let mut flags = HashMap::new();
        flags.insert("computerUse".into(), true);
        flags.insert("audioOutput".into(), false);
        ctx.feature_flags = Some(flags);
        let env = build_env_for_test(&ctx, "http://localhost");
        let raw = env
            .get("VM0_FEATURE_FLAGS")
            .expect("VM0_FEATURE_FLAGS should be set");
        let parsed: HashMap<String, bool> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.get("computerUse"), Some(&true));
        assert_eq!(parsed.get("audioOutput"), Some(&false));
    }

    #[test]
    fn build_env_json_empty_feature_flags_omitted() {
        let mut ctx = minimal_context();
        ctx.feature_flags = Some(HashMap::new());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
    }

    #[test]
    fn build_env_json_no_feature_flags() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
    }

    // -----------------------------------------------------------------------
    // Sandbox-interacting function tests (using sandbox-mock)
    // -----------------------------------------------------------------------

    use sandbox::{
        ExecResult, ProcessExit, ProcessOutputChunk, SandboxError, SandboxInitializationPhase,
        SandboxOperation, SandboxOperationReason,
    };
    use sandbox_mock::MockSandbox;

    fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
    }

    fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
    }

    fn sandbox_create_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: message.into(),
        }
    }

    #[tokio::test]
    async fn fix_guest_clock_calls_date_command() {
        let sandbox = MockSandbox::new("test");
        // Default mock returns exit 0 — clock fix should succeed.
        fix_guest_clock(&sandbox).await.unwrap();
    }

    #[tokio::test]
    async fn fix_guest_clock_propagates_exec_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Err(sandbox_exec_error("timeout")));
        let result = fix_guest_clock(&sandbox).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fix_guest_clock_fails_on_nonzero_exit() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(ExecResult::new(
            2,
            b"date stdout".to_vec(),
            b"date stderr".to_vec(),
        )));

        let result = fix_guest_clock(&sandbox).await;

        let message = result.unwrap_err().to_string();
        assert!(
            message.contains("guest clock sync failed (exit code 2)"),
            "got: {message}"
        );
        assert!(
            message.contains("stderr (captured): date stderr"),
            "got: {message}"
        );
        assert!(
            message.contains("stdout (captured): date stdout"),
            "got: {message}"
        );
    }

    #[tokio::test]
    async fn reseed_guest_entropy_succeeds() {
        let sandbox = MockSandbox::new("test");
        reseed_guest_entropy(&sandbox).await.unwrap();

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].cmd, "guest-reseed");
        assert!(calls[0].sudo);
        let stdin_bytes = calls[0].stdin_bytes.as_ref().unwrap();
        assert_eq!(stdin_bytes.len(), 256);
    }

    #[tokio::test]
    async fn reseed_guest_entropy_propagates_exec_error() {
        let sandbox = MockSandbox::new("test");
        // Sandbox-level failure (vsock connection issue).
        sandbox.push_exec_result(Err(sandbox_exec_error("reseed failed")));
        let result = reseed_guest_entropy(&sandbox).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn reseed_guest_entropy_fails_on_nonzero_exit() {
        let sandbox = MockSandbox::new("test");
        // guest-reseed exits with code 1 (e.g., ioctl failed).
        sandbox.push_exec_result(Ok(ExecResult::new(
            1,
            Vec::new(),
            b"RNDRESEEDCRNG failed: Operation not permitted".to_vec(),
        )));
        let result = reseed_guest_entropy(&sandbox).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("guest-reseed failed"), "got: {msg}");
    }

    #[tokio::test]
    async fn sync_guest_timezone_accepts_common_timezone_name_shapes() {
        for tz in [
            "UTC",
            "Etc/GMT+1",
            "Etc/GMT-14",
            "America/Argentina/Buenos_Aires",
        ] {
            let sandbox = MockSandbox::new("test");
            let mut ctx = minimal_context();
            ctx.user_timezone = Some(tz.into());

            sync_guest_timezone(&sandbox, &ctx).await;

            let calls = sandbox.exec_calls();
            assert_eq!(calls.len(), 1, "timezone {tz:?} should call guest exec");
            assert!(
                calls[0]
                    .cmd
                    .starts_with(&format!("if test -f /usr/share/zoneinfo/{tz}; then ")),
                "unexpected timezone command: {}",
                calls[0].cmd
            );
            assert!(
                calls[0]
                    .cmd
                    .contains(&format!("echo '{tz}' > /etc/timezone")),
                "unexpected timezone command: {}",
                calls[0].cmd
            );
            assert!(
                calls[0]
                    .cmd
                    .contains(&format!("echo 'TZ={tz}' >> /etc/environment")),
                "unexpected timezone command: {}",
                calls[0].cmd
            );
            assert!(calls[0].cmd.ends_with(" fi"));
        }
    }

    #[tokio::test]
    async fn sync_guest_timezone_skips_when_none() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        sync_guest_timezone(&sandbox, &ctx).await;

        assert!(sandbox.exec_calls().is_empty());
    }

    #[tokio::test]
    async fn sync_guest_timezone_rejects_invalid_timezone_names() {
        for invalid_tz in [
            "$(rm -rf /)",
            "../UTC",
            "Etc/../UTC",
            "America/New York",
            "UTC;id",
            "UTC'",
        ] {
            let sandbox = MockSandbox::new("test");
            let mut ctx = minimal_context();
            ctx.user_timezone = Some(invalid_tz.into());

            sync_guest_timezone(&sandbox, &ctx).await;

            assert!(
                sandbox.exec_calls().is_empty(),
                "timezone {invalid_tz:?} should be rejected before guest exec"
            );
        }
    }

    #[tokio::test]
    async fn sync_guest_timezone_empty_string_skips() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(String::new());
        sync_guest_timezone(&sandbox, &ctx).await;

        assert!(sandbox.exec_calls().is_empty());
    }

    async fn capture_sync_guest_timezone_events(
        sandbox: &dyn Sandbox,
        ctx: &ExecutionContext,
    ) -> Vec<CapturedEvent> {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let _guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();

        sync_guest_timezone(sandbox, ctx).await;

        captured.entries()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sync_guest_timezone_logs_nonzero_exit() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(ExecResult::new(
            2,
            b"timezone stdout".to_vec(),
            b"timezone stderr".to_vec(),
        )));
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("America/New_York".into());

        let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;
        let event = events
            .iter()
            .find(|event| {
                event.level == Level::WARN
                    && event.fields.get("message").map(String::as_str)
                        == Some("failed to set guest timezone")
            })
            .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
        let run_id = RunId::nil().to_string();
        assert_eq!(
            event.fields.get("run_id").map(String::as_str),
            Some(run_id.as_str())
        );
        assert_eq!(
            event.fields.get("tz").map(String::as_str),
            Some("America/New_York")
        );
        assert_eq!(event.fields.get("exit_code").map(String::as_str), Some("2"));
        assert!(
            event
                .fields
                .get("stderr_excerpt")
                .is_some_and(|value| value.contains("timezone stderr")),
            "event={event:#?}"
        );
        assert!(
            event
                .fields
                .get("stdout_excerpt")
                .is_some_and(|value| value.contains("timezone stdout")),
            "event={event:#?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sync_guest_timezone_logs_exec_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Err(sandbox_exec_error("vsock disconnected")));
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("America/New_York".into());

        let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;

        let event = events
            .iter()
            .find(|event| {
                event.level == Level::WARN
                    && event.fields.get("message").map(String::as_str)
                        == Some("failed to set guest timezone")
            })
            .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
        let run_id = RunId::nil().to_string();
        assert_eq!(
            event.fields.get("run_id").map(String::as_str),
            Some(run_id.as_str())
        );
        assert_eq!(
            event.fields.get("tz").map(String::as_str),
            Some("America/New_York")
        );
        assert!(
            event
                .fields
                .get("error")
                .is_some_and(|value| value.contains("vsock disconnected")),
            "event={event:#?}"
        );
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_content() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(Some(b"checkpoint error: disk full".to_vec())));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert_eq!(msg.as_deref(), Some("checkpoint error: disk full"));
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_none_on_missing_file() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(None));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_none_on_empty_content() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(Some(b"   \n  ".to_vec())));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_none_on_exec_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Err(sandbox_exec_error("vsock timeout")));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_valid_diagnostic() {
        let sandbox = MockSandbox::new("test");
        let diagnostic = FailureDiagnostic::new(
            agent_diagnostics::FailureClass::CliNonzero,
            agent_diagnostics::AgentFramework::ClaudeCode,
            agent_diagnostics::PromptMetadata::from_prompt("/help"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(agent_diagnostics::FailureDetailSource::ClaudeResult)
        .with_session_history_status(agent_diagnostics::SessionHistoryStatus::Present);
        sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

        let read = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert_eq!(read, Some(diagnostic));
        let calls = sandbox.read_file_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].path,
            agent_diagnostics::failure_diagnostic_file(&RunId::nil().to_string())
        );
        assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_none_on_missing_file() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(None));

        let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert!(diagnostic.is_none());
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_none_on_empty_content() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(Some(b" \n\t".to_vec())));

        let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert!(diagnostic.is_none());
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_none_on_malformed_json() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(Some(b"{not-json".to_vec())));

        let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert!(diagnostic.is_none());
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_none_on_unsupported_schema() {
        let sandbox = MockSandbox::new("test");
        let mut diagnostic = FailureDiagnostic::new(
            agent_diagnostics::FailureClass::CliNonzero,
            agent_diagnostics::AgentFramework::ClaudeCode,
            agent_diagnostics::PromptMetadata::from_prompt("/help"),
        );
        diagnostic.schema_version = FAILURE_DIAGNOSTIC_SCHEMA_VERSION + 1;
        sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

        let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert!(diagnostic.is_none());
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_none_on_read_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Err(sandbox_exec_error("vsock timeout")));

        let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert!(diagnostic.is_none());
    }

    #[tokio::test]
    async fn read_guest_failure_diagnostic_file_returns_none_on_oversized_content() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_read_file_result(Ok(Some(vec![
            b' ';
            SMALL_GUEST_FILE_MAX_BYTES as usize + 1
        ])));

        let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

        assert!(diagnostic.is_none());
    }

    #[tokio::test]
    async fn download_storages_success() {
        let sandbox = MockSandbox::new("test");
        // write_file succeeds by default, exec returns exit 0 by default.
        let ctx = minimal_context();
        let manifest = GuestDownloadManifest {
            storages: vec![guest_storage(
                "/data",
                "data",
                "v1",
                Some("https://s3/archive.tar.gz"),
            )],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        download_storages(&sandbox, &ctx, &manifest).await.unwrap();
    }

    #[test]
    fn guest_download_command_uses_guest_common_system_log_without_shell_redirect() {
        let cmd = guest_download_command();

        assert_eq!(
            cmd,
            "/usr/local/bin/guest-download /tmp/storage-manifest.json"
        );
        assert!(!cmd.contains(">>"));
        assert!(!cmd.contains("2>&1"));
        assert!(!cmd.contains("--system-log"));
    }

    #[test]
    fn guest_download_env_includes_run_id_for_guest_common_logs() {
        let ctx = minimal_context();
        let run_id = ctx.run_id.to_string();
        let env = guest_download_env(&run_id);

        assert_eq!(env[0].0, "VM0_RUN_ID");
        assert_eq!(env[0].1, run_id);
    }

    #[tokio::test]
    async fn download_storages_nonzero_exit_code() {
        let sandbox = MockSandbox::new("test");
        // write_file succeeds, but exec returns non-zero.
        sandbox.push_exec_result(Ok(ExecResult::new(
            1,
            b"stdout clue".to_vec(),
            b"[2026-05-20T18:03:00Z] [ERROR] [sandbox:guest-download] storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false download failed: Failed to read archive entries: invalid gzip header".to_vec(),
        )));
        let ctx = minimal_context();
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let err = download_storages(&sandbox, &ctx, &manifest)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("storage download failed (exit code 1)"));
        assert!(msg.contains("stderr (captured)"));
        assert!(msg.contains("mountPath=/workspace"));
        assert!(msg.contains("vasStorageName=repo"));
        assert!(msg.contains("Failed to read archive entries"));
        assert!(msg.contains("stdout (captured): stdout clue"));
    }

    #[test]
    fn guest_download_failure_output_redacts_url_queries() {
        let result = ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"HTTP transport error for archiveUrl=https://storage.example/archive.tar.gz?X-Amz-Signature=secret"
                .to_vec(),
            stdout_truncated: false,
            stderr_truncated: true,
        };

        let msg = format_guest_download_failure(&result);

        assert!(msg.contains("stderr (captured, sandbox-truncated)"));
        assert!(msg.contains("archiveUrl=https://storage.example/archive.tar.gz?<redacted>"));
        assert!(!msg.contains("secret"));
    }

    #[tokio::test]
    async fn restore_session_writes_history() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "claude-code".into();
        let session = ResumeSession {
            session_id: "sess-abc-123".into(),
            session_history: r#"{"type":"init"}"#.into(),
        };
        restore_session(&sandbox, &ctx, &session).await.unwrap();
    }

    #[tokio::test]
    async fn restore_session_rejects_invalid_session_id() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        let session = ResumeSession {
            session_id: "../../etc/passwd".into(),
            session_history: "data".into(),
        };
        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
        assert!(err.to_string().contains("invalid session_id"));
    }

    #[tokio::test]
    async fn restore_session_skips_unknown_framework() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "custom-agent".into();
        let session = ResumeSession {
            session_id: "sess-1".into(),
            session_history: "data".into(),
        };
        // Unknown frameworks must no-op silently (warn-and-skip) so a typo in
        // CLI_AGENT_TYPE does not block the run. Pushing an exec error detects
        // any accidental fallthrough into either framework's restore path.
        sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
        restore_session(&sandbox, &ctx, &session).await.unwrap();
    }

    #[tokio::test]
    async fn restore_session_allows_empty_agent_type() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = String::new(); // empty defaults to claude-code
        let session = ResumeSession {
            session_id: "sess-1".into(),
            session_history: "{}".into(),
        };
        // Should proceed (empty agent type treated as claude-code).
        restore_session(&sandbox, &ctx, &session).await.unwrap();
    }

    #[tokio::test]
    async fn restore_session_writes_codex_session() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        let session = ResumeSession {
            session_id: "01jzm-thread-id".into(),
            session_history: "{\"type\":\"thread.started\"}\n".into(),
        };
        restore_session(&sandbox, &ctx, &session).await.unwrap();
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert!(
            writes[0].path.ends_with("/01jzm-thread-id.jsonl"),
            "codex resume history must be restored as plain jsonl, got {}",
            writes[0].path
        );
        assert_eq!(writes[0].content, session.session_history.as_bytes());
    }

    #[tokio::test]
    async fn restore_session_rejects_invalid_codex_session_id() {
        // Path-traversal validation runs before framework dispatch, so codex
        // shares the same allow-list as claude-code.
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        let session = ResumeSession {
            session_id: "../../etc/passwd".into(),
            session_history: "{}".into(),
        };
        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
        assert!(err.to_string().contains("invalid session_id"));
    }

    #[tokio::test]
    async fn build_env_json_with_memory_as_artifact() {
        // Post-#10602: memory rides in VM0_ARTIFACTS, not VM0_MEMORY_*.
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![],
            artifacts: vec![api_artifact(
                "memory",
                "/memory",
                "",
                "v2",
                "https://example.com/memory.tar.gz",
            )],
        });
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_MEMORY_DRIVER"));
        assert!(!env.contains_key("VM0_MEMORY_MOUNT_PATH"));
        assert!(!env.contains_key("VM0_MEMORY_NAME"));
        assert!(!env.contains_key("VM0_MEMORY_VERSION_ID"));
        let artifacts = env.get("VM0_ARTIFACTS").unwrap();
        assert!(artifacts.contains("\"memory\""));
        assert!(artifacts.contains("\"/memory\""));
        assert!(artifacts.contains("\"v2\""));
    }

    // -----------------------------------------------------------------------
    // copy_guest_logs tests
    // -----------------------------------------------------------------------

    #[test]
    fn guest_log_copy_failure_kind_tracks_cancellation() {
        assert_eq!(
            guest_log_copy_failure_kind(false),
            GuestLogCopyFailureKind::Failed
        );
        assert_eq!(
            guest_log_copy_failure_kind(true),
            GuestLogCopyFailureKind::SkippedAfterCancellation
        );
    }

    #[tokio::test]
    async fn copy_guest_logs_writes_files_to_host() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        tokio::fs::write(
            log_paths.system_log(ctx.run_id),
            b"transient host-streamed stdout\n",
        )
        .await
        .unwrap();

        // Queue guest-copy results: system log + metrics log + sandbox ops log.
        sandbox.push_copy_file_result(Ok(b"system log line 1\nsystem log line 2\n".to_vec()));
        sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));
        sandbox.push_copy_file_result(Ok(
            b"{\"action_type\":\"final_telemetry_upload\",\"duration_ms\":10,\"success\":true}\n"
                .to_vec(),
        ));

        copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

        let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(system_log, "system log line 1\nsystem log line 2\n");
        assert!(!system_log.contains("transient host-streamed stdout"));

        let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(metrics_log, "{\"cpu\":0.5}\n");

        let sandbox_ops_log = tokio::fs::read_to_string(log_paths.sandbox_ops_log(ctx.run_id))
            .await
            .unwrap();
        assert!(sandbox_ops_log.contains("final_telemetry_upload"));

        let calls = sandbox.copy_file_calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(
            calls[2].path,
            format!("/tmp/vm0-sandbox-ops-{}.jsonl", ctx.run_id)
        );
        assert_eq!(calls[2].host_path, log_paths.sandbox_ops_log(ctx.run_id));
        assert_eq!(calls[0].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
        assert_eq!(calls[1].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
        assert_eq!(calls[2].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    }

    #[tokio::test]
    async fn copy_guest_logs_keeps_existing_logs_when_sandbox_ops_missing() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        sandbox.push_copy_file_result(Ok(b"system log\n".to_vec()));
        sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));

        copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

        let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(system_log, "system log\n");

        let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(metrics_log, "{\"cpu\":0.5}\n");
        assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());

        let calls = sandbox.copy_file_calls();
        assert_eq!(calls.len(), 3);
        assert!(
            calls[2].missing_ok,
            "missing sandbox ops log should be a best-effort no-op"
        );
    }

    #[tokio::test]
    async fn copy_guest_logs_skips_on_nonzero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        // Copy fails (file doesn't exist in guest).
        sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));
        sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));
        sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));

        copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

        // Host files should not be created
        assert!(!log_paths.system_log(ctx.run_id).exists());
        assert!(!log_paths.metrics_log(ctx.run_id).exists());
        assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());
    }

    #[tokio::test]
    async fn copy_guest_logs_skips_on_exec_error() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));
        sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));
        sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));

        copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

        assert!(!log_paths.system_log(ctx.run_id).exists());
        assert!(!log_paths.metrics_log(ctx.run_id).exists());
        assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());
    }

    #[tokio::test]
    async fn post_job_cleanup_appends_stream_markers_after_guest_log_copy() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        let system_log_path = config.log_paths.system_log(ctx.run_id);

        tokio::fs::write(&system_log_path, b"transient host-streamed stdout\n")
            .await
            .unwrap();
        sandbox.push_copy_file_result(Ok(b"guest system log".to_vec()));

        post_job_cleanup(
            &sandbox,
            &config,
            &ctx,
            "10.0.0.1",
            false,
            AgentStdoutStreamDiagnostics {
                chunk_truncated: true,
                stream_overflowed: true,
            },
        )
        .await;

        let system_log = tokio::fs::read(&system_log_path).await.unwrap();
        let mut expected = b"guest system log\n".to_vec();
        expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
        expected.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
        assert_eq!(system_log, expected);
    }

    // -----------------------------------------------------------------------
    // drain_stdout_to_file tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn drain_stdout_writes_chunks_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");

        let (tx, rx) = tokio::sync::mpsc::channel(2);
        tx.send(ProcessOutputChunk {
            bytes: b"chunk 1\n".to_vec(),
            truncated: false,
        })
        .await
        .unwrap();
        tx.send(ProcessOutputChunk {
            bytes: b"chunk 2\n".to_vec(),
            truncated: false,
        })
        .await
        .unwrap();
        drop(tx); // close channel

        let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(content, "chunk 1\nchunk 2\n");
        assert!(!report.chunk_truncated);
    }

    #[tokio::test]
    async fn drain_stdout_reports_truncated_chunk_without_changing_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");

        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tx.send(ProcessOutputChunk {
            bytes: b"partial chunk".to_vec(),
            truncated: true,
        })
        .await
        .unwrap();
        drop(tx);

        let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

        let content = tokio::fs::read(&path).await.unwrap();
        assert_eq!(content, b"partial chunk");
        assert!(report.chunk_truncated);
    }

    #[tokio::test]
    async fn drain_stdout_empty_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.log");

        let (_tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
        drop(_tx);

        let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(content.is_empty());
        assert!(!report.chunk_truncated);
    }

    #[tokio::test]
    async fn drain_stdout_invalid_path_returns_error() {
        let (_tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
        drop(_tx);
        let error = drain_stdout_to_file(rx, PathBuf::from("/dev/null/impossible/file"))
            .await
            .unwrap_err();
        assert!(matches!(error, StdoutDrainError::Open { .. }));
    }

    #[tokio::test]
    async fn append_stdout_stream_diagnostics_noops_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");

        append_stdout_stream_diagnostics(&path, AgentStdoutStreamDiagnostics::default())
            .await
            .unwrap();

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn append_stdout_stream_diagnostics_writes_markers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");
        tokio::fs::write(&path, b"guest system log without newline")
            .await
            .unwrap();

        append_stdout_stream_diagnostics(
            &path,
            AgentStdoutStreamDiagnostics {
                chunk_truncated: true,
                stream_overflowed: true,
            },
        )
        .await
        .unwrap();

        let content = tokio::fs::read(&path).await.unwrap();
        let mut expected = b"guest system log without newline\n".to_vec();
        expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
        expected.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
        assert_eq!(content, expected);
    }

    // -----------------------------------------------------------------------
    // write_file failure tests (using push_write_file_result)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn download_storages_fails_on_write_file_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
        let ctx = minimal_context();
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let err = download_storages(&sandbox, &ctx, &manifest)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("vsock write failed"), "got: {err}");
    }

    #[tokio::test]
    async fn restore_session_fails_on_write_file_error() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        let session = ResumeSession {
            session_id: "sess-abc".into(),
            session_history: r#"{"type":"init"}"#.into(),
        };
        sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));
        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
        assert!(err.to_string().contains("disk full"), "got: {err}");
    }

    // -----------------------------------------------------------------------
    // execute_new_sandbox integration tests (MockSandboxFactory + real filesystem)
    // -----------------------------------------------------------------------

    /// Build a real `ExecutorConfig` backed by tempdir files.
    async fn test_executor_config(dir: &std::path::Path) -> ExecutorConfig {
        let registry_path = dir.join("proxy-registry.json");
        let lock_path = dir.join("proxy-registry.json.lock");
        tokio::fs::write(&registry_path, r#"{"vms":{},"updatedAt":0}"#)
            .await
            .unwrap();
        let log_dir = dir.join("logs");
        tokio::fs::create_dir_all(&log_dir).await.unwrap();

        ExecutorConfig {
            api_url: "http://localhost:9999".into(),
            registry: proxy::ProxyRegistryHandle::new(registry_path, lock_path),
            http: crate::http::HttpClient::new(HttpClientConfig {
                api_url: "http://localhost:9999".into(),
                vercel_bypass: None,
            })
            .unwrap(),
            log_paths: LogPaths::new(log_dir),
            network_log_manager: NetworkLogManager::new(),
            network_log_drain: NetworkLogDrainCoordinator::noop(),
            home: HomePaths::with_root(dir.to_path_buf()),
        }
    }

    fn default_params() -> JobParams {
        JobParams {
            vcpu: 2,
            memory_mb: 2048,
            restore_guest_state: false,
            device_rate_limits: None,
        }
    }

    fn test_device_rate_limits() -> sandbox::DeviceRateLimits {
        sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 100 * 1024 * 1024,
                ops_per_sec: 10_000,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 50 * 1024 * 1024,
                tx_bytes_per_sec: 25 * 1024 * 1024,
            },
        }
    }

    fn test_budget_lease() -> crate::resource_budget::BudgetLease {
        let budget = Arc::new(crate::resource_budget::ResourceBudget::new(1, 1, 1.0, 0));
        crate::resource_budget::ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap()
    }

    async fn make_reusable_idle_sandbox(
        sandbox: Box<dyn Sandbox>,
        source_ip: String,
        session_id: &str,
    ) -> (ReusableIdleSandbox, crate::resource_budget::BudgetLease) {
        use crate::idle_pool::{
            IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult, ParkedIdleCandidate,
            SyntheticParkedIdleCandidateParts,
        };

        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox,
                factory: std::sync::Arc::new(
                    Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
                ),
                session_id: session_id.into(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default".into(),
                device_rate_limits: None,
                budget_lease: test_budget_lease(),
                source_ip,
                storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
            });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let entry = pool.take(session_id).expect("idle entry should exist");
        match entry.try_unpark().await {
            IdleUnparkResult::Reused {
                sandbox,
                budget_lease,
            } => (sandbox, budget_lease),
            IdleUnparkResult::Failed { error, .. } => {
                panic!("test idle entry should unpark: {error}");
            }
        }
    }

    fn test_telemetry(config: &ExecutorConfig, ctx: &ExecutionContext) -> JobTelemetry {
        crate::telemetry::JobTelemetry::new(
            config.http.clone(),
            ctx.run_id,
            ctx.sandbox_token.clone(),
        )
    }

    async fn assert_proxy_registry_empty(dir: &std::path::Path) {
        let raw = tokio::fs::read_to_string(dir.join("proxy-registry.json"))
            .await
            .unwrap();
        let registry: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            registry["vms"].as_object().map(|vms| vms.len()),
            Some(0),
            "proxy registry should not retain a VM after executor cleanup: {registry}",
        );
        assert!(
            registry["updatedAt"]
                .as_i64()
                .is_some_and(|updated_at| updated_at > 0),
            "proxy registry should record a cleanup mutation: {registry}",
        );
    }

    struct CancelAfterWaitSandbox {
        inner: Box<dyn Sandbox>,
        cancel: tokio_util::sync::CancellationToken,
    }

    #[async_trait]
    impl Sandbox for CancelAfterWaitSandbox {
        fn id(&self) -> &str {
            self.inner.id()
        }

        fn source_ip(&self) -> &str {
            self.inner.source_ip()
        }

        fn process_pid(&self) -> Option<u32> {
            self.inner.process_pid()
        }

        async fn start(&mut self) -> sandbox::Result<()> {
            self.inner.start().await
        }

        async fn stop(&mut self) -> sandbox::Result<()> {
            self.inner.stop().await
        }

        async fn kill(&mut self) -> sandbox::Result<()> {
            self.inner.kill().await
        }

        async fn park(&mut self) -> sandbox::Result<()> {
            self.inner.park().await
        }

        async fn unpark(&mut self) -> sandbox::Result<()> {
            self.inner.unpark().await
        }

        async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
            self.inner.exec(request).await
        }

        async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
            self.inner.read_file(path, max_bytes).await
        }

        async fn copy_file(
            &self,
            path: &str,
            host_path: &std::path::Path,
            options: CopyFileOptions,
        ) -> sandbox::Result<sandbox::CopyFileResult> {
            self.inner.copy_file(path, host_path, options).await
        }

        async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
            self.inner.write_file(path, content).await
        }

        async fn start_process(
            &self,
            request: &StartProcessRequest<'_>,
        ) -> sandbox::Result<sandbox::GuestProcessHandle> {
            self.inner.start_process(request).await
        }

        async fn wait_process(
            &self,
            handle: sandbox::GuestProcessHandle,
            timeout: Duration,
        ) -> sandbox::Result<ProcessExit> {
            let result = self.inner.wait_process(handle, timeout).await;
            self.cancel.cancel();
            result
        }
    }

    async fn run_execute_inner(
        factory: &MockSandboxFactory,
        ctx: &ExecutionContext,
        config: &ExecutorConfig,
        params: &JobParams,
    ) -> RunnerResult<(i32, Option<String>)> {
        let mut telemetry = test_telemetry(config, ctx);
        let cancel = tokio_util::sync::CancellationToken::new();
        let outcome = execute_new_sandbox(
            factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            config,
            params,
            &mut telemetry,
            cancel,
        )
        .await?;
        Ok((outcome.exit_code(), outcome.error().map(ToOwned::to_owned)))
    }

    async fn create_overridden_sandbox(
        overrides: Arc<sandbox_mock::MockSandboxOverrides>,
    ) -> Box<dyn Sandbox> {
        sandbox_mock::MockSandboxFactory::with_overrides(overrides)
            .create(SandboxConfig {
                id: SandboxId::new_v4(),
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 2048,
                },
                device_rate_limits: None,
            })
            .await
            .unwrap()
    }

    fn spawn_run_in_sandbox_test(
        sandbox: Box<dyn Sandbox>,
        ctx: ExecutionContext,
        config: ExecutorConfig,
        cancel: tokio_util::sync::CancellationToken,
    ) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
        spawn_run_in_sandbox_test_with_timeouts(
            sandbox,
            ctx,
            config,
            cancel,
            PROCESS_CANCEL_TIMEOUTS,
        )
    }

    fn spawn_run_in_sandbox_test_with_timeouts(
        sandbox: Box<dyn Sandbox>,
        ctx: ExecutionContext,
        config: ExecutorConfig,
        cancel: tokio_util::sync::CancellationToken,
        process_cancel_timeouts: ProcessCancelTimeouts,
    ) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
        tokio::spawn(async move {
            let mut telemetry = test_telemetry(&config, &ctx);
            run_in_sandbox_with_process_cancel_timeouts(
                &*sandbox,
                &ctx,
                &config,
                RunStart {
                    restore_guest_state: false,
                    reuse_result: SandboxReuseResult::PoolMiss,
                    prev_storage: None,
                },
                &mut telemetry,
                cancel,
                process_cancel_timeouts,
            )
            .await
        })
    }

    #[tokio::test]
    async fn run_in_sandbox_preserves_wait_result_when_cancel_arrives_after_wait() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
            bytes: b"partial stdout".to_vec(),
            truncated: true,
        }]);
        let cancel = tokio_util::sync::CancellationToken::new();
        let factory = MockSandboxFactory::with_overrides(overrides);
        let sandbox = CancelAfterWaitSandbox {
            inner: factory
                .create(SandboxConfig {
                    id: SandboxId::new_v4(),
                    resources: sandbox::ResourceLimits {
                        cpu_count: 2,
                        memory_mb: 2048,
                    },
                    device_rate_limits: None,
                })
                .await
                .unwrap(),
            cancel: cancel.clone(),
        };
        let ctx = minimal_context();
        let mut telemetry = test_telemetry(&config, &ctx);

        let result = run_in_sandbox(
            &sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            cancel.clone(),
        )
        .await
        .unwrap();

        assert!(cancel.is_cancelled());
        assert!(result.failure.is_none());
        assert_eq!(
            result.stdout_stream_diagnostics,
            AgentStdoutStreamDiagnostics {
                chunk_truncated: true,
                stream_overflowed: false,
            }
        );
    }

    #[tokio::test]
    async fn run_in_sandbox_cancels_guest_process_and_waits_for_terminal_status() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
            Arc::clone(&wait_gate),
        ));
        overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
            bytes: b"partial stdout".to_vec(),
            truncated: true,
        }]);
        let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
        exit.stream_overflowed = true;
        overrides.push_wait_process_exit(exit);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
        cancel.cancel();

        assert!(
            overrides
                .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
                .await
        );

        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert_eq!(
            overrides.process_cancel_calls().as_slice(),
            [sandbox_mock::ProcessCancelCall {
                timeout: PROCESS_CANCEL_WRITE_TIMEOUT
            }]
        );
        assert_eq!(
            result.failure.as_ref().map(|failure| failure.exit_code),
            Some(EXIT_SIGKILL)
        );
        assert_eq!(
            result.stdout_stream_diagnostics,
            AgentStdoutStreamDiagnostics {
                chunk_truncated: true,
                stream_overflowed: true,
            }
        );
    }

    #[tokio::test]
    async fn run_in_sandbox_returns_cancelled_when_cancel_handle_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
            wait_gate,
        ));
        overrides.set_process_cancel_supported(false);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
        cancel.cancel();

        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert!(overrides.process_cancel_calls().is_empty());
        assert_eq!(
            result.failure.as_ref().map(|failure| failure.exit_code),
            Some(EXIT_SIGKILL)
        );
    }

    #[tokio::test]
    async fn run_in_sandbox_returns_cancelled_when_process_cancel_send_fails() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
            wait_gate,
        ));
        overrides.push_process_cancel_error("cancel write failed");
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
        cancel.cancel();

        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert_eq!(
            overrides.process_cancel_calls().as_slice(),
            [sandbox_mock::ProcessCancelCall {
                timeout: PROCESS_CANCEL_WRITE_TIMEOUT
            }]
        );
        assert_eq!(
            result.failure.as_ref().map(|failure| failure.exit_code),
            Some(EXIT_SIGKILL)
        );
    }

    #[tokio::test]
    async fn run_in_sandbox_returns_cancelled_when_wait_fails_after_process_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let mut overrides = sandbox_mock::MockSandboxOverrides::with_wait_process_gate(wait_gate);
        overrides.set_wait_process_error("wait failed after cancel");
        let overrides = Arc::new(overrides);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
        cancel.cancel();

        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert_eq!(
            overrides.process_cancel_calls().as_slice(),
            [sandbox_mock::ProcessCancelCall {
                timeout: PROCESS_CANCEL_WRITE_TIMEOUT
            }]
        );
        assert_eq!(
            result.failure.as_ref().map(|failure| failure.exit_code),
            Some(EXIT_SIGKILL)
        );
    }

    #[tokio::test]
    async fn run_in_sandbox_returns_cancelled_when_terminal_grace_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
            wait_gate,
        ));
        overrides.set_process_cancel_releases_wait_gate(false);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run_task = spawn_run_in_sandbox_test_with_timeouts(
            sandbox,
            ctx,
            config,
            cancel.clone(),
            ProcessCancelTimeouts {
                write: PROCESS_CANCEL_WRITE_TIMEOUT,
                terminal_grace: Duration::ZERO,
            },
        );
        cancel.cancel();

        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert_eq!(
            overrides.process_cancel_calls().as_slice(),
            [sandbox_mock::ProcessCancelCall {
                timeout: PROCESS_CANCEL_WRITE_TIMEOUT
            }]
        );
        assert_eq!(
            result.failure.as_ref().map(|failure| failure.exit_code),
            Some(EXIT_SIGKILL)
        );
    }

    #[tokio::test]
    async fn execute_inner_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let (exit_code, error_msg) =
            run_execute_inner(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();
        assert_eq!(exit_code, 0);
        assert!(error_msg.is_none());
        assert_proxy_registry_empty(dir.path()).await;
    }

    #[tokio::test]
    async fn execute_inner_appends_stream_overflow_marker() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
        exit.stream_overflowed = true;
        overrides.push_wait_process_exit(exit);
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let system_log_path = config.log_paths.system_log(ctx.run_id);

        let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();

        assert_eq!(exit_code, 0);
        assert!(error_msg.is_none());
        let system_log = tokio::fs::read(&system_log_path).await.unwrap();
        assert_eq!(system_log, STDOUT_STREAM_OVERFLOW_MARKER);
    }

    #[tokio::test]
    async fn execute_inner_appends_stream_limit_marker() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
            bytes: b"partial stdout".to_vec(),
            truncated: true,
        }]);
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let system_log_path = config.log_paths.system_log(ctx.run_id);

        let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();

        assert_eq!(exit_code, 0);
        assert!(error_msg.is_none());
        let system_log = tokio::fs::read(&system_log_path).await.unwrap();
        let mut expected = b"partial stdout\n".to_vec();
        expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
        assert_eq!(system_log, expected);
    }

    #[tokio::test]
    async fn execute_inner_appends_stream_limit_marker_after_oom_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
            bytes: b"partial stdout".to_vec(),
            truncated: true,
        }]);
        overrides.push_wait_process_exit(ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new()));
        overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: "dmesg".to_string(),
            exit_code: 0,
            stdout: b"Out of memory: Killed process 1234".to_vec(),
            stderr: Vec::new(),
        });
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let system_log_path = config.log_paths.system_log(ctx.run_id);

        let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();

        assert_eq!(exit_code, 1);
        assert_eq!(
            error_msg.as_deref(),
            Some("Agent process killed by OOM killer")
        );
        let system_log = tokio::fs::read(&system_log_path).await.unwrap();
        let mut expected = b"partial stdout\n".to_vec();
        expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
        assert_eq!(system_log, expected);
    }

    #[tokio::test]
    async fn execute_inner_passes_device_rate_limits_to_sandbox_create() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let limits = test_device_rate_limits();
        let params = JobParams {
            device_rate_limits: Some(limits.clone()),
            ..default_params()
        };

        let (exit_code, error_msg) =
            run_execute_inner(&factory, &minimal_context(), &config, &params)
                .await
                .unwrap();

        assert_eq!(exit_code, 0);
        assert!(error_msg.is_none());
        let configs = overrides.create_configs();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].device_rate_limits, Some(limits));
    }

    #[tokio::test]
    async fn execute_inner_launches_agent_stream_only_without_guest_log_tee() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides.clone());

        let (exit_code, error_msg) =
            run_execute_inner(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();
        assert_eq!(exit_code, 0);
        assert!(error_msg.is_none());

        let calls = overrides.start_process_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].output, ProcessOutputMode::stream());
        assert_eq!(calls[0].control, ProcessControlMode::Enabled);
    }

    #[tokio::test]
    async fn execute_inner_with_snapshot_runs_clock_fix_and_reseed() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let params = JobParams {
            restore_guest_state: true,
            ..default_params()
        };
        let (exit_code, _) = run_execute_inner(&factory, &minimal_context(), &config, &params)
            .await
            .unwrap();
        assert_eq!(exit_code, 0);
    }

    #[tokio::test]
    async fn execute_inner_with_storage_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![api_storage(
                "data",
                "/data",
                "v1",
                "https://example.com/data.tar.gz",
            )],
            artifacts: vec![],
        });
        let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(exit_code, 0);
    }

    #[tokio::test]
    async fn execute_inner_with_resume_session() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-abc-123".into(),
            session_history: r#"{"type":"init"}"#.into(),
        });
        let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(exit_code, 0);
    }

    #[tokio::test]
    async fn execute_inner_create_failure_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();
        factory.push_create_result(Err(sandbox_create_error("no free devices")));

        let err = run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no free devices"), "got: {err}");
    }

    #[tokio::test]
    async fn execute_inner_aborts_drain_task_on_wait_process_error() {
        // Simulate wait_process timeout: stdout channel stays open (sender held
        // alive by MockSandbox), wait_process returns error.
        // Without the fix, task.await blocks forever → test times out.
        // With the fix, task is aborted immediately → test completes.
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_error(
            "wait timeout",
        ));
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let mut telemetry = test_telemetry(&config, &ctx);

        let outcome = execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.exit_code(), 1);
        let error = outcome.error().unwrap();
        assert!(error.contains("wait timeout"), "got: {error}");
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on post-start execution failure"
        );
        assert!(
            outcome.network_log_session.is_some(),
            "network log session must be returned on post-start execution failure"
        );
        assert_proxy_registry_empty(dir.path()).await;
    }

    #[tokio::test]
    async fn execute_inner_nonzero_without_guest_error_returns_failure_message() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
            7,
        ));
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);

        let (exit_code, error) =
            run_execute_inner(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();

        assert_eq!(exit_code, 7);
        assert_eq!(error.as_deref(), Some("Agent exited with code 7"));
    }

    #[tokio::test]
    async fn execute_inner_nonzero_records_agent_execute_error() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
            7,
        ));
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let mut telemetry = test_telemetry(&config, &ctx);
        let cancel = tokio_util::sync::CancellationToken::new();

        let outcome = execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            &mut telemetry,
            cancel,
        )
        .await
        .unwrap();

        assert_eq!(outcome.exit_code(), 7);
        let ops = telemetry.pending_ops_snapshot();
        let agent_execute = ops
            .iter()
            .find(|op| op.0 == "agent_execute")
            .expect("agent_execute telemetry should be recorded");
        assert!(!agent_execute.1);
        assert_eq!(agent_execute.2.as_deref(), Some("Agent exited with code 7"));
    }

    #[tokio::test]
    async fn execute_inner_start_failure_destroy_panic_returns_start_error() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_result(Err(SandboxError::Start {
            message: "boot failed".into(),
        }));
        let factory = DestroyPanicFactory {
            inner: MockSandboxFactory::with_overrides(overrides),
        };

        let ctx = minimal_context();
        let mut telemetry = test_telemetry(&config, &ctx);
        let cancel = tokio_util::sync::CancellationToken::new();
        let result = execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            &mut telemetry,
            cancel,
        )
        .await;

        assert!(result.is_err(), "start failure must return an error");
        let err = result.err().unwrap();
        assert!(err.to_string().contains("boot failed"), "got: {err}");
        assert_proxy_registry_empty(dir.path()).await;
        assert!(
            !config
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-start-failure.test"})
                )
                .await,
            "start failure should close inline network-log attribution",
        );
    }

    #[tokio::test]
    async fn execute_job_wraps_execute_inner() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code(), 0);
        assert!(outcome.error().is_none());
        assert!(outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn execute_job_create_failure_returns_exit_1() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();
        factory.push_create_result(Err(sandbox_create_error("boom")));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code(), 1);
        assert!(outcome.error().unwrap().contains("boom"));
        assert!(outcome.sandbox.is_none());
    }

    #[tokio::test]
    async fn execute_job_model_provider_env_validation_failure_returns_run_failure() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let secret = "sk-proj-real-openai-secret";
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        assert_eq!(outcome.exit_code(), 1);
        let error = outcome.error().unwrap();
        assert!(error.contains("OPENAI_API_KEY"));
        assert!(!error.contains(secret));
        assert!(outcome.sandbox.is_none());
        assert!(
            overrides.create_configs().is_empty(),
            "fresh sandbox must not be created after env validation failure"
        );
    }

    #[tokio::test]
    async fn execute_job_claude_tool_validation_failure_skips_sandbox_create() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut ctx = minimal_context();
        ctx.tools = Some(vec!["Bash,Read".into()]);

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        assert_eq!(outcome.exit_code(), 1);
        let error = outcome.error().unwrap();
        assert!(error.contains("VM0_TOOLS"));
        assert!(error.contains("must not contain commas"));
        assert!(outcome.sandbox.is_none());
        assert!(
            overrides.create_configs().is_empty(),
            "fresh sandbox must not be created after tool validation failure"
        );
    }

    #[tokio::test]
    async fn execute_job_codex_ignores_claude_tool_validation() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.disallowed_tools = Some(vec!["".into()]);
        ctx.tools = Some(vec!["Bash,Read".into()]);

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        assert_eq!(outcome.exit_code(), 0);
        assert!(outcome.error().is_none());
        assert!(outcome.sandbox.is_some());
        assert_eq!(overrides.create_configs().len(), 1);
    }

    // -----------------------------------------------------------------------
    // Keep-alive VM reuse integration tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn execute_job_reuse_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        // First: create a sandbox via normal execute_job
        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code(), 0);
        let sandbox = outcome.sandbox.expect("sandbox should be alive");

        // Reuse the sandbox for a second turn
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, minimal_context(), &config, cancel).await;
        assert_eq!(reuse_outcome.exit_code(), 0);
        assert!(reuse_outcome.error().is_none());
        assert!(reuse_outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn execute_job_reuse_model_provider_env_validation_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let source_ip = sandbox.source_ip().to_string();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
        let secret = "sk-proj-real-openai-secret";
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, ctx, &config, cancel).await;

        assert_eq!(reuse_outcome.exit_code(), 1);
        let error = reuse_outcome.error().unwrap();
        assert!(error.contains("OPENAI_API_KEY"));
        assert!(!error.contains(secret));
        assert!(reuse_outcome.sandbox.is_some());
        assert!(reuse_outcome.network_log_session.is_none());
        assert!(
            overrides.start_process_calls().is_empty(),
            "reused sandbox must not start a process after env validation failure"
        );
    }

    #[tokio::test]
    async fn execute_job_reuse_claude_tool_validation_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let source_ip = sandbox.source_ip().to_string();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec!["   ".into()]);

        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, ctx, &config, cancel).await;

        assert_eq!(reuse_outcome.exit_code(), 1);
        let error = reuse_outcome.error().unwrap();
        assert!(error.contains("VM0_DISALLOWED_TOOLS"));
        assert!(error.contains("must not be empty"));
        assert!(reuse_outcome.sandbox.is_some());
        assert!(reuse_outcome.network_log_session.is_none());
        assert!(
            overrides.start_process_calls().is_empty(),
            "reused sandbox must not start a process after tool validation failure"
        );
    }

    #[tokio::test]
    async fn execute_job_reuse_appends_stream_limit_marker() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
            bytes: b"reuse partial stdout".to_vec(),
            truncated: true,
        }]);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let source_ip = sandbox.source_ip().to_string();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
        let ctx = minimal_context();
        let system_log_path = config.log_paths.system_log(ctx.run_id);

        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, ctx, &config, cancel).await;

        assert_eq!(reuse_outcome.exit_code(), 0);
        assert!(reuse_outcome.error().is_none());
        assert!(reuse_outcome.sandbox.is_some());
        assert!(reuse_outcome.network_log_session.is_some());
        assert_proxy_registry_empty(dir.path()).await;
        let system_log = tokio::fs::read(&system_log_path).await.unwrap();
        let mut expected = b"reuse partial stdout\n".to_vec();
        expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
        assert_eq!(system_log, expected);
    }

    #[tokio::test]
    async fn execute_job_reuse_with_session_context() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        // First turn: execute with resume_session
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "test-session-abc".into(),
            session_history: r#"{"type":"human","text":"hello"}"#.into(),
        });
        assert_eq!(ctx.session_id(), Some("test-session-abc"));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code(), 0);
        let sandbox = outcome.sandbox.expect("sandbox should be alive");

        // Second turn: reuse with new session history
        let mut ctx2 = minimal_context();
        ctx2.resume_session = Some(ResumeSession {
            session_id: "test-session-abc".into(),
            session_history: r#"{"type":"human","text":"hello"}
{"type":"assistant","text":"hi"}
{"type":"human","text":"do something"}"#
                .into(),
        });

        let cancel = tokio_util::sync::CancellationToken::new();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, ctx2, &config, cancel).await;
        assert_eq!(reuse_outcome.exit_code(), 0);
        assert!(reuse_outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn idle_pool_park_and_reuse_cycle() {
        use crate::idle_pool::{
            IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate,
            SyntheticParkedIdleCandidateParts,
        };

        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        // Execute first job
        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code(), 0);
        let sandbox = outcome.sandbox.expect("sandbox alive");

        // Park in idle pool
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });

        let entry = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
            sandbox,
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: test_budget_lease(),
            source_ip: outcome.source_ip,
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        });

        let result = pool.park(entry);
        assert!(matches!(result, ParkResult::Parked));
        assert_eq!(pool.len(), 1);

        // Take from pool for reuse
        let reuse_entry = pool.take("test-session").expect("should find session");
        assert_eq!(pool.len(), 0);
        assert_eq!(reuse_entry.profile_name(), "vm0/default");

        // Execute reuse
        let cancel = tokio_util::sync::CancellationToken::new();
        let (idle_sandbox, _lease) = match reuse_entry.try_unpark().await {
            crate::idle_pool::IdleUnparkResult::Reused {
                sandbox,
                budget_lease,
            } => (sandbox, budget_lease),
            crate::idle_pool::IdleUnparkResult::Failed { error, .. } => {
                panic!("test idle entry should unpark: {error}");
            }
        };
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, minimal_context(), &config, cancel).await;
        assert_eq!(reuse_outcome.exit_code(), 0);
        assert!(reuse_outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn idle_pool_profile_mismatch_returns_none() {
        use crate::idle_pool::{
            IdlePool, IdlePoolConfig, ParkedIdleCandidate, SyntheticParkedIdleCandidateParts,
        };

        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });

        // Park with profile "vm0/default"
        let entry = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
            sandbox: Box::new(sandbox_mock::MockSandbox::new("test")),
            factory: std::sync::Arc::new(
                Box::new(sandbox_mock::MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: test_budget_lease(),
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        });
        let _ = pool.park(entry);

        // Take and verify profile
        let taken = pool.take("test-session").expect("should find");
        assert_eq!(taken.profile_name(), "vm0/default");

        // Simulate caller checking profile mismatch
        let matches_browser = taken.profile_name() == "vm0/browser";
        assert!(!matches_browser, "should not match different profile");
    }

    #[tokio::test]
    async fn execute_job_reuse_clock_fix_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;

        // Build a MockSandbox that fails on the first exec (fix_guest_clock)
        let sandbox = MockSandbox::new("reuse-clock-fail");
        sandbox.push_exec_result(Err(sandbox_exec_error("vsock broken")));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
        let (outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, minimal_context(), &config, cancel).await;

        assert_eq!(outcome.exit_code(), 1);
        assert!(outcome.error().unwrap().contains("vsock broken"));
        // Critical: sandbox must be returned so caller can stop + destroy it
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on clock fix failure"
        );
        assert!(
            outcome.network_log_session.is_some(),
            "network log session must be returned so finalization can close it"
        );
        assert_proxy_registry_empty(dir.path()).await;
    }

    #[tokio::test]
    async fn execute_job_reuse_reseed_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;

        // First exec (fix_guest_clock) succeeds, second (reseed_guest_entropy) fails
        let sandbox = MockSandbox::new("reuse-reseed-fail");
        sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
        sandbox.push_exec_result(Err(sandbox_exec_error("reseed timeout")));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
        let (outcome, _telemetry) =
            execute_job_reuse(idle_sandbox, minimal_context(), &config, cancel).await;

        assert_eq!(outcome.exit_code(), 1);
        assert!(outcome.error().unwrap().contains("reseed timeout"));
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on reseed failure"
        );
    }

    /// Verify that session restore failure during reuse still returns the sandbox.
    #[tokio::test]
    async fn execute_job_reuse_session_restore_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;

        let sandbox = MockSandbox::new("reuse-session-fail");
        // clock fix and reseed succeed (default), but write_file for session
        // history fails.
        sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));

        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-abc".into(),
            session_history: r#"{"type":"init"}"#.into(),
        });

        let cancel = tokio_util::sync::CancellationToken::new();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-abc").await;
        let (outcome, _telemetry) = execute_job_reuse(idle_sandbox, ctx, &config, cancel).await;

        assert_eq!(outcome.exit_code(), 1);
        assert!(outcome.error().unwrap().contains("disk full"));
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on session restore failure"
        );
    }

    #[tokio::test]
    async fn execute_job_nonzero_exit_still_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        // Sandbox should be alive regardless of exit code (caller decides fate)
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned for caller to stop+destroy or park"
        );
    }

    // -----------------------------------------------------------------------
    // filter_unchanged_storages tests
    // -----------------------------------------------------------------------

    fn guest_art(name: &str, ver: &str, url: Option<&str>) -> GuestDownloadArtifactEntry {
        GuestDownloadArtifactEntry {
            mount_path: "/workspace".into(),
            archive_url: url.map(str::to_string),
            cached: false,
            vas_storage_name: name.into(),
            vas_storage_id: String::new(),
            vas_version_id: ver.into(),
        }
    }

    fn guest_storage(
        mount_path: &str,
        name: &str,
        ver: &str,
        url: Option<&str>,
    ) -> GuestDownloadStorageEntry {
        GuestDownloadStorageEntry {
            mount_path: mount_path.into(),
            archive_url: url.map(str::to_string),
            instructions_target_filename: None,
            cached: false,
            vas_storage_name: name.into(),
            vas_version_id: ver.into(),
        }
    }

    fn art_fp(mount: &str, name: &str, ver: &str) -> HashMap<String, (String, String)> {
        let mut m = HashMap::new();
        m.insert(mount.into(), (name.into(), ver.into()));
        m
    }

    #[test]
    fn filter_same_artifact_version_nulls_url() {
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_none());
    }

    #[test]
    fn filter_different_artifact_version_keeps_url() {
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("my-art", "v2", Some("https://s3/v2"))],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert_eq!(
            result.artifacts[0].archive_url.as_deref(),
            Some("https://s3/v2"),
        );
    }

    #[test]
    fn filter_different_artifact_name_keeps_url() {
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("other-art", "v1", Some("https://s3/v1"))],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_some());
    }

    #[test]
    fn filter_new_artifact_not_in_prev_keeps_url() {
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints::default();
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_some());
    }

    #[test]
    fn filter_empty_prev_downloads_everything() {
        let manifest = GuestDownloadManifest {
            storages: vec![guest_storage(
                "/data",
                "vol-1",
                "v1",
                Some("https://s3/data"),
            )],
            artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints::default();
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.storages[0].archive_url.is_some());
        assert!(result.artifacts[0].archive_url.is_some());
    }

    #[test]
    fn filter_all_unchanged_nulls_all_urls() {
        let manifest = GuestDownloadManifest {
            storages: vec![guest_storage(
                "/data",
                "vol-1",
                "v1",
                Some("https://s3/same-url"),
            )],
            artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.storages[0].archive_url.is_none());
        assert!(result.storages[0].cached);
        assert!(result.artifacts[0].archive_url.is_none());
        assert!(result.artifacts[0].cached);
    }

    #[test]
    fn filter_two_artifacts_at_different_mount_paths() {
        let art_a = GuestDownloadArtifactEntry {
            mount_path: "/workspace".into(),
            archive_url: Some("https://s3/a-v2".into()),
            cached: false,
            vas_storage_name: "art-a".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v2".into(),
        };
        let art_b = GuestDownloadArtifactEntry {
            mount_path: "/data".into(),
            archive_url: Some("https://s3/b-v1".into()),
            cached: false,
            vas_storage_name: "art-b".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v1".into(),
        };
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![art_a, art_b],
            cleanup_paths: vec![],
        };
        // Previous fingerprints: art-a was v1 (changed), art-b was v1 (unchanged).
        let mut artifacts = HashMap::new();
        artifacts.insert("/workspace".into(), ("art-a".into(), "v1".into()));
        artifacts.insert("/data".into(), ("art-b".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts,
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert_eq!(result.artifacts.len(), 2);
        // art-a changed → keeps URL, not cached, cleanup path added
        assert!(result.artifacts[0].archive_url.is_some());
        assert!(!result.artifacts[0].cached);
        assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
        // art-b unchanged → URL nulled, cached
        assert!(result.artifacts[1].archive_url.is_none());
        assert!(result.artifacts[1].cached);
    }

    #[test]
    fn filter_detects_removed_artifacts() {
        // Current manifest has only one artifact; previous had two.
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("kept", "v1", Some("https://s3/kept"))],
            cleanup_paths: vec![],
        };
        let mut artifacts = HashMap::new();
        artifacts.insert("/workspace".into(), ("kept".into(), "v1".into()));
        artifacts.insert("/old".into(), ("removed".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts,
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Removed artifact path must appear in cleanup_paths.
        assert!(result.cleanup_paths.contains(&"/old".to_string()));
    }

    #[test]
    fn filter_computes_cleanup_for_changed_storages() {
        let manifest = GuestDownloadManifest {
            storages: vec![
                guest_storage(
                    "/home/user/.claude",
                    "instructions",
                    "v2",
                    Some("https://s3/instructions"),
                ),
                guest_storage(
                    "/home/user/.claude/skills/foo",
                    "skill-foo",
                    "v1",
                    Some("https://s3/foo"),
                ),
            ],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert(
            "/home/user/.claude".into(),
            ("instructions".into(), "v1".into()),
        );
        storages.insert(
            "/home/user/.claude/skills/foo".into(),
            ("skill-foo".into(), "v1".into()),
        );
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Instructions changed (v1→v2), skill-foo unchanged
        assert!(result.storages[0].archive_url.is_some());
        assert!(!result.storages[0].cached);
        assert!(result.storages[1].archive_url.is_none());
        assert!(result.storages[1].cached);
        // Only changed storage in cleanup_paths
        assert_eq!(result.cleanup_paths, vec!["/home/user/.claude"]);
    }

    #[test]
    fn filter_detects_removed_storages() {
        let manifest = GuestDownloadManifest {
            storages: vec![guest_storage(
                "/home/user/.claude",
                "instructions",
                "v1",
                Some("https://s3/instructions"),
            )],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert(
            "/home/user/.claude".into(),
            ("instructions".into(), "v1".into()),
        );
        storages.insert(
            "/home/user/.claude/skills/old-skill".into(),
            ("old-skill".into(), "v1".into()),
        );
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // instructions unchanged, old-skill removed
        assert!(result.storages[0].archive_url.is_none());
        assert!(
            result
                .cleanup_paths
                .contains(&"/home/user/.claude/skills/old-skill".to_string())
        );
    }

    #[test]
    fn filter_changed_artifact_adds_cleanup_path() {
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("my-art", "v2", Some("https://s3/v2"))],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_some());
        assert!(
            result
                .cleanup_paths
                .contains(&result.artifacts[0].mount_path)
        );
    }

    #[test]
    fn filter_changed_artifact_with_null_url_adds_cleanup_path() {
        let manifest = GuestDownloadManifest {
            storages: vec![],
            artifacts: vec![guest_art("my-art", "v2", None)],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Version changed → must be in cleanup_paths even though URL is absent.
        assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
        assert!(!result.artifacts[0].cached);
    }

    #[test]
    fn filter_changed_storage_with_null_url_adds_cleanup_path() {
        let manifest = GuestDownloadManifest {
            storages: vec![guest_storage("/data", "vol-1", "v2", None)],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Version changed → must be in cleanup_paths even though URL is absent.
        assert!(result.cleanup_paths.contains(&"/data".to_string()));
        assert!(!result.storages[0].cached);
    }

    #[test]
    fn filter_unchanged_storage_sets_cached_true() {
        let manifest = GuestDownloadManifest {
            storages: vec![guest_storage(
                "/data",
                "vol-1",
                "v1",
                Some("https://s3/data"),
            )],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.storages[0].cached);
        assert!(result.storages[0].archive_url.is_none());
    }

    // -----------------------------------------------------------------------
    // Reuse-outcome telemetry (issue #10360: sandbox reuse success rate)
    // -----------------------------------------------------------------------

    fn new_telemetry() -> JobTelemetry {
        let http = HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".to_string(),
            vercel_bypass: None,
        })
        .unwrap();
        JobTelemetry::new(http, RunId::nil(), "tok".to_string())
    }

    #[test]
    fn record_reuse_result_emits_hit_for_reuse() {
        let mut telemetry = new_telemetry();
        record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].0, "sandbox_reuse_hit");
    }

    #[test]
    fn record_reuse_result_emits_miss_for_every_miss_variant() {
        let variants = [
            SandboxReuseResult::NoSessionId,
            SandboxReuseResult::PoolMiss,
            SandboxReuseResult::ProfileMismatch,
            SandboxReuseResult::DeviceLimitMismatch,
            SandboxReuseResult::UnparkFailed,
        ];
        for variant in variants {
            let mut telemetry = new_telemetry();
            record_reuse_result(&mut telemetry, variant);
            let ops = telemetry.pending_ops_snapshot();
            assert_eq!(ops.len(), 1, "{variant:?}");
            assert_eq!(ops[0].0, "sandbox_reuse_miss", "{variant:?}");
        }
    }

    #[tokio::test]
    async fn execute_job_records_sandbox_reuse_miss_in_telemetry() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (_outcome, telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        let ops = telemetry.pending_ops_snapshot();
        let reuse_events: Vec<_> = ops
            .iter()
            .filter(|op| op.0.starts_with("sandbox_reuse_"))
            .collect();
        assert_eq!(reuse_events.len(), 1);
        assert_eq!(reuse_events[0].0, "sandbox_reuse_miss");
    }

    #[tokio::test]
    async fn execute_job_reuse_records_sandbox_reuse_hit_in_telemetry() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let factory = MockSandboxFactory::new();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        let sandbox = outcome.sandbox.expect("sandbox should be alive");

        let cancel = tokio_util::sync::CancellationToken::new();
        let (idle_sandbox, _lease) =
            make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
        let (_outcome, telemetry) =
            execute_job_reuse(idle_sandbox, minimal_context(), &config, cancel).await;

        let ops = telemetry.pending_ops_snapshot();
        let reuse_events: Vec<_> = ops
            .iter()
            .filter(|op| op.0.starts_with("sandbox_reuse_"))
            .collect();
        assert_eq!(reuse_events.len(), 1);
        assert_eq!(reuse_events[0].0, "sandbox_reuse_hit");
    }
}
