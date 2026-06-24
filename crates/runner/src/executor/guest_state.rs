//! Guest state repair helpers used before agent execution.

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, Sandbox};

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};
use crate::helper_exec::{
    format_command_output_excerpt, format_helper_exec_failure, helper_exec_succeeded,
    helper_exec_termination_label,
};
use crate::types::ExecutionContext;

const ENTROPY_SIZE: usize = 256;
const TIMEZONE_SYNC_FAILED_MARKER: &str = "guest timezone sync failed";

#[derive(Clone, Copy)]
struct GuestTimezone<'a> {
    name: &'a str,
    context: &'a ExecutionContext,
}

fn helper_exec_exit_code(result: &sandbox::ExecResult) -> Option<i32> {
    match result.termination {
        ExecTermination::Exited { exit_code } => Some(exit_code),
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => None,
    }
}

fn host_unix_timestamp_secs() -> String {
    format!(
        "{:.3}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    )
}

fn read_host_entropy() -> RunnerResult<Vec<u8>> {
    use std::io::Read;

    let mut entropy = vec![0u8; ENTROPY_SIZE];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut entropy))
        .map_err(|e| RunnerError::Internal(format!("read host entropy: {e}")))?;
    Ok(entropy)
}

fn valid_timezone_name(tz: &str) -> bool {
    tz.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'_' || b == b'-' || b == b'+')
}

fn user_timezone(context: &ExecutionContext) -> Option<&str> {
    let tz = match context.user_timezone.as_deref() {
        Some(tz) if !tz.is_empty() => tz,
        _ => return None,
    };
    // Strict validation: timezone names are like "Asia/Shanghai" or "UTC".
    // Only allow alphanumeric, '/', '_', '-', '+'.  This prevents shell
    // injection since the value is interpolated into a sudo shell command.
    if !valid_timezone_name(tz) {
        tracing::warn!(tz = %tz, "rejected invalid timezone name");
        return None;
    }
    Some(tz)
}

fn timezone_sync_body(tz: &str) -> String {
    format!(
        "echo '{tz}' > /etc/timezone && \
         ln -sf /usr/share/zoneinfo/{tz} /etc/localtime && \
         sed -i '/^TZ=/d' /etc/environment && \
         echo 'TZ={tz}' >> /etc/environment"
    )
}

fn timezone_sync_command(tz: &str) -> String {
    let body = timezone_sync_body(tz);
    format!("if test -f /usr/share/zoneinfo/{tz}; then {body}; fi")
}

fn timezone_sync_best_effort_command(tz: &str) -> String {
    let body = timezone_sync_body(tz);
    format!(
        "if test -f /usr/share/zoneinfo/{tz}; then {{ {body}; }} || echo \"{TIMEZONE_SYNC_FAILED_MARKER}\" >&2; fi"
    )
}

fn log_embedded_timezone_failure(
    context: &ExecutionContext,
    tz: &str,
    result: &sandbox::ExecResult,
) {
    if !result
        .stderr
        .windows(TIMEZONE_SYNC_FAILED_MARKER.len())
        .any(|window| window == TIMEZONE_SYNC_FAILED_MARKER.as_bytes())
    {
        return;
    }

    let stderr_excerpt =
        format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated);
    let stdout_excerpt =
        format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated);
    tracing::warn!(
        run_id = %context.run_id,
        tz = %tz,
        termination = helper_exec_termination_label(result),
        stderr_excerpt = %stderr_excerpt.as_deref().unwrap_or(""),
        stdout_excerpt = %stdout_excerpt.as_deref().unwrap_or(""),
        "failed to set guest timezone"
    );
}

/// Restores snapshot-sensitive guest state in one exec before the agent starts.
///
/// On ARM64 with kernel 6.1, VMGenID does not work (the driver only supports
/// ACPI; DeviceTree support requires kernel 6.10+). All VMs restored from the
/// same snapshot share identical CRNG state, producing identical random output.
///
/// This syncs the frozen guest clock and injects fresh host entropy so each VM
/// produces unique random numbers from the first `getrandom()` call.
pub(crate) async fn restore_guest_state(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
) -> RunnerResult<()> {
    let timezone = user_timezone(context).map(|name| GuestTimezone { name, context });
    restore_guest_state_inner(sandbox, timezone).await
}

pub(crate) async fn restore_guest_state_without_timezone(
    sandbox: &dyn Sandbox,
) -> RunnerResult<()> {
    restore_guest_state_inner(sandbox, None).await
}

async fn restore_guest_state_inner(
    sandbox: &dyn Sandbox,
    timezone: Option<GuestTimezone<'_>>,
) -> RunnerResult<()> {
    let timestamp = host_unix_timestamp_secs();
    let entropy = read_host_entropy()?;
    let mut cmd = format!(
        r#"date -s "@{timestamp}" || {{ status=$?; echo "guest clock sync failed" >&2; exit "$status"; }}
guest-reseed || {{ status=$?; echo "guest-reseed failed" >&2; exit "$status"; }}"#
    );
    if let Some(timezone) = timezone {
        cmd.push('\n');
        cmd.push_str(&timezone_sync_best_effort_command(timezone.name));
    }
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &[],
                sudo: true,
                stdin_bytes: Some(&entropy),
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "guest-state-restore",
        )
        .await?;

    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "guest state restore",
            &result,
        )));
    }
    if let Some(timezone) = timezone {
        log_embedded_timezone_failure(timezone.context, timezone.name, &result);
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
pub(super) async fn sync_guest_timezone(sandbox: &dyn Sandbox, context: &ExecutionContext) {
    let Some(tz) = user_timezone(context) else {
        return;
    };
    let cmd = timezone_sync_command(tz);
    // Best-effort: don't fail the run if timezone setup fails.
    match sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &[],
                sudo: true,
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "guest-timezone-sync",
        )
        .await
    {
        Ok(result) if !helper_exec_succeeded(&result) => {
            let stderr_excerpt =
                format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated);
            let stdout_excerpt =
                format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated);
            if let Some(exit_code) = helper_exec_exit_code(&result) {
                tracing::warn!(
                    run_id = %context.run_id,
                    tz = %tz,
                    termination = helper_exec_termination_label(&result),
                    exit_code,
                    stderr_excerpt = %stderr_excerpt.as_deref().unwrap_or(""),
                    stdout_excerpt = %stdout_excerpt.as_deref().unwrap_or(""),
                    "failed to set guest timezone"
                );
            } else {
                tracing::warn!(
                    run_id = %context.run_id,
                    tz = %tz,
                    termination = helper_exec_termination_label(&result),
                    stderr_excerpt = %stderr_excerpt.as_deref().unwrap_or(""),
                    stdout_excerpt = %stdout_excerpt.as_deref().unwrap_or(""),
                    "failed to set guest timezone"
                );
            }
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(run_id = %context.run_id, tz = %tz, error = %e, "failed to set guest timezone");
        }
    }
}
