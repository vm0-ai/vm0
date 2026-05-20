use std::thread;
use std::time::Duration;

use vsock_guest::handle_connection;
use vsock_proto::{
    self, ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR,
    MSG_EXEC_CANCEL, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START, MSG_PROCESS_CONTROL,
    MSG_PROCESS_CONTROL_RESULT, MSG_PROCESS_EXIT, MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS,
    MSG_SPAWN_PROCESS, MSG_SPAWN_PROCESS_RESULT, MSG_STDOUT_CHUNK, ProcessControlStatus,
};

pub(crate) const EXIT_CODE_TIMEOUT: i32 = 124;
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

pub(crate) fn stdout_data(chunks: &[ExecOutputChunk]) -> Vec<u8> {
    chunks
        .iter()
        .filter(|chunk| chunk.stream == ExecOutputStream::Stdout && !chunk.truncated)
        .flat_map(|chunk| chunk.chunk.clone())
        .collect()
}

pub(crate) fn stderr_data(chunks: &[ExecOutputChunk]) -> Vec<u8> {
    chunks
        .iter()
        .filter(|chunk| chunk.stream == ExecOutputStream::Stderr && !chunk.truncated)
        .flat_map(|chunk| chunk.chunk.clone())
        .collect()
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

/// Send a MSG_SPAWN_PROCESS message with streaming enabled.
pub(crate) fn send_spawn_process(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    log_path: Option<&str>,
    timeout_ms: u32,
) {
    send_spawn_process_with_env(stream, seq, command, &[], log_path, timeout_ms);
}

pub(crate) fn send_spawn_process_with_env(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    env: &[(&str, &str)],
    log_path: Option<&str>,
    timeout_ms: u32,
) {
    let payload =
        vsock_proto::encode_spawn_process(timeout_ms, command, env, false, true, log_path).unwrap();
    let msg = vsock_proto::encode(MSG_SPAWN_PROCESS, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_spawn_process_with_control_nonce(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    control_nonce: vsock_proto::ProcessControlNonce,
) {
    let payload = vsock_proto::encode_spawn_process_with_control_nonce(
        5000,
        command,
        &[],
        false,
        true,
        control_nonce,
        None,
    )
    .unwrap();
    let msg = vsock_proto::encode(MSG_SPAWN_PROCESS, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_process_control(
    stream: &mut impl std::io::Write,
    request_seq: u32,
    target_seq: u32,
    control_nonce: vsock_proto::ProcessControlNonce,
    message_id: &str,
) {
    let payload = vsock_proto::encode_process_control(
        target_seq,
        control_nonce,
        message_id,
        b"payload",
        5000,
    )
    .unwrap();
    let msg = vsock_proto::encode(MSG_PROCESS_CONTROL, request_seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn assert_process_control_result(
    stream: &mut impl std::io::Read,
    request_seq: u32,
    expected_target_seq: u32,
    expected_nonce: vsock_proto::ProcessControlNonce,
    expected_message_id: &str,
    expected_status: ProcessControlStatus,
    expected_diagnostic: &str,
) {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_PROCESS_CONTROL_RESULT);
    assert_eq!(msg.seq, request_seq);
    let decoded = vsock_proto::decode_process_control_result(&msg.payload).unwrap();
    assert_eq!(decoded.target_seq, expected_target_seq);
    assert_eq!(decoded.control_nonce, expected_nonce);
    assert_eq!(decoded.message_id, expected_message_id);
    assert_eq!(decoded.status, expected_status);
    assert_eq!(decoded.diagnostic, expected_diagnostic);
}

/// Read all streaming messages for a spawn_process command in a single loop.
/// Uses one decoder to avoid losing messages when the OS batches multiple
/// protocol frames into a single read buffer.
///
/// Returns `(pid, stdout_data, exit_code, stderr)`.
pub(crate) fn read_streaming_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (u32, Vec<u8>, i32, Vec<u8>) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    let mut stdout_data = Vec::new();
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for streaming result");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            // Pick up the PID from spawn_process_result
            if msg.msg_type == MSG_SPAWN_PROCESS_RESULT && msg.seq == seq {
                pid = Some(vsock_proto::decode_spawn_process_result(&msg.payload).unwrap());
                continue;
            }
            let Some(p) = pid else { continue };

            // Collect stdout chunks and return on process_exit
            if msg.msg_type == MSG_STDOUT_CHUNK
                && msg.seq == seq
                && let Ok((chunk_pid, data)) = vsock_proto::decode_stdout_chunk(&msg.payload)
                && chunk_pid == p
            {
                stdout_data.extend_from_slice(data);
            } else if msg.msg_type == MSG_PROCESS_EXIT
                && msg.seq == seq
                && let Ok((exit_pid, code, _stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                && exit_pid == p
            {
                return (p, stdout_data, code, stderr.to_vec());
            }
        }
    }
}

pub(crate) fn read_streaming_exit_after_result(
    stream: &mut impl std::io::Read,
    seq: u32,
    pid: u32,
) -> (Vec<u8>, i32, Vec<u8>) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut stdout_data = Vec::new();
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for streaming process exit");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_STDOUT_CHUNK
                && msg.seq == seq
                && let Ok((chunk_pid, data)) = vsock_proto::decode_stdout_chunk(&msg.payload)
                && chunk_pid == pid
            {
                stdout_data.extend_from_slice(data);
            } else if msg.msg_type == MSG_PROCESS_EXIT
                && msg.seq == seq
                && let Ok((exit_pid, code, _stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                && exit_pid == pid
            {
                return (stdout_data, code, stderr.to_vec());
            }
        }
    }
}

pub(crate) fn send_spawn_process_buffered(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
) {
    send_spawn_process_buffered_with_env(stream, seq, command, &[], timeout_ms);
}

pub(crate) fn send_spawn_process_buffered_with_env(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    env: &[(&str, &str)],
    timeout_ms: u32,
) {
    let payload =
        vsock_proto::encode_spawn_process(timeout_ms, command, env, false, false, None).unwrap();
    let msg = vsock_proto::encode(MSG_SPAWN_PROCESS, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

/// Read `MSG_SPAWN_PROCESS_RESULT` + `MSG_PROCESS_EXIT` for a buffered
/// spawn_process and return `(pid, exit_code, stdout, stderr)`.
pub(crate) fn read_buffered_spawn_process_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (u32, i32, Vec<u8>, Vec<u8>) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(
            n > 0,
            "unexpected EOF waiting for buffered spawn_process result"
        );
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_PROCESS_RESULT && msg.seq == seq {
                pid = Some(vsock_proto::decode_spawn_process_result(&msg.payload).unwrap());
                continue;
            }
            let Some(p) = pid else { continue };
            if msg.msg_type == MSG_PROCESS_EXIT
                && msg.seq == seq
                && let Ok((exit_pid, code, stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                && exit_pid == p
            {
                return (p, code, stdout.to_vec(), stderr.to_vec());
            }
        }
    }
}

pub(crate) fn read_spawn_process_pid(stream: &mut impl std::io::Read, seq: u32) -> u32 {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for spawn_process pid");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_PROCESS_RESULT && msg.seq == seq {
                return vsock_proto::decode_spawn_process_result(&msg.payload).unwrap();
            }
        }
    }
}

fn read_pid_file(path: &str) -> u32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match std::fs::read_to_string(path) {
            Ok(contents) => {
                if let Ok(pid) = contents.trim().parse() {
                    return pid;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("failed to read pid file {path}: {e}"),
        }
        assert!(
            std::time::Instant::now() < deadline,
            "pid file {path} was not created",
        );
        thread::sleep(Duration::from_millis(50));
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
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        if std::time::Instant::now() >= deadline {
            kill_pid_group(pid);
            panic!("pid {pid} did not terminate within 5s after {context}");
        }
        thread::sleep(Duration::from_millis(50));
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
    if pgid == 0 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return true;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let file_name = entry.file_name();
        let Some(pid_text) = file_name.to_str() else {
            return false;
        };
        let Ok(pid) = pid_text.parse::<u32>() else {
            return false;
        };
        let Some(stat) = proc_stat(pid) else {
            return false;
        };
        if stat.pgid != pgid || stat.state == 'Z' {
            return false;
        }
        // SAFETY: `kill` with sig=0 is a no-op existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    })
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
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while process_group_has_live_member(pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "cleanup should kill remaining process group members"
            );
            thread::sleep(Duration::from_millis(10));
        }
        group_guard.disarm();
    }
}
