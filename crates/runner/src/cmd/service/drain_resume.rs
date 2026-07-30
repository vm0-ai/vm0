use clap::Args;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

use super::drain_override::{remove_drain_restart_override, write_drain_restart_override};
use super::gate::{read_runner_status, runner_base_dir};
use super::reload::{SystemdReloadRequirement, coordinate_systemd_reload};
use super::signal::{ServiceSignalOutcome, signal_service_main};
use super::systemctl::{
    SystemdUnitEnablement, get_service_restart_policy, is_unit_active, read_unit_enablement,
    restore_unit_enablement, run_systemctl,
};
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
    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement>;
    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool>;
    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()>;
    fn restart_policy<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String>;
    fn signal_drain<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()>;
}

trait ServiceResumeOps {
    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement>;
    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool>;
    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()>;
    fn signal_resume<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn enable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()>;
}

struct RealServiceDrainOps;
struct RealServiceResumeOps;

impl ServiceDrainOps for RealServiceDrainOps {
    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active(unit).await })
    }

    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement> {
        Box::pin(async move { read_unit_enablement(unit).await })
    }

    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit)
    }

    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
        remove_drain_restart_override(unit)
    }

    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement)
                .await
                .map(|_| ())
        })
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
        Box::pin(
            async move { run_systemctl(&["disable", "--no-reload", unit.service_name()]).await },
        )
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move { restore_unit_enablement(unit, enablement).await })
    }
}

impl ServiceResumeOps for RealServiceResumeOps {
    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement> {
        Box::pin(async move { read_unit_enablement(unit).await })
    }

    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit)
    }

    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
        remove_drain_restart_override(unit)
    }

    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement)
                .await
                .map(|_| ())
        })
    }

    fn signal_resume<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome> {
        Box::pin(async move { signal_service_main(unit, nix::sys::signal::Signal::SIGUSR2).await })
    }

    fn enable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(
            async move { run_systemctl(&["enable", "--no-reload", unit.service_name()]).await },
        )
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move { restore_unit_enablement(unit, enablement).await })
    }
}

fn transition_error_with_rollback_failure(
    unit: &RunnerServiceUnit,
    transition: &str,
    error: RunnerError,
    rollback_error: RunnerError,
) -> RunnerError {
    RunnerError::Internal(format!(
        "{transition} failed for {}: {error}; additionally rollback failed: {rollback_error}",
        unit.unit_name()
    ))
}

async fn rollback_drain_transition(
    unit: &RunnerServiceUnit,
    restart_override_written: bool,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceDrainOps,
    context: &str,
) -> RunnerResult<()> {
    let mut failures = Vec::new();

    if restart_override_written {
        match ops.remove_restart_override(unit) {
            Ok(_) => {}
            Err(error) => failures.push(format!("remove drain restart override: {error}")),
        }
    }

    match prior_enablement {
        Some(enablement) => {
            if let Err(error) = ops.restore_enablement(unit, enablement).await {
                failures.push(format!("restore boot enablement: {error}"));
            }
        }
        None => failures.push("prior boot enablement is unavailable".to_string()),
    }

    if let Err(error) = ops
        .daemon_reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(false),
        )
        .await
    {
        failures.push(format!("reload restored systemd state: {error}"));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "failed to roll back drain transition for {} ({context}): {}",
            unit.unit_name(),
            failures.join("; ")
        )))
    }
}

async fn rollback_resume_transition(
    unit: &RunnerServiceUnit,
    drain_override_removed: bool,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceResumeOps,
    context: &str,
) -> RunnerResult<()> {
    let mut failures = Vec::new();

    if drain_override_removed && let Err(error) = ops.write_restart_override(unit) {
        failures.push(format!("restore drain restart override: {error}"));
    }

    match prior_enablement {
        Some(enablement) => {
            if let Err(error) = ops.restore_enablement(unit, enablement).await {
                failures.push(format!("restore boot enablement: {error}"));
            }
        }
        None => failures.push("prior boot enablement is unavailable".to_string()),
    }

    if let Err(error) = ops
        .daemon_reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(true),
        )
        .await
    {
        failures.push(format!("reload restored systemd state: {error}"));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "failed to roll back resume transition for {} ({context}): {}",
            unit.unit_name(),
            failures.join("; ")
        )))
    }
}

