//! Logging utilities for VM scripts.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

static SYSTEM_LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Get current timestamp in RFC3339 format with milliseconds.
pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Also append future log lines to a system log file.
///
/// The write is synchronous and completes before the logging macro returns.
/// This matters for guest-agent's final telemetry upload, which reads the
/// same file immediately after some fatal-path log lines are emitted.
pub fn set_system_log_file(path: impl AsRef<Path>) {
    let mut guard = SYSTEM_LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(path.as_ref().to_path_buf());
}

#[doc(hidden)]
pub fn clear_system_log_file() {
    let mut guard = SYSTEM_LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn append_system_log_line(line: &str) -> std::io::Result<()> {
    let guard = SYSTEM_LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = guard.as_ref() else {
        return Ok(());
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
    use std::io::Write;
    let mut line = line.as_bytes().to_vec();
    line.push(b'\n');
    file.write_all(&line)?;
    file.flush()
}

fn write_stderr_line(line: &str) {
    use std::io::Write;
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(line.as_bytes());
    let _ = stderr.write_all(b"\n");
    let _ = stderr.flush();
}

/// Emit one formatted log line to stderr and, when configured, to the
/// guest-side system log file.
pub fn emit(level: &str, tag: &str, args: std::fmt::Arguments<'_>) {
    let line = format!("[{}] [{level}] [{tag}] {args}", timestamp());
    if let Err(e) = append_system_log_line(&line) {
        write_stderr_line(&format!(
            "[{}] [WARN] [sandbox:guest-common] failed to append system log: {e}",
            timestamp()
        ));
    }
    write_stderr_line(&line);
}

/// Log an info message to stderr.
#[macro_export]
macro_rules! log_info {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::emit("INFO", $tag, format_args!($($arg)*));
    };
}

/// Log a warning message to stderr.
#[macro_export]
macro_rules! log_warn {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::emit("WARN", $tag, format_args!($($arg)*));
    };
}

/// Log an error message to stderr.
#[macro_export]
macro_rules! log_error {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::emit("ERROR", $tag, format_args!($($arg)*));
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    static LOG_TEST_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn timestamp_is_rfc3339() {
        let ts = timestamp();
        // RFC3339 with millis: "2026-01-01T00:00:00.000Z"
        assert!(ts.ends_with('Z'), "timestamp should end with Z: {ts}");
        assert!(ts.contains('T'), "timestamp should contain T: {ts}");
        assert_eq!(ts.len(), 24, "unexpected timestamp length: {ts}");
        // Verify it parses as a valid datetime
        assert!(
            chrono::DateTime::parse_from_rfc3339(&ts).is_ok(),
            "not a valid RFC3339: {ts}"
        );
    }

    #[test]
    fn emit_appends_to_configured_system_log_file() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        set_system_log_file(&path);

        emit(
            "WARN",
            "sandbox:guest-agent",
            format_args!("Tool timeout {}", "WebFetch"),
        );

        clear_system_log_file();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(
            content.contains("[WARN] [sandbox:guest-agent] Tool timeout WebFetch"),
            "unexpected content: {content:?}"
        );
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn emit_continues_when_system_log_append_fails() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-parent").join("system.log");
        set_system_log_file(&path);

        emit(
            "WARN",
            "sandbox:guest-agent",
            format_args!("system log path is not writable"),
        );

        clear_system_log_file();
        assert!(
            !path.exists(),
            "test setup expected append to fail for missing parent dir",
        );
    }

    #[test]
    fn emit_appends_complete_lines_concurrently() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        set_system_log_file(&path);

        let handles: Vec<_> = (0..8)
            .map(|thread_id| {
                std::thread::spawn(move || {
                    for line_id in 0..20 {
                        append_system_log_line(&format!(
                            "[timestamp] [INFO] [sandbox:guest-agent] concurrent {thread_id}-{line_id}"
                        ))
                        .unwrap();
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }
        clear_system_log_file();

        let content = std::fs::read_to_string(path).unwrap();
        let lines: Vec<_> = content.lines().collect();
        assert_eq!(lines.len(), 160);
        assert!(content.ends_with('\n'));
        assert!(
            lines
                .iter()
                .all(|line| { line.contains("[INFO] [sandbox:guest-agent] concurrent ") })
        );
    }
}
