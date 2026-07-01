//! Telemetry recording for sandbox operations.

use crate::log;
use serde::Serialize;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};

static SANDBOX_OPS_APPEND_LOCK: Mutex<()> = Mutex::new(());
static SANDBOX_OPS_LOG_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Set the sandbox operations log path used by future `record_sandbox_op` calls.
pub fn set_sandbox_ops_log_file(path: impl AsRef<Path>) {
    let mut state = SANDBOX_OPS_LOG_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state = Some(path.as_ref().to_path_buf());
}

/// Clear the explicit sandbox operations log path.
pub fn clear_sandbox_ops_log_file() {
    let mut state = SANDBOX_OPS_LOG_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state = None;
}

fn configured_sandbox_ops_log() -> Option<PathBuf> {
    SANDBOX_OPS_LOG_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
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

/// Record a sandbox operation to the telemetry log on a best-effort basis.
///
/// This helper is non-fatal: it no-ops when no explicit log path is configured.
/// Serialization or append/open/lock/write failures are not propagated to the
/// caller. Guest operations should not treat a successful return from this
/// function as proof that a telemetry entry was written.
///
/// Each JSONL entry contains `ts`, `action_type`, `duration_ms`, `success`, and
/// an optional `error` field. The format is compatible with the TypeScript
/// version for consistency.
pub fn record_sandbox_op(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
) {
    let Some(path) = configured_sandbox_ops_log() else {
        return;
    };

    let entry = SandboxOpEntry {
        ts: log::timestamp(),
        action_type: action_type.to_string(),
        duration_ms: duration_ms(duration),
        success,
        error: error.map(String::from),
    };

    let Ok(mut record) = serde_json::to_vec(&entry) else {
        return;
    };
    record.push(b'\n');

    let _ = append_sandbox_op_record(&path, &record);
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn append_sandbox_op_record(path: impl AsRef<Path>, record: &[u8]) -> io::Result<()> {
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
    use std::sync::{Mutex, MutexGuard};
    use std::time::Duration;

    static TELEMETRY_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock_test_state() -> MutexGuard<'static, ()> {
        TELEMETRY_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    struct SandboxOpsOverrideGuard;

    impl SandboxOpsOverrideGuard {
        fn set(path: impl AsRef<Path>) -> Self {
            set_sandbox_ops_log_file(path);
            Self
        }
    }

    impl Drop for SandboxOpsOverrideGuard {
        fn drop(&mut self) {
            clear_sandbox_ops_log_file();
        }
    }

    #[test]
    fn record_sandbox_op_writes_and_appends_jsonl() {
        let _guard = lock_test_state();
        clear_sandbox_ops_log_file();
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir
            .path()
            .join("runtime")
            .join("logs")
            .join("sandbox-ops.jsonl");
        let _override_guard = SandboxOpsOverrideGuard::set(&log_path);

        record_sandbox_op("op_a", Duration::from_millis(10), true, None);
        record_sandbox_op("op_b", Duration::from_millis(20), false, Some("fail"));
        record_sandbox_op("op_max", Duration::MAX, true, None);

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

        let content = std::fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3 + THREAD_COUNT * RECORDS_PER_THREAD);

        let a: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(a["action_type"], "op_a");
        assert_eq!(a["duration_ms"], 10);
        assert!(a["success"].as_bool().unwrap());
        assert!(a["ts"].is_string());

        let b: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(b["action_type"], "op_b");
        assert_eq!(b["error"], "fail");
        assert!(!b["success"].as_bool().unwrap());

        let max_duration: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(max_duration["action_type"], "op_max");
        assert_eq!(max_duration["duration_ms"], u64::MAX);
        assert!(max_duration["success"].as_bool().unwrap());

        let mut actions = HashSet::new();
        for line in lines {
            let entry: serde_json::Value = serde_json::from_str(line).unwrap();
            actions.insert(entry["action_type"].as_str().unwrap().to_string());
        }

        assert_eq!(actions.len(), 3 + THREAD_COUNT * RECORDS_PER_THREAD);
        assert!(actions.contains("op_a"));
        assert!(actions.contains("op_b"));
        assert!(actions.contains("op_max"));
        for thread_index in 0..THREAD_COUNT {
            for record_index in 0..RECORDS_PER_THREAD {
                assert!(actions.contains(&format!("op_{thread_index}_{record_index}")));
            }
        }

        let _ = std::fs::remove_file(&log_path);
    }

    #[test]
    fn record_sandbox_op_uses_explicit_log_path_override() {
        let _guard = lock_test_state();
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("runtime").join("logs").join("ops.jsonl");
        let _override_guard = SandboxOpsOverrideGuard::set(&log_path);

        record_sandbox_op("op_override", Duration::from_millis(12), true, None);

        let content = std::fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 1);
        let entry: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(entry["action_type"], "op_override");
        assert_eq!(entry["duration_ms"], 12);
    }

    #[test]
    fn record_sandbox_op_noops_without_explicit_log_path() {
        let _guard = lock_test_state();
        clear_sandbox_ops_log_file();
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir
            .path()
            .join("runtime")
            .join("logs")
            .join("sandbox-ops.jsonl");

        record_sandbox_op("op_without_path", Duration::from_millis(1), true, None);

        assert!(
            !log_path.exists(),
            "sandbox op logging should not create a file without an explicit path"
        );
    }
}
