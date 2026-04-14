//! Validation for runner instance names.
//!
//! The same name is used as both a directory name (joined against
//! `HomePaths::runners_dir()`) and a systemd service name suffix
//! (e.g. `vm0-runner-<name>`). This module is the single source of
//! truth for what counts as a valid runner instance name.
//!
//! Without validation, an absolute path (`/etc`) replaces the base via
//! `Path::join`, and a bare `..` segment escapes once the kernel resolves
//! it.
//!
//! Unlike `group` and `profile`, runner directory names are not persisted
//! in `runner.yaml` (only the resolved `RunnerConfig.base_dir: PathBuf`
//! is). Validation therefore happens once at the CLI boundary in
//! `runner config`; there is no config-load checkpoint to mirror.
//!
//! No matching server-side schema exists — runner directory names are
//! purely a runner-local concern.

use crate::error::{RunnerError, RunnerResult};

/// Validate `name` and return a `RunnerError::Config` with a uniform
/// message if it fails. Use this at every callsite that takes a runner
/// directory name from the user (currently only the `--runner-dirname`
/// flag of `runner config`) so the error wording stays consistent.
pub fn validate_or_err(name: &str) -> RunnerResult<()> {
    if !validate_name(name) {
        return Err(RunnerError::Config(format!(
            "invalid runner-dirname: {name} (must be a non-empty single path segment \
             of lowercase alphanumeric, hyphens, and dots; cannot start with `.` or `-`)"
        )));
    }
    Ok(())
}

/// Validate that `name` is a safe runner instance identifier.
///
/// Used for both runner directory names and systemd service name suffixes
/// to ensure a single validation rule across the codebase.
///
/// Accepts `[a-z0-9.-]+` with these guards:
/// - non-empty
/// - does not start with `.` (rejects `.`, `..`, and hidden-file forms)
/// - does not start with `-` (avoids being parsed as a flag downstream)
///
/// Implicitly rejects `/` and `\` (neither is in the charset), keeping the
/// name to a single path segment regardless of the host's separator
/// conventions. The dot allowance exists for production semver dirnames
/// produced by `ansible/playbooks/deploy-runner.yml` (e.g. `v0.3.0`).
pub(crate) fn validate_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('.') || name.starts_with('-') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_valid() {
        // All values currently in use across ansible/scripts/CI.
        assert!(validate_name("v0.3.0")); // ansible production semver
        assert!(validate_name("v1.10.1"));
        assert!(validate_name("local-alice-macbook")); // dev-runner.sh
        assert!(validate_name("alice-macbook"));
        assert!(validate_name("pr-1234-test")); // CI workflows
        assert!(validate_name("pr-1234-bench"));
        assert!(validate_name("staging-test"));
        assert!(validate_name("staging-test-balloon"));
        assert!(validate_name("a")); // minimal
    }

    /// The validator intentionally accepts some filename shapes that look
    /// unusual but don't enable path traversal on Linux. Lock in the
    /// contract so future tightening is an explicit decision, not a silent
    /// regression.
    #[test]
    fn validate_name_valid_unusual_shapes() {
        assert!(validate_name("foo-")); // trailing hyphen
        assert!(validate_name("foo.")); // trailing dot
        assert!(validate_name("foo--bar")); // consecutive hyphens
        assert!(validate_name("foo..bar")); // consecutive dots (NOT traversal — no `/`)
        assert!(validate_name("vm0..0")); // near-traversal shape, still safe
        assert!(validate_name("0")); // single digit
    }

    #[test]
    fn validate_name_invalid_shape() {
        assert!(!validate_name(""));
        assert!(!validate_name("."));
        assert!(!validate_name(".."));
    }

    #[test]
    fn validate_name_rejects_leading_dot_or_hyphen() {
        assert!(!validate_name(".hidden"));
        assert!(!validate_name(".env"));
        assert!(!validate_name("-flag"));
        assert!(!validate_name("-v0.3.0"));
        // These look like traversal attempts but are rejected via the
        // leading-dot rule — lock in that the rule catches them.
        assert!(!validate_name("..."));
        assert!(!validate_name("..foo"));
    }

    #[test]
    fn validate_name_invalid_chars() {
        assert!(!validate_name("V0.3.0")); // uppercase
        assert!(!validate_name("v0.3.0_dev")); // underscore
        assert!(!validate_name("v0 3 0")); // space
        assert!(!validate_name("v0.3.0!")); // punctuation
    }

    /// Security-sensitive inputs that are rejected by the charset check
    /// rather than by a dedicated rule. If someone later relaxes the
    /// charset (e.g. switches to `is_alphanumeric` which is Unicode-aware),
    /// these assertions surface the behavior change immediately.
    #[test]
    fn validate_name_rejects_injection_and_unicode() {
        assert!(!validate_name("foo\0bar")); // NUL byte
        assert!(!validate_name("foo\nbar")); // newline (log/header injection)
        assert!(!validate_name("foo\r\nbar")); // CRLF
        assert!(!validate_name("foo\tbar")); // tab
        assert!(!validate_name("v日本0")); // non-ASCII
        assert!(!validate_name("vm0\u{200B}prod")); // zero-width space
        assert!(!validate_name("vm0\u{2010}prod")); // Unicode hyphen lookalike
    }

    #[test]
    fn validate_name_rejects_path_traversal() {
        // The security-relevant cases the validator exists to block.
        assert!(!validate_name("/etc"));
        assert!(!validate_name("/etc/passwd"));
        assert!(!validate_name("../etc"));
        assert!(!validate_name("../../tmp"));
        assert!(!validate_name("foo/bar"));
        assert!(!validate_name(r"foo\bar"));
    }

    #[test]
    fn validate_or_err_passes_for_valid_name() {
        assert!(validate_or_err("v0.3.0").is_ok());
    }

    #[test]
    fn validate_or_err_carries_offending_name_in_message() {
        let err = validate_or_err("/etc").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
        assert!(msg.contains("/etc"), "got: {msg}");
    }

    /// Empty input renders the `{name}` placeholder as blank in the error
    /// message, so the generic "cannot start with `.` or `-`" hint does
    /// not apply. Lock in that the message explicitly calls out the
    /// non-empty requirement so empty-string bugs surface clearly.
    #[test]
    fn validate_or_err_empty_message_hints_non_empty() {
        let err = validate_or_err("").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("non-empty"), "got: {msg}");
    }
}
