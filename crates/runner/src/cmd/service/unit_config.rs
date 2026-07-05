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
    let tokens = tokenize_systemd_exec_start(line)?;
    for (idx, token) in tokens.iter().enumerate() {
        if token == "--config" || token == "-c" {
            let value = tokens.get(idx + 1)?;
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
            continue;
        }
        if let Some(value) = token
            .strip_prefix("--config=")
            .or_else(|| token.strip_prefix("-c="))
            && !value.is_empty()
        {
            return Some(PathBuf::from(value));
        }
    }
    None
}

fn tokenize_systemd_exec_start(input: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut chars = input.chars().peekable();
    let mut in_quote = false;
    let mut has_token = false;
    while let Some(ch) = chars.next() {
        if in_quote {
            match ch {
                '"' => in_quote = false,
                '\\' => match chars.next() {
                    Some(next @ ('\\' | '"')) => token.push(next),
                    Some(next) => {
                        token.push('\\');
                        token.push(next);
                    }
                    None => return None,
                },
                '%' if chars.peek() == Some(&'%') => {
                    chars.next();
                    token.push('%');
                }
                '%' => token.push('%'),
                _ => token.push(ch),
            }
        } else {
            match ch {
                ch if ch.is_ascii_whitespace() => {
                    if has_token {
                        tokens.push(std::mem::take(&mut token));
                        has_token = false;
                    }
                }
                '"' => {
                    in_quote = true;
                    has_token = true;
                }
                '\\' => {
                    has_token = true;
                    match chars.next() {
                        Some(next @ ('\\' | '"')) => token.push(next),
                        Some(next) => {
                            token.push('\\');
                            token.push(next);
                        }
                        None => token.push('\\'),
                    }
                }
                '%' if chars.peek() == Some(&'%') => {
                    chars.next();
                    token.push('%');
                    has_token = true;
                }
                '%' => {
                    token.push('%');
                    has_token = true;
                }
                _ => {
                    token.push(ch);
                    has_token = true;
                }
            }
        }
    }
    if in_quote {
        return None;
    }
    if has_token {
        tokens.push(token);
    }
    Some(tokens)
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
    fn parse_config_ignores_flag_token_inside_quoted_exe_path() {
        let line = r#""/opt/my --config fake/runner" start --config "/data/runner.yaml""#;
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
