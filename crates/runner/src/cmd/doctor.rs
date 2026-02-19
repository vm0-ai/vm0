//! Runtime health diagnostics for all runners on the host.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use serde::Deserialize;

use crate::config::RunnerConfig;
use crate::error::RunnerResult;
use crate::process;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

#[derive(Args)]
pub struct DoctorArgs {}

// ---------------------------------------------------------------------------
// Report structs
// ---------------------------------------------------------------------------

struct RunnerReport {
    pid: u32,
    config_path: PathBuf,
    subcommand: String,
    service_type: ServiceType,
    status: Option<StatusInfo>,
    api_ok: Option<bool>,
    proxy_pid: Option<u32>,
    jobs: Vec<JobReport>,
    warnings: Vec<String>,
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run_doctor(_args: DoctorArgs) -> RunnerResult<ExitCode> {
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
    let stopped = find_stopped_services(&installed_services, &reports);

    // Phase 5: Global orphan detection
    let global_warnings =
        detect_global_orphans(&reports, &discovered.firecrackers, &discovered.mitmdumps).await;

    // Phase 6: Output
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
    if api_ok == Some(false) {
        warnings.push("API unreachable".into());
    }

    // Base dir for job correlation
    let base_dir = config.as_ref().map(|c| &c.base_dir);

    // Proxy check (match by port from status.json)
    let proxy_pid = if let Some(st) = &status
        && let Some(port) = st.proxy_port
    {
        let pid = mitm_procs.iter().find(|m| m.port == port).map(|m| m.pid);
        if pid.is_none() {
            warnings.push(format!("no mitmproxy process on port {port}"));
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
fn find_stopped_services<'a>(
    installed: &'a [InstalledService],
    reports: &[RunnerReport],
) -> Vec<&'a InstalledService> {
    installed
        .iter()
        .filter(|svc| {
            !reports.iter().any(|r| match &r.service_type {
                ServiceType::Installed(name) => name == &svc.unit_name,
                _ => false,
            })
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

/// Returns `None` if no server configured, `Some(true)` if reachable,
/// `Some(false)` if unreachable.
async fn check_api(config: &RunnerConfig) -> Option<bool> {
    let server = config.server.as_ref()?;
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
) -> (Vec<JobReport>, Vec<String>) {
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
                warnings.push(format!("no firecracker process for run {run_id}"));
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
            warnings.push(format!(
                "firecracker PID {} (run {}) not in status.json",
                fc.pid, fc.run_id
            ));
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
) -> Vec<String> {
    let mut warnings = Vec::new();

    let runner_pids: Vec<u32> = reports.iter().map(|r| r.pid).collect();

    // Orphan firecracker processes
    for fc in fc_procs {
        if process::is_orphan(fc.pid, &runner_pids).await {
            warnings.push(format!(
                "orphan firecracker PID {} (run {}, ppid={})",
                fc.pid,
                fc.run_id,
                fc.ppid.map_or("?".into(), |p| p.to_string()),
            ));
        }
    }

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
            warnings.push(format!(
                "orphan mitmdump PID {} (port {}, ppid={})",
                mitm.pid,
                mitm.port,
                mitm.ppid.map_or("?".into(), |p| p.to_string()),
            ));
        }
    }

    // Orphan network namespaces
    warnings.extend(detect_orphan_namespaces().await);

    warnings
}

/// List `vm0-ns-*` namespaces and check if their pool locks are held.
async fn detect_orphan_namespaces() -> Vec<String> {
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
                warnings.push(format!("orphan namespace {ns_name} (pool lock not held)"));
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
// Pretty-print output
// ---------------------------------------------------------------------------

fn print_report(
    reports: &[RunnerReport],
    stopped: &[&InstalledService],
    global_warnings: &[String],
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
            let config_info = svc
                .config_path
                .as_ref()
                .map_or("unknown config".into(), |p| p.display().to_string());
            println!("  {} ({config_info}) -- not running", svc.unit_name);
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
        assert!(warnings.first().unwrap().contains("no firecracker process"));
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
        assert!(warnings.first().unwrap().contains("not in status.json"));
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
        assert!(warnings.first().unwrap().contains("no firecracker process"));
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
        assert_eq!(stopped.first().unwrap().unit_name, "vm0-runner-stopped");
    }
}
