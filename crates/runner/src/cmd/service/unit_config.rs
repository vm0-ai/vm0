use std::path::PathBuf;
use std::time::Duration;

use crate::error::RunnerResult;

use super::target::RunnerServiceUnit;

pub(super) const DEPLOYMENT_SOURCE_CONFIG_FLAG: &str = "--deployment-source-config";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RunnerUnitCommandPaths {
    executable_path: PathBuf,
    activation_config_path: PathBuf,
    deployment_source_config_path: Option<PathBuf>,
}

impl RunnerUnitCommandPaths {
    pub(crate) fn executable_path(&self) -> &std::path::Path {
        &self.executable_path
    }

    pub(crate) fn activation_config_path(&self) -> &std::path::Path {
        &self.activation_config_path
    }

    pub(crate) fn deployment_source_config_path(&self) -> Option<&std::path::Path> {
        self.deployment_source_config_path.as_deref()
    }
}

/// Read systemd's selected unit content and extract the exact Runner command paths.
pub(crate) async fn read_unit_command_paths(
    unit: &RunnerServiceUnit,
) -> RunnerResult<Option<RunnerUnitCommandPaths>> {
    let content = super::systemctl::cat_unit_content(unit).await?;
    Ok(parse_unit_command_paths(&content))
}

/// Read systemd's selected unit content and extract the runner `--config` path.
pub(crate) async fn read_unit_config_path(
    unit: &RunnerServiceUnit,
) -> RunnerResult<Option<PathBuf>> {
    let content = super::systemctl::cat_unit_content(unit).await?;
    Ok(parse_unit_config_path(&content))
}

pub(super) async fn read_unit_config_path_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<super::systemctl::BoundedSystemctlQuery<Option<PathBuf>>> {
    match super::systemctl::cat_unit_content_bounded(unit, duration).await? {
        super::systemctl::BoundedSystemctlQuery::Completed(content) => Ok(
            super::systemctl::BoundedSystemctlQuery::Completed(parse_unit_config_path(&content)),
        ),
        super::systemctl::BoundedSystemctlQuery::TimedOut => {
            Ok(super::systemctl::BoundedSystemctlQuery::TimedOut)
        }
    }
}

pub(crate) fn parse_unit_config_path(content: &str) -> Option<PathBuf> {
    parse_unit_exec_start(content, |line| Ok(parse_exec_start_config(line)))
}

pub(crate) fn parse_unit_command_paths(content: &str) -> Option<RunnerUnitCommandPaths> {
    parse_unit_exec_start(content, |line| {
        parse_exec_start_command_paths(line).map(Some).ok_or(())
    })
}

