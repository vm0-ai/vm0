//! Logging utilities for VM scripts.

/// Get current timestamp in RFC3339 format with milliseconds.
pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Log an info message to stderr.
#[macro_export]
macro_rules! log_info {
    ($tag:expr, $($arg:tt)*) => {
        eprintln!("[{}] [INFO] [{}] {}", $crate::log::timestamp(), $tag, format!($($arg)*));
    };
}

/// Log a warning message to stderr.
#[macro_export]
macro_rules! log_warn {
    ($tag:expr, $($arg:tt)*) => {
        eprintln!("[{}] [WARN] [{}] {}", $crate::log::timestamp(), $tag, format!($($arg)*));
    };
}

/// Log an error message to stderr.
#[macro_export]
macro_rules! log_error {
    ($tag:expr, $($arg:tt)*) => {
        eprintln!("[{}] [ERROR] [{}] {}", $crate::log::timestamp(), $tag, format!($($arg)*));
    };
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
