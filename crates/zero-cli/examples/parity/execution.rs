use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::pty::{Winsize, openpty};
use tempfile::{Builder, TempDir};

use crate::compare::normalize_observation;
use crate::http::MockServer;
use crate::model::{
    Case, FilesystemEntry, FilesystemEntryKind, Observation, RuntimeValues, RustExecution,
    SeedEntry, TerminalMode, Termination,
};
use crate::{HarnessError, NPX_MARKER_ENV, NPX_TARGET_ENV, RUST_EXECUTION_ENV, Result};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const PTY_COLUMNS: u16 = 100;
const PTY_ROWS: u16 = 30;

#[derive(Clone, Copy, Debug)]
pub enum Implementation {
    Typescript,
    Rust,
}

impl Implementation {
    fn label(self) -> &'static str {
        match self {
            Self::Typescript => "TypeScript",
            Self::Rust => "Rust",
        }
    }

    fn temp_prefix(self) -> &'static str {
        match self {
            Self::Typescript => "zero-cli-parity-typescript-",
            Self::Rust => "zero-cli-parity-rust-",
        }
    }
}

struct IsolatedRuntime {
    _root: TempDir,
    workspace: PathBuf,
    home: PathBuf,
    temp: PathBuf,
    bin: PathBuf,
    npx_marker: PathBuf,
}

struct ProcessOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: ExitStatus,
}

struct ProcessGroupChild {
    child: Child,
    process_group: libc::pid_t,
    wait_id: libc::id_t,
    group_terminated: bool,
    reaped: bool,
}

struct ProcessWorkers {
    stdin: JoinHandle<io::Result<()>>,
    stdout: JoinHandle<io::Result<Vec<u8>>>,
    stderr: JoinHandle<io::Result<Vec<u8>>>,
}

struct WorkerResults {
    stdin: Result<()>,
    stdout: Result<Vec<u8>>,
    stderr: Result<Vec<u8>>,
}

impl ProcessGroupChild {
    fn spawn(command: &mut Command, description: &str) -> Result<Self> {
        command.process_group(0);
        let child = command
            .spawn()
            .map_err(|error| HarnessError::new(format!("spawn {description}: {error}")))?;
        Self::new(child)
    }

