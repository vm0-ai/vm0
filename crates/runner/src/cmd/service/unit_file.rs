use std::ffi::OsString;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{RunnerError, RunnerResult};

use super::target::RunnerServiceUnit;

const UNIT_STAGING_MARKER: &str = ".tmp@";
const UNIT_STAGING_MAX_ATTEMPTS: u64 = 32;
// Older runner binaries created dot-UUID staging files without holding the
// service lock, so only age them out after the rolling-upgrade window.
const LEGACY_UNIT_STAGING_MIN_AGE: Duration = Duration::from_secs(10 * 60);
#[cfg(unix)]
const UNIT_FILE_MODE: u32 = 0o600;
static UNIT_STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Resolve a config path to an absolute path.
pub(super) fn resolve_config_path(path: &Path) -> RunnerResult<PathBuf> {
    std::fs::canonicalize(path).map_err(|e| {
        RunnerError::Config(format!(
            "cannot resolve config path {}: {e}",
            path.display()
        ))
    })
}

/// Escape a string for use inside a double-quoted systemd value.
///
/// Three characters need escaping:
/// - `\` and `"`: required by systemd's quoted-string syntax; without
///   escape, the closing `"` is misparsed and the unit file is corrupted.
/// - `%`: systemd performs **specifier expansion** on directive values
///   (`%H` → hostname, `%n` → unit name, `%i` → instance, etc.), so an
///   unescaped `%` followed by a specifier letter gets silently rewritten.
///   `%%` is the literal-`%` escape and is safe across all systemd versions.
///
/// Single-pass iteration intentionally avoids chained `replace` calls:
/// the previous `\\` → `"` order was a hidden contract that future
/// additions to this set could easily get wrong.
fn escape_systemd_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out
}

/// Generate the systemd unit file content.
///
/// User-controllable values (`ExecStart=` paths, `Environment=` values) go
/// through [`escape_systemd_value`] so that input cannot break out of the
/// quotes or trigger systemd specifier expansion. `unit` is not escaped
/// because [`RunnerServiceUnit`] already restricts it to lowercase alphanumeric,
/// hyphens, and dots — no `%`, `\`, `"`, or other systemd special chars
/// can reach `Description=` or `SyslogIdentifier=`.
pub(super) fn generate_unit_file(
    unit: &RunnerServiceUnit,
    exe_path: &Path,
    config_path: &Path,
    env_vars: &[String],
    local: bool,
) -> String {
    let mut env_lines = String::new();
    for entry in env_vars {
        let escaped = escape_systemd_value(entry);
        env_lines.push_str(&format!("Environment=\"{escaped}\"\n"));
    }
    let local_flag = if local { " --local" } else { "" };
    let exe = escape_systemd_value(&exe_path.display().to_string());
    let config = escape_systemd_value(&config_path.display().to_string());
    let unit_name = unit.unit_name();
    format!(
        "\
[Unit]
Description=VM0 Runner ({unit_name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=\"{exe}\" start --config \"{config}\"{local_flag}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=300
StandardOutput=journal
StandardError=journal
SyslogIdentifier={unit_name}
{env_lines}
[Install]
WantedBy=multi-user.target
",
    )
}

/// Validate that each env entry is in `KEY=VALUE` format and contains no
/// characters that would silently corrupt the generated systemd unit file.
///
/// Bare newlines / carriage returns / NUL bytes inside a value break the
/// `Environment=` directive even with proper quote/backslash escaping
/// (a literal newline terminates the directive line). Reject these at
/// install time rather than letting `daemon-reload` fail obscurely later.
pub(super) fn validate_env_vars(vars: &[String]) -> RunnerResult<()> {
    for entry in vars {
        // Check dangerous chars first so the KEY=VALUE error below can
        // safely interpolate `entry` without leaking newlines/NUL into
        // log output.
        if entry.contains(['\n', '\r', '\0']) {
            return Err(RunnerError::Config(
                "invalid --env value: newline or NUL characters are not allowed".to_string(),
            ));
        }
        let eq_pos = entry.find('=');
        if eq_pos.is_none_or(|p| p == 0) {
            return Err(RunnerError::Config(format!(
                "invalid --env value '{entry}': expected KEY=VALUE format"
            )));
        }
    }
    Ok(())
}

pub(super) fn validate_systemd_path(label: &str, path: &Path) -> RunnerResult<()> {
    let value = path.display().to_string();
    if value.contains(['\n', '\r', '\0']) {
        return Err(RunnerError::Config(format!(
            "{label} cannot contain newline or NUL characters"
        )));
    }
    Ok(())
}

pub(super) fn validate_current_exe_path(path: PathBuf) -> RunnerResult<PathBuf> {
    let meta = std::fs::metadata(&path).map_err(|e| {
        RunnerError::Internal(format!("stat current executable {}: {e}", path.display()))
    })?;
    if !meta.is_file() {
        return Err(RunnerError::Internal(format!(
            "current executable {} is not a file",
            path.display()
        )));
    }
    #[cfg(unix)]
    if meta.permissions().mode() & 0o111 == 0 {
        return Err(RunnerError::Internal(format!(
            "current executable {} is not executable",
            path.display()
        )));
    }
    Ok(path)
}

fn unit_staging_path(path: &Path, attempt: u64) -> RunnerResult<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        RunnerError::Internal(format!(
            "unit file path has no file name: {}",
            path.display()
        ))
    })?;
    let mut staging_name = OsString::from(file_name);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    staging_name.push(format!(
        "{UNIT_STAGING_MARKER}{}.{}.{}",
        std::process::id(),
        nanos,
        attempt
    ));
    Ok(parent.join(staging_name))
}

