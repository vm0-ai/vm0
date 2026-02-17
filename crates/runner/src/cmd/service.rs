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
    Start(ServiceStartArgs),
    /// Stop the runner service
    Stop(ServiceNameArgs),
    /// Install runner as a persistent systemd service (production, survives reboot)
    Install(ServiceInstallArgs),
    /// Uninstall the runner service (stop + disable + remove unit)
    Uninstall(ServiceNameArgs),
    /// Drain the runner (SIGUSR1, non-blocking — returns immediately)
    Drain(ServiceNameArgs),
    /// Show service status (all runner services if --name is omitted)
    Status(ServiceStatusArgs),
    /// Show service logs
    Logs(ServiceLogsArgs),
}

#[derive(Args)]
struct ServiceStartArgs {
    /// Path to runner config YAML
    #[arg(long, short)]
    config: PathBuf,
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

#[derive(Args)]
struct ServiceInstallArgs {
    /// Path to runner config YAML
    #[arg(long, short)]
    config: PathBuf,
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
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
fn unit_name(suffix: &str) -> RunnerResult<String> {
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
fn generate_unit_file(unit: &str, exe_path: &Path, config_path: &Path, user: &str) -> String {
    format!(
        "\
[Unit]
Description=VM0 Runner ({unit})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=\"{exe}\" start --config \"{config}\"
Restart=on-failure
RestartSec=5
MemoryMax=2G
KillSignal=SIGTERM
TimeoutStopSec=300
User={user}
StandardOutput=journal
StandardError=journal
SyslogIdentifier={unit}

[Install]
WantedBy=multi-user.target
",
        exe = exe_path.display(),
        config = config_path.display(),
    )
}

/// Run `sudo systemctl <args>` and check exit status.
async fn run_systemctl(args: &[&str]) -> RunnerResult<()> {
    let status = tokio::process::Command::new("sudo")
        .arg("systemctl")
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

/// Write a unit file via `sudo tee`.
async fn write_unit_file(path: &Path, content: &str) -> RunnerResult<()> {
    use tokio::io::AsyncWriteExt;

    let mut child = tokio::process::Command::new("sudo")
        .args(["tee", &path.to_string_lossy()])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("spawn sudo tee: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|e| RunnerError::Internal(format!("write unit file: {e}")))?;
    }

    let status = child
        .wait()
        .await
        .map_err(|e| RunnerError::Internal(format!("wait sudo tee: {e}")))?;
    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "sudo tee {} failed: {status}",
            path.display()
        )));
    }
    Ok(())
}

/// Check whether a systemd unit is active (running or activating).
async fn is_unit_active(name: &str) -> RunnerResult<bool> {
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
async fn start(args: ServiceStartArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;

    if is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "unit {unit} is already running, stop it first with: runner service stop --name {}",
            args.name
        )));
    }

    let config_path = resolve_config_path(&args.config)?;
    let exe_path =
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?;
    let uid = nix::unistd::getuid();

    let unit_arg = format!("--unit={unit}");
    let desc_arg = format!("--description=VM0 Runner ({unit})");
    let syslog_arg = format!("--property=SyslogIdentifier={unit}");
    let uid_arg = format!("--uid={uid}");

    let status = tokio::process::Command::new("sudo")
        .args([
            "systemd-run",
            &unit_arg,
            &desc_arg,
            "--property=Type=exec",
            "--property=Restart=on-failure",
            "--property=RestartSec=5",
            "--property=MemoryMax=2G",
            "--property=StandardOutput=journal",
            "--property=StandardError=journal",
            "--property=KillSignal=SIGTERM",
            "--property=TimeoutStopSec=300",
            &syslog_arg,
            &uid_arg,
        ])
        .arg(&exe_path)
        .args(["start", "--config"])
        .arg(&config_path)
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
async fn stop(args: ServiceNameArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    if !is_unit_active(&unit).await? {
        info!(unit = %unit, "no active service found");
        return Ok(());
    }
    let svc = format!("{unit}.service");
    run_systemctl(&["stop", &svc]).await?;
    info!(unit = %unit, "stopped");
    Ok(())
}

/// `service install` — persistent unit file (production).
async fn install(args: ServiceInstallArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    let config_path = resolve_config_path(&args.config)?;
    let exe_path =
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?;
    let uid = nix::unistd::getuid();
    let user = nix::unistd::User::from_uid(uid)
        .map_err(|e| RunnerError::Internal(format!("lookup user for uid {uid}: {e}")))?
        .ok_or_else(|| RunnerError::Internal(format!("no user found for uid {uid}")))?
        .name;

    let unit_content = generate_unit_file(&unit, &exe_path, &config_path, &user);
    let upath = unit_file_path(&unit);

    write_unit_file(&upath, &unit_content).await?;

    run_systemctl(&["daemon-reload"]).await?;
    let svc = format!("{unit}.service");
    run_systemctl(&["enable", "--now", &svc]).await?;

    info!(unit = %unit, "service installed and started");
    Ok(())
}

/// `service uninstall` — stop + disable + remove unit file.
async fn uninstall(args: ServiceNameArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    let svc = format!("{unit}.service");

    // Best-effort stop + disable (may already be stopped/disabled).
    let _ = run_systemctl(&["stop", &svc]).await;
    let _ = run_systemctl(&["disable", &svc]).await;

    // Remove the unit file if it exists.
    let upath = unit_file_path(&unit);
    let rm_result = tokio::process::Command::new("sudo")
        .args(["rm", "-f", &upath.to_string_lossy()])
        .status()
        .await;
    if let Err(e) = rm_result {
        warn!(unit = %unit, error = %e, "failed to remove unit file");
    }

    if let Err(e) = run_systemctl(&["daemon-reload"]).await {
        warn!(unit = %unit, error = %e, "failed to reload systemd daemon");
    }

    info!(unit = %unit, "service uninstalled");
    Ok(())
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
            Path::new("/home/ubuntu/.vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            "ubuntu",
        );
        assert!(content.contains("Description=VM0 Runner (vm0-runner-v0.1.0)"));
        assert!(content.contains(
            "ExecStart=\"/home/ubuntu/.vm0-runner/bin/v0.1.0/vm0-runner\" start --config \"/home/ubuntu/runner.yaml\""
        ));
        assert!(content.contains("User=ubuntu"));
        assert!(content.contains("SyslogIdentifier=vm0-runner-v0.1.0"));
        assert!(content.contains("Restart=on-failure"));
        assert!(content.contains("TimeoutStopSec=300"));
        assert!(content.contains("MemoryMax=2G"));
        assert!(content.contains("[Install]"));
        assert!(content.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn test_generate_unit_file_special_chars() {
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/opt/my runner/vm0-runner"),
            Path::new("/opt/my config/runner.yaml"),
            "deploy-user",
        );
        assert!(content.contains(
            "ExecStart=\"/opt/my runner/vm0-runner\" start --config \"/opt/my config/runner.yaml\""
        ));
        assert!(content.contains("User=deploy-user"));
    }
}
