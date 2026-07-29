use std::process::ExitStatus;

use crate::error::{RunnerError, RunnerResult};

use super::diagnostic::status_field_preview;
use super::systemctl::has_service_main_process;
use super::target::RunnerServiceUnit;

/// Outcome of asking systemd to signal a unit's main process.
///
/// `AlreadyGone` means the delivery command failed and a follow-up systemd
/// query proved that the unit no longer has a main process. Callers retain
/// their distinct policies for that race: drain continues boot-enablement
/// cleanup, while resume rejects an inactive runner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ServiceSignalOutcome {
    Sent,
    AlreadyGone,
}

/// Ask systemd to send `signal` to the current main process of `unit`.
///
/// Systemd owns the unit's process identity, so resolving and signaling the
/// target inside the manager avoids a caller-side numeric PID reuse race.
pub(super) async fn signal_service_main(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
) -> RunnerResult<ServiceSignalOutcome> {
    let signal_arg = format!("--signal={}", signal.as_str());
    let output = tokio::process::Command::new("systemctl")
        .args([
            "kill",
            "--kill-whom=main",
            signal_arg.as_str(),
            unit.service_name(),
        ])
        .output()
        .await
        .map_err(|e| {
            RunnerError::Internal(format!(
                "spawn systemctl kill for {}: {e}",
                unit.service_name()
            ))
        })?;

    if output.status.success() {
        return Ok(ServiceSignalOutcome::Sent);
    }

    let signal_error = systemctl_kill_error(unit, signal, output.status, &output.stderr);
    match has_service_main_process(unit).await {
        Ok(false) => Ok(ServiceSignalOutcome::AlreadyGone),
        Ok(true) | Err(_) => Err(signal_error),
    }
}

fn systemctl_kill_error(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
    status: ExitStatus,
    stderr: &[u8],
) -> RunnerError {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    let command = format!(
        "systemctl kill --kill-whom=main --signal={} {}",
        signal.as_str(),
        unit.service_name()
    );
    if stderr.is_empty() {
        RunnerError::Internal(format!("{command} exited with {status}"))
    } else {
        RunnerError::Internal(format!(
            "{command} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::Duration;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const SCENARIO_ENV: &str = "VM0_RUN_SERVICE_SIGNAL_SCENARIO";
    const SIGNAL_ENV: &str = "VM0_RUN_SERVICE_SIGNAL_NAME";
    const INVOCATIONS_ENV: &str = "VM0_RUN_SERVICE_SIGNAL_INVOCATIONS";
    const CHILD_TEST: &str = "cmd::service::signal::tests::signal_service_main_systemctl_child";
    const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$VM0_RUN_SERVICE_SIGNAL_INVOCATIONS"

if [ "$1" = "kill" ]; then
  case "$VM0_RUN_SERVICE_SIGNAL_SCENARIO" in
    success-*) exit 0 ;;
    absent|live|recheck-failed)
      printf '%s\n' 'signal delivery failed' >&2
      exit 1
      ;;
  esac
fi

if [ "$1" = "show" ]; then
  case "$VM0_RUN_SERVICE_SIGNAL_SCENARIO" in
    absent)
      printf '%s\n' 'LoadState=loaded' 'MainPID=0'
      exit 0
      ;;
    live)
      printf '%s\n' 'LoadState=loaded' 'MainPID=123'
      exit 0
      ;;
    recheck-failed)
      printf '%s\n' 'state lookup failed' >&2
      exit 1
      ;;
  esac
fi

printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

    #[tokio::test]
    async fn signal_service_main_uses_systemd_main_scope_for_both_signals() {
        for (scenario, signal) in [
            ("success-sigusr1", nix::sys::signal::Signal::SIGUSR1),
            ("success-sigusr2", nix::sys::signal::Signal::SIGUSR2),
        ] {
            let invocations = run_signal_scenario(scenario, signal).await;

            assert_eq!(invocations, vec![expected_kill_invocation(signal)]);
        }
    }

    #[tokio::test]
    async fn signal_service_main_returns_already_gone_when_recheck_proves_absence() {
        let signal = nix::sys::signal::Signal::SIGUSR1;
        let invocations = run_signal_scenario("absent", signal).await;

        assert_eq!(
            invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    #[tokio::test]
    async fn signal_service_main_preserves_failure_when_main_process_is_present() {
        let signal = nix::sys::signal::Signal::SIGUSR2;
        let invocations = run_signal_scenario("live", signal).await;

        assert_eq!(
            invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    #[tokio::test]
    async fn signal_service_main_preserves_failure_when_recheck_fails() {
        let signal = nix::sys::signal::Signal::SIGUSR1;
        let invocations = run_signal_scenario("recheck-failed", signal).await;

        assert_eq!(
            invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    async fn run_signal_scenario(scenario: &str, signal: nix::sys::signal::Signal) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let fake_systemctl = dir.path().join("systemctl");
        std::fs::write(&fake_systemctl, FAKE_SYSTEMCTL).unwrap();
        let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_systemctl, permissions).unwrap();

        let invocations_path = dir.path().join("invocations");
        let path = utf8_path(dir.path());
        let invocations = utf8_path(&invocations_path);
        run_ignored_child_test(
            CHILD_TEST,
            (SCENARIO_ENV, scenario),
            &[
                ("PATH", Some(path)),
                (SIGNAL_ENV, Some(signal.as_str())),
                (INVOCATIONS_ENV, Some(invocations)),
            ],
            Duration::from_secs(10),
        )
        .await;

        std::fs::read_to_string(invocations_path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn utf8_path(path: &Path) -> &str {
        path.to_str().expect("temporary path must be UTF-8")
    }

    fn expected_kill_invocation(signal: nix::sys::signal::Signal) -> String {
        format!(
            "kill --kill-whom=main --signal={} vm0-runner-test.service",
            signal.as_str()
        )
    }

    fn expected_show_invocation() -> String {
        "show vm0-runner-test.service --property=LoadState --property=MainPID".to_string()
    }

    #[tokio::test]
    #[ignore = "spawned by signal service main systemctl tests"]
    async fn signal_service_main_systemctl_child() {
        let Ok(scenario) = std::env::var(SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((SCENARIO_ENV, &scenario)) {
            return;
        }

        let signal = match std::env::var(SIGNAL_ENV).as_deref() {
            Ok("SIGUSR1") => nix::sys::signal::Signal::SIGUSR1,
            Ok("SIGUSR2") => nix::sys::signal::Signal::SIGUSR2,
            value => panic!("unexpected signal scenario value: {value:?}"),
        };
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let result = signal_service_main(&unit, signal).await;

        match scenario.as_str() {
            "success-sigusr1" | "success-sigusr2" => {
                assert_eq!(result.unwrap(), ServiceSignalOutcome::Sent);
            }
            "absent" => {
                assert_eq!(result.unwrap(), ServiceSignalOutcome::AlreadyGone);
            }
            "live" | "recheck-failed" => {
                let error = result.unwrap_err().to_string();
                assert!(
                    error.contains("signal delivery failed"),
                    "unexpected error: {error}"
                );
                assert!(
                    !error.contains("state lookup failed"),
                    "recheck error replaced original failure: {error}"
                );
            }
            unexpected => panic!("unexpected service signal scenario: {unexpected}"),
        }
    }
}