fn parse_unit_exec_start<T>(
    content: &str,
    parse: impl Fn(&str) -> Result<Option<T>, ()>,
) -> Option<T> {
    let mut value = None;
    let mut in_service_section = false;
    for line in logical_unit_lines(content) {
        let trimmed = line.trim();
        if let Some(section) = unit_section_name(trimmed) {
            in_service_section = section == "Service";
            continue;
        }
        if !in_service_section {
            continue;
        }
        let Some((key, rest)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() != "ExecStart" {
            continue;
        }
        if rest.trim().is_empty() {
            value = None;
            continue;
        }
        match parse(rest) {
            Ok(Some(next_value)) => value = Some(next_value),
            Ok(None) => {}
            Err(()) => return None,
        }
    }
    value
}

fn unit_section_name(line: &str) -> Option<&str> {
    let section = line.strip_prefix('[')?.strip_suffix(']')?;
    Some(section.trim())
}

fn logical_unit_lines(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut continued = String::new();
    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        let trimmed_start = line.trim_start();
        if !continued.is_empty()
            && (trimmed_start.is_empty()
                || trimmed_start.starts_with('#')
                || trimmed_start.starts_with(';'))
        {
            continue;
        }
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
    config_path_from_tokens(&tokens)
}

fn parse_exec_start_command_paths(line: &str) -> Option<RunnerUnitCommandPaths> {
    let tokens = tokenize_systemd_exec_start(line)?;
    let executable_path = tokens
        .first()
        .and_then(|value| command_path_from_arg(value))?;
    let activation_config_path = config_path_from_tokens(&tokens)?;
    let deployment_source_config_path = deployment_source_config_path_from_tokens(&tokens).ok()?;
    Some(RunnerUnitCommandPaths {
        executable_path,
        activation_config_path,
        deployment_source_config_path,
    })
}

fn deployment_source_config_path_from_tokens(tokens: &[String]) -> Result<Option<PathBuf>, ()> {
    let mut path = None;
    for (index, token) in tokens.iter().enumerate() {
        let value = if token == DEPLOYMENT_SOURCE_CONFIG_FLAG {
            Some(tokens.get(index + 1).ok_or(())?.as_str())
        } else {
            token
                .strip_prefix(DEPLOYMENT_SOURCE_CONFIG_FLAG)
                .and_then(|rest| rest.strip_prefix('='))
        };
        let Some(value) = value else {
            continue;
        };
        let next_path = config_path_from_arg(value).ok_or(())?;
        if path.replace(next_path).is_some() {
            return Err(());
        }
    }
    Ok(path)
}

fn config_path_from_tokens(tokens: &[String]) -> Option<PathBuf> {
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

fn command_path_from_arg(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    Some(PathBuf::from(value))
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
    use std::path::Path;

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
    fn parse_unit_command_paths_preserves_independent_exact_paths() {
        let content = r#"
[Service]
ExecStart="/var/lib/vm0-runner/bin/binary-blue/runner" start --config "/var/lib/vm0-runner/runners/config-green/runner.yaml"
"#;

        let paths = parse_unit_command_paths(content).unwrap();
        assert_eq!(
            paths.executable_path(),
            PathBuf::from("/var/lib/vm0-runner/bin/binary-blue/runner")
        );
        assert_eq!(
            paths.activation_config_path(),
            PathBuf::from("/var/lib/vm0-runner/runners/config-green/runner.yaml")
        );
        assert_eq!(paths.deployment_source_config_path(), None);
    }

    #[test]
    fn parse_unit_command_paths_reads_exact_deployment_source_config() {
        let content = r#"
[Service]
ExecStart="/var/lib/vm0-runner/bin/binary-blue/runner" start --config "/run/vm0/snapshots/runner.yaml" --deployment-source-config "/var/lib/vm0-runner/runners/config-green/runner.yaml"
"#;

        let paths = parse_unit_command_paths(content).unwrap();
        assert_eq!(
            paths.activation_config_path(),
            PathBuf::from("/run/vm0/snapshots/runner.yaml")
        );
        assert_eq!(
            paths.deployment_source_config_path(),
            Some(Path::new(
                "/var/lib/vm0-runner/runners/config-green/runner.yaml"
            ))
        );
    }

    #[test]
    fn parse_unit_command_paths_rejects_ambiguous_deployment_source_config() {
        let content = r#"
[Service]
ExecStart="/var/lib/vm0-runner/bin/binary-blue/runner" start --config "/run/vm0/snapshots/runner.yaml" --deployment-source-config "/first/runner.yaml" --deployment-source-config "/second/runner.yaml"
"#;

        assert_eq!(parse_unit_command_paths(content), None);
    }

    #[test]
    fn parse_unit_command_paths_does_not_fall_back_past_malformed_override() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/run/base.yaml" --deployment-source-config "/source/base.yaml"
ExecStart="/usr/bin/runner" start --config "/run/override.yaml" --deployment-source-config "/source/first.yaml" --deployment-source-config "/source/second.yaml"
"#;

        assert_eq!(parse_unit_command_paths(content), None);
        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/run/override.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_does_not_require_supported_executable_syntax() {
        let content = r#"
[Service]
ExecStart=-/usr/bin/runner start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
        assert_eq!(parse_unit_command_paths(content), None);
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
    fn parse_unit_config_path_ignores_exec_start_outside_service_section() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"

[Unit]
ExecStart="/usr/bin/runner" start --config "/etc/wrong-runner.yaml"
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
    fn parse_unit_config_path_continues_past_comment_lines() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start \
  # comment between continued lines
  ; another comment
  --config "/etc/runner.yaml"
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

    #[test]
    fn parse_unit_config_path_applies_systemd_selected_content_in_order() {
        let content = r#"
# /etc/systemd/system/vm0-runner-v1.0.0.service
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/base-runner.yaml"

# /usr/lib/systemd/system/vm0-runner-.service.d/10-vendor.conf
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/vendor-runner.yaml"

# /run/systemd/system/vm0-runner-v1.0.0.service.d/20-runtime.conf
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/runtime-runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runtime-runner.yaml"))
        );
    }
}
