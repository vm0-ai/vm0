use std::path::{Path, PathBuf};

use crate::error::{ActiveJobsError, RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::paths::HomePaths;
use clap::{Args, Subcommand};
use tracing::{info, warn};

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
// Helpers
// ---------------------------------------------------------------------------

const UNIT_PREFIX: &str = "vm0-runner-";

/// Build the full systemd unit name from the user-supplied suffix.
///
/// Validates the suffix with [`crate::runner_dirname::validate_name`] so
/// that runner directory names and service name suffixes follow the same
/// rules (lowercase alphanumeric, hyphens, dots; no leading `.` or `-`).
pub(crate) fn unit_name(suffix: &str) -> RunnerResult<String> {
    if !crate::runner_dirname::validate_name(suffix) {
        return Err(RunnerError::Config(format!(
            "invalid service name suffix '{suffix}': must be non-empty, \
             lowercase alphanumeric, hyphens, and dots; cannot start with '.' or '-'"
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

/// Escape a string for use inside a double-quoted systemd value.
///
/// Three characters need escaping:
/// - `\` and `"`: required by systemd's quoted-string syntax; without
///   escape, the closing `"` is misparsed and the unit file is corrupted.
/// - `%`: systemd performs **specifier expansion** on directive values
///   (`%H` → hostname, `%n` → unit name, `%i` → instance, etc.), so an
///   unescaped `%` followed by a specifier letter gets silently rewritten.
///   `%%` is the literal-`%` escape and is safe across all systemd versions.
///
/// Single-pass iteration intentionally avoids chained `replace` calls:
/// the previous `\\` → `"` order was a hidden contract that future
/// additions to this set could easily get wrong.
fn escape_systemd_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out
}

/// Generate the systemd unit file content.
///
/// User-controllable values (`ExecStart=` paths, `Environment=` values) go
/// through [`escape_systemd_value`] so that input cannot break out of the
/// quotes or trigger systemd specifier expansion. `unit` is not escaped
/// because [`unit_name`] already restricts it to lowercase alphanumeric,
/// hyphens, and dots — no `%`, `\`, `"`, or other systemd special chars
/// can reach `Description=` or `SyslogIdentifier=`.
fn generate_unit_file(
    unit: &str,
    exe_path: &Path,
    config_path: &Path,
    env_vars: &[String],
    local: bool,
) -> String {
    let mut env_lines = String::new();
    for entry in env_vars {
        let escaped = escape_systemd_value(entry);
        env_lines.push_str(&format!("Environment=\"{escaped}\"\n"));
    }
    let local_flag = if local { " --local" } else { "" };
    let exe = escape_systemd_value(&exe_path.display().to_string());
    let config = escape_systemd_value(&config_path.display().to_string());
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
    )
}

/// Validate that each env entry is in `KEY=VALUE` format and contains no
/// characters that would silently corrupt the generated systemd unit file.
///
/// Bare newlines / carriage returns / NUL bytes inside a value break the
/// `Environment=` directive even with proper quote/backslash escaping
/// (a literal newline terminates the directive line). Reject these at
/// install time rather than letting `daemon-reload` fail obscurely later.
fn validate_env_vars(vars: &[String]) -> RunnerResult<()> {
    for entry in vars {
        // Check dangerous chars first so the KEY=VALUE error below can
        // safely interpolate `entry` without leaking newlines/NUL into
        // log output.
        if entry.contains(['\n', '\r', '\0']) {
            return Err(RunnerError::Config(
                "invalid --env value: newline or NUL characters are not allowed".to_string(),
            ));
        }
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

/// Write a unit file atomically: stage to a sibling `.tmp` file, then rename.
///
/// `rename(2)` is atomic on the same filesystem, so a concurrent
/// `systemctl daemon-reload` (possibly triggered by unrelated unit changes
/// on the host) sees either the old file or the new file — never a
/// half-written one. Without this, the truncate+write window inside
/// `std::fs::write` could let systemd parse a partial unit file and leave
/// the unit in a broken state. Same pattern as `status::write_status`.
fn write_unit_file(path: &Path, content: &str) -> RunnerResult<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)
        .map_err(|e| RunnerError::Internal(format!("write {}: {e}", tmp.display())))?;
    let result = std::fs::rename(&tmp, path).map_err(|e| {
        RunnerError::Internal(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    });
    // Unlike short-lived dirs elsewhere in the crate, unit files live in
    // /etc/systemd/system/ which no GC path sweeps, and the staged content
    // contains Environment= secrets.
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
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

/// Outcome of attempting to signal a systemd unit's main process.
///
/// The `AlreadyGone` variant collapses two distinct races into a single
/// state so callers can encode one policy instead of two:
///
/// 1. `systemctl show --property=MainPID` read `0` — the runner either
///    exited, or systemd is mid-transition and has cleared MainPID.
/// 2. MainPID resolved to a live value but `kill(2)` returned `ESRCH`
///    because the process exited in the ~µs window before signal delivery.
///
/// Either way the signal was not delivered, and the cause is the same:
/// the runner is no longer around to receive it. `Sent` carries the PID
/// so callers can keep the pre-refactor `info!(…, pid, …)` structured
/// field in their journald logs.
enum ServiceSignalOutcome {
    Sent { pid: u32 },
    AlreadyGone,
}

/// Send `sig` to the main process of `unit`, tolerating the race between
/// MainPID lookup and signal delivery.
///
/// Callers decide the policy for `AlreadyGone`: `drain` continues to
/// `systemctl disable` (the unit file must still be rewritten so the
/// service does not restart on reboot), while `resume` surfaces an error
/// matching its preflight "not active" branch — a runner that has exited
/// cannot be resumed.
async fn signal_service_main(
    unit: &str,
    sig: nix::sys::signal::Signal,
) -> RunnerResult<ServiceSignalOutcome> {
    let Some(pid) = get_service_pid(unit).await? else {
        return Ok(ServiceSignalOutcome::AlreadyGone);
    };
    let raw_pid =
        i32::try_from(pid).map_err(|_| RunnerError::Internal(format!("PID {pid} out of range")))?;
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw_pid), sig) {
        Ok(()) => Ok(ServiceSignalOutcome::Sent { pid }),
        Err(nix::errno::Errno::ESRCH) => Ok(ServiceSignalOutcome::AlreadyGone),
        Err(e) => Err(RunnerError::Internal(format!("{sig:?} to PID {pid}: {e}"))),
    }
}

// ---------------------------------------------------------------------------
// Active-jobs gate (shared by `service stop` and `service uninstall`)
// ---------------------------------------------------------------------------

/// Resolve the runner's base_dir from its service name suffix using the
/// project-wide convention: `/var/lib/vm0-runner/runners/<suffix>/`.
///
/// This matches `ansible/playbooks/build-runner.yml` and the `--runner-dirname`
/// default in `runner config`. Non-standard `base_dir` overrides (dev-only)
/// will fail to locate status.json and fall through to forceful stop.
fn runner_base_dir(suffix: &str) -> Option<PathBuf> {
    let home = HomePaths::new().ok()?;
    Some(home.runners_dir().join(suffix))
}

/// Parsed snapshot of the runner's status.json.
struct RunnerStatusSnapshot {
    /// Mode string sourced verbatim from status.json. Valid values are the
    /// lowercase serialization of [`crate::status::RunnerMode`]: `"running"`,
    /// `"draining"`, `"stopped"`. Unknown values (e.g. from a newer runner
    /// writing a future variant) are preserved and routed to the normal
    /// refuse branch by [`decide_gate`].
    mode: String,
    /// UUIDs of runs currently in flight.
    run_ids: Vec<RunId>,
    /// How long the runner process itself has been up, derived from the
    /// `started_at` timestamp. status.json does not record per-run start
    /// times, so the error message surfaces this runner-level uptime
    /// rather than a misleading per-job duration.
    uptime: std::time::Duration,
}

fn status_field_preview(value: &str) -> String {
    const MAX_CHARS: usize = 128;
    let mut chars = value.chars();
    let preview = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...[truncated]")
    } else {
        preview
    }
}

#[derive(Debug)]
enum RunnerStatusReadError {
    Read {
        path: PathBuf,
        error: std::io::Error,
    },
    ParseJson {
        path: PathBuf,
        error: serde_json::Error,
    },
    ParseStartedAt {
        started_at: String,
        error: chrono::ParseError,
    },
}

impl std::fmt::Display for RunnerStatusReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, error } => write!(f, "read {}: {error}", path.display()),
            Self::ParseJson { path, error } => write!(f, "parse {}: {error}", path.display()),
            Self::ParseStartedAt { started_at, error } => {
                write!(
                    f,
                    "parse started_at {:?}: {error}",
                    status_field_preview(started_at)
                )
            }
        }
    }
}

