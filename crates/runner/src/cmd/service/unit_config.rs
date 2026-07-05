use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Parse the ExecStart line of a systemd unit file for a runner `--config` path.
pub(crate) async fn read_unit_config_path(unit_path: &Path) -> Option<PathBuf> {
    let mut content = tokio::fs::read_to_string(unit_path).await.ok()?;
    content.push_str(&read_unit_dropin_content(unit_path).await?);
    parse_unit_config_path(&content)
}

async fn read_unit_dropin_content(unit_path: &Path) -> Option<String> {
    let mut dir = OsString::from(unit_path.as_os_str());
    dir.push(".d");
    let dir = PathBuf::from(dir);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(String::new()),
        Err(_) => return None,
    };

    let mut paths = Vec::new();
    while let Some(entry) = entries.next_entry().await.ok()? {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "conf")
        {
            paths.push(path);
        }
    }
    paths.sort();

    let mut content = String::new();
    for path in paths {
        content.push('\n');
        content.push_str(&tokio::fs::read_to_string(path).await.ok()?);
    }
    Some(content)
}

pub(crate) fn parse_unit_config_path(content: &str) -> Option<PathBuf> {
    let mut config_path = None;
    for line in logical_unit_lines(content) {
        let trimmed = line.trim();
        let Some((key, rest)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() != "ExecStart" {
            continue;
        }
        if rest.trim().is_empty() {
            config_path = None;
            continue;
        }
        if let Some(next_config_path) = parse_exec_start_config(rest) {
            config_path = Some(next_config_path);
        }
    }
    config_path
}

fn logical_unit_lines(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut continued = String::new();
    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        if let Some(prefix) = line.strip_suffix('\\') {
            continued.push_str(prefix);
            continued.push(' ');
            continue;
        }

        if continued.is_empty() {
            lines.push(line.to_string());
        } else {
            continued.push_str(line.trim_start());
            lines.push(std::mem::take(&mut continued));
        }
    }

    if !continued.is_empty() {
        lines.push(continued);
    }

    lines
}

/// Extract the value following `--config` or `-c` from an `ExecStart` line body.
///
/// Handles both quoted (`--config "/path with spaces/f.yaml"`) and unquoted
/// (`--config /simple/path.yaml`) forms. Only the argument value is extracted.
pub(crate) fn parse_exec_start_config(line: &str) -> Option<PathBuf> {
    let tokens = tokenize_systemd_exec_start(line)?;
    for (idx, token) in tokens.iter().enumerate() {
        if token == "--config" || token == "-c" {
            if let Some(config_path) = tokens
                .get(idx + 1)
                .and_then(|value| config_path_from_arg(value))
            {
                return Some(config_path);
            }
            continue;
        }
        if let Some(value) = token
            .strip_prefix("--config=")
            .or_else(|| token.strip_prefix("-c="))
            .and_then(config_path_from_arg)
        {
            return Some(value);
        }
    }
    None
}

fn config_path_from_arg(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    Some(PathBuf::from(value))
}

fn tokenize_systemd_exec_start(input: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut chars = input.chars().peekable();
    let mut quote = None;
    let mut has_token = false;
    while let Some(ch) = chars.next() {
        if let Some(quote_char) = quote {
            match ch {
                ch if ch == quote_char => quote = None,
                '\\' => match chars.next() {
                    Some(next @ ('\\' | '"' | '\'')) => token.push(next),
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
                '"' | '\'' => {
                    quote = Some(ch);
                    has_token = true;
                }
                '\\' => {
                    has_token = true;
                    match chars.next() {
                        Some(next @ ('\\' | '"' | '\'')) => token.push(next),
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
    if quote.is_some() {
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
    fn parse_config_single_quoted_path_with_spaces() {
        let line = r#""/usr/bin/runner" start --config '/opt/my config/runner.yaml'"#;
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
    fn parse_config_skips_flag_value_before_valid_config() {
        let line = r#""/usr/bin/runner" start --config --local --config "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
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

    #[test]
    fn parse_unit_config_path_allows_space_before_equals() {
        let content = r#"
[Service]
ExecStart = "/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_handles_continued_exec_start() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start \
  --config "/etc/runner.yaml" \
  --local
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_honors_exec_start_reset() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/new-runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/new-runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_reset_without_replacement_returns_none() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
ExecStart=
"#;

        assert_eq!(parse_unit_config_path(content), None);
    }

    #[test]
    fn parse_unit_config_path_skips_unparseable_exec_start() {
        let content = r#"
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[tokio::test]
    async fn read_unit_config_path_applies_dropin_exec_start_override() {
        let dir = tempfile::tempdir().unwrap();
        let unit_path = dir.path().join("vm0-runner-v1.0.0.service");
        std::fs::write(
            &unit_path,
            r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
"#,
        )
        .unwrap();
        let dropin_dir = dir.path().join("vm0-runner-v1.0.0.service.d");
        std::fs::create_dir(&dropin_dir).unwrap();
        std::fs::write(
            dropin_dir.join("10-override.conf"),
            r#"
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/new-runner.yaml"
"#,
        )
        .unwrap();

        assert_eq!(
            read_unit_config_path(&unit_path).await,
            Some(PathBuf::from("/etc/new-runner.yaml"))
        );
    }
}
