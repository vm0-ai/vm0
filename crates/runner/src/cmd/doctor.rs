//! Runtime health diagnostics for all runners on the host.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use serde::Deserialize;
use tracing::warn;

use crate::config::RunnerConfig;
use crate::error::RunnerResult;
use crate::process;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

#[derive(Args)]
pub struct DoctorArgs {
    /// Only check the runner with this name (matches config `name` field)
    #[arg(long)]
    name: Option<String>,
}

// ---------------------------------------------------------------------------
// Warning type — structured anomalies with targeted recheck
// ---------------------------------------------------------------------------

/// How long to wait before each recheck of detected anomalies.
const RECHECK_DELAY: Duration = Duration::from_secs(3);

/// Maximum number of recheck attempts before reporting persistent anomalies.
///
/// Worst-case latency: `RECHECK_MAX_ATTEMPTS × RECHECK_DELAY` = 9 s (only
/// when anomalies persist across all attempts; zero overhead when healthy).
const RECHECK_MAX_ATTEMPTS: u32 = 3;

/// A detected anomaly that carries enough context to recheck itself.
enum Warning {
    /// API server not responding to HEAD request.
    ApiUnreachable {
        server_url: String,
        server_token: String,
    },
    /// status.json lists a proxy port but no mitmdump process found on it.
    NoMitmproxy { port: u16, base_dir: PathBuf },
    /// status.json lists a run_id but no firecracker process found for it.
    NoFirecrackerForRun { run_id: String, base_dir: PathBuf },
    /// A firecracker process exists but its run_id is not in status.json.
    FirecrackerNotInStatus {
        pid: u32,
        run_id: String,
        base_dir: PathBuf,
    },
    /// A firecracker process whose ppid chain doesn't lead to any runner.
    OrphanFirecracker {
        pid: u32,
        run_id: String,
        ppid: Option<u32>,
    },
    /// A mitmdump process on an unclaimed port whose ppid chain is orphaned.
    OrphanMitmdump {
        pid: u32,
        port: u16,
        ppid: Option<u32>,
    },
    /// Runner is stopped but mitmproxy process is still running (leaked).
    StaleMitmproxy { pid: u32, port: u16 },
    /// A network namespace whose pool lock is not held by any process.
    OrphanNamespace { ns_name: String, pool_idx: u32 },
    /// A dm-snapshot target with no openers (leaked after crash/kill).
    OrphanDmSnapshot {
        name: String,
        runner_name: Option<String>,
    },
    /// A loop device backing a runner file with no active sandboxes.
    OrphanLoopDevice {
        device: String,
        backing: String,
        runner_name: Option<String>,
    },
}

impl fmt::Display for Warning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiUnreachable { .. } => write!(f, "API unreachable"),
            Self::NoMitmproxy { port, .. } => {
                write!(f, "no mitmproxy process on port {port}")
            }
            Self::NoFirecrackerForRun { run_id, .. } => {
                write!(f, "no firecracker process for run {run_id}")
            }
            Self::FirecrackerNotInStatus { pid, run_id, .. } => {
                write!(f, "firecracker PID {pid} (run {run_id}) not in status.json")
            }
            Self::OrphanFirecracker { pid, run_id, ppid } => {
                let ppid_str = ppid.map_or("?".into(), |p| p.to_string());
                write!(
                    f,
                    "orphan firecracker PID {pid} (run {run_id}, ppid={ppid_str})"
                )
            }
            Self::OrphanMitmdump { pid, port, ppid } => {
                let ppid_str = ppid.map_or("?".into(), |p| p.to_string());
                write!(
                    f,
                    "orphan mitmdump PID {pid} (port {port}, ppid={ppid_str})"
                )
            }
            Self::StaleMitmproxy { pid, port } => {
                write!(
                    f,
                    "stale mitmproxy PID {pid} on port {port} (runner stopped)"
                )
            }
            Self::OrphanNamespace { ns_name, .. } => {
                write!(f, "orphan namespace {ns_name} (pool lock not held)")
            }
            Self::OrphanDmSnapshot { name, runner_name } => {
                write!(f, "orphan dm-snapshot target {name} (no openers)")?;
                if let Some(runner) = runner_name {
                    write!(f, " [runner: {runner}]")?;
                }
                Ok(())
            }
            Self::OrphanLoopDevice {
                device,
                backing,
                runner_name,
            } => {
                write!(f, "orphan loop device {device} ({backing})")?;
                if let Some(runner) = runner_name {
                    write!(f, " [runner: {runner}]")?;
                }
                Ok(())
            }
        }
    }
}

impl Warning {
    /// Targeted recheck: returns `true` if the anomaly still persists.
    ///
    /// Process-related checks use the pre-scanned `fresh` data (a single
    /// `/proc` scan shared across all warnings). Other checks do their own
    /// minimal I/O (status.json read, HTTP HEAD, flock).
    async fn persists(&self, fresh: &process::DiscoveredProcesses) -> bool {
        match self {
            Self::ApiUnreachable {
                server_url,
                server_token,
            } => {
                let client = match reqeast::builder().timeout(Duration::from_secs(5)).build() {
                    Ok(c) => c,
                    Err(_) => return true,
                };
                client
                    .head(server_url)
                    .bearer_auth(server_token)
                    .send()
                    .await
                    .is_err()
            }
            Self::NoMitmproxy { port, base_dir } => {
                // Resolved if mitmproxy process now exists on this port.
                if fresh.mitmdumps.iter().any(|m| m.port == *port) {
                    return false;
                }
                // Resolved if mode transitioned to stopped/draining (proxy
                // shutdown is expected in these modes).
                !matches!(read_status(base_dir).await, Some(st) if is_inactive_mode(&st.mode))
            }
            Self::NoFirecrackerForRun { run_id, base_dir } => {
                // Resolved if firecracker process now exists (startup completed)
                let fc_found = fresh.firecrackers.iter().any(|f| {
                    f.run_id == *run_id && f.base_dir.as_deref() == Some(base_dir.as_path())
                });
                if fc_found {
                    return false;
                }
                // Resolved if run_id removed from status.json (cleanup completed)
                match read_status(base_dir).await {
                    Some(st) => st.active_run_ids.contains(run_id),
                    None => false,
                }
            }
            Self::FirecrackerNotInStatus {
                pid,
                run_id,
                base_dir,
            } => {
                // Resolved if process exited or now tracked in status.json.
                if !pid_exists(*pid) {
                    return false;
                }
                match read_status(base_dir).await {
                    Some(st) => !st.active_run_ids.iter().any(|id| id == run_id),
                    None => true,
                }
            }
            Self::StaleMitmproxy { pid, .. } => {
                // Resolved if the stale mitmproxy process has exited.
                pid_exists(*pid)
            }
            Self::OrphanFirecracker { pid, .. } | Self::OrphanMitmdump { pid, .. } => {
                // Resolved if process has exited.
                pid_exists(*pid)
            }
            Self::OrphanNamespace { pool_idx, .. } => {
                let lock_path = format!("/var/lock/vm0-netns-pool-{pool_idx}.lock");
                is_lock_free(&lock_path).await
            }
            Self::OrphanDmSnapshot { name, .. } => dm_target_has_no_openers(name).await,
            Self::OrphanLoopDevice { device, .. } => loop_device_exists(device).await,
        }
    }
}

