use std::collections::BTreeMap;
use std::process::{ExitStatus, Output};

use crate::error::{RunnerError, RunnerResult};

use super::diagnostic::status_field_preview;
use super::target::RunnerServiceUnit;

pub(super) fn journalctl_logs_status(svc: &str, status: ExitStatus) -> RunnerResult<()> {
    if status.success() {
        return Ok(());
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;

        // Preserve normal Unix pipeline behavior: `runner service logs | head`
        // can close stdout early, causing journalctl to terminate with SIGPIPE.
        if status.signal() == Some(libc::SIGPIPE) {
            return Ok(());
        }
    }

    Err(RunnerError::Internal(format!(
        "journalctl for {svc} exited with {status}"
    )))
}

/// Run `systemctl <args>` and check exit status.
pub(super) async fn run_systemctl(args: &[&str]) -> RunnerResult<()> {
    let status = tokio::process::Command::new("systemctl")
        .args(args)
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl: {e}")))?;
    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "systemctl {args:?} exited with {status}"
        )));
    }
    Ok(())
}

/// Check whether a systemd unit is active (running or activating).
pub(crate) async fn is_unit_active(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    let output = run_systemctl_show(svc, &properties).await?;
    let values = parse_systemctl_show_output(svc, &properties, &output)?;
    unit_active_from_systemctl_show(svc, &properties, &output.status, &values, &output.stderr)
}

/// Check whether a systemd unit is enabled for boot.
pub(crate) async fn is_unit_enabled(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    let svc = unit.service_name();
    let output = tokio::process::Command::new("systemctl")
        .args(["is-enabled", svc])
        .output()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl is-enabled: {e}")))?;
    unit_enabled_from_systemctl_is_enabled(svc, &output.status, &output.stdout, &output.stderr)
}

/// Get the main PID of a systemd unit.
pub(super) async fn get_service_pid(unit: &RunnerServiceUnit) -> RunnerResult<Option<u32>> {
    let svc = unit.service_name();
    let properties = ["LoadState", "MainPID"];
    let output = run_systemctl_show(svc, &properties).await?;
    let values = parse_systemctl_show_output(svc, &properties, &output)?;
    service_pid_from_systemctl_show(svc, &properties, &output.status, &values, &output.stderr)
}

async fn run_systemctl_show(svc: &str, properties: &[&str]) -> RunnerResult<Output> {
    let mut cmd = tokio::process::Command::new("systemctl");
    cmd.args(["show", svc]);
    for property in properties {
        cmd.arg(format!("--property={property}"));
    }
    cmd.output()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl show: {e}")))
}

fn parse_systemctl_show_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> RunnerResult<BTreeMap<String, String>> {
    match parse_systemctl_show_properties(svc, properties, &output.stdout) {
        Ok(values) => Ok(values),
        Err(_) if !output.status.success() => Err(systemctl_show_status_error(
            svc,
            properties,
            &output.status,
            &output.stderr,
        )),
        Err(e) => Err(e),
    }
}

