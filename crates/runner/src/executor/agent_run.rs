use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use guest_contracts::diagnostics::{CliTerminationReason, FailureDiagnostic};
use guest_contracts::session_history_identity::{
    FinalSessionHistoryIdentity, FinalSessionHistoryIdentityError,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
};
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, GuestProcessCancelHandle,
    GuestProcessControlHandle, GuestProcessHandle, ProcessControlMode, ProcessOutputMode, Sandbox,
    StartProcessRequest,
};
use shell_quote::quote_shell_arg;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::codex_model_catalog_prefetch::{
    StartedCodexModelCatalogPrefetch, is_eligible as is_codex_model_catalog_prefetch_eligible,
};
use super::diagnostics::{
    AgentBootstrapAbnormalExitLogContext, AgentEnvDiagnostics, AgentStdoutStreamDiagnostics,
    StdoutDrainReport, build_agent_env_diagnostics, build_agent_env_key_diagnostics,
    check_host_oom, collect_agent_abnormal_exit_diagnostics, dmesg_indicates_oom,
    drain_stdout_to_file, log_agent_abnormal_exit_env_diagnostics,
    log_agent_bootstrap_abnormal_exit_diagnostics, log_agent_process_exit_summary,
    read_guest_error_file, read_guest_failure_diagnostic_file,
    should_collect_agent_abnormal_exit_diagnostics,
    should_collect_unattributed_sigkill_resource_diagnostics,
    should_log_agent_bootstrap_abnormal_exit_diagnostics,
};
use super::effective_cli_framework;
use super::env::{
    build_env_json_for_run, build_run_payload_for_run, build_user_env_json, write_run_payload_file,
    write_user_env_file,
};
use super::guest_state::{restore_guest_state, sync_guest_timezone};
use super::session_history_cpu::{SessionHistoryCpuJob, SessionHistoryPrefixOutcome};
use super::session_history_download::{
    SessionHistoryDownloadPhaseTiming, SessionHistoryDownloadTimings,
    SessionHistoryMaterialization, SessionHistoryMaterializer,
};
use super::session_restore::{
    MaterializedResumeSession, SessionRestoreDiagnostics, restore_session,
};
use super::storage::download_storages;
use super::telemetry::{RunnerSpawnTiming, record_api_latency};
use super::workspace_session_history_materializer::{
    WorkspaceSessionHistoryMaterialization, WorkspaceSessionHistoryPhaseTiming,
    WorkspaceSessionHistoryTimings,
};
use super::{
    EXIT_SIGKILL, EXIT_SIGNAL_KILL, ExecutionFailure, ExecutorConfig, JOB_TIMEOUT,
    JOB_TIMEOUT_EXIT_CODE, PROCESS_CANCEL_TIMEOUTS, ResourceFailureDiagnostics,
    ResourceFailureKind, RunnerError, RunnerResult, SandboxReuseResult,
    SessionHistoryRestoreFallback, SessionHistoryRestorePlan, USER_ENV_FILE_ENV_KEY,
    agent_exit_failure_message, guest_runtime_dir, guest_runtime_path, job_supervisor_timeout,
    job_terminal_wait_timeout, normalize_failure_exit_code,
};
use crate::active_input::ActiveInputSource;
use crate::helper_exec::{helper_exec_succeeded, helper_exec_termination_label};
use crate::paths::guest;
use crate::restored_session_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT, RestoredSessionFinalMetadataVerification,
    RestoredSessionIdentity, RestoredSessionIdentityMismatchReason,
};
use crate::storage_plan::{StoragePlan, build_storage_plan};
use crate::telemetry::{
    JobTelemetry, SessionHistoryTelemetryMetadata, session_history_prefix_extension_action_type,
};
use crate::types::ExecutionContext;

const AGENT_WRAPPER_STDERR_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;
const SESSION_HISTORY_DOWNLOAD_TELEMETRY_ERROR: &str = "session history download failed";
const SESSION_HISTORY_DOWNLOAD_PHASE_TELEMETRY_ERROR: &str =
    "session history download phase failed";
const SESSION_HISTORY_MATERIALIZATION_WAIT_TELEMETRY_ERROR: &str =
    "session history materialization failed";
const WORKSPACE_SESSION_HISTORY_PHASE_TELEMETRY_ERROR: &str =
    "workspace session history phase failed";
const STORAGE_CACHE_POPULATE_FAILED: &str = "storage-cache-populate-failed";
const STORAGE_DOWNLOAD_FAILED: &str = "storage-download-failed";
const SESSION_HISTORY_IDENTITY_VERIFY_TIMEOUT: Duration = Duration::from_secs(5);
const USER_CANCELLATION_CONTROL_PAYLOAD: &[u8] = br#"{"type":"user-cancellation"}"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionHistoryIdentityReason {
    FinalizeMetadataPathUnresolved,
    FinalizeRuntimeDirUnresolved,
    FinalizeMissingMetadata,
    FinalizeMetadataReadFailed,
    FinalizeInvalidMetadata,
    FinalizeUnverifiableMetadata,
    VerifyRequestMissing,
    VerifyRequestMismatch,
    VerifyMissingVerifier,
    VerifyHelperFailed,
    VerifyHelperTimedOut,
    VerifyHelperInvalidArgs,
    VerifyHelperMetadataRead,
    VerifyHelperInvalidMetadata,
    VerifyHelperFrameworkMismatch,
    VerifyHelperExpectedMismatch,
    VerifyHelperHistoryRead,
    VerifyHelperHistoryMismatch,
    VerifyHelperHistoryTooLarge,
    VerifyHelperExecError,
    ReuseMissingNoIdleIdentity,
}

impl SessionHistoryIdentityReason {
    const fn action_type(self) -> &'static str {
        match self {
            Self::FinalizeMetadataPathUnresolved => {
                "session_history_identity_finalize_metadata_path_unresolved"
            }
            Self::FinalizeRuntimeDirUnresolved => {
                "session_history_identity_finalize_runtime_dir_unresolved"
            }
            Self::FinalizeMissingMetadata => "session_history_identity_finalize_missing_metadata",
            Self::FinalizeMetadataReadFailed => {
                "session_history_identity_finalize_metadata_read_failed"
            }
            Self::FinalizeInvalidMetadata => "session_history_identity_finalize_invalid_metadata",
            Self::FinalizeUnverifiableMetadata => {
                "session_history_identity_finalize_unverifiable_metadata"
            }
            Self::VerifyRequestMissing => "session_history_identity_verify_request_missing",
            Self::VerifyRequestMismatch => "session_history_identity_verify_request_mismatch",
            Self::VerifyMissingVerifier => "session_history_identity_verify_missing_verifier",
            Self::VerifyHelperFailed => "session_history_identity_verify_helper_failed",
            Self::VerifyHelperTimedOut => "session_history_identity_verify_helper_timed_out",
            Self::VerifyHelperInvalidArgs => "session_history_identity_verify_helper_invalid_args",
            Self::VerifyHelperMetadataRead => {
                "session_history_identity_verify_helper_metadata_read_failed"
            }
            Self::VerifyHelperInvalidMetadata => {
                "session_history_identity_verify_helper_invalid_metadata"
            }
            Self::VerifyHelperFrameworkMismatch => {
                "session_history_identity_verify_helper_framework_mismatch"
            }
            Self::VerifyHelperExpectedMismatch => {
                "session_history_identity_verify_helper_expected_mismatch"
            }
            Self::VerifyHelperHistoryRead => {
                "session_history_identity_verify_helper_history_read_failed"
            }
            Self::VerifyHelperHistoryMismatch => {
                "session_history_identity_verify_helper_history_mismatch"
            }
            Self::VerifyHelperHistoryTooLarge => {
                "session_history_identity_verify_helper_history_too_large"
            }
            Self::VerifyHelperExecError => "session_history_identity_verify_helper_exec_error",
            Self::ReuseMissingNoIdleIdentity => {
                "session_history_identity_reuse_missing_no_idle_identity"
            }
        }
    }

    const fn from_final_metadata_error(error: FinalSessionHistoryIdentityError) -> Self {
        match error {
            FinalSessionHistoryIdentityError::MetadataTooLarge
            | FinalSessionHistoryIdentityError::HistoryTooLarge => {
                Self::FinalizeUnverifiableMetadata
            }
            FinalSessionHistoryIdentityError::InvalidJson
            | FinalSessionHistoryIdentityError::UnsupportedVersion
            | FinalSessionHistoryIdentityError::InvalidFramework
            | FinalSessionHistoryIdentityError::InvalidHistoryRefKind
            | FinalSessionHistoryIdentityError::InvalidSessionIdHash
            | FinalSessionHistoryIdentityError::InvalidHistoryHash
            | FinalSessionHistoryIdentityError::InvalidHistorySize
            | FinalSessionHistoryIdentityError::MissingHistoryMarker => {
                Self::FinalizeInvalidMetadata
            }
        }
    }
}

fn record_session_history_identity_reason(
    telemetry: &mut JobTelemetry,
    reason: SessionHistoryIdentityReason,
) {
    telemetry.record(reason.action_type(), Duration::ZERO, true, None);
}

fn record_session_history_identity_mismatch_reason(
    telemetry: &mut JobTelemetry,
    reason: RestoredSessionIdentityMismatchReason,
) {
    telemetry.record(reason.action_type(), Duration::ZERO, true, None);
    if let Some(action_type) = reason.history_hash_size_relationship_action_type() {
        telemetry.record(action_type, Duration::ZERO, true, None);
    }
}

