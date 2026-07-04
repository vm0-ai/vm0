use std::path::{Path, PathBuf};

/// Parse the ExecStart line of a systemd unit file for a runner `--config` path.
pub(crate) async fn read_unit_config_path(unit_path: &Path) -> Option<PathBuf> {
    let content = tokio::fs::read_to_string(unit_path).await.ok()?;
    parse_unit_config_path(&content)
}

pub(crate) fn parse_unit_config_path(content: &str) -> Option<PathBuf> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("ExecStart=") {
            return parse_exec_start_config(rest);
        }
    }
    None
}

/// Extract the value following `--config` or `-c` from an `ExecStart` line body.
///
/// Handles both quoted (`--config "/path with spaces/f.yaml"`) and unquoted
/// (`--config /simple/path.yaml`) forms. Only the argument value is extracted.
pub(crate) fn parse_exec_start_config(line: &str) -> Option<PathBuf> {
    extract_flag_value(line, "--config").or_else(|| extract_flag_value(line, "-c"))
}

/// Find `flag` in `line` as a standalone token, then return the next
/// whitespace-delimited or quote-delimited value after it.
///
/// Supports both `--config /path` and `--config=/path` forms.
fn extract_flag_value(line: &str, flag: &str) -> Option<PathBuf> {
    let idx = line
        .match_indices(flag)
        .find(|&(i, _)| {
            let before_ok = i == 0
                || line
                    .as_bytes()
                    .get(i - 1)
                    .is_some_and(|b| b.is_ascii_whitespace());
            let after_ok = line
                .as_bytes()
                .get(i + flag.len())
                .is_none_or(|b| b.is_ascii_whitespace() || b == &b'=');
            before_ok && after_ok
        })?
        .0;
    let after = line.get(idx + flag.len()..)?;
    let after = after.strip_prefix('=').unwrap_or(after).trim_ascii_start();
    if after.is_empty() {
        return None;
    }
    let path = if after.starts_with('"') {
        parse_quoted_systemd_value(after.get(1..)?)?
    } else {
        let end = after
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(after.len());
        unescape_systemd_value(after.get(..end)?)
    };
    Some(PathBuf::from(path))
}

fn parse_quoted_systemd_value(input: &str) -> Option<String> {
    let mut value = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(value),
            '\\' => match chars.next() {
                Some(next @ ('\\' | '"')) => value.push(next),
                Some(next) => {
                    value.push('\\');
                    value.push(next);
                }
                None => return None,
            },
            '%' if chars.peek() == Some(&'%') => {
                chars.next();
                value.push('%');
            }
            '%' => value.push('%'),
            _ => value.push(ch),
        }
    }
    None
}

fn unescape_systemd_value(input: &str) -> String {
    let mut value = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some(next @ ('\\' | '"')) => value.push(next),
                Some(next) => {
                    value.push('\\');
                    value.push(next);
                }
                None => value.push('\\'),
            },
            '%' if chars.peek() == Some(&'%') => {
                chars.next();
                value.push('%');
            }
            '%' => value.push('%'),
            _ => value.push(ch),
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_config_plain_path() {
        let line = r#""/usr/bin/runner" start --config /data/runner.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_quoted_path_with_spaces() {
        let line = r#""/opt/my runner/vm0-runner" start --config "/opt/my config/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/opt/my config/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_quoted_path_with_escaped_characters() {
        let line = r#""/usr/bin/runner" start --config "/tmp/a\"b\\c%%d.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from(r#"/tmp/a"b\c%d.yaml"#))
        );
    }

    #[test]
    fn parse_config_quoted_path_without_spaces() {
        let line = r#""/usr/bin/runner" start --config "/etc/runner.yaml" --local"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_short_flag() {
        let line = r#""/usr/bin/runner" start -c "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_missing_flag() {
        let line = r#""/usr/bin/runner" start --local"#;
        assert_eq!(parse_exec_start_config(line), None);
    }

    #[test]
    fn parse_config_flag_at_end_without_value() {
        let line = r#""/usr/bin/runner" start --config"#;
        assert_eq!(parse_exec_start_config(line), None);
    }

    #[test]
    fn parse_config_equals_form() {
        let line = r#""/usr/bin/runner" start --config=/data/runner.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_equals_form_quoted() {
        let line = r#""/usr/bin/runner" start --config="/data/my config/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/my config/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_equals_form_unescapes_percent() {
        let line = r#""/usr/bin/runner" start --config=/data/runner%%config.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner%config.yaml"))
        );
    }

    #[test]
    fn parse_config_ignores_flag_substring_in_exe_path() {
        let line = r#""/opt/nice-cli/runner" start -c "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_unclosed_quote_returns_none() {
        let line = r#""/usr/bin/runner" start --config "/data/no-close"#;
        assert_eq!(parse_exec_start_config(line), None);
    }

    #[test]
    fn parse_config_tab_separated() {
        let line = "\"/usr/bin/runner\" start --config\t/data/runner.yaml";
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_short_flag_equals_form() {
        let line = r#""/usr/bin/runner" start -c=/data/runner.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_reads_first_exec_start() {
        let content = r#"
[Unit]
Description=runner

[Service]
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }
}
