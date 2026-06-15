//! Guest state repair helpers used before agent execution.

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};

use super::storage::format_command_output_excerpt;
use super::storage::format_guest_exec_failure;
use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};
use crate::types::ExecutionContext;

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
pub(super) async fn sync_guest_timezone(sandbox: &dyn Sandbox, context: &ExecutionContext) {
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