fn record_session_history_prefix_outcome(
    telemetry: &mut JobTelemetry,
    outcome: SessionHistoryPrefixOutcome,
) {
    match outcome {
        SessionHistoryPrefixOutcome::Verified { raw_extension_size } => {
            telemetry.record(
                "session_history_requested_larger_prefix_verified",
                Duration::ZERO,
                true,
                None,
            );
            telemetry.record(
                session_history_prefix_extension_action_type(raw_extension_size),
                Duration::ZERO,
                true,
                None,
            );
        }
        SessionHistoryPrefixOutcome::Divergent => telemetry.record(
            "session_history_requested_larger_prefix_divergent",
            Duration::ZERO,
            true,
            None,
        ),
    }
}

fn record_session_history_download_timings(
    telemetry: &mut JobTelemetry,
    timings: &SessionHistoryDownloadTimings,
) {
    let metadata = timings.metadata();
    record_session_history_download_phase(
        telemetry,
        "session_history_download_request_status",
        timings.request_status(),
        metadata,
    );
    record_session_history_download_phase(
        telemetry,
        "session_history_download_body_read",
        timings.body_read(),
        metadata,
    );
    record_session_history_download_phase(
        telemetry,
        "session_history_download_validation",
        timings.validation(),
        metadata,
    );
    record_session_history_download_phase(
        telemetry,
        "session_history_download_decompression",
        timings.decompression(),
        metadata,
    );
    record_session_history_download_phase(
        telemetry,
        "session_history_download_hash_verification",
        timings.hash_verification(),
        metadata,
    );
}

fn record_session_history_download_phase(
    telemetry: &mut JobTelemetry,
    action_type: &'static str,
    phase: Option<SessionHistoryDownloadPhaseTiming>,
    metadata: Option<SessionHistoryTelemetryMetadata>,
) {
    if let Some(phase) = phase {
        telemetry.record_with_session_history_metadata(
            action_type,
            phase.elapsed(),
            phase.success(),
            (!phase.success()).then_some(SESSION_HISTORY_DOWNLOAD_PHASE_TELEMETRY_ERROR),
            metadata,
        );
    }
}

fn record_session_history_materializer_state(
    telemetry: &mut JobTelemetry,
    was_downloading: bool,
    completed_before_restore: bool,
    wait: Duration,
    success: bool,
    metadata: Option<SessionHistoryTelemetryMetadata>,
) {
    if !was_downloading {
        return;
    }
    if completed_before_restore {
        telemetry.record_with_session_history_metadata(
            "session_history_materializer_completed_before_restore",
            Duration::ZERO,
            success,
            (!success).then_some(SESSION_HISTORY_MATERIALIZATION_WAIT_TELEMETRY_ERROR),
            metadata,
        );
    } else {
        telemetry.record_with_session_history_metadata(
            "session_history_materializer_waited_at_restore",
            wait,
            success,
            (!success).then_some(SESSION_HISTORY_MATERIALIZATION_WAIT_TELEMETRY_ERROR),
            metadata,
        );
    }
}

fn record_session_history_restore_fallback(
    telemetry: &mut JobTelemetry,
    fallback: Option<SessionHistoryRestoreFallback>,
) {
    if let Some(fallback) = fallback {
        telemetry.record(fallback.action_type(), Duration::ZERO, true, None);
        if let Some(reason) = fallback.identity_mismatch_reason() {
            record_session_history_identity_mismatch_reason(telemetry, reason);
        }
        if matches!(fallback, SessionHistoryRestoreFallback::MissingIdleIdentity) {
            telemetry.record(
                "session_history_identity_reuse_missing",
                Duration::ZERO,
                true,
                None,
            );
            record_session_history_identity_reason(
                telemetry,
                SessionHistoryIdentityReason::ReuseMissingNoIdleIdentity,
            );
        }
    }
}

fn record_workspace_session_history_phase(
    telemetry: &mut JobTelemetry,
    action_type: &'static str,
    phase: Option<WorkspaceSessionHistoryPhaseTiming>,
) {
    if let Some(phase) = phase {
        telemetry.record(
            action_type,
            phase.elapsed(),
            phase.success(),
            (!phase.success()).then_some(WORKSPACE_SESSION_HISTORY_PHASE_TELEMETRY_ERROR),
        );
    }
}

fn record_workspace_session_history_timings(
    telemetry: &mut JobTelemetry,
    timings: WorkspaceSessionHistoryTimings,
) {
    record_workspace_session_history_phase(
        telemetry,
        "session_history_workspace_cache_file_read",
        timings.file_read(),
    );
    if let Some(wait) = timings.cpu_admission_wait() {
        telemetry.record(
            "session_history_workspace_cache_cpu_pool_wait",
            wait,
            true,
            None,
        );
    }
    record_workspace_session_history_phase(
        telemetry,
        "session_history_workspace_cache_materialization",
        timings.materialization(),
    );
}

async fn materialize_inline_resume_session(
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: &CancellationToken,
) -> RunnerResult<Option<MaterializedResumeSession>> {
    let Some(resume_session) = context.resume_session.as_ref() else {
        return Ok(None);
    };
    let Some(history) = resume_session.shared_session_history() else {
        return Ok(None);
    };
    if effective_cli_framework(&context.cli_agent_type)
        == super::cli_framework::EffectiveCliFramework::Codex
    {
        let outcome = config
            .session_history_cpu
            .materialize(
                SessionHistoryCpuJob::inline_codex(
                    resume_session.cli_agent_session_id.clone(),
                    history,
                ),
                cancel,
            )
            .await?;
        return outcome
            .result
            .map(|materialization| Some(materialization.session));
    }
    Ok(Some(MaterializedResumeSession::new_shared(
        resume_session.cli_agent_session_id.clone(),
        history,
        None,
    )))
}

pub(super) fn build_agent_start_command(run_agent_path: &str) -> String {
    let run_agent_path = quote_shell_arg(run_agent_path);
    format!(
        "if [ ! -e {run_agent_path} ]; then \
            printf '%s\\n' 'agent bootstrap failed: guest-agent is missing' >&2; \
            exit 127; \
        fi; \
        if [ ! -f {run_agent_path} ]; then \
            printf '%s\\n' 'agent bootstrap failed: guest-agent is not a regular file' >&2; \
            exit 126; \
        fi; \
        if [ ! -x {run_agent_path} ]; then \
            printf '%s\\n' 'agent bootstrap failed: guest-agent is not executable' >&2; \
            exit 126; \
        fi; \
        exec {run_agent_path} 2>&1"
    )
}

fn validate_agent_bootstrap_exec_boundary(
    agent_cmd: &str,
    env_pairs: &[(String, String)],
) -> RunnerResult<()> {
    let mut values = Vec::with_capacity(env_pairs.len() + 3);
    values.push(guest_contracts::exec_limits::ExecBoundaryValue::arg(
        "argv[0]",
        "/bin/bash",
    ));
    values.push(guest_contracts::exec_limits::ExecBoundaryValue::arg(
        "argv[1]", "-c",
    ));
    values.push(guest_contracts::exec_limits::ExecBoundaryValue::arg(
        "argv[2] bootstrap command",
        agent_cmd,
    ));
    for (key, value) in env_pairs {
        values.push(guest_contracts::exec_limits::ExecBoundaryValue::env(
            key.as_str(),
            value,
        ));
    }

    guest_contracts::exec_limits::validate_exec_boundary_sizes(values).map_err(|error| {
        RunnerError::Internal(format!("guest-agent bootstrap argv/env too large: {error}"))
    })
}

async fn verify_restored_session_identity_for_reuse(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    identity: RestoredSessionIdentity,
) -> Result<RestoredSessionIdentity, SessionHistoryIdentityReason> {
    let Some(requested_identity) = RestoredSessionIdentity::from_context(context) else {
        debug!(
            run_id = %context.run_id,
            "restored session identity cannot be verified without a valid hash-backed resume request"
        );
        return Err(SessionHistoryIdentityReason::VerifyRequestMissing);
    };
    if identity != requested_identity {
        debug!(
            run_id = %context.run_id,
            "restored session identity invalidated because it does not match the resume request"
        );
        return Err(SessionHistoryIdentityReason::VerifyRequestMismatch);
    }
    let Some(verification) = identity.final_metadata_verification() else {
        debug!(
            run_id = %context.run_id,
            "restored session identity cannot be verified without a final metadata verifier"
        );
        return Err(SessionHistoryIdentityReason::VerifyMissingVerifier);
    };
    if !identity.is_verified_match_for_request(&requested_identity) {
        return Err(SessionHistoryIdentityReason::VerifyRequestMismatch);
    }

    let RestoredSessionFinalMetadataVerification {
        metadata_path,
        runtime_dir,
        framework,
        session_id_hash,
        history_ref_kind,
        history_hash,
        history_size_bytes,
    } = verification;
    let metadata_path = metadata_path.to_owned();
    let runtime_dir = runtime_dir.to_owned();
    let command = build_final_identity_verify_command(
        guest::RUN_AGENT,
        &metadata_path,
        framework.as_str(),
        session_id_hash,
        history_ref_kind.as_str(),
        history_hash,
        history_size_bytes,
    );
    verify_final_identity_metadata(sandbox, context, identity, command, &runtime_dir).await
}

async fn verify_final_identity_metadata(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    identity: RestoredSessionIdentity,
    command: String,
    runtime_dir: &str,
) -> Result<RestoredSessionIdentity, SessionHistoryIdentityReason> {
    let env = [(
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        runtime_dir,
    )];
    let request = ExecRequest {
        cmd: &command,
        timeout: SESSION_HISTORY_IDENTITY_VERIFY_TIMEOUT,
        env: &env,
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
    };
    match sandbox
        .exec_with_diagnostic_label(&request, "session-history-identity-verify")
        .await
    {
        Ok(result) if helper_exec_succeeded(&result) => Ok(identity),
        Ok(result) => {
            debug!(
                run_id = %context.run_id,
                termination = %helper_exec_termination_label(&result),
                "restored session identity final metadata verification failed"
            );
            Err(session_history_identity_reason_from_helper_result(&result))
        }
        Err(_) => {
            debug!(
                run_id = %context.run_id,
                "restored session identity final metadata verification errored"
            );
            Err(SessionHistoryIdentityReason::VerifyHelperExecError)
        }
    }
}

