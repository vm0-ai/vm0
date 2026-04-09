use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};

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
    Stop(ServiceNameArgs),
    /// Install runner as a persistent systemd service (production, survives reboot)
    Install(ServiceRunArgs),
    /// Uninstall the runner service (stop + disable + remove unit)
    Uninstall(ServiceNameArgs),
    /// Drain the runner (SIGUSR1, non-blocking — returns immediately)
    Drain(ServiceNameArgs),
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
struct ServiceNameArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
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

#[derive(Args)]
struct ServiceStatusArgs {
    /// Service name suffix (omit to show all runner services)
    #[arg(long)]
    name: Option<String>,
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
        ServiceCommand::Status(a) => status(a).await,
        ServiceCommand::Logs(a) => logs(a).await,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIT_PREFIX: &str = "vm0-runner-";

/// Build the full systemd unit name from the user-supplied suffix.
///
/// Validates that the suffix contains only safe characters for systemd unit
/// names and file paths.
pub(crate) fn unit_name(suffix: &str) -> RunnerResult<String> {
    if suffix.is_empty()
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
    {
        return Err(RunnerError::Config(format!(
            "invalid service name suffix '{suffix}': only alphanumeric, '.', '-', '_' allowed"
        )));
    }
    Ok(format!("{UNIT_PREFIX}{suffix}"))
}

/// Path to the unit file under `/etc/systemd/system/`.
fn unit_file_path(name: &str) -> PathBuf {
    PathBuf::from(format!("/etc/systemd/system/{name}.service"))
}

/// Resolve a config path to an absolute path.
fn resolve_config_path(path: &Path) -> RunnerResult<PathBuf> {
    std::fs::canonicalize(path).map_err(|e| {
        RunnerError::Config(format!(
            "cannot resolve config path {}: {e}",
            path.display()
        ))
    })
}

/// Generate the systemd unit file content.
fn generate_unit_file(
    unit: &str,
    exe_path: &Path,
    config_path: &Path,
    env_vars: &[String],
    local: bool,
) -> String {
    let mut env_lines = String::new();
    for entry in env_vars {
        env_lines.push_str(&format!("Environment=\"{entry}\"\n"));
    }
    let local_flag = if local { " --local" } else { "" };
    format!(
        "\
[Unit]
Description=VM0 Runner ({unit})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=\"{exe}\" start --config \"{config}\"{local_flag}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=300
StandardOutput=journal
StandardError=journal
SyslogIdentifier={unit}
{env_lines}
[Install]
WantedBy=multi-user.target
",
        exe = exe_path.display(),
        config = config_path.display(),
    )
}

/// Validate that each env entry is in `KEY=VALUE` format.
fn validate_env_vars(vars: &[String]) -> RunnerResult<()> {
    for entry in vars {
        let eq_pos = entry.find('=');
        if eq_pos.is_none_or(|p| p == 0) {
            return Err(RunnerError::Config(format!(
                "invalid --env value '{entry}': expected KEY=VALUE format"
            )));
        }
    }
    Ok(())
}

/// Run `systemctl <args>` and check exit status.
async fn run_systemctl(args: &[&str]) -> RunnerResult<()> {
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

/// Write a unit file directly (running as root).
fn write_unit_file(path: &Path, content: &str) -> RunnerResult<()> {
    std::fs::write(path, content)
        .map_err(|e| RunnerError::Internal(format!("write {}: {e}", path.display())))
}

/// Check whether a systemd unit is active (running or activating).
pub(crate) async fn is_unit_active(name: &str) -> RunnerResult<bool> {
    let svc = format!("{name}.service");
    let status = tokio::process::Command::new("systemctl")
        .args(["is-active", "--quiet", &svc])
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl is-active: {e}")))?;
    Ok(status.success())
}

/// Get the main PID of a systemd unit.
async fn get_service_pid(unit: &str) -> RunnerResult<Option<u32>> {
    let svc = format!("{unit}.service");
    let output = tokio::process::Command::new("systemctl")
        .args(["show", &svc, "--property=MainPID", "--value"])
        .output()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl show: {e}")))?;

    let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match pid_str.parse::<u32>() {
        Ok(0) | Err(_) => Ok(None),
        Ok(pid) => Ok(Some(pid)),
    }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/// `service start` — transient unit via systemd-run (CI).
async fn start(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    validate_env_vars(&args.env)?;

    if is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "unit {unit} is already running, stop it first with: runner service stop --name {}",
            args.name
        )));
    }

    let config_path = resolve_config_path(&args.config)?;
    let exe_path =
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?;

    let unit_arg = format!("--unit={unit}");
    let desc_arg = format!("--description=VM0 Runner ({unit})");
    let syslog_arg = format!("--property=SyslogIdentifier={unit}");
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
    info!(unit = %unit, "transient service started");
    Ok(())
}