fn unit_staging_prefix(path: &Path) -> RunnerResult<String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "unit file path has no UTF-8 file name: {}",
                path.display()
            ))
        })?;
    Ok(format!("{file_name}{UNIT_STAGING_MARKER}"))
}

fn legacy_unit_staging_prefix(path: &Path) -> RunnerResult<String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "unit file path has no UTF-8 file name: {}",
                path.display()
            ))
        })?;
    Ok(format!(".{file_name}.tmp."))
}

fn is_generated_unit_staging_suffix(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(pid) = parts.next() else {
        return false;
    };
    let Some(nanos) = parts.next() else {
        return false;
    };
    let Some(attempt) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && pid.parse::<u32>().is_ok()
        && nanos.parse::<u128>().is_ok()
        && attempt.parse::<u64>().is_ok()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnitStagingFileKind {
    Current,
    Legacy,
}

fn unit_staging_file_kind(
    name: &str,
    staging_prefix: &str,
    legacy_staging_prefix: &str,
) -> Option<UnitStagingFileKind> {
    if let Some(suffix) = name.strip_prefix(staging_prefix) {
        return is_generated_unit_staging_suffix(suffix).then_some(UnitStagingFileKind::Current);
    }
    if let Some(suffix) = name.strip_prefix(legacy_staging_prefix) {
        return uuid::Uuid::parse_str(suffix)
            .is_ok()
            .then_some(UnitStagingFileKind::Legacy);
    }
    None
}

fn remove_stale_unit_staging_file(path: &Path, min_age: Option<Duration>) -> RunnerResult<()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat stale unit staging file {}: {e}",
                path.display()
            )));
        }
    };
    let file_type = meta.file_type();
    if !meta.is_file() && !file_type.is_symlink() {
        return Ok(());
    }
    if let Some(min_age) = min_age {
        let modified = meta.modified().map_err(|e| {
            RunnerError::Internal(format!(
                "stat stale unit staging file mtime {}: {e}",
                path.display()
            ))
        })?;
        if SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default()
            < min_age
        {
            return Ok(());
        }
    }
    std::fs::remove_file(path).map_err(|e| {
        RunnerError::Internal(format!(
            "remove stale unit staging file {}: {e}",
            path.display()
        ))
    })
}

