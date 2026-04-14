//! Runtime health diagnostics for all runners on the host.

use std::fmt;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use crate::config::RunnerConfig;
use crate::error::RunnerResult;
use crate::process;
use clap::Args;
use serde::Deserialize;

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
    /// status.json lists a dns_port but no dnsmasq process found on it.
    NoDnsmasq { port: u16, base_dir: PathBuf },
    /// A network namespace whose pool lock is not held by any process.
    OrphanNamespace { ns_name: String, pool_idx: u32 },
    /// An NBD device whose owning process has exited without disconnecting.
    OrphanNbdDevice { device_index: u32, pid: u32 },
    /// The NBD orphan scan task panicked (bug in find_nbd_orphans).
    NbdScanFailed,
}

impl fmt::Display for Warning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiUnreachable { .. } => write!(f, "API unreachable"),
            Self::NoMitmproxy { port, .. } => {
                write!(f, "no mitmproxy process on port {port}")
            }
            Self::NoDnsmasq { port, .. } => {
                write!(f, "no dnsmasq process on port {port}")
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
            Self::OrphanNbdDevice { device_index, pid } => {
                write!(
                    f,
                    "orphan NBD device /dev/nbd{device_index} (owner PID {pid} no longer exists)"
                )
            }
            Self::NbdScanFailed => {
                write!(f, "NBD orphan scan failed (task panicked)")
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
            Self::NoDnsmasq { port, base_dir } => {
                if fresh.dnsmasqs.iter().any(|d| d.port == *port) {
                    return false;
                }
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
            Self::OrphanNbdDevice { device_index, pid } => {
                // Re-read sysfs to check if the device is still connected with a dead owner.
                let idx = *device_index;
                let original_pid = *pid;
                tokio::task::spawn_blocking(move || {
                    match super::nbd::read_nbd_pid(idx) {
                        Some(current_pid) => {
                            // Still orphaned if same dead PID
                            current_pid == original_pid && !pid_exists(current_pid)
                        }
                        None => false, // device freed or pid cleared
                    }
                })
                .await
                .unwrap_or(false)
            }
            Self::NbdScanFailed => {
                // Retry the scan — persists if it panics again.
                tokio::task::spawn_blocking(super::nbd::find_nbd_orphans)
                    .await
                    .is_err()
            }
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
    dns_pid: Option<u32>,
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
    dns_port: Option<u16>,
    idle_vms: usize,
    idle_sessions: Vec<String>,
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
            &discovered.dnsmasqs,
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
    // When --name is set, run orphan firecracker detection scoped to that
    // runner. Orphan mitmproxy and namespace are skipped (no
    // runner-identifying info on orphaned processes).
    let mut global_warnings: Vec<Warning> = if args.name.is_none() {
        detect_global_orphans(&reports, &discovered.firecrackers, &discovered.mitmdumps).await
    } else {
        // Scoped detection: orphan firecracker for the named runner.
        // Orphan mitmproxy, namespace, and NBD devices are skipped because
        // they lack per-runner attribution — report them only in global mode
        // (no --name) so they don't cause unrelated runners to fail.
        let mut warnings = Vec::new();

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
    dns_procs: &[process::DnsmasqProcessInfo],
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

    // DNS proxy check (same pattern as proxy check).
    let dns_pid = if let Some(st) = &status
        && let Some(port) = st.dns_port
    {
        let pid = dns_procs.iter().find(|d| d.port == port).map(|d| d.pid);
        if st.mode == "running" && pid.is_none() {
            let bd = base_dir.map(|p| p.to_path_buf()).unwrap_or_default();
            warnings.push(Warning::NoDnsmasq { port, base_dir: bd });
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
        dns_pid,
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
    #[serde(default)]
    dns_port: Option<u16>,
    #[serde(default)]
    idle_vms: usize,
    #[serde(default)]
    idle_sessions: Vec<String>,
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
        dns_port: file.dns_port,
        idle_vms: file.idle_vms,
        idle_sessions: file.idle_sessions,
    })
}

// ---------------------------------------------------------------------------
// API connectivity check
// ---------------------------------------------------------------------------

/// Returns `true` if the URL's host TLD is `.test` (RFC 2606).
fn is_test_tld(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    parsed
        .host_str()
        .is_some_and(|h| h.ends_with(".test") || h == "test")
}

/// Returns `None` if no server configured or URL uses `.test` TLD (RFC 2606),
/// `Some(true)` if reachable, `Some(false)` if unreachable.
async fn check_api(config: &RunnerConfig) -> Option<bool> {
    let server = config.server.as_ref()?;
    // Skip connectivity check for .test domains (reserved per RFC 2606, used in CI)
    if is_test_tld(&server.url) {
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

    // Orphan NBD devices
    warnings.extend(detect_nbd_orphans().await);

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

/// Scan for NBD devices whose owning process has exited without disconnecting.
async fn detect_nbd_orphans() -> Vec<Warning> {
    let (_, orphans) = match tokio::task::spawn_blocking(super::nbd::find_nbd_orphans).await {
        Ok(result) => result,
        Err(e) => {
            tracing::warn!("NBD orphan scan task failed: {e}");
            return vec![Warning::NbdScanFailed];
        }
    };

    orphans
        .into_iter()
        .map(|(device_index, pid)| Warning::OrphanNbdDevice { device_index, pid })
        .collect()
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

        // DNS proxy
        match (r.dns_pid, r.status.as_ref().and_then(|st| st.dns_port)) {
            (Some(pid), Some(port)) => println!("    DNS:     PID {pid} (port {port})"),
            (Some(pid), None) => println!("    DNS:     PID {pid}"),
            (None, Some(port)) => println!("    DNS:     NOT FOUND (port {port})"),
            (None, None) => {}
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

        // Idle VMs (keep-alive)
        if let Some(st) = &r.status
            && st.idle_vms > 0
        {
            println!("    Idle:    {} VMs", st.idle_vms);
            for session in &st.idle_sessions {
                println!("      - session {session}");
            }
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
            dns_port: None,
            idle_vms: 0,
            idle_sessions: vec![],
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
            dns_port: None,
            idle_vms: 0,
            idle_sessions: vec![],
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
            dns_port: None,
            idle_vms: 0,
            idle_sessions: vec![],
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
            dns_port: None,
            idle_vms: 0,
            idle_sessions: vec![],
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
            dns_pid: None,
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
            dns_pid: None,
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

        let w = Warning::OrphanNbdDevice {
            device_index: 3,
            pid: 12345,
        };
        assert_eq!(
            w.to_string(),
            "orphan NBD device /dev/nbd3 (owner PID 12345 no longer exists)"
        );

        let w = Warning::NbdScanFailed;
        assert_eq!(w.to_string(), "NBD orphan scan failed (task panicked)");
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
    fn is_test_tld_matches_dot_test() {
        assert!(is_test_tld("https://not-a-real-server.test/api"));
        assert!(is_test_tld("https://sub.domain.test"));
        assert!(is_test_tld("https://test"));
        assert!(is_test_tld("https://server.test:8080/api"));
    }

    #[test]
    fn is_test_tld_rejects_substring_match() {
        assert!(!is_test_tld("https://attestation.service.internal/api"));
        assert!(!is_test_tld("https://my.testing.company.com/api"));
        assert!(!is_test_tld("https://contest.example.com"));
    }

    #[test]
    fn is_test_tld_handles_edge_cases() {
        assert!(!is_test_tld("not-a-url"));
        assert!(!is_test_tld("https://example.com/.test"));
        assert!(!is_test_tld("https://example.com?q=.test"));
    }
}