/// Decision from [`decide_gate`] — pure function that maps a status
/// snapshot to the gate outcome without performing any I/O.
#[derive(Debug, PartialEq, Eq)]
enum GateDecision {
    /// Let the stop/uninstall proceed.
    Bypass,
    /// Refuse the operation; `draining` selects the UX variant.
    Refuse { draining: bool },
}

/// Pure decision logic shared by the gate — testable without systemctl.
///
/// Short-circuit order:
/// 1. `mode == "stopped"` or `"stopping"` — teardown has already started.
///    The runner is actively cancelling any in-flight jobs itself; a user
///    `stop`/`uninstall` just accelerates the process and is safe.
/// 2. `run_ids.is_empty()` — nothing to protect, regardless of mode.
/// 3. Otherwise refuse; `draining=true` when `mode == "draining"` so the
///    error message suggests waiting rather than re-running `drain`.
///
/// Mode strings mirror [`crate::status::RunnerMode`] (serde lowercase).
fn decide_gate(status: &RunnerStatusSnapshot) -> GateDecision {
    if matches!(status.mode.as_str(), "stopped" | "stopping") {
        return GateDecision::Bypass;
    }
    if status.run_ids.is_empty() {
        return GateDecision::Bypass;
    }
    GateDecision::Refuse {
        draining: status.mode == "draining",
    }
}

