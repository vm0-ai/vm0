//! Guest cleanup and rootfs admission policy before idle parking.

use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    REUSE_PREPARATION_EXIT_INSPECTION_FAILED, REUSE_PREPARATION_EXIT_INVALID_REQUEST,
    ReusePreparationReport, ReusePreparationRequest,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecResult, ExecTermination};
use tracing::{info, warn};

use crate::helper_exec::{
    format_helper_exec_failure, helper_exec_succeeded, helper_exec_termination_label,
};
use crate::ids::RunId;
use crate::paths::guest;
use crate::workspace_mount::{WORKSPACE_MOUNT_TIMEOUT, workspace_mount_command};

const REUSE_PREPARATION_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_REUSE_ROOTFS_AVAILABLE_BYTES: u64 = 128 * 1024 * 1024;
const MIN_REUSE_ROOTFS_AVAILABLE_INODES: u64 = 1024;
const REUSE_PREPARATION_EXIT_WORKSPACE_MOUNT_FAILED: i32 = 6;

#[derive(Clone, Copy)]
enum ReuseRejectionReason {
    InvalidRequest,
    InspectionFailed,
    CleanupFailed,
    ContainmentFailed,
    WorkspaceMountFailed,
    HelperFailed,
    InvalidReport,
    LowBytes,
    LowInodes,
    LowBytesAndInodes,
}

impl ReuseRejectionReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InspectionFailed => "inspection_failed",
            Self::CleanupFailed => "cleanup_failed",
            Self::ContainmentFailed => "containment_failed",
            Self::WorkspaceMountFailed => "workspace_mount_failed",
            Self::HelperFailed => "helper_failed",
            Self::InvalidReport => "invalid_report",
            Self::LowBytes => "low_bytes",
            Self::LowInodes => "low_inodes",
            Self::LowBytesAndInodes => "low_bytes_and_inodes",
        }
    }
}

#[derive(Debug)]
pub(crate) struct IdleReusePreparationFailure {
    error: String,
}

impl std::fmt::Display for IdleReusePreparationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.error)
    }
}

pub(crate) struct IdleReusePreparation {
    run_id: RunId,
    sandbox_id: String,
    command: String,
    request_bytes: Vec<u8>,
}

impl IdleReusePreparation {
    pub(crate) fn new(
        sandbox_id: &str,
        run_id: RunId,
        retained_runtime_dir: Option<&str>,
    ) -> Result<Self, IdleReusePreparationFailure> {
        let current_runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(
            CANONICAL_GUEST_HOME_DIR,
            &run_id.to_string(),
        )
        .map_err(|error| {
            reject_without_exec(
                sandbox_id,
                run_id,
                ReuseRejectionReason::InvalidRequest,
                format!("resolve current runtime directory: {error}"),
            )
        })?
        .to_string_lossy()
        .into_owned();
        let request = ReusePreparationRequest {
            current_runtime_dir,
            retained_runtime_dir: retained_runtime_dir.map(str::to_owned),
        };
        let request_bytes = serde_json::to_vec(&request).map_err(|error| {
            reject_without_exec(
                sandbox_id,
                run_id,
                ReuseRejectionReason::InvalidRequest,
                format!("serialize reuse-preparation request: {error}"),
            )
        })?;
        let mount_command = workspace_mount_command();
        let command = format!(
            "set -e\n{} prepare-for-reuse\nset +e\n(\nset -eu\n{}\n) >/dev/null\nmount_status=$?\nset -e\nif [ \"$mount_status\" -ne 0 ]; then\n  exit {REUSE_PREPARATION_EXIT_WORKSPACE_MOUNT_FAILED}\nfi",
            guest::RUN_AGENT,
            mount_command
        );
        Ok(Self {
            run_id,
            sandbox_id: sandbox_id.to_owned(),
            command,
            request_bytes,
        })
    }