fn session_history_identity_reason_from_helper_result(
    result: &sandbox::ExecResult,
) -> SessionHistoryIdentityReason {
    match result.termination {
        ExecTermination::TimedOut => SessionHistoryIdentityReason::VerifyHelperTimedOut,
        ExecTermination::Exited { exit_code } => match exit_code {
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS => {
                SessionHistoryIdentityReason::VerifyHelperInvalidArgs
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ => {
                SessionHistoryIdentityReason::VerifyHelperMetadataRead
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA => {
                SessionHistoryIdentityReason::VerifyHelperInvalidMetadata
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH => {
                SessionHistoryIdentityReason::VerifyHelperFrameworkMismatch
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH => {
                SessionHistoryIdentityReason::VerifyHelperExpectedMismatch
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ => {
                SessionHistoryIdentityReason::VerifyHelperHistoryRead
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH => {
                SessionHistoryIdentityReason::VerifyHelperHistoryMismatch
            }
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE => {
                SessionHistoryIdentityReason::VerifyHelperHistoryTooLarge
            }
            _ => SessionHistoryIdentityReason::VerifyHelperFailed,
        },
        ExecTermination::Cancelled | ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            SessionHistoryIdentityReason::VerifyHelperFailed
        }
    }
}

fn build_final_identity_verify_command(
    run_agent_path: &str,
    metadata_path: &str,
    framework: &str,
    session_id_hash: &str,
    history_ref_kind: &str,
    history_hash: &str,
    history_size_bytes: u64,
) -> String {
    let args = [
        quote_shell_arg(run_agent_path),
        "verify-session-history-identity".to_string(),
        quote_shell_arg(metadata_path),
        quote_shell_arg(framework),
        quote_shell_arg(session_id_hash),
        quote_shell_arg(history_ref_kind),
        quote_shell_arg(history_hash),
        history_size_bytes.to_string(),
    ];
    args.join(" ")
}

async fn read_final_session_history_identity(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
) -> Result<RestoredSessionIdentity, SessionHistoryIdentityReason> {
    let metadata_path = match guest_runtime_path(
        context.run_id,
        guest_contracts::runtime_paths::final_session_history_identity_file,
    ) {
        Ok(path) => path,
        Err(error) => {
            debug!(
                run_id = %context.run_id,
                error = %error,
                "final session history identity path could not be resolved"
            );
            return Err(SessionHistoryIdentityReason::FinalizeMetadataPathUnresolved);
        }
    };
    let runtime_dir = match guest_runtime_dir(context.run_id) {
        Ok(path) => path,
        Err(error) => {
            debug!(
                run_id = %context.run_id,
                error = %error,
                "guest runtime dir could not be resolved for final session history identity"
            );
            return Err(SessionHistoryIdentityReason::FinalizeRuntimeDirUnresolved);
        }
    };
    let bytes = match sandbox
        .read_file(&metadata_path, FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT)
        .await
    {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(SessionHistoryIdentityReason::FinalizeMissingMetadata),
        Err(_) => {
            debug!(
                run_id = %context.run_id,
                "final session history identity metadata read failed"
            );
            return Err(SessionHistoryIdentityReason::FinalizeMetadataReadFailed);
        }
    };
    let metadata = match FinalSessionHistoryIdentity::from_json_slice(&bytes) {
        Ok(metadata) => metadata,
        Err(error) => {
            debug!(
                run_id = %context.run_id,
                error = %error,
                "final session history identity metadata was invalid"
            );
            return Err(SessionHistoryIdentityReason::from_final_metadata_error(
                error,
            ));
        }
    };
    RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
        .ok_or(SessionHistoryIdentityReason::FinalizeUnverifiableMetadata)
}

#[derive(Clone, Copy)]
pub(super) struct ProcessCancelTimeouts {
    pub(super) write: Duration,
    pub(super) terminal_grace: Duration,
    pub(super) cooperative_grace: Duration,
}

pub(super) struct AgentExecutionResult {
    pub(super) failure: Option<ExecutionFailure>,
    pub(super) stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
    pub(super) reusable_session_identity: Option<RestoredSessionIdentity>,
}

impl AgentExecutionResult {
    pub(super) fn success() -> Self {
        Self {
            failure: None,
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
            reusable_session_identity: None,
        }
    }

    pub(super) fn failure(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        Self {
            failure: Some(ExecutionFailure::new(exit_code, error, diagnostic)),
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
            reusable_session_identity: None,
        }
    }

    pub(super) fn failure_from_error(error: impl Into<String>) -> Self {
        Self::failure(1, error, None)
    }

    pub(super) fn cancelled() -> Self {
        Self {
            failure: Some(ExecutionFailure::cancelled()),
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
            reusable_session_identity: None,
        }
    }

    pub(super) fn with_stdout_stream_diagnostics(
        mut self,
        diagnostics: AgentStdoutStreamDiagnostics,
    ) -> Self {
        self.stdout_stream_diagnostics = diagnostics;
        self
    }

    pub(super) fn with_reusable_session_identity(
        mut self,
        reusable_session_identity: Option<RestoredSessionIdentity>,
    ) -> Self {
        self.reusable_session_identity = reusable_session_identity;
        self
    }

    pub(super) fn with_resource_diagnostics(
        mut self,
        resource_diagnostics: Option<ResourceFailureDiagnostics>,
    ) -> Self {
        if let Some(failure) = self.failure.take() {
            self.failure = Some(failure.with_resource_diagnostics(resource_diagnostics));
        }
        self
    }

    #[must_use]
    pub(super) fn with_resource_failure_kind(mut self, kind: ResourceFailureKind) -> Self {
        if let Some(failure) = self.failure.take() {
            self.failure = Some(failure.with_resource_diagnostics(Some(
                ResourceFailureDiagnostics::from_failure_kind(kind),
            )));
        }
        self
    }
}
pub(super) fn cancelled_agent_process_exit(
    guest_pid: u32,
    stream_overflowed: bool,
) -> sandbox::ProcessExit {
    let mut exit = sandbox::ProcessExit::new(guest_pid, EXIT_SIGKILL, Vec::new(), Vec::new());
    exit.termination = ExecTermination::Cancelled;
    exit.stream_overflowed = stream_overflowed;
    exit
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CancellationDisposition {
    None,
    Cooperative,
    HardFallback,
}

impl CancellationDisposition {
    fn observed(self) -> bool {
        self != Self::None
    }

    fn used_hard_fallback(self) -> bool {
        self == Self::HardFallback
    }
}

struct ProcessWaitOutcome {
    result: sandbox::Result<sandbox::ProcessExit>,
    cancellation: CancellationDisposition,
    abort_stdout_drain: bool,
}

impl ProcessWaitOutcome {
    fn normal(result: sandbox::Result<sandbox::ProcessExit>) -> Self {
        let abort_stdout_drain = result.is_err();
        Self {
            result,
            cancellation: CancellationDisposition::None,
            abort_stdout_drain,
        }
    }

    fn cooperative(exit: sandbox::ProcessExit) -> Self {
        Self {
            result: Ok(exit),
            cancellation: CancellationDisposition::Cooperative,
            abort_stdout_drain: false,
        }
    }

    fn hard_fallback(
        guest_process_pid: u32,
        stream_overflowed: bool,
        abort_stdout_drain: bool,
    ) -> Self {
        Self {
            result: Ok(cancelled_agent_process_exit(
                guest_process_pid,
                stream_overflowed,
            )),
            cancellation: CancellationDisposition::HardFallback,
            abort_stdout_drain,
        }
    }
}

async fn request_guest_process_cancel(
    run_id: crate::ids::RunId,
    guest_process_pid: u32,
    process_cancel: &mut Option<GuestProcessCancelHandle>,
    timeout: Duration,
) -> bool {
    let Some(process_cancel) = process_cancel.take() else {
        warn!(
            run_id = %run_id,
            pid = guest_process_pid,
            "sandbox does not support guest process cancellation"
        );
        return false;
    };
    match process_cancel.cancel(timeout).await {
        Ok(()) => true,
        Err(error) => {
            warn!(
                run_id = %run_id,
                pid = guest_process_pid,
                error = %error,
                "failed to send guest process cancellation"
            );
            false
        }
    }
}

async fn force_cancel_guest_process<F>(
    run_id: crate::ids::RunId,
    guest_process_pid: u32,
    process_cancel: &mut Option<GuestProcessCancelHandle>,
    process_cancel_timeouts: ProcessCancelTimeouts,
    mut wait_process: Pin<&mut F>,
) -> ProcessWaitOutcome
where
    F: Future<Output = sandbox::Result<sandbox::ProcessExit>>,
{
    if !request_guest_process_cancel(
        run_id,
        guest_process_pid,
        process_cancel,
        process_cancel_timeouts.write,
    )
    .await
    {
        return ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true);
    }

    match tokio::time::timeout(
        process_cancel_timeouts.terminal_grace,
        wait_process.as_mut(),
    )
    .await
    {
        Ok(Ok(exit)) => {
            info!(
                run_id = %run_id,
                pid = guest_process_pid,
                "cancelled guest process reached terminal status"
            );
            ProcessWaitOutcome::hard_fallback(guest_process_pid, exit.stream_overflowed, false)
        }
        Ok(Err(error)) => {
            warn!(
                run_id = %run_id,
                pid = guest_process_pid,
                error = %error,
                "guest process wait failed after cancellation"
            );
            ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true)
        }
        Err(_) => {
            warn!(
                run_id = %run_id,
                pid = guest_process_pid,
                timeout_ms = process_cancel_timeouts.terminal_grace.as_millis(),
                "timed out waiting for cancelled guest process"
            );
            ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true)
        }
    }
}

async fn send_cooperative_user_cancellation(
    run_id: crate::ids::RunId,
    process_control: Option<&GuestProcessControlHandle>,
    hard_cancel: &CancellationToken,
    timeout: Duration,
) -> bool {
    let Some(process_control) = process_control else {
        warn!(
            run_id = %run_id,
            "guest process does not support cooperative user cancellation"
        );
        return false;
    };
    let message_id = format!("user-cancellation:{run_id}");
    tokio::select! {
        biased;
        () = hard_cancel.cancelled() => false,
        result = process_control.control(
            &message_id,
            USER_CANCELLATION_CONTROL_PAYLOAD,
            timeout,
        ) => {
            match result {
                Ok(ack) if ack.message_id == message_id => true,
                Ok(ack) => {
                    warn!(
                        run_id = %run_id,
                        expected_message_id = %message_id,
                        acknowledged_message_id = %ack.message_id,
                        "guest acknowledged the wrong user-cancellation message"
                    );
                    false
                }
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        error = %error,
                        "failed to send cooperative user cancellation"
                    );
                    false
                }
            }
        }
    }
}

async fn wait_for_cooperative_user_cancellation<F>(
    run_id: crate::ids::RunId,
    guest_process_pid: u32,
    process_control: Option<&GuestProcessControlHandle>,
    process_cancel: &mut Option<GuestProcessCancelHandle>,
    hard_cancel: &CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
    mut wait_process: Pin<&mut F>,
) -> ProcessWaitOutcome
where
    F: Future<Output = sandbox::Result<sandbox::ProcessExit>>,
{
    if !send_cooperative_user_cancellation(
        run_id,
        process_control,
        hard_cancel,
        process_cancel_timeouts.write,
    )
    .await
    {
        return force_cancel_guest_process(
            run_id,
            guest_process_pid,
            process_cancel,
            process_cancel_timeouts,
            wait_process,
        )
        .await;
    }

    tokio::select! {
        biased;
        result = wait_process.as_mut() => {
            match result {
                Ok(exit) => {
                    info!(
                        run_id = %run_id,
                        pid = guest_process_pid,
                        "guest completed cooperative user cancellation"
                    );
                    ProcessWaitOutcome::cooperative(exit)
                }
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        pid = guest_process_pid,
                        error = %error,
                        "guest process wait failed during cooperative cancellation"
                    );
                    request_guest_process_cancel(
                        run_id,
                        guest_process_pid,
                        process_cancel,
                        process_cancel_timeouts.write,
                    )
                    .await;
                    ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true)
                }
            }
        }
        () = hard_cancel.cancelled() => {
            info!(
                run_id = %run_id,
                "hard cancellation preempted cooperative user cancellation"
            );
            force_cancel_guest_process(
                run_id,
                guest_process_pid,
                process_cancel,
                process_cancel_timeouts,
                wait_process,
            )
            .await
        }
        () = tokio::time::sleep(process_cancel_timeouts.cooperative_grace) => {
            warn!(
                run_id = %run_id,
                timeout_ms = process_cancel_timeouts.cooperative_grace.as_millis(),
                "cooperative user cancellation timed out"
            );
            force_cancel_guest_process(
                run_id,
                guest_process_pid,
                process_cancel,
                process_cancel_timeouts,
                wait_process,
            )
            .await
        }
    }
}