fn parse_systemctl_show_properties(
    svc: &str,
    properties: &[&str],
    stdout: &[u8],
) -> RunnerResult<BTreeMap<String, String>> {
    let stdout = std::str::from_utf8(stdout).map_err(|e| {
        RunnerError::Internal(format!(
            "systemctl show {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    let mut values = BTreeMap::new();
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let Some((property, value)) = line.split_once('=') else {
            return Err(RunnerError::Internal(format!(
                "malformed systemctl show output for {svc}: {:?}",
                status_field_preview(line)
            )));
        };
        if !properties.contains(&property) {
            return Err(RunnerError::Internal(format!(
                "unexpected systemctl show property for {svc}: {property}"
            )));
        }
        if values
            .insert(property.to_string(), value.to_string())
            .is_some()
        {
            return Err(RunnerError::Internal(format!(
                "duplicate systemctl show property for {svc}: {property}"
            )));
        }
    }
    for property in properties {
        if !values.contains_key(*property) {
            return Err(RunnerError::Internal(format!(
                "missing systemctl show property for {svc}: {property}"
            )));
        }
    }
    Ok(values)
}

fn required_systemctl_property<'a>(
    svc: &str,
    values: &'a BTreeMap<String, String>,
    property: &str,
) -> RunnerResult<&'a str> {
    let value = values.get(property).ok_or_else(|| {
        RunnerError::Internal(format!(
            "missing systemctl show property for {svc}: {property}"
        ))
    })?;
    let value = value.trim();
    if value.is_empty() {
        return Err(RunnerError::Internal(format!(
            "empty systemctl show property for {svc}: {property}"
        )));
    }
    Ok(value)
}

fn classify_unit_active(svc: &str, load_state: &str, active_state: &str) -> RunnerResult<bool> {
    match active_state {
        "active" | "activating" | "reloading" | "refreshing" => Ok(true),
        "inactive" | "failed" | "deactivating" | "maintenance" => Ok(false),
        _ => Err(RunnerError::Internal(format!(
            "unknown ActiveState for {svc}: {active_state} (LoadState={load_state})"
        ))),
    }
}

fn unit_active_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<bool> {
    let load_state = required_systemctl_property(svc, values, "LoadState")?;
    let active_state = required_systemctl_property(svc, values, "ActiveState")?;
    let active = classify_unit_active(svc, load_state, active_state)?;
    let missing_unit = load_state == "not-found" && !active;
    ensure_systemctl_show_status(svc, properties, status, stderr, missing_unit)?;
    Ok(active)
}

fn service_pid_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<Option<u32>> {
    let load_state = required_systemctl_property(svc, values, "LoadState")?;
    let pid_str = required_systemctl_property(svc, values, "MainPID")?;
    let pid = match parse_main_pid(svc, pid_str) {
        Ok(pid) => pid,
        Err(_) if !status.success() => {
            return Err(systemctl_show_status_error(svc, properties, status, stderr));
        }
        Err(e) => return Err(e),
    };
    let missing_unit = load_state == "not-found" && pid.is_none();
    ensure_systemctl_show_status(svc, properties, status, stderr, missing_unit)?;
    Ok(pid)
}

fn parse_main_pid(svc: &str, value: &str) -> RunnerResult<Option<u32>> {
    let value = value.trim();
    if value.is_empty() {
        return Err(RunnerError::Internal(format!("empty MainPID for {svc}")));
    }
    let pid = value.parse::<u32>().map_err(|e| {
        RunnerError::Internal(format!(
            "parse MainPID for {svc}: {:?}: {e}",
            status_field_preview(value)
        ))
    })?;
    if pid == 0 { Ok(None) } else { Ok(Some(pid)) }
}

fn unit_enabled_from_systemctl_is_enabled(
    svc: &str,
    status: &ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> RunnerResult<bool> {
    let state = std::str::from_utf8(stdout).map_err(|e| {
        RunnerError::Internal(format!(
            "systemctl is-enabled {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    let state = state.trim();
    match state {
        "enabled" | "enabled-runtime" => Ok(true),
        "alias" | "disabled" | "generated" | "indirect" | "linked" | "linked-runtime"
        | "masked" | "masked-runtime" | "static" | "transient" => Ok(false),
        "" if !status.success() => Err(systemctl_is_enabled_status_error(svc, status, stderr)),
        other if !status.success() => {
            tracing::debug!(
                "systemctl is-enabled {svc} exited with {status} and state {other:?}; treating as disabled"
            );
            Ok(false)
        }
        other => Err(RunnerError::Internal(format!(
            "unknown UnitFileState for {svc}: {other:?}"
        ))),
    }
}

fn systemctl_is_enabled_status_error(svc: &str, status: &ExitStatus, stderr: &[u8]) -> RunnerError {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        RunnerError::Internal(format!("systemctl is-enabled {svc} exited with {status}"))
    } else {
        RunnerError::Internal(format!(
            "systemctl is-enabled {svc} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

fn ensure_systemctl_show_status(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    stderr: &[u8],
    allow_failed_status: bool,
) -> RunnerResult<()> {
    if status.success() || allow_failed_status {
        return Ok(());
    }
    Err(systemctl_show_status_error(svc, properties, status, stderr))
}

fn systemctl_show_status_error(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    stderr: &[u8],
) -> RunnerError {
    let property_args = properties.join(",");
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        RunnerError::Internal(format!(
            "systemctl show {svc} --property={property_args} exited with {status}"
        ))
    } else {
        RunnerError::Internal(format!(
            "systemctl show {svc} --property={property_args} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn systemctl_show_output(status: ExitStatus, stdout: &[u8], stderr: &[u8]) -> Output {
        Output {
            status,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn journalctl_logs_status_allows_successful_exit() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);

        assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
    }

    #[test]
    fn journalctl_logs_status_rejects_failed_exit() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        let err = journalctl_logs_status("vm0-runner-test.service", status).unwrap_err();

        assert!(
            matches!(err, RunnerError::Internal(message) if message.contains("journalctl for vm0-runner-test.service exited with"))
        );
    }

    #[test]
    fn journalctl_logs_status_allows_sigpipe() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(libc::SIGPIPE);

        assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
    }

    #[test]
    fn parse_systemctl_show_properties_extracts_values() {
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"MainPID=123\n",
        )
        .unwrap();

        assert_eq!(
            required_systemctl_property("vm0-runner-test.service", &values, "MainPID").unwrap(),
            "123"
        );
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_missing_property() {
        let err = parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"")
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("missing systemctl show property"));
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_unexpected_property() {
        let err = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"ActiveState=active\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unexpected systemctl show property"));
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_duplicate_property() {
        let err = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"MainPID=123\nMainPID=456\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("duplicate systemctl show property"));
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_malformed_line() {
        let err = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"MainPID 123\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("malformed systemctl show output"));
    }

    #[test]
    fn parse_systemctl_show_output_preserves_parse_error_on_success_status() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(ExitStatus::from_raw(0), b"MainPID 123\n", b"");
        let err = parse_systemctl_show_output("vm0-runner-test.service", &["MainPID"], &output)
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("malformed systemctl show output"));
    }

    #[test]
    fn parse_systemctl_show_output_prefers_status_error_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(
            ExitStatus::from_raw(0x100),
            b"MainPID 123\n",
            b"Failed to connect to bus\n",
        );
        let err = parse_systemctl_show_output("vm0-runner-test.service", &["MainPID"], &output)
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
        assert!(message.contains("Failed to connect to bus"));
        assert!(!message.contains("malformed systemctl show output"));
    }

    #[test]
    fn required_systemctl_property_rejects_empty_value() {
        let values =
            parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"MainPID=\n")
                .unwrap();
        let err =
            required_systemctl_property("vm0-runner-test.service", &values, "MainPID").unwrap_err();
        let message = err.to_string();

        assert!(message.contains("empty systemctl show property"));
    }

    #[test]
    fn systemctl_show_status_error_includes_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        let err = systemctl_show_status_error(
            "vm0-runner-test.service",
            &["MainPID"],
            &status,
            b"Failed to connect to bus: Host is down\n",
        );
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn classify_unit_active_accepts_active_states() {
        for active_state in ["active", "activating", "reloading", "refreshing"] {
            assert!(
                classify_unit_active("vm0-runner-test.service", "loaded", active_state).unwrap()
            );
        }
    }

    #[test]
    fn classify_unit_active_accepts_inactive_states() {
        for active_state in ["inactive", "failed", "deactivating", "maintenance"] {
            assert!(
                !classify_unit_active("vm0-runner-test.service", "loaded", active_state).unwrap()
            );
        }
    }

    #[test]
    fn classify_unit_active_treats_not_found_inactive_as_inactive() {
        assert!(!classify_unit_active("vm0-runner-test.service", "not-found", "inactive").unwrap());
    }

    #[test]
    fn classify_unit_active_rejects_unknown_active_state() {
        let err =
            classify_unit_active("vm0-runner-test.service", "loaded", "half-active").unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unknown ActiveState"));
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_accepts_enabled_states() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);
        for state in ["enabled", "enabled-runtime"] {
            assert!(
                unit_enabled_from_systemctl_is_enabled(
                    "vm0-runner-test.service",
                    &status,
                    format!("{state}\n").as_bytes(),
                    b"",
                )
                .unwrap()
            );
        }
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_rejects_disabled_states() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        for state in [
            "alias",
            "disabled",
            "generated",
            "indirect",
            "linked",
            "linked-runtime",
            "masked",
            "masked-runtime",
            "static",
            "transient",
        ] {
            assert!(
                !unit_enabled_from_systemctl_is_enabled(
                    "vm0-runner-test.service",
                    &status,
                    format!("{state}\n").as_bytes(),
                    b"",
                )
                .unwrap(),
                "{state} should not be treated as enabled"
            );
        }
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_rejects_unknown_success_state() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);
        let err = unit_enabled_from_systemctl_is_enabled(
            "vm0-runner-test.service",
            &status,
            b"half-enabled\n",
            b"",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unknown UnitFileState"));
    }

    #[test]
    fn unit_active_from_systemctl_show_allows_not_found_inactive_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nActiveState=inactive\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);

        assert!(
            !unit_active_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"Unit not found\n",
            )
            .unwrap()
        );
    }

    #[test]
    fn unit_active_from_systemctl_show_rejects_nonzero_loaded_inactive() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nActiveState=inactive\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = unit_active_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Failed to connect to bus\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn ensure_systemctl_show_status_requires_explicit_failed_status_allowance() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);

        assert!(
            ensure_systemctl_show_status(
                "vm0-runner-test.service",
                &["MainPID"],
                &status,
                b"Unit not found\n",
                true,
            )
            .is_ok()
        );

        let err = ensure_systemctl_show_status(
            "vm0-runner-test.service",
            &["MainPID"],
            &status,
            b"Failed to connect to bus\n",
            false,
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn service_pid_from_systemctl_show_returns_pid_on_success() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nMainPID=123\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);

        assert_eq!(
            service_pid_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"",
            )
            .unwrap(),
            Some(123)
        );
    }

    #[test]
    fn service_pid_from_systemctl_show_allows_not_found_zero_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nMainPID=0\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);

        assert_eq!(
            service_pid_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"Unit not found\n",
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn service_pid_from_systemctl_show_rejects_nonzero_loaded_zero() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nMainPID=0\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = service_pid_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Failed to connect to bus\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn service_pid_from_systemctl_show_rejects_malformed_pid_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nMainPID=abc\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = service_pid_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("Unit not found"));
    }

    #[test]
    fn parse_main_pid_zero_returns_none() {
        assert_eq!(
            parse_main_pid("vm0-runner-test.service", "0").unwrap(),
            None
        );
    }

    #[test]
    fn parse_main_pid_positive_returns_pid() {
        assert_eq!(
            parse_main_pid("vm0-runner-test.service", "123").unwrap(),
            Some(123)
        );
    }

    #[test]
    fn parse_main_pid_rejects_malformed_values() {
        for value in ["abc", "", "-1", "4294967296"] {
            assert!(
                parse_main_pid("vm0-runner-test.service", value).is_err(),
                "value should fail: {value}"
            );
        }
    }
}
