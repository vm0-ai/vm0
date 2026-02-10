//! System metrics collection: CPU, memory, disk.
//!
//! Reads `/proc/stat` for CPU, `/proc/meminfo` for memory, and uses
//! `libc::statvfs` for disk. Writes JSONL to the metrics log file.

use crate::constants;
use crate::paths;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
struct MetricsEntry {
    ts: String,
    cpu: f64,
    mem_used: u64,
    mem_total: u64,
    disk_used: u64,
    disk_total: u64,
}

/// Parse `/proc/stat` to get overall CPU usage percentage.
fn get_cpu_percent() -> f64 {
    let content = match std::fs::read_to_string("/proc/stat") {
        Ok(c) => c,
        Err(_) => return 0.0,
    };
    let first_line = match content.lines().next() {
        Some(l) => l,
        None => return 0.0,
    };
    if !first_line.starts_with("cpu ") {
        return 0.0;
    }
    let values: Vec<u64> = first_line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if values.len() < 5 {
        return 0.0;
    }
    // idle = values[3], iowait = values[4]
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    let total: u64 = values.iter().sum();
    if total == 0 {
        return 0.0;
    }
    let pct = 100.0 * (1.0 - idle as f64 / total as f64);
    (pct * 100.0).round() / 100.0
}

/// Parse `/proc/meminfo` to get (used, total) in bytes.
fn get_memory_info() -> (u64, u64) {
    let content = match std::fs::read_to_string("/proc/meminfo") {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    let mut total_kb = 0u64;
    let mut available_kb = 0u64;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = parse_meminfo_value(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available_kb = parse_meminfo_value(rest);
        }
    }
    let total = total_kb * 1024;
    let used = total.saturating_sub(available_kb * 1024);
    (used, total)
}

fn parse_meminfo_value(s: &str) -> u64 {
    // Format: "     12345 kB"
    s.split_whitespace()
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Get disk usage for `/` via `libc::statvfs`. Returns (used, total) in bytes.
fn get_disk_info() -> (u64, u64) {
    let path = c"/";
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
    if ret != 0 {
        return (0, 0);
    }
    let block_size = stat.f_frsize;
    let total = stat.f_blocks * block_size;
    let free = stat.f_bfree * block_size;
    let used = total.saturating_sub(free);
    (used, total)
}

/// Collect one snapshot of system metrics.
fn collect_metrics() -> MetricsEntry {
    let cpu = get_cpu_percent();
    let (mem_used, mem_total) = get_memory_info();
    let (disk_used, disk_total) = get_disk_info();
    MetricsEntry {
        ts: guest_common::log::timestamp(),
        cpu,
        mem_used,
        mem_total,
        disk_used,
        disk_total,
    }
}

/// Background loop writing metrics JSONL every `METRICS_INTERVAL_SECS`.
pub async fn metrics_loop(shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(constants::METRICS_INTERVAL_SECS));
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => {
                let entry = collect_metrics();
                if let Ok(json) = serde_json::to_string(&entry) {
                    let path = paths::metrics_log_file();
                    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                        let _ = writeln!(f, "{json}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cpu_percent_handles_empty() {
        // get_cpu_percent reads /proc/stat which may or may not exist in CI
        let pct = get_cpu_percent();
        assert!((0.0..=100.0).contains(&pct));
    }

    #[test]
    fn parse_meminfo_value_basic() {
        assert_eq!(parse_meminfo_value("  12345 kB"), 12345);
        assert_eq!(parse_meminfo_value("  0 kB"), 0);
        assert_eq!(parse_meminfo_value(""), 0);
    }
}
