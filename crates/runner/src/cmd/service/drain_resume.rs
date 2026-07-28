use clap::Args;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

use super::drain_override::{remove_drain_restart_override, write_drain_restart_override};
use super::gate::{read_runner_status, runner_base_dir};
use super::signal::{ServiceSignalOutcome, signal_service_main};
use super::systemctl::{get_service_restart_policy, is_unit_active, run_systemctl};
use super::{RunnerServiceUnit, ServiceFuture, acquire_service_lock};

#[derive(Args)]
pub(super) struct DrainArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

#[derive(Args)]
pub(super) struct ResumeArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

fn ensure_drain_restart_policy_applied(
    unit: &RunnerServiceUnit,
    restart_policy: &str,
) -> RunnerResult<()> {
    if restart_policy == "no" {
        return Ok(());
    }
    Err(RunnerError::Internal(format!(
        "effective Restart={restart_policy:?} for {} after drain override; expected Restart=no",
        unit.service_name()
    )))
}

trait ServiceDrainOps {
    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool>;
    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool>;
    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()>;
    fn restart_policy<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String>;
    fn signal_drain<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
}

trait ServiceResumeOps {
    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool>;
    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()>;
    fn signal_resume<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn enable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
}

struct RealServiceDrainOps;
struct RealServiceResumeOps;

impl ServiceDrainOps for RealServiceDrainOps {
    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active(unit).await })
    }

    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit)
    }

    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
        remove_drain_restart_override(unit)
    }

    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
        Box::pin(async { run_systemctl(&["daemon-reload"]).await })
    }

    fn restart_policy<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String> {
        Box::pin(async move { get_service_restart_policy(unit).await })
    }

    fn signal_drain<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome> {
        Box::pin(async move { signal_service_main(unit, nix::sys::signal::Signal::SIGUSR1).await })
    }

    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move { run_systemctl(&["disable", unit.service_name()]).await })
    }
}

impl ServiceResumeOps for RealServiceResumeOps {
    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit)
    }

    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
        remove_drain_restart_override(unit)
    }

    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
        Box::pin(async { run_systemctl(&["daemon-reload"]).await })
    }

    fn signal_resume<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome> {
        Box::pin(async move { signal_service_main(unit, nix::sys::signal::Signal::SIGUSR2).await })
    }

    fn enable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move { run_systemctl(&["enable", unit.service_name()]).await })
    }
}

async fn rollback_drain_restart_override(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
    context: &str,
) {
    match ops.remove_restart_override(unit) {
        Ok(true) => {
            if let Err(e) = ops.daemon_reload().await {
                warn!(
                    unit = %unit.unit_name(),
                    context,
                    error = %e,
                    "failed to reload systemd after removing drain restart override"
                );
            }
        }
        Ok(false) => {}
        Err(e) => {
            warn!(
                unit = %unit.unit_name(),
                context,
                error = %e,
                "failed to remove drain restart override after drain failure"
            );
        }
    }
}

async fn restore_drain_restart_override_after_failed_resume(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceResumeOps,
    context: &str,
) -> RunnerResult<()> {
    if let Err(e) = ops.write_restart_override(unit) {
        return Err(RunnerError::Internal(format!(
            "failed to restore drain restart override for {} after resume failure ({context}): {e}",
            unit.unit_name()
        )));
    }
    if let Err(e) = ops.daemon_reload().await {
        return Err(RunnerError::Internal(format!(
            "failed to reload systemd after restoring drain restart override for {} ({context}): {e}",
            unit.unit_name()
        )));
    }
    Ok(())
}

fn resume_error_with_restore_failure(
    unit: &RunnerServiceUnit,
    resume_error: RunnerError,
    restore_error: RunnerError,
) -> RunnerError {
    RunnerError::Internal(format!(
        "resume failed for {}: {resume_error}; additionally failed to restore drain restart override: {restore_error}",
        unit.unit_name()
    ))
}

