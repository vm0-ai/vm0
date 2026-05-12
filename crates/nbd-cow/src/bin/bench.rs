//! Benchmark: NBD COW vs dm-snapshot.
//!
//! Runs fio workloads on both a dm-snapshot device and an NBD COW device,
//! then compares VM-visible IOPS, latency, AND actual host disk IOPS.
//!
//! Requires: root, nbd kernel module, fio, losetup, dmsetup.

use std::path::{Path, PathBuf};
use std::process::Command;

use nbd_cow::{DestroyRetryPolicy, pool::DevicePoolHandle};
use serde_json::Value;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let base_size_mb: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1024);

    eprintln!("=== NBD COW vs dm-snapshot Benchmark ===");
    eprintln!("Base image size: {base_size_mb} MB");

    // Detect host disk
    let host_disk = detect_host_disk();
    eprintln!("Host disk: {host_disk}");
    eprintln!();

    // Check prerequisites
    if !is_root() {
        eprintln!("ERROR: must run as root");
        std::process::exit(1);
    }
    for tool in &["fio", "losetup", "dmsetup"] {
        if !tool_exists(tool) {
            eprintln!("ERROR: {tool} not found in PATH");
            std::process::exit(1);
        }
    }

    let work_dir = tempfile::Builder::new()
        .prefix("nbd-cow-bench-")
        .tempdir()
        .unwrap_or_else(|e| {
            eprintln!("ERROR: failed to create benchmark work directory: {e}");
            std::process::exit(1);
        });
    let work_dir_path = work_dir.path();
    eprintln!("Work directory: {}", work_dir_path.display());

    let base_path = work_dir_path.join("base.img");
    let base_size = base_size_mb * 1024 * 1024;

    // Create base image
    eprintln!("== Creating base image ==");
    if let Err(e) = create_sparse_file(&base_path, base_size) {
        eprintln!("ERROR: {e}");
        drop(work_dir);
        std::process::exit(1);
    }

    let workloads = vec![
        FioWorkload {
            name: "rand4k-read",
            args: "--rw=randread --bs=4k --size=256m --numjobs=4 --direct=1",
        },
        FioWorkload {
            name: "rand4k-write",
            args: "--rw=randwrite --bs=4k --size=256m --numjobs=4 --direct=1",
        },
        FioWorkload {
            name: "seq128k-read",
            args: "--rw=read --bs=128k --size=512m --direct=1",
        },
        FioWorkload {
            name: "seq128k-write",
            args: "--rw=write --bs=128k --size=512m --direct=1",
        },
        FioWorkload {
            name: "mixed-70r30w",
            args: "--rw=randrw --rwmixread=70 --bs=4k --size=256m --direct=1",
        },
    ];

    // --- dm-snapshot benchmark ---
    eprintln!("== Benchmarking dm-snapshot ==");
    cleanup_stale_dm_mappings();
    let dm_name = work_dir_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("bench-cow-{}-{name}", std::process::id()))
        .unwrap_or_else(|| format!("bench-cow-{}", std::process::id()));
    let dm_results = match run_dm_snapshot_bench(
        work_dir_path,
        &base_path,
        base_size,
        &workloads,
        &host_disk,
        &dm_name,
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("dm-snapshot bench failed: {e}");
            vec![]
        }
    };

    // --- NBD COW benchmark ---
    eprintln!("== Benchmarking NBD COW ==");
    // Clean up any stale NBD devices from previous runs
    cleanup_stale_nbd_devices();
    let nbd_results =
        match run_nbd_cow_bench(work_dir_path, &base_path, base_size, &workloads, &host_disk).await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("NBD COW bench failed: {e}");
                vec![]
            }
        };

    // --- Print results ---
    eprintln!("== Results ==");
    eprintln!();
    println!(
        "{:<16} {:>10} {:>10} {:>10} {:>12} {:>10} {:>10} {:>10} {:>12}",
        "Workload",
        "DM IOPS",
        "DM p50",
        "DM p99",
        "DM disk-IO",
        "NBD IOPS",
        "NBD p50",
        "NBD p99",
        "NBD disk-IO"
    );
    println!("{}", "-".repeat(118));

    for (i, wl) in workloads.iter().enumerate() {
        let dm = dm_results.get(i);
        let nbd = nbd_results.get(i);
        println!(
            "{:<16} {:>10} {:>8}us {:>8}us {:>10}/s {:>10} {:>8}us {:>8}us {:>10}/s",
            wl.name,
            dm.map_or("-".into(), |r| r.vm_iops.to_string()),
            dm.map_or("-".into(), |r| r.lat_p50_us.to_string()),
            dm.map_or("-".into(), |r| r.lat_p99_us.to_string()),
            dm.map_or("-".into(), |r| r.host_disk_iops.to_string()),
            nbd.map_or("-".into(), |r| r.vm_iops.to_string()),
            nbd.map_or("-".into(), |r| r.lat_p50_us.to_string()),
            nbd.map_or("-".into(), |r| r.lat_p99_us.to_string()),
            nbd.map_or("-".into(), |r| r.host_disk_iops.to_string()),
        );
    }

    // Cleanup
    eprintln!();
    eprintln!("== Cleaning up ==");
    drop(work_dir);
    eprintln!("Done.");
}

