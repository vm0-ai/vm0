use sandbox::{ExecResult, ProcessTerminationKind};

pub(crate) const HELPER_EXEC_OUTPUT_EXCERPT_BYTES: usize = 8 * 1024;

pub(crate) fn helper_exec_succeeded(result: &ExecResult) -> bool {
    result.termination == ProcessTerminationKind::Exited && result.exit_code == 0
}

pub(crate) fn helper_exec_termination_label(result: &ExecResult) -> &'static str {
    match result.termination {
        ProcessTerminationKind::Exited => "exited",
        ProcessTerminationKind::TimedOut => "timed_out",
        ProcessTerminationKind::Cancelled => "cancelled",
        ProcessTerminationKind::StartFailed => "start_failed",
        ProcessTerminationKind::WaitFailed => "wait_failed",
    }
}

pub(crate) fn format_helper_exec_failure(operation: &str, result: &ExecResult) -> String {
    let mut message = match result.termination {
        ProcessTerminationKind::Exited => {
            format!("{operation} failed (exit code {})", result.exit_code)
        }
        ProcessTerminationKind::TimedOut => format!(
            "{operation} failed (timed out; compatibility exit code {})",
            result.exit_code
        ),
        ProcessTerminationKind::Cancelled => format!(
            "{operation} failed (cancelled; compatibility exit code {})",
            result.exit_code
        ),
        ProcessTerminationKind::StartFailed => format!(
            "{operation} failed (start failed; compatibility exit code {})",
            result.exit_code
        ),
        ProcessTerminationKind::WaitFailed => format!(
            "{operation} failed (wait failed; compatibility exit code {})",
            result.exit_code
        ),
    };

    if let Some(stderr) =
        format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated)
    {
        message.push_str("; ");
        message.push_str(&stderr);
    }
    if let Some(stdout) =
        format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated)
    {
        message.push_str("; ");
        message.push_str(&stdout);
    }

    message
}

pub(crate) fn format_command_output_excerpt(
    label: &str,
    bytes: &[u8],
    sandbox_truncated: bool,
) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    // Redact before excerpting so a suffix cannot start inside a URL query and expose it.
    let output = String::from_utf8_lossy(bytes);
    let output = sanitize_command_output_for_diagnostic(output.trim());
    let output = output.trim();
    let (excerpt, omitted_prefix) = diagnostic_output_excerpt(output);
    let excerpt = excerpt.trim();
    if excerpt.is_empty() {
        return None;
    }

    let mut qualifiers = Vec::new();
    if omitted_prefix {
        qualifiers.push("last 8192 bytes");
    } else {
        qualifiers.push("captured");
    }
    if sandbox_truncated {
        qualifiers.push("sandbox-truncated");
    }

    Some(format!("{label} ({}): {excerpt}", qualifiers.join(", ")))
}

fn diagnostic_output_excerpt(input: &str) -> (&str, bool) {
    if input.len() <= HELPER_EXEC_OUTPUT_EXCERPT_BYTES {
        return (input, false);
    }

    let mut start = input.len() - HELPER_EXEC_OUTPUT_EXCERPT_BYTES;
    while !input.is_char_boundary(start) {
        start += 1;
    }
    (&input[start..], true)
}

fn sanitize_command_output_for_diagnostic(input: &str) -> String {
    redact_url_query_strings(input)
}

fn redact_url_query_strings(input: &str) -> String {
    let mut redacted = String::with_capacity(input.len());
    let mut cursor = 0;

    while cursor < input.len() {
        let Some(scheme) = url_scheme_at(input, cursor) else {
            let Some(ch) = input[cursor..].chars().next() else {
                break;
            };
            redacted.push(ch);
            cursor += ch.len_utf8();
            continue;
        };

        let url_start = cursor;
        let url_body_start = url_start + scheme.len();
        let url_end = find_url_token_end(input, url_body_start);
        let Some(query_offset) = input[url_body_start..url_end].find('?') else {
            redacted.push_str(&input[url_start..url_end]);
            cursor = url_end;
            continue;
        };

        let query_start = url_body_start + query_offset;
        let query_value_start = query_start + '?'.len_utf8();
        redacted.push_str(&input[url_start..query_value_start]);
        redacted.push_str("<redacted>");
        cursor = url_end;
    }

    redacted.push_str(&input[cursor..]);
    redacted
}

fn url_scheme_at(input: &str, index: usize) -> Option<&'static str> {
    ["https://", "http://"].into_iter().find(|scheme| {
        input[index..]
            .get(..scheme.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(scheme))
    })
}

