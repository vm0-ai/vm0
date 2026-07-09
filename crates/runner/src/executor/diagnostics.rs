//! Runner executor diagnostics and post-job log preservation.
//!
//! This facade keeps the executor-facing diagnostics API narrow while the
//! implementation is split by diagnostic source and side-effect boundary.

mod environment;
mod exit;
mod guest_files;
mod guest_logs;
mod oom;
mod resource;
mod stdout_stream;

pub(super) use environment::{build_agent_env_diagnostics, build_agent_env_key_diagnostics};
pub(super) use exit::{
    AgentBootstrapAbnormalExitLogContext, log_agent_abnormal_exit_env_diagnostics,
    log_agent_bootstrap_abnormal_exit_diagnostics, log_agent_process_exit_summary,
    should_collect_agent_abnormal_exit_diagnostics,
    should_collect_unattributed_sigkill_resource_diagnostics,
    should_log_agent_bootstrap_abnormal_exit_diagnostics,
};
pub(super) use guest_files::{
    read_guest_cli_agent_session_id, read_guest_error_file, read_guest_failure_diagnostic_file,
};
pub(super) use guest_logs::copy_guest_logs;
#[cfg(test)]
pub(super) use guest_logs::{GuestLogCopyFailureKind, guest_log_copy_failure_kind};
#[cfg(test)]
pub(super) use oom::host_dmesg_indicates_oom;
pub(super) use oom::{check_host_oom, dmesg_indicates_oom};
pub(super) use resource::collect_agent_abnormal_exit_diagnostics;
#[cfg(test)]
pub(super) use resource::parse_agent_abnormal_exit_resource_diagnostics;
pub(super) use stdout_stream::{
    AgentStdoutStreamDiagnostics, StdoutDrainReport,
    append_stdout_stream_diagnostics_to_stream_log, drain_stdout_to_file,
};
#[cfg(test)]
pub(super) use stdout_stream::{StdoutDrainError, append_stdout_stream_diagnostics};
