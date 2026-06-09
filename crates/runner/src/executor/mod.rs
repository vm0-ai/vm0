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

use std::path::PathBuf;
use std::time::Duration;

use agent_diagnostics::FailureDiagnostic;
use sandbox::{Sandbox, SandboxFactory, SandboxId};
use tokio_util::sync::CancellationToken;

mod agent_run;
mod diagnostics;
mod env;
mod guest_state;
mod sandbox_run;
mod session_restore;
mod storage;
mod telemetry;

pub(crate) use guest_state::{fix_guest_clock, reseed_guest_entropy};

use agent_run::ProcessCancelTimeouts;
use env::validate_execution_context_before_sandbox;
use sandbox_run::{
    execute_new_sandbox, execute_reused_sandbox, invalidate_disabled_workspace_cache_baselines,
    workspace_image_promotable,
};
use telemetry::{record_api_latency, record_reuse_result};

use crate::ids::RunId;
use api_contracts::generated::constants::runners::paths::{
    CANONICAL_GUEST_HOME_DIR, CANONICAL_WORKING_DIR,
};

/// Maximum wall-clock time for a single job (2 hours).
const JOB_TIMEOUT: Duration = Duration::from_secs(7200);
/// Exit code used when the runner's job timeout stops an agent process.
const JOB_TIMEOUT_EXIT_CODE: i32 = 124;
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
const AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(5);
const AGENT_ENV_KEY_DIAGNOSTIC_LIMIT: usize = 128;
const AGENT_ENV_KEY_MAX_CHARS: usize = 128;
const SMALL_GUEST_FILE_MAX_BYTES: u64 = 64 * 1024;
const GUEST_LOG_COPY_MAX_BYTES: u64 = 64 * 1024 * 1024;
const GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES: usize = 8 * 1024;
const STDOUT_STREAM_LIMIT_MARKER: &[u8] =
    b"[vm0] stdout stream reached the guest stream limit; later output was omitted\n";
const STDOUT_STREAM_OVERFLOW_MARKER: &[u8] =
    b"[vm0] stdout stream overflowed the host queue; some output was dropped\n";
const MIN_EPOCH_MS_TIMESTAMP: u64 = 1_000_000_000_000;
const BOOTSTRAP_SENSITIVE_ENV_KEYS: &[&str] = &[
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "NODE_OPTIONS",
];
const USER_ENV_FILE_ENV_KEY: &str = "VM0_USER_ENV_FILE";
const GUEST_USER_ENV_DIR_NAME: &str = "user-env";
const GUEST_USER_ENV_FILENAME: &str = "env.json";
const GUEST_AGENT_TUNING_ENV_KEYS: &[&str] = &[
    "VM0_STUCK_TOOL_TIMEOUT_SECS",
    "VM0_POST_RESULT_SIGTERM_GRACE_SECS",
    "VM0_POST_RESULT_SIGKILL_GRACE_SECS",
];
const AGENT_ABNORMAL_EXIT_DIAGNOSTIC_SCRIPT: &str =
    include_str!("../../scripts/agent-abnormal-exit-diagnostics.sh");

use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::idle_pool::ReusableIdleSandbox;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogManager;
use crate::network_log_manager::NetworkLogSession;
use crate::paths::{HomePaths, LogPaths};
use crate::proxy::{MitmJsonlFlushHandle, ProxyRegistryHandle};
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, SandboxReuseResult};
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceImageActiveLeaseRequest, WorkspaceImageLease,
};