    fn new(mut child: Child) -> Result<Self> {
        let child_id = child.id();
        let process_group = libc::pid_t::try_from(child_id).ok();
        let wait_id = libc::id_t::try_from(child_id).ok();
        // SAFETY: `getpgrp` has no pointer or lifetime preconditions.
        let current_process_group = unsafe { libc::getpgrp() };
        let Some((process_group, wait_id)) = process_group
            .zip(wait_id)
            .filter(|(group, _)| *group > 1 && *group != current_process_group)
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(HarnessError::new(format!(
                "spawned child PID {child_id} is not a safe process-group ID"
            )));
        };
        Ok(Self {
            child,
            process_group,
            wait_id,
            group_terminated: false,
            reaped: false,
        })
    }

    fn exited_without_reaping(&self) -> io::Result<bool> {
        loop {
            let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: `wait_id` identifies the live direct child owned by `self`,
            // and `information` points to writable storage for `siginfo_t`.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.wait_id,
                    information.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                // SAFETY: successful `waitid` initializes `siginfo_t`; a zero PID
                // is the specified WNOHANG result when the child is still alive.
                let information = unsafe { information.assume_init() };
                return Ok(unsafe { information.si_pid() } != 0);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn terminate_group(&mut self) -> io::Result<()> {
        if self.group_terminated {
            return Ok(());
        }
        // SAFETY: `process_group` is the validated PID of an unreaped child
        // spawned with `process_group(0)`, so the negative target cannot name
        // the harness process group.
        let result = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        if result == 0 {
            self.group_terminated = true;
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            self.group_terminated = true;
            return Ok(());
        }
        Err(error)
    }

    fn reap(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.reaped = true;
        Ok(status)
    }
}

impl Drop for ProcessGroupChild {
    fn drop(&mut self) {
        if !self.group_terminated {
            let _ = self.terminate_group();
        }
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl ProcessWorkers {
    fn join(self) -> WorkerResults {
        WorkerResults {
            stdin: join_stdin_writer(self.stdin),
            stdout: join_reader(self.stdout, "stdout"),
            stderr: join_reader(self.stderr, "stderr"),
        }
    }
}

pub fn observe(
    implementation: Implementation,
    executable: &Path,
    typescript_executable: &Path,
    harness_executable: &Path,
    case: &Case,
) -> Result<Observation> {
    let runtime = IsolatedRuntime::new(implementation, harness_executable, case)?;
    let server = MockServer::start(&case.mock_http)?;
    let runtime_values = RuntimeValues {
        workspace_path: display_path(&runtime.workspace),
        mock_http_url: server.url().to_owned(),
        home_path: display_path(&runtime.home),
        temp_path: display_path(&runtime.temp),
    };
    let command = build_command(
        implementation,
        executable,
        typescript_executable,
        &runtime,
        &runtime_values,
        case,
    )?;
    let process_result = run_process(command, case);
    let execution_result =
        validate_rust_execution(implementation, case.rust_execution, &runtime.npx_marker);
    let http_result = server.finish();
    let process = process_result.map_err(|error| {
        HarnessError::new(format!(
            "{} execution failed: {error}",
            implementation.label()
        ))
    })?;
    execution_result?;
    let requests = http_result.map_err(|error| {
        HarnessError::new(format!(
            "{} mock HTTP service failed: {error}",
            implementation.label()
        ))
    })?;
    validate_http_exchanges(implementation, case, &requests)?;

    let filesystem = snapshot_filesystem(&runtime.workspace).map_err(|error| {
        HarnessError::new(format!(
            "snapshot {} case filesystem: {error}",
            implementation.label()
        ))
    })?;
    let mut observation = Observation {
        stdout: process.stdout,
        stderr: process.stderr,
        termination: Termination {
            code: process.status.code(),
            signal: process.status.signal(),
        },
        requests,
        filesystem,
    };
    normalize_observation(&mut observation, case, &runtime_values).map_err(|error| {
        HarnessError::new(format!(
            "normalize {} observation: {error}",
            implementation.label()
        ))
    })?;
    Ok(observation)
}

impl IsolatedRuntime {
    fn new(implementation: Implementation, harness_executable: &Path, case: &Case) -> Result<Self> {
        let root = Builder::new()
            .prefix(implementation.temp_prefix())
            .tempdir()
            .map_err(|error| HarnessError::new(format!("create isolated runtime: {error}")))?;
        let workspace = root.path().join("workspace");
        let home = root.path().join("home");
        let temp = root.path().join("tmp");
        let bin = root.path().join("bin");
        let npx_marker = temp.join("npm-fallback-invoked");
        for directory in [&workspace, &home, &temp, &bin] {
            fs::create_dir_all(directory).map_err(|error| {
                HarnessError::new(format!(
                    "create isolated directory {}: {error}",
                    directory.display()
                ))
            })?;
        }
        symlink(harness_executable, bin.join("npx"))
            .map_err(|error| HarnessError::new(format!("create isolated npx shim: {error}")))?;
        materialize_filesystem(&workspace, &case.filesystem.seed)?;
        let working_directory = workspace.join(&case.working_directory);
        fs::create_dir_all(&working_directory).map_err(|error| {
            HarnessError::new(format!(
                "create case working directory {}: {error}",
                working_directory.display()
            ))
        })?;

        Ok(Self {
            _root: root,
            workspace,
            home,
            temp,
            bin,
            npx_marker,
        })
    }
}

fn build_command(
    implementation: Implementation,
    executable: &Path,
    typescript_executable: &Path,
    runtime: &IsolatedRuntime,
    runtime_values: &RuntimeValues,
    case: &Case,
) -> Result<Command> {
    let inherited_path =
        env::var_os("PATH").ok_or_else(|| HarnessError::new("host PATH is unavailable"))?;
    let mut path_entries = vec![runtime.bin.clone()];
    path_entries.extend(env::split_paths(&inherited_path));
    let isolated_path = env::join_paths(path_entries)
        .map_err(|error| HarnessError::new(format!("construct isolated PATH: {error}")))?;

    let mut command = Command::new(executable);
    command
        .args(&case.argv)
        .current_dir(runtime.workspace.join(&case.working_directory))
        .env_clear()
        .env("HOME", &runtime.home)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("PATH", isolated_path)
        .env("TMPDIR", &runtime.temp)
        .env("TZ", "UTC")
        .env("VM0_API_BACKEND_URL", &runtime_values.mock_http_url)
        .env("XDG_CACHE_HOME", runtime.home.join(".cache"))
        .env(NPX_TARGET_ENV, typescript_executable);

    if matches!(implementation, Implementation::Rust) {
        command
            .env(NPX_MARKER_ENV, &runtime.npx_marker)
            .env(RUST_EXECUTION_ENV, case.rust_execution.as_str());
    }

    match case.terminal_mode {
        TerminalMode::Pipe => {
            command.env("NO_COLOR", "1").env("TERM", "dumb");
        }
        TerminalMode::Pty => {
            command.env("TERM", "xterm-256color");
        }
    }

    for (key, value) in &case.environment {
        command.env(key, expand_runtime_placeholders(value, runtime_values));
    }
    Ok(command)
}

fn validate_rust_execution(
    implementation: Implementation,
    expected: RustExecution,
    marker: &Path,
) -> Result<()> {
    if matches!(implementation, Implementation::Typescript) {
        return Ok(());
    }

    let fallback_invoked = marker.try_exists().map_err(|error| {
        HarnessError::new(format!(
            "inspect npm fallback marker {}: {error}",
            marker.display()
        ))
    })?;
    match (expected, fallback_invoked) {
        (RustExecution::Native, false) | (RustExecution::Fallback, true) => Ok(()),
        (RustExecution::Native, true) => Err(HarnessError::new(
            "fixture requires native Rust execution, but zero-cli invoked npm fallback",
        )),
        (RustExecution::Fallback, false) => Err(HarnessError::new(
            "fixture requires npm fallback, but zero-cli executed natively",
        )),
    }
}

fn expand_runtime_placeholders(value: &str, runtime_values: &RuntimeValues) -> String {
    value
        .replace("${WORKSPACE}", &runtime_values.workspace_path)
        .replace("${MOCK_HTTP_URL}", &runtime_values.mock_http_url)
        .replace("${HOME}", &runtime_values.home_path)
        .replace("${TEMP}", &runtime_values.temp_path)
}

fn run_process(command: Command, case: &Case) -> Result<ProcessOutput> {
    match case.terminal_mode {
        TerminalMode::Pipe => run_piped(command, case.stdin.as_bytes(), case.timeout_ms),
        TerminalMode::Pty => run_pty(command, case.stdin.as_bytes(), case.timeout_ms),
    }
}

fn run_piped(mut command: Command, stdin: &[u8], timeout_ms: u64) -> Result<ProcessOutput> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = ProcessGroupChild::spawn(&mut command, "process")?;
    drop(command);
    let deadline = process_deadline(timeout_ms)?;

    let child_stdin = process
        .child
        .stdin
        .take()
        .ok_or_else(|| HarnessError::new("piped child stdin was not created"))?;
    let child_stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| HarnessError::new("piped child stdout was not created"))?;
    let child_stderr = process
        .child
        .stderr
        .take()
        .ok_or_else(|| HarnessError::new("piped child stderr was not created"))?;

    let workers = ProcessWorkers {
        stdin: spawn_stdin_writer(child_stdin, stdin.to_vec(), false),
        stdout: spawn_reader(child_stdout, false),
        stderr: spawn_reader(child_stderr, false),
    };
    finish_process(process, workers, deadline, timeout_ms)
}

fn run_pty(mut command: Command, stdin: &[u8], timeout_ms: u64) -> Result<ProcessOutput> {
    let winsize = Winsize {
        ws_row: PTY_ROWS,
        ws_col: PTY_COLUMNS,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let stdin_pty = openpty(Some(&winsize), None)
        .map_err(|error| HarnessError::new(format!("open stdin PTY: {error}")))?;
    let stdout_pty = openpty(Some(&winsize), None)
        .map_err(|error| HarnessError::new(format!("open stdout PTY: {error}")))?;
    let stderr_pty = openpty(Some(&winsize), None)
        .map_err(|error| HarnessError::new(format!("open stderr PTY: {error}")))?;

    command
        .stdin(Stdio::from(File::from(stdin_pty.slave)))
        .stdout(Stdio::from(File::from(stdout_pty.slave)))
        .stderr(Stdio::from(File::from(stderr_pty.slave)));
    let process = ProcessGroupChild::spawn(&mut command, "PTY process")?;
    drop(command);
    let deadline = process_deadline(timeout_ms)?;

    let workers = ProcessWorkers {
        stdin: spawn_stdin_writer(File::from(stdin_pty.master), stdin.to_vec(), true),
        stdout: spawn_reader(File::from(stdout_pty.master), true),
        stderr: spawn_reader(File::from(stderr_pty.master), true),
    };
    finish_process(process, workers, deadline, timeout_ms)
}

fn process_deadline(timeout_ms: u64) -> Result<Instant> {
    Instant::now()
        .checked_add(Duration::from_millis(timeout_ms))
        .ok_or_else(|| HarnessError::new("process timeout exceeds supported duration"))
}

fn finish_process(
    mut process: ProcessGroupChild,
    workers: ProcessWorkers,
    deadline: Instant,
    timeout_ms: u64,
) -> Result<ProcessOutput> {
    let wait_result = wait_until_exit(&process, deadline, timeout_ms);
    let termination_result = process
        .terminate_group()
        .map_err(|error| HarnessError::new(format!("terminate process group: {error}")));
    let status_result = process
        .reap()
        .map_err(|error| HarnessError::new(format!("reap process: {error}")));
    let worker_results = workers.join();

    if let Err(primary_error) = wait_result {
        let mut cleanup_errors = Vec::new();
        if let Err(error) = &termination_result {
            cleanup_errors.push(error.to_string());
        }
        if let Err(error) = &status_result {
            cleanup_errors.push(error.to_string());
        }
        if let Err(error) = &worker_results.stdin {
            cleanup_errors.push(error.to_string());
        }
        if let Err(error) = &worker_results.stdout {
            cleanup_errors.push(error.to_string());
        }
        if let Err(error) = &worker_results.stderr {
            cleanup_errors.push(error.to_string());
        }
        if cleanup_errors.is_empty() {
            return Err(primary_error);
        }
        return Err(HarnessError::new(format!(
            "{primary_error}; cleanup failed: {}",
            cleanup_errors.join("; ")
        )));
    }

    termination_result?;
    let status = status_result?;
    worker_results.stdin?;
    let stdout = worker_results.stdout?;
    let stderr = worker_results.stderr?;
    Ok(ProcessOutput {
        stdout,
        stderr,
        status,
    })
}

fn spawn_stdin_writer<W: Write + Send + 'static>(
    mut writer: W,
    stdin: Vec<u8>,
    send_end_of_transmission: bool,
) -> JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        match writer.write_all(&stdin) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
            Err(error) => return Err(error),
        }
        if send_end_of_transmission {
            match writer.write_all(&[4]) {
                Ok(()) => {}
                Err(error) if is_closed_stream_error(&error) => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        writer.flush()
    })
}