pub(super) fn cleanup_unit_staging_files(path: &Path) -> RunnerResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let prefix = unit_staging_prefix(path)?;
    let legacy_prefix = legacy_unit_staging_prefix(path)?;

    // Do not remove the old fixed `<target>.tmp` path here: during a rolling
    // deploy an older runner binary may still be using it as its staging file.
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read unit directory {}: {e}",
                parent.display()
            )));
        }
    };
    for entry in entries {
        let entry = entry.map_err(|e| {
            RunnerError::Internal(format!("read unit directory {}: {e}", parent.display()))
        })?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        match unit_staging_file_kind(name, &prefix, &legacy_prefix) {
            Some(UnitStagingFileKind::Current) => {
                remove_stale_unit_staging_file(&entry.path(), None)?;
            }
            Some(UnitStagingFileKind::Legacy) => {
                remove_stale_unit_staging_file(&entry.path(), Some(LEGACY_UNIT_STAGING_MIN_AGE))?;
            }
            None => {}
        }
    }
    Ok(())
}

/// Write a unit file atomically: stage to a unique sibling file, then rename.
///
/// `rename(2)` is atomic on the same filesystem, so a concurrent
/// `systemctl daemon-reload` (possibly triggered by unrelated unit changes
/// on the host) sees either the old file or the new file — never a
/// half-written one. Without this, the truncate+write window inside
/// `std::fs::write` could let systemd parse a partial unit file and leave
/// the unit in a broken state. The staging file is unique so concurrent
/// installs for the same unit do not share a writable temp path.
pub(super) fn write_unit_file(path: &Path, content: &str) -> RunnerResult<()> {
    for _ in 0..UNIT_STAGING_MAX_ATTEMPTS {
        let attempt = UNIT_STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = unit_staging_path(path, attempt)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(UNIT_FILE_MODE);
        }
        let mut file = match options.open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "create staging unit file {}: {e}",
                    tmp.display()
                )));
            }
        };

        #[cfg(unix)]
        {
            if let Err(e) = file.set_permissions(std::fs::Permissions::from_mode(UNIT_FILE_MODE)) {
                let _ = std::fs::remove_file(&tmp);
                return Err(RunnerError::Internal(format!(
                    "set permissions on staging unit file {}: {e}",
                    tmp.display()
                )));
            }
        }
        if let Err(e) = file.write_all(content.as_bytes()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(RunnerError::Internal(format!(
                "write {}: {e}",
                tmp.display()
            )));
        }
        #[cfg(not(unix))]
        drop(file);
        if let Err(e) = std::fs::rename(&tmp, path) {
            // Unlike short-lived dirs elsewhere in the crate, unit files live
            // in /etc/systemd/system/ which no GC path sweeps, and the staged
            // content contains Environment= secrets.
            let _ = std::fs::remove_file(&tmp);
            return Err(RunnerError::Internal(format!(
                "rename {} -> {}: {e}",
                tmp.display(),
                path.display()
            )));
        }
        return Ok(());
    }

    Err(RunnerError::Internal(format!(
        "create unique staging unit file for {}: exhausted {UNIT_STAGING_MAX_ATTEMPTS} attempts",
        path.display()
    )))
}

