//! Constants.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Heartbeat interval in seconds.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 60;

/// Telemetry upload interval in seconds.
pub const TELEMETRY_INTERVAL_SECS: u64 = 30;

/// Metrics collection interval in seconds.
pub const METRICS_INTERVAL_SECS: u64 = 5;

/// Max HTTP retries for webhook calls.
pub const HTTP_MAX_RETRIES: u32 = 3;

/// HTTP connect timeout in seconds.
pub const HTTP_CONNECT_TIMEOUT_SECS: u64 = 10;

/// HTTP request timeout in seconds.
pub const HTTP_TIMEOUT_SECS: u64 = 30;

/// HTTP request timeout for uploads in seconds.
pub const HTTP_UPLOAD_TIMEOUT_SECS: u64 = 60;