struct FioWorkload {
    name: &'static str,
    args: &'static str,
}

#[derive(Debug, Default)]
struct FioResult {
    /// IOPS as seen by the VM / fio
    vm_iops: u64,
    lat_p50_us: u64,
    lat_p99_us: u64,
    /// Actual IOPS on the host disk during the test
    host_disk_iops: u64,
}

struct LoopDeviceGuard {
    device: String,
    detached: bool,
}

impl LoopDeviceGuard {
    fn attach(path: &Path, read_only: bool) -> Result<Self, String> {
        Ok(Self {
            device: attach_loop(path, read_only)?,
            detached: false,
        })
    }

    fn device(&self) -> &str {
        &self.device
    }

    fn detach(&mut self) -> Result<(), String> {
        if self.detached {
            return Ok(());
        }
        detach_loop(&self.device)?;
        self.detached = true;
        Ok(())
    }
}

impl Drop for LoopDeviceGuard {
    fn drop(&mut self) {
        if !self.detached {
            let _ = detach_loop(&self.device);
        }
    }
}

struct DmMappingGuard {
    name: String,
    removed: bool,
}

impl DmMappingGuard {
    fn create(name: &str, table: &str) -> Result<Self, String> {
        run_cmd("dmsetup", &["create", name, "--table", table])?;
        Ok(Self {
            name: name.to_string(),
            removed: false,
        })
    }

    fn device_path(&self) -> String {
        format!("/dev/mapper/{}", self.name)
    }

    fn remove(&mut self) -> Result<(), String> {
        if self.removed {
            return Ok(());
        }
        run_cmd("dmsetup", &["remove", &self.name])?;
        self.removed = true;
        Ok(())
    }
}

impl Drop for DmMappingGuard {
    fn drop(&mut self) {
        if !self.removed {
            let _ = run_cmd("dmsetup", &["remove", &self.name]);
        }
    }
}

struct TempFileCleanup {
    path: PathBuf,
}

impl TempFileCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempFileCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Snapshot of /proc/diskstats for a specific device.
#[derive(Debug, Clone)]
struct DiskStats {
    reads_completed: u64,
    writes_completed: u64,
}

impl DiskStats {
    fn total_ios(&self) -> u64 {
        self.reads_completed + self.writes_completed
    }
}

