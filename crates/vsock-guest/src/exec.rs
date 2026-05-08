use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime};

use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;
#[cfg(not(debug_assertions))]
const SANDBOX_USER: &str = "user";
const SANDBOX_UID: libc::uid_t = 1000;
const SANDBOX_GID: libc::gid_t = 1000;
const ENV_SCRIPT_PREFIX: &str = "vm0-env-";
const ENV_SCRIPT_SUFFIX: &str = ".sh";
const ENV_SCRIPT_STALE_AFTER: Duration = Duration::from_secs(60 * 60);

fn get_exec_user() -> Option<&'static str> {
    #[cfg(debug_assertions)]
    {
        None
    }

    #[cfg(not(debug_assertions))]
    {
        // Default user for command execution (UID 1000, matching E2B sandbox)
        Some(SANDBOX_USER)
    }
}

/// Shell-escape a value by wrapping in single quotes and escaping embedded `'`.
fn shell_escape_value(val: &str) -> String {
    format!("'{}'", val.replace('\'', "'\\''"))
}

/// Build a Command to execute a shell command as the appropriate user.
///
/// When `sudo` is true the command runs as root, bypassing `su - user` and
/// the PAM overhead that comes with it.
///
/// In release builds the guest-init process is already root, so `sh -c`
/// suffices. In debug builds the process is a normal user, so `sudo sh -c`
/// is needed to elevate.
pub(crate) fn build_exec_command(command: &str, sudo: bool) -> Command {
    match get_exec_user() {
        Some(user) => {
            if sudo {
                // Release: already root — run directly
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("su");
                c.arg("-").arg(user).arg("-c").arg(command);
                c
            }
        }
        None => {
            if sudo {
                // Debug: not root — elevate with sudo
                let mut c = Command::new("sudo");
                c.arg("sh").arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            }
        }
    }
}

pub(crate) struct EnvScriptGuard {
    path: Option<PathBuf>,
    dir: Option<PathBuf>,
}

impl EnvScriptGuard {
    fn new(path: PathBuf, dir: PathBuf) -> Self {
        Self {
            path: Some(path),
            dir: Some(dir),
        }
    }

    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub(crate) fn cleanup(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
        if let Some(dir) = self.dir.take() {
            let _ = fs::remove_dir(dir);
        }
    }
}

impl Drop for EnvScriptGuard {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub(crate) struct PreparedExecCommand {
    pub(crate) command: Command,
    pub(crate) env_script: Option<EnvScriptGuard>,
}

pub(crate) struct SpawnedCommand {
    pub(crate) child: Child,
    pub(crate) env_script: Option<EnvScriptGuard>,
}

fn effective_uid() -> libc::uid_t {
    // SAFETY: `geteuid` is a simple libc getter with no preconditions.
    unsafe { libc::geteuid() }
}

fn default_env_script_dir() -> PathBuf {
    if effective_uid() == 0 {
        PathBuf::from("/run/vm0-exec")
    } else if Path::new("/dev/shm").is_dir() {
        PathBuf::from("/dev/shm/vm0-exec")
    } else {
        std::env::temp_dir().join("vm0-exec")
    }
}

fn format_env_key_for_log(key: &str) -> String {
    truncate_preview(&key.escape_debug().to_string())
}

pub(crate) fn format_env_diagnostics(command: &str, env: &[(&str, &str)]) -> String {
    let env_bytes: usize = env.iter().map(|(key, value)| key.len() + value.len()).sum();
    let mut largest: Vec<(&str, usize)> =
        env.iter().map(|(key, value)| (*key, value.len())).collect();
    largest.sort_by(|(left_key, left_len), (right_key, right_len)| {
        right_len
            .cmp(left_len)
            .then_with(|| left_key.cmp(right_key))
    });
    let largest = largest
        .into_iter()
        .take(5)
        .map(|(key, len)| format!("{}:{len}", format_env_key_for_log(key)))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "command_bytes={}, env_count={}, env_bytes={}, largest_env=[{}]",
        command.len(),
        env.len(),
        env_bytes,
        largest,
    )
}

