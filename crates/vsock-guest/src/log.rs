//! Lightweight stderr logging for the vsock guest process.

/// Logs a message to stderr.
///
/// The logger writes one line in the form `[vsock-guest] [{level}] {msg}`.
/// `level` is passed through as a free-form label without validation or
/// normalization; current call sites conventionally use `INFO`, `WARN`, and
/// `ERROR`.
///
/// `msg` is written as provided, and the trailing line break is added by this
/// function. Callers that need one physical log line should avoid embedding
/// newlines in `msg`.
pub fn log(level: &str, msg: &str) {
    eprintln!("[vsock-guest] [{level}] {msg}");
}
