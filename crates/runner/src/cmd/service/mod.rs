use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, touch_mtime};
use clap::{Args, Subcommand};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

mod diagnostic;
mod drain_override;
mod gate;
mod signal;
mod systemctl;
mod target;
mod unit_config;
mod unit_file;

pub(crate) use systemctl::{is_unit_active, is_unit_enabled};
pub(crate) use target::RunnerServiceUnit;
pub(crate) use unit_config::read_unit_config_path;

use drain_override::{remove_drain_restart_override, write_drain_restart_override};
use gate::{check_active_jobs_gate, read_runner_status, runner_base_dir};
use signal::{ServiceSignalOutcome, signal_service_main};
use systemctl::{get_service_restart_policy, journalctl_logs_status, run_systemctl};
use unit_file::{
    RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE, cleanup_unit_staging_files, generate_unit_file,
    remove_unit_file_if_exists, resolve_config_path, validate_current_exe_path, validate_env_vars,
    validate_systemd_path, write_unit_file,
};

const SERVICE_CONFIG_SNAPSHOT_DIR: &str = "service-config-snapshots";

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
    /// Path to runner config YAML to snapshot for service activation
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
    home: &HomePaths,
) -> RunnerResult<nix::fcntl::Flock<std::fs::File>> {
    crate::lock::acquire(home.service_lock(unit.unit_name())).await
}

struct ServiceActivationConfig {
    snapshot_path: PathBuf,
    image_artifact_guards: crate::config::LockedRunnerImageArtifacts,
}

fn service_activation_config_snapshot_path(
    unit: &RunnerServiceUnit,
    base_dir: &Path,
    snapshot_content: &[u8],
) -> PathBuf {
    let digest = hex::encode(Sha256::digest(snapshot_content));
    base_dir
        .join(SERVICE_CONFIG_SNAPSHOT_DIR)
        .join(format!("{}-{digest}.yaml", unit.suffix()))
}

fn systemd_run_limit_nofile_property_arg() -> String {
    format!("--property={RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE}")
}