fn guest_runtime_dir(run_id: RunId) -> RunnerResult<String> {
    let run_id = run_id.to_string();
    let path = guest_runtime_paths::run_dir_for_home(CANONICAL_GUEST_HOME_DIR, &run_id)
        .map_err(|e| RunnerError::Internal(format!("guest runtime dir: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

fn guest_runtime_path(
    run_id: RunId,
    path: impl FnOnce(PathBuf) -> PathBuf,
) -> RunnerResult<String> {
    let run_id = run_id.to_string();
    let run_dir = guest_runtime_paths::run_dir_for_home(CANONICAL_GUEST_HOME_DIR, &run_id)
        .map_err(|e| RunnerError::Internal(format!("guest runtime path: {e}")))?;
    Ok(path(run_dir).to_string_lossy().into_owned())
}

/// Shared configuration for all executions (profile-independent).
pub struct ExecutorConfig {
    pub api_url: String,
    pub registry: ProxyRegistryHandle,
    pub http: HttpClient,
    pub log_paths: LogPaths,
    pub network_log_manager: NetworkLogManager,
    pub network_log_drain: NetworkLogDrainCoordinator,
    pub mitm_jsonl_flush: Option<MitmJsonlFlushHandle>,
    pub home: HomePaths,
    pub workspace_cache: Option<SessionWorkspaceCache>,
}

/// Per-job VM parameters resolved from the profile config.
pub struct JobParams {
    pub profile_name: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub workspace_disk_mb: u32,
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
    pub workspace_image: Option<WorkspaceImageLease>,
    pub workspace_promotable: bool,
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
    pub kind: ExecutionFailureKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionFailureKind {
    Generic,
    RunnerJobTimeout {
        timeout_ms: u128,
        elapsed_ms: u128,
        guest_duration_ms: Option<u32>,
    },
}

impl ExecutionFailure {
    #[must_use]
    pub fn new(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        let exit_code = normalize_failure_exit_code(exit_code);
        let error = non_empty_failure_error(exit_code, error.into());
        Self {
            exit_code,
            error,
            diagnostic,
            kind: ExecutionFailureKind::Generic,
        }
    }

    #[must_use]
    pub fn runner_job_timeout(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
        timeout: Duration,
        elapsed: Duration,
        guest_duration_ms: Option<u32>,
    ) -> Self {
        let exit_code = normalize_timeout_failure_exit_code(exit_code);
        let error = non_empty_failure_error(exit_code, error.into());
        Self {
            exit_code,
            error,
            diagnostic,
            kind: ExecutionFailureKind::RunnerJobTimeout {
                timeout_ms: timeout.as_millis(),
                elapsed_ms: elapsed.as_millis(),
                guest_duration_ms,
            },
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

fn normalize_failure_exit_code(exit_code: i32) -> i32 {
    if exit_code == 0 { 1 } else { exit_code }
}

fn normalize_timeout_failure_exit_code(exit_code: i32) -> i32 {
    if exit_code == 0 {
        JOB_TIMEOUT_EXIT_CODE
    } else {
        exit_code
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
            workspace_image: None,
            workspace_promotable: false,
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
                workspace_image: None,
                workspace_promotable: false,
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
    params: &JobParams,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    let run_id = context.run_id;
    let mut telemetry =
        JobTelemetry::new(config.http.clone(), run_id, context.sandbox_token.clone());

    record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
    record_api_latency("api_to_vm_start", &context, &mut telemetry);

    let sandbox_id = idle_sandbox.sandbox_id();
    let idle_parts = idle_sandbox.into_parts();
    let source_ip = idle_parts.source_ip;
    let prev_storage = idle_parts.storage_fingerprints;
    let workspace_promotion = idle_parts.workspace_promotion;
    let sandbox = idle_parts.sandbox;

    let workspace_cache_enabled = context.session_workspace_image_cache_enabled();
    let workspace_image = match (workspace_cache_enabled, config.workspace_cache.as_ref()) {
        (true, Some(cache)) => {
            let active_request = WorkspaceImageActiveLeaseRequest {
                run_id,
                sandbox_id,
                profile_name: &params.profile_name,
                session_id: context.session_id(),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
                workspace_drive_available: true,
            };
            Some(match workspace_promotion {
                Some(promotion) => promotion.into_active_lease(active_request),
                None => cache.lease_active(active_request).await,
            })
        }
        (false, maybe_cache) => {
            if let Some(cache) = maybe_cache {
                invalidate_disabled_workspace_cache_baselines(&context, cache).await;
            }
            if let Some(promotion) = workspace_promotion
                && let Err(error) = promotion
                    .invalidate_current("reused sandbox ran without workspace image cache")
                    .await
            {
                let failure = ExecutionFailure::from_error(format!(
                    "failed to invalidate workspace image cache before disabled-cache reuse: {error}"
                ));
                return (
                    ExecuteOutcome {
                        failure: Some(failure),
                        sandbox: Some(sandbox),
                        source_ip,
                        network_log_session: None,
                        workspace_image: None,
                        workspace_promotable: false,
                        guest_session_id: None,
                    },
                    telemetry,
                );
            }
            None
        }
        (true, None) => {
            if let Some(promotion) = workspace_promotion
                && let Err(error) = promotion
                    .invalidate_current("reused sandbox ran without workspace image cache")
                    .await
            {
                let failure = ExecutionFailure::from_error(format!(
                    "failed to invalidate workspace image cache before unconfigured-cache reuse: {error}"
                ));
                return (
                    ExecuteOutcome {
                        failure: Some(failure),
                        sandbox: Some(sandbox),
                        source_ip,
                        network_log_session: None,
                        workspace_image: None,
                        workspace_promotable: false,
                        guest_session_id: None,
                    },
                    telemetry,
                );
            }
            None
        }
    };

    // execute_reused_sandbox never returns Err — it always returns the sandbox
    // in the outcome so the caller can stop + destroy it on failure.
    let outcome = if let Err(error) = validate_execution_context_before_sandbox(&context) {
        ExecuteOutcome {
            failure: Some(ExecutionFailure::from_error(error)),
            sandbox: Some(sandbox),
            source_ip,
            network_log_session: None,
            workspace_promotable: workspace_image_promotable(
                workspace_image.as_ref(),
                &context,
                None,
            ),
            workspace_image,
            guest_session_id: None,
        }
    } else {
        let mut outcome = execute_reused_sandbox(
            sandbox,
            &source_ip,
            &context,
            config,
            &prev_storage,
            &mut telemetry,
            cancel,
        )
        .await;
        outcome.workspace_promotable = workspace_image_promotable(
            workspace_image.as_ref(),
            &context,
            outcome.guest_session_id.as_deref(),
        );
        outcome.workspace_image = workspace_image;
        outcome
    };

    (outcome, telemetry)
}

/// Dispatch inputs for the fresh-create path. Holds the UUID for the new VM
/// and the categorized reason no idle VM was reused. The id is selected in job
/// discovery after the reuse decision, then forwarded by `job_spawn`; it becomes
/// the sandbox's identity, and the reuse result is forwarded to the guest for
/// /complete metadata.
pub struct NewSandboxDispatch {
    pub id: SandboxId,
    pub reuse_result: SandboxReuseResult,
}

#[cfg(test)]
mod tests;
