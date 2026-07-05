use std::path::PathBuf;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use clap::{Args, Subcommand};
use tracing::{info, warn};

mod diagnostic;
mod gate;
mod signal;
mod systemctl;
mod target;
mod unit_config;
mod unit_file;

pub(crate) use systemctl::{is_unit_active, is_unit_enabled};
pub(crate) use target::RunnerServiceUnit;
pub(crate) use unit_config::read_unit_config_path;

use gate::{check_active_jobs_gate, read_runner_status, runner_base_dir};
use signal::{ServiceSignalOutcome, signal_service_main};
use systemctl::{journalctl_logs_status, run_systemctl};
use unit_file::{
    cleanup_unit_staging_files, generate_unit_file, remove_unit_file_if_exists,
    resolve_config_path, validate_current_exe_path, validate_env_vars, validate_systemd_path,
    write_unit_file,
};

#[derive(Args)]
pub struct ServiceArgs {
    #[command(subcommand)]
    command: ServiceCommand,
}

#[derive(Subcommand)]
enum ServiceCommand {
    /// Start runner as a transient systemd service (CI, does not survive reboot)
    Start(ServiceRunArgs),
    /// Stop the runner service
    Stop(ServiceStopArgs),
    /// Install runner as a persistent systemd service (production, survives reboot)
    Install(ServiceRunArgs),
    /// Uninstall the runner service (stop + disable + remove unit)
    Uninstall(ServiceUninstallArgs),
    /// Drain the runner (SIGUSR1, non-blocking — returns immediately)
    Drain(ServiceDrainArgs),
    /// Resume a draining runner (SIGUSR2, reverses `drain` before teardown begins)
    Resume(ServiceResumeArgs),
    /// Show service status (all runner services if --name is omitted)
    Status(ServiceStatusArgs),
    /// Show service logs
    Logs(ServiceLogsArgs),
}

/// Common arguments shared by `service start` and `service install`.
#[derive(Args)]
struct ServiceRunArgs {
    /// Path to runner config YAML
    #[arg(long, short)]
    config: PathBuf,
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Environment variables to pass to the service (KEY=VALUE)
    #[arg(long, value_name = "KEY=VALUE")]
    env: Vec<String>,
    /// Use local file queue provider instead of API
    #[arg(long)]
    local: bool,
}

#[derive(Args)]
struct ServiceStopArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Skip active-jobs pre-check and force stop (active jobs will be killed).
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct ServiceUninstallArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Skip active-jobs pre-check and force uninstall (active jobs will be killed).
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct ServiceDrainArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

#[derive(Args)]
struct ServiceResumeArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

#[derive(Args)]
struct ServiceStatusArgs {
    /// Service name suffix (omit to show all runner services)
    #[arg(long)]
    name: Option<String>,
}

#[derive(Args)]
struct ServiceLogsArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Follow log output
    #[arg(long, short)]
    follow: bool,
    /// Number of lines to show
    #[arg(long, short, default_value = "100")]
    lines: u32,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

pub async fn run_service(args: ServiceArgs) -> RunnerResult<()> {
    match args.command {
        ServiceCommand::Start(a) => start(a).await,
        ServiceCommand::Stop(a) => stop(a).await,
        ServiceCommand::Install(a) => install(a).await,
        ServiceCommand::Uninstall(a) => uninstall(a).await,
        ServiceCommand::Drain(a) => drain(a).await,
        ServiceCommand::Resume(a) => resume(a).await,
        ServiceCommand::Status(a) => status(a).await,
        ServiceCommand::Logs(a) => logs(a).await,
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async fn acquire_service_lock(
    unit: &RunnerServiceUnit,
) -> RunnerResult<nix::fcntl::Flock<std::fs::File>> {
    let home = HomePaths::new()?;
    crate::lock::acquire(home.service_lock(unit.unit_name())).await
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/// `service start` — transient unit via systemd-run (CI).
async fn start(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    validate_env_vars(&args.env)?;

    if is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "unit {} is already running, stop it first with: runner service stop --name {}",
            unit.unit_name(),
            args.name
        )));
    }

    let config_path = resolve_config_path(&args.config)?;
    let exe_path = validate_current_exe_path(
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?,
    )?;
    validate_systemd_path("current executable path", &exe_path)?;
    validate_systemd_path("config path", &config_path)?;

    let unit_arg = format!("--unit={}", unit.unit_name());
    let desc_arg = format!("--description=VM0 Runner ({})", unit.unit_name());
    let syslog_arg = format!("--property=SyslogIdentifier={}", unit.unit_name());
    let mut cmd = tokio::process::Command::new("systemd-run");
    cmd.args([
        &*unit_arg,
        &*desc_arg,
        "--property=Type=exec",
        "--property=Restart=on-failure",
        "--property=RestartSec=5",
        "--property=StandardOutput=journal",
        "--property=StandardError=journal",
        "--property=KillSignal=SIGTERM",
        "--property=TimeoutStopSec=300",
        &*syslog_arg,
    ]);
    for entry in &args.env {
        cmd.arg(format!("--setenv={entry}"));
    }
    cmd.arg(&exe_path)
        .args(["start", "--config"])
        .arg(&config_path);
    if args.local {
        cmd.arg("--local");
    }

    let status = cmd
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemd-run: {e}")))?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "systemd-run failed: {status}"
        )));
    }
    info!(unit = %unit.unit_name(), "transient service started");
    Ok(())
}

