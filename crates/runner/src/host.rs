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
}