fn wait_process_timed_out(error: &sandbox::SandboxError) -> bool {
    matches!(
        error,
        sandbox::SandboxError::Operation {
            operation: sandbox::SandboxOperation::WaitProcess,
            reason: sandbox::SandboxOperationReason::Timeout,
            ..
        }
    ) || matches!(
        error,
        sandbox::SandboxError::Io(error) if error.kind() == std::io::ErrorKind::TimedOut
    )
}

fn process_exit_code(exit: &sandbox::ProcessExit) -> Option<i32> {
    match exit.termination {
        ExecTermination::Exited { exit_code } => Some(exit_code),
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => None,
    }
}

fn process_failed(exit: &sandbox::ProcessExit) -> bool {
    !matches!(exit.termination, ExecTermination::Exited { exit_code: 0 })
}

fn diagnostic_is_agent_execution_timeout(diagnostic: Option<&FailureDiagnostic>) -> bool {
    diagnostic
        .and_then(|diagnostic| diagnostic.cli_termination.as_ref())
        .is_some_and(|termination| termination.reason == CliTerminationReason::ExecutionTimeout)
}

fn process_exit_oom_candidate(exit: &sandbox::ProcessExit) -> bool {
    matches!(
        exit.termination,
        ExecTermination::Exited {
            exit_code: EXIT_SIGKILL | EXIT_SIGNAL_KILL
        }
    )
}

fn process_failure_exit_code(exit: &sandbox::ProcessExit) -> i32 {
    match exit.termination {
        ExecTermination::Exited { exit_code } => normalize_failure_exit_code(exit_code),
        ExecTermination::TimedOut => JOB_TIMEOUT_EXIT_CODE,
        ExecTermination::Cancelled | ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            1
        }
    }
}

fn process_failure_stderr(exit: &sandbox::ProcessExit) -> String {
    let mut stderr = String::from_utf8_lossy(&exit.stderr).to_string();
    match exit.termination {
        ExecTermination::TimedOut => {
            if stderr.is_empty() {
                return "Timeout".to_string();
            }
        }
        ExecTermination::Cancelled => {
            if stderr.is_empty() {
                stderr.push_str("Cancelled");
            }
            append_process_diagnostic(&mut stderr, &exit.diagnostic);
        }
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            append_process_diagnostic(&mut stderr, &exit.diagnostic);
        }
        ExecTermination::Exited { .. } => {}
    }

    stderr
}

fn append_process_diagnostic(stderr: &mut String, diagnostic: &str) {
    if diagnostic.is_empty() {
        return;
    }
    if !stderr.is_empty() && !stderr.ends_with('\n') {
        stderr.push('\n');
    }
    stderr.push_str(diagnostic);
}

/// How this run is entering its sandbox. Each field feeds a distinct step:
/// `restore_guest_state` gates clock/entropy repair, `prev_storage` enables
/// the download-skip optimization on reuse, and `reuse_result` is forwarded
/// to the guest for /complete metadata.
pub(super) struct RunStart<'a> {
    pub(super) restore_guest_state: bool,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) prev_storage: Option<&'a crate::storage_fingerprints::StorageFingerprints>,
}

pub(super) struct RunControls {
    pub(super) cancel: CancellationToken,
    pub(super) cooperative_user_cancel: CancellationToken,
    pub(super) hard_cancel: CancellationToken,
    pub(super) active_input_source: Option<ActiveInputSource>,
    pub(super) spawn_timing: Option<RunnerSpawnTiming>,
    pub(super) session_history_restore_plan: SessionHistoryRestorePlan,
    pub(super) prepared_storage: Option<crate::storage_cache::PreparedFreshStorage>,
    pub(super) prepared_guest_runtime: Option<PreparedGuestRuntime>,
}

pub(super) enum PreparedGuestRuntime {
    Ready(StartedCodexModelCatalogPrefetch),
    Failed(RunnerError),
    Cancelled,
}

impl PreparedGuestRuntime {
    pub(super) async fn prepare_for_codex_model_catalog_prefetch(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        restore_guest_state: bool,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
    ) -> Option<Self> {
        if !is_codex_model_catalog_prefetch_eligible(context, reuse_result) {
            return None;
        }

        Some(
            Self::prepare(
                sandbox,
                context,
                restore_guest_state,
                reuse_result,
                cancel,
                telemetry,
            )
            .await,
        )
    }

    async fn prepare(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        restore_guest_state: bool,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
    ) -> Self {
        match prepare_guest_runtime_state_phase(
            sandbox,
            context,
            restore_guest_state,
            cancel,
            telemetry,
        )
        .await
        {
            GuestRuntimeStatePreparation::Ready => Self::Ready(
                StartedCodexModelCatalogPrefetch::start(sandbox, context, reuse_result, cancel)
                    .await,
            ),
            GuestRuntimeStatePreparation::Failed(error) => Self::Failed(error),
            GuestRuntimeStatePreparation::Cancelled => Self::Cancelled,
        }
    }

    pub(super) async fn finish(self, sandbox: &dyn Sandbox, telemetry: &mut JobTelemetry) {
        if let Self::Ready(prefetch) = self {
            prefetch.finish(sandbox, telemetry).await;
        }
    }
}

impl RunControls {
    #[cfg(test)]
    pub(super) fn new(
        cancel: CancellationToken,
        active_input_source: Option<ActiveInputSource>,
    ) -> Self {
        Self::from_cancellation(
            crate::run_cancellation::RunCancellationSignals::hard_only(cancel),
            active_input_source,
        )
    }

    pub(super) fn from_cancellation(
        cancellation: crate::run_cancellation::RunCancellationSignals,
        active_input_source: Option<ActiveInputSource>,
    ) -> Self {
        Self {
            cancel: cancellation.any(),
            cooperative_user_cancel: cancellation.cooperative_user(),
            hard_cancel: cancellation.hard(),
            active_input_source,
            spawn_timing: None,
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
            prepared_storage: None,
            prepared_guest_runtime: None,
        }
    }

    pub(super) fn with_spawn_timing(mut self, spawn_timing: RunnerSpawnTiming) -> Self {
        self.spawn_timing = Some(spawn_timing);
        self
    }

    pub(super) fn with_session_history_restore_plan(
        mut self,
        plan: SessionHistoryRestorePlan,
    ) -> Self {
        self.session_history_restore_plan = plan;
        self
    }
}

struct PreparedAgentProcess {
    handle: GuestProcessHandle,
    agent_started_at: Instant,
    deferred_background_fill: Option<crate::storage_cache::DeferredBackgroundFill>,
    session_restore_diagnostics: Option<SessionRestoreDiagnostics>,
    pre_run_restored_session_identity: Option<RestoredSessionIdentity>,
    env_diagnostics: AgentEnvDiagnostics,
    env_pairs: Vec<(String, String)>,
}

