//! Retained CLI stderr diagnostic policy.
//!
//! These values are shared by the guest-agent collector and its integration
//! fixtures so runtime behavior and boundary payloads stay in lockstep.

/// Maximum number of CLI stderr lines retained in the diagnostic tail.
pub const CLI_STDERR_RESULT_MAX_LINES: usize = 200;

/// Maximum raw byte length retained for one CLI stderr diagnostic line.
///
/// LF is excluded. A preceding CR is stripped before measuring a CRLF-terminated
/// line, while a lone CR in an EOF-terminated final line counts toward the limit.
pub const CLI_STDERR_RESULT_MAX_LINE_BYTES: usize = 16 * 1024;

/// Replacement for a CLI stderr line that exceeds the diagnostic byte limit.
pub const CLI_STDERR_OMITTED_LONG_LINE: &str =
    "[stderr line omitted: exceeded diagnostic size limit]";
