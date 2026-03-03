use crate::error::{RunnerError, RunnerResult};

/// Return the number of logical CPUs available to this process.
pub fn cpu_count() -> RunnerResult<usize> {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .map_err(|e| RunnerError::Internal(format!("detect CPU count: {e}")))
}

/// Read total physical memory in MiB from `/proc/meminfo`.
pub fn memory_mb() -> RunnerResult<usize> {
    let content = std::fs::read_to_string("/proc/meminfo")
        .map_err(|e| RunnerError::Internal(format!("read /proc/meminfo: {e}")))?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: usize = rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse()
                .map_err(|e| RunnerError::Internal(format!("parse MemTotal: {e}")))?;
            return Ok(kb / 1024);
        }
    }
    Err(RunnerError::Internal(
        "MemTotal not found in /proc/meminfo".into(),
    ))
}

/// Compute how many sandboxes can run concurrently given host resources and
/// per-sandbox requirements.
///
/// Uses integer division because we need whole sandboxes — a host with 5 CPUs
/// and vcpu=2 can run 2 sandboxes, not 2.5.
pub fn compute_max_concurrent(
    host_cpus: usize,
    host_memory_mb: usize,
    vcpu: u32,
    memory_mb: u32,
) -> usize {
    std::cmp::min(
        host_cpus / vcpu as usize,
        host_memory_mb / memory_mb as usize,
    )
    .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_count_is_positive() {
        assert!(cpu_count().unwrap() > 0);
    }

    #[test]
    fn memory_mb_is_positive() {
        // Only works on Linux with /proc
        if std::path::Path::new("/proc/meminfo").exists() {
            assert!(memory_mb().unwrap() > 0);
        }
    }

    #[test]
    fn compute_max_concurrent_cpu_limited() {
        // 8 CPUs, 32 GB, 2 vcpu, 4 GB per VM → min(4, 8) = 4
        assert_eq!(compute_max_concurrent(8, 32768, 2, 4096), 4);
    }

    #[test]
    fn compute_max_concurrent_memory_limited() {
        // 16 CPUs, 8 GB, 2 vcpu, 4 GB per VM → min(8, 2) = 2
        assert_eq!(compute_max_concurrent(16, 8192, 2, 4096), 2);
    }

    #[test]
    fn compute_max_concurrent_minimum_one() {
        // 1 CPU, 1 GB, 2 vcpu, 4 GB → min(0, 0) → max(1) = 1
        assert_eq!(compute_max_concurrent(1, 1024, 2, 4096), 1);
    }

    #[test]
    fn compute_max_concurrent_exact_fit() {
        // 4 CPUs, 8 GB, 2 vcpu, 2 GB → min(2, 4) = 2
        assert_eq!(compute_max_concurrent(4, 8192, 2, 2048), 2);
    }
}