fn is_shell_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn validate_env_keys(env: &[(&str, &str)]) -> io::Result<()> {
    for (key, _) in env {
        if !is_shell_identifier(key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "invalid environment variable name: {}",
                    format_env_key_for_log(key)
                ),
            ));
        }
    }
    Ok(())
}

fn build_env_script_content(
    script_dir: &Path,
    script_path: &Path,
    command: &str,
    env: &[(&str, &str)],
) -> io::Result<String> {
    validate_env_keys(env)?;
    let script_dir = script_dir.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script directory path must be valid UTF-8",
        )
    })?;
    let script_path = script_path.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script path must be valid UTF-8",
        )
    })?;

    let mut script = String::new();
    script.push_str("#!/bin/bash\n");
    script.push_str("set +e\n");
    script.push_str("script_dir=");
    script.push_str(&shell_escape_value(script_dir));
    script.push('\n');
    script.push_str("script_path=");
    script.push_str(&shell_escape_value(script_path));
    script.push('\n');
    script.push_str("rm -f -- \"$script_path\"\n");
    script.push_str("rmdir -- \"$script_dir\" 2>/dev/null || true\n");
    for (key, value) in env {
        script.push_str("export ");
        script.push_str(key);
        script.push('=');
        script.push_str(&shell_escape_value(value));
        script.push('\n');
    }
    script.push_str("exec /bin/bash -c ");
    script.push_str(&shell_escape_value(command));
    script.push('\n');
    Ok(script)
}