fn run_dm_snapshot_bench(
    work_dir: &Path,
    base_path: &Path,
    base_size: u64,
    workloads: &[FioWorkload],
    host_disk: &str,
    dm_name: &str,
) -> Result<Vec<FioResult>, String> {
    let cow_path = work_dir.join("dm-cow.img");
    let sectors = base_size / 512;
    let mut results = Vec::new();

    let mut base_loop = LoopDeviceGuard::attach(base_path, true)?;

    for wl in workloads {
        let _cow_file_cleanup = TempFileCleanup::new(cow_path.clone());
        create_sparse_file(&cow_path, base_size)?;
        let mut cow_loop = LoopDeviceGuard::attach(&cow_path, false)?;

        let table = format!(
            "0 {sectors} snapshot {} {} P 8",
            base_loop.device(),
            cow_loop.device()
        );
        let mut dm_mapping = DmMappingGuard::create(dm_name, &table)?;

        let device = dm_mapping.device_path();
        eprintln!("  Running fio ({}) on {device}...", wl.name);

        let result = run_fio_with_iostat(&device, wl, host_disk)?;
        results.push(result);

        dm_mapping.remove()?;
        cow_loop.detach()?;
    }

    base_loop.detach()?;
    Ok(results)
}

async fn run_nbd_cow_bench(
    work_dir: &Path,
    base_path: &Path,
    base_size: u64,
    workloads: &[FioWorkload],
    host_disk: &str,
) -> Result<Vec<FioResult>, String> {
    let mut results = Vec::new();

    if !nbd_module_loaded() {
        eprintln!("  WARNING: nbd kernel module not loaded.");
        eprintln!("  Load with: modprobe nbd nbds_max=4096");
        return Ok(results);
    }

    eprintln!("  NBD module loaded, setting up NBD COW device...");

    let device_pool = DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    device_pool.warmup().await;

    let result: Result<Vec<FioResult>, String> = async {
        for wl in workloads {
            let cow_path = work_dir.join("nbd-cow.img");
            let _cow_file_cleanup = TempFileCleanup::new(cow_path.clone());

            let device = device_pool
                .create_cow_device(base_path, &cow_path, base_size)
                .await
                .map_err(|e| format!("failed to create NBD COW device: {e}"))?;

            let dev_path = device.device_path().to_string_lossy().to_string();
            eprintln!("  Running fio ({}) on {dev_path}...", wl.name);

            let result = run_fio_with_iostat(&dev_path, wl, host_disk)?;
            results.push(result);

            device
                .destroy_with_retries(DestroyRetryPolicy {
                    attempts: 1,
                    delay: std::time::Duration::ZERO,
                })
                .await
                .map_err(|e| format!("failed to destroy NBD device: {e}"))?;
        }

        Ok(results)
    }
    .await;

    device_pool.cleanup().await;
    result
}

/// Run fio while sampling /proc/diskstats before and after to measure actual host disk IOPS.
fn run_fio_with_iostat(
    device: &str,
    workload: &FioWorkload,
    host_disk: &str,
) -> Result<FioResult, String> {
    // Snapshot disk stats before
    let before = read_diskstats(host_disk)?;

    let start = std::time::Instant::now();

    let output = Command::new("fio")
        .arg(format!("--name={}", workload.name))
        .arg(format!("--filename={device}"))
        .args(workload.args.split_whitespace())
        .arg("--runtime=10")
        .arg("--time_based")
        .arg("--output-format=json")
        .arg("--group_reporting=1")
        .arg("--unified_rw_reporting=1")
        .output()
        .map_err(|e| format!("fio failed to start: {e}"))?;

    let elapsed_secs = start.elapsed().as_secs_f64();

    // Snapshot disk stats after
    let after = read_diskstats(host_disk)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("fio failed: {stderr}"));
    }

    let mut result = parse_fio_json(&output.stdout)?;

    // Calculate actual host disk IOPS
    let delta_ios = after.total_ios().saturating_sub(before.total_ios());
    if elapsed_secs > 0.0 {
        result.host_disk_iops = (delta_ios as f64 / elapsed_secs) as u64;
    }

    eprintln!(
        "    VM IOPS: {}, Host disk IOPS: {}, Duration: {:.1}s",
        result.vm_iops, result.host_disk_iops, elapsed_secs
    );

    Ok(result)
}