fn join_stdin_writer(thread: JoinHandle<io::Result<()>>) -> Result<()> {
    thread
        .join()
        .map_err(|_| HarnessError::new("stdin writer thread panicked"))?
        .map_err(|error| HarnessError::new(format!("write child stdin: {error}")))
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    pty: bool,
) -> JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return Ok(output),
                Ok(read) => {
                    if let Some(bytes) = buffer.get(..read) {
                        output.extend_from_slice(bytes);
                    }
                }
                Err(error) if pty && is_closed_stream_error(&error) => return Ok(output),
                Err(error) => return Err(error),
            }
        }
    })
}

fn join_reader(thread: JoinHandle<io::Result<Vec<u8>>>, stream: &str) -> Result<Vec<u8>> {
    thread
        .join()
        .map_err(|_| HarnessError::new(format!("{stream} reader thread panicked")))?
        .map_err(|error| HarnessError::new(format!("read child {stream}: {error}")))
}

fn is_closed_stream_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::BrokenPipe || error.raw_os_error() == Some(Errno::EIO as i32)
}

fn wait_until_exit(process: &ProcessGroupChild, deadline: Instant, timeout_ms: u64) -> Result<()> {
    loop {
        if process
            .exited_without_reaping()
            .map_err(|error| HarnessError::new(format!("wait for process: {error}")))?
        {
            return Ok(());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(HarnessError::new(format!(
                "process exceeded fixture timeout of {timeout_ms} ms"
            )));
        }
        thread::sleep(PROCESS_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

fn materialize_filesystem(workspace: &Path, entries: &[SeedEntry]) -> Result<()> {
    for entry in entries {
        let path = workspace.join(entry.path());
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                HarnessError::new(format!(
                    "create filesystem fixture parent {}: {error}",
                    parent.display()
                ))
            })?;
        }
        match entry {
            SeedEntry::File { content, .. } => {
                fs::write(&path, content).map_err(|error| {
                    HarnessError::new(format!(
                        "write filesystem fixture {}: {error}",
                        path.display()
                    ))
                })?;
            }
            SeedEntry::Directory { .. } => {
                fs::create_dir_all(&path).map_err(|error| {
                    HarnessError::new(format!(
                        "create filesystem fixture directory {}: {error}",
                        path.display()
                    ))
                })?;
            }
            SeedEntry::Symlink { target, .. } => {
                symlink(target, &path).map_err(|error| {
                    HarnessError::new(format!(
                        "create filesystem fixture symlink {}: {error}",
                        path.display()
                    ))
                })?;
            }
        }
    }

    for entry in entries {
        let path = workspace.join(entry.path());
        match entry {
            SeedEntry::File { mode, .. } | SeedEntry::Directory { mode, .. } => {
                fs::set_permissions(&path, fs::Permissions::from_mode(*mode)).map_err(|error| {
                    HarnessError::new(format!(
                        "set filesystem fixture mode on {}: {error}",
                        path.display()
                    ))
                })?;
            }
            SeedEntry::Symlink { .. } => {}
        }
    }
    Ok(())
}