async fn run_pre_spawn_phase<T>(
    cancel: &CancellationToken,
    phase: impl Future<Output = T>,
) -> Option<T> {
    if cancel.is_cancelled() {
        return None;
    }

    tokio::select! {
        biased;
        result = phase => Some(result),
        () = cancel.cancelled() => None,
    }
}

fn record_storage_plan_state(
    plan: &StoragePlan,
    previous_storage: bool,
    planning_started: Instant,
    telemetry: &mut JobTelemetry,
) {
    if previous_storage {
        telemetry.record(
            "runner_storage_manifest_fingerprint_reuse",
            planning_started.elapsed(),
            true,
            None,
        );
    }
    if plan.reused_entries() > 0 {
        info!(
            skipped = plan.reused_entries(),
            total = plan.entry_count(),
            "filtered unchanged manifest entries"
        );
    }
    if plan.cleanup_path_count() > 0 {
        info!(
            count = plan.cleanup_path_count(),
            "computed cleanup paths for stale file removal"
        );
    }
    if plan.instruction_cleanup_count() > 0 {
        info!(
            count = plan.instruction_cleanup_count(),
            "computed instruction cleanup entries for stale file removal"
        );
    }
}

async fn populate_storage_plan(
    plan: &mut StoragePlan,
    fresh_delivery: Option<&mut crate::storage_cache::FreshArchiveDelivery>,
    sandbox: &dyn Sandbox,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<crate::storage_cache::DeferredBackgroundFill>> {
    let cache_started = Instant::now();
    let result = crate::storage_cache::populate_cache_with_fresh_delivery(
        plan,
        sandbox,
        &config.home,
        telemetry,
        fresh_delivery,
    )
    .await;
    telemetry.record(
        "runner_storage_manifest_cache_populate",
        cache_started.elapsed(),
        result.is_ok(),
        result.is_err().then_some(STORAGE_CACHE_POPULATE_FAILED),
    );
    result
}

enum GuestRuntimeStatePreparation {
    Ready,
    Failed(RunnerError),
    Cancelled,
}

async fn prepare_guest_runtime_state(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    restore_guest_state_required: bool,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    if restore_guest_state_required {
        let started = Instant::now();
        let result = restore_guest_state(sandbox, context).await;
        let error = result.as_ref().err().map(ToString::to_string);
        telemetry.record(
            "runner_guest_state_restore",
            started.elapsed(),
            result.is_ok(),
            error.as_deref(),
        );
        result?;
    } else {
        let started = Instant::now();
        sync_guest_timezone(sandbox, context).await;
        telemetry.record("runner_guest_timezone_sync", started.elapsed(), true, None);
    }
    Ok(())
}

async fn prepare_guest_runtime_state_phase(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    restore_guest_state_required: bool,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> GuestRuntimeStatePreparation {
    match run_pre_spawn_phase(
        cancel,
        prepare_guest_runtime_state(sandbox, context, restore_guest_state_required, telemetry),
    )
    .await
    {
        Some(Ok(())) => GuestRuntimeStatePreparation::Ready,
        Some(Err(error)) => GuestRuntimeStatePreparation::Failed(error),
        None => GuestRuntimeStatePreparation::Cancelled,
    }
}

async fn prepare_guest_storage(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: &RunStart<'_>,
    telemetry: &mut JobTelemetry,
    prepared_storage: &mut Option<crate::storage_cache::PreparedFreshStorage>,
) -> RunnerResult<Option<crate::storage_cache::DeferredBackgroundFill>> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(None);
    };
    let apply_started = Instant::now();
    let planning_started = Instant::now();

    let result: RunnerResult<Option<crate::storage_cache::DeferredBackgroundFill>> = async {
        if let Some(prepared) = prepared_storage.as_mut() {
            record_storage_plan_state(
                &prepared.plan,
                start.prev_storage.is_some(),
                planning_started,
                telemetry,
            );
            let has_work = prepared.plan.requires_guest_work();
            telemetry.record(
                "runner_storage_manifest_has_work",
                Duration::ZERO,
                true,
                None,
            );
            if !has_work {
                info!(run_id = %context.run_id, "storage manifest has no download work, skipping download");
                prepared.delivery.cancel_and_drain(telemetry).await;
                let _ = prepared_storage.take();
                Ok(None)
            } else {
                let deferred = populate_storage_plan(
                    &mut prepared.plan,
                    Some(&mut prepared.delivery),
                    sandbox,
                    config,
                    telemetry,
                )
                .await?;
                let prepared = prepared_storage.take().ok_or_else(|| {
                    RunnerError::Internal(
                        "prepared storage disappeared after cache population".into(),
                    )
                })?;
                let guest_manifest = prepared.plan.into_guest_manifest();
                let download_started = Instant::now();
                let download_result = download_storages(sandbox, context, &guest_manifest).await;
                telemetry.record(
                    "runner_storage_manifest_guest_download",
                    download_started.elapsed(),
                    download_result.is_ok(),
                    download_result.is_err().then_some(STORAGE_DOWNLOAD_FAILED),
                );
                download_result.map(|()| deferred)
            }
        } else {
            let runtime_dir = guest_runtime_dir(context.run_id)?;
            let mut plan = build_storage_plan(manifest, runtime_dir.as_str(), start.prev_storage)?;
            record_storage_plan_state(
                &plan,
                start.prev_storage.is_some(),
                planning_started,
                telemetry,
            );
            let has_work = plan.requires_guest_work();
            telemetry.record(
                "runner_storage_manifest_has_work",
                Duration::ZERO,
                true,
                None,
            );
            if !has_work {
                info!(run_id = %context.run_id, "storage manifest has no download work, skipping download");
                Ok(None)
            } else {
                let deferred =
                    populate_storage_plan(&mut plan, None, sandbox, config, telemetry).await?;
                let guest_manifest = plan.into_guest_manifest();
                let download_started = Instant::now();
                let download_result = download_storages(sandbox, context, &guest_manifest).await;
                telemetry.record(
                    "runner_storage_manifest_guest_download",
                    download_started.elapsed(),
                    download_result.is_ok(),
                    download_result.is_err().then_some(STORAGE_DOWNLOAD_FAILED),
                );
                download_result.map(|()| deferred)
            }
        }
    }
    .await;

    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_storage_manifest_apply",
        apply_started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}

pub(super) async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    controls: RunControls,
) -> RunnerResult<AgentExecutionResult> {
    run_in_sandbox_with_process_cancel_timeouts(
        sandbox,
        context,
        config,
        start,
        telemetry,
        controls,
        PROCESS_CANCEL_TIMEOUTS,
    )
    .await
}