/// Read /proc/diskstats for a given device name.
///
/// Format: major minor name rd_ios rd_merges rd_sectors rd_ticks
///         wr_ios wr_merges wr_sectors wr_ticks ...
fn read_diskstats(device_name: &str) -> Result<DiskStats, String> {
    let content =
        std::fs::read_to_string("/proc/diskstats").map_err(|e| format!("read diskstats: {e}"))?;

    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 7 && parts.get(2).is_some_and(|name| *name == device_name) {
            let reads = parts
                .get(3)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let writes = parts
                .get(7)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            return Ok(DiskStats {
                reads_completed: reads,
                writes_completed: writes,
            });
        }
    }

    Err(format!("device {device_name} not found in /proc/diskstats"))
}

/// Auto-detect the host disk by finding the block device backing /tmp.
fn detect_host_disk() -> String {
    // Try to find the device for /tmp via df
    if let Ok(output) = Command::new("df").arg("/tmp").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = stdout.lines().nth(1)
            && let Some(dev) = line.split_whitespace().next()
        {
            // /dev/root -> find actual device
            if dev == "/dev/root" {
                // Check /proc/diskstats for nvme or xvd devices
                if let Ok(stats) = std::fs::read_to_string("/proc/diskstats") {
                    for candidate in &["nvme0n1", "xvda", "sda", "vda"] {
                        if stats.contains(candidate) {
                            return (*candidate).to_string();
                        }
                    }
                }
            } else {
                return diskstats_device_name(dev);
            }
        }
    }
    "nvme0n1".to_string()
}