/// Check if a process is still alive via `/proc/{pid}`.
fn pid_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

// ---------------------------------------------------------------------------
// Report structs
// ---------------------------------------------------------------------------

struct RunnerReport {
    name: Option<String>,
    base_dir: Option<PathBuf>,
    pid: u32,
    config_path: PathBuf,
    subcommand: String,
    service_type: ServiceType,
    status: Option<StatusInfo>,
    api_ok: Option<bool>,
    proxy_pid: Option<u32>,
    jobs: Vec<JobReport>,
    warnings: Vec<Warning>,
}

enum ServiceType {
    Installed(String),
    Transient(String),
    Bare,
}

struct StatusInfo {
    mode: String,
    started_at: String,
    active_run_ids: Vec<String>,
    proxy_port: Option<u16>,
}

struct InstalledService {
    unit_name: String,
    config_path: Option<PathBuf>,
}

struct JobReport {
    run_id: String,
    status: JobStatus,
}

enum JobStatus {
    Running(u32),
    NoProcess,
    NotInStatus,
}

struct StoppedInfo {
    unit_name: String,
    config_info: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run_doctor(args: DoctorArgs) -> RunnerResult<ExitCode> {
    // Phase 1: Discover running processes (single /proc scan)
    let discovered = process::discover_all().await;

    // Phase 2: Discover installed services
    let installed_services = find_installed_services().await;

    // Phase 3: Build runner reports
    let mut reports = Vec::new();
    for runner in &discovered.runners {
        let report = build_runner_report(
            runner,
            &discovered.firecrackers,
            &discovered.mitmdumps,
            &installed_services,
        )
        .await;
        reports.push(report);
    }

    // Phase 4: Find stopped services (installed but no matching running process)
    // Skip when filtering by name — other runners' stopped services are irrelevant
    let stopped = if args.name.is_none() {
        find_stopped_services(&installed_services, &reports)
    } else {
        vec![]
    };

    // Phase 5: Global orphan detection
    // When --name is set, run block-cow and orphan firecracker detection
    // scoped to that runner. Orphan mitmproxy and namespace are skipped
    // (no runner-identifying info on orphaned processes).
    let mut global_warnings: Vec<Warning> = if args.name.is_none() {
        detect_global_orphans(&reports, &discovered.firecrackers, &discovered.mitmdumps).await
    } else {
        // Scoped detection: block-cow + orphan firecracker for the named runner.
        // Orphan mitmproxy and namespace cannot be scoped (no runner-identifying
        // info on orphaned processes / no persistent runner→pool_idx mapping).
        let mut warnings = detect_block_cow_orphans(&reports, args.name.as_deref()).await;

        // Orphan firecracker: scope by base_dir match.
        let named_base_dir = reports
            .iter()
            .find(|r| r.name.as_deref() == args.name.as_deref())
            .and_then(|r| r.base_dir.clone());
        if let Some(base_dir) = named_base_dir {
            let runner_pids: Vec<u32> = reports.iter().map(|r| r.pid).collect();
            warnings.extend(
                detect_orphan_firecrackers(&discovered.firecrackers, &runner_pids, Some(&base_dir))
                    .await,
            );
        }

        warnings
    };

    // Filter reports by name after global detection (which needs full list)
    let mut reports = if let Some(ref name_filter) = args.name {
        reports
            .into_iter()
            .filter(|r| r.name.as_deref() == Some(name_filter.as_str()))
            .collect()
    } else {
        reports
    };

    // Phase 6: Targeted recheck of anomalies
    // When warnings are found, wait briefly and recheck only the failing items.
    // This filters transient false-positives (e.g. NO PROCESS during run cleanup)
    // without redoing the entire scan. Up to 3 attempts, 3s apart.
    for _ in 0..RECHECK_MAX_ATTEMPTS {
        let has_warnings =
            reports.iter().any(|r| !r.warnings.is_empty()) || !global_warnings.is_empty();
        if !has_warnings {
            break;
        }

        tokio::time::sleep(RECHECK_DELAY).await;

        // Single /proc scan shared across all warning rechecks.
        let fresh = process::discover_all().await;

        for report in &mut reports {
            let mut rechecked = Vec::new();
            for warning in report.warnings.drain(..) {
                if warning.persists(&fresh).await {
                    rechecked.push(warning);
                }
            }
            report.warnings = rechecked;
        }

        let mut rechecked_global = Vec::new();
        for warning in global_warnings.drain(..) {
            if warning.persists(&fresh).await {
                rechecked_global.push(warning);
            }
        }
        global_warnings = rechecked_global;
    }

    // Phase 7: Output
    let total_warnings = print_report(&reports, &stopped, &global_warnings);

    if total_warnings > 0 {
        Ok(ExitCode::FAILURE)
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

async fn build_runner_report(
    runner: &process::RunnerProcessInfo,
    fc_procs: &[process::FirecrackerProcessInfo],
    mitm_procs: &[process::MitmproxyProcessInfo],
    installed: &[InstalledService],
) -> RunnerReport {
    let mut warnings = Vec::new();

    // Load config (best-effort)
    let config = load_config_lenient(&runner.config_path).await;
    let name = config.as_ref().map(|c| c.name.clone());

    // Detect service type
    let service_type = detect_service_type(runner.pid, installed).await;

    // Read status.json
    let status = if let Some(cfg) = &config {
        read_status(&cfg.base_dir).await
    } else {
        None
    };

    // API connectivity check (only when server is configured)
    let api_ok = match &config {
        Some(cfg) => check_api(cfg).await,
        None => None,
    };
    if api_ok == Some(false)
        && let Some(cfg) = &config
        && let Some(server) = &cfg.server
    {
        warnings.push(Warning::ApiUnreachable {
            server_url: server.url.clone(),
            server_token: server.token.clone(),
        });
    }

    // Base dir for job correlation
    let base_dir = config.as_ref().map(|c| &c.base_dir);

    // Proxy check (match by port from status.json).
    //   running  + proxy missing  → NoMitmproxy warning
    //   stopped  + proxy present  → StaleMitmproxy warning
    //   draining                  → no warning either way
    let proxy_pid = if let Some(st) = &status
        && let Some(port) = st.proxy_port
    {
        let pid = mitm_procs.iter().find(|m| m.port == port).map(|m| m.pid);
        match (st.mode.as_str(), pid) {
            ("running", None) => {
                let bd = base_dir.map(|p| p.to_path_buf()).unwrap_or_default();
                warnings.push(Warning::NoMitmproxy { port, base_dir: bd });
            }
            ("stopped", Some(mitm_pid)) => {
                warnings.push(Warning::StaleMitmproxy {
                    pid: mitm_pid,
                    port,
                });
            }
            _ => {}
        }
        pid
    } else {
        None
    };

    // Job correlation
    let jobs = if let (Some(st), Some(bd)) = (&status, base_dir) {
        let (job_reports, job_warnings) = correlate_jobs(st, bd, fc_procs);
        warnings.extend(job_warnings);
        job_reports
    } else {
        Vec::new()
    };

    RunnerReport {
        name,
        base_dir: config.as_ref().map(|c| c.base_dir.clone()),
        pid: runner.pid,
        config_path: runner.config_path.clone(),
        subcommand: runner.subcommand.clone(),
        service_type,
        status,
        api_ok,
        proxy_pid,
        jobs,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Config loading (lenient — no path validation)
// ---------------------------------------------------------------------------

async fn load_config_lenient(path: &Path) -> Option<RunnerConfig> {
    let content = tokio::fs::read_to_string(path).await.ok()?;
    let mut config: RunnerConfig = serde_yaml_ng::from_str(&content).ok()?;
    if let Some(config_dir) = path.parent() {
        config.resolve_relative_paths(config_dir);
    }
    Some(config)
}

// ---------------------------------------------------------------------------
// Service type detection
// ---------------------------------------------------------------------------

/// Read `/proc/{pid}/cgroup` to find the systemd unit, then classify it.
async fn detect_service_type(pid: u32, installed: &[InstalledService]) -> ServiceType {
    let unit_name = match process::read_service_unit(pid).await {
        Some(name) if name.starts_with("vm0-runner-") => name,
        _ => return ServiceType::Bare,
    };

    // Check if the unit file exists on disk (installed vs transient)
    let unit_path = format!("/etc/systemd/system/{unit_name}.service");
    if tokio::fs::try_exists(&unit_path).await.unwrap_or(false)
        || installed.iter().any(|s| s.unit_name == unit_name)
    {
        ServiceType::Installed(unit_name)
    } else {
        ServiceType::Transient(unit_name)
    }
}

// ---------------------------------------------------------------------------
// Installed service discovery
// ---------------------------------------------------------------------------

/// Scan `/etc/systemd/system/vm0-runner-*.service` for installed services.
async fn find_installed_services() -> Vec<InstalledService> {
    let mut services = Vec::new();
    let mut entries = match tokio::fs::read_dir("/etc/systemd/system").await {
        Ok(e) => e,
        Err(_) => return services,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with("vm0-runner-") || !name_str.ends_with(".service") {
            continue;
        }
        let unit_name = name_str
            .strip_suffix(".service")
            .unwrap_or(name_str)
            .to_string();
        let config_path = parse_unit_config_path(&entry.path()).await;
        services.push(InstalledService {
            unit_name,
            config_path,
        });
    }
    services
}

/// Parse the ExecStart line of a systemd unit file for `--config` path.
async fn parse_unit_config_path(unit_path: &Path) -> Option<PathBuf> {
    let content = tokio::fs::read_to_string(unit_path).await.ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("ExecStart=") {
            // ExecStart="..." start --config "..."
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            let pos = tokens
                .iter()
                .position(|&t| t == "--config" || t == "-c" || t.trim_matches('"') == "--config")?;
            let path_str = (*tokens.get(pos + 1)?).trim_matches('"');
            return Some(PathBuf::from(path_str));
        }
    }
    None
}

/// Find installed services that have no matching running runner.
fn find_stopped_services(
    installed: &[InstalledService],
    reports: &[RunnerReport],
) -> Vec<StoppedInfo> {
    installed
        .iter()
        .filter(|svc| {
            !reports.iter().any(|r| match &r.service_type {
                ServiceType::Installed(name) => name == &svc.unit_name,
                _ => false,
            })
        })
        .map(|svc| StoppedInfo {
            unit_name: svc.unit_name.clone(),
            config_info: svc
                .config_path
                .as_ref()
                .map_or("unknown config".into(), |p| p.display().to_string()),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Status reading
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StatusFile {
    mode: String,
    active_run_ids: Vec<String>,
    started_at: String,
    #[serde(default)]
    proxy_port: Option<u16>,
}

/// Returns `true` for modes where proxy absence is expected (not a warning).
fn is_inactive_mode(mode: &str) -> bool {
    matches!(mode, "stopped" | "draining")
}

async fn read_status(base_dir: &Path) -> Option<StatusInfo> {
    let path = base_dir.join("status.json");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    let file: StatusFile = serde_json::from_str(&content).ok()?;
    Some(StatusInfo {
        mode: file.mode,
        started_at: file.started_at,
        active_run_ids: file.active_run_ids,
        proxy_port: file.proxy_port,
    })
}

// ---------------------------------------------------------------------------
// API connectivity check
// ---------------------------------------------------------------------------

/// Returns `None` if no server configured or URL uses `.test` TLD (RFC 2606),
/// `Some(true)` if reachable, `Some(false)` if unreachable.
async fn check_api(config: &RunnerConfig) -> Option<bool> {
    let server = config.server.as_ref()?;
    // Skip connectivity check for .test domains (reserved per RFC 2606, used in CI)
    if server.url.contains(".test") {
        return None;
    }
    let client = reqeast::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    Some(
        client
            .head(&server.url)
            .bearer_auth(&server.token)
            .send()
            .await
            .is_ok(),
    )
}

// ---------------------------------------------------------------------------
// Job correlation
// ---------------------------------------------------------------------------

fn correlate_jobs(
    status: &StatusInfo,
    base_dir: &Path,
    fc_procs: &[process::FirecrackerProcessInfo],
) -> (Vec<JobReport>, Vec<Warning>) {
    let mut jobs = Vec::new();
    let mut warnings = Vec::new();

    // Firecracker processes belonging to this runner
    let my_fcs: Vec<&process::FirecrackerProcessInfo> = fc_procs
        .iter()
        .filter(|p| p.base_dir.as_deref() == Some(base_dir))
        .collect();

    // For each run_id in status, find matching firecracker process
    for run_id in &status.active_run_ids {
        let fc = my_fcs.iter().find(|p| p.run_id == *run_id);
        let job_status = match fc {
            Some(p) => JobStatus::Running(p.pid),
            None => {
                warnings.push(Warning::NoFirecrackerForRun {
                    run_id: run_id.clone(),
                    base_dir: base_dir.to_path_buf(),
                });
                JobStatus::NoProcess
            }
        };
        jobs.push(JobReport {
            run_id: run_id.clone(),
            status: job_status,
        });
    }

    // Firecracker processes not in status.json
    for fc in &my_fcs {
        if !status.active_run_ids.contains(&fc.run_id) {
            warnings.push(Warning::FirecrackerNotInStatus {
                pid: fc.pid,
                run_id: fc.run_id.clone(),
                base_dir: base_dir.to_path_buf(),
            });
            jobs.push(JobReport {
                run_id: fc.run_id.clone(),
                status: JobStatus::NotInStatus,
            });
        }
    }

    (jobs, warnings)
}

// ---------------------------------------------------------------------------
// Global orphan detection
// ---------------------------------------------------------------------------

async fn detect_global_orphans(
    reports: &[RunnerReport],
    fc_procs: &[process::FirecrackerProcessInfo],
    mitm_procs: &[process::MitmproxyProcessInfo],
) -> Vec<Warning> {
    let mut warnings = Vec::new();

    let runner_pids: Vec<u32> = reports.iter().map(|r| r.pid).collect();

    // Orphan firecracker processes (all runners)
    warnings.extend(detect_orphan_firecrackers(fc_procs, &runner_pids, None).await);

    // Orphan mitmproxy processes.
    // A mitmdump belongs to a runner if its port matches the runner's proxy
    // port (from status.json). All processes on that port — main process and
    // worker forks — are considered owned.
    let claimed_ports: Vec<u16> = reports
        .iter()
        .filter_map(|r| r.status.as_ref()?.proxy_port)
        .collect();
    for mitm in mitm_procs {
        if claimed_ports.contains(&mitm.port) {
            continue;
        }
        if process::is_orphan(mitm.pid, &runner_pids).await {
            warnings.push(Warning::OrphanMitmdump {
                pid: mitm.pid,
                port: mitm.port,
                ppid: mitm.ppid,
            });
        }
    }

    // Orphan network namespaces
    warnings.extend(detect_orphan_namespaces().await);

    // Orphan dm-snapshot targets and loop devices
    warnings.extend(detect_block_cow_orphans(reports, None).await);

    warnings
}

/// Detect orphan firecracker processes whose ppid chain doesn't lead to any runner.
///
/// When `base_dir_filter` is `Some`, only reports processes whose working
/// directory is under the specified base_dir (for `--name` scoping).
async fn detect_orphan_firecrackers(
    fc_procs: &[process::FirecrackerProcessInfo],
    runner_pids: &[u32],
    base_dir_filter: Option<&Path>,
) -> Vec<Warning> {
    let mut warnings = Vec::new();
    for fc in fc_procs {
        if let Some(filter) = base_dir_filter
            && fc.base_dir.as_deref() != Some(filter)
        {
            continue;
        }
        if process::is_orphan(fc.pid, runner_pids).await {
            warnings.push(Warning::OrphanFirecracker {
                pid: fc.pid,
                run_id: fc.run_id.clone(),
                ppid: fc.ppid,
            });
        }
    }
    warnings
}

/// List `vm0-ns-*` namespaces and check if their pool locks are held.
async fn detect_orphan_namespaces() -> Vec<Warning> {
    let mut warnings = Vec::new();

    let output = match tokio::process::Command::new("ip")
        .args(["netns", "list"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return warnings,
    };

    for line in output.lines() {
        // ip netns list output: "vm0-ns-00-0a (id: 42)" or just "vm0-ns-00-0a"
        let ns_name = line.split_whitespace().next().unwrap_or("");
        if !ns_name.starts_with("vm0-ns-") {
            continue;
        }

        // Extract pool index from name: vm0-ns-{pool_idx}-{ns_idx}
        if let Some(pool_idx) = parse_pool_index(ns_name) {
            let lock_path = format!("/var/lock/vm0-netns-pool-{pool_idx}.lock");
            if is_lock_free(&lock_path).await {
                warnings.push(Warning::OrphanNamespace {
                    ns_name: ns_name.to_string(),
                    pool_idx,
                });
            }
        }
    }

    warnings
}

/// Parse pool index from namespace name: `vm0-ns-{XX}-{XX}` → pool_idx as u32.
fn parse_pool_index(ns_name: &str) -> Option<u32> {
    let rest = ns_name.strip_prefix("vm0-ns-")?;
    let pool_hex = rest.split('-').next()?;
    u32::from_str_radix(pool_hex, 16).ok()
}

/// Try non-blocking flock to check if a lock file is free (not held by anyone).
async fn is_lock_free(lock_path: &str) -> bool {
    let lock_path = lock_path.to_string();
    tokio::task::spawn_blocking(move || {
        use std::fs::File;
        let file = match File::open(&lock_path) {
            Ok(f) => f,
            Err(_) => return true, // no lock file → not held
        };
        // Try exclusive lock without blocking
        match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
            Ok(_lock) => true, // lock acquired → was free → orphaned
            Err(_) => false,   // lock held → pool is active
        }
    })
    .await
    .unwrap_or(false) // if task panics, assume lock is held (don't false-positive)
}

// ---------------------------------------------------------------------------
// Orphan dm-snapshot and loop device detection
// ---------------------------------------------------------------------------

/// Detect orphaned dm-snapshot targets and loop devices.
///
/// dm-snapshot targets: `cow-*` with `open_count == 0` (no active sandbox).
///
/// Loop devices (per-device precision, no global guard):
/// - **Cow loops** (backing `…/workspaces/{id}/cow.img`): orphaned when no
///   corresponding `cow-{id}` dm target exists — the dm target is always
///   created before and removed after the cow loop.
/// - **Base loops** (backing `…/rootfs/{hash}/rootfs.ext4`): shared across
///   sandboxes via `BaseLoopCache`, orphaned only when no runner process on
///   the host is alive.
///
/// When `name_filter` is `Some`, only checks resources belonging to the
/// named runner (skips `dmsetup info` calls for unrelated targets).
async fn detect_block_cow_orphans(
    reports: &[RunnerReport],
    name_filter: Option<&str>,
) -> Vec<Warning> {
    let mut warnings = Vec::new();

    // 1. List dm-snapshot targets
    let dm_output = match tokio::process::Command::new("sudo")
        .args(["dmsetup", "ls", "--target", "snapshot"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => {
            warn!(
                stderr = %String::from_utf8_lossy(&o.stderr).trim(),
                "dmsetup ls failed — skipping block-cow check"
            );
            return warnings;
        }
        Err(e) => {
            warn!(error = %e, "dmsetup not available — skipping block-cow check");
            return warnings;
        }
    };

    let dm_target_list = super::gc::parse_dm_targets(&dm_output, "cow-");
    let dm_targets: HashSet<String> = dm_target_list.iter().cloned().collect();

    // Pre-scan workspace directories once for consistent runner correlation.
    // This avoids per-target exists() calls and reduces the TOCTOU window to
    // a single filesystem snapshot.
    let sandbox_runner_map = {
        let dirs: Vec<_> = reports
            .iter()
            .filter_map(|r| Some((r.name.clone()?, r.base_dir.as_ref()?.join("workspaces"))))
            .collect();
        tokio::task::spawn_blocking(move || build_sandbox_runner_map(&dirs))
            .await
            .unwrap_or_default()
    };

    // 2. Orphan dm-snapshot targets (open_count == 0), checked in parallel.
    //    When name_filter is set, only check targets belonging to that runner.
    let mut info_set = tokio::task::JoinSet::new();
    for name in dm_target_list {
        let runner_name = find_runner_for_dm_target(&name, &sandbox_runner_map);
        if name_filter.is_some() && runner_name.as_deref() != name_filter {
            continue;
        }
        info_set.spawn(async move {
            let orphan = dm_target_has_no_openers(&name).await;
            (name, orphan, runner_name)
        });
    }
    while let Some(result) = info_set.join_next().await {
        match result {
            Ok((name, true, runner_name)) => {
                warnings.push(Warning::OrphanDmSnapshot { name, runner_name });
            }
            Ok(_) => {}
            Err(e) => warn!(error = %e, "dmsetup info task failed"),
        }
    }

    // 3. List loop devices under runner root
    let runner_root = match crate::paths::HomePaths::new() {
        Ok(paths) => format!("{}/", paths.root().display()),
        Err(e) => {
            warn!(error = %e, "failed to determine runner root — skipping loop device check");
            return warnings;
        }
    };

    let loop_output = match tokio::process::Command::new("sudo")
        .args(["losetup", "-a"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => {
            warn!(
                stderr = %String::from_utf8_lossy(&o.stderr).trim(),
                "losetup -a failed — skipping loop device check"
            );
            return warnings;
        }
        Err(e) => {
            warn!(error = %e, "losetup not available — skipping loop device check");
            return warnings;
        }
    };

    let loops = super::gc::parse_losetup(&loop_output, &runner_root);
    let any_runner_alive = reports.iter().any(|r| pid_exists(r.pid));

    for (device, backing) in loops {
        let runner_name = find_runner_for_loop(&backing, reports);
        if name_filter.is_some() && runner_name.as_deref() != name_filter {
            continue;
        }

        let is_orphan = if let Some(sandbox_id) = extract_sandbox_id(&backing) {
            // Cow loop: orphaned if no corresponding dm target exists.
            // The dm target (`cow-{id}`) is created before the cow loop and
            // removed after it, so absence means the sandbox is fully torn down.
            let expected = format!("cow-{sandbox_id}");
            !dm_targets.contains(expected.as_str())
        } else {
            // Base loop (rootfs.ext4): shared via BaseLoopCache, orphaned only
            // when every runner process on the host is dead.
            !any_runner_alive
        };

        if is_orphan {
            warnings.push(Warning::OrphanLoopDevice {
                device,
                backing,
                runner_name,
            });
        }
    }

    warnings
}

/// Build a map from sandbox_id → runner_name by scanning workspace directories.
///
/// Takes a single filesystem snapshot so that all runner correlation lookups
/// use a consistent view. Accepts pre-extracted `(runner_name, workspaces_dir)`
/// pairs so it can run inside `spawn_blocking`.
fn build_sandbox_runner_map(dirs: &[(String, PathBuf)]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (name, ws_dir) in dirs {
        let Ok(entries) = std::fs::read_dir(ws_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Some(id) = entry.file_name().to_str() {
                map.insert(id.to_string(), name.clone());
            }
        }
    }
    map
}

/// Find which runner owns a `cow-{sandbox_id}` target via pre-built map.
fn find_runner_for_dm_target(
    target_name: &str,
    sandbox_runner_map: &HashMap<String, String>,
) -> Option<String> {
    let sandbox_id = target_name.strip_prefix("cow-")?;
    sandbox_runner_map.get(sandbox_id).cloned()
}

/// Check if a dm target has no openers (`Open count: 0` in `dmsetup info`).
async fn dm_target_has_no_openers(name: &str) -> bool {
    let output = match tokio::process::Command::new("sudo")
        .args(["dmsetup", "info", name])
        .output()
        .await
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => {
            warn!(name, "dmsetup info failed — assuming target is in use");
            return false;
        }
    };
    parse_dm_open_count(&output) == Some(0)
}

/// Extract `Open count:` value from `dmsetup info` output.
fn parse_dm_open_count(info_output: &str) -> Option<u32> {
    for line in info_output.lines() {
        if let Some(rest) = line.trim().strip_prefix("Open count:") {
            return rest.trim().parse().ok();
        }
    }
    None
}

/// Strip the `" (deleted)"` suffix that the kernel appends to backing file
/// paths when the underlying file has been unlinked.
fn strip_deleted_suffix(s: &str) -> &str {
    s.strip_suffix(" (deleted)").unwrap_or(s)
}

/// Extract sandbox ID from a cow loop backing file path.
///
/// Expected format: `.../workspaces/{sandbox_id}/cow.img[ (deleted)]`
/// Returns `None` for non-cow paths (e.g. `rootfs.ext4`).
fn extract_sandbox_id(backing: &str) -> Option<&str> {
    let path = Path::new(strip_deleted_suffix(backing));
    if path.file_name()? != "cow.img" {
        return None;
    }
    // parent = `.../workspaces/{sandbox_id}`
    let parent = path.parent()?;
    parent.file_name()?.to_str()
}

/// Find which runner owns a loop device by matching backing file path prefix.
fn find_runner_for_loop(backing: &str, reports: &[RunnerReport]) -> Option<String> {
    let path = strip_deleted_suffix(backing);
    reports.iter().find_map(|r| {
        let base_dir = r.base_dir.as_ref()?;
        let prefix = format!("{}/", base_dir.display());
        if path.starts_with(&prefix) {
            r.name.clone()
        } else {
            None
        }
    })
}

/// Check if a loop device still exists.
async fn loop_device_exists(device: &str) -> bool {
    match tokio::process::Command::new("sudo")
        .args(["losetup", device])
        .output()
        .await
    {
        Ok(o) if o.status.success() => true,
        Ok(_) => false, // device gone — expected during cleanup
        Err(e) => {
            warn!(device, error = %e, "losetup check failed — assuming device exists");
            true
        }
    }
}

// ---------------------------------------------------------------------------
// Pretty-print output
// ---------------------------------------------------------------------------

fn print_report(
    reports: &[RunnerReport],
    stopped: &[StoppedInfo],
    global_warnings: &[Warning],
) -> usize {
    let running = reports.len();
    let stopped_count = stopped.len();
    println!("Runners ({running} running, {stopped_count} stopped):\n");

    for (i, r) in reports.iter().enumerate() {
        println!(
            "[{}] {} (PID {}) [{}]",
            i + 1,
            r.config_path.display(),
            r.pid,
            r.subcommand,
        );

        // Service type
        match &r.service_type {
            ServiceType::Installed(name) => println!("    Service: {name} (installed)"),
            ServiceType::Transient(name) => println!("    Service: {name} (transient)"),
            ServiceType::Bare => println!("    Service: none (bare process)"),
        }

        // Mode + uptime
        if let Some(st) = &r.status {
            let uptime = format_uptime(&st.started_at);
            println!("    Mode:    {} ({uptime})", st.mode);
        }

        // API
        match r.api_ok {
            Some(true) => println!("    API:     ok"),
            Some(false) => println!("    API:     UNREACHABLE"),
            None => println!("    API:     not configured"),
        }

        // Proxy
        match (r.proxy_pid, r.status.as_ref().and_then(|st| st.proxy_port)) {
            (Some(pid), Some(port)) => println!("    Proxy:   PID {pid} (port {port})"),
            (Some(pid), None) => println!("    Proxy:   PID {pid}"),
            (None, Some(port)) => println!("    Proxy:   NOT FOUND (port {port})"),
            (None, None) => println!("    Proxy:   unknown"),
        }

        // Jobs
        if !r.jobs.is_empty() {
            let active_count = r
                .jobs
                .iter()
                .filter(|j| matches!(j.status, JobStatus::Running(_) | JobStatus::NoProcess))
                .count();
            println!("    Jobs:    {active_count} active");
            for job in &r.jobs {
                match job.status {
                    JobStatus::Running(pid) => {
                        println!("      - run {} -> PID {pid}", job.run_id);
                    }
                    JobStatus::NoProcess => {
                        println!("      - run {} -> NO PROCESS", job.run_id);
                    }
                    JobStatus::NotInStatus => {
                        println!("      - run {} -> not in status.json", job.run_id);
                    }
                }
            }
        } else if r.status.is_some() {
            println!("    Jobs:    0 active");
        }

        // Per-runner warnings
        if !r.warnings.is_empty() {
            for w in &r.warnings {
                println!("    WARNING: {w}");
            }
        }
        println!();
    }

    // Stopped services
    if !stopped.is_empty() {
        println!("Stopped services:");
        for svc in stopped {
            println!("  {} ({}) -- not running", svc.unit_name, svc.config_info);
        }
        println!();
    }

    // Global warnings (orphans only — per-runner warnings printed above)
    if !global_warnings.is_empty() {
        println!("Warnings:");
        for w in global_warnings {
            println!("  ! {w}");
        }
        println!();
    }

    let total_warnings: usize =
        reports.iter().map(|r| r.warnings.len()).sum::<usize>() + global_warnings.len();
    println!("{total_warnings} warning(s) found");
    total_warnings
}

/// Format an ISO 8601 timestamp as a human-readable relative duration.
fn format_uptime(started_at: &str) -> String {
    let Ok(started) = chrono::DateTime::parse_from_rfc3339(started_at) else {
        return "unknown".into();
    };
    let elapsed = chrono::Utc::now().signed_duration_since(started);
    let total_mins = elapsed.num_minutes();
    if total_mins < 0 {
        return "just started".into();
    }
    let days = elapsed.num_days();
    let hours = elapsed.num_hours() % 24;
    let mins = total_mins % 60;
    let mut out = String::new();
    if days > 0 {
        let _ = write!(out, "{days}d ");
    }
    if days > 0 || hours > 0 {
        let _ = write!(out, "{hours}h ");
    }
    let _ = write!(out, "{mins}m");
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_uptime_minutes() {
        let now = chrono::Utc::now();
        let started = now - chrono::Duration::minutes(42);
        let s = started.to_rfc3339();
        assert_eq!(format_uptime(&s), "42m");
    }

    #[test]
    fn format_uptime_hours_and_minutes() {
        let now = chrono::Utc::now();
        let started = now - chrono::Duration::hours(3) - chrono::Duration::minutes(15);
        let s = started.to_rfc3339();
        assert_eq!(format_uptime(&s), "3h 15m");
    }

    #[test]
    fn format_uptime_days() {
        let now = chrono::Utc::now();
        let started = now - chrono::Duration::days(2) - chrono::Duration::hours(5);
        let s = started.to_rfc3339();
        assert_eq!(format_uptime(&s), "2d 5h 0m");
    }

    #[test]
    fn format_uptime_invalid_timestamp() {
        assert_eq!(format_uptime("not-a-date"), "unknown");
    }

    #[test]
    fn parse_pool_index_valid() {
        assert_eq!(parse_pool_index("vm0-ns-00-0a"), Some(0));
        assert_eq!(parse_pool_index("vm0-ns-3f-ff"), Some(63));
        assert_eq!(parse_pool_index("vm0-ns-0a-00"), Some(10));
    }

    #[test]
    fn parse_pool_index_invalid() {
        assert_eq!(parse_pool_index("not-a-ns"), None);
        assert_eq!(parse_pool_index("vm0-ns-"), None);
        assert_eq!(parse_pool_index("vm0-ns-zz-00"), None);
    }

    #[test]
    fn correlate_jobs_matching() {
        let status = StatusInfo {
            mode: "running".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            active_run_ids: vec!["abc".into(), "def".into()],
            proxy_port: None,
        };
        let fc = vec![
            process::FirecrackerProcessInfo {
                pid: 100,
                ppid: None,
                run_id: "abc".into(),
                base_dir: Some(PathBuf::from("/data/r1")),
            },
            process::FirecrackerProcessInfo {
                pid: 101,
                ppid: None,
                run_id: "def".into(),
                base_dir: Some(PathBuf::from("/data/r1")),
            },
        ];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 2);
        assert!(warnings.is_empty());
        assert!(matches!(
            jobs.first().unwrap().status,
            JobStatus::Running(100)
        ));
    }

    #[test]
    fn correlate_jobs_missing_process() {
        let status = StatusInfo {
            mode: "running".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            active_run_ids: vec!["abc".into()],
            proxy_port: None,
        };
        let fc: Vec<process::FirecrackerProcessInfo> = vec![];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].to_string().contains("no firecracker process"));
    }

    #[test]
    fn correlate_jobs_extra_process() {
        let status = StatusInfo {
            mode: "running".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            active_run_ids: vec![],
            proxy_port: None,
        };
        let fc = vec![process::FirecrackerProcessInfo {
            pid: 200,
            ppid: None,
            run_id: "orphan".into(),
            base_dir: Some(PathBuf::from("/data/r1")),
        }];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].to_string().contains("not in status.json"));
    }

    #[test]
    fn correlate_jobs_ignores_other_runners() {
        let status = StatusInfo {
            mode: "running".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            active_run_ids: vec!["abc".into()],
            proxy_port: None,
        };
        // This firecracker belongs to a different runner (different base_dir)
        let fc = vec![process::FirecrackerProcessInfo {
            pid: 300,
            ppid: None,
            run_id: "abc".into(),
            base_dir: Some(PathBuf::from("/data/r2")),
        }];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].to_string().contains("no firecracker process"));
    }

    #[test]
    fn find_stopped_services_detects_missing() {
        let installed = vec![
            InstalledService {
                unit_name: "vm0-runner-active".into(),
                config_path: Some(PathBuf::from("/data/active.yaml")),
            },
            InstalledService {
                unit_name: "vm0-runner-stopped".into(),
                config_path: Some(PathBuf::from("/data/stopped.yaml")),
            },
        ];
        let reports = vec![RunnerReport {
            name: None,
            base_dir: None,
            pid: 1,
            config_path: PathBuf::from("/data/active.yaml"),
            subcommand: "start".into(),
            service_type: ServiceType::Installed("vm0-runner-active".into()),
            status: None,
            api_ok: None,
            proxy_pid: None,
            jobs: vec![],
            warnings: vec![],
        }];
        let stopped = find_stopped_services(&installed, &reports);
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].unit_name, "vm0-runner-stopped");
        assert_eq!(stopped[0].config_info, "/data/stopped.yaml");
    }

    fn make_report(name: Option<&str>) -> RunnerReport {
        RunnerReport {
            name: name.map(String::from),
            base_dir: None,
            pid: 1,
            config_path: PathBuf::from("/data/test.yaml"),
            subcommand: "start".into(),
            service_type: ServiceType::Bare,
            status: None,
            api_ok: None,
            proxy_pid: None,
            jobs: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn filter_by_name_keeps_matching() {
        let reports = vec![
            make_report(Some("pr-100-1")),
            make_report(Some("pr-200-1")),
            make_report(None),
        ];
        let name_filter = "pr-100-1";
        let filtered: Vec<_> = reports
            .into_iter()
            .filter(|r| r.name.as_deref() == Some(name_filter))
            .collect();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name.as_deref(), Some("pr-100-1"));
    }

    #[test]
    fn filter_by_name_no_match_returns_empty() {
        let reports = vec![make_report(Some("pr-100-1")), make_report(None)];
        let name_filter = "nonexistent";
        let filtered: Vec<_> = reports
            .into_iter()
            .filter(|r| r.name.as_deref() == Some(name_filter))
            .collect();
        assert!(filtered.is_empty());
    }

    #[test]
    fn warning_display() {
        let w = Warning::NoFirecrackerForRun {
            run_id: "abc-123".into(),
            base_dir: PathBuf::from("/data/r1"),
        };
        assert_eq!(w.to_string(), "no firecracker process for run abc-123");

        let w = Warning::ApiUnreachable {
            server_url: "https://example.com".into(),
            server_token: "tok".into(),
        };
        assert_eq!(w.to_string(), "API unreachable");

        let w = Warning::OrphanFirecracker {
            pid: 42,
            run_id: "xyz".into(),
            ppid: Some(10),
        };
        assert_eq!(
            w.to_string(),
            "orphan firecracker PID 42 (run xyz, ppid=10)"
        );

        let w = Warning::OrphanFirecracker {
            pid: 42,
            run_id: "xyz".into(),
            ppid: None,
        };
        assert_eq!(w.to_string(), "orphan firecracker PID 42 (run xyz, ppid=?)");

        let w = Warning::StaleMitmproxy {
            pid: 555,
            port: 32821,
        };
        assert_eq!(
            w.to_string(),
            "stale mitmproxy PID 555 on port 32821 (runner stopped)"
        );

        let w = Warning::OrphanDmSnapshot {
            name: "cow-abc123".into(),
            runner_name: None,
        };
        assert_eq!(
            w.to_string(),
            "orphan dm-snapshot target cow-abc123 (no openers)"
        );

        let w = Warning::OrphanDmSnapshot {
            name: "cow-def456".into(),
            runner_name: Some("pr-100-1".into()),
        };
        assert_eq!(
            w.to_string(),
            "orphan dm-snapshot target cow-def456 (no openers) [runner: pr-100-1]"
        );

        let w = Warning::OrphanLoopDevice {
            device: "/dev/loop5".into(),
            backing: "/home/ubuntu/.vm0-runner/workspaces/x/cow.img".into(),
            runner_name: Some("pr-100-1".into()),
        };
        assert!(w.to_string().contains("/dev/loop5"));
        assert!(w.to_string().contains("cow.img"));
        assert!(w.to_string().contains("[runner: pr-100-1]"));
    }

    #[test]
    fn parse_dm_open_count_extracts_value() {
        let info = "\
Name:              cow-abc123
State:             ACTIVE
Read Ahead:        256
Tables present:    LIVE
Open count:        1
Event number:      0
Major, minor:      253, 0";
        assert_eq!(parse_dm_open_count(info), Some(1));
    }

    #[test]
    fn parse_dm_open_count_zero() {
        let info = "Open count:        0\n";
        assert_eq!(parse_dm_open_count(info), Some(0));
    }

    #[test]
    fn parse_dm_open_count_missing() {
        assert_eq!(parse_dm_open_count("no such field"), None);
    }

    #[test]
    fn is_inactive_mode_classification() {
        assert!(is_inactive_mode("stopped"));
        assert!(is_inactive_mode("draining"));
        assert!(!is_inactive_mode("running"));
        assert!(!is_inactive_mode("starting"));
        assert!(!is_inactive_mode(""));
    }

    /// Helper that replicates the proxy check logic from `build_runner_report`.
    fn proxy_check_warnings(
        mode: &str,
        proxy_port: Option<u16>,
        mitm_procs: &[process::MitmproxyProcessInfo],
    ) -> Vec<Warning> {
        let mut warnings = Vec::new();
        let base_dir = PathBuf::from("/data/r1");
        if let Some(port) = proxy_port {
            let pid = mitm_procs.iter().find(|m| m.port == port).map(|m| m.pid);
            match (mode, pid) {
                ("running", None) => {
                    warnings.push(Warning::NoMitmproxy {
                        port,
                        base_dir: base_dir.clone(),
                    });
                }
                ("stopped", Some(mitm_pid)) => {
                    warnings.push(Warning::StaleMitmproxy {
                        pid: mitm_pid,
                        port,
                    });
                }
                _ => {}
            }
        }
        warnings
    }

    #[test]
    fn proxy_check_no_warning_for_stopped_without_proxy() {
        let warnings = proxy_check_warnings("stopped", Some(32821), &[]);
        assert!(
            warnings.is_empty(),
            "stopped runner without proxy should not warn"
        );
    }

    #[test]
    fn proxy_check_warns_for_running_without_proxy() {
        let warnings = proxy_check_warnings("running", Some(32821), &[]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].to_string().contains("no mitmproxy"));
    }

    #[test]
    fn proxy_check_warns_stale_proxy_on_stopped_runner() {
        let mitm_procs = vec![process::MitmproxyProcessInfo {
            pid: 999,
            ppid: None,
            port: 32821,
        }];
        let warnings = proxy_check_warnings("stopped", Some(32821), &mitm_procs);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].to_string().contains("stale mitmproxy"));
        assert!(warnings[0].to_string().contains("999"));
    }

    #[test]
    fn proxy_check_no_warning_for_draining() {
        // Draining: no warning whether proxy is present or absent
        let warnings = proxy_check_warnings("draining", Some(32821), &[]);
        assert!(
            warnings.is_empty(),
            "draining without proxy should not warn"
        );

        let mitm_procs = vec![process::MitmproxyProcessInfo {
            pid: 999,
            ppid: None,
            port: 32821,
        }];
        let warnings = proxy_check_warnings("draining", Some(32821), &mitm_procs);
        assert!(warnings.is_empty(), "draining with proxy should not warn");
    }

    #[test]
    fn proxy_check_no_warning_for_running_with_proxy() {
        let mitm_procs = vec![process::MitmproxyProcessInfo {
            pid: 999,
            ppid: None,
            port: 32821,
        }];
        let warnings = proxy_check_warnings("running", Some(32821), &mitm_procs);
        assert!(warnings.is_empty(), "running with proxy should not warn");
    }

    #[test]
    fn find_runner_for_dm_target_matches_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        std::fs::create_dir_all(base.join("workspaces/abc123")).unwrap();

        let dirs = vec![("pr-100-1".to_string(), base.join("workspaces"))];
        let map = build_sandbox_runner_map(&dirs);
        assert_eq!(
            find_runner_for_dm_target("cow-abc123", &map),
            Some("pr-100-1".into())
        );
        assert_eq!(find_runner_for_dm_target("cow-unknown", &map), None);
        assert_eq!(find_runner_for_dm_target("not-a-cow", &map), None);
    }

    #[test]
    fn find_runner_for_loop_matches_path_prefix() {
        let reports = vec![RunnerReport {
            name: Some("pr-200-1".into()),
            base_dir: Some(PathBuf::from("/data/runners/pr-200")),
            ..make_report(Some("pr-200-1"))
        }];

        assert_eq!(
            find_runner_for_loop("/data/runners/pr-200/workspaces/x/cow.img", &reports),
            Some("pr-200-1".into())
        );
        assert_eq!(
            find_runner_for_loop(
                "/data/runners/pr-200/workspaces/x/cow.img (deleted)",
                &reports
            ),
            Some("pr-200-1".into())
        );
        assert_eq!(find_runner_for_loop("/other/path/cow.img", &reports), None);
    }

    #[test]
    fn extract_sandbox_id_from_cow_path() {
        assert_eq!(
            extract_sandbox_id(
                "/home/ubuntu/.vm0-runner/runners/pr-123/workspaces/abc-def/cow.img"
            ),
            Some("abc-def")
        );
    }

    #[test]
    fn extract_sandbox_id_from_deleted_cow_path() {
        assert_eq!(
            extract_sandbox_id(
                "/home/ubuntu/.vm0-runner/runners/pr-123/workspaces/abc-def/cow.img (deleted)"
            ),
            Some("abc-def")
        );
    }

    #[test]
    fn extract_sandbox_id_returns_none_for_rootfs() {
        assert_eq!(
            extract_sandbox_id("/home/ubuntu/.vm0-runner/rootfs/560c452/rootfs.ext4"),
            None
        );
    }

    #[test]
    fn extract_sandbox_id_returns_none_for_unrelated() {
        assert_eq!(extract_sandbox_id("/var/lib/snapd/snaps/foo.snap"), None);
    }
}
