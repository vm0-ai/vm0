//! Fork-like clone3 followed by a strictly prepared, syscall-only child path.
//!
//! This is not libc fork: no allocator, libc setxid coordination, atfork
//! callbacks, Rust unwinding or destructors may run in the copied child.

use std::collections::BTreeMap;
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::time::{Duration, Instant};

use crate::contained_command::{CommandStdio, ContainedChild, ContainedCommand};
use crate::process::{kill_and_reap_child, private_descriptor};
use crate::user::UserCredentials;

const CLONE_CLEAR_SIGHAND: u64 = 1 << 32;
const CLONE_INTO_CGROUP: u64 = 1 << 33;
const CLOSE_RANGE_CLOEXEC: u32 = 1 << 2;
const EXEC_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

// Linux UAPI clone_args, including the v2 cgroup field (Linux 5.7).
#[repr(C)]
#[derive(Default)]
struct CloneArguments {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

struct PreparedStdio {
    child: Option<OwnedFd>,
    parent: Option<OwnedFd>,
}

impl PreparedStdio {
    fn new(value: CommandStdio, input: bool) -> io::Result<Self> {
        match value {
            CommandStdio::Inherit => Ok(Self {
                child: None,
                parent: None,
            }),
            CommandStdio::Owned(fd) => Ok(Self {
                child: Some(private_descriptor(fd)?),
                parent: None,
            }),
            CommandStdio::Piped => {
                let (reader, writer) = pipe()?;
                let (child, parent) = if input {
                    (reader, writer)
                } else {
                    (writer, reader)
                };
                Ok(Self {
                    child: Some(child),
                    parent: Some(parent),
                })
            }
        }
    }
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [0; 2];
    // SAFETY: pipe2 initializes both slots on success, atomically CLOEXEC.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let [reader, writer] = descriptors;
    // SAFETY: each new descriptor is transferred to exactly one owner before
    // either fallible normalization, so partial setup cannot leak the other.
    let reader = unsafe { OwnedFd::from_raw_fd(reader) };
    // SAFETY: this is the distinct writer returned by pipe2.
    let writer = unsafe { OwnedFd::from_raw_fd(writer) };
    Ok((private_descriptor(reader)?, private_descriptor(writer)?))
}

fn cstring(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul byte in process input"))
}

fn executable_paths(
    program: &OsStr,
    environment: &BTreeMap<OsString, OsString>,
) -> io::Result<Vec<CString>> {
    let bytes = program.as_bytes();
    if bytes.contains(&b'/') || bytes.is_empty() {
        return Ok(vec![cstring(program)?]);
    }
    let path = environment
        .get(OsStr::new("PATH"))
        .map(|path| path.as_bytes());
    // The deployed musl execvp default. Explicit/empty PATH still wins.
    let path = path.unwrap_or(b"/usr/local/bin:/bin:/usr/bin");
    path.split(|byte| *byte == b':')
        .map(|directory| {
            let mut candidate = directory.to_vec();
            if !candidate.is_empty() {
                candidate.push(b'/');
            }
            candidate.extend_from_slice(bytes);
            cstring(OsStr::from_bytes(&candidate))
        })
        .collect()
}

pub(crate) fn spawn(
    command: ContainedCommand,
    cgroup: BorrowedFd<'_>,
    credentials: Option<&UserCredentials>,
    deny_process_inspection: bool,
) -> io::Result<ContainedChild> {
    let mut environment: BTreeMap<OsString, OsString> = if command.inherit_environment {
        std::env::vars_os().collect()
    } else {
        BTreeMap::new()
    };
    environment.extend(command.environment);
    let paths = executable_paths(&command.program, &environment)?;
    let arguments: Vec<CString> = std::iter::once(&command.program)
        .chain(command.args.iter())
        .map(|value| cstring(value))
        .collect::<io::Result<_>>()?;
    let argv: Vec<_> = arguments
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let environment: Vec<CString> = environment
        .into_iter()
        .map(|(key, value)| {
            if key.as_bytes().contains(&b'=') {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "equals sign in environment key",
                ));
            }
            let mut entry = key.into_encoded_bytes();
            entry.push(b'=');
            entry.extend(value.into_encoded_bytes());
            cstring(OsStr::from_bytes(&entry))
        })
        .collect::<io::Result<_>>()?;
    let envp: Vec<_> = environment
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let directory = command
        .directory
        .as_ref()
        .map(|path| cstring(path.as_os_str()))
        .transpose()?;
    let stdin = PreparedStdio::new(command.stdin, true)?;
    let stdout = PreparedStdio::new(command.stdout, false)?;
    let stderr = PreparedStdio::new(command.stderr, false)?;
    let (error_reader, error_writer) = pipe()?;
    // SAFETY: a zeroed sigaction with SIG_DFL is a valid reset disposition.
    let mut sigpipe: libc::sigaction = unsafe { std::mem::zeroed() };
    sigpipe.sa_sigaction = libc::SIG_DFL;
    let inputs = ChildInputs {
        paths: &paths,
        search_path: !command.program.as_bytes().contains(&b'/') && !command.program.is_empty(),
        argv: &argv,
        envp: &envp,
        directory: directory.as_deref(),
        credentials,
        deny_process_inspection,
        stdio: [
            stdin.child.as_ref(),
            stdout.child.as_ref(),
            stderr.child.as_ref(),
        ]
        .map(|fd| fd.map(AsRawFd::as_raw_fd)),
        error_fd: error_writer.as_raw_fd(),
        sigpipe: &sigpipe,
    };
    let arguments = CloneArguments {
        flags: CLONE_INTO_CGROUP | CLONE_CLEAR_SIGHAND,
        exit_signal: libc::SIGCHLD as u64,
        cgroup: cgroup.as_raw_fd() as u64,
        ..CloneArguments::default()
    };
    let old_mask = set_signal_mask(u64::MAX)?;
    // SAFETY: without CLONE_VM/FILES/THREAD, the child owns its copied address
    // space, stack and descriptor table. All referenced input is prepared and
    // live. Its branch never returns, allocates, unwinds or calls Rust Drop.
    let pid = unsafe { libc::syscall(libc::SYS_clone3, &arguments, size_of::<CloneArguments>()) };
    if pid == 0 {
        child_exec(&inputs, old_mask);
    }
    let clone_error = (pid < 0).then(io::Error::last_os_error);
    let restore = set_signal_mask(old_mask);
    if let Some(error) = clone_error {
        restore?;
        return Err(error);
    }
    let mut child = ContainedChild::direct(pid as libc::pid_t);
    child.stdin = stdin.parent.map(Into::into);
    child.stdout = stdout.parent.map(Into::into);
    child.stderr = stderr.parent.map(Into::into);
    drop((stdin.child, stdout.child, stderr.child, error_writer));
    if let Err(error) = restore.and_then(|_| exec_handshake(error_reader)) {
        kill_and_reap_child(child);
        return Err(error);
    }
    Ok(child)
}

