use std::time::{Duration, Instant};

use guest_contracts::diagnostics::FailureDiagnostic;
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
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, ProcessControlMode, ProcessOutputMode,
    Sandbox, StartProcessRequest,
};
use shell_quote::quote_shell_arg;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::diagnostics::{
    AgentBootstrapAbnormalExitLogContext, AgentStdoutStreamDiagnostics, StdoutDrainReport,
    build_agent_env_diagnostics, build_agent_env_key_diagnostics, check_host_oom,
    collect_agent_abnormal_exit_diagnostics, dmesg_indicates_oom, drain_stdout_to_file,
    log_agent_abnormal_exit_env_diagnostics, log_agent_bootstrap_abnormal_exit_diagnostics,
    log_agent_process_exit_summary, read_guest_error_file, read_guest_failure_diagnostic_file,
    should_collect_agent_abnormal_exit_diagnostics,
    should_log_agent_bootstrap_abnormal_exit_diagnostics,
};
use super::env::{
    build_env_json_for_run, build_run_payload_for_run, build_user_env_json, write_run_payload_file,
    write_user_env_file,
};
use super::guest_state::{restore_guest_state, sync_guest_timezone};
use super::session_history_download::{
    SessionHistoryDownloadPhaseTiming, SessionHistoryDownloadTimings,
    SessionHistoryMaterialization, SessionHistoryMaterializer,
};
use super::session_restore::{MaterializedResumeSession, restore_session};
use super::storage::{apply_storage_fingerprint_reuse, download_storages, guest_download_has_work};
use super::telemetry::{RunnerSpawnTiming, record_api_latency};
use super::{
    EXIT_SIGKILL, EXIT_SIGNAL_KILL, ExecutionFailure, ExecutorConfig, JOB_TIMEOUT,
    JOB_TIMEOUT_EXIT_CODE, PROCESS_CANCEL_TIMEOUTS, ResourceFailureDiagnostics,
    ResourceFailureKind, RunnerError, RunnerResult, SandboxReuseResult, USER_ENV_FILE_ENV_KEY,
    agent_exit_failure_message, guest_runtime_dir, guest_runtime_path, job_terminal_wait_timeout,
    normalize_failure_exit_code,
};
use crate::active_input::ActiveInputSource;
use crate::helper_exec::{helper_exec_succeeded, helper_exec_termination_label};
use crate::paths::guest;
use crate::restored_session_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT, RestoredSessionFinalMetadataVerification,
    RestoredSessionIdentity, RestoredSessionIdentityMismatchReason,
};
use crate::telemetry::{JobTelemetry, SessionHistoryTelemetryMetadata};
use crate::types::{ExecutionContext, GuestDownloadManifest};

const AGENT_WRAPPER_STDERR_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;
const SESSION_HISTORY_DOWNLOAD_TELEMETRY_ERROR: &str = "session history download failed";
const SESSION_HISTORY_DOWNLOAD_PHASE_TELEMETRY_ERROR: &str =
    "session history download phase failed";
const SESSION_HISTORY_MATERIALIZATION_WAIT_TELEMETRY_ERROR: &str =
    "session history materialization failed";
const STORAGE_CACHE_POPULATE_FAILED: &str = "storage-cache-populate-failed";
const STORAGE_DOWNLOAD_FAILED: &str = "storage-download-failed";
const SESSION_HISTORY_IDENTITY_VERIFY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionHistoryRestoreFallback {
    NonReuse,
    MissingIdleIdentity,
    UnverifiedIdleIdentity,
    StaleIdleIdentity,
    IdentityMismatch(Option<RestoredSessionIdentityMismatchReason>),
}

impl SessionHistoryRestoreFallback {
    const fn action_type(self) -> &'static str {
        match self {
            Self::NonReuse => "session_history_restore_fallback_non_reuse",
            Self::MissingIdleIdentity => "session_history_restore_fallback_missing_idle_identity",
            Self::UnverifiedIdleIdentity => {
                "session_history_restore_fallback_unverified_idle_identity"
            }
            Self::StaleIdleIdentity => "session_history_restore_fallback_stale_idle_identity",
            Self::IdentityMismatch(_) => "session_history_restore_fallback_identity_mismatch",
        }
    }

    const fn identity_mismatch_reason(self) -> Option<RestoredSessionIdentityMismatchReason> {
        match self {
            Self::IdentityMismatch(reason) => reason,
            _ => None,
        }
    }
}

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