fn diskstats_device_name(path: &str) -> String {
    let name = path.trim_start_matches("/dev/");

    if let Some((base, partition)) = name.rsplit_once('p')
        && !partition.is_empty()
        && partition.chars().all(|c| c.is_ascii_digit())
        && ["nvme", "mmcblk", "nbd", "loop"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    {
        return base.to_string();
    }

    let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if base.len() != name.len()
        && ["sd", "vd", "xvd"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    {
        return base.to_string();
    }

    name.to_string()
}

fn create_sparse_file(path: &Path, size: u64) -> Result<(), String> {
    let f = std::fs::File::create(path)
        .map_err(|e| format!("failed to create {}: {e}", path.display()))?;
    f.set_len(size)
        .map_err(|e| format!("failed to set {} size: {e}", path.display()))?;
    Ok(())
}

fn parse_fio_json(stdout: &[u8]) -> Result<FioResult, String> {
    let root: Value = serde_json::from_slice(stdout).map_err(|e| format!("parse fio JSON: {e}"))?;
    let jobs = fio_jobs(&root)?;
    let vm_iops = fio_vm_iops(jobs)?;
    let (lat_p50_us, lat_p99_us) = fio_latency_us(jobs)?;

    Ok(FioResult {
        vm_iops: vm_iops as u64,
        lat_p50_us,
        lat_p99_us,
        host_disk_iops: 0,
    })
}

fn fio_jobs(root: &Value) -> Result<&[Value], String> {
    let jobs = root
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| "fio JSON missing jobs array".to_string())?;
    if jobs.is_empty() {
        return Err("fio JSON jobs array is empty".to_string());
    }
    Ok(jobs)
}

fn fio_vm_iops(jobs: &[Value]) -> Result<f64, String> {
    let active_mixed_sections = jobs
        .iter()
        .filter_map(|job| job.get("mixed"))
        .filter(|section| section_is_active(section))
        .collect::<Vec<_>>();
    if !active_mixed_sections.is_empty() {
        return sum_section_iops(&active_mixed_sections, "mixed");
    }

    let active_direction_sections = jobs
        .iter()
        .flat_map(|job| {
            DIRECTIONS
                .iter()
                .filter_map(move |direction| job.get(*direction))
        })
        .filter(|section| section_is_active(section))
        .collect::<Vec<_>>();
    if !active_direction_sections.is_empty() {
        return sum_section_iops(&active_direction_sections, "active direction");
    }

    let mut saw_iops = false;
    let total = jobs
        .iter()
        .flat_map(|job| DIRECTIONS.iter().map(move |direction| (job, *direction)))
        .filter_map(|(job, direction)| {
            section_iops(job, direction).inspect(|_| {
                saw_iops = true;
            })
        })
        .sum::<f64>();

    if !saw_iops {
        return Err("fio JSON missing IOPS fields".to_string());
    }
    Ok(total)
}

const DIRECTIONS: [&str; 3] = ["read", "write", "trim"];

fn fio_latency_us(jobs: &[Value]) -> Result<(u64, u64), String> {
    let active_mixed_sections = jobs
        .iter()
        .filter_map(|job| job.get("mixed"))
        .filter(|section| section_is_active(section))
        .collect::<Vec<_>>();
    if !active_mixed_sections.is_empty() {
        return single_latency_section(active_mixed_sections, "mixed");
    }

    let active_directions = DIRECTIONS
        .iter()
        .copied()
        .filter(|direction| {
            jobs.iter()
                .filter_map(|job| job.get(*direction))
                .any(section_is_active)
        })
        .collect::<Vec<_>>();

    match active_directions.as_slice() {
        [] => Err("fio JSON has no active read/write/trim direction".to_string()),
        [direction] => {
            let latency_sections = jobs
                .iter()
                .filter_map(|job| job.get(*direction))
                .filter(|section| section_is_active(section))
                .collect::<Vec<_>>();
            single_latency_section(latency_sections, direction)
        }
        directions => Err(format!(
            "fio JSON has mixed directions ({}) but no unified mixed latency; rerun with --unified_rw_reporting=1",
            directions.join(",")
        )),
    }
}

fn section_iops(job: &Value, section: &str) -> Option<f64> {
    job.get(section)?.get("iops")?.as_f64()
}

fn sum_section_iops(sections: &[&Value], section_name: &str) -> Result<f64, String> {
    sections
        .iter()
        .map(|section| {
            section
                .get("iops")
                .and_then(Value::as_f64)
                .ok_or_else(|| format!("fio JSON missing {section_name} IOPS for active section"))
        })
        .sum()
}

fn section_is_active(section: &Value) -> bool {
    section_total_ios(section).unwrap_or(0) > 0
        || section.get("iops").and_then(Value::as_f64).unwrap_or(0.0) > 0.0
}

fn section_total_ios(section: &Value) -> Option<u64> {
    section.get("total_ios")?.as_u64()
}

fn section_latency_us(section: &Value, section_name: &str) -> Result<(u64, u64), String> {
    let p50 = percentile_us(section, "50.000000")
        .ok_or_else(|| format!("fio JSON missing {section_name} p50 latency"))?;
    let p99 = percentile_us(section, "99.000000")
        .ok_or_else(|| format!("fio JSON missing {section_name} p99 latency"))?;
    Ok((p50, p99))
}

fn single_latency_section(sections: Vec<&Value>, section_name: &str) -> Result<(u64, u64), String> {
    match sections.as_slice() {
        [] => Err(format!(
            "fio JSON missing {section_name} latency percentiles"
        )),
        [section] => section_latency_us(section, section_name),
        _ => Err(format!(
            "fio JSON has multiple {section_name} latency sections; rerun with --group_reporting=1"
        )),
    }
}

fn percentile_us(section: &Value, percentile: &str) -> Option<u64> {
    let value = section.get("clat_ns")?.get("percentile")?.get(percentile)?;
    let ns = value
        .as_u64()
        .or_else(|| value.as_f64().map(|value| value as u64))?;
    Some(ns / 1000)
}

fn attach_loop(path: &Path, read_only: bool) -> Result<String, String> {
    let mut args = vec!["--find", "--show"];
    if read_only {
        args.push("--read-only");
    }
    args.push("--direct-io=on");
    let path_str = path.to_str().ok_or("invalid path")?;
    args.push(path_str);

    let output = Command::new("losetup")
        .args(&args)
        .output()
        .map_err(|e| format!("losetup failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("losetup failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detach_loop(device: &str) -> Result<(), String> {
    run_cmd("losetup", &["-d", device])
}

fn run_cmd(cmd: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{cmd} failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{cmd} failed: {stderr}"));
    }
    Ok(())
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

fn tool_exists(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn cleanup_stale_dm_mappings() {
    let Ok(output) = Command::new("dmsetup").arg("ls").output() else {
        return;
    };
    if !output.status.success() {
        return;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        let Some(pid) = bench_dm_owner_pid(name) else {
            continue;
        };
        if std::path::Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }

        eprintln!("  Cleaning up stale dm mapping {name} (owner pid={pid})...");
        let _ = run_cmd("dmsetup", &["remove", name]);
    }
}

fn bench_dm_owner_pid(name: &str) -> Option<u32> {
    name.strip_prefix("bench-cow-")?
        .split('-')
        .next()?
        .parse()
        .ok()
}

/// Try to disconnect NBD devices owned by our process that still have a non-zero
/// size (stale from a previous bench run that didn't clean up).
fn cleanup_stale_nbd_devices() {
    let max = nbd_cow::netlink::nbds_max();
    for i in 0..max {
        let size_path = format!("/sys/block/nbd{i}/size");
        let pid_path = format!("/sys/block/nbd{i}/pid");
        let size: u64 = std::fs::read_to_string(&size_path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        if size == 0 {
            continue;
        }
        // Only disconnect devices we own or whose owner is dead.
        let pid: u32 = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        if nbd_cow::is_our_thread(pid) || !std::path::Path::new(&format!("/proc/{pid}")).exists() {
            eprintln!("  Cleaning up stale /dev/nbd{i} (size={size}, pid={pid})...");
            let _ = nbd_cow::netlink::disconnect(i);
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

fn nbd_module_loaded() -> bool {
    std::fs::read_to_string("/proc/modules")
        .map(|s| s.lines().any(|l| l.starts_with("nbd ")))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fio_json_sums_mixed_read_write_iops() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0},
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 11000, "99.000000": 21000}}
                }
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 1000);
        assert_eq!(result.lat_p50_us, 11);
        assert_eq!(result.lat_p99_us, 21);
    }

    #[test]
    fn fio_vm_iops_sums_read_write_without_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {"iops": 700.0, "total_ios": 700},
                "write": {"iops": 300.0, "total_ios": 300},
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;
        let root: Value = serde_json::from_slice(json).unwrap();
        let jobs = fio_jobs(&root).unwrap();

        assert_eq!(fio_vm_iops(jobs).unwrap() as u64, 1000);
    }

    #[test]
    fn parse_fio_json_prefers_mixed_section() {
        let json = br#"{
            "jobs": [{
                "read": {"iops": 700.0, "total_ios": 700},
                "write": {"iops": 300.0, "total_ios": 300},
                "trim": {"iops": 0.0, "total_ios": 0},
                "mixed": {
                    "iops": 950.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000, "99.000000": 23000}}
                }
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 950);
        assert_eq!(result.lat_p50_us, 13);
        assert_eq!(result.lat_p99_us, 23);
    }

    #[test]
    fn parse_fio_json_accepts_float_percentile_values() {
        let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000.0, "99.000000": 23000.0}}
                }
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.lat_p50_us, 13);
        assert_eq!(result.lat_p99_us, 23);
    }

    #[test]
    fn parse_fio_json_ignores_inactive_mixed_section_for_read_only() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 512.0,
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                },
                "write": {"iops": 0.0, "total_ios": 0},
                "trim": {"iops": 0.0, "total_ios": 0},
                "mixed": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 512);
        assert_eq!(result.lat_p50_us, 8);
        assert_eq!(result.lat_p99_us, 16);
    }

    #[test]
    fn parse_fio_json_rejects_active_mixed_section_missing_latency() {
        let json = br#"{
            "jobs": [{
                "mixed": {"iops": 1000.0, "total_ios": 1000}
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("mixed p50 latency"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_active_direction_missing_iops() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                }
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("active direction IOPS"), "{err}");
    }

    #[test]
    fn fio_vm_iops_sums_multiple_jobs() {
        let json = br#"{
            "jobs": [
                {
                    "mixed": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "mixed": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;
        let root: Value = serde_json::from_slice(json).unwrap();
        let jobs = fio_jobs(&root).unwrap();

        assert_eq!(fio_vm_iops(jobs).unwrap() as u64, 1000);
    }

    #[test]
    fn parse_fio_json_rejects_multiple_mixed_latency_sections() {
        let json = br#"{
            "jobs": [
                {
                    "mixed": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "mixed": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("--group_reporting=1"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_multiple_read_latency_sections() {
        let json = br#"{
            "jobs": [
                {
                    "read": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "read": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("--group_reporting=1"), "{err}");
    }

    #[test]
    fn parse_fio_json_accepts_read_only_without_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 512.0,
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                },
                "write": {"iops": 0.0, "total_ios": 0},
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 512);
        assert_eq!(result.lat_p50_us, 8);
        assert_eq!(result.lat_p99_us, 16);
    }

    #[test]
    fn parse_fio_json_accepts_write_only_without_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {"iops": 0.0, "total_ios": 0},
                "write": {
                    "iops": 256.0,
                    "total_ios": 256,
                    "clat_ns": {"percentile": {"50.000000": 9000, "99.000000": 18000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 256);
        assert_eq!(result.lat_p50_us, 9);
        assert_eq!(result.lat_p99_us, 18);
    }

    #[test]
    fn parse_fio_json_rejects_mixed_latency_without_unified_stats() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("unified"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_mixed_latency_without_unified_stats_ignoring_inactive_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "mixed": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("unified"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_invalid_json() {
        let err = parse_fio_json(b"not json").unwrap_err();

        assert!(err.contains("parse fio JSON"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_missing_or_empty_jobs() {
        let missing = parse_fio_json(br#"{}"#).unwrap_err();
        assert!(missing.contains("missing jobs array"), "{missing}");

        let empty = parse_fio_json(br#"{"jobs":[]}"#).unwrap_err();
        assert!(empty.contains("jobs array is empty"), "{empty}");
    }

    #[test]
    fn diskstats_device_name_strips_partition_suffixes() {
        assert_eq!(diskstats_device_name("/dev/nvme0n1p1"), "nvme0n1");
        assert_eq!(diskstats_device_name("/dev/mmcblk0p2"), "mmcblk0");
        assert_eq!(diskstats_device_name("/dev/nbd12p3"), "nbd12");
        assert_eq!(diskstats_device_name("/dev/sda1"), "sda");
        assert_eq!(diskstats_device_name("/dev/vda2"), "vda");
        assert_eq!(diskstats_device_name("/dev/xvdf12"), "xvdf");
    }

    #[test]
    fn diskstats_device_name_preserves_whole_disk_names() {
        assert_eq!(diskstats_device_name("/dev/nvme0n1"), "nvme0n1");
        assert_eq!(diskstats_device_name("/dev/mmcblk0"), "mmcblk0");
        assert_eq!(diskstats_device_name("/dev/nbd12"), "nbd12");
        assert_eq!(diskstats_device_name("/dev/loop0"), "loop0");
        assert_eq!(diskstats_device_name("/dev/sda"), "sda");
        assert_eq!(diskstats_device_name("vda"), "vda");
    }

    #[test]
    fn bench_dm_owner_pid_parses_pid_from_bench_mapping_name() {
        assert_eq!(
            bench_dm_owner_pid("bench-cow-1234-nbd-cow-bench-abcd"),
            Some(1234)
        );
        assert_eq!(bench_dm_owner_pid("bench-cow-1234"), Some(1234));
    }

    #[test]
    fn bench_dm_owner_pid_rejects_non_bench_or_invalid_names() {
        assert_eq!(bench_dm_owner_pid("other-1234-nbd-cow-bench-abcd"), None);
        assert_eq!(bench_dm_owner_pid("bench-cow-nbd-cow-bench-abcd"), None);
        assert_eq!(bench_dm_owner_pid("bench-cow-"), None);
    }
}
