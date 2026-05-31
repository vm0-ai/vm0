use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use vsock_guest::handle_connection;
use vsock_proto::{
    self, ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR,
    MSG_EXEC_CANCEL, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START, MSG_PING, MSG_PONG,
    MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS,
};

pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
pub(crate) const LONG_RUNNING_EXEC_TIMEOUT_MS: u32 = 60_000;
pub(crate) const LARGE_ENV_COMMAND: &str =
    "printf '%s:%s:%s:%s:%s\\n' \"$SMALL\" \"${#BIG_A}\" \"${#BIG_B}\" \"${#BIG_C}\" \"${#BIG_D}\"";

pub(crate) struct TempPathGuard(String);

impl TempPathGuard {
    fn new(path: String) -> Self {
        let _ = std::fs::remove_file(&path);
        Self(path)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for TempPathGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) fn unique_tmp_path(label: &str, suffix: &str) -> TempPathGuard {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    TempPathGuard::new(format!(
        "/tmp/vsock-test-{label}-{}-{nonce}{suffix}",
        std::process::id(),
    ))
}

pub(crate) fn unique_socket_path(label: &str) -> TempPathGuard {
    unique_tmp_path(label, ".sock")
}

pub(crate) fn unique_pid_path(label: &str) -> TempPathGuard {
    unique_tmp_path(label, ".pid")
}

pub(crate) fn large_env_values() -> [String; 4] {
    [
        "A".repeat(40 * 1024),
        "B".repeat(40 * 1024),
        "C".repeat(40 * 1024),
        "D".repeat(40 * 1024),
    ]
}

pub(crate) fn large_env_entries(values: &[String; 4]) -> [(&'static str, &str); 5] {
    [
        ("SMALL", "ok"),
        ("BIG_A", values[0].as_str()),
        ("BIG_B", values[1].as_str()),
        ("BIG_C", values[2].as_str()),
        ("BIG_D", values[3].as_str()),
    ]
}

pub(crate) fn assert_large_env_stdout(stdout: &[u8]) {
    assert_eq!(
        String::from_utf8_lossy(stdout),
        "ok:40960:40960:40960:40960\n"
    );
}

pub(crate) struct OrphanProcessGuard {
    pid_file: TempPathGuard,
}

impl OrphanProcessGuard {
    pub(crate) fn new(label: &str) -> Self {
        Self {
            pid_file: unique_pid_path(label),
        }
    }

    pub(crate) fn pid_path(&self) -> &str {
        self.pid_file.as_str()
    }
}

impl Drop for OrphanProcessGuard {
    fn drop(&mut self) {
        let Ok(pid_text) = std::fs::read_to_string(self.pid_file.as_str()) else {
            return;
        };
        let Ok(pid) = pid_text.trim().parse::<libc::pid_t>() else {
            return;
        };
        if pid > 0 {
            // SAFETY: pid is written by the shell as `$!` for this test's
            // background `sleep` process; failures are best-effort cleanup.
            unsafe {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

pub(crate) fn orphan_sleep_command(marker: &str, pid_path: &str) -> String {
    format!("sleep 30 & echo $! > {pid_path}; echo {marker}")
}

pub(crate) fn read_message(stream: &mut impl std::io::Read) -> vsock_proto::RawMessage {
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).unwrap();

    let mut full = Vec::with_capacity(4 + body_len);
    full.extend_from_slice(&hdr);
    full.extend_from_slice(&body);
    let mut decoder = vsock_proto::Decoder::new();
    let msgs = decoder.decode(&full).unwrap();
    assert_eq!(msgs.len(), 1);
    msgs.into_iter().next().unwrap()
}

/// Read one framed message from the stream and discard it.
pub(crate) fn read_and_discard_message(stream: &mut impl std::io::Read) {
    let _ = read_message(stream);
}

#[derive(Debug)]
pub(crate) struct ExecOutputChunk {
    pub(crate) stream: ExecOutputStream,
    pub(crate) output_seq: u32,
    pub(crate) chunk: Vec<u8>,
    pub(crate) truncated: bool,
}

#[derive(Debug)]
pub(crate) struct ExecResult {
    pub(crate) termination: ExecTermination,
    pub(crate) stdout: Option<Vec<u8>>,
    pub(crate) stderr: Option<Vec<u8>>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    pub(crate) diagnostic: String,
}

pub(crate) fn start_guest_connection() -> (thread::JoinHandle<()>, std::os::unix::net::UnixStream) {
    let (guest_stream, mut host_stream) = std::os::unix::net::UnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    (handle, host_stream)
}

pub(crate) fn finish_guest_connection(
    handle: thread::JoinHandle<()>,
    host_stream: std::os::unix::net::UnixStream,
) {
    drop(host_stream);
    let _ = handle.join();
}

pub(crate) fn send_exec_start(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
) {
    send_exec_start_with_env(stream, seq, command, timeout_ms, &[], stdout, stderr);
}

pub(crate) fn send_exec_start_with_env(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
) {
    let payload =
        vsock_proto::encode_exec_start(timeout_ms, command, env, false, "test", stdout, stderr)
            .unwrap();
    let msg = vsock_proto::encode(MSG_EXEC_START, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_exec_start_request(
    stream: &mut impl std::io::Write,
    seq: u32,
    request: vsock_proto::ExecStartEncodeRequest<'_>,
) {
    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(request).unwrap();
    let msg = vsock_proto::encode(MSG_EXEC_START, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn read_error_response(stream: &mut impl std::io::Read, seq: u32) -> String {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_ERROR);
    assert_eq!(msg.seq, seq);
    vsock_proto::decode_error(&msg.payload).unwrap().to_owned()
}

pub(crate) fn assert_ping_pong<T>(stream: &mut T, seq: u32)
where
    T: std::io::Read + std::io::Write,
{
    let ping = vsock_proto::encode(MSG_PING, seq, &[]).unwrap();
    stream.write_all(&ping).unwrap();
    let pong = read_message(stream);
    assert_eq!(pong.msg_type, MSG_PONG);
    assert_eq!(pong.seq, seq);
    assert!(pong.payload.is_empty());
}

pub(crate) fn send_exec_cancel(stream: &mut impl std::io::Write, seq: u32) {
    let payload = vsock_proto::encode_exec_cancel();
    let msg = vsock_proto::encode(MSG_EXEC_CANCEL, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_empty_control(stream: &mut impl std::io::Write, msg_type: u8, seq: u32) {
    let msg = vsock_proto::encode(msg_type, seq, &[]).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_control_payload(
    stream: &mut impl std::io::Write,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
) {
    let msg = vsock_proto::encode(msg_type, seq, payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_quiesce_operations(stream: &mut impl std::io::Write, seq: u32) {
    send_empty_control(stream, MSG_QUIESCE_OPERATIONS, seq);
}

pub(crate) fn send_resume_operations(stream: &mut impl std::io::Write, seq: u32) {
    send_empty_control(stream, MSG_RESUME_OPERATIONS, seq);
}

pub(crate) fn read_exec_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (Vec<ExecOutputChunk>, ExecResult) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut chunks = Vec::new();
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for exec result");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.seq != seq {
                continue;
            }
            match msg.msg_type {
                MSG_EXEC_OUTPUT => {
                    let decoded = vsock_proto::decode_exec_output(&msg.payload).unwrap();
                    chunks.push(ExecOutputChunk {
                        stream: decoded.stream,
                        output_seq: decoded.output_seq,
                        chunk: decoded.chunk.to_vec(),
                        truncated: decoded.truncated,
                    });
                }
                MSG_EXEC_RESULT => {
                    let decoded = vsock_proto::decode_exec_result(&msg.payload).unwrap();
                    return (
                        chunks,
                        ExecResult {
                            termination: decoded.termination,
                            stdout: captured_to_vec(decoded.stdout),
                            stderr: captured_to_vec(decoded.stderr),
                            stdout_truncated: captured_truncated(decoded.stdout),
                            stderr_truncated: captured_truncated(decoded.stderr),
                            diagnostic: decoded.diagnostic.to_string(),
                        },
                    );
                }
                MSG_ERROR => {
                    let error = vsock_proto::decode_error(&msg.payload).unwrap();
                    panic!("unexpected exec operation error for seq={seq}: {error}");
                }
                other => panic!("unexpected exec operation response type: 0x{other:02X}"),
            }
        }
    }
}

pub(crate) fn read_exec_output_chunk(stream: &mut impl std::io::Read, seq: u32) -> ExecOutputChunk {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for exec output");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.seq != seq {
                continue;
            }
            match msg.msg_type {
                MSG_EXEC_OUTPUT => {
                    let decoded = vsock_proto::decode_exec_output(&msg.payload).unwrap();
                    return ExecOutputChunk {
                        stream: decoded.stream,
                        output_seq: decoded.output_seq,
                        chunk: decoded.chunk.to_vec(),
                        truncated: decoded.truncated,
                    };
                }
                MSG_EXEC_RESULT => panic!("unexpected exec result before output"),
                MSG_ERROR => {
                    let error = vsock_proto::decode_error(&msg.payload).unwrap();
                    panic!("unexpected exec operation error for seq={seq}: {error}");
                }
                other => panic!("unexpected exec operation response type: 0x{other:02X}"),
            }
        }
    }
}

fn captured_to_vec(captured: ExecCapturedOutput<'_>) -> Option<Vec<u8>> {
    match captured {
        ExecCapturedOutput::Discarded => None,
        ExecCapturedOutput::Captured { bytes, .. } => Some(bytes.to_vec()),
    }
}

fn captured_truncated(captured: ExecCapturedOutput<'_>) -> bool {
    match captured {
        ExecCapturedOutput::Discarded => false,
        ExecCapturedOutput::Captured { truncated, .. } => truncated,
    }
}

fn output_data(chunks: &[ExecOutputChunk], stream: ExecOutputStream) -> Vec<u8> {
    chunks
        .iter()
        .filter(|chunk| chunk.stream == stream && !chunk.truncated)
        .flat_map(|chunk| chunk.chunk.iter().copied())
        .collect()
}

pub(crate) fn stdout_data(chunks: &[ExecOutputChunk]) -> Vec<u8> {
    output_data(chunks, ExecOutputStream::Stdout)
}

pub(crate) fn stderr_data(chunks: &[ExecOutputChunk]) -> Vec<u8> {
    output_data(chunks, ExecOutputStream::Stderr)
}

pub(crate) fn read_retry_eintr(
    stream: &mut impl std::io::Read,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    loop {
        match stream.read(buf) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

fn read_pid_file(path: &str) -> u32 {
    let path = Path::new(path);
    let deadline = Instant::now() + Duration::from_secs(3);
    let watcher = DirectoryWatcher::new(
        path.parent()
            .unwrap_or_else(|| panic!("pid path has no parent: {}", path.display())),
    )
    .unwrap_or_else(|e| panic!("failed to watch pid path parent {}: {e}", path.display()));

    loop {
        match try_read_pid_file(path) {
            Ok(Some(pid)) => return pid,
            Ok(None) => {}
            Err(e) => panic!("failed to read pid file {}: {e}", path.display()),
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "pid file {} was not created",
            path.display()
        );
        let changed = watcher
            .wait(remaining)
            .unwrap_or_else(|e| panic!("failed waiting for pid file {}: {e}", path.display()));
        assert!(changed, "pid file {} was not created", path.display());
    }
}

fn try_read_pid_file(path: &Path) -> std::io::Result<Option<u32>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents.trim().parse().ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn kill_pid_group(pid: u32) {
    // SAFETY: best-effort cleanup for a pid produced by a test child process.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

pub(crate) struct ProcessGroupFileGuard<'a> {
    pid_path: &'a str,
    pid: Option<u32>,
    armed: bool,
}

impl<'a> ProcessGroupFileGuard<'a> {
    pub(crate) fn new(pid_path: &'a str) -> Self {
        Self {
            pid_path,
            pid: None,
            armed: true,
        }
    }

    pub(crate) fn read_pid(&mut self) -> u32 {
        let pid = read_pid_file(self.pid_path);
        self.pid = Some(pid);
        pid
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessGroupFileGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pid = self.pid.or_else(|| {
            std::fs::read_to_string(self.pid_path)
                .ok()
                .and_then(|contents| contents.trim().parse().ok())
        });
        let Some(pid) = pid else {
            return;
        };
        if pid > 0 && pid_alive(pid) {
            kill_pid_group(pid);
        }
    }
}

pub(crate) fn wait_for_pid_exit(pid: u32, context: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            kill_pid_group(pid);
            panic!("pid {pid} did not terminate within 5s after {context}");
        }
        let changed = wait_for_pid_set_change(pid, remaining)
            .unwrap_or_else(|e| panic!("failed waiting for pid {pid} after {context}: {e}"));
        if !changed {
            kill_pid_group(pid);
            panic!("pid {pid} did not terminate within 5s after {context}");
        }
    }
}

#[derive(Clone, Copy)]
struct ProcStat {
    state: char,
    pgid: u32,
}

fn parse_proc_stat(stat: &str) -> Option<ProcStat> {
    let fields_start = stat.rfind(") ")? + 2;
    let mut fields = stat[fields_start..].split_whitespace();
    let state = fields.next()?.chars().next()?;
    let _ppid = fields.next()?;
    let pgid = fields.next()?.parse().ok()?;
    Some(ProcStat { state, pgid })
}

fn proc_stat(pid: u32) -> Option<ProcStat> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_proc_stat(&stat)
}

fn process_group_has_live_member(pgid: u32) -> bool {
    !process_group_live_members(pgid).is_empty()
}

fn process_group_live_members(pgid: u32) -> Vec<u32> {
    if pgid == 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![pgid];
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| {
            let Some(stat) = proc_stat(*pid) else {
                return false;
            };
            if stat.pgid != pgid || stat.state == 'Z' {
                return false;
            }
            // SAFETY: `kill` with sig=0 is a no-op existence check.
            unsafe { libc::kill(*pid as i32, 0) == 0 }
        })
        .collect()
}

/// Returns true iff `pid` is still running and signalable by the test owner.
/// Zombie leaders are dead, but their process group can still contain live
/// children, so wait/cleanup only treat the group as exited once no live member
/// remains. Some CI containers leave reparented zombies visible to
/// `kill(pid, 0)` until PID 1 reaps them.
pub(crate) fn pid_alive(pid: u32) -> bool {
    // SAFETY: `kill` with sig=0 is a no-op existence check.
    if unsafe { libc::kill(pid as i32, 0) != 0 } {
        return process_group_has_live_member(pid);
    }
    match proc_stat(pid) {
        Some(stat) if stat.state == 'Z' => process_group_has_live_member(stat.pgid),
        Some(_) => true,
        None => true,
    }
}

struct DirectoryWatcher {
    fd: OwnedFd,
}

impl DirectoryWatcher {
    fn new(dir: &Path) -> std::io::Result<Self> {
        // SAFETY: `inotify_init1` does not dereference user pointers and
        // returns a fresh file descriptor on success.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        // SAFETY: `fd` is a fresh descriptor returned by `inotify_init1`.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let dir = CString::new(dir.as_os_str().as_bytes()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "watch directory contains a NUL byte",
            )
        })?;
        let mask = libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE;
        // SAFETY: `fd` is a valid inotify descriptor and `dir` is a
        // NUL-terminated directory path.
        let wd = unsafe { libc::inotify_add_watch(fd.as_raw_fd(), dir.as_ptr(), mask) };
        if wd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        Ok(Self { fd })
    }

    fn wait(&self, timeout: Duration) -> std::io::Result<bool> {
        let pollfd = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        match poll_until(&mut [pollfd], timeout)? {
            true => {
                drain_fd(self.fd.as_raw_fd());
                Ok(true)
            }
            false => Ok(false),
        }
    }
}

fn wait_for_pid_set_change(pid: u32, timeout: Duration) -> std::io::Result<bool> {
    let pids = live_pids_for_wait(pid);
    if pids.is_empty() {
        return Ok(true);
    }
    let pidfds = pids
        .into_iter()
        .filter_map(open_pidfd_if_live)
        .collect::<std::io::Result<Vec<_>>>()?;
    if pidfds.is_empty() {
        return Ok(true);
    }

    let mut pollfds = pidfds
        .iter()
        .map(|pidfd| libc::pollfd {
            fd: pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        })
        .collect::<Vec<_>>();

    poll_until(&mut pollfds, timeout)
}

fn live_pids_for_wait(pid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    match proc_stat(pid) {
        Some(stat) if stat.state == 'Z' => pids.extend(process_group_live_members(stat.pgid)),
        Some(stat) => {
            pids.push(pid);
            pids.extend(process_group_live_members(stat.pgid));
        }
        None => {
            // SAFETY: `kill` with sig=0 is a no-op existence check.
            if unsafe { libc::kill(pid as i32, 0) == 0 } {
                pids.push(pid);
            }
            pids.extend(process_group_live_members(pid));
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn open_pidfd_if_live(pid: u32) -> Option<std::io::Result<OwnedFd>> {
    // SAFETY: `pidfd_open` does not dereference user pointers and returns a
    // new file descriptor for the requested PID on success.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
    if fd < 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            return None;
        }
        return Some(Err(err));
    }

    // SAFETY: `fd` is a fresh descriptor returned by `pidfd_open`.
    Some(Ok(unsafe {
        OwnedFd::from_raw_fd(fd as std::os::fd::RawFd)
    }))
}

fn poll_until(pollfds: &mut [libc::pollfd], timeout: Duration) -> std::io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: `pollfds` points to initialized pollfd entries and the len
        // argument matches the slice length.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as _, timeout_ms) };
        if result > 0 {
            return Ok(true);
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

fn drain_fd(fd: std::os::fd::RawFd) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: `fd` is a valid non-blocking descriptor owned by the caller;
        // `buf` is valid writable memory for the requested length.
        let result = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proc_stat_handles_process_names_with_parentheses() {
        let stat = "123 (name ) with parens) S 1 456 456 0 -1 4194304 1 2 3 4 5 6 7 8 20 0 1 0 0";

        let parsed = parse_proc_stat(stat).unwrap();

        assert_eq!(parsed.state, 'S');
        assert_eq!(parsed.pgid, 456);
    }

    #[test]
    fn pid_alive_detects_live_group_after_leader_is_reaped() {
        use std::os::unix::process::CommandExt;

        let pid_path = unique_pid_path("reaped-leader-live-group");
        let mut group_guard = ProcessGroupFileGuard::new(pid_path.as_str());
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "printf '%s' \"$$\" > '{}'; sleep 30 & exit 0",
                pid_path.as_str()
            ))
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = group_guard.read_pid();

        child.wait().unwrap();

        assert!(
            pid_alive(pid),
            "live process group should remain visible after leader is reaped"
        );
        kill_pid_group(pid);
        wait_for_pid_exit(pid, "test cleanup for reaped leader live group");
        group_guard.disarm();
    }
}