#[derive(Default)]
#[must_use = "restore plans decide whether resume history download can be skipped"]
pub(crate) enum SessionHistoryRestorePlan {
    #[default]
    Default,
    Prestarted {
        materializer: SessionHistoryMaterializer,
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    SkipVerified(RestoredSessionIdentity),
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

pub(super) struct ProcessCancelTimeouts {
    pub(super) write: Duration,
    pub(super) terminal_grace: Duration,
}

pub(super) struct AgentExecutionResult {
    pub(super) failure: Option<ExecutionFailure>,
    pub(super) stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
    pub(super) restored_session_identity: Option<RestoredSessionIdentity>,
}

impl AgentExecutionResult {
    pub(super) fn success() -> Self {
        Self {
            failure: None,
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
            restored_session_identity: None,
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
            restored_session_identity: None,
        }
    }

    pub(super) fn failure_from_error(error: impl Into<String>) -> Self {
        Self::failure(1, error, None)
    }

    pub(super) fn exit_code(&self) -> i32 {
        self.failure.as_ref().map_or(0, |failure| failure.exit_code)
    }

    pub(super) fn with_stdout_stream_diagnostics(
        mut self,
        diagnostics: AgentStdoutStreamDiagnostics,
    ) -> Self {
        self.stdout_stream_diagnostics = diagnostics;
        self
    }

    pub(super) fn with_restored_session_identity(
        mut self,
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> Self {
        self.restored_session_identity = restored_session_identity;
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
    pid: u32,
    stream_overflowed: bool,
) -> sandbox::ProcessExit {
    let mut exit = sandbox::ProcessExit::new(pid, EXIT_SIGKILL, Vec::new(), Vec::new());
    exit.termination = ExecTermination::Cancelled;
    exit.stream_overflowed = stream_overflowed;
    exit
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
    pub(super) active_input_source: Option<ActiveInputSource>,
    pub(super) spawn_timing: Option<RunnerSpawnTiming>,
    pub(super) session_history_restore_plan: SessionHistoryRestorePlan,
}

impl RunControls {
    pub(super) fn new(
        cancel: CancellationToken,
        active_input_source: Option<ActiveInputSource>,
    ) -> Self {
        Self {
            cancel,
            active_input_source,
            spawn_timing: None,
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
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
        active_input_source,
        spawn_timing,
        session_history_restore_plan,
    } = controls;
    let has_active_input_source = active_input_source.is_some();

    // 1. Fix guest clock and reseed entropy (must happen before HTTPS calls).
    //    Needed after snapshot restore (frozen clock) and after idle reuse (drifted clock).
    //    When this exec already runs, fold best-effort timezone sync into it
    //    to avoid another pre-spawn guest round trip.
    if start.restore_guest_state {
        let t = Instant::now();
        let result = restore_guest_state(sandbox, context).await;
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "runner_guest_state_restore",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    } else {
        // 2. Set guest timezone from user preference (best-effort, never fails).
        let t = Instant::now();
        sync_guest_timezone(sandbox, context).await;
        telemetry.record("runner_guest_timezone_sync", t.elapsed(), true, None);
    }

    // 3. Download storage manifest entries (skipping entries unchanged since the previous turn).
    if let Some(manifest) = &context.storage_manifest {
        let guest_manifest = GuestDownloadManifest::from(manifest);
        let mut effective: GuestDownloadManifest = match start.prev_storage {
            Some(prev) => {
                let t = Instant::now();
                let effective = apply_storage_fingerprint_reuse(&guest_manifest, prev);
                telemetry.record(
                    "runner_storage_manifest_fingerprint_reuse",
                    t.elapsed(),
                    true,
                    None,
                );
                effective
            }
            None => guest_manifest,
        };
        // Short-circuit: skip the vsock exec if no downloads, cleanup, or
        // guest-side instruction normalization remain.
        let has_work_t = Instant::now();
        let has_work = guest_download_has_work(&effective);
        telemetry.record(
            "runner_storage_manifest_has_work",
            has_work_t.elapsed(),
            true,
            None,
        );
        if !has_work {
            info!(run_id = %context.run_id, "storage manifest has no download work, skipping download");
        }
        let t = Instant::now();
        let result = if has_work {
            // Populate the runner-side cache first, rewriting eligible entries'
            // `archive_url` to `file:///tmp/vm0-storage-cache/...` so the guest
            // reads from its tmpfs instead of hitting R2 per turn.
            async {
                let cache_t = Instant::now();
                let cache_result = crate::storage_cache::populate_cache(
                    &mut effective,
                    sandbox,
                    &config.home,
                    telemetry,
                )
                .await;
                telemetry.record(
                    "runner_storage_manifest_cache_populate",
                    cache_t.elapsed(),
                    cache_result.is_ok(),
                    cache_result
                        .is_err()
                        .then_some(STORAGE_CACHE_POPULATE_FAILED),
                );
                cache_result?;

                let download_t = Instant::now();
                let download_result = download_storages(sandbox, context, &effective).await;
                telemetry.record(
                    "runner_storage_manifest_guest_download",
                    download_t.elapsed(),
                    download_result.is_ok(),
                    download_result.is_err().then_some(STORAGE_DOWNLOAD_FAILED),
                );
                download_result
            }
            .await
        } else {
            Ok(())
        };
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "runner_storage_manifest_apply",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    let mut session_restore_diagnostics = None;
    let mut restored_session_identity = None;
    let session_history_materializer = match session_history_restore_plan {
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
                    restored_session_identity = Some(identity);
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
                        context.resume_session.as_ref(),
                        cancel.clone(),
                    ))
                }
            }
        }
        SessionHistoryRestorePlan::Default => Some(SessionHistoryMaterializer::start_cancellable(
            &config.http,
            context.resume_session.as_ref(),
            cancel.clone(),
        )),
        SessionHistoryRestorePlan::Prestarted {
            materializer,
            fallback,
        } => {
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
            Some(materializer)
        }
    };
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
        let resume_session = downloaded_resume_session.map(Ok).or_else(|| {
            context
                .resume_session
                .as_ref()
                .map(MaterializedResumeSession::from_inline_resume_session)
        });
        if let Some(session) = resume_session {
            let t = Instant::now();
            let result = match session {
                Ok(session) => restore_session(sandbox, context, &session).await,
                Err(error) => Err(error),
            };
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

    // JOB_TIMEOUT remains the guest-side runtime budget. The host waits a
    // little longer for terminal proof so the guest timeout path can kill,
    // drain stdout/stderr, and report ExecTermination::TimedOut.
    let t = Instant::now();
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: &agent_cmd,
            timeout: JOB_TIMEOUT,
            env: &env_refs,
            sudo: false,
            output: ProcessOutputMode::stream_with_stderr_capture(
                AGENT_WRAPPER_STDERR_CAPTURE_LIMIT_BYTES,
            ),
            control: ProcessControlMode::Enabled,
        })
        .await;