pub(super) fn remove_unit_file_if_exists(path: &Path) -> RunnerResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove unit file {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service_unit(suffix: &str) -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix(suffix).unwrap()
    }

    #[test]
    fn test_max_length_suffix_derived_basenames_fit_name_max() {
        const COMMON_LINUX_NAME_MAX: usize = 255;

        let suffix = "a".repeat(crate::runner_dirname::MAX_NAME_BYTES);
        let unit = RunnerServiceUnit::from_suffix(&suffix).unwrap();
        let unit_file = unit.service_name().to_string();
        let service_lock = format!("service-{}.lock", unit.unit_name());
        let current_staging = format!(
            "{unit_file}{UNIT_STAGING_MARKER}{}.{}.{}",
            u32::MAX,
            u128::MAX,
            u64::MAX
        );
        let legacy_staging = format!(".{unit_file}.tmp.{}", "0".repeat(36));

        for (label, basename) in [
            ("unit file", unit_file),
            ("service lock", service_lock),
            ("current unit staging", current_staging),
            ("legacy unit staging", legacy_staging),
        ] {
            assert!(
                basename.len() <= COMMON_LINUX_NAME_MAX,
                "{label} basename is {} bytes: {basename}",
                basename.len()
            );
        }
    }

    #[test]
    fn test_unit_file_path() {
        let path = service_unit("v0.1.0").unit_file_path().to_path_buf();
        assert_eq!(
            path,
            PathBuf::from("/etc/systemd/system/vm0-runner-v0.1.0.service")
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_current_exe_path_accepts_executable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner");
        std::fs::write(&path, "binary").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(validate_current_exe_path(path.clone()).unwrap(), path);
    }

    #[cfg(unix)]
    #[test]
    fn validate_current_exe_path_rejects_non_executable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner");
        std::fs::write(&path, "binary").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        assert!(validate_current_exe_path(path).is_err());
    }

    #[test]
    fn validate_current_exe_path_rejects_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-runner");

        assert!(validate_current_exe_path(path).is_err());
    }

    #[test]
    fn validate_current_exe_path_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner");
        std::fs::create_dir(&path).unwrap();

        assert!(validate_current_exe_path(path).is_err());
    }

    #[test]
    fn test_generate_unit_file() {
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/var/lib/vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            &[],
            false,
        );
        assert!(content.contains("Description=VM0 Runner (vm0-runner-v0.1.0)"));
        assert!(content.contains(
            "ExecStart=\"/var/lib/vm0-runner/bin/v0.1.0/vm0-runner\" start --config \"/home/ubuntu/runner.yaml\"\n"
        ));
        assert!(!content.contains("User="));
        assert!(content.contains("SyslogIdentifier=vm0-runner-v0.1.0"));
        assert!(!content.contains("EnvironmentFile="));
        assert!(content.contains("Restart=on-failure"));
        assert!(content.contains("TimeoutStopSec=300"));
        assert!(content.contains("[Install]"));
        assert!(content.contains("WantedBy=multi-user.target"));
        assert!(!content.contains("Environment="));
        assert!(!content.contains("--local"));
    }

    #[test]
    fn test_generate_unit_file_with_env() {
        let env = vec![
            "VERCEL_AUTOMATION_BYPASS_SECRET=xxx".to_string(),
            "USE_MOCK_CLAUDE=true".to_string(),
            "MY_DESC=hello world".to_string(),
        ];
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/var/lib/vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            &env,
            false,
        );
        assert!(!content.contains("EnvironmentFile="));
        assert!(content.contains("Environment=\"VERCEL_AUTOMATION_BYPASS_SECRET=xxx\""));
        assert!(content.contains("Environment=\"USE_MOCK_CLAUDE=true\""));
        assert!(content.contains("Environment=\"MY_DESC=hello world\""));
        let first_env_pos = content
            .find("Environment=\"VERCEL_AUTOMATION_BYPASS_SECRET=xxx\"")
            .unwrap();
        let install_pos = content.find("[Install]").unwrap();
        assert!(first_env_pos < install_pos);
        assert!(content.contains("\n\n[Install]"));
    }

    #[test]
    fn test_generate_unit_file_special_chars() {
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/opt/my runner/vm0-runner"),
            Path::new("/opt/my config/runner.yaml"),
            &[],
            false,
        );
        assert!(content.contains(
            "ExecStart=\"/opt/my runner/vm0-runner\" start --config \"/opt/my config/runner.yaml\""
        ));
        assert!(!content.contains("User="));
    }

    #[test]
    fn test_generate_unit_file_local_flag() {
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/usr/bin/runner"),
            Path::new("/etc/runner.yaml"),
            &[],
            true,
        );
        assert!(content.contains(
            "ExecStart=\"/usr/bin/runner\" start --config \"/etc/runner.yaml\" --local\n"
        ));
    }

    #[test]
    fn test_escape_systemd_value() {
        // Empty input — degenerate but callable (helper is independent of
        // validate); guards against future implementation changes.
        assert_eq!(escape_systemd_value(""), "");

        // No special chars — identity.
        assert_eq!(escape_systemd_value("KEY=value"), "KEY=value");

        // Double quotes.
        assert_eq!(escape_systemd_value(r#"MSG=say "hi""#), r#"MSG=say \"hi\""#,);

        // Backslashes.
        assert_eq!(
            escape_systemd_value(r"PATH=C:\Users\test"),
            r"PATH=C:\\Users\\test",
        );

        // Mixed `\` and `"` — regressions here catch reversed-order bugs
        // (each character alone would still pass the tests above).
        assert_eq!(escape_systemd_value(r#"K=a\b"c"#), r#"K=a\\b\"c"#);

        // Trailing `\`: without escape, the generated line `"K=foo\"` would
        // swallow the closing quote and corrupt the unit file.
        assert_eq!(escape_systemd_value(r"K=foo\"), r"K=foo\\");

        // Single `%` — without escape, systemd would treat `%X` as a
        // specifier (e.g. `%H` → hostname). `%%` is the literal-`%` escape.
        assert_eq!(escape_systemd_value("MSG=50% done"), "MSG=50%% done");

        // `%` followed by a known specifier letter — concrete reproduction
        // of issue #9470: without escape, systemd silently rewrites this
        // to the host's actual hostname.
        assert_eq!(escape_systemd_value("MSG=host=%H"), "MSG=host=%%H");

        // Already-escaped `%%` in user input — must be doubled again to
        // `%%%%`, otherwise systemd unescapes it back to a single `%`
        // which then specifier-expands.
        assert_eq!(escape_systemd_value("K=100%%"), "K=100%%%%");

        // All three escape classes in one value — catches any single-char
        // regression that the targeted tests would miss.
        assert_eq!(escape_systemd_value(r#"K=a\b"c%d"#), r#"K=a\\b\"c%%d"#,);

        // Trailing `%`: arguably the most version-sensitive case. Older
        // systemd may preserve a trailing `%`, newer versions may warn or
        // error; escaping to `%%` is safe everywhere.
        assert_eq!(escape_systemd_value("KEY=trailing%"), "KEY=trailing%%");

        // Non-ASCII / UTF-8 input: characters outside the escape set must
        // pass through as their original UTF-8 bytes. Guards against any
        // future refactor that switches from `chars()` to byte-level
        // iteration and breaks multi-byte characters.
        assert_eq!(escape_systemd_value("MSG=任务完成 ✓"), "MSG=任务完成 ✓");
    }

    #[test]
    fn test_generate_unit_file_escapes_env_values() {
        let env = vec![
            r#"MSG=say "hi""#.to_string(),
            r"PATH=C:\Users".to_string(),
            // Both `"` and `\` in a single entry — catches regressions in
            // the helper-to-format! interaction that the helper-only test
            // would miss (e.g. accidental extra escaping at the call site).
            r#"K=a"\b"#.to_string(),
            // `%H` in user input must reach the runner process literally,
            // not be expanded to the host's hostname by systemd. See #9470.
            "MSG=job %H done".to_string(),
        ];
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/usr/bin/runner"),
            Path::new("/etc/runner.yaml"),
            &env,
            false,
        );
        assert!(content.contains(r#"Environment="MSG=say \"hi\"""#));
        assert!(content.contains(r#"Environment="PATH=C:\\Users""#));
        assert!(content.contains(r#"Environment="K=a\"\\b""#));
        assert!(content.contains(r#"Environment="MSG=job %%H done""#));
    }

    #[test]
    fn test_generate_unit_file_escapes_exec_paths() {
        // A `%` in the config or exe path would otherwise be subject to
        // systemd specifier expansion (e.g. `%H` → hostname), pointing
        // ExecStart at the wrong file. Same root cause as #9470.
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/opt/runner-v1%2.0/bin/runner"),
            Path::new("/etc/cache%20.yaml"),
            &[],
            false,
        );
        assert!(content.contains(
            r#"ExecStart="/opt/runner-v1%%2.0/bin/runner" start --config "/etc/cache%%20.yaml""#
        ));
    }

    #[test]
    fn test_validate_env_vars_valid() {
        assert!(validate_env_vars(&[]).is_ok());
        assert!(validate_env_vars(&["KEY=VALUE".to_string()]).is_ok());
        assert!(validate_env_vars(&["K=".to_string()]).is_ok());
        assert!(validate_env_vars(&["K=V=W".to_string()]).is_ok());
        // `"`, `\`, and `%` are valid at the validate layer — they get
        // escaped later in `escape_systemd_value`.
        assert!(validate_env_vars(&[r#"MSG=say "hi""#.to_string()]).is_ok());
        assert!(validate_env_vars(&[r"PATH=C:\Users".to_string()]).is_ok());
        assert!(validate_env_vars(&["MSG=50% done".to_string()]).is_ok());
        // Tab is intentionally NOT rejected: it is valid inside a systemd
        // quoted `Environment=` value. Locking this in so a future "let's
        // reject all whitespace control chars" change is an explicit choice.
        assert!(validate_env_vars(&["KEY=with\ttab".to_string()]).is_ok());
    }

    #[test]
    fn test_validate_env_vars_invalid() {
        assert!(validate_env_vars(&["NOEQUALS".to_string()]).is_err());
        assert!(validate_env_vars(&["=VALUE".to_string()]).is_err());
        assert!(validate_env_vars(&["".to_string()]).is_err());
        // Bare newline / CR / NUL would silently corrupt the unit file.
        assert!(validate_env_vars(&["KEY=line1\nline2".to_string()]).is_err());
        assert!(validate_env_vars(&["KEY=foo\rbar".to_string()]).is_err());
        assert!(validate_env_vars(&["KEY=with\0nul".to_string()]).is_err());
    }

    #[test]
    fn validate_systemd_path_rejects_line_breaks() {
        assert!(validate_systemd_path("config path", Path::new("/tmp/runner config.yaml")).is_ok());
        assert!(
            validate_systemd_path("config path", Path::new("/tmp/runner\nconfig.yaml")).is_err()
        );
        assert!(
            validate_systemd_path("config path", Path::new("/tmp/runner\rconfig.yaml")).is_err()
        );
        assert!(
            validate_systemd_path("config path", Path::new("/tmp/runner\0config.yaml")).is_err()
        );
    }

    #[test]
    fn write_unit_file_creates_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        write_unit_file(&path, "[Unit]\nDescription=test\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[Unit]\nDescription=test\n"
        );
    }

    #[test]
    fn write_unit_file_overwrites_existing() {
        // Verifies the rename step replaces an existing file rather than
        // failing — POSIX rename(2) over an existing file is the atomic
        // swap we rely on for race-free updates.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        std::fs::write(&path, "old content").unwrap();
        write_unit_file(&path, "new content").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");
    }

    #[cfg(unix)]
    #[test]
    fn write_unit_file_uses_restrictive_permissions_for_new_unit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");

        write_unit_file(&path, "content").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn write_unit_file_tightens_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        std::fs::write(&path, "old content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_unit_file(&path, "new content").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");
    }

    #[test]
    fn write_unit_file_allows_concurrent_writers() {
        use std::sync::{Arc, Barrier};

        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("vm0-runner-test.service"));
        let writer_count = 16;
        let barrier = Arc::new(Barrier::new(writer_count));
        let contents: Vec<String> = (0..writer_count)
            .map(|idx| format!("content-{idx}-{}", "x".repeat(4096)))
            .collect();

        let handles: Vec<_> = contents
            .iter()
            .cloned()
            .map(|content| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    write_unit_file(path.as_path(), &content)
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let final_content = std::fs::read_to_string(path.as_path()).unwrap();
        assert!(contents.contains(&final_content));
        assert_no_unit_staging_files(dir.path(), "vm0-runner-test.service");
    }

    #[test]
    fn write_unit_file_does_not_leave_tmp_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        write_unit_file(&path, "content").unwrap();
        assert_no_unit_staging_files(dir.path(), "vm0-runner-test.service");
    }

    #[test]
    fn write_unit_file_ignores_legacy_fixed_tmp_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        let legacy_tmp = path.with_extension("tmp");
        std::fs::write(&legacy_tmp, "legacy").unwrap();

        write_unit_file(&path, "content").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "content");
        assert_eq!(std::fs::read_to_string(&legacy_tmp).unwrap(), "legacy");
        assert_no_unit_staging_files(dir.path(), "vm0-runner-test.service");
    }

    #[test]
    fn cleanup_unit_staging_files_preserves_legacy_fixed_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        let legacy_tmp = path.with_extension("tmp");
        let stale_unique = dir.path().join("vm0-runner-test.service.tmp@123.456.0");
        let old_legacy_unique = dir.path().join(format!(
            ".vm0-runner-test.service.tmp.{}",
            uuid::Uuid::new_v4()
        ));
        let recent_legacy_unique = dir.path().join(format!(
            ".vm0-runner-test.service.tmp.{}",
            uuid::Uuid::new_v4()
        ));
        let invalid_staging = dir.path().join("vm0-runner-test.service.tmp@manual");
        let other_unit_staging = dir.path().join("vm0-runner-other.service.tmp@123.456.0");
        let colliding_unit_staging = dir
            .path()
            .join("vm0-runner-test.service.tmp.other.service.tmp@123.456.0");
        let staging_dir = dir.path().join("vm0-runner-test.service.tmp.dir");

        std::fs::write(&path, "current").unwrap();
        std::fs::write(&legacy_tmp, "legacy").unwrap();
        std::fs::write(&stale_unique, "stale").unwrap();
        std::fs::write(&old_legacy_unique, "old legacy unique").unwrap();
        std::fs::write(&recent_legacy_unique, "recent legacy unique").unwrap();
        std::fs::write(&invalid_staging, "manual").unwrap();
        std::fs::write(&other_unit_staging, "other").unwrap();
        std::fs::write(&colliding_unit_staging, "colliding").unwrap();
        std::fs::create_dir(&staging_dir).unwrap();
        let old_legacy_mtime =
            SystemTime::now() - LEGACY_UNIT_STAGING_MIN_AGE - Duration::from_secs(60);
        std::fs::File::open(&old_legacy_unique)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old_legacy_mtime))
            .unwrap();

        cleanup_unit_staging_files(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "current");
        assert!(
            legacy_tmp.exists(),
            "legacy fixed staging may be in use by an older runner binary"
        );
        assert!(!stale_unique.exists(), "unique staging must be removed");
        assert!(
            !old_legacy_unique.exists(),
            "old legacy dot-prefixed unique staging must be removed"
        );
        assert!(
            recent_legacy_unique.exists(),
            "recent legacy dot-prefixed staging may be in use by an older runner binary"
        );
        assert!(
            invalid_staging.exists(),
            "invalid staging-like files must not be removed"
        );
        assert!(
            other_unit_staging.exists(),
            "other unit staging must not be removed"
        );
        assert!(
            colliding_unit_staging.exists(),
            "dot-prefixed unit names must not collide with this unit staging"
        );
        assert!(staging_dir.exists(), "directories must not be removed");
    }

    #[test]
    fn write_unit_file_cleans_up_staging_on_rename_failure() {
        // Rename fails when the target path is an existing directory
        // (EISDIR). Verifies the staged content — which may contain
        // Environment= secrets — is removed so it doesn't persist in
        // /etc/systemd/system/.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::fs::create_dir(&path).unwrap();
        let result = write_unit_file(&path, "secret=xyz");
        assert!(result.is_err(), "rename onto existing dir must fail");
        assert_no_unit_staging_files(dir.path(), "target.service");
    }

    #[test]
    fn remove_unit_file_if_exists_removes_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::fs::write(&path, "unit").unwrap();

        remove_unit_file_if_exists(&path).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn remove_unit_file_if_exists_ignores_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");

        remove_unit_file_if_exists(&path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn remove_unit_file_if_exists_removes_broken_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::os::unix::fs::symlink(dir.path().join("missing-target"), &path).unwrap();

        remove_unit_file_if_exists(&path).unwrap();

        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "broken unit symlink should be removed"
        );
    }

    fn assert_no_unit_staging_files(dir: &Path, unit_file_name: &str) {
        let staging_prefix = format!("{unit_file_name}{UNIT_STAGING_MARKER}");
        let staging_files: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(&staging_prefix))
            .collect();
        assert!(
            staging_files.is_empty(),
            "staging files must be cleaned up: {staging_files:?}"
        );
    }
}
