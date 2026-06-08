use serde_json::Value;

const ECHO_MARKER: &str = "@ECHO@";

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum MockScenario<'a> {
    EchoJsonl(&'a str),
    FailNoNewline(&'a str),
    FailInvalidUtf8,
    FailInvalidUtf8Long,
    Fail(&'a str),
    StuckTool { deaf: bool, close_stdout: bool },
    OrphanPipe,
    HangAfterResult { deaf: bool },
    ExitAfterResult,
    WriteEnvJson(&'a str),
    Shell,
}

impl<'a> MockScenario<'a> {
    pub(crate) fn from_prompt(prompt: &'a str) -> Self {
        if let Some(payload) = echo_jsonl_payload(prompt) {
            return Self::EchoJsonl(payload);
        }
        if let Some(msg) = prompt.strip_prefix("@fail-no-newline:") {
            return Self::FailNoNewline(msg);
        }
        if prompt == "@fail-invalid-utf8" {
            return Self::FailInvalidUtf8;
        }
        if prompt == "@fail-invalid-utf8-long" {
            return Self::FailInvalidUtf8Long;
        }
        if let Some(msg) = prompt.strip_prefix("@fail:") {
            return Self::Fail(msg);
        }
        if prompt.starts_with("@stuck-tool-closed-stdout-deaf") {
            return Self::StuckTool {
                deaf: true,
                close_stdout: true,
            };
        }
        if prompt.starts_with("@stuck-tool-deaf") {
            return Self::StuckTool {
                deaf: true,
                close_stdout: false,
            };
        }
        if prompt.starts_with("@stuck-tool") {
            return Self::StuckTool {
                deaf: false,
                close_stdout: false,
            };
        }
        if prompt.starts_with("@orphan-pipe") {
            return Self::OrphanPipe;
        }
        if prompt.starts_with("@hang-after-result-deaf") {
            return Self::HangAfterResult { deaf: true };
        }
        if prompt.starts_with("@exit-after-result") {
            return Self::ExitAfterResult;
        }
        if let Some(path) = prompt.strip_prefix("@write-env-json:") {
            return Self::WriteEnvJson(path);
        }
        if prompt.starts_with("@hang-after-result") {
            return Self::HangAfterResult { deaf: false };
        }
        Self::Shell
    }
}

fn echo_jsonl_payload(prompt: &str) -> Option<&str> {
    let (first_line, payload) = prompt.split_once('\n').unwrap_or((prompt, ""));
    if first_line.trim_end_matches('\r') == ECHO_MARKER {
        return Some(payload);
    }
    None
}

pub(crate) fn parse_echo_jsonl(payload: &str) -> Result<Vec<(String, Value)>, String> {
    let mut events = Vec::new();
    for (index, line) in payload.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str::<Value>(line)
            .map_err(|e| format!("invalid @ECHO@ JSONL line {}: {e}", index + 2))?;
        events.push((line.to_string(), event));
    }

    if events.is_empty() {
        return Err("@ECHO@ payload must contain at least one JSONL event".to_string());
    }

    Ok(events)
}

pub(crate) fn echo_session_id(events: &[(String, Value)]) -> Option<&str> {
    events.iter().find_map(|(_, event)| {
        let event_type = event.get("type").and_then(Value::as_str)?;
        let subtype = event.get("subtype").and_then(Value::as_str)?;
        if event_type != "system" || subtype != "init" {
            return None;
        }
        event.get("session_id").and_then(Value::as_str)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_hang_after_result_variants() {
        assert_eq!(
            MockScenario::from_prompt("@hang-after-result-deaf"),
            MockScenario::HangAfterResult { deaf: true }
        );
        assert_eq!(
            MockScenario::from_prompt("@hang-after-result"),
            MockScenario::HangAfterResult { deaf: false }
        );
    }

    #[test]
    fn classifies_stuck_tool_variants() {
        assert_eq!(
            MockScenario::from_prompt("@stuck-tool"),
            MockScenario::StuckTool {
                deaf: false,
                close_stdout: false
            }
        );
        assert_eq!(
            MockScenario::from_prompt("@stuck-tool-deaf"),
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: false
            }
        );
        assert_eq!(
            MockScenario::from_prompt("@stuck-tool-closed-stdout-deaf"),
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: true
            }
        );
    }

    #[test]
    fn classifies_ordinary_prompt_as_shell() {
        assert_eq!(MockScenario::from_prompt("echo hello"), MockScenario::Shell);
    }

    #[test]
    fn classifies_echo_jsonl_when_first_line_is_marker() {
        assert_eq!(
            MockScenario::from_prompt("@ECHO@\n{\"type\":\"result\"}"),
            MockScenario::EchoJsonl("{\"type\":\"result\"}")
        );
    }

    #[test]
    fn classifies_echo_jsonl_with_crlf_marker() {
        assert_eq!(
            MockScenario::from_prompt("@ECHO@\r\n{\"type\":\"result\"}"),
            MockScenario::EchoJsonl("{\"type\":\"result\"}")
        );
    }

    #[test]
    fn does_not_classify_marker_with_extra_text_as_echo_jsonl() {
        assert_eq!(
            MockScenario::from_prompt("@ECHO@ please\n{\"type\":\"result\"}"),
            MockScenario::Shell
        );
    }

    #[test]
    fn parses_echo_jsonl_non_empty_lines() {
        let events =
            parse_echo_jsonl(r#"{"type":"system","subtype":"init","session_id":"preview-1"}"#)
                .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["type"], "system");
    }

    #[test]
    fn rejects_invalid_echo_jsonl() {
        let err = parse_echo_jsonl(r#"{"type":"system""#).unwrap_err();
        assert!(err.contains("invalid @ECHO@ JSONL line 2"));
    }

    #[test]
    fn rejects_empty_echo_jsonl_payload() {
        let err = parse_echo_jsonl("\n\n").unwrap_err();
        assert_eq!(err, "@ECHO@ payload must contain at least one JSONL event");
    }
}