/// `service stop` — stop the named unit.
///
/// Also clears residual transient unit state so that a subsequent
/// `service start` with the same name succeeds.
///
/// Refuses to stop a runner with active jobs unless `--force` is passed.
/// See [`check_active_jobs_gate`] for the policy.
async fn stop(args: ServiceStopArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    check_active_jobs_gate(&unit, args.force, "stop").await?;
    let svc = unit.service_name();

    if is_unit_active(&unit).await? {
        // Active unit: stop must succeed — failure means the runner process
        // (and its Firecracker VMs) would keep running.
        run_systemctl(&["stop", svc]).await?;
        info!(unit = %unit.unit_name(), "stopped");
    } else {
        // Unit may be loaded but inactive (residual transient unit).
        // Try stop to trigger systemd GC.  Ignore errors — the unit may
        // not exist at all (first run on this host).
        let _ = run_systemctl(&["stop", svc]).await;
        info!(unit = %unit.unit_name(), "no active service found");
    }

    // Clear "failed" latch so systemd fully unloads the transient unit.
    // (stop alone does not clear the failed state.)
    let _ = run_systemctl(&["reset-failed", svc]).await;
    Ok(())
}

/// `service install` — persistent unit file (production).
async fn install(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let _service_lock = acquire_service_lock(&unit).await?;

    validate_env_vars(&args.env)?;

    let config_path = resolve_config_path(&args.config)?;
    let exe_path = validate_current_exe_path(
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?,
    )?;
    validate_systemd_path("current executable path", &exe_path)?;
    validate_systemd_path("config path", &config_path)?;

    let unit_content = generate_unit_file(&unit, &exe_path, &config_path, &args.env, args.local);
    let upath = unit.unit_file_path();

    cleanup_unit_staging_files(upath)?;
    write_unit_file(upath, &unit_content)?;

    run_systemctl(&["daemon-reload"]).await?;
    run_systemctl(&["enable", "--now", unit.service_name()]).await?;

    info!(unit = %unit.unit_name(), "service installed and started");
    Ok(())
}

/// Stop + disable + remove the unit file for the given service unit.
///
/// Best-effort: does not fail if the service is already stopped or missing.
///
/// Callers that can race with install/uninstall/GC must hold the service lock.
pub(crate) async fn uninstall_service_unit(unit: &RunnerServiceUnit) -> RunnerResult<()> {
    // Best-effort stop + disable (may already be stopped/disabled).
    let _ = run_systemctl(&["stop", unit.service_name()]).await;
    let _ = run_systemctl(&["disable", unit.service_name()]).await;

    // Remove the unit file if it exists.
    let upath = unit.unit_file_path();
    if let Err(e) = cleanup_unit_staging_files(upath) {
        warn!(unit = %unit.unit_name(), error = %e, "failed to remove stale unit staging files");
    }
    if let Err(e) = remove_unit_file_if_exists(upath) {
        warn!(unit = %unit.unit_name(), error = %e, "failed to remove unit file");
    }

    if let Err(e) = run_systemctl(&["daemon-reload"]).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to reload systemd daemon");
    }

    info!(unit = %unit.unit_name(), "service uninstalled");
    Ok(())
}

/// `service uninstall` — stop + disable + remove unit file.
///
/// Refuses when the runner has active jobs unless `--force` is passed.
async fn uninstall(args: ServiceUninstallArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let _service_lock = acquire_service_lock(&unit).await?;
    check_active_jobs_gate(&unit, args.force, "uninstall").await?;
    uninstall_service_unit(&unit).await
}