    pub(crate) fn exec_request(&self) -> ExecRequest<'_> {
        ExecRequest {
            cmd: &self.command,
            timeout: REUSE_PREPARATION_TIMEOUT + WORKSPACE_MOUNT_TIMEOUT,
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: Some(&self.request_bytes),
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        }
    }

    pub(crate) fn validate_result(
        &self,
        result: &ExecResult,
    ) -> Result<(), IdleReusePreparationFailure> {
        if !helper_exec_succeeded(result) {
            let reason = helper_failure_reason(result);
            return Err(reject_with_result(
                &self.sandbox_id,
                self.run_id,
                reason,
                result,
                format_helper_exec_failure("reuse preparation", result),
            ));
        }

        let report =
            serde_json::from_slice::<ReusePreparationReport>(&result.stdout).map_err(|error| {
                reject_with_result(
                    &self.sandbox_id,
                    self.run_id,
                    ReuseRejectionReason::InvalidReport,
                    result,
                    format!("reuse preparation returned an invalid report: {error}"),
                )
            })?;
        let low_bytes = report.after.available_bytes < MIN_REUSE_ROOTFS_AVAILABLE_BYTES;
        let low_inodes = report.after.available_inodes < MIN_REUSE_ROOTFS_AVAILABLE_INODES;
        if low_bytes || low_inodes {
            let reason = if low_bytes && low_inodes {
                ReuseRejectionReason::LowBytesAndInodes
            } else if low_bytes {
                ReuseRejectionReason::LowBytes
            } else {
                ReuseRejectionReason::LowInodes
            };
            log_report(
                &self.sandbox_id,
                self.run_id,
                reason.as_str(),
                result,
                report,
                false,
            );
            return Err(IdleReusePreparationFailure {
                error: format!(
                    "guest rootfs below reuse reserve: {} bytes and {} inodes available",
                    report.after.available_bytes, report.after.available_inodes
                ),
            });
        }

        log_report(&self.sandbox_id, self.run_id, "ready", result, report, true);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn healthy_reuse_preparation_report() -> ReusePreparationReport {
    use guest_contracts::reuse_preparation::RootFilesystemCapacity;

    ReusePreparationReport {
        before: RootFilesystemCapacity {
            available_bytes: 256 * 1024 * 1024,
            available_inodes: 2048,
        },
        after: RootFilesystemCapacity {
            available_bytes: 256 * 1024 * 1024,
            available_inodes: 2048,
        },
        removed_entries: 0,
    }
}

#[cfg(test)]
pub(crate) fn add_healthy_reuse_preparation_matcher(
    overrides: &sandbox_mock::MockSandboxOverrides,
) {
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".to_string(),
        exit_code: 0,
        stdout: serde_json::to_vec(&healthy_reuse_preparation_report()).unwrap(),
        stderr: Vec::new(),
    });
}

#[cfg(test)]
pub(crate) fn mock_sandbox_ready_for_idle_reuse(
    name: impl Into<String>,
) -> sandbox_mock::MockSandbox {
    let overrides = std::sync::Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    sandbox_mock::MockSandbox::with_overrides(name, overrides)
}

fn helper_failure_reason(result: &ExecResult) -> ReuseRejectionReason {
    match result.termination {
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_INVALID_REQUEST,
        } => ReuseRejectionReason::InvalidRequest,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
        } => ReuseRejectionReason::InspectionFailed,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        } => ReuseRejectionReason::CleanupFailed,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
        } => ReuseRejectionReason::ContainmentFailed,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_WORKSPACE_MOUNT_FAILED,
        } => ReuseRejectionReason::WorkspaceMountFailed,
        ExecTermination::Exited { .. }
        | ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => ReuseRejectionReason::HelperFailed,
    }
}

fn reject_without_exec(
    sandbox_id: &str,
    run_id: RunId,
    reason: ReuseRejectionReason,
    error: String,
) -> IdleReusePreparationFailure {
    warn!(
        run_id = %run_id,
        sandbox_id,
        reason = reason.as_str(),
        error = %error,
        "sandbox rejected from idle reuse"
    );
    IdleReusePreparationFailure { error }
}

fn reject_with_result(
    sandbox_id: &str,
    run_id: RunId,
    reason: ReuseRejectionReason,
    result: &ExecResult,
    error: String,
) -> IdleReusePreparationFailure {
    warn!(
        run_id = %run_id,
        sandbox_id,
        reason = reason.as_str(),
        helper_termination = helper_exec_termination_label(result),
        helper_stdout_len = result.stdout.len(),
        helper_stderr_len = result.stderr.len(),
        helper_stdout_truncated = result.stdout_truncated,
        helper_stderr_truncated = result.stderr_truncated,
        error = %error,
        "sandbox rejected from idle reuse"
    );
    IdleReusePreparationFailure { error }
}