fn find_url_token_end(input: &str, start: usize) -> usize {
    input[start..]
        .char_indices()
        .find_map(|(index, ch)| ch.is_whitespace().then_some(start + index))
        .unwrap_or(input.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec_result(termination: ProcessTerminationKind, exit_code: i32) -> ExecResult {
        ExecResult {
            termination,
            exit_code,
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    #[test]
    fn helper_exec_success_requires_exited_zero() {
        assert!(helper_exec_succeeded(&exec_result(
            ProcessTerminationKind::Exited,
            0,
        )));
        assert!(!helper_exec_succeeded(&exec_result(
            ProcessTerminationKind::Exited,
            1,
        )));
        assert!(!helper_exec_succeeded(&exec_result(
            ProcessTerminationKind::TimedOut,
            0,
        )));
        assert!(!helper_exec_succeeded(&exec_result(
            ProcessTerminationKind::Cancelled,
            0,
        )));
        assert!(!helper_exec_succeeded(&exec_result(
            ProcessTerminationKind::StartFailed,
            0,
        )));
        assert!(!helper_exec_succeeded(&exec_result(
            ProcessTerminationKind::WaitFailed,
            0,
        )));
    }

    #[test]
    fn exited_failure_keeps_exit_code_wording() {
        let result = exec_result(ProcessTerminationKind::Exited, 2);

        let message = format_helper_exec_failure("guest clock sync", &result);

        assert_eq!(message, "guest clock sync failed (exit code 2)");
    }

    #[test]
    fn terminal_state_failures_include_compatibility_exit_code() {
        for (termination, expected) in [
            (
                ProcessTerminationKind::TimedOut,
                "storage download failed (timed out; compatibility exit code 124)",
            ),
            (
                ProcessTerminationKind::Cancelled,
                "storage download failed (cancelled; compatibility exit code 1)",
            ),
            (
                ProcessTerminationKind::StartFailed,
                "storage download failed (start failed; compatibility exit code 1)",
            ),
            (
                ProcessTerminationKind::WaitFailed,
                "storage download failed (wait failed; compatibility exit code 1)",
            ),
        ] {
            let exit_code = if termination == ProcessTerminationKind::TimedOut {
                124
            } else {
                1
            };
            let result = exec_result(termination, exit_code);

            assert_eq!(
                format_helper_exec_failure("storage download", &result),
                expected
            );
        }
    }

    #[test]
    fn failure_formatting_preserves_excerpts_and_truncation_markers() {
        let mut result = exec_result(ProcessTerminationKind::TimedOut, 124);
        result.stdout = b"stdout clue".to_vec();
        result.stderr = b"stderr clue".to_vec();
        result.stderr_truncated = true;

        let message = format_helper_exec_failure("storage download", &result);

        assert!(message.contains("storage download failed (timed out"));
        assert!(message.contains("stderr (captured, sandbox-truncated): stderr clue"));
        assert!(message.contains("stdout (captured): stdout clue"));
    }

    #[test]
    fn command_output_redaction_handles_urls_before_excerpting() {
        let prefix = "archiveUrl=https://storage.example/archive.tar.gz?";
        let secret = "X-Amz-Signature=secret-value-that-must-not-leak";
        let padding_len =
            HELPER_EXEC_OUTPUT_EXCERPT_BYTES + "X-Amz-".len() - secret.len() - " done".len();
        let output = format!("{prefix}{secret}{} done", "a".repeat(padding_len));

        let excerpt = format_command_output_excerpt("stderr", output.as_bytes(), false).unwrap();

        assert!(excerpt.contains("archive.tar.gz?<redacted>"));
        assert!(!excerpt.contains("X-Amz-Signature"));
        assert!(!excerpt.contains("secret-value-that-must-not-leak"));
    }

    #[test]
    fn termination_label_is_stable_for_logs() {
        assert_eq!(
            helper_exec_termination_label(&exec_result(ProcessTerminationKind::Exited, 0)),
            "exited"
        );
        assert_eq!(
            helper_exec_termination_label(&exec_result(ProcessTerminationKind::TimedOut, 124)),
            "timed_out"
        );
        assert_eq!(
            helper_exec_termination_label(&exec_result(ProcessTerminationKind::Cancelled, 1)),
            "cancelled"
        );
        assert_eq!(
            helper_exec_termination_label(&exec_result(ProcessTerminationKind::StartFailed, 1)),
            "start_failed"
        );
        assert_eq!(
            helper_exec_termination_label(&exec_result(ProcessTerminationKind::WaitFailed, 1)),
            "wait_failed"
        );
    }
}