pub(super) async fn run_in_sandbox_with_process_cancel_timeouts(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    controls: RunControls,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> RunnerResult<AgentExecutionResult> {
    let RunControls {
        cancel,
        cooperative_user_cancel,
        hard_cancel,
        active_input_source,
        spawn_timing,
        session_history_restore_plan,
        mut prepared_storage,
        prepared_guest_runtime,
    } = controls;
    let has_active_input_source = active_input_source.is_some();
    let pre_spawn_started = Instant::now();
    let prepared_guest_runtime = match prepared_guest_runtime {
        Some(prepared) => prepared,
        None => {
            PreparedGuestRuntime::prepare(
                sandbox,
                context,
                start.restore_guest_state,
                start.reuse_result,
                &cancel,
                telemetry,
            )
            .await
        }
    };
    let mut model_catalog_prefetch = match prepared_guest_runtime {
        PreparedGuestRuntime::Ready(prefetch) => prefetch.supervise(sandbox),
        PreparedGuestRuntime::Failed(error) => {
            if let Some(prepared) = prepared_storage.as_mut() {
                prepared.delivery.cancel_and_drain(telemetry).await;
            }
            return Err(error);
        }
        PreparedGuestRuntime::Cancelled => {
            if let Some(prepared) = prepared_storage.as_mut() {
                prepared.delivery.cancel_and_drain(telemetry).await;
            }
            info!(
                run_id = %context.run_id,
                "cancel received before guest process started"
            );
            let result = AgentExecutionResult::cancelled();
            telemetry.record(
                "agent_execute",
                pre_spawn_started.elapsed(),
                false,
                result
                    .failure
                    .as_ref()
                    .map(|failure| failure.error.as_str()),
            );
            return Ok(result);
        }
    };
    model_catalog_prefetch.record_outcome(telemetry);
    let storage_result = model_catalog_prefetch
        .race(run_pre_spawn_phase(
            &cancel,
            prepare_guest_storage(
                sandbox,
                context,
                config,
                &start,
                telemetry,
                &mut prepared_storage,
            ),
        ))
        .await;
    model_catalog_prefetch.record_outcome(telemetry);
    let deferred_background_fill = match storage_result {
        Some(Ok(deferred)) => deferred,
        Some(Err(error)) => {
            if let Some(prepared) = prepared_storage.as_mut() {
                prepared.delivery.cancel_and_drain(telemetry).await;
            }
            model_catalog_prefetch.finish(telemetry).await;
            return Err(error);
        }
        None => {
            if let Some(prepared) = prepared_storage.as_mut() {
                prepared.delivery.cancel_and_drain(telemetry).await;
            }
            model_catalog_prefetch.finish(telemetry).await;
            info!(
                run_id = %context.run_id,
                "cancel received before guest process started"
            );
            let result = AgentExecutionResult::cancelled();
            telemetry.record(
                "agent_execute",
                pre_spawn_started.elapsed(),
                false,
                result
                    .failure
                    .as_ref()
                    .map(|failure| failure.error.as_str()),
            );
            return Ok(result);
        }
    };
    let pre_spawn_cancel = cancel.clone();
    let pre_spawn_start = &start;
    let pre_spawn_telemetry = &mut *telemetry;
    let prepared_agent = model_catalog_prefetch
        .race(run_pre_spawn_phase(&cancel, async move {
            let cancel = pre_spawn_cancel;
            let start = pre_spawn_start;
            let telemetry = pre_spawn_telemetry;
            let deferred_background_fill = deferred_background_fill;

    let mut session_restore_diagnostics = None;
    let mut pre_run_restored_session_identity = None;
    let mut local_session_history_materializer = None;
    let mut session_history_materializer = match session_history_restore_plan {
        SessionHistoryRestorePlan::SkipVerified(identity) => {
            match verify_restored_session_identity_for_reuse(sandbox, context, identity).await {
                Ok(identity) => {
                    telemetry.record(
                        "session_history_identity_reuse_hit",
                        Duration::ZERO,
                        true,
                        None,
                    );
                    telemetry.record("session_history_restore_skip", Duration::ZERO, true, None);
                    pre_run_restored_session_identity = Some(identity);
                    None
                }
                Err(reason) => {
                    telemetry.record(
                        SessionHistoryRestoreFallback::StaleIdleIdentity.action_type(),
                        Duration::ZERO,
                        true,
                        None,
                    );
                    record_session_history_identity_reason(telemetry, reason);
                    Some(SessionHistoryMaterializer::start_cancellable(
                        &config.http,
                        &config.session_history_cpu,
                        context.resume_session.as_ref(),
                        effective_cli_framework(&context.cli_agent_type),
                        cancel.clone(),
                        Some(&config.session_history_probe),
                    ))
                }
            }
        }
        SessionHistoryRestorePlan::DeferredHashBacked { fallback } => {
            record_session_history_restore_fallback(telemetry, fallback);
            Some(SessionHistoryMaterializer::start_cancellable(
                &config.http,
                &config.session_history_cpu,
                context.resume_session.as_ref(),
                effective_cli_framework(&context.cli_agent_type),
                cancel.clone(),
                Some(&config.session_history_probe),
            ))
        }
        SessionHistoryRestorePlan::Default => Some(SessionHistoryMaterializer::start_cancellable(
            &config.http,
            &config.session_history_cpu,
            context.resume_session.as_ref(),
            effective_cli_framework(&context.cli_agent_type),
            cancel.clone(),
            Some(&config.session_history_probe),
        )),
        SessionHistoryRestorePlan::Prestarted {
            materializer,
            fallback,
        } => {
            record_session_history_restore_fallback(telemetry, fallback);
            Some(materializer)
        }
        SessionHistoryRestorePlan::LocalSidecar {
            materializer,
            fallback,
        } => {
            record_session_history_restore_fallback(telemetry, fallback);
            local_session_history_materializer = Some(materializer);
            None
        }
    };
    if let Some(local_materializer) = local_session_history_materializer {
        let completed_before_restore = local_materializer.is_finished();
        let materialization_wait_started = Instant::now();
        let local_materialization = local_materializer.finish(&cancel).await;
        let materialization_wait = if completed_before_restore {
            Duration::ZERO
        } else {
            materialization_wait_started.elapsed()
        };
        let materialization_succeeded = matches!(
            &local_materialization,
            WorkspaceSessionHistoryMaterialization::Materialized { .. }
        );
        telemetry.record(
            "session_history_workspace_cache_materialization_wait",
            materialization_wait,
            materialization_succeeded,
            (!materialization_succeeded).then_some(
                WORKSPACE_SESSION_HISTORY_PHASE_TELEMETRY_ERROR,
            ),
        );
        match local_materialization {
            WorkspaceSessionHistoryMaterialization::Materialized { session, timings } => {
                record_workspace_session_history_timings(telemetry, timings);
                let guest_restore_started = Instant::now();
                let restore_result = restore_session(sandbox, context, &session).await;
                let guest_restore_elapsed = guest_restore_started.elapsed();
                telemetry.record(
                    "session_history_workspace_cache_guest_restore",
                    guest_restore_elapsed,
                    restore_result.is_ok(),
                    restore_result
                        .is_err()
                        .then_some(WORKSPACE_SESSION_HISTORY_PHASE_TELEMETRY_ERROR),
                );
                match restore_result {
                    Ok(diagnostics) => {
                        telemetry.record(
                            "session_history_workspace_cache_restore",
                            timings
                                .host_service_time()
                                .saturating_add(guest_restore_elapsed),
                            true,
                            None,
                        );
                        telemetry.record("session_restore", guest_restore_elapsed, true, None);
                        session_restore_diagnostics = Some(diagnostics);
                    }
                    Err(error) => {
                        telemetry.record(
                            "session_restore",
                            guest_restore_elapsed,
                            false,
                            Some(&error.to_string()),
                        );
                        if cancel.is_cancelled() || matches!(&error, RunnerError::Cancelled) {
                            return Err(error);
                        }
                        telemetry.record(
                            "session_history_workspace_cache_restore",
                            timings
                                .host_service_time()
                                .saturating_add(guest_restore_elapsed),
                            false,
                            Some("restore_error"),
                        );
                        telemetry.record(
                            "session_history_workspace_cache_miss",
                            Duration::ZERO,
                            true,
                            Some("restore_error"),
                        );
                        warn!(
                            run_id = %context.run_id,
                            error = %error,
                            "workspace session history sidecar restore failed; falling back to remote history"
                        );
                        session_history_materializer =
                            Some(SessionHistoryMaterializer::start_cancellable(
                                &config.http,
                                &config.session_history_cpu,
                                context.resume_session.as_ref(),
                                effective_cli_framework(&context.cli_agent_type),
                                cancel.clone(),
                                Some(&config.session_history_probe),
                            ));
                    }
                }
            }
            WorkspaceSessionHistoryMaterialization::Failed { timings, error } => {
                record_workspace_session_history_timings(telemetry, timings);
                if cancel.is_cancelled() || matches!(&error, RunnerError::Cancelled) {
                    return Err(error);
                }
                telemetry.record(
                    "session_history_workspace_cache_restore",
                    timings.host_service_time(),
                    false,
                    Some("materialize_error"),
                );
                telemetry.record(
                    "session_history_workspace_cache_miss",
                    Duration::ZERO,
                    true,
                    Some("materialize_error"),
                );
                warn!(
                    run_id = %context.run_id,
                    error = %error,
                    "workspace session history sidecar materialization failed; falling back to remote history"
                );
                session_history_materializer = Some(SessionHistoryMaterializer::start_cancellable(
                    &config.http,
                    &config.session_history_cpu,
                    context.resume_session.as_ref(),
                    effective_cli_framework(&context.cli_agent_type),
                    cancel.clone(),
                    Some(&config.session_history_probe),
                ));
            }
        }
    }
    if let Some(session_history_materializer) = session_history_materializer {
        // 4. Restore session history. Hash-backed history downloads can start
        // before sandbox preparation, then materialize here right before restore.
        let should_record_materialization_wait = session_history_materializer.is_downloading();
        let materializer_completed_before_restore =
            session_history_materializer.is_download_finished();
        let materialization_wait_started = Instant::now();
        let materialization = session_history_materializer.finish(&cancel).await;
        let materialization_wait = materialization_wait_started.elapsed();
        let downloaded_resume_session = match materialization {
            SessionHistoryMaterialization::Missing => None,
            SessionHistoryMaterialization::NoDownloadNeeded => None,
            SessionHistoryMaterialization::Downloaded {
                session,
                prefix_outcome,
                elapsed,
                timings,
            } => {
                record_session_history_materializer_state(
                    telemetry,
                    should_record_materialization_wait,
                    materializer_completed_before_restore,
                    materialization_wait,
                    true,
                    timings.metadata(),
                );
                if should_record_materialization_wait {
                    telemetry.record_with_session_history_metadata(
                        "session_history_materialization_wait",
                        materialization_wait,
                        true,
                        None,
                        timings.metadata(),
                    );
                }
                telemetry.record_with_session_history_metadata(
                    "session_history_download",
                    elapsed,
                    true,
                    None,
                    timings.metadata(),
                );
                record_session_history_download_timings(telemetry, &timings);
                if let Some(prefix_outcome) = prefix_outcome {
                    record_session_history_prefix_outcome(telemetry, prefix_outcome);
                }
                Some(session)
            }
            SessionHistoryMaterialization::Failed {
                elapsed,
                timings,
                error,
            } => {
                record_session_history_materializer_state(
                    telemetry,
                    should_record_materialization_wait,
                    materializer_completed_before_restore,
                    materialization_wait,
                    false,
                    timings.metadata(),
                );
                if should_record_materialization_wait {
                    telemetry.record_with_session_history_metadata(
                        "session_history_materialization_wait",
                        materialization_wait,
                        false,
                        Some(SESSION_HISTORY_MATERIALIZATION_WAIT_TELEMETRY_ERROR),
                        timings.metadata(),
                    );
                }
                telemetry.record_with_session_history_metadata(
                    "session_history_download",
                    elapsed,
                    false,
                    Some(SESSION_HISTORY_DOWNLOAD_TELEMETRY_ERROR),
                    timings.metadata(),
                );
                record_session_history_download_timings(telemetry, &timings);
                return Err(error);
            }
        };
        let resume_session = match downloaded_resume_session {
            Some(session) => Some(session),
            None => materialize_inline_resume_session(context, config, &cancel).await?,
        };
        if let Some(session) = resume_session {
            let t = Instant::now();
            let result = restore_session(sandbox, context, &session).await;
            let err = result.as_ref().err().map(|e| e.to_string());
            telemetry.record(
                "session_restore",
                t.elapsed(),
                result.is_ok(),
                err.as_deref(),
            );
            let diagnostics = result?;
            session_restore_diagnostics = Some(diagnostics);
        }
    }

    // 5. Build env vars. The guest-agent bootstrap env is runner-owned only;
    // user-provided env is passed through a private guest file and injected
    // into the CLI child after guest-agent has started.
    let user_env_started = Instant::now();
    let user_env_map = build_user_env_json(context);
    let user_env_file = match write_user_env_file(sandbox, context.run_id, &user_env_map).await {
        Ok(user_env_file) => {
            telemetry.record(
                "runner_user_env_write",
                user_env_started.elapsed(),
                true,
                None,
            );
            user_env_file
        }
        Err(error) => {
            telemetry.record(
                "runner_user_env_write",
                user_env_started.elapsed(),
                false,
                None,
            );
            return Err(error);
        }
    };
    let env_build_started = Instant::now();
    let run_payload = match build_run_payload_for_run(context) {
        Ok(run_payload) => run_payload,
        Err(error) => {
            telemetry.record(
                "runner_agent_env_build",
                env_build_started.elapsed(),
                false,
                None,
            );
            return Err(error);
        }
    };
    info!(
        run_id = %context.run_id,
        prompt_bytes = run_payload.prompt.len(),
        append_system_prompt_bytes = run_payload.append_system_prompt.len(),
        secret_values_present = !run_payload.secret_values.is_empty(),
        disallowed_tools_bytes = run_payload.disallowed_tools.len(),
        tools_bytes = run_payload.tools.len(),
        settings_bytes = run_payload.settings.len(),
        artifacts_bytes = run_payload.artifacts.len(),
        feature_flags_bytes = run_payload.feature_flags.len(),
        "guest-agent run payload prepared"
    );
    let run_payload_write_started = Instant::now();
    let run_payload_file = match write_run_payload_file(sandbox, context.run_id, &run_payload).await
    {
        Ok(path) => {
            telemetry.record(
                "runner_run_payload_write",
                run_payload_write_started.elapsed(),
                true,
                None,
            );
            path
        }
        Err(error) => {
            telemetry.record(
                "runner_run_payload_write",
                run_payload_write_started.elapsed(),
                false,
                None,
            );
            return Err(error);
        }
    };
    let mut env_map = match build_env_json_for_run(
        context,
        &config.api_url,
        sandbox.id(),
        start.reuse_result,
        has_active_input_source,
    ) {
        Ok(env_map) => env_map,
        Err(error) => {
            telemetry.record(
                "runner_agent_env_build",
                env_build_started.elapsed(),
                false,
                None,
            );
            return Err(error);
        }
    };
    if let Some(path) = user_env_file {
        env_map.insert(USER_ENV_FILE_ENV_KEY.into(), path);
    }
    env_map.insert(
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV.into(),
        run_payload_file,
    );
    let env_diagnostics = build_agent_env_diagnostics(&env_map, &user_env_map);
    let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    telemetry.record(
        "runner_agent_env_build",
        env_build_started.elapsed(),
        true,
        None,
    );
    info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

    // 6. Spawn agent — stdout streamed to host via vsock. guest-agent stderr is
    //    merged into stdout, while a small stderr capture keeps shell/wrapper
    //    startup failures visible when the process exits before guest logging.
    let agent_cmd = build_agent_start_command(guest::RUN_AGENT);
    validate_agent_bootstrap_exec_boundary(&agent_cmd, &env_pairs)?;
    info!(run_id = %context.run_id, "spawning agent");

    // Guest-agent receives JOB_TIMEOUT as the user execution budget. The
    // sandbox supervisor remains a later hard fallback so guest-agent can
    // terminate the CLI and create a recovery checkpoint first.
    let t = Instant::now();
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: &agent_cmd,
            timeout: job_supervisor_timeout(),
            env: &env_refs,
            sudo: false,
            output: ProcessOutputMode::stream_with_stderr_capture(
                AGENT_WRAPPER_STDERR_CAPTURE_LIMIT_BYTES,
            ),
            control: ProcessControlMode::Enabled,
        })
        .await;

    let handle = match handle {
        Ok(h) => {
            let spawned_at = Instant::now();
            telemetry.record(
                "runner_agent_start_process",
                spawned_at.saturating_duration_since(t),
                true,
                None,
            );
            if let Some(spawn_timing) = spawn_timing {
                spawn_timing.record_spawn_success_at(telemetry, spawned_at);
            }
            h
        }
        Err(e) => {
            telemetry.record(
                "runner_agent_start_process",
                t.elapsed(),
                false,
                Some(&e.to_string()),
            );
            telemetry.record("agent_execute", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

            RunnerResult::Ok(PreparedAgentProcess {
                handle,
                agent_started_at: t,
                deferred_background_fill,
                session_restore_diagnostics,
                pre_run_restored_session_identity,
                env_diagnostics,
                env_pairs,
            })
        }))
        .await;
    model_catalog_prefetch.record_outcome(telemetry);
    let prepared_agent = match prepared_agent {
        Some(Ok(prepared_agent)) => prepared_agent,
        Some(Err(RunnerError::Cancelled)) | None => {
            model_catalog_prefetch.finish(telemetry).await;
            info!(
                run_id = %context.run_id,
                "cancel received before guest process started"
            );
            let result = AgentExecutionResult::cancelled();
            telemetry.record(
                "agent_execute",
                pre_spawn_started.elapsed(),
                false,
                result
                    .failure
                    .as_ref()
                    .map(|failure| failure.error.as_str()),
            );
            return Ok(result);
        }
        Some(Err(error)) => {
            model_catalog_prefetch.finish(telemetry).await;
            return Err(error);
        }
    };
    let PreparedAgentProcess {
        mut handle,
        agent_started_at: t,
        deferred_background_fill,
        session_restore_diagnostics,
        mut pre_run_restored_session_identity,
        env_diagnostics,
        env_pairs,
    } = prepared_agent;

    // Claude Code process has a PID now — record end-to-end startup latency.
    record_api_latency("api_to_spawn", context, telemetry);

    let process_control = handle.control_handle();
    let active_input_forwarder = super::active_input::ActiveInputForwarder::start(
        context.run_id,
        active_input_source,
        process_control.clone(),
        cancel.clone(),
    );

    // Spawn background task to drain stdout chunks and write to the host stream log file.
    let host_log_path = config.log_paths.system_stream_log(context.run_id);
    let stream_task = handle
        .take_stdout_receiver()
        .map(|stdout_rx| tokio::spawn(drain_stdout_to_file(stdout_rx, host_log_path)));

    if let Some(background_fill) = deferred_background_fill {
        background_fill.start(telemetry);
    }

    // 6. Wait for exit or cancellation. A user request first asks guest-agent
    // to checkpoint recovery state and exit; hard cancellation and bounded
    // fallback use the existing supervised-process cancellation path.
    let guest_process_pid = handle.guest_pid;
    let mut process_cancel = handle.take_cancel_handle();
    let wait_process = sandbox.wait_process(handle, job_terminal_wait_timeout());
    tokio::pin!(wait_process);
    let wait_outcome = model_catalog_prefetch
        .race(async {
            tokio::select! {
                biased;
                result = wait_process.as_mut() => {
                    ProcessWaitOutcome::normal(result)
                }
                () = hard_cancel.cancelled() => {
                    info!(run_id = %context.run_id, "hard cancellation received, cancelling guest process");
                    force_cancel_guest_process(
                        context.run_id,
                        guest_process_pid,
                        &mut process_cancel,
                        process_cancel_timeouts,
                        wait_process.as_mut(),
                    )
                    .await
                }
                () = cooperative_user_cancel.cancelled() => {
                    info!(
                        run_id = %context.run_id,
                        "user cancellation received, requesting guest recovery"
                    );
                    wait_for_cooperative_user_cancellation(
                        context.run_id,
                        guest_process_pid,
                        process_control.as_ref(),
                        &mut process_cancel,
                        &hard_cancel,
                        process_cancel_timeouts,
                        wait_process.as_mut(),
                    )
                    .await
                }
            }
        })
        .await;
    model_catalog_prefetch.record_outcome(telemetry);
    let ProcessWaitOutcome {
        result,
        cancellation,
        abort_stdout_drain,
    } = wait_outcome;
    let cancellation_observed = cancellation.observed();
    let used_hard_cancellation_fallback = cancellation.used_hard_fallback();

    if let Some(forwarder) = active_input_forwarder {
        forwarder.stop().await;
    }

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
    model_catalog_prefetch.finish(telemetry).await;
    let stdout_stream_diagnostics_on_wait_error = AgentStdoutStreamDiagnostics {
        bytes_written: stdout_drain_report.bytes_written,
        chunk_truncated: stdout_drain_report.chunk_truncated,
        stream_overflowed: false,
    };
    let exit = match result {
        Ok(exit) => exit,
        Err(e) => {
            // Sandbox crashed — check host dmesg for OOM evidence naming the
            // firecracker process before propagating a generic error.
            if let Some(host_process_pid) = sandbox.host_process_pid()
                && check_host_oom(host_process_pid).await
            {
                warn!(
                    run_id = %context.run_id,
                    pid = host_process_pid,
                    "host OOM kill detected for firecracker"
                );
                let error = "Firecracker VM killed by host OOM killer".to_string();
                telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
                return Ok(AgentExecutionResult::failure(1, error, None)
                    .with_resource_failure_kind(ResourceFailureKind::HostMemoryOomKilled));
            }
            let error = e.to_string();
            telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
            if wait_process_timed_out(&e) {
                return Ok(AgentExecutionResult {
                    failure: Some(ExecutionFailure::runner_job_timeout(
                        JOB_TIMEOUT_EXIT_CODE,
                        error,
                        None,
                        JOB_TIMEOUT,
                        t.elapsed(),
                        None,
                    )),
                    stdout_stream_diagnostics: stdout_stream_diagnostics_on_wait_error,
                    reusable_session_identity: None,
                });
            }
            return Err(e.into());
        }
    };
    if exit.stream_overflowed {
        warn!(run_id = %context.run_id, "agent stdout stream overflowed before process exit");
    }
    let stdout_stream_diagnostics = AgentStdoutStreamDiagnostics {
        bytes_written: stdout_drain_report.bytes_written,
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
        termination = ?exit.termination,
        exit_code = ?process_exit_code(&exit),
        "agent exited"
    );
    log_agent_process_exit_summary(
        context.run_id,
        sandbox.id(),
        start.reuse_result,
        &exit,
        &env_diagnostics,
        stdout_stream_diagnostics,
    );

    // Check for OOM kill when process was terminated by SIGKILL. Skip only
    // after hard fallback, where the SIGKILL exit code is synthetic. A
    // cooperative guest exit remains real process evidence.
    if !used_hard_cancellation_fallback && process_exit_oom_candidate(&exit) {
        let dmesg_req = ExecRequest {
            cmd: "dmesg | tail -20 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        };
        match sandbox
            .exec_with_diagnostic_label(&dmesg_req, "oom-dmesg")
            .await
        {
            Ok(dmesg)
                if helper_exec_succeeded(&dmesg)
                    && dmesg_indicates_oom(&String::from_utf8_lossy(&dmesg.stdout)) =>
            {
                warn!(run_id = %context.run_id, "OOM kill detected via dmesg");
                // Return exit code 1 with descriptive message instead of raw 137,
                // so callers see a clear error rather than an opaque signal code.
                let error = "Agent process killed by OOM killer";
                telemetry.record("agent_execute", t.elapsed(), false, Some(error));
                return Ok(AgentExecutionResult::failure(1, error, None)
                    .with_resource_failure_kind(ResourceFailureKind::GuestMemoryOomKilled)
                    .with_stdout_stream_diagnostics(stdout_stream_diagnostics));
            }
            Err(e) => {
                warn!(run_id = %context.run_id, error = %e, "failed to exec dmesg for OOM check");
            }
            Ok(dmesg) if !helper_exec_succeeded(&dmesg) => {
                warn!(
                    run_id = %context.run_id,
                    termination = helper_exec_termination_label(&dmesg),
                    "dmesg OOM check helper failed"
                );
            }
            _ => {}
        }
    }

    let failure = if cancellation_observed {
        // Cancellation remains authoritative over guest failure files. Hard
        // fallback may also leave the guest process without terminal proof.
        Some(ExecutionFailure::cancelled())
    } else if process_failed(&exit) {
        let failure_exit_code = process_failure_exit_code(&exit);
        let stderr = process_failure_stderr(&exit);
        let failure_diagnostic = read_guest_failure_diagnostic_file(sandbox, context.run_id).await;
        let should_read_guest_error = stderr.is_empty()
            || (failure_diagnostic.is_none()
                && matches!(exit.termination, ExecTermination::Exited { exit_code } if exit_code != 0));
        let guest_error = if should_read_guest_error {
            read_guest_error_file(sandbox, context.run_id).await
        } else {
            None
        };
        let should_log_bootstrap_diagnostics = should_log_agent_bootstrap_abnormal_exit_diagnostics(
            cancellation_observed,
            &exit,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        );
        let should_collect_resource_diagnostics = should_collect_agent_abnormal_exit_diagnostics(
            cancellation_observed,
            &exit,
            &stderr,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        );
        let should_collect_sigkill_resource_diagnostics =
            should_collect_unattributed_sigkill_resource_diagnostics(
                cancellation_observed,
                &exit,
                failure_diagnostic.as_ref(),
            );
        let should_collect_resource_diagnostics =
            should_collect_resource_diagnostics || should_collect_sigkill_resource_diagnostics;
        let mut resource_diagnostics = None;
        if should_log_bootstrap_diagnostics || should_collect_resource_diagnostics {
            let env_key_diagnostics = build_agent_env_key_diagnostics(&env_pairs);
            if should_log_bootstrap_diagnostics {
                log_agent_bootstrap_abnormal_exit_diagnostics(
                    AgentBootstrapAbnormalExitLogContext {
                        run_id: context.run_id,
                        sandbox_id: sandbox.id(),
                        reuse_result: start.reuse_result,
                        exit: &exit,
                        env_diagnostics: &env_diagnostics,
                        env_key_diagnostics: &env_key_diagnostics,
                        stdout_stream_diagnostics,
                        session_restore_diagnostics: session_restore_diagnostics.as_ref(),
                    },
                );
            }
            if should_collect_resource_diagnostics {
                log_agent_abnormal_exit_env_diagnostics(
                    context.run_id,
                    sandbox.id(),
                    start.reuse_result,
                    &exit,
                    &env_diagnostics,
                    &env_key_diagnostics,
                );
                resource_diagnostics = collect_agent_abnormal_exit_diagnostics(
                    sandbox,
                    context.run_id,
                    sandbox.id(),
                    start.reuse_result,
                    failure_exit_code,
                )
                .await;
            }
        }
        let error = if !stderr.is_empty() {
            stderr
        } else {
            // Stderr is empty (redirected to log file). Check for a structured
            // error file written by the guest-agent for final failure
            // handoff.
            guest_error.unwrap_or_else(|| agent_exit_failure_message(failure_exit_code))
        };
        let is_runner_job_timeout = matches!(exit.termination, ExecTermination::TimedOut)
            || diagnostic_is_agent_execution_timeout(failure_diagnostic.as_ref());
        Some(if is_runner_job_timeout {
            ExecutionFailure::runner_job_timeout(
                failure_exit_code,
                error,
                failure_diagnostic,
                JOB_TIMEOUT,
                t.elapsed(),
                exit.guest_duration_ms,
            )
            .with_resource_diagnostics(resource_diagnostics)
        } else {
            ExecutionFailure::new(failure_exit_code, error, failure_diagnostic)
                .with_resource_diagnostics(resource_diagnostics)
        })
    } else {
        None
    };

    // A pre-run identity proves only what was restored. Once the agent starts,
    // publish an identity only after a successful execution verifies the
    // current history or confirms that the restored history stayed unchanged.
    let reusable_session_identity = if failure.is_none() {
        match read_final_session_history_identity(sandbox, context).await {
            Ok(final_identity) => {
                telemetry.record(
                    "session_history_identity_finalized",
                    Duration::ZERO,
                    true,
                    None,
                );
                Some(final_identity)
            }
            Err(final_identity_reason) => {
                record_session_history_identity_reason(telemetry, final_identity_reason);
                if let Some(restored_identity) = pre_run_restored_session_identity.take() {
                    match verify_restored_session_identity_for_reuse(
                        sandbox,
                        context,
                        restored_identity,
                    )
                    .await
                    {
                        Ok(verified_restored_session_identity) => {
                            Some(verified_restored_session_identity)
                        }
                        Err(reason) => {
                            record_session_history_identity_reason(telemetry, reason);
                            None
                        }
                    }
                } else {
                    None
                }
            }
        }
    } else {
        None
    };

    let agent_result = match failure {
        Some(failure) => AgentExecutionResult {
            failure: Some(failure),
            stdout_stream_diagnostics,
            reusable_session_identity: None,
        },
        None => AgentExecutionResult::success()
            .with_stdout_stream_diagnostics(stdout_stream_diagnostics)
            .with_reusable_session_identity(reusable_session_identity),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn exec_arg_aggregate_bytes(value: &str) -> usize {
        value.len() + 1
    }

    fn env_pairs_for_aggregate_bytes(target_bytes: usize) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut remaining = target_bytes;
        let mut index = 0;

        while remaining > 0 {
            let key = format!("VM0_FILL_{index}");
            let overhead = key.len() + 2;
            if remaining <= overhead {
                pairs
                    .last_mut()
                    .expect("aggregate target must require at least one env pair")
                    .1
                    .push_str(&"x".repeat(remaining));
                break;
            }

            let value_len = (64 * 1024).min(remaining - overhead);
            pairs.push((key, "x".repeat(value_len)));
            remaining -= overhead + value_len;
            index += 1;
        }

        pairs
    }

    #[test]
    fn bootstrap_exec_boundary_rejects_oversized_env_value_without_value_leak() {
        let secret = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        let env_pairs = vec![("VM0_OVERSIZED".to_string(), secret.clone())];

        let error =
            validate_agent_bootstrap_exec_boundary("exec /usr/local/bin/guest-agent", &env_pairs)
                .unwrap_err()
                .to_string();

        assert!(error.contains("guest-agent bootstrap argv/env too large"));
        assert!(error.contains("VM0_OVERSIZED"));
        assert!(!error.contains(&secret));
    }

    #[test]
    fn bootstrap_exec_boundary_rejects_aggregate_overflow() {
        let value = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES - 16);
        let env_pairs: Vec<(String, String)> = (0..20)
            .map(|index| (format!("VM0_CHUNK_{index}"), value.clone()))
            .collect();

        let error =
            validate_agent_bootstrap_exec_boundary("exec /usr/local/bin/guest-agent", &env_pairs)
                .unwrap_err()
                .to_string();

        assert!(error.contains("argv/env aggregate too large"));
    }

    #[test]
    fn bootstrap_exec_boundary_counts_shell_wrapper_dash_c_arg() {
        let agent_cmd = "exec /usr/local/bin/guest-agent";
        let shell_arg_bytes = exec_arg_aggregate_bytes("/bin/bash")
            + exec_arg_aggregate_bytes("-c")
            + exec_arg_aggregate_bytes(agent_cmd);
        let env_pairs = env_pairs_for_aggregate_bytes(
            guest_contracts::exec_limits::EXECVE_ARG_ENV_MAX_BYTES + 1 - shell_arg_bytes,
        );

        let error = validate_agent_bootstrap_exec_boundary(agent_cmd, &env_pairs)
            .unwrap_err()
            .to_string();

        assert!(error.contains("argv/env aggregate too large"));
    }
}