fn snapshot_filesystem(workspace: &Path) -> Result<Vec<FilesystemEntry>> {
    let mut entries = Vec::new();
    snapshot_directory(workspace, workspace, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn snapshot_directory(
    workspace: &Path,
    directory: &Path,
    entries: &mut Vec<FilesystemEntry>,
) -> Result<()> {
    let children = fs::read_dir(directory).map_err(|error| {
        HarnessError::new(format!(
            "read workspace directory {}: {error}",
            directory.display()
        ))
    })?;
    let mut paths = children
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| HarnessError::new(format!("read workspace entry: {error}")))
        })
        .collect::<Result<Vec<_>>>()?;
    paths.sort();

    for path in paths {
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            HarnessError::new(format!(
                "inspect workspace entry {}: {error}",
                path.display()
            ))
        })?;
        let relative = path.strip_prefix(workspace).map_err(|error| {
            HarnessError::new(format!(
                "resolve workspace-relative path {}: {error}",
                path.display()
            ))
        })?;
        let relative = relative.to_str().ok_or_else(|| {
            HarnessError::new(format!(
                "workspace entry is not valid UTF-8: {}",
                relative.display()
            ))
        })?;
        let mode = metadata.permissions().mode() & 0o7777;
        let file_type = metadata.file_type();
        let kind = if file_type.is_file() {
            FilesystemEntryKind::File(fs::read(&path).map_err(|error| {
                HarnessError::new(format!("read workspace file {}: {error}", path.display()))
            })?)
        } else if file_type.is_dir() {
            FilesystemEntryKind::Directory
        } else if file_type.is_symlink() {
            let target = fs::read_link(&path).map_err(|error| {
                HarnessError::new(format!(
                    "read workspace symlink {}: {error}",
                    path.display()
                ))
            })?;
            FilesystemEntryKind::Symlink(target.to_string_lossy().into_owned())
        } else {
            return Err(HarnessError::new(format!(
                "unsupported workspace entry type: {}",
                path.display()
            )));
        };
        entries.push(FilesystemEntry {
            path: relative.to_owned(),
            mode,
            kind,
        });
        if file_type.is_dir() {
            snapshot_directory(workspace, &path, entries)?;
        }
    }
    Ok(())
}