/// Read status.json at `base_dir`.
///
/// Returns an error on any I/O or parse failure — the caller should log the
/// reason and fall through to forceful stop (status unknown → cannot protect
/// jobs).
async fn read_runner_status(
    base_dir: &Path,
) -> Result<RunnerStatusSnapshot, RunnerStatusReadError> {
    #[derive(serde::Deserialize)]
    struct StatusFile {
        mode: String,
        active_runs: Vec<ActiveRunEntry>,
        started_at: String,
    }
    #[derive(serde::Deserialize)]
    struct ActiveRunEntry {
        run_id: RunId,
        // `sandbox_id` is present in the file but unused by the gate.
    }
    let path = base_dir.join("status.json");
    let content =
        tokio::fs::read_to_string(&path)
            .await
            .map_err(|error| RunnerStatusReadError::Read {
                path: path.clone(),
                error,
            })?;
    let file: StatusFile = serde_json::from_str(&content)
        .map_err(|error| RunnerStatusReadError::ParseJson { path, error })?;
    let started = chrono::DateTime::parse_from_rfc3339(&file.started_at).map_err(|error| {
        RunnerStatusReadError::ParseStartedAt {
            started_at: file.started_at.clone(),
            error,
        }
    })?;
    let now = chrono::Utc::now();
    let uptime = (now - started.with_timezone(&chrono::Utc))
        .to_std()
        .unwrap_or_default();
    Ok(RunnerStatusSnapshot {
        mode: file.mode,
        run_ids: file.active_runs.into_iter().map(|r| r.run_id).collect(),
        uptime,
    })
}