fn removed_drain_override_reload_error(
    unit: &RunnerServiceUnit,
    reload_error: RunnerError,
    restore_error: RunnerError,
) -> RunnerError {
    RunnerError::Internal(format!(
        "failed to reload systemd after removing drain restart override for {} before resume: {reload_error}; additionally failed to restore drain restart override: {restore_error}",
        unit.unit_name()
    ))
}

fn ensure_resume_mode_is_draining(unit: &RunnerServiceUnit, mode: &str) -> RunnerResult<()> {
    match mode {
        "draining" => Ok(()),
        "stopping" | "stopped" => Err(RunnerError::Internal(format!(
            "{} is already shutting down (mode={mode}) — cannot resume",
            unit.unit_name()
        ))),
        "running" => Err(RunnerError::Internal(format!(
            "{} is running, not draining — cannot resume",
            unit.unit_name()
        ))),
        "starting" => Err(RunnerError::Internal(format!(
            "{} is starting, not draining — cannot resume",
            unit.unit_name()
        ))),
        _ => Err(RunnerError::Internal(format!(
            "{} is in unknown mode {mode:?} — cannot resume",
            unit.unit_name()
        ))),
    }
}

async fn remove_drain_restart_override_before_resume(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<bool> {
    let removed = ops.remove_restart_override(unit)?;
    if !removed {
        return Ok(false);
    }

    if let Err(reload_error) = ops.daemon_reload().await {
        if let Err(restore_error) =
            restore_drain_restart_override_after_failed_resume(unit, ops, "remove_reload").await
        {
            return Err(removed_drain_override_reload_error(
                unit,
                reload_error,
                restore_error,
            ));
        }
        return Err(reload_error);
    }

    Ok(true)
}

async fn signal_resume_after_restart_policy_restored(
    unit: &RunnerServiceUnit,
    removed_drain_restart_override: bool,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<()> {
    match ops.signal_resume(unit).await {
        Ok(ServiceSignalOutcome::Sent) => {
            info!(unit = %unit.unit_name(), "sent SIGUSR2 (resume)");
            Ok(())
        }
        Ok(ServiceSignalOutcome::AlreadyGone) => {
            let resume_error = RunnerError::Internal(format!(
                "{} is not active — cannot resume an inactive runner",
                unit.unit_name()
            ));
            if removed_drain_restart_override
                && let Err(restore_error) = restore_drain_restart_override_after_failed_resume(
                    unit,
                    ops,
                    "signal_resume_gone",
                )
                .await
            {
                return Err(resume_error_with_restore_failure(
                    unit,
                    resume_error,
                    restore_error,
                ));
            }
            info!(
                unit = %unit.unit_name(),
                "runner exited between preflight and signal; refusing resume",
            );
            Err(resume_error)
        }
        Err(e) => {
            if removed_drain_restart_override
                && let Err(restore_error) = restore_drain_restart_override_after_failed_resume(
                    unit,
                    ops,
                    "signal_resume_error",
                )
                .await
            {
                return Err(resume_error_with_restore_failure(unit, e, restore_error));
            }
            Err(e)
        }
    }
}

async fn drain_with_ops(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<()> {
    let mut should_signal = ops.is_active(unit).await?;
    if !should_signal {
        info!(unit = %unit.unit_name(), "no active service found; drain signal not needed");
    }

    if should_signal {
        ops.write_restart_override(unit)?;
        if let Err(e) = ops.daemon_reload().await {
            rollback_drain_restart_override(unit, ops, "daemon_reload").await;
            return Err(e);
        }
        match ops.restart_policy(unit).await {
            Ok(restart_policy) => {
                if let Err(e) = ensure_drain_restart_policy_applied(unit, &restart_policy) {
                    rollback_drain_restart_override(unit, ops, "restart_policy").await;
                    return Err(e);
                }
            }
            Err(e) => {
                match ops.is_active(unit).await {
                    Ok(true) => {
                        rollback_drain_restart_override(unit, ops, "restart_policy").await;
                        return Err(e);
                    }
                    Ok(false) => {}
                    Err(active_err) => {
                        rollback_drain_restart_override(unit, ops, "restart_policy_active_check")
                            .await;
                        return Err(active_err);
                    }
                }
                info!(
                    unit = %unit.unit_name(),
                    "runner exited before restart policy verification; drain signal not needed"
                );
                should_signal = false;
            }
        }
    }

    if should_signal {
        // `is_unit_active` above can race against the runner exiting on its own.
        // Both outcomes ("live, signal delivered" and "already gone") must still
        // run `systemctl disable` below so the unit does not auto-start at the
        // next boot.
        match ops.signal_drain(unit).await {
            Err(e) => {
                rollback_drain_restart_override(unit, ops, "signal_drain").await;
                return Err(e);
            }
            Ok(ServiceSignalOutcome::Sent) => {
                info!(unit = %unit.unit_name(), "sent SIGUSR1 (drain)");
            }
            Ok(ServiceSignalOutcome::AlreadyGone) => {
                info!(unit = %unit.unit_name(), "runner already exited; drain signal not needed");
            }
        }
    }

    // Disable so it won't restart on reboot. Disabling is boot enablement
    // cleanup only; active-unit restart prevention is handled by the runtime
    // Restart=no override above.
    if let Err(e) = ops.disable(unit).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to disable unit");
        eprintln!(
            "WARNING: drain could not disable {}: {e}. \
             Run it manually to prevent the unit from restarting on reboot.",
            unit.service_name()
        );
    } else {
        info!(unit = %unit.unit_name(), "disabled (won't restart on reboot)");
    }

    Ok(())
}

async fn resume_after_preflight_with_ops(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<()> {
    let removed_drain_restart_override =
        remove_drain_restart_override_before_resume(unit, ops).await?;

    // Same race as in `drain`: the runner can exit after the preflight
    // `is_unit_active` check but before we deliver SIGUSR2. If resume does not
    // deliver SIGUSR2 after restoring Restart=on-failure, put the drain override
    // back so a still-draining old runner does not regain restart behavior.
    signal_resume_after_restart_policy_restored(unit, removed_drain_restart_override, ops).await?;

    // Re-enable so the unit restarts on reboot (undoes the disable from drain).
    // Use `enable` (not `--now`) — the service is already running. SIGUSR2
    // has already been delivered so the runner IS resumed; a re-enable
    // failure is partial success. Surface the hint on stderr so CLI users
    // don't miss it.
    if let Err(e) = ops.enable(unit).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to re-enable unit");
        eprintln!(
            "WARNING: runner resumed but `systemctl enable {}` failed: {e}. \
             Run it manually to restore the restart-on-reboot behavior.",
            unit.service_name()
        );
    } else {
        info!(unit = %unit.unit_name(), "re-enabled (will restart on reboot)");
    }

    Ok(())
}

/// `service drain` — send SIGUSR1, disable unit, return immediately.
pub(super) async fn run_drain(args: DrainArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;
    drain_with_ops(&unit, &mut RealServiceDrainOps).await
}

/// `service resume` — send SIGUSR2, re-enable unit.
///
/// Reverses a prior `service drain` while the runner is still `Draining`.
/// If the runner has already transitioned to `Stopping` (teardown in
/// progress), is still `Running`, or exited, resume is refused when status is
/// readable. SIGUSR2 on an already-`Running` runner is a no-op on the runner
/// side, so the CLI must not restore Restart=on-failure until the runner has
/// actually entered `Draining`.
pub(super) async fn run_resume(args: ResumeArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

    if !is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "{} is not active — cannot resume an inactive runner",
            unit.unit_name()
        )));
    }

    // Preflight: only remove Restart=no once status.json confirms the runner
    // has processed SIGUSR1 and entered Draining. A too-early resume while
    // status is still Running can race with the pending SIGUSR1: SIGUSR2 is a
    // no-op in Running, but removing the restart override would let a later
    // Draining runner regain restart behavior.
    if let Some(base_dir) = runner_base_dir(&unit) {
        match read_runner_status(&base_dir).await {
            Ok(status) => ensure_resume_mode_is_draining(&unit, &status.mode)?,
            Err(e) => {
                warn!(
                    unit = %unit.unit_name(),
                    base_dir = %base_dir.display(),
                    error = %e,
                    "cannot read status.json during resume preflight"
                );
            }
        }
    }

    resume_after_preflight_with_ops(&unit, &mut RealServiceResumeOps).await
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    struct FakeDrainOps {
        events: Vec<&'static str>,
        active_results: VecDeque<RunnerResult<bool>>,
        write_error: bool,
        remove_error: bool,
        reload_error: bool,
        restart_policy_error: bool,
        restart_policy: String,
        signal_error: bool,
        signal_outcome: ServiceSignalOutcome,
        disable_error: bool,
    }

    struct FakeResumeOps {
        events: Vec<&'static str>,
        write_error: bool,
        remove_error: bool,
        removed_restart_override: bool,
        reload_errors: VecDeque<bool>,
        signal_error: bool,
        signal_outcome: ServiceSignalOutcome,
        enable_error: bool,
    }

    impl Default for FakeDrainOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                active_results: VecDeque::from([Ok(true)]),
                write_error: false,
                remove_error: false,
                reload_error: false,
                restart_policy_error: false,
                restart_policy: "no".to_string(),
                signal_error: false,
                signal_outcome: ServiceSignalOutcome::Sent,
                disable_error: false,
            }
        }
    }

    impl Default for FakeResumeOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                write_error: false,
                remove_error: false,
                removed_restart_override: true,
                reload_errors: VecDeque::new(),
                signal_error: false,
                signal_outcome: ServiceSignalOutcome::Sent,
                enable_error: false,
            }
        }
    }

    fn fake_error(message: &str) -> RunnerError {
        RunnerError::Internal(message.to_string())
    }

    impl ServiceDrainOps for FakeDrainOps {
        fn is_active<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
            self.events.push("is_active");
            Box::pin(std::future::ready(
                self.active_results.pop_front().unwrap_or(Ok(false)),
            ))
        }

        fn write_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<()> {
            self.events.push("write_restart_override");
            if self.write_error {
                Err(fake_error("write failed"))
            } else {
                Ok(())
            }
        }

        fn remove_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<bool> {
            self.events.push("remove_restart_override");
            if self.remove_error {
                Err(fake_error("remove failed"))
            } else {
                Ok(true)
            }
        }

        fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
            self.events.push("daemon_reload");
            Box::pin(std::future::ready(if self.reload_error {
                Err(fake_error("reload failed"))
            } else {
                Ok(())
            }))
        }

        fn restart_policy<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, String> {
            self.events.push("restart_policy");
            Box::pin(std::future::ready(if self.restart_policy_error {
                Err(fake_error("restart policy failed"))
            } else {
                Ok(self.restart_policy.clone())
            }))
        }

        fn signal_drain<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ServiceSignalOutcome> {
            self.events.push("signal_drain");
            Box::pin(std::future::ready(if self.signal_error {
                Err(fake_error("signal failed"))
            } else {
                Ok(self.signal_outcome)
            }))
        }

        fn disable<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("disable");
            Box::pin(std::future::ready(if self.disable_error {
                Err(fake_error("disable failed"))
            } else {
                Ok(())
            }))
        }
    }

    impl ServiceResumeOps for FakeResumeOps {
        fn write_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<()> {
            self.events.push("write_restart_override");
            if self.write_error {
                Err(fake_error("write failed"))
            } else {
                Ok(())
            }
        }

        fn remove_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<bool> {
            self.events.push("remove_restart_override");
            if self.remove_error {
                Err(fake_error("remove failed"))
            } else {
                Ok(self.removed_restart_override)
            }
        }

        fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
            self.events.push("daemon_reload");
            let reload_error = self.reload_errors.pop_front().unwrap_or(false);
            Box::pin(std::future::ready(if reload_error {
                Err(fake_error("reload failed"))
            } else {
                Ok(())
            }))
        }

        fn signal_resume<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ServiceSignalOutcome> {
            self.events.push("signal_resume");
            Box::pin(std::future::ready(if self.signal_error {
                Err(fake_error("signal failed"))
            } else {
                Ok(self.signal_outcome)
            }))
        }

        fn enable<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("enable");
            Box::pin(std::future::ready(if self.enable_error {
                Err(fake_error("enable failed"))
            } else {
                Ok(())
            }))
        }
    }

    #[tokio::test]
    async fn drain_active_service_disables_restart_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps::default();

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "disable",
            ]
        );
    }

    #[tokio::test]
    async fn drain_disable_failure_remains_successful_after_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            disable_error: true,
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "disable",
            ]
        );
    }

    #[tokio::test]
    async fn drain_inactive_service_skips_restart_override_and_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            active_results: VecDeque::from([Ok(false)]),
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(ops.events, ["is_active", "disable"]);
    }

    #[tokio::test]
    async fn drain_write_failure_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            write_error: true,
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("write failed"));
        assert_eq!(ops.events, ["is_active", "write_restart_override"]);
    }

    #[tokio::test]
    async fn drain_daemon_reload_failure_rolls_back_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            reload_error: true,
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "remove_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_mismatch_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            restart_policy: "on-failure".to_string(),
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("Restart=\"on-failure\""));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "remove_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_for_still_active_service_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            active_results: VecDeque::from([Ok(true), Ok(true)]),
            restart_policy_error: true,
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("restart policy failed"));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "is_active",
                "remove_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_with_failed_active_recheck_rolls_back() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            active_results: VecDeque::from([Ok(true), Err(fake_error("active recheck failed"))]),
            restart_policy_error: true,
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("active recheck failed"));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "is_active",
                "remove_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_for_exited_service_still_disables_unit() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            active_results: VecDeque::from([Ok(true), Ok(false)]),
            restart_policy_error: true,
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "is_active",
                "disable",
            ]
        );
    }

    #[tokio::test]
    async fn drain_signal_failure_rolls_back_restart_override() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            signal_error: true,
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("signal failed"));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "remove_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_already_gone_still_disables_unit() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            signal_outcome: ServiceSignalOutcome::AlreadyGone,
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_active",
                "write_restart_override",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "disable",
            ]
        );
    }

    #[tokio::test]
    async fn resume_signal_sent_keeps_restored_restart_policy() {
        let unit = service_unit();
        let mut ops = FakeResumeOps::default();

        signal_resume_after_restart_policy_restored(&unit, true, &mut ops)
            .await
            .unwrap();

        assert_eq!(ops.events, ["signal_resume"]);
    }

    #[tokio::test]
    async fn resume_enable_failure_remains_successful_after_signal() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            enable_error: true,
            ..FakeResumeOps::default()
        };

        resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap();

        assert_eq!(
            ops.events,
            [
                "remove_restart_override",
                "daemon_reload",
                "signal_resume",
                "enable",
            ]
        );
    }

    #[test]
    fn resume_preflight_allows_only_draining_mode() {
        let unit = service_unit();

        ensure_resume_mode_is_draining(&unit, "draining").unwrap();

        let running = ensure_resume_mode_is_draining(&unit, "running").unwrap_err();
        assert!(running.to_string().contains("running, not draining"));

        let starting = ensure_resume_mode_is_draining(&unit, "starting").unwrap_err();
        assert!(starting.to_string().contains("starting, not draining"));

        let stopping = ensure_resume_mode_is_draining(&unit, "stopping").unwrap_err();
        assert!(stopping.to_string().contains("already shutting down"));

        let unknown = ensure_resume_mode_is_draining(&unit, "paused").unwrap_err();
        assert!(unknown.to_string().contains("unknown mode"));
    }

    #[tokio::test]
    async fn resume_remove_missing_override_skips_reload() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            removed_restart_override: false,
            ..FakeResumeOps::default()
        };

        let removed = remove_drain_restart_override_before_resume(&unit, &mut ops)
            .await
            .unwrap();

        assert!(!removed);
        assert_eq!(ops.events, ["remove_restart_override"]);
    }

    #[tokio::test]
    async fn resume_remove_reload_failure_restores_removed_drain_override() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            reload_errors: VecDeque::from([true, false]),
            ..FakeResumeOps::default()
        };

        let err = remove_drain_restart_override_before_resume(&unit, &mut ops)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "remove_restart_override",
                "daemon_reload",
                "write_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_remove_reload_failure_reports_restore_write_failure() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            write_error: true,
            reload_errors: VecDeque::from([true]),
            ..FakeResumeOps::default()
        };

        let err = remove_drain_restart_override_before_resume(&unit, &mut ops)
            .await
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("failed to reload systemd after removing drain restart override"));
        assert!(message.contains("additionally failed to restore drain restart override"));
        assert!(message.contains("write failed"));
        assert_eq!(
            ops.events,
            [
                "remove_restart_override",
                "daemon_reload",
                "write_restart_override",
            ]
        );
    }

    #[tokio::test]
    async fn resume_remove_reload_failure_reports_restore_reload_failure() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            reload_errors: VecDeque::from([true, true]),
            ..FakeResumeOps::default()
        };

        let err = remove_drain_restart_override_before_resume(&unit, &mut ops)
            .await
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("failed to reload systemd after removing drain restart override"));
        assert!(message.contains("additionally failed to restore drain restart override"));
        assert!(message.contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "remove_restart_override",
                "daemon_reload",
                "write_restart_override",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_restores_removed_drain_override() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let err = signal_resume_after_restart_policy_restored(&unit, true, &mut ops)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("signal failed"));
        assert_eq!(
            ops.events,
            ["signal_resume", "write_restart_override", "daemon_reload"]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_reports_restore_write_failure() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            write_error: true,
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let err = signal_resume_after_restart_policy_restored(&unit, true, &mut ops)
            .await
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("signal failed"));
        assert!(message.contains("additionally failed to restore drain restart override"));
        assert!(message.contains("write failed"));
        assert_eq!(ops.events, ["signal_resume", "write_restart_override"]);
    }

    #[tokio::test]
    async fn resume_signal_failure_reports_restore_reload_failure() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            reload_errors: VecDeque::from([true]),
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let err = signal_resume_after_restart_policy_restored(&unit, true, &mut ops)
            .await
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("signal failed"));
        assert!(message.contains("additionally failed to restore drain restart override"));
        assert!(message.contains("reload failed"));
        assert_eq!(
            ops.events,
            ["signal_resume", "write_restart_override", "daemon_reload"]
        );
    }

    #[tokio::test]
    async fn resume_already_gone_restores_removed_drain_override() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            signal_outcome: ServiceSignalOutcome::AlreadyGone,
            ..FakeResumeOps::default()
        };

        let err = signal_resume_after_restart_policy_restored(&unit, true, &mut ops)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("cannot resume an inactive runner"));
        assert_eq!(
            ops.events,
            ["signal_resume", "write_restart_override", "daemon_reload"]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_without_removed_override_does_not_write_override() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let err = signal_resume_after_restart_policy_restored(&unit, false, &mut ops)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("signal failed"));
        assert_eq!(ops.events, ["signal_resume"]);
    }
}