fn validate_http_exchanges(
    implementation: Implementation,
    case: &Case,
    requests: &[crate::model::RequestObservation],
) -> Result<()> {
    let mut mismatches = Vec::new();
    if requests.len() != case.mock_http.exchanges.len() {
        mismatches.push(format!(
            "request count: expected {}, observed {}",
            case.mock_http.exchanges.len(),
            requests.len()
        ));
    }

    for (index, (exchange, request)) in case.mock_http.exchanges.iter().zip(requests).enumerate() {
        let expected = &exchange.request;
        if request.method != expected.method {
            mismatches.push(format!(
                "request {index} method: expected {:?}, observed {:?}",
                expected.method, request.method
            ));
        }
        if request.path != expected.path {
            mismatches.push(format!(
                "request {index} path: expected {:?}, observed {:?}",
                expected.path, request.path
            ));
        }
        if request.query != expected.query {
            mismatches.push(format!(
                "request {index} query: expected {:?}, observed {:?}",
                expected.query, request.query
            ));
        }
        if request.body != expected.body.as_bytes() {
            mismatches.push(format!(
                "request {index} body: expected {:?}, observed {}",
                expected.body,
                render_bytes(&request.body)
            ));
        }
    }

    if mismatches.is_empty() {
        return Ok(());
    }
    Err(HarnessError::new(format!(
        "{} fixture HTTP contract mismatch:\n    {}",
        implementation.label(),
        mismatches.join("\n    ")
    )))
}