/// `service stop` — stop the named unit.
///
/// Also clears residual transient unit state so that a subsequent
/// `service start` with the same name succeeds.
async fn stop(args: ServiceNameArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    let svc = format!("{unit}.service");

    if is_unit_active(&unit).await? {
        // Active unit: stop must succeed — failure means the runner process
        // (and its Firecracker VMs) would keep running.
        run_systemctl(&["stop", &svc]).await?;
        info!(unit = %unit, "stopped");
    } else {
        // Unit may be loaded but inactive (residual transient unit).
        // Try stop to trigger systemd GC.  Ignore errors — the unit may
        // not exist at all (first run on this host).
        let _ = run_systemctl(&["stop", &svc]).await;
        info!(unit = %unit, "no active service found");
    }

    // Clear "failed" latch so systemd fully unloads the transient unit.
    // (stop alone does not clear the failed state.)
    let _ = run_systemctl(&["reset-failed", &svc]).await;
    Ok(())
}

/// `service install` — persistent unit file (production).
async fn install(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    validate_env_vars(&args.env)?;
    let config_path = resolve_config_path(&args.config)?;
    let exe_path =
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?;

    let unit_content = generate_unit_file(&unit, &exe_path, &config_path, &args.env, args.local);
    let upath = unit_file_path(&unit);

    write_unit_file(&upath, &unit_content)?;

    run_systemctl(&["daemon-reload"]).await?;
    let svc = format!("{unit}.service");
    run_systemctl(&["enable", "--now", &svc]).await?;

    info!(unit = %unit, "service installed and started");
    Ok(())
}

/// Stop + disable + remove the unit file for the given service suffix.
///
/// Best-effort: does not fail if the service is already stopped or missing.
pub(crate) async fn uninstall_service(suffix: &str) -> RunnerResult<()> {
    let unit = unit_name(suffix)?;
    let svc = format!("{unit}.service");

    // Best-effort stop + disable (may already be stopped/disabled).
    let _ = run_systemctl(&["stop", &svc]).await;
    let _ = run_systemctl(&["disable", &svc]).await;

    // Remove the unit file if it exists.
    let upath = unit_file_path(&unit);
    if upath.exists()
        && let Err(e) = std::fs::remove_file(&upath)
    {
        warn!(unit = %unit, error = %e, "failed to remove unit file");
    }

    if let Err(e) = run_systemctl(&["daemon-reload"]).await {
        warn!(unit = %unit, error = %e, "failed to reload systemd daemon");
    }

    info!(unit = %unit, "service uninstalled");
    Ok(())
}

/// `service uninstall` — stop + disable + remove unit file.
async fn uninstall(args: ServiceNameArgs) -> RunnerResult<()> {
    uninstall_service(&args.name).await
}

/// `service drain` — send SIGUSR1, disable unit, return immediately.
async fn drain(args: ServiceNameArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    if !is_unit_active(&unit).await? {
        info!(unit = %unit, "no active service found");
        return Ok(());
    }

    let pid = get_service_pid(&unit)
        .await?
        .ok_or_else(|| RunnerError::Internal(format!("{unit} has no main PID")))?;

    // Send SIGUSR1 to enter drain mode
    let raw_pid =
        i32::try_from(pid).map_err(|_| RunnerError::Internal(format!("PID {pid} out of range")))?;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(raw_pid),
        nix::sys::signal::Signal::SIGUSR1,
    )
    .map_err(|e| RunnerError::Internal(format!("SIGUSR1 to PID {pid}: {e}")))?;
    info!(unit = %unit, pid, "sent SIGUSR1 (drain)");

    // Disable so it won't restart on reboot
    let svc = format!("{unit}.service");
    if let Err(e) = run_systemctl(&["disable", &svc]).await {
        warn!(unit = %unit, error = %e, "failed to disable unit");
    } else {
        info!(unit = %unit, "disabled (won't restart on reboot)");
    }

    Ok(())
}

