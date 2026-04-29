//! Benchmark: NBD COW vs dm-snapshot.
//!
//! Runs fio workloads on both a dm-snapshot device and an NBD COW device,
//! then compares VM-visible IOPS, latency, AND actual host disk IOPS.
//!
//! Requires: root, nbd kernel module, fio, losetup, dmsetup.

use std::path::{Path, PathBuf};
use std::process::Command;

use nbd_cow::{DestroyRetryPolicy, pool::DevicePoolHandle};

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

    let work_dir = PathBuf::from("/tmp/nbd-cow-bench");
    let _ = std::fs::create_dir_all(&work_dir);

    let base_path = work_dir.join("base.img");
    let base_size = base_size_mb * 1024 * 1024;

    // Create base image
    eprintln!("[1/5] Creating {base_size_mb}MB base image...");
    create_sparse_file(&base_path, base_size);

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
    eprintln!("[2/5] Setting up dm-snapshot...");
    let dm_results =
        match run_dm_snapshot_bench(&work_dir, &base_path, base_size, &workloads, &host_disk) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("dm-snapshot bench failed: {e}");
                vec![]
            }
        };

    // --- NBD COW benchmark ---
    eprintln!("[3/5] Setting up NBD COW...");
    // Clean up any stale NBD devices from previous runs
    cleanup_stale_nbd_devices();
    let nbd_results =
        match run_nbd_cow_bench(&work_dir, &base_path, base_size, &workloads, &host_disk).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("NBD COW bench failed: {e}");
                vec![]
            }
        };

    // --- Print results ---
    eprintln!("[5/5] Results:");
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
    eprintln!("Cleaning up...");
    let _ = std::fs::remove_dir_all(&work_dir);
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
) -> Result<Vec<FioResult>, String> {
    let cow_path = work_dir.join("dm-cow.img");
    let sectors = base_size / 512;
    let mut results = Vec::new();

    let base_loop = attach_loop(base_path, true)?;

    for wl in workloads {
        create_sparse_file(&cow_path, base_size);
        let cow_loop = attach_loop(&cow_path, false)?;

        let dm_name = "bench-cow";
        let table = format!("0 {sectors} snapshot {base_loop} {cow_loop} P 8");
        run_cmd("dmsetup", &["create", dm_name, "--table", &table])?;

        let device = format!("/dev/mapper/{dm_name}");
        eprintln!("  Running fio ({}) on {device}...", wl.name);

        let result = run_fio_with_iostat(&device, wl, host_disk)?;
        results.push(result);

        let _ = run_cmd("dmsetup", &["remove", dm_name]);
        detach_loop(&cow_loop)?;
        let _ = std::fs::remove_file(&cow_path);
    }

    detach_loop(&base_loop)?;
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

    for wl in workloads {
        let cow_path = work_dir.join("nbd-cow.img");

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
        let _ = std::fs::remove_file(&cow_path);
    }

    device_pool.cleanup().await;
    Ok(results)
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
                // Strip /dev/ prefix and partition suffix
                let name = dev.trim_start_matches("/dev/");
                // Remove partition number (nvme0n1p1 -> nvme0n1, sda1 -> sda)
                if let Some(base) = name.strip_suffix(|c: char| c.is_ascii_digit()) {
                    if base.ends_with('p') && base.contains("nvme") {
                        return base.trim_end_matches('p').to_string();
                    }
                    return base.to_string();
                }
                return name.to_string();
            }
        }
    }
    "nvme0n1".to_string()
}

fn create_sparse_file(path: &Path, size: u64) {
    let f = std::fs::File::create(path).unwrap_or_else(|e| {
        eprintln!("Failed to create {}: {e}", path.display());
        std::process::exit(1);
    });
    f.set_len(size).unwrap_or_else(|e| {
        eprintln!("Failed to set file size: {e}");
        std::process::exit(1);
    });
}

fn parse_fio_json(stdout: &[u8]) -> Result<FioResult, String> {
    let text = String::from_utf8_lossy(stdout);
    let mut result = FioResult::default();

    for pattern in &["\"iops\""] {
        for line in text.lines() {
            if line.contains(pattern)
                && let Some(val) = extract_number(line)
                && val > result.vm_iops
            {
                result.vm_iops = val;
            }
        }
    }

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.contains("\"50.000000\"")
            && let Some(val) = extract_number(trimmed)
        {
            result.lat_p50_us = val / 1000;
        }
        if trimmed.contains("\"99.000000\"")
            && let Some(val) = extract_number(trimmed)
        {
            result.lat_p99_us = val / 1000;
        }
    }

    Ok(result)
}

fn extract_number(s: &str) -> Option<u64> {
    let after_colon = s.rsplit(':').next()?;
    let cleaned: String = after_colon
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    cleaned.split('.').next()?.parse().ok()
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