fn render_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(value) => format!("{value:?}"),
        Err(_) => bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    const DESCENDANT_PID_PATH_ENV: &str = "ZERO_CLI_PARITY_DESCENDANT_PID_PATH";
    const TEST_EXECUTION_BOUND: Duration = Duration::from_secs(5);
    const TEST_CLEANUP_BOUND: Duration = Duration::from_secs(5);
    const TEST_SYNC_INTERVAL: Duration = Duration::from_millis(10);

    struct DescendantProcess {
        pid: libc::pid_t,
        armed: bool,
    }

    impl DescendantProcess {
        fn terminate(&mut self) {
            if self.armed {
                // SAFETY: the PID was written by the isolated test shell,
                // validated as positive, and is signalled only for test cleanup.
                unsafe {
                    libc::kill(self.pid, libc::SIGKILL);
                }
                self.armed = false;
            }
        }

        fn disarm(&mut self) {
            self.armed = false;
        }
    }

    impl Drop for DescendantProcess {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    fn run_descendant_case(
        terminal_mode: TerminalMode,
        script: &str,
        stdin: Vec<u8>,
        timeout_ms: u64,
    ) -> Result<ProcessOutput> {
        let temp = tempfile::tempdir().unwrap();
        let pid_path = temp.path().join("processes");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .env(DESCENDANT_PID_PATH_ENV, &pid_path);
        let (result_sender, result_receiver) = mpsc::channel();
        let execution = thread::spawn(move || {
            let result = match terminal_mode {
                TerminalMode::Pipe => run_piped(command, &stdin, timeout_ms),
                TerminalMode::Pty => run_pty(command, &stdin, timeout_ms),
            };
            result_sender.send(result).unwrap();
        });
        let mut descendant = wait_for_descendant_process(&pid_path);

        let result = match result_receiver.recv_timeout(TEST_EXECUTION_BOUND) {
            Ok(result) => result,
            Err(error) => {
                descendant.terminate();
                let cleanup = result_receiver.recv_timeout(TEST_CLEANUP_BOUND);
                let joined = cleanup.is_ok().then(|| execution.join());
                assert!(
                    cleanup.is_ok(),
                    "test process cleanup did not finish: {error}"
                );
                assert!(joined.unwrap().is_ok(), "execution thread panicked");
                panic!("parity execution exceeded the test-owned bound: {error}");
            }
        };
        execution.join().unwrap();

        let descendant_terminated = wait_for_process_termination(descendant.pid);
        if !descendant_terminated {
            descendant.terminate();
        } else {
            descendant.disarm();
        }
        assert!(
            descendant_terminated,
            "descendant {} remained alive after parity execution",
            descendant.pid
        );
        result
    }

    fn wait_for_descendant_process(path: &Path) -> DescendantProcess {
        let deadline = Instant::now() + TEST_EXECUTION_BOUND;
        loop {
            match fs::read_to_string(path) {
                Ok(value) => {
                    let mut pids = value.split_ascii_whitespace();
                    let descendant = pids.next().and_then(|pid| pid.parse().ok());
                    if let (Some(pid), None) = (descendant, pids.next())
                        && pid > 1
                    {
                        return DescendantProcess { pid, armed: true };
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => panic!("read child process IDs: {error}"),
            }
            assert!(
                Instant::now() < deadline,
                "child process IDs were not published"
            );
            thread::sleep(TEST_SYNC_INTERVAL);
        }
    }

    fn wait_for_process_termination(pid: libc::pid_t) -> bool {
        let deadline = Instant::now() + TEST_CLEANUP_BOUND;
        loop {
            if !process_is_live(pid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(TEST_SYNC_INTERVAL);
        }
    }

    #[cfg(target_os = "linux")]
    fn process_is_live(pid: libc::pid_t) -> bool {
        let status = match fs::read_to_string(format!("/proc/{pid}/status")) {
            Ok(status) => status,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        };
        !status.lines().any(|line| {
            line.strip_prefix("State:")
                .and_then(|state| state.split_ascii_whitespace().next())
                == Some("Z")
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn process_is_live(pid: libc::pid_t) -> bool {
        // SAFETY: signal zero only probes the positive PID parsed from the
        // isolated test shell and does not alter the process.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[test]
    fn validates_native_and_fallback_execution_markers() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("npm-fallback-invoked");

        validate_rust_execution(Implementation::Rust, RustExecution::Native, &marker).unwrap();
        assert!(
            validate_rust_execution(Implementation::Rust, RustExecution::Fallback, &marker)
                .is_err()
        );

        fs::write(&marker, b"invoked").unwrap();
        validate_rust_execution(Implementation::Rust, RustExecution::Fallback, &marker).unwrap();
        assert!(
            validate_rust_execution(Implementation::Rust, RustExecution::Native, &marker).is_err()
        );
    }

    #[test]
    fn pty_execution_connects_all_standard_streams_to_terminals() {
        if cfg!(target_os = "linux") && !Path::new("/dev/pts").is_dir() {
            eprintln!("PTY integration probe skipped: /dev/pts is unavailable");
            return;
        }

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"
stdin_mode=pipe
stdout_mode=pipe
stderr_mode=pipe
[ -t 0 ] && stdin_mode=tty
[ -t 1 ] && stdout_mode=tty
[ -t 2 ] && stderr_mode=tty
IFS= read -r payload
printf 'stdin=%s;stdout=%s;input=%s' "$stdin_mode" "$stdout_mode" "$payload"
printf 'stderr=%s' "$stderr_mode" >&2
"#,
        );

        let output = run_pty(command, b"fixture-input\n", 2_000).unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout, b"stdin=tty;stdout=tty;input=fixture-input");
        assert_eq!(output.stderr, b"stderr=tty");
    }

    #[test]
    fn piped_execution_terminates_descendant_after_direct_child_exit() {
        let output = run_descendant_case(
            TerminalMode::Pipe,
            r#"
sleep 60 &
descendant=$!
printf '%s\n' "$descendant" > "$ZERO_CLI_PARITY_DESCENDANT_PID_PATH"
printf 'before-exit'
exit 0
"#,
            vec![b'x'; 1024 * 1024],
            500,
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout, b"before-exit");
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn pty_execution_terminates_descendant_after_direct_child_exit() {
        let output = run_descendant_case(
            TerminalMode::Pty,
            r#"
sleep 60 &
descendant=$!
printf '%s\n' "$descendant" > "$ZERO_CLI_PARITY_DESCENDANT_PID_PATH"
printf 'before-exit'
exit 0
"#,
            Vec::new(),
            500,
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout, b"before-exit");
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn timed_out_execution_terminates_descendant_and_blocked_stdin_writer() {
        let result = run_descendant_case(
            TerminalMode::Pipe,
            r#"
sleep 60 &
descendant=$!
printf '%s\n' "$descendant" > "$ZERO_CLI_PARITY_DESCENDANT_PID_PATH"
wait "$descendant"
"#,
            vec![b'x'; 1024 * 1024],
            100,
        );
        let error = match result {
            Ok(_) => panic!("timed-out execution unexpectedly succeeded"),
            Err(error) => error,
        };

        assert_eq!(
            error.to_string(),
            "process exceeded fixture timeout of 100 ms"
        );
    }

    #[test]
    fn filesystem_snapshot_records_content_modes_and_links() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let entries = vec![
            SeedEntry::Directory {
                path: PathBuf::from("nested"),
                mode: 0o750,
            },
            SeedEntry::File {
                path: PathBuf::from("nested/value.txt"),
                content: "value".to_owned(),
                mode: 0o640,
            },
            SeedEntry::Symlink {
                path: PathBuf::from("link"),
                target: PathBuf::from("nested/value.txt"),
            },
        ];
        materialize_filesystem(&workspace, &entries).unwrap();

        let snapshot = snapshot_filesystem(&workspace).unwrap();

        assert_eq!(snapshot.len(), 3);
        assert!(snapshot.iter().any(|entry| {
            entry.path == "nested/value.txt"
                && entry.mode == 0o640
                && entry.kind == FilesystemEntryKind::File(b"value".to_vec())
        }));
        assert!(snapshot.iter().any(|entry| {
            entry.path == "link"
                && entry.kind == FilesystemEntryKind::Symlink("nested/value.txt".to_owned())
        }));
        assert_eq!(
            fs::metadata(workspace.join("nested"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o750
        );
    }
}
