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