/// Gate for `service stop` / `service uninstall`: block the operation when
/// the runner has active jobs unless `force` is set.
///
/// Returns `Ok(())` to proceed (either bypassed or confirmed safe). Returns
/// `Err(RunnerError::ActiveJobs(_))` to refuse with a user-facing message.
///
/// ## Transient / race handling
///
/// Each of these conditions returns `Ok(())` to let the operator through,
/// erring on the side of "stop is usable" over "gate is strict":
///
/// 1. **Dead / crashed runner** — if the systemd unit is inactive, the
///    on-disk `active_runs` may be stale (runner was SIGKILLed before it
///    could update status.json). Nothing alive to protect; skip the gate.
/// 2. **Cleanly stopped runner** — `mode == "stopped"` indicates the
///    runner's own drain finished. Covers the short window between
///    status.json being rewritten with `"stopped"` (`start.rs` end of
///    `run_with_config`) and systemd noticing the process has exited
///    (marking the unit inactive). Without this, the gate could spuriously
///    refuse a stop issued during that window.
/// 3. **Base-dir unresolvable** — non-standard deployments that override
///    `base_dir` away from the `/var/lib/vm0-runner/runners/<suffix>`
///    convention fall here. Warn-log and fall through.
/// 4. **Status file unreadable / malformed** — missing file, permission
///    denied, JSON parse error, bad `started_at`: warn-log and fall
///    through. Matches the acceptance criteria.
///
/// When the runner's `mode == "draining"`, we still refuse but flip the
/// `draining` flag so the error renders a wait-or-force message (the
/// operator already initiated drain, so re-suggesting drain would be
/// noise).
///
/// ## TOCTOU (documented, not mitigated)
///
/// Between this gate reading status.json and `systemctl stop` killing the
/// process, the runner may claim a new job via its API poll (seconds
/// cadence). That job will be killed. This is *intentional*: `stop` is
/// defined as forceful. Callers who need zero-race graceful shutdown
/// should use `service drain`. Mitigating this race would require sending
/// SIGUSR1 first and waiting — which is exactly what `drain` does.
async fn check_active_jobs_gate(
    unit: &str,
    suffix: &str,
    force: bool,
    command_name: &'static str,
) -> RunnerResult<()> {
    if force {
        // Leave an audit trail — --force is valid but destructive, so
        // journalctl should show it was used if jobs later appear lost.
        info!(
            unit,
            command = command_name,
            "--force passed, bypassing active-jobs gate"
        );
        return Ok(());
    }

    // (1) Dead-runner short-circuit.
    let active = is_unit_active(unit).await.unwrap_or_else(|e| {
        warn!(unit, error = %e, "cannot check unit state — skipping active-jobs gate");
        false
    });
    if !active {
        return Ok(());
    }

    let Some(base_dir) = runner_base_dir(suffix) else {
        warn!(
            unit,
            "cannot determine vm0-runner home — skipping active-jobs gate"
        );
        return Ok(());
    };
    let status = match read_runner_status(&base_dir).await {
        Ok(status) => status,
        Err(e) => {
            warn!(
                unit,
                base_dir = %base_dir.display(),
                error = %e,
                "cannot read status.json — skipping active-jobs gate"
            );
            return Ok(());
        }
    };

    match decide_gate(&status) {
        GateDecision::Bypass => Ok(()),
        GateDecision::Refuse { draining } => Err(RunnerError::ActiveJobs(ActiveJobsError {
            unit: unit.to_string(),
            suffix: suffix.to_string(),
            run_ids: status.run_ids,
            runner_uptime: status.uptime,
            command_name,
            draining,
        })),
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
///
/// Refuses to stop a runner with active jobs unless `--force` is passed.
/// See [`check_active_jobs_gate`] for the policy.
async fn stop(args: ServiceStopArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    check_active_jobs_gate(&unit, &args.name, args.force, "stop").await?;
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
///
/// Refuses when the runner has active jobs unless `--force` is passed.
/// The internal [`uninstall_service`] helper (called from GC) is not
/// guarded — GC already pre-checks `is_unit_active=false`.
async fn uninstall(args: ServiceUninstallArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    check_active_jobs_gate(&unit, &args.name, args.force, "uninstall").await?;
    uninstall_service(&args.name).await
}

/// `service drain` — send SIGUSR1, disable unit, return immediately.
async fn drain(args: ServiceDrainArgs) -> RunnerResult<()> {
    let unit = unit_name(&args.name)?;
    if !is_unit_active(&unit).await? {
        info!(unit = %unit, "no active service found");
        return Ok(());
    }

    // `is_unit_active` above can race against the runner exiting on its own:
    // by the time we read MainPID or call `kill`, the process may be gone.
    // Both outcomes ("live, signal delivered" and "already gone") must still
    // run `systemctl disable` below so the unit does not auto-start at the
    // next boot.
    match signal_service_main(&unit, nix::sys::signal::Signal::SIGUSR1).await? {
        ServiceSignalOutcome::Sent { pid } => info!(unit = %unit, pid, "sent SIGUSR1 (drain)"),
        ServiceSignalOutcome::AlreadyGone => {
            info!(unit = %unit, "runner already exited; drain signal not needed");
        }
    }

    // Disable so it won't restart on reboot. The SIGUSR1 has already been
    // delivered, so a disable failure is a partial-success condition — the
    // operator can re-run the command manually. Surface the hint on stderr
    // in addition to the structured log so CLI users don't miss it.
    let svc = format!("{unit}.service");
    if let Err(e) = run_systemctl(&["disable", &svc]).await {
        warn!(unit = %unit, error = %e, "failed to disable unit");
        eprintln!(
            "WARNING: drain signal was sent but `systemctl disable {svc}` failed: {e}. \
             Run it manually to prevent the unit from restarting on reboot."
        );
    } else {
        info!(unit = %unit, "disabled (won't restart on reboot)");
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
    let unit = unit_name(&args.name)?;
    if !is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "{unit} is not active — cannot resume an inactive runner"
        )));
    }

    // Preflight: if status.json shows the runner is already past the
    // resumable point (Stopping = teardown in progress, Stopped = exited),
    // SIGUSR2 is too late.
    if let Some(base_dir) = runner_base_dir(&args.name) {
        match read_runner_status(&base_dir).await {
            Ok(status) if matches!(status.mode.as_str(), "stopping" | "stopped") => {
                return Err(RunnerError::Internal(format!(
                    "{unit} is already shutting down (mode={}) — cannot resume",
                    status.mode
                )));
            }
            Ok(_) => {}
            Err(e) => {
                warn!(
                    unit,
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
        ServiceSignalOutcome::Sent { pid } => info!(unit = %unit, pid, "sent SIGUSR2 (resume)"),
        ServiceSignalOutcome::AlreadyGone => {
            info!(
                unit = %unit,
                "runner exited between preflight and signal; refusing resume",
            );
            return Err(RunnerError::Internal(format!(
                "{unit} is not active — cannot resume an inactive runner"
            )));
        }
    }

    // Re-enable so the unit restarts on reboot (undoes the disable from drain).
    // Use `enable` (not `--now`) — the service is already running. SIGUSR2
    // has already been delivered so the runner IS resumed; a re-enable
    // failure is partial success. Surface the hint on stderr so CLI users
    // don't miss it.
    let svc = format!("{unit}.service");
    if let Err(e) = run_systemctl(&["enable", &svc]).await {
        warn!(unit = %unit, error = %e, "failed to re-enable unit");
        eprintln!(
            "WARNING: runner resumed but `systemctl enable {svc}` failed: {e}. \
             Run it manually to restore the restart-on-reboot behavior."
        );
    } else {
        info!(unit = %unit, "re-enabled (will restart on reboot)");
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
        assert_eq!(
            unit_name("pr-1234-test").unwrap(),
            "vm0-runner-pr-1234-test"
        );
    }

    #[test]
    fn test_unit_name_rejects_invalid() {
        assert!(unit_name("").is_err());
        assert!(unit_name("../evil").is_err());
        assert!(unit_name("has space").is_err());
        assert!(unit_name("semi;colon").is_err());
        // Now aligned with runner_dirname: reject uppercase, underscore, leading dot/hyphen
        assert!(unit_name("V0.2.0").is_err());
        assert!(unit_name("my_name-1.0").is_err());
        assert!(unit_name(".hidden").is_err());
        assert!(unit_name("-flag").is_err());
    }

    /// Guard against someone replacing the call with `validate_or_err`
    /// which would surface a "runner-dirname" message in a service context.
    #[test]
    fn test_unit_name_error_mentions_service() {
        let msg = unit_name("UPPER").unwrap_err().to_string();
        assert!(msg.contains("service name suffix"), "got: {msg}");
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
    fn test_escape_systemd_value() {
        // Empty input — degenerate but callable (helper is independent of
        // validate); guards against future implementation changes.
        assert_eq!(escape_systemd_value(""), "");

        // No special chars — identity.
        assert_eq!(escape_systemd_value("KEY=value"), "KEY=value");

        // Double quotes.
        assert_eq!(escape_systemd_value(r#"MSG=say "hi""#), r#"MSG=say \"hi\""#,);

        // Backslashes.
        assert_eq!(
            escape_systemd_value(r"PATH=C:\Users\test"),
            r"PATH=C:\\Users\\test",
        );

        // Mixed `\` and `"` — regressions here catch reversed-order bugs
        // (each character alone would still pass the tests above).
        assert_eq!(escape_systemd_value(r#"K=a\b"c"#), r#"K=a\\b\"c"#);

        // Trailing `\`: without escape, the generated line `"K=foo\"` would
        // swallow the closing quote and corrupt the unit file.
        assert_eq!(escape_systemd_value(r"K=foo\"), r"K=foo\\");

        // Single `%` — without escape, systemd would treat `%X` as a
        // specifier (e.g. `%H` → hostname). `%%` is the literal-`%` escape.
        assert_eq!(escape_systemd_value("MSG=50% done"), "MSG=50%% done");

        // `%` followed by a known specifier letter — concrete reproduction
        // of issue #9470: without escape, systemd silently rewrites this
        // to the host's actual hostname.
        assert_eq!(escape_systemd_value("MSG=host=%H"), "MSG=host=%%H");

        // Already-escaped `%%` in user input — must be doubled again to
        // `%%%%`, otherwise systemd unescapes it back to a single `%`
        // which then specifier-expands.
        assert_eq!(escape_systemd_value("K=100%%"), "K=100%%%%");

        // All three escape classes in one value — catches any single-char
        // regression that the targeted tests would miss.
        assert_eq!(escape_systemd_value(r#"K=a\b"c%d"#), r#"K=a\\b\"c%%d"#,);

        // Trailing `%`: arguably the most version-sensitive case. Older
        // systemd may preserve a trailing `%`, newer versions may warn or
        // error; escaping to `%%` is safe everywhere.
        assert_eq!(escape_systemd_value("KEY=trailing%"), "KEY=trailing%%");

        // Non-ASCII / UTF-8 input: characters outside the escape set must
        // pass through as their original UTF-8 bytes. Guards against any
        // future refactor that switches from `chars()` to byte-level
        // iteration and breaks multi-byte characters.
        assert_eq!(escape_systemd_value("MSG=任务完成 ✓"), "MSG=任务完成 ✓");
    }

    #[test]
    fn test_generate_unit_file_escapes_env_values() {
        let env = vec![
            r#"MSG=say "hi""#.to_string(),
            r"PATH=C:\Users".to_string(),
            // Both `"` and `\` in a single entry — catches regressions in
            // the helper-to-format! interaction that the helper-only test
            // would miss (e.g. accidental extra escaping at the call site).
            r#"K=a"\b"#.to_string(),
            // `%H` in user input must reach the runner process literally,
            // not be expanded to the host's hostname by systemd. See #9470.
            "MSG=job %H done".to_string(),
        ];
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/usr/bin/runner"),
            Path::new("/etc/runner.yaml"),
            &env,
            false,
        );
        assert!(content.contains(r#"Environment="MSG=say \"hi\"""#));
        assert!(content.contains(r#"Environment="PATH=C:\\Users""#));
        assert!(content.contains(r#"Environment="K=a\"\\b""#));
        assert!(content.contains(r#"Environment="MSG=job %%H done""#));
    }

    #[test]
    fn test_generate_unit_file_escapes_exec_paths() {
        // A `%` in the config or exe path would otherwise be subject to
        // systemd specifier expansion (e.g. `%H` → hostname), pointing
        // ExecStart at the wrong file. Same root cause as #9470.
        let content = generate_unit_file(
            "vm0-runner-v0.1.0",
            Path::new("/opt/runner-v1%2.0/bin/runner"),
            Path::new("/etc/cache%20.yaml"),
            &[],
            false,
        );
        assert!(content.contains(
            r#"ExecStart="/opt/runner-v1%%2.0/bin/runner" start --config "/etc/cache%%20.yaml""#
        ));
    }

    #[test]
    fn test_validate_env_vars_valid() {
        assert!(validate_env_vars(&[]).is_ok());
        assert!(validate_env_vars(&["KEY=VALUE".to_string()]).is_ok());
        assert!(validate_env_vars(&["K=".to_string()]).is_ok());
        assert!(validate_env_vars(&["K=V=W".to_string()]).is_ok());
        // `"`, `\`, and `%` are valid at the validate layer — they get
        // escaped later in `escape_systemd_value`.
        assert!(validate_env_vars(&[r#"MSG=say "hi""#.to_string()]).is_ok());
        assert!(validate_env_vars(&[r"PATH=C:\Users".to_string()]).is_ok());
        assert!(validate_env_vars(&["MSG=50% done".to_string()]).is_ok());
        // Tab is intentionally NOT rejected: it is valid inside a systemd
        // quoted `Environment=` value. Locking this in so a future "let's
        // reject all whitespace control chars" change is an explicit choice.
        assert!(validate_env_vars(&["KEY=with\ttab".to_string()]).is_ok());
    }

    #[test]
    fn test_validate_env_vars_invalid() {
        assert!(validate_env_vars(&["NOEQUALS".to_string()]).is_err());
        assert!(validate_env_vars(&["=VALUE".to_string()]).is_err());
        assert!(validate_env_vars(&["".to_string()]).is_err());
        // Bare newline / CR / NUL would silently corrupt the unit file.
        assert!(validate_env_vars(&["KEY=line1\nline2".to_string()]).is_err());
        assert!(validate_env_vars(&["KEY=foo\rbar".to_string()]).is_err());
        assert!(validate_env_vars(&["KEY=with\0nul".to_string()]).is_err());
    }

    #[test]
    fn write_unit_file_creates_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        write_unit_file(&path, "[Unit]\nDescription=test\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[Unit]\nDescription=test\n"
        );
    }

    #[test]
    fn write_unit_file_overwrites_existing() {
        // Verifies the rename step replaces an existing file rather than
        // failing — POSIX rename(2) over an existing file is the atomic
        // swap we rely on for race-free updates.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        std::fs::write(&path, "old content").unwrap();
        write_unit_file(&path, "new content").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");
    }

    #[test]
    fn write_unit_file_does_not_leave_tmp_on_success() {
        // The tmp file is consumed by the rename — it must not be left
        // behind on disk. A residual `.tmp` would not be loaded by
        // systemd (wrong suffix) but would clutter the unit directory.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        write_unit_file(&path, "content").unwrap();
        let tmp = path.with_extension("tmp");
        assert!(!tmp.exists(), "tmp file must be consumed by rename");
    }

    #[test]
    fn write_unit_file_cleans_up_tmp_on_rename_failure() {
        // Rename fails when the target path is an existing directory
        // (EISDIR). Verifies the staged `.tmp` — which may contain
        // Environment= secrets — is removed so it doesn't persist in
        // /etc/systemd/system/.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::fs::create_dir(&path).unwrap();
        let result = write_unit_file(&path, "secret=xyz");
        assert!(result.is_err(), "rename onto existing dir must fail");
        let tmp = path.with_extension("tmp");
        assert!(!tmp.exists(), "tmp file must be cleaned up on failure");
    }

    // -----------------------------------------------------------------
    // status.json reader
    // -----------------------------------------------------------------

    #[test]
    fn status_field_preview_bounds_long_values_on_char_boundary() {
        let exact = "x".repeat(128);
        assert_eq!(status_field_preview(&exact), exact);

        let long_ascii = "x".repeat(129);
        assert_eq!(
            status_field_preview(&long_ascii),
            format!("{}...[truncated]", "x".repeat(128))
        );

        let long_unicode = "界".repeat(129);
        assert_eq!(
            status_field_preview(&long_unicode),
            format!("{}...[truncated]", "界".repeat(128))
        );
    }

    #[tokio::test]
    async fn read_runner_status_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_empty_json() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("status.json"), "{}")
            .await
            .unwrap();
        // Missing required fields -> parse error.
        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_malformed_started_at() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","active_runs":[],"started_at":"not-a-date"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_malformed_long_started_at_error_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let started_at = "x".repeat(512);
        let s = format!(r#"{{"mode":"running","active_runs":[],"started_at":"{started_at}"}}"#);
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();

        let err = match read_runner_status(dir.path()).await {
            Ok(_) => panic!("expected malformed started_at to fail"),
            Err(err) => err,
        };
        let message = err.to_string();

        assert!(message.contains(&"x".repeat(128)));
        assert!(message.contains("...[truncated]"));
        assert!(!message.contains(&"x".repeat(129)));
    }

    #[tokio::test]
    async fn read_runner_status_running_no_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00.000Z"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
        assert!(status.run_ids.is_empty());
    }

    #[tokio::test]
    async fn read_runner_status_with_active_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"running",
            "active_runs":[
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"},
                {"run_id":"0191c4e0-0000-7000-8000-000000000002","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000002"}
            ],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
        assert_eq!(status.run_ids.len(), 2);
    }

    #[tokio::test]
    async fn read_runner_status_draining_mode() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"draining",
            "active_runs":[
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"}
            ],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "draining");
        assert_eq!(status.run_ids.len(), 1);
    }

    #[tokio::test]
    async fn read_runner_status_full_runner_payload() {
        // Guard against schema drift: status.json written by StatusTracker
        // (crates/runner/src/status.rs) contains more fields than the ones
        // we care about. The decoder must tolerate the full payload.
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"},
                {"run_id":"0191c4e0-0000-7000-8000-000000000002","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000002"}
            ],
            "idle_vms": [
                {"session_id":"sess-1","sandbox_id":"bbbbbbbb-0000-7000-8000-000000000001"}
            ],
            "proxy_port": 8080,
            "dns_port": 5300,
            "started_at": "2026-04-13T00:00:00.000Z",
            "updated_at": "2026-04-13T00:05:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
        assert_eq!(status.run_ids.len(), 2);
    }

    #[tokio::test]
    async fn read_runner_status_future_started_at_yields_zero_uptime() {
        // Clock skew guard: if started_at is in the future (NTP correction,
        // misconfigured clock), `to_std()` fails and we fall back to
        // Duration::ZERO rather than propagating an error.
        let dir = tempfile::tempdir().unwrap();
        let future = (chrono::Utc::now() + chrono::Duration::hours(1))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let s = format!(r#"{{"mode":"running","active_runs":[],"started_at":"{future}"}}"#);
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.uptime, std::time::Duration::ZERO);
    }

    #[tokio::test]
    async fn read_runner_status_started_at_without_millis() {
        // StatusTracker writes millisecond precision today, but RFC 3339
        // allows second-precision too. Make sure we accept both so a
        // future format change won't silently break the gate.
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00Z"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
    }

    #[tokio::test]
    async fn read_runner_status_stopped_preserves_ids() {
        // Reader is unopinionated: it returns what's on disk, and the gate
        // consults `mode` to decide whether to short-circuit.
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"stopped",
            "active_runs":[
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"}
            ],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "stopped");
        assert_eq!(status.run_ids.len(), 1);
    }

    // -----------------------------------------------------------------
    // decide_gate — pure decision function
    // -----------------------------------------------------------------

    fn snapshot(mode: &str, run_count: usize) -> RunnerStatusSnapshot {
        RunnerStatusSnapshot {
            mode: mode.to_string(),
            run_ids: (0..run_count).map(|_| RunId::nil()).collect(),
            uptime: std::time::Duration::from_secs(600),
        }
    }

    #[test]
    fn decide_gate_running_with_jobs_refuses_normal() {
        assert_eq!(
            decide_gate(&snapshot("running", 3)),
            GateDecision::Refuse { draining: false }
        );
    }

    #[test]
    fn decide_gate_running_without_jobs_bypasses() {
        assert_eq!(decide_gate(&snapshot("running", 0)), GateDecision::Bypass);
    }

    #[test]
    fn decide_gate_stopped_bypasses_even_with_stale_ids() {
        // Covers the narrow window between status.json being rewritten
        // with "stopped" and systemd marking the unit inactive.
        assert_eq!(decide_gate(&snapshot("stopped", 2)), GateDecision::Bypass);
    }

    #[test]
    fn decide_gate_stopping_bypasses() {
        // Stopping = teardown in progress. The runner is already cancelling
        // in-flight jobs itself; user stop/uninstall accelerates rather than
        // endangers — bypass the active-jobs gate.
        assert_eq!(decide_gate(&snapshot("stopping", 3)), GateDecision::Bypass);
    }

    #[test]
    fn decide_gate_draining_with_jobs_refuses_draining_variant() {
        assert_eq!(
            decide_gate(&snapshot("draining", 1)),
            GateDecision::Refuse { draining: true }
        );
    }

    #[test]
    fn decide_gate_unknown_mode_with_jobs_refuses_normal() {
        // Forward-compat: a newer runner writing a mode string we don't
        // recognize (e.g. "paused") gets the normal refuse branch —
        // safer than bypassing, and does not impersonate "draining".
        assert_eq!(
            decide_gate(&snapshot("paused", 1)),
            GateDecision::Refuse { draining: false }
        );
    }
}