/// `service status` — show systemctl status for the named unit, or all runner units.
async fn status(args: ServiceStatusArgs) -> RunnerResult<()> {
    let pattern = match &args.name {
        Some(suffix) => format!("{}.service", unit_name(suffix)?),
        None => format!("{UNIT_PREFIX}*.service"),
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
    let unit = unit_name(&args.name)?;
    let svc = format!("{unit}.service");
    let lines = args.lines.to_string();
    let mut cmd = tokio::process::Command::new("journalctl");
    cmd.args(["--unit", &svc, "--lines", &lines]);
    if args.follow {
        cmd.arg("--follow");
    }
    cmd.status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn journalctl: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unit_name() {
        assert_eq!(unit_name("v0.2.0").unwrap(), "vm0-runner-v0.2.0");
        assert_eq!(unit_name("staging").unwrap(), "vm0-runner-staging");
        assert_eq!(unit_name("my_name-1.0").unwrap(), "vm0-runner-my_name-1.0");
    }

    #[test]
    fn test_unit_name_rejects_invalid() {
        assert!(unit_name("").is_err());
        assert!(unit_name("../evil").is_err());
        assert!(unit_name("has space").is_err());
        assert!(unit_name("semi;colon").is_err());
    }

    #[test]
    fn test_unit_file_path() {
        let path = unit_file_path("vm0-runner-v0.1.0");
        assert_eq!(
            path,
            PathBuf::from("/etc/systemd/system/vm0-runner-v0.1.0.service")
        );
    }

    #[test]
    fn test_generate_unit_file() {
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/var/lib/vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            &[],
            false,
        );
        assert!(content.contains("Description=VM0 Runner (vm0-runner-v0.1.0)"));
        assert!(content.contains(
            "ExecStart=\"/var/lib/vm0-runner/bin/v0.1.0/vm0-runner\" start --config \"/home/ubuntu/runner.yaml\"\n"
        ));
        assert!(!content.contains("User="));
        assert!(content.contains("SyslogIdentifier=vm0-runner-v0.1.0"));
        assert!(content.contains("Restart=on-failure"));
        assert!(content.contains("TimeoutStopSec=300"));
        assert!(content.contains("[Install]"));
        assert!(content.contains("WantedBy=multi-user.target"));
        assert!(!content.contains("Environment="));
        assert!(!content.contains("--local"));
    }

    #[test]
    fn test_generate_unit_file_with_env() {
        let env = vec![
            "VERCEL_AUTOMATION_BYPASS_SECRET=xxx".to_string(),
            "USE_MOCK_CLAUDE=true".to_string(),
            "MY_DESC=hello world".to_string(),
        ];
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/var/lib/vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            &env,
            false,
        );
        assert!(content.contains("Environment=\"VERCEL_AUTOMATION_BYPASS_SECRET=xxx\""));
        assert!(content.contains("Environment=\"USE_MOCK_CLAUDE=true\""));
        assert!(content.contains("Environment=\"MY_DESC=hello world\""));
        assert!(content.contains("\n\n[Install]"));
    }

    #[test]
    fn test_generate_unit_file_special_chars() {
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/opt/my runner/vm0-runner"),
            Path::new("/opt/my config/runner.yaml"),
            &[],
            false,
        );
        assert!(content.contains(
            "ExecStart=\"/opt/my runner/vm0-runner\" start --config \"/opt/my config/runner.yaml\""
        ));
        assert!(!content.contains("User="));
    }

    #[test]
    fn test_generate_unit_file_local_flag() {
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/usr/bin/runner"),
            Path::new("/etc/runner.yaml"),
            &[],
            true,
        );
        assert!(content.contains(
            "ExecStart=\"/usr/bin/runner\" start --config \"/etc/runner.yaml\" --local\n"
        ));
    }

    #[test]
    fn test_validate_env_vars_valid() {
        assert!(validate_env_vars(&[]).is_ok());
        assert!(validate_env_vars(&["KEY=VALUE".to_string()]).is_ok());
        assert!(validate_env_vars(&["K=".to_string()]).is_ok());
        assert!(validate_env_vars(&["K=V=W".to_string()]).is_ok());
    }

    #[test]
    fn test_validate_env_vars_invalid() {
        assert!(validate_env_vars(&["NOEQUALS".to_string()]).is_err());
        assert!(validate_env_vars(&["=VALUE".to_string()]).is_err());
        assert!(validate_env_vars(&["".to_string()]).is_err());
    }
}