async fn drain_error_after_rollback(
    unit: &RunnerServiceUnit,
    restart_override_written: bool,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceDrainOps,
    context: &str,
    error: RunnerError,
) -> RunnerError {
    match rollback_drain_transition(
        unit,
        restart_override_written,
        prior_enablement,
        ops,
        context,
    )
    .await
    {
        Ok(()) => error,
        Err(rollback_error) => {
            transition_error_with_rollback_failure(unit, "drain", error, rollback_error)
        }
    }
}

async fn resume_error_after_rollback(
    unit: &RunnerServiceUnit,
    drain_override_removed: bool,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceResumeOps,
    context: &str,
    error: RunnerError,
) -> RunnerError {
    match rollback_resume_transition(unit, drain_override_removed, prior_enablement, ops, context)
        .await
    {
        Ok(()) => error,
        Err(rollback_error) => {
            transition_error_with_rollback_failure(unit, "resume", error, rollback_error)
        }
    }
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

async fn drain_enablement_before_transition(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
) -> Option<SystemdUnitEnablement> {
    match ops.enablement(unit).await {
        Ok(enablement) => Some(enablement),
        Err(error) => {
            warn!(
                unit = %unit.unit_name(),
                error = %error,
                "failed to read boot enablement before drain; rollback may be partial"
            );
            None
        }
    }
}

async fn resume_enablement_before_transition(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceResumeOps,
) -> Option<SystemdUnitEnablement> {
    match ops.enablement(unit).await {
        Ok(enablement) => Some(enablement),
        Err(error) => {
            warn!(
                unit = %unit.unit_name(),
                error = %error,
                "failed to read boot enablement before resume; rollback may be partial"
            );
            None
        }
    }
}

async fn drain_with_ops(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<()> {
    let mut should_signal = ops.is_active(unit).await?;
    let prior_enablement = drain_enablement_before_transition(unit, ops).await;
    if !should_signal {
        info!(unit = %unit.unit_name(), "no active service found; drain signal not needed");
    }

    let restart_override_written = should_signal;
    if should_signal {
        ops.write_restart_override(unit)?;
    }

    if let Err(error) = ops.disable(unit).await {
        warn!(unit = %unit.unit_name(), error = %error, "failed to disable unit");
        eprintln!(
            "WARNING: drain could not disable {}: {error}. \
             Run it manually to prevent the unit from restarting on reboot.",
            unit.service_name()
        );
    } else {
        info!(unit = %unit.unit_name(), "disabled (won't restart on reboot)");
    }

    if let Err(error) = ops
        .daemon_reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(true),
        )
        .await
    {
        return Err(drain_error_after_rollback(
            unit,
            restart_override_written,
            prior_enablement,
            ops,
            "daemon_reload",
            error,
        )
        .await);
    }

    if should_signal {
        match ops.restart_policy(unit).await {
            Ok(restart_policy) => {
                if let Err(error) = ensure_drain_restart_policy_applied(unit, &restart_policy) {
                    return Err(drain_error_after_rollback(
                        unit,
                        restart_override_written,
                        prior_enablement,
                        ops,
                        "restart_policy",
                        error,
                    )
                    .await);
                }
            }
            Err(error) => {
                match ops.is_active(unit).await {
                    Ok(true) => {
                        return Err(drain_error_after_rollback(
                            unit,
                            restart_override_written,
                            prior_enablement,
                            ops,
                            "restart_policy",
                            error,
                        )
                        .await);
                    }
                    Ok(false) => {}
                    Err(active_err) => {
                        return Err(drain_error_after_rollback(
                            unit,
                            restart_override_written,
                            prior_enablement,
                            ops,
                            "restart_policy_active_check",
                            active_err,
                        )
                        .await);
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
        // Both outcomes ("live, signal delivered" and "already gone") retain
        // the already-applied disabled boot state.
        match ops.signal_drain(unit).await {
            Err(error) => {
                return Err(drain_error_after_rollback(
                    unit,
                    restart_override_written,
                    prior_enablement,
                    ops,
                    "signal_drain",
                    error,
                )
                .await);
            }
            Ok(ServiceSignalOutcome::Sent) => {
                info!(unit = %unit.unit_name(), "sent SIGUSR1 (drain)");
            }
            Ok(ServiceSignalOutcome::AlreadyGone) => {
                info!(unit = %unit.unit_name(), "runner already exited; drain signal not needed");
            }
        }
    }

    Ok(())
}

async fn resume_after_preflight_with_ops(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<()> {
    let prior_enablement = resume_enablement_before_transition(unit, ops).await;
    let drain_override_removed = ops.remove_restart_override(unit)?;

    if let Err(error) = ops.enable(unit).await {
        warn!(unit = %unit.unit_name(), error = %error, "failed to re-enable unit");
        eprintln!(
            "WARNING: resume could not `systemctl enable {}`: {error}. \
             Run it manually to restore the restart-on-reboot behavior.",
            unit.service_name()
        );
    } else {
        info!(unit = %unit.unit_name(), "re-enabled (will restart on reboot)");
    }

    if let Err(error) = ops
        .daemon_reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(false),
        )
        .await
    {
        return Err(resume_error_after_rollback(
            unit,
            drain_override_removed,
            prior_enablement,
            ops,
            "daemon_reload",
            error,
        )
        .await);
    }

    let signal_result = match ops.signal_resume(unit).await {
        Ok(ServiceSignalOutcome::Sent) => {
            info!(unit = %unit.unit_name(), "sent SIGUSR2 (resume)");
            return Ok(());
        }
        Ok(ServiceSignalOutcome::AlreadyGone) => {
            info!(
                unit = %unit.unit_name(),
                "runner exited between preflight and signal; refusing resume",
            );
            RunnerError::Internal(format!(
                "{} is not active — cannot resume an inactive runner",
                unit.unit_name()
            ))
        }
        Err(error) => error,
    };

    Err(resume_error_after_rollback(
        unit,
        drain_override_removed,
        prior_enablement,
        ops,
        "signal_resume",
        signal_result,
    )
    .await)
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
        enablement_results: VecDeque<RunnerResult<SystemdUnitEnablement>>,
        write_error: bool,
        remove_error: bool,
        reload_errors: VecDeque<bool>,
        restart_policy_error: bool,
        restart_policy: String,
        signal_error: bool,
        signal_outcome: ServiceSignalOutcome,
        disable_error: bool,
        restore_enablement_error: bool,
    }

    struct FakeResumeOps {
        events: Vec<&'static str>,
        enablement_results: VecDeque<RunnerResult<SystemdUnitEnablement>>,
        write_error: bool,
        remove_error: bool,
        removed_restart_override: bool,
        reload_errors: VecDeque<bool>,
        signal_error: bool,
        signal_outcome: ServiceSignalOutcome,
        enable_error: bool,
        restore_enablement_error: bool,
    }

    impl Default for FakeDrainOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                active_results: VecDeque::from([Ok(true)]),
                enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::Enabled)]),
                write_error: false,
                remove_error: false,
                reload_errors: VecDeque::new(),
                restart_policy_error: false,
                restart_policy: "no".to_string(),
                signal_error: false,
                signal_outcome: ServiceSignalOutcome::Sent,
                disable_error: false,
                restore_enablement_error: false,
            }
        }
    }

    impl Default for FakeResumeOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::NotEnabled)]),
                write_error: false,
                remove_error: false,
                removed_restart_override: true,
                reload_errors: VecDeque::new(),
                signal_error: false,
                signal_outcome: ServiceSignalOutcome::Sent,
                enable_error: false,
                restore_enablement_error: false,
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

        fn enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, SystemdUnitEnablement> {
            self.events.push("is_enabled");
            Box::pin(std::future::ready(
                self.enablement_results
                    .pop_front()
                    .unwrap_or(Ok(SystemdUnitEnablement::NotEnabled)),
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

        fn daemon_reload<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            _requirement: SystemdReloadRequirement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("daemon_reload");
            let reload_error = self.reload_errors.pop_front().unwrap_or(false);
            Box::pin(std::future::ready(if reload_error {
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

        fn restore_enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            enablement: SystemdUnitEnablement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push(match enablement {
                SystemdUnitEnablement::Enabled => "restore_enabled",
                SystemdUnitEnablement::EnabledRuntime => "restore_enabled_runtime",
                SystemdUnitEnablement::NotEnabled => "restore_not_enabled",
            });
            Box::pin(std::future::ready(if self.restore_enablement_error {
                Err(fake_error("restore enablement failed"))
            } else {
                Ok(())
            }))
        }
    }

    impl ServiceResumeOps for FakeResumeOps {
        fn enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, SystemdUnitEnablement> {
            self.events.push("is_enabled");
            Box::pin(std::future::ready(
                self.enablement_results
                    .pop_front()
                    .unwrap_or(Ok(SystemdUnitEnablement::NotEnabled)),
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
                Ok(self.removed_restart_override)
            }
        }

        fn daemon_reload<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            _requirement: SystemdReloadRequirement,
        ) -> ServiceFuture<'a, ()> {
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

        fn restore_enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            enablement: SystemdUnitEnablement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push(match enablement {
                SystemdUnitEnablement::Enabled => "restore_enabled",
                SystemdUnitEnablement::EnabledRuntime => "restore_enabled_runtime",
                SystemdUnitEnablement::NotEnabled => "restore_not_enabled",
            });
            Box::pin(std::future::ready(if self.restore_enablement_error {
                Err(fake_error("restore enablement failed"))
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
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

        assert_eq!(
            ops.events,
            ["is_active", "is_enabled", "disable", "daemon_reload"]
        );
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
        assert_eq!(
            ops.events,
            ["is_active", "is_enabled", "write_restart_override"]
        );
    }

    #[tokio::test]
    async fn drain_daemon_reload_failure_rolls_back_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            reload_errors: VecDeque::from([true, false]),
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "remove_restart_override",
                "restore_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_failure_restores_runtime_only_enablement() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::EnabledRuntime)]),
            reload_errors: VecDeque::from([true, false]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("reload failed"));
        assert!(ops.events.contains(&"restore_enabled_runtime"));
        assert!(!ops.events.contains(&"restore_enabled"));
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "remove_restart_override",
                "restore_enabled",
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "is_active",
                "remove_restart_override",
                "restore_enabled",
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "is_active",
                "remove_restart_override",
                "restore_enabled",
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "is_active",
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "remove_restart_override",
                "restore_enabled",
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
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
            ]
        );
    }

    #[tokio::test]
    async fn resume_enables_and_reloads_before_signal() {
        let unit = service_unit();
        let mut ops = FakeResumeOps::default();

        resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap();

        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
            ]
        );
    }

    #[tokio::test]
    async fn resume_enable_failure_remains_successful_after_reload_and_signal() {
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
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
            ]
        );
    }

    #[tokio::test]
    async fn resume_reload_failure_restores_override_and_enablement() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            reload_errors: VecDeque::from([true, false]),
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_restores_override_and_enablement() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("signal failed"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_reports_rollback_failures() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            write_error: true,
            restore_enablement_error: true,
            reload_errors: VecDeque::from([false, true]),
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("signal failed"));
        assert!(message.contains("additionally rollback failed"));
        assert!(message.contains("write failed"));
        assert!(message.contains("restore enablement failed"));
        assert!(message.contains("reload failed"));
    }

    #[tokio::test]
    async fn resume_already_gone_restores_transition() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            signal_outcome: ServiceSignalOutcome::AlreadyGone,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("cannot resume an inactive runner")
        );
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_failure_without_override_restores_only_enablement() {
        let unit = service_unit();
        let mut ops = FakeResumeOps {
            removed_restart_override: false,
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("signal failed"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "restore_not_enabled",
                "daemon_reload",
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
}