fn log_report(
    sandbox_id: &str,
    run_id: RunId,
    reason: &'static str,
    result: &ExecResult,
    report: ReusePreparationReport,
    ready: bool,
) {
    let reclaimed_bytes = report
        .after
        .available_bytes
        .saturating_sub(report.before.available_bytes);
    let reclaimed_inodes = report
        .after
        .available_inodes
        .saturating_sub(report.before.available_inodes);
    if ready {
        info!(
            run_id = %run_id,
            sandbox_id,
            reason,
            helper_termination = helper_exec_termination_label(result),
            removed_entries = report.removed_entries,
            before_available_bytes = report.before.available_bytes,
            after_available_bytes = report.after.available_bytes,
            reclaimed_bytes,
            before_available_inodes = report.before.available_inodes,
            after_available_inodes = report.after.available_inodes,
            reclaimed_inodes,
            "sandbox prepared for idle reuse"
        );
    } else {
        warn!(
            run_id = %run_id,
            sandbox_id,
            reason,
            helper_termination = helper_exec_termination_label(result),
            removed_entries = report.removed_entries,
            before_available_bytes = report.before.available_bytes,
            after_available_bytes = report.after.available_bytes,
            reclaimed_bytes,
            before_available_inodes = report.before.available_inodes,
            after_available_inodes = report.after.available_inodes,
            reclaimed_inodes,
            "sandbox rejected from idle reuse"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use sandbox::{Sandbox, SandboxError, SandboxOperation, SandboxOperationReason};
    use sandbox_mock::MockSandbox;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    fn report(
        before_bytes: u64,
        after_bytes: u64,
        before_inodes: u64,
        after_inodes: u64,
    ) -> ReusePreparationReport {
        use guest_contracts::reuse_preparation::RootFilesystemCapacity;

        ReusePreparationReport {
            before: RootFilesystemCapacity {
                available_bytes: before_bytes,
                available_inodes: before_inodes,
            },
            after: RootFilesystemCapacity {
                available_bytes: after_bytes,
                available_inodes: after_inodes,
            },
            removed_entries: 3,
        }
    }

    async fn capture_preparation(
        sandbox: &MockSandbox,
        run_id: RunId,
    ) -> (Result<(), IdleReusePreparationFailure>, Vec<CapturedEvent>) {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let result = execute_preparation(sandbox, run_id, None).await;
        drop(guard);
        (result, captured.entries())
    }

    async fn execute_preparation(
        sandbox: &MockSandbox,
        run_id: RunId,
        retained_runtime_dir: Option<&str>,
    ) -> Result<(), IdleReusePreparationFailure> {
        let preparation = IdleReusePreparation::new(sandbox.id(), run_id, retained_runtime_dir)?;
        let result = sandbox
            .exec_with_diagnostic_label(&preparation.exec_request(), "idle-reuse-preparation")
            .await
            .map_err(|error| {
                reject_without_exec(
                    sandbox.id(),
                    run_id,
                    ReuseRejectionReason::HelperFailed,
                    format!("reuse-preparation exec failed: {error}"),
                )
            })?;
        preparation.validate_result(&result)
    }

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
    }

    #[tokio::test]
    async fn preparation_sends_canonical_current_and_retained_runtime_directories() {
        let sandbox = MockSandbox::new("reuse-request");
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            serde_json::to_vec(&healthy_reuse_preparation_report()).unwrap(),
            Vec::new(),
        )));
        let run_id = RunId::new_v4();
        let retained = "/home/user/.vm0/guest-agent/runs/previous";

        execute_preparation(&sandbox, run_id, Some(retained))
            .await
            .expect("healthy guest should be prepared");

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].sudo);
        let helper_position = calls[0]
            .cmd
            .find("guest-agent prepare-for-reuse")
            .expect("reuse helper command");
        let mount_position = calls[0]
            .cmd
            .find("workspace_device=")
            .expect("workspace mount command");
        assert!(helper_position < mount_position);
        let request: ReusePreparationRequest = serde_json::from_slice(
            calls[0]
                .stdin_bytes
                .as_deref()
                .expect("reuse request should be sent on stdin"),
        )
        .unwrap();
        assert_eq!(
            request.current_runtime_dir,
            format!("/home/user/.vm0/guest-agent/runs/{run_id}")
        );
        assert_eq!(request.retained_runtime_dir.as_deref(), Some(retained));
    }

    #[tokio::test]
    async fn preparation_rejects_low_bytes_with_capacity_telemetry() {
        let sandbox = MockSandbox::new("low-bytes");
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            serde_json::to_vec(&report(64, 96, 4096, 4090)).unwrap(),
            Vec::new(),
        )));

        let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

        assert!(result.is_err());
        let event = captured_event(&events, "sandbox rejected from idle reuse");
        assert_eq!(
            event.fields.get("reason").map(String::as_str),
            Some("low_bytes")
        );
        assert_eq!(
            event
                .fields
                .get("before_available_bytes")
                .map(String::as_str),
            Some("64")
        );
        assert_eq!(
            event
                .fields
                .get("after_available_bytes")
                .map(String::as_str),
            Some("96")
        );
        assert_eq!(
            event.fields.get("reclaimed_bytes").map(String::as_str),
            Some("32")
        );
    }

    #[tokio::test]
    async fn preparation_rejects_low_inodes_with_capacity_telemetry() {
        let sandbox = MockSandbox::new("low-inodes");
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            serde_json::to_vec(&report(256 * 1024 * 1024, 257 * 1024 * 1024, 500, 600)).unwrap(),
            Vec::new(),
        )));

        let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

        assert!(result.is_err());
        let event = captured_event(&events, "sandbox rejected from idle reuse");
        assert_eq!(
            event.fields.get("reason").map(String::as_str),
            Some("low_inodes")
        );
        assert_eq!(
            event
                .fields
                .get("after_available_inodes")
                .map(String::as_str),
            Some("600")
        );
        assert_eq!(
            event.fields.get("reclaimed_inodes").map(String::as_str),
            Some("100")
        );
    }

    #[tokio::test]
    async fn preparation_distinguishes_typed_helper_failures() {
        for (exit_code, expected_reason) in [
            (
                REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
                "inspection_failed",
            ),
            (REUSE_PREPARATION_EXIT_CLEANUP_FAILED, "cleanup_failed"),
            (
                REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
                "containment_failed",
            ),
        ] {
            let sandbox = MockSandbox::new(expected_reason);
            sandbox.push_exec_result(Ok(ExecResult::new(
                exit_code,
                Vec::new(),
                b"helper failed".to_vec(),
            )));

            let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

            assert!(result.is_err());
            let event = captured_event(&events, "sandbox rejected from idle reuse");
            assert_eq!(
                event.fields.get("reason").map(String::as_str),
                Some(expected_reason)
            );
        }
    }

    #[tokio::test]
    async fn preparation_distinguishes_workspace_mount_failure() {
        let sandbox = MockSandbox::new("workspace-mount-failure");
        sandbox.push_exec_result(Ok(ExecResult::new(
            REUSE_PREPARATION_EXIT_WORKSPACE_MOUNT_FAILED,
            serde_json::to_vec(&healthy_reuse_preparation_report()).unwrap(),
            b"workspace mount failed".to_vec(),
        )));

        let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

        assert!(result.is_err());
        assert_eq!(
            captured_event(&events, "sandbox rejected from idle reuse")
                .fields
                .get("reason")
                .map(String::as_str),
            Some("workspace_mount_failed")
        );
    }

    #[tokio::test]
    async fn preparation_fails_closed_for_malformed_report_and_transport_failure() {
        let malformed = MockSandbox::new("malformed-report");
        malformed.push_exec_result(Ok(ExecResult::new(0, b"not-json".to_vec(), Vec::new())));
        let (result, events) = capture_preparation(&malformed, RunId::new_v4()).await;
        assert!(result.is_err());
        assert_eq!(
            captured_event(&events, "sandbox rejected from idle reuse")
                .fields
                .get("reason")
                .map(String::as_str),
            Some("invalid_report")
        );

        let transport = MockSandbox::new("transport-failure");
        transport.push_exec_result(Err(SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::Guest,
            message: "vsock disconnected".into(),
        }));
        let (result, events) = capture_preparation(&transport, RunId::new_v4()).await;
        assert!(result.is_err());
        assert_eq!(
            captured_event(&events, "sandbox rejected from idle reuse")
                .fields
                .get("reason")
                .map(String::as_str),
            Some("helper_failed")
        );
    }
}
