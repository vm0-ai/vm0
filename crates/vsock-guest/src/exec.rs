use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime};

use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;
const ENV_SCRIPT_PREFIX: &str = "vm0-env-";
const ENV_SCRIPT_SUFFIX: &str = ".sh";
const ENV_SCRIPT_STALE_AFTER: Duration = Duration::from_secs(60 * 60);
const CHOWN_UNCHANGED_UID: libc::uid_t = !0;

fn get_exec_user() -> Option<&'static str> {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        None
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        // Default user for command execution (UID 1000, matching E2B sandbox)
        Some(crate::user::sandbox_user_name())
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
/// In production-style builds, non-sudo commands run through `su - user`.
/// In debug/test-support builds, local tests run as the current user unless
/// `sudo` explicitly requests elevation through `sudo sh -c`.
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

fn compare_env_diagnostic_entries(
    left: &(&str, usize),
    right: &(&str, usize),
) -> std::cmp::Ordering {
    right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0))
}

pub(crate) fn format_env_diagnostics(command: &str, env: &[(&str, &str)]) -> String {
    let mut env_bytes = 0;
    let mut largest: Vec<(&str, usize)> = Vec::with_capacity(env.len().min(5));
    for (key, value) in env {
        env_bytes += key.len() + value.len();
        let entry = (*key, value.len());
        match largest
            .iter()
            .position(|existing| compare_env_diagnostic_entries(&entry, existing).is_lt())
        {
            Some(index) => largest.insert(index, entry),
            None if largest.len() < 5 => largest.push(entry),
            None => {}
        }
        if largest.len() > 5 {
            largest.pop();
        }
    }
    let largest = largest
        .into_iter()
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

fn validate_env_values(env: &[(&str, &str)]) -> io::Result<()> {
    for (key, value) in env {
        if value.as_bytes().contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "environment variable value contains NUL bytes: {}",
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
    if command.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command contains NUL bytes",
        ));
    }
    validate_env_keys(env)?;
    validate_env_values(env)?;
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
    script.push_str("rm -f -- \"$script_path\" 2>/dev/null || true\n");
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

fn validate_env_script_dir(dir: &Path, euid: libc::uid_t) -> io::Result<()> {
    let metadata = fs::symlink_metadata(dir)?;
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
    Ok(())
}