fn random_hex(bytes: usize) -> io::Result<String> {
    let mut raw = vec![0_u8; bytes];
    File::open("/dev/urandom")?.read_exact(&mut raw)?;
    let mut out = String::with_capacity(bytes * 2);
    for byte in raw {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

fn ensure_env_script_dir(dir: &Path) -> io::Result<()> {
    let euid = effective_uid();
    let mode = if euid == 0 { 0o711 } else { 0o700 };
    match fs::symlink_metadata(dir) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("env script path is not a directory: {}", dir.display()),
                ));
            }
            let expected_owner = if euid == 0 { 0 } else { euid };
            if metadata.uid() != expected_owner {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "env script directory has unexpected owner: {}",
                        dir.display()
                    ),
                ));
            }
            if metadata.permissions().mode() & 0o022 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "env script directory is writable by group/other: {}",
                        dir.display()
                    ),
                ));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            DirBuilder::new().mode(mode).create(dir)?;
        }
        Err(e) => return Err(e),
    }

    fs::set_permissions(dir, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn chown_path(path: &Path, uid: libc::uid_t, gid: libc::gid_t) -> io::Result<()> {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script path must not contain NUL bytes",
        )
    })?;
    let ret = unsafe { libc::chown(path.as_ptr(), uid, gid) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn cleanup_stale_env_scripts_in(
    dir: &Path,
    now: SystemTime,
    stale_after: Duration,
) -> io::Result<usize> {
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(ENV_SCRIPT_PREFIX) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_dir() && !name.ends_with(ENV_SCRIPT_SUFFIX) {
            continue;
        }
        if !metadata.file_type().is_file()
            && !metadata.file_type().is_symlink()
            && !metadata.file_type().is_dir()
        {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age >= stale_after)
        {
            let removed_entry = if metadata.file_type().is_dir() {
                fs::remove_dir_all(&path).is_ok()
            } else {
                fs::remove_file(&path).is_ok()
            };
            if removed_entry {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn create_env_script_in_dir(
    dir: &Path,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<EnvScriptGuard> {
    ensure_env_script_dir(dir)?;
    let _ = cleanup_stale_env_scripts_in(dir, SystemTime::now(), ENV_SCRIPT_STALE_AFTER);

    for _ in 0..16 {
        let script_dir = dir.join(format!("{}{}", ENV_SCRIPT_PREFIX, random_hex(16)?));
        match DirBuilder::new().mode(0o700).create(&script_dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
        fs::set_permissions(&script_dir, fs::Permissions::from_mode(0o700))?;

        let path = script_dir.join(format!("run{ENV_SCRIPT_SUFFIX}"));
        let script = build_env_script_content(&script_dir, &path, command, env)?;
        let mut guard = EnvScriptGuard::new(path.clone(), script_dir.clone());

        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };

        let result = (|| -> io::Result<()> {
            file.write_all(script.as_bytes())?;
            if effective_uid() == 0 && !sudo && get_exec_user().is_some() {
                file.set_permissions(fs::Permissions::from_mode(0o000))?;
                chown_path(&script_dir, SANDBOX_UID, SANDBOX_GID)?;
                let ret = unsafe { libc::fchown(file.as_raw_fd(), SANDBOX_UID, SANDBOX_GID) };
                if ret != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            file.set_permissions(fs::Permissions::from_mode(0o400))?;
            Ok(())
        })();

        if let Err(e) = result {
            guard.cleanup();
            return Err(e);
        }
        drop(file);
        return Ok(guard);
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to allocate a unique env script path",
    ))
}

fn create_env_script(
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<EnvScriptGuard> {
    create_env_script_in_dir(&default_env_script_dir(), command, env, sudo)
}

fn script_invocation(path: &Path) -> io::Result<String> {
    let path = path.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script path must be valid UTF-8",
        )
    })?;
    Ok(format!("/bin/bash {}", shell_escape_value(path)))
}

pub(crate) fn build_exec_command_with_env(
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<PreparedExecCommand> {
    if env.is_empty() {
        return Ok(PreparedExecCommand {
            command: build_exec_command(command, sudo),
            env_script: None,
        });
    }

    let env_script = create_env_script(command, env, sudo)?;
    let script_path = env_script
        .path()
        .ok_or_else(|| io::Error::other("env script path missing"))?;
    let invocation = script_invocation(script_path)?;
    Ok(PreparedExecCommand {
        command: build_exec_command(&invocation, sudo),
        env_script: Some(env_script),
    })
}

/// Truncate a command string for logging, preserving UTF-8 boundaries
pub(crate) fn truncate_preview(s: &str) -> String {
    if s.len() <= COMMAND_PREVIEW_MAX_LEN {
        return s.to_string();
    }
    // Find a safe UTF-8 boundary at or before the max length
    let end = s
        .char_indices()
        .take_while(|(i, _)| *i < COMMAND_PREVIEW_MAX_LEN)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(COMMAND_PREVIEW_MAX_LEN);
    format!("{}...", &s[..end])
}

/// Spawn a command as the leader of a new process group on Unix.
///
/// Timeout killing targets the process group by child PID, so every child path
/// that uses the shared wait helpers must preserve this spawn invariant.
pub(crate) fn spawn_in_own_process_group(command: &mut Command) -> io::Result<Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0).spawn()
    }
    #[cfg(not(unix))]
    {
        command.spawn()
    }
}

/// Spawn `command` with stdout/stderr piped — used by both buffered exec and
/// streaming spawn-watch.
pub(crate) fn spawn_with_pipes(
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<SpawnedCommand> {
    let PreparedExecCommand {
        mut command,
        env_script,
    } = build_exec_command_with_env(command, env, sudo)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = spawn_in_own_process_group(&mut command)?;
    Ok(SpawnedCommand { child, env_script })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use crate::wait::{WaitOutcome, wait_with_kill_timeout};

    struct TempDirGuard(PathBuf);

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn wait_for_path(path: &std::path::Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    fn temp_dir(label: &str) -> (PathBuf, TempDirGuard) {
        let dir = std::env::temp_dir().join(format!(
            "vsock-guest-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let guard = TempDirGuard(dir.clone());
        (dir, guard)
    }

    #[test]
    fn shell_escape_simple() {
        assert_eq!(shell_escape_value("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_with_single_quotes() {
        assert_eq!(shell_escape_value("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_empty() {
        assert_eq!(shell_escape_value(""), "''");
    }

    #[test]
    fn env_script_content_self_removes_before_exports() {
        let dir = Path::new("/run/vm0-exec/vm0-env-test");
        let path = dir.join("run.sh");
        let script =
            build_env_script_content(dir, &path, "echo \"$FOO\"", &[("FOO", "it's a \"test\"")])
                .unwrap();

        let rm_pos = script.find("rm -f -- \"$script_path\"").unwrap();
        let export_pos = script.find("export FOO=").unwrap();
        assert!(rm_pos < export_pos);
        assert!(script.contains("script_dir='/run/vm0-exec/vm0-env-test'"));
        assert!(script.contains("script_path='/run/vm0-exec/vm0-env-test/run.sh'"));
        assert!(script.contains("rmdir -- \"$script_dir\""));
        assert!(script.contains("export FOO='it'\\''s a \"test\"'"));
        assert!(script.contains("exec /bin/bash -c 'echo \"$FOO\"'"));
    }

    #[test]
    fn env_script_content_rejects_invalid_env_key() {
        let dir = Path::new("/run/vm0-exec/vm0-env-test");
        let path = dir.join("run.sh");
        let err = build_env_script_content(dir, &path, "echo hi", &[("BAD;touch /tmp/pwned", "x")])
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(
            err.to_string()
                .contains("invalid environment variable name")
        );
    }

    #[test]
    fn env_script_invocation_keeps_secret_out_of_argv() {
        let (dir, _guard) = temp_dir("argv");
        let secret = "secret-value-that-must-not-be-in-argv";
        let script =
            create_env_script_in_dir(&dir, "echo \"$FOO\"", &[("FOO", secret)], true).unwrap();
        let invocation = script_invocation(script.path().unwrap()).unwrap();
        let command = build_exec_command(&invocation, true);
        let argv = std::iter::once(command.get_program().to_string_lossy().to_string())
            .chain(
                command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned()),
            )
            .collect::<Vec<_>>()
            .join("\0");

        assert!(!argv.contains(secret));
        assert!(argv.contains("/bin/bash"));
        assert!(argv.contains(script.path().unwrap().to_str().unwrap()));
    }

    #[test]
    fn env_script_removes_file_and_directory_when_started() {
        let (dir, _guard) = temp_dir("self-remove");
        let output = dir.join("output");
        let output_arg = shell_escape_value(output.to_str().unwrap());
        let script = create_env_script_in_dir(
            &dir,
            &format!("printf \"$FOO\" > {output_arg}"),
            &[("FOO", "done")],
            true,
        )
        .unwrap();
        let path = script.path().unwrap().to_path_buf();
        let script_dir = path.parent().unwrap().to_path_buf();
        let invocation = script_invocation(&path).unwrap();

        let status = Command::new("sh")
            .arg("-c")
            .arg(invocation)
            .status()
            .unwrap();

        assert!(status.success());
        assert_eq!(std::fs::read_to_string(output).unwrap(), "done");
        assert!(!path.exists());
        assert!(!script_dir.exists());
    }

    #[test]
    fn env_diagnostics_do_not_include_values() {
        let diagnostics = format_env_diagnostics(
            "echo hi",
            &[
                ("SMALL", "ok"),
                ("BIG", "secret-value-that-must-not-appear"),
            ],
        );

        assert!(diagnostics.contains("command_bytes=7"));
        assert!(diagnostics.contains("env_count=2"));
        assert!(diagnostics.contains("BIG:33"));
        assert!(!diagnostics.contains("secret-value"));
        assert!(!diagnostics.contains("ok"));
    }

    #[test]
    fn env_script_guard_cleanup_is_idempotent() {
        let (dir, _guard) = temp_dir("cleanup");
        let script_dir = dir.join("vm0-env-cleanup");
        std::fs::create_dir(&script_dir).unwrap();
        let path = script_dir.join("run.sh");
        std::fs::write(&path, "secret").unwrap();
        let mut guard = EnvScriptGuard::new(path.clone(), script_dir.clone());

        guard.cleanup();
        guard.cleanup();

        assert!(!path.exists());
        assert!(!script_dir.exists());
    }

    #[test]
    fn stale_env_script_cleanup_only_removes_matching_entries() {
        let (dir, _guard) = temp_dir("stale");
        let stale = dir.join(format!("{ENV_SCRIPT_PREFIX}stale{ENV_SCRIPT_SUFFIX}"));
        let other = dir.join("other.sh");
        std::fs::write(&stale, "secret").unwrap();
        std::fs::write(&other, "not ours").unwrap();

        let removed =
            cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::ZERO).unwrap();

        assert_eq!(removed, 1);
        assert!(!stale.exists());
        assert!(other.exists());
    }

    #[test]
    fn stale_env_script_cleanup_removes_matching_directories() {
        let (dir, _guard) = temp_dir("stale-dir");
        let stale = dir.join(format!("{ENV_SCRIPT_PREFIX}stale-dir"));
        let nested = stale.join("run.sh");
        std::fs::create_dir(&stale).unwrap();
        std::fs::write(&nested, "secret").unwrap();

        let removed =
            cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::ZERO).unwrap();

        assert_eq!(removed, 1);
        assert!(!stale.exists());
    }

    #[cfg(unix)]
    #[test]
    fn stale_env_script_cleanup_removes_symlink_without_following_it() {
        let (dir, _guard) = temp_dir("stale-symlink");
        let target = dir.join("target");
        let link = dir.join(format!("{ENV_SCRIPT_PREFIX}link{ENV_SCRIPT_SUFFIX}"));
        std::fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let removed =
            cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::ZERO).unwrap();

        assert_eq!(removed, 1);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    }

    #[test]
    fn truncate_preview_short_string() {
        let s = "echo hello";
        assert_eq!(truncate_preview(s), "echo hello");
    }

    #[test]
    fn truncate_preview_exact_limit() {
        let s = "x".repeat(COMMAND_PREVIEW_MAX_LEN);
        assert_eq!(truncate_preview(&s), s);
    }

    #[test]
    fn truncate_preview_over_limit() {
        let s = "y".repeat(COMMAND_PREVIEW_MAX_LEN + 50);
        let result = truncate_preview(&s);
        // Single-byte ASCII: truncates to exactly COMMAND_PREVIEW_MAX_LEN + "..."
        assert_eq!(
            result,
            format!("{}{}", "y".repeat(COMMAND_PREVIEW_MAX_LEN), "...")
        );
    }

    #[test]
    fn truncate_preview_multibyte_utf8() {
        // Each '🔥' is 4 bytes. Fill to just over the limit.
        let emoji = "🔥".repeat(COMMAND_PREVIEW_MAX_LEN / 4 + 5);
        let result = truncate_preview(&emoji);
        assert!(result.ends_with("..."));
        // Must not panic from slicing in the middle of a UTF-8 sequence
        assert!(result.is_char_boundary(result.len() - 3));
    }

    #[test]
    fn build_exec_command_normal() {
        let cmd = build_exec_command("echo hello", false);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sh -c "echo hello"
        // In release builds: su - user -c "echo hello"
        assert!(
            (prog == "sh" && args == ["-c", "echo hello"])
                || (prog == "su" && args == ["-", "user", "-c", "echo hello"]),
            "unexpected command: {prog} {args:?}"
        );
    }

    #[test]
    fn build_exec_command_sudo() {
        let cmd = build_exec_command("reboot", true);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sudo sh -c "reboot"
        // In release builds: sh -c "reboot"
        assert!(
            (prog == "sudo" && args == ["sh", "-c", "reboot"])
                || (prog == "sh" && args == ["-c", "reboot"]),
            "unexpected sudo command: {prog} {args:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_in_own_process_group_timeout_kills_background_child() {
        let dir = std::env::temp_dir().join(format!(
            "vsock-guest-pg-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = TempDirGuard(dir.clone());
        let ready = dir.join("ready");
        let survived = dir.join("survived");
        let ready_arg = shell_escape_value(ready.to_str().unwrap());
        let survived_arg = shell_escape_value(survived.to_str().unwrap());
        let script =
            format!("trap '' HUP; (sleep 1; touch {survived_arg}) & touch {ready_arg}; wait");

        let mut command = build_exec_command(&script, false);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let child = spawn_in_own_process_group(&mut command).unwrap();
        assert!(
            wait_for_path(&ready, Duration::from_secs(2)),
            "background child should be started before timeout kill is tested"
        );

        let outcome = wait_with_kill_timeout(child, 100);
        assert!(matches!(outcome, WaitOutcome::TimedOut));

        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            !survived.exists(),
            "timeout kill should terminate background children in the process group"
        );
    }
}