    let mut handle = match handle {
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

    // Claude Code process has a PID now — record end-to-end startup latency.
    record_api_latency("api_to_spawn", context, telemetry);

    let active_input_forwarder = super::active_input::ActiveInputForwarder::start(
        context.run_id,
        active_input_source,
        handle.control_handle(),
        cancel.clone(),
    );

    // Spawn background task to drain stdout chunks and write to the host stream log file.
    let host_log_path = config.log_paths.system_stream_log(context.run_id);
    let stream_task = handle
        .take_stdout_receiver()
        .map(|stdout_rx| tokio::spawn(drain_stdout_to_file(stdout_rx, host_log_path)));

    // 6. Wait for exit (or cancellation). On cancel, ask the guest to cancel the
    // supervised process and briefly wait for its terminal status so the vsock
    // operation can be removed before sandbox cleanup closes the connection.
    let process_pid = handle.pid;
    let process_cancel = handle.take_cancel_handle();
    let wait_process = sandbox.wait_process(handle, job_terminal_wait_timeout());
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
    let stdout_stream_diagnostics_on_wait_error = AgentStdoutStreamDiagnostics {
        bytes_written: stdout_drain_report.bytes_written,
        chunk_truncated: stdout_drain_report.chunk_truncated,
        stream_overflowed: false,
    };
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
                return Ok(AgentExecutionResult::failure(1, error, None)
                    .with_resource_failure_kind(ResourceFailureKind::HostMemoryOomKilled)
                    .with_restored_session_identity(restored_session_identity));
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
                    restored_session_identity,
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

    // Check for OOM kill when process was terminated by SIGKILL.
    // Skip when cancelled — the SIGKILL exit code is synthetic and dmesg
    // would run against a sandbox that hasn't been stopped yet.
    if !wait_cancelled && process_exit_oom_candidate(&exit) {
        let dmesg_req = ExecRequest {
            cmd: "dmesg | tail -20 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
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
                    .with_stdout_stream_diagnostics(stdout_stream_diagnostics)
                    .with_restored_session_identity(restored_session_identity));
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

    let failure = if wait_cancelled {
        // Skip guest file reads — sandbox hasn't been stopped yet.
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
            wait_cancelled,
            &exit,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        );
        let should_collect_resource_diagnostics = should_collect_agent_abnormal_exit_diagnostics(
            wait_cancelled,
            &exit,
            &stderr,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        );
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
        Some(if matches!(exit.termination, ExecTermination::TimedOut) {
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

    if failure.is_none() {
        match read_final_session_history_identity(sandbox, context).await {
            Ok(final_identity) => {
                telemetry.record(
                    "session_history_identity_finalized",
                    Duration::ZERO,
                    true,
                    None,
                );
                restored_session_identity = Some(final_identity);
            }
            Err(final_identity_reason) => {
                record_session_history_identity_reason(telemetry, final_identity_reason);
                if let Some(restored_identity) = restored_session_identity.take() {
                    match verify_restored_session_identity_for_reuse(
                        sandbox,
                        context,
                        restored_identity,
                    )
                    .await
                    {
                        Ok(verified_restored_session_identity) => {
                            restored_session_identity = Some(verified_restored_session_identity);
                        }
                        Err(reason) => {
                            record_session_history_identity_reason(telemetry, reason);
                        }
                    }
                }
            }
        }
    }

    let agent_result = match failure {
        Some(failure) => AgentExecutionResult {
            failure: Some(failure),
            stdout_stream_diagnostics,
            restored_session_identity,
        },
        None => AgentExecutionResult::success()
            .with_stdout_stream_diagnostics(stdout_stream_diagnostics)
            .with_restored_session_identity(restored_session_identity),
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
