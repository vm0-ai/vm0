//! Telemetry recording for sandbox operations.

use crate::log;
use serde::Serialize;
use std::fs::File;
use std::io::{self, Write};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};

static RUN_ID: LazyLock<String> =
    LazyLock::new(|| std::env::var(guest_contracts::env::RUN_ID_ENV).unwrap_or_default());

static SANDBOX_OPS_LOG: LazyLock<String> = LazyLock::new(|| {
    let Ok(run_dir) = guest_contracts::runtime_paths::run_dir_from_env(&RUN_ID) else {
        return String::new();
    };
    guest_contracts::runtime_paths::sandbox_ops_log_file(run_dir)
        .to_string_lossy()
        .into_owned()
});

static SANDBOX_OPS_APPEND_LOCK: Mutex<()> = Mutex::new(());

/// Path to sandbox operations log file (JSONL format).
pub fn sandbox_ops_log() -> &'static str {
    &SANDBOX_OPS_LOG
}

#[cfg(unix)]
struct FileLockGuard {
    fd: RawFd,
}

#[cfg(unix)]
impl FileLockGuard {
    fn lock(file: &File) -> io::Result<Self> {
        let fd = file.as_raw_fd();
        flock_fd(fd, libc::LOCK_EX)?;
        Ok(Self { fd })
    }
}

#[cfg(unix)]
impl Drop for FileLockGuard {
    fn drop(&mut self) {
        let _ = flock_fd(self.fd, libc::LOCK_UN);
    }
}

#[cfg(unix)]
fn flock_fd(fd: RawFd, operation: libc::c_int) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is borrowed from an open `File`, and `flock` does not
        // mutate Rust memory. The caller owns the descriptor for the lock's
        // lifetime.
        let result = unsafe { libc::flock(fd, operation) };
        if result == 0 {
            return Ok(());
        }

        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
}

#[cfg(not(unix))]
struct FileLockGuard;

#[cfg(not(unix))]
impl FileLockGuard {
    fn lock(_file: &File) -> io::Result<Self> {
        Ok(Self)
    }
}

#[derive(Serialize)]
struct SandboxOpEntry {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Record a sandbox operation to the telemetry log.
///
/// Writes a JSONL entry to the guest runtime sandbox operations log.
/// Format is compatible with the TypeScript version for consistency.
pub fn record_sandbox_op(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
) {
    let entry = SandboxOpEntry {
        ts: log::timestamp(),
        action_type: action_type.to_string(),
        duration_ms: duration.as_millis() as u64,
        success,
        error: error.map(String::from),
    };

    let path = sandbox_ops_log();
    if path.is_empty() {
        return;
    }

    let Ok(mut record) = serde_json::to_vec(&entry) else {
        return;
    };
    record.push(b'\n');

    let _ = append_sandbox_op_record(path, &record);
}

fn append_sandbox_op_record(path: &str, record: &[u8]) -> io::Result<()> {
    let mut file = guest_contracts::runtime_paths::open_private_append(path)?;
    let _append_guard = SANDBOX_OPS_APPEND_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _file_lock = FileLockGuard::lock(&file)?;

    file.write_all(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::time::Duration;

    #[test]
    fn record_sandbox_op_writes_and_appends_jsonl() {
        // Single test because all calls share the same static log path.
        let dir = tempfile::tempdir().unwrap();
        let runtime_dir = dir.path().join("runtime");
        unsafe {
            std::env::set_var(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            );
        }
        let log_path = sandbox_ops_log();
        let _ = std::fs::remove_file(log_path);

        record_sandbox_op("op_a", Duration::from_millis(10), true, None);
        record_sandbox_op("op_b", Duration::from_millis(20), false, Some("fail"));

        const THREAD_COUNT: usize = 8;
        const RECORDS_PER_THREAD: usize = 64;

        std::thread::scope(|scope| {
            for thread_index in 0..THREAD_COUNT {
                scope.spawn(move || {
                    for record_index in 0..RECORDS_PER_THREAD {
                        let action_type = format!("op_{thread_index}_{record_index}");
                        let error = format!("error_{thread_index}_{record_index}");
                        record_sandbox_op(
                            &action_type,
                            Duration::from_millis(record_index as u64),
                            false,
                            Some(&error),
                        );
                    }
                });
            }
        });

        let content = std::fs::read_to_string(log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2 + THREAD_COUNT * RECORDS_PER_THREAD);

        let a: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(a["action_type"], "op_a");
        assert_eq!(a["duration_ms"], 10);
        assert!(a["success"].as_bool().unwrap());
        assert!(a["ts"].is_string());

        let b: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(b["action_type"], "op_b");
        assert_eq!(b["error"], "fail");
        assert!(!b["success"].as_bool().unwrap());

        let mut actions = HashSet::new();
        for line in lines {
            let entry: serde_json::Value = serde_json::from_str(line).unwrap();
            actions.insert(entry["action_type"].as_str().unwrap().to_string());
        }

        assert_eq!(actions.len(), 2 + THREAD_COUNT * RECORDS_PER_THREAD);
        assert!(actions.contains("op_a"));
        assert!(actions.contains("op_b"));
        for thread_index in 0..THREAD_COUNT {
            for record_index in 0..RECORDS_PER_THREAD {
                assert!(actions.contains(&format!("op_{thread_index}_{record_index}")));
            }
        }

        let _ = std::fs::remove_file(log_path);
        unsafe {
            std::env::remove_var(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV);
        }
    }
}