fn set_signal_mask(mask: u64) -> io::Result<u64> {
    let mut old = 0u64;
    // SAFETY: Linux uses a 64-bit kernel signal set on both supported guest
    // architectures. This masks only the calling thread, including libc's
    // reserved signals, which pthread_sigmask deliberately leaves unblocked.
    if unsafe {
        libc::syscall(
            libc::SYS_rt_sigprocmask,
            libc::SIG_SETMASK,
            &mask,
            &mut old,
            size_of::<u64>(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(old)
}

fn exec_handshake(reader: OwnedFd) -> io::Result<()> {
    let deadline = Instant::now() + EXEC_HANDSHAKE_TIMEOUT;
    let mut reader = File::from(reader);
    let mut poll = libc::pollfd {
        fd: reader.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let timeout = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: poll points to one initialized descriptor record.
        let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
        if ready == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process exec handshake timed out",
            ));
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let mut bytes = [0; size_of::<i32>()];
        match reader.read(&mut bytes) {
            Ok(0) => return Ok(()),
            Ok(4) => return Err(io::Error::from_raw_os_error(i32::from_ne_bytes(bytes))),
            Ok(_) => return Err(io::Error::other("incomplete process exec error")),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

struct ChildInputs<'a> {
    paths: &'a [CString],
    search_path: bool,
    argv: &'a [*const libc::c_char],
    envp: &'a [*const libc::c_char],
    directory: Option<&'a CStr>,
    credentials: Option<&'a UserCredentials>,
    deny_process_inspection: bool,
    stdio: [Option<RawFd>; 3],
    error_fd: RawFd,
    sigpipe: &'a libc::sigaction,
}

fn child_exec(inputs: &ChildInputs<'_>, old_mask: u64) -> ! {
    // SAFETY: exclusive copied-child path. Every pointer refers to immutable
    // parent-prepared storage. All called operations are raw syscalls or
    // async-signal-safe sigaction; no libc threaded credential coordination.
    unsafe {
        if libc::syscall(libc::SYS_setpgid, 0, 0) != 0 {
            child_errno(inputs.error_fd);
        }
        for (target, source) in inputs.stdio.iter().enumerate() {
            if let Some(source) = source
                && libc::syscall(libc::SYS_dup3, *source, target as RawFd, 0) < 0
            {
                child_errno(inputs.error_fd);
            }
        }
        if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) != 0 {
            child_errno(inputs.error_fd);
        }
        if let Some(credentials) = inputs.credentials
            && (libc::syscall(
                libc::SYS_setgroups,
                credentials.groups.len(),
                credentials.groups.as_ptr(),
            ) != 0
                || libc::syscall(libc::SYS_setgid, credentials.gid) != 0
                || libc::syscall(libc::SYS_setuid, credentials.uid) != 0)
        {
            child_errno(inputs.error_fd);
        }
        if let Some(directory) = inputs.directory
            && libc::syscall(libc::SYS_chdir, directory.as_ptr()) != 0
        {
            child_errno(inputs.error_fd);
        }
        // setuid can reset dumpability, so preserve the existing ordering.
        if inputs.deny_process_inspection
            && libc::syscall(libc::SYS_prctl, libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
        {
            child_errno(inputs.error_fd);
        }
        if libc::sigaction(libc::SIGPIPE, inputs.sigpipe, std::ptr::null_mut()) != 0
            || libc::syscall(
                libc::SYS_rt_sigprocmask,
                libc::SIG_SETMASK,
                &old_mask,
                std::ptr::null_mut::<u64>(),
                size_of::<u64>(),
            ) != 0
        {
            child_errno(inputs.error_fd);
        }
        let mut missing_error = libc::ENOENT;
        for path in inputs.paths {
            libc::syscall(
                libc::SYS_execve,
                path.as_ptr(),
                inputs.argv.as_ptr(),
                inputs.envp.as_ptr(),
            );
            let error = *libc::__errno_location();
            if !inputs.search_path {
                child_error(inputs.error_fd, error);
            }
            match error {
                libc::EACCES => missing_error = error,
                libc::ENOENT | libc::ENOTDIR => {}
                _ => child_error(inputs.error_fd, error),
            }
        }
        child_error(inputs.error_fd, missing_error);
    }
}

fn child_errno(error_fd: RawFd) -> ! {
    // SAFETY: errno is copied thread-local scalar state, not a libc lock.
    child_error(error_fd, unsafe { *libc::__errno_location() });
}

fn child_error(error_fd: RawFd, error: i32) -> ! {
    // SAFETY: this empty CLOEXEC pipe has exactly one child writer. The
    // four-byte write is atomic. _exit never runs parent-owned destructors.
    unsafe {
        loop {
            if libc::syscall(libc::SYS_write, error_fd, &error, size_of::<i32>()) >= 0
                || *libc::__errno_location() != libc::EINTR
            {
                break;
            }
        }
        libc::_exit(127);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsFd;
    use std::process::Command;

    fn signal_mask() -> u64 {
        let mut mask = 0u64;
        // SAFETY: null new-set only reads the current thread's kernel mask.
        assert_eq!(
            unsafe {
                libc::syscall(
                    libc::SYS_rt_sigprocmask,
                    libc::SIG_SETMASK,
                    std::ptr::null::<u64>(),
                    &mut mask,
                    size_of::<u64>(),
                )
            },
            0
        );
        mask
    }

    #[test]
    fn rejected_cgroup_never_falls_back_or_changes_the_parent_mask() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-exist");
        let not_a_cgroup = File::open(directory.path()).unwrap();
        let before = signal_mask();
        let mut command = ContainedCommand::new("/bin/sh");
        command
            .arg("-c")
            .arg("touch \"$MARKER\"")
            .env("MARKER", &marker);
        match spawn(command, not_a_cgroup.as_fd(), None, false) {
            Err(error) => assert!(error.raw_os_error().is_some(), "{error}"),
            Ok(child) => {
                kill_and_reap_child(child);
                panic!("an ordinary directory cannot authorize a cgroup launch");
            }
        }
        assert_eq!(signal_mask(), before);
        assert!(!marker.exists());
    }

    #[test]
    fn malformed_launch_inputs_fail_before_child_creation() {
        let directory = tempfile::tempdir().unwrap();
        let descriptor = File::open(directory.path()).unwrap();
        for invalid in ["argument", "environment", "directory"] {
            let mut command = ContainedCommand::new("/bin/true");
            match invalid {
                "argument" => {
                    command.arg("bad\0argument");
                }
                "environment" => {
                    command.env("bad=key", "value");
                }
                _ => {
                    command.current_dir("bad\0directory");
                }
            }
            let error = match spawn(command, descriptor.as_fd(), None, false) {
                Err(error) => error,
                Ok(child) => {
                    kill_and_reap_child(child);
                    panic!("invalid input unexpectedly spawned");
                }
            };
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn private_pipes_preserve_closed_standard_descriptors() {
        const CHILD_ENV: &str = "OKOU_TEST_PRIVATE_PIPE_CHILD";
        if std::env::var_os(CHILD_ENV).is_some() {
            // Close after Rust startup, which repairs inherited closed stdio.
            // This process runs only this test and exits before harness output.
            for fd in [0, 1, 2] {
                // SAFETY: only this isolated process loses its standard fds.
                unsafe { libc::close(fd) };
            }
            let (reader, writer) = pipe().unwrap();
            assert!(reader.as_raw_fd() > 2 && writer.as_raw_fd() > 2);
            for fd in [0, 1, 2] {
                // SAFETY: fcntl only probes whether this descriptor is open.
                assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
                assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
            }
            // The isolated child intentionally has no harness output fds.
            // SAFETY: all assertions completed; the OS owns final fd cleanup.
            unsafe { libc::_exit(0) };
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "cgroup_spawn::tests::private_pipes_preserve_closed_standard_descriptors",
            ])
            .env(CHILD_ENV, "1");
        assert!(command.status().unwrap().success());
    }
}