fn ensure_env_script_dir(dir: &Path) -> io::Result<()> {
    let euid = effective_uid();
    let mode = if euid == 0 { 0o711 } else { 0o700 };
    match validate_env_script_dir(dir, euid) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            match DirBuilder::new().mode(mode).create(dir) {
                Ok(()) => {}
                Err(create_err) if create_err.kind() == io::ErrorKind::AlreadyExists => {
                    validate_env_script_dir(dir, euid)?;
                }
                Err(create_err) => return Err(create_err),
            }
        }
        Err(e) => return Err(e),
    }

    fs::set_permissions(dir, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn fchown_group(fd: RawFd, gid: libc::gid_t) -> io::Result<()> {
    // SAFETY: `fd` comes from an open file/directory descriptor and `-1`
    // as uid asks fchown to leave the owner unchanged.
    let ret = unsafe { libc::fchown(fd, CHOWN_UNCHANGED_UID, gid) };
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

        let path = script_dir.join(format!("run{ENV_SCRIPT_SUFFIX}"));
        let mut guard = EnvScriptGuard::new(path.clone(), script_dir.clone());
        if let Err(e) = fs::set_permissions(&script_dir, fs::Permissions::from_mode(0o700)) {
            guard.cleanup();
            return Err(e);
        }

        let script = match build_env_script_content(&script_dir, &path, command, env) {
            Ok(script) => script,
            Err(e) => {
                guard.cleanup();
                return Err(e);
            }
        };

        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                guard.cleanup();
                continue;
            }
            Err(e) => {
                guard.cleanup();
                return Err(e);
            }
        };

        let result = (|| -> io::Result<()> {
            file.write_all(script.as_bytes())?;
            if effective_uid() == 0 && !sudo && get_exec_user().is_some() {
                // Keep the per-run directory and script root-owned. The
                // sandbox user only gets group read/traverse access; if it
                // owned either path, an existing same-UID process could
                // chmod/replace run.sh after the path appears in argv but
                // before bash opens it.
                let sandbox_gid = crate::user::sandbox_user_gid()?;
                let script_dir_file = File::open(&script_dir)?;
                fchown_group(file.as_raw_fd(), sandbox_gid)?;
                file.set_permissions(fs::Permissions::from_mode(0o440))?;
                fchown_group(script_dir_file.as_raw_fd(), sandbox_gid)?;
                fs::set_permissions(&script_dir, fs::Permissions::from_mode(0o710))?;
            } else {
                file.set_permissions(fs::Permissions::from_mode(0o400))?;
            }
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
    // Find a safe UTF-8 boundary at or before the max length.
    let mut end = COMMAND_PREVIEW_MAX_LEN;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
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
/// streaming spawned processes.
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
    use std::sync::{Arc, Barrier};
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

    #[cfg(target_os = "linux")]
    fn open_pidfd(pid: libc::pid_t) -> std::io::Result<std::os::fd::OwnedFd> {
        use std::os::fd::FromRawFd;

        // SAFETY: `pidfd_open` does not dereference user pointers. On success
        // it returns a new file descriptor owned by this process.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        // SAFETY: `fd` is a fresh descriptor returned by `pidfd_open` above.
        Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as std::os::fd::RawFd) })
    }

    #[cfg(target_os = "linux")]
    fn wait_for_pidfd_exit(
        pidfd: &std::os::fd::OwnedFd,
        timeout: Duration,
    ) -> std::io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
            let mut pollfd = libc::pollfd {
                fd: std::os::fd::AsRawFd::as_raw_fd(pidfd),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: `pollfd` points to one initialized descriptor entry.
            let result = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
            if result > 0 {
                let revents = pollfd.revents;
                if revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                    return Err(std::io::Error::other("pidfd became invalid while polling"));
                }
                if revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                    return Ok(true);
                }
                return Err(std::io::Error::other(format!(
                    "unexpected pidfd poll revents: {revents:#x}"
                )));
            }
            if result == 0 {
                return Ok(false);
            }
            let err = std::io::Error::last_os_error();
            if err.kind() != std::io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
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
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let guard = TempDirGuard(dir.clone());
        (dir, guard)
    }

    #[cfg(target_os = "linux")]
    fn kill_spawned_child(child: &mut Option<Child>) {
        if let Some(child) = child.take() {
            crate::process::kill_and_reap_child(child);
        }
    }

    #[cfg(target_os = "linux")]
    fn signal_pidfd(pidfd: &std::os::fd::OwnedFd, signal: libc::c_int) -> std::io::Result<()> {
        // SAFETY: best-effort cleanup of a test-owned background process.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                std::os::fd::AsRawFd::as_raw_fd(pidfd),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(err)
    }

    #[cfg(target_os = "linux")]
    fn kill_pidfd_and_wait(pidfd: &std::os::fd::OwnedFd) -> std::io::Result<()> {
        signal_pidfd(pidfd, libc::SIGKILL)?;
        if wait_for_pidfd_exit(pidfd, Duration::from_secs(1))? {
            return Ok(());
        }

        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out waiting for pidfd process to exit after SIGKILL",
        ))
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
        assert!(script.contains("rm -f -- \"$script_path\" 2>/dev/null || true"));
        assert!(script.contains("rmdir -- \"$script_dir\" 2>/dev/null || true"));
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
    fn env_script_content_rejects_nul_command() {
        let dir = Path::new("/run/vm0-exec/vm0-env-test");
        let path = dir.join("run.sh");
        let err = build_env_script_content(dir, &path, "echo before\0after", &[("FOO", "x")])
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("command contains NUL bytes"));
    }

    #[test]
    fn env_script_content_rejects_nul_env_value() {
        let dir = Path::new("/run/vm0-exec/vm0-env-test");
        let path = dir.join("run.sh");
        let err = build_env_script_content(dir, &path, "echo hi", &[("SECRET", "before\0after")])
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(
            err.to_string()
                .contains("environment variable value contains NUL bytes: SECRET")
        );
        assert!(!err.to_string().contains("before"));
        assert!(!err.to_string().contains("after"));
    }

    #[test]
    fn create_env_script_cleans_dir_on_script_build_failure() {
        let (dir, _guard) = temp_dir("build-failure-cleanup");
        let err = match create_env_script_in_dir(&dir, "echo hi", &[("BAD;KEY", "x")], true) {
            Ok(_) => panic!("invalid env key unexpectedly created an env script"),
            Err(err) => err,
        };

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        let entries = std::fs::read_dir(&dir)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            entries.is_empty(),
            "env script entries leaked after build failure: {entries:?}"
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
    fn env_diagnostics_reports_largest_five_in_stable_order() {
        let diagnostics = format_env_diagnostics(
            "cmd",
            &[
                ("Z", "1"),
                ("B", "22"),
                ("A", "22"),
                ("C", "333"),
                ("D", "4444"),
                ("E", "55555"),
                ("F", "666666"),
            ],
        );

        assert!(diagnostics.contains("env_count=7"));
        assert!(diagnostics.contains("largest_env=[F:6,E:5,D:4,C:3,A:2]"));
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
    fn env_script_dir_creation_tolerates_concurrent_first_use() {
        let (base, _guard) = temp_dir("dir-race");
        let dir = base.join("vm0-exec");
        let thread_count = 8;
        let barrier = Arc::new(Barrier::new(thread_count));
        let handles = (0..thread_count)
            .map(|_| {
                let dir = dir.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure_env_script_dir(&dir)
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        assert!(dir.is_dir());
    }

    #[test]
    fn env_script_dir_rejects_existing_file() {
        let (base, _guard) = temp_dir("dir-file");
        let path = base.join("vm0-exec");
        std::fs::write(&path, "not a directory").unwrap();

        let err = ensure_env_script_dir(&path).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(path.is_file());
    }

    #[test]
    fn env_script_dir_rejects_group_or_world_writable_directory() {
        let (base, _guard) = temp_dir("dir-mode");
        let dir = base.join("vm0-exec");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();

        let err = ensure_env_script_dir(&dir).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
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
    fn stale_env_script_cleanup_preserves_recent_directories() {
        let (dir, _guard) = temp_dir("recent-dir");
        let active = dir.join(format!("{ENV_SCRIPT_PREFIX}active"));
        std::fs::create_dir(&active).unwrap();
        std::fs::write(active.join("run.sh"), "secret").unwrap();

        let removed =
            cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::from_secs(60 * 60))
                .unwrap();

        assert_eq!(removed, 0);
        assert!(active.exists());
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

        let boundary = format!("{}🔥tail", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 4));
        assert_eq!(
            truncate_preview(&boundary),
            format!("{}🔥...", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 4))
        );

        let crossing = format!("{}🔥tail", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 1));
        assert_eq!(
            truncate_preview(&crossing),
            format!("{}...", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 1))
        );
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

    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_in_own_process_group_timeout_kills_background_child() {
        let (dir, _guard) = temp_dir("pg");
        let ready = dir.join("ready");
        let background_pid = dir.join("background-pid");
        let ready_arg = shell_escape_value(ready.to_str().unwrap());
        let background_pid_arg = shell_escape_value(background_pid.to_str().unwrap());
        let script = format!(
            "trap '' HUP; tail -f /dev/null & echo $! > {background_pid_arg}; \
             touch {ready_arg}; wait"
        );

        let mut command = build_exec_command(&script, false);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = Some(spawn_in_own_process_group(&mut command).unwrap());
        if !wait_for_path(&ready, Duration::from_secs(2)) {
            kill_spawned_child(&mut child);
            panic!("background child should be started before timeout kill is tested");
        }
        let background_pid_text = match std::fs::read_to_string(&background_pid) {
            Ok(pid) => pid,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to read background pid: {e}");
            }
        };
        let background_pid: libc::pid_t = match background_pid_text.trim().parse() {
            Ok(pid) => pid,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to parse background pid {background_pid_text:?}: {e}");
            }
        };
        let background_pidfd = match open_pidfd(background_pid) {
            Ok(pidfd) => pidfd,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to open pidfd for pid {background_pid}: {e}");
            }
        };

        let outcome = wait_with_kill_timeout(child.take().unwrap(), 100);
        if !matches!(outcome, WaitOutcome::TimedOut) {
            kill_pidfd_and_wait(&background_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up background pidfd: {e}"));
            panic!("expected timeout kill to return WaitOutcome::TimedOut");
        }

        match wait_for_pidfd_exit(&background_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&background_pidfd)
                    .unwrap_or_else(|e| panic!("failed to clean up background pidfd: {e}"));
                panic!(
                    "timeout kill should terminate background pid {background_pid} in the process group"
                );
            }
            Err(e) => {
                let cleanup = kill_pidfd_and_wait(&background_pidfd);
                panic!(
                    "failed to wait for background pid {background_pid} exit: {e}; cleanup={cleanup:?}"
                );
            }
        }
    }
}