async fn reload_systemd_if_drain_restart_override_removed(
    unit: &RunnerServiceUnit,
) -> RunnerResult<()> {
    if remove_drain_restart_override(unit)? {
        run_systemctl(&["daemon-reload"]).await?;
    }
    Ok(())
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

type ServiceFuture<'a, T> = Pin<Box<dyn Future<Output = RunnerResult<T>> + 'a>>;

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

struct RealServiceDrainOps;

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
                if ops.is_active(unit).await? {
                    rollback_drain_restart_override(unit, ops, "restart_policy").await;
                    return Err(e);
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
        // `is_unit_active` above can race against the runner exiting on its own:
        // by the time we read MainPID or call `kill`, the process may be gone.
        // Both outcomes ("live, signal delivered" and "already gone") must still
        // run `systemctl disable` below so the unit does not auto-start at the
        // next boot.
        match ops.signal_drain(unit).await {
            Err(e) => {
                rollback_drain_restart_override(unit, ops, "signal_drain").await;
                return Err(e);
            }
            Ok(ServiceSignalOutcome::Sent { pid }) => {
                info!(unit = %unit.unit_name(), pid, "sent SIGUSR1 (drain)");
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

async fn prepare_service_activation_config(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    home: &HomePaths,
) -> RunnerResult<ServiceActivationConfig> {
    let runner_config = crate::config::load(config_path).await?;
    let snapshot_content = serde_yaml_ng::to_string(&runner_config)
        .map_err(|e| RunnerError::Config(format!("serialize activation config snapshot: {e}")))?;
    let snapshot_path = service_activation_config_snapshot_path(
        unit,
        &runner_config.base_dir,
        snapshot_content.as_bytes(),
    );
    validate_systemd_path("activation config path", &snapshot_path)?;

    let image_artifact_guards =
        crate::config::lock_and_validate_runner_image_artifacts(&runner_config.profiles, home)
            .await?;

    crate::private_fs::ensure_private_dir(&runner_config.base_dir).await?;
    let snapshot_dir = snapshot_path.parent().ok_or_else(|| {
        RunnerError::Internal(format!(
            "activation config snapshot path has no parent: {}",
            snapshot_path.display()
        ))
    })?;
    crate::private_fs::ensure_private_dir(snapshot_dir).await?;
    crate::private_fs::write_private_file(&snapshot_path, snapshot_content.as_bytes()).await?;

    Ok(ServiceActivationConfig {
        snapshot_path,
        image_artifact_guards,
    })
}

async fn with_service_activation_image_artifacts<T, Fut>(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    home: &HomePaths,
    activation: impl FnOnce(PathBuf) -> Fut,
) -> RunnerResult<T>
where
    Fut: Future<Output = RunnerResult<T>>,
{
    let activation_config = prepare_service_activation_config(unit, config_path, home).await?;

    let output = activation(activation_config.snapshot_path).await?;
    touch_service_activation_image_artifacts(&activation_config.image_artifact_guards);
    Ok(output)
}

fn touch_service_activation_image_artifacts(
    image_artifact_guards: &crate::config::LockedRunnerImageArtifacts,
) {
    for (_, profile_paths) in image_artifact_guards.profile_paths() {
        touch_mtime(profile_paths.rootfs_paths().dir());
        touch_mtime(profile_paths.snapshot_paths().dir());
    }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/// `service start` — transient unit via systemd-run (CI).
async fn start(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

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
    reload_systemd_if_drain_restart_override_removed(&unit).await?;

    let unit_arg = format!("--unit={}", unit.unit_name());
    let desc_arg = format!("--description=VM0 Runner ({})", unit.unit_name());
    let syslog_arg = format!("--property=SyslogIdentifier={}", unit.unit_name());
    let nofile_arg = systemd_run_limit_nofile_property_arg();
    with_service_activation_image_artifacts(
        &unit,
        &config_path,
        &home,
        |snapshot_path| async move {
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
                &*nofile_arg,
                &*syslog_arg,
            ]);
            for entry in &args.env {
                cmd.arg(format!("--setenv={entry}"));
            }
            cmd.arg(&exe_path)
                .args(["start", "--config"])
                .arg(&snapshot_path);
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
            Ok(())
        },
    )
    .await?;

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
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

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
    if let Err(e) = reload_systemd_if_drain_restart_override_removed(&unit).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to remove drain restart override after stop");
        eprintln!(
            "WARNING: stop could not remove the drain restart override for {}: {e}.",
            unit.service_name()
        );
    }
    Ok(())
}

/// `service install` — persistent unit file (production).
async fn install(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

    validate_env_vars(&args.env)?;

    let config_path = resolve_config_path(&args.config)?;
    let exe_path = validate_current_exe_path(
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?,
    )?;
    validate_systemd_path("current executable path", &exe_path)?;
    validate_systemd_path("config path", &config_path)?;

    let unit_for_activation = unit.clone();
    let upath = unit.unit_file_path().to_path_buf();

    with_service_activation_image_artifacts(
        &unit,
        &config_path,
        &home,
        |snapshot_path| async move {
            let unit_content = generate_unit_file(
                &unit_for_activation,
                &exe_path,
                &snapshot_path,
                &args.env,
                args.local,
            );
            cleanup_unit_staging_files(&upath)?;
            write_unit_file(&upath, &unit_content)?;
            remove_drain_restart_override(&unit_for_activation)?;

            run_systemctl(&["daemon-reload"]).await?;
            run_systemctl(&["enable", "--now", unit_for_activation.service_name()]).await?;
            Ok(())
        },
    )
    .await?;

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
    if let Err(e) = remove_drain_restart_override(unit) {
        warn!(unit = %unit.unit_name(), error = %e, "failed to remove drain restart override");
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
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;
    check_active_jobs_gate(&unit, args.force, "uninstall").await?;
    uninstall_service_unit(&unit).await
}

/// `service drain` — send SIGUSR1, disable unit, return immediately.
async fn drain(args: ServiceDrainArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;
    drain_with_ops(&unit, &mut RealServiceDrainOps).await
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
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

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

    reload_systemd_if_drain_restart_override_removed(&unit).await?;

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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, SystemTime};

    use crate::paths::RootfsPaths;

    const TEST_ROOTFS_HASH: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TEST_SNAPSHOT_HASH: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    struct ServiceActivationFixture {
        _dir: tempfile::TempDir,
        home: HomePaths,
        config_path: PathBuf,
        base_dir: PathBuf,
        ca_dir: PathBuf,
        firecracker: PathBuf,
        kernel: PathBuf,
    }

    impl ServiceActivationFixture {
        async fn with_complete_artifacts() -> Self {
            let fixture = Self::without_artifacts().await;
            write_complete_artifacts(&fixture.home).await;
            fixture
        }

        async fn with_complete_artifacts_and_relative_config() -> Self {
            let fixture = Self::without_artifacts_with_relative_config().await;
            write_complete_artifacts(&fixture.home).await;
            fixture
        }

        async fn without_artifacts() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let firecracker = dir.path().join("firecracker");
            let kernel = dir.path().join("vmlinux");
            tokio::fs::write(&firecracker, b"").await.unwrap();
            tokio::fs::write(&kernel, b"").await.unwrap();

            let config_path = dir.path().join("runner.yaml");
            let base_dir = dir.path().to_path_buf();
            let ca_dir = dir.path().to_path_buf();
            write_config(&config_path, &base_dir, &ca_dir, &firecracker, &kernel)
                .await
                .unwrap();

            Self {
                home: HomePaths::with_root(dir.path().join("vm0-runner")),
                base_dir,
                ca_dir,
                firecracker,
                kernel,
                _dir: dir,
                config_path,
            }
        }

        async fn without_artifacts_with_relative_config() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = dir.path().join("config");
            let base_dir = config_dir.join("runner-state");
            let ca_dir = config_dir.join("ca");
            let firecracker = config_dir.join("bin/firecracker");
            let kernel = config_dir.join("bin/vmlinux");
            tokio::fs::create_dir_all(firecracker.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(&firecracker, b"").await.unwrap();
            tokio::fs::write(&kernel, b"").await.unwrap();
            tokio::fs::create_dir_all(&ca_dir).await.unwrap();

            let config_path = config_dir.join("runner.yaml");
            write_config(
                &config_path,
                Path::new("runner-state"),
                Path::new("ca"),
                Path::new("bin/firecracker"),
                Path::new("bin/vmlinux"),
            )
            .await
            .unwrap();

            Self {
                home: HomePaths::with_root(dir.path().join("vm0-runner")),
                base_dir,
                ca_dir,
                firecracker,
                kernel,
                _dir: dir,
                config_path,
            }
        }

        fn rootfs(&self) -> RootfsPaths {
            RootfsPaths::new(&self.home, TEST_ROOTFS_HASH)
        }
    }

    async fn write_config(
        config_path: &Path,
        base_dir: &Path,
        ca_dir: &Path,
        firecracker: &Path,
        kernel: &Path,
    ) -> std::io::Result<()> {
        tokio::fs::write(
            config_path,
            format!(
                r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {firecracker}
  kernel: {kernel}
profiles:
  vm0/default:
    rootfs_hash: {TEST_ROOTFS_HASH}
    snapshot_hash: {TEST_SNAPSHOT_HASH}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
                base_dir = base_dir.display(),
                ca_dir = ca_dir.display(),
                firecracker = firecracker.display(),
                kernel = kernel.display(),
            ),
        )
        .await
    }

    async fn write_complete_artifacts(home: &HomePaths) {
        let rootfs = RootfsPaths::new(home, TEST_ROOTFS_HASH);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();

        let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
        tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
        for path in [
            snapshot.snapshot_bin(),
            snapshot.memory_bin(),
            snapshot.cow_img(),
            snapshot.cow_bitmap(),
        ] {
            tokio::fs::write(path, b"snapshot").await.unwrap();
        }
        tokio::fs::write(
            snapshot.complete_marker(),
            sandbox_fc::SNAPSHOT_COMPLETE_MARKER_CONTENT,
        )
        .await
        .unwrap();
    }

    async fn assert_artifact_locks_held(home: &HomePaths) {
        let rootfs_err = crate::lock::try_acquire(home.rootfs_lock(TEST_ROOTFS_HASH))
            .await
            .unwrap_err();
        assert!(
            rootfs_err.to_string().contains("lock is already held"),
            "unexpected rootfs lock error: {rootfs_err}"
        );

        let snapshot_err = crate::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
            .await
            .unwrap_err();
        assert!(
            snapshot_err.to_string().contains("lock is already held"),
            "unexpected snapshot lock error: {snapshot_err}"
        );
    }

    async fn assert_artifact_locks_released(home: &HomePaths) {
        let rootfs_lock = crate::lock::try_acquire(home.rootfs_lock(TEST_ROOTFS_HASH))
            .await
            .unwrap();
        drop(rootfs_lock);

        let snapshot_lock = crate::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
            .await
            .unwrap();
        drop(snapshot_lock);
    }

    fn set_dir_mtime(path: &Path, time: SystemTime) {
        let file = std::fs::File::open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(time))
            .unwrap();
    }

    fn dir_mtime(path: &Path) -> SystemTime {
        std::fs::metadata(path).unwrap().modified().unwrap()
    }

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    struct FakeDrainOps {
        events: Vec<&'static str>,
        active_results: VecDeque<bool>,
        write_error: bool,
        remove_error: bool,
        reload_error: bool,
        restart_policy_error: bool,
        restart_policy: String,
        signal_error: bool,
        signal_outcome: ServiceSignalOutcome,
        disable_error: bool,
    }

    impl Default for FakeDrainOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                active_results: VecDeque::from([true]),
                write_error: false,
                remove_error: false,
                reload_error: false,
                restart_policy_error: false,
                restart_policy: "no".to_string(),
                signal_error: false,
                signal_outcome: ServiceSignalOutcome::Sent { pid: 123 },
                disable_error: false,
            }
        }
    }

    fn fake_error(message: &str) -> RunnerError {
        RunnerError::Internal(message.to_string())
    }

    impl ServiceDrainOps for FakeDrainOps {
        fn is_active<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
            self.events.push("is_active");
            Box::pin(std::future::ready(Ok(self
                .active_results
                .pop_front()
                .unwrap_or(false))))
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
    async fn drain_inactive_service_skips_restart_override_and_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            active_results: VecDeque::from([false]),
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
            active_results: VecDeque::from([true, true]),
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
    async fn drain_restart_policy_error_for_exited_service_still_disables_unit() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            active_results: VecDeque::from([true, false]),
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

    #[test]
    fn systemd_run_uses_explicit_soft_and_hard_nofile_limit() {
        assert_eq!(
            systemd_run_limit_nofile_property_arg(),
            "--property=LimitNOFILE=524288:524288"
        );
    }

    #[test]
    fn activation_config_snapshot_path_is_content_addressed() {
        let unit = service_unit();
        let base_dir = Path::new("/var/lib/vm0-runner/runners/test");

        let first = service_activation_config_snapshot_path(&unit, base_dir, b"name: test\n");
        let second = service_activation_config_snapshot_path(&unit, base_dir, b"name: test\n");
        let different =
            service_activation_config_snapshot_path(&unit, base_dir, b"name: different\n");

        assert_eq!(first, second);
        assert_ne!(first, different);
        assert_eq!(
            first.parent().unwrap(),
            base_dir.join(SERVICE_CONFIG_SNAPSHOT_DIR)
        );
        assert!(
            first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("test-")
        );
        assert!(
            first
                .extension()
                .is_some_and(|extension| extension == "yaml")
        );
    }

    #[tokio::test]
    async fn activation_config_snapshot_serializes_resolved_paths_and_is_private() {
        let fixture = ServiceActivationFixture::with_complete_artifacts_and_relative_config().await;
        let activation_config =
            prepare_service_activation_config(&service_unit(), &fixture.config_path, &fixture.home)
                .await
                .unwrap();

        assert_ne!(activation_config.snapshot_path, fixture.config_path);
        assert!(
            activation_config
                .snapshot_path
                .starts_with(fixture.base_dir.join(SERVICE_CONFIG_SNAPSHOT_DIR))
        );

        let snapshot = crate::config::load_for_start(&activation_config.snapshot_path, None)
            .await
            .unwrap();
        assert_eq!(snapshot.base_dir, fixture.base_dir);
        assert_eq!(snapshot.ca_dir, fixture.ca_dir);
        assert_eq!(snapshot.firecracker.binary, fixture.firecracker);
        assert_eq!(snapshot.firecracker.kernel, fixture.kernel);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = std::fs::metadata(&activation_config.snapshot_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn activation_guard_hands_stable_snapshot_path_to_activation() {
        let fixture = ServiceActivationFixture::with_complete_artifacts().await;
        let config_path = fixture.config_path.clone();
        let base_dir = fixture.base_dir.clone();

        let snapshot_path = with_service_activation_image_artifacts(
            &service_unit(),
            &fixture.config_path,
            &fixture.home,
            |snapshot_path| async move {
                assert_ne!(snapshot_path, config_path);
                assert!(snapshot_path.starts_with(base_dir.join(SERVICE_CONFIG_SNAPSHOT_DIR)));

                tokio::fs::write(&config_path, "name: mutated\n")
                    .await
                    .unwrap();

                let snapshot_content = tokio::fs::read_to_string(&snapshot_path).await.unwrap();
                assert!(snapshot_content.contains(TEST_ROOTFS_HASH));
                assert!(snapshot_content.contains(TEST_SNAPSHOT_HASH));
                assert!(!snapshot_content.contains("mutated"));
                Ok(snapshot_path)
            },
        )
        .await
        .unwrap();

        assert!(snapshot_path.exists());
    }

    #[tokio::test]
    async fn activation_guard_rejects_incomplete_artifacts_before_activation() {
        let fixture = ServiceActivationFixture::without_artifacts().await;
        let activation_polled = Arc::new(AtomicBool::new(false));
        let activation_polled_in_task = activation_polled.clone();

        let err = with_service_activation_image_artifacts(
            &service_unit(),
            &fixture.config_path,
            &fixture.home,
            |_| async {
                activation_polled_in_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("rootfs") && err.to_string().contains("not found"),
            "unexpected error: {err}"
        );
        assert!(!activation_polled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn activation_guard_holds_locks_during_activation_and_releases_after_success() {
        let fixture = ServiceActivationFixture::with_complete_artifacts().await;

        with_service_activation_image_artifacts(
            &service_unit(),
            &fixture.config_path,
            &fixture.home,
            |_| async {
                assert_artifact_locks_held(&fixture.home).await;
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_artifact_locks_released(&fixture.home).await;
    }

    #[tokio::test]
    async fn activation_guard_touches_artifacts_after_success() {
        let fixture = ServiceActivationFixture::with_complete_artifacts().await;
        let rootfs = fixture.rootfs();
        let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(60);
        set_dir_mtime(rootfs.dir(), old_time);
        set_dir_mtime(snapshot.dir(), old_time);

        with_service_activation_image_artifacts(
            &service_unit(),
            &fixture.config_path,
            &fixture.home,
            |_| async {
                assert_eq!(dir_mtime(rootfs.dir()), old_time);
                assert_eq!(dir_mtime(snapshot.dir()), old_time);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(dir_mtime(rootfs.dir()) > old_time);
        assert!(dir_mtime(snapshot.dir()) > old_time);
    }

    #[tokio::test]
    async fn activation_guard_releases_locks_after_failure_without_touching_artifacts() {
        let fixture = ServiceActivationFixture::with_complete_artifacts().await;
        let rootfs = fixture.rootfs();
        let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(60);
        set_dir_mtime(rootfs.dir(), old_time);
        set_dir_mtime(snapshot.dir(), old_time);

        let err = with_service_activation_image_artifacts(
            &service_unit(),
            &fixture.config_path,
            &fixture.home,
            |_| async {
                assert_artifact_locks_held(&fixture.home).await;
                Err::<(), RunnerError>(RunnerError::Internal("activation failed".to_string()))
            },
        )
        .await
        .unwrap_err();

        assert_eq!(err.to_string(), "internal error: activation failed");
        assert_artifact_locks_released(&fixture.home).await;
        assert_eq!(dir_mtime(rootfs.dir()), old_time);
        assert_eq!(dir_mtime(snapshot.dir()), old_time);
    }
}