/// `service drain` — send SIGUSR1, disable unit, return immediately.
async fn drain(args: ServiceDrainArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    if is_unit_active(&unit).await? {
        // `is_unit_active` above can race against the runner exiting on its own:
        // by the time we read MainPID or call `kill`, the process may be gone.
        // Both outcomes ("live, signal delivered" and "already gone") must still
        // run `systemctl disable` below so the unit does not auto-start at the
        // next boot.
        match signal_service_main(&unit, nix::sys::signal::Signal::SIGUSR1).await? {
            ServiceSignalOutcome::Sent { pid } => {
                info!(unit = %unit.unit_name(), pid, "sent SIGUSR1 (drain)");
            }
            ServiceSignalOutcome::AlreadyGone => {
                info!(unit = %unit.unit_name(), "runner already exited; drain signal not needed");
            }
        }
    } else {
        info!(unit = %unit.unit_name(), "no active service found; drain signal not needed");
    }

    // Disable so it won't restart on reboot. At this point the runner either
    // saw SIGUSR1, already exited, or was inactive, so disabling is the
    // remaining retirement step. Surface the hint on stderr in addition to
    // the structured log so CLI users don't miss it.
    if let Err(e) = run_systemctl(&["disable", unit.service_name()]).await {
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

/// `service resume` — send SIGUSR2, re-enable unit.
///
/// Reverses a prior `service drain` while the runner is still `Draining`.
/// If the runner has already transitioned to `Stopping` (teardown in
/// progress) or exited, resume is refused. SIGUSR2 on an already-`Running`
/// runner is a no-op on the runner side (the state guard rejects the
/// transition).
async fn resume(args: ServiceResumeArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    if !is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "{} is not active — cannot resume an inactive runner",
            unit.unit_name()
        )));
    }

    // Preflight: if status.json shows the runner is already past the
    // resumable point (Stopping = teardown in progress, Stopped = exited),
    // SIGUSR2 is too late.
    if let Some(base_dir) = runner_base_dir(&unit) {
        match read_runner_status(&base_dir).await {
            Ok(status) if matches!(status.mode.as_str(), "stopping" | "stopped") => {
                return Err(RunnerError::Internal(format!(
                    "{} is already shutting down (mode={}) — cannot resume",
                    unit.unit_name(),
                    status.mode
                )));
            }
            Ok(_) => {}
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

    // Same race as in `drain`: the runner can exit after the preflight
    // `is_unit_active` check but before we deliver SIGUSR2. Unlike drain,
    // there is no useful cleanup left once the runner is gone — resume is
    // meaningless — so surface the same "not active" error the preflight
    // branch above already returns.
    match signal_service_main(&unit, nix::sys::signal::Signal::SIGUSR2).await? {
        ServiceSignalOutcome::Sent { pid } => {
            info!(unit = %unit.unit_name(), pid, "sent SIGUSR2 (resume)");
        }
        ServiceSignalOutcome::AlreadyGone => {
            info!(
                unit = %unit.unit_name(),
                "runner exited between preflight and signal; refusing resume",
            );
            return Err(RunnerError::Internal(format!(
                "{} is not active — cannot resume an inactive runner",
                unit.unit_name()
            )));
        }
    }

    // Re-enable so the unit restarts on reboot (undoes the disable from drain).
    // Use `enable` (not `--now`) — the service is already running. SIGUSR2
    // has already been delivered so the runner IS resumed; a re-enable
    // failure is partial success. Surface the hint on stderr so CLI users
    // don't miss it.
    if let Err(e) = run_systemctl(&["enable", unit.service_name()]).await {
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

/// `service status` — show systemctl status for the named unit, or all runner units.
async fn status(args: ServiceStatusArgs) -> RunnerResult<()> {
    let pattern = match &args.name {
        Some(suffix) => RunnerServiceUnit::from_suffix(suffix)?
            .service_name()
            .to_string(),
        None => target::all_units_pattern(),
    };
    // Inherit stdout so user sees output directly.
    // systemctl status returns exit code 3 for inactive — ignore exit code.
    tokio::process::Command::new("systemctl")
        .args(["status", &pattern])
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl: {e}")))?;
    Ok(())
}

/// `service logs` — show journalctl output for the named unit.
async fn logs(args: ServiceLogsArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let lines = args.lines.to_string();
    let mut cmd = tokio::process::Command::new("journalctl");
    cmd.args(["--unit", unit.service_name(), "--lines", &lines]);
    if args.follow {
        cmd.arg("--follow");
    }
    let status = cmd
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn journalctl: {e}")))?;
    journalctl_logs_status(unit.service_name(), status)
}
