use std::collections::{HashSet, VecDeque};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use vsock_proto::{
    self, MSG_ERROR, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT,
    MSG_WRITE_FILES_ABORT, MSG_WRITE_FILES_CHUNK, MSG_WRITE_FILES_FILE, MSG_WRITE_FILES_FINISH,
    MSG_WRITE_FILES_RESULT, RawMessage, WriteFilesResultEntry,
};

use crate::drain::drain_into_vec_cancellable;
use crate::error::to_io_error;
use crate::exec::{
    format_env_diagnostics, spawn_in_own_process_group, spawn_with_pipes, truncate_preview,
};
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, kill_process_tree};
use crate::shutdown::handle_shutdown;
use crate::threading::{SystemThreadSpawner, ThreadSpawner, spawn_scoped_named};
use crate::user::apply_write_file_identity;
use crate::wait::{
    WaitOutcome, await_drain_deadline, finalize_buffered_result,
    wait_with_drain_and_timeout_or_cancelled, wait_with_kill_timeout,
};

const THREAD_WRITE_STDERR: &str = "vsock-write-stderr";
const THREAD_WRITE_STDIN: &str = "vsock-write-stdin";
const WRITE_TIMEOUT_MS: u32 = 30_000;
const GUEST_WRITE_FILE_PATH: &str = "/sbin/guest-write-file";
const BATCH_MAGIC: &[u8; 8] = b"VM0WFB1\n";
const WRITE_FILES_CHUNK_DATA_OFFSET: usize = 8;
const WRITE_FILES_STDIN_QUEUE_BYTES: usize = 32 * 1024 * 1024;
#[cfg(any(debug_assertions, feature = "test-support"))]
static DEBUG_GUEST_WRITE_FILE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(crate) enum MessageOutcome {
    Response(Vec<u8>),
    Shutdown(Vec<u8>),
}

/// Handle exec message
pub(crate) fn handle_exec(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    connection_cancel: &AtomicBool,
) -> (i32, Vec<u8>, Vec<u8>) {
    log(
        "INFO",
        &format!(
            "exec: {} (timeout={}ms, sudo={}, {})",
            truncate_preview(command),
            timeout_ms,
            sudo,
            format_env_diagnostics(command, env),
        ),
    );

    let spawned = match spawn_with_pipes(command, env, sudo) {
        Ok(c) => c,
        Err(e) => {
            return (
                1,
                Vec::new(),
                format!(
                    "Failed to execute: {e} ({})",
                    format_env_diagnostics(command, env)
                )
                .into_bytes(),
            );
        }
    };
    let crate::exec::SpawnedCommand {
        child,
        env_script: _env_script,
    } = spawned;

    let (outcome, stdout, stderr_buf) =
        wait_with_drain_and_timeout_or_cancelled(child, timeout_ms, connection_cancel);
    let result = finalize_buffered_result(outcome, stdout, stderr_buf);

    log(
        "INFO",
        &format!(
            "exec result: exit_code={}, stdout_len={}, stderr_len={}",
            result.0,
            result.1.len(),
            result.2.len()
        ),
    );
    result
}

/// Handle write_file message
fn handle_write_file(path: &str, content: &[u8], use_sudo: bool) -> (bool, String) {
    log(
        "INFO",
        &format!(
            "write_file: path={} size={} sudo={}",
            path,
            content.len(),
            use_sudo,
        ),
    );

    let child = match spawn_write_files_command(use_sudo) {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn write command: {e}")),
    };

    let mut batch = Vec::with_capacity(BATCH_MAGIC.len() + 4 + 14 + path.len() + content.len());
    if let Err(e) = write_batch_header(&mut batch, 1)
        .and_then(|_| write_batch_file_header(&mut batch, 0, path, content.len() as u64))
        .and_then(|_| batch.write_all(content))
    {
        return (false, format!("Failed to encode write batch: {e}"));
    }

    wait_write_file_child(child, &batch, SystemThreadSpawner)
}

fn wait_write_file_child<S>(child: Child, content: &[u8], spawner: S) -> (bool, String)
where
    S: ThreadSpawner,
{
    wait_write_file_child_with_timeout(child, content, WRITE_TIMEOUT_MS, spawner)
}

fn wait_write_file_child_with_timeout<S>(
    mut child: Child,
    content: &[u8],
    timeout_ms: u32,
    spawner: S,
) -> (bool, String)
where
    S: ThreadSpawner,
{
    let child_pid = child.id();
    let stdin_pipe = match child.stdin.take() {
        Some(p) => p,
        None => {
            kill_and_reap_child(child);
            return (false, "missing stdin pipe".to_string());
        }
    };
    // Drain stderr concurrently with wait via the cancellable helper. Stdout
    // is `Stdio::null()` so there's no orphan-fd hazard there. Stdin is also
    // written from a helper thread so a child that stalls before reading stdin
    // cannot block the connection loop before timeout enforcement starts.
    // After the child exits, the drain thread either reaches EOF naturally or
    // — if a grandchild somehow still holds stderr — is cut at the deadline so
    // its last write returns EPIPE.
    // Defensive: same invariant as the exec drain helper — reap the child if
    // its stderr is somehow already gone, so we don't leave a zombie.
    let stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None => {
            kill_and_reap_child(child);
            return (false, "missing stderr pipe".to_string());
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let stderr_handle = {
        let drain_cancel = cancel.clone();
        match spawner.spawn_vec(
            THREAD_WRITE_STDERR,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stderr_pipe, &drain_cancel);
                let _ = done_tx.send(());
                buf
            }),
        ) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                drop(stdin_pipe);
                kill_and_reap_child(child);
                return (false, format!("Failed to spawn stderr drain thread: {e}"));
            }
        }
    };

    std::thread::scope(|scope| {
        let (stdin_done_tx, stdin_done_rx) = std::sync::mpsc::channel::<()>();
        let stdin_handle = match spawn_scoped_named(scope, THREAD_WRITE_STDIN, move || {
            let mut stdin = stdin_pipe;
            let result = stdin.write_all(content);
            let _ = stdin_done_tx.send(());
            result
        }) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                kill_and_reap_child(child);
                let _ = await_drain_deadline(&done_rx, 1, &cancel);
                let _ = stderr_handle.join();
                return (false, format!("Failed to spawn stdin writer thread: {e}"));
            }
        };

        let outcome = wait_with_kill_timeout(child, timeout_ms);
        if matches!(outcome, WaitOutcome::Exited(_) | WaitOutcome::WaitFailed(_))
            && matches!(
                stdin_done_rx.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            )
        {
            // The direct helper exited, but a descendant may still hold the
            // stdin pipe open without reading from it. Kill the helper's
            // process group before joining the writer, otherwise write_all()
            // can block forever on a full pipe.
            let _ = unsafe { kill_process_tree(child_pid) };
        }
        let stdin_result = match stdin_handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };

        let _ = await_drain_deadline(&done_rx, 1, &cancel);
        let stderr = stderr_handle.join().unwrap_or_default();

        match outcome {
            WaitOutcome::TimedOut => (false, "write timed out".to_string()),
            WaitOutcome::Cancelled => (false, "write cancelled".to_string()),
            WaitOutcome::WaitFailed(msg) => (false, format!("write wait failed: {msg}")),
            WaitOutcome::Exited(s) => {
                let exit_code = extract_exit_code(s);
                if exit_code != 0 {
                    let stderr_str = String::from_utf8_lossy(&stderr);
                    return (false, format!("write failed: {stderr_str}"));
                }
                if let Err(e) = stdin_result {
                    return (false, format!("Failed to write to stdin: {e}"));
                }
                (true, String::new())
            }
        }
    })
}

fn spawn_write_files_command(use_sudo: bool) -> io::Result<Child> {
    let mut command = Command::new(guest_write_file_path());
    command.arg("--batch");
    if !use_sudo {
        command.arg("--create-parents");
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_write_file_identity(&mut command, use_sudo)?;
    spawn_in_own_process_group(&mut command)
}

fn write_batch_header(writer: &mut impl Write, file_count: u32) -> io::Result<()> {
    writer.write_all(BATCH_MAGIC)?;
    writer.write_all(&file_count.to_be_bytes())
}

fn write_batch_file_header(
    writer: &mut impl Write,
    file_index: u32,
    path: &str,
    content_len: u64,
) -> io::Result<()> {
    let path_bytes = path.as_bytes();
    let path_len = u16::try_from(path_bytes.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "write_files path too long for helper protocol",
        )
    })?;
    writer.write_all(&file_index.to_be_bytes())?;
    writer.write_all(&path_len.to_be_bytes())?;
    writer.write_all(path_bytes)?;
    writer.write_all(&content_len.to_be_bytes())
}

fn guest_write_file_path() -> PathBuf {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        DEBUG_GUEST_WRITE_FILE_PATH
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| PathBuf::from(GUEST_WRITE_FILE_PATH))
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        PathBuf::from(GUEST_WRITE_FILE_PATH)
    }
}

#[cfg(any(debug_assertions, feature = "test-support"))]
pub(crate) fn set_debug_guest_write_file_path(path: PathBuf) -> Result<(), PathBuf> {
    *DEBUG_GUEST_WRITE_FILE_PATH
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(path);
    Ok(())
}

enum BatchWrite {
    Bytes(Vec<u8>),
    WriteFilesChunkPayload(Vec<u8>),
}

impl BatchWrite {
    fn queued_len(&self) -> usize {
        match self {
            Self::Bytes(bytes) | Self::WriteFilesChunkPayload(bytes) => bytes.len(),
        }
    }

    fn write_to(self, stdin: &mut ChildStdin) -> io::Result<()> {
        match self {
            Self::Bytes(bytes) => stdin.write_all(&bytes),
            Self::WriteFilesChunkPayload(payload) => {
                let chunk = payload
                    .get(WRITE_FILES_CHUNK_DATA_OFFSET..)
                    .ok_or_else(|| io::Error::other("write_files chunk payload too short"))?;
                stdin.write_all(chunk)
            }
        }
    }
}

struct BatchWriteQueueState {
    queue: VecDeque<BatchWrite>,
    queued_bytes: usize,
    closed: bool,
}

struct BatchWriteQueue {
    state: Mutex<BatchWriteQueueState>,
    available: Condvar,
    space: Condvar,
}

impl BatchWriteQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(BatchWriteQueueState {
                queue: VecDeque::new(),
                queued_bytes: 0,
                closed: false,
            }),
            available: Condvar::new(),
            space: Condvar::new(),
        }
    }

    fn send(&self, write: BatchWrite, timeout: Duration) -> io::Result<()> {
        self.send_with_limit(write, timeout, WRITE_FILES_STDIN_QUEUE_BYTES)
    }

    fn send_with_limit(
        &self,
        write: BatchWrite,
        timeout: Duration,
        max_queued_bytes: usize,
    ) -> io::Result<()> {
        let len = write.queued_len();
        if len > max_queued_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "write command stdin queue item exceeds limit",
            ));
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        let mut write = Some(write);
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if guard.closed {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "write command stdin closed",
                ));
            }

            if guard.queued_bytes.saturating_add(len) <= max_queued_bytes {
                guard.queued_bytes += len;
                let Some(write) = write.take() else {
                    return Err(io::Error::other("write command queued more than once"));
                };
                guard.queue.push_back(write);
                self.available.notify_one();
                return Ok(());
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "write command stdin queue full",
                ));
            }

            let (next_guard, wait_result) = self
                .space
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;
            if wait_result.timed_out() && guard.queued_bytes.saturating_add(len) > max_queued_bytes
            {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "write command stdin queue full",
                ));
            }
        }
    }

    fn recv(&self) -> Option<BatchWrite> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(write) = guard.queue.pop_front() {
                guard.queued_bytes = guard.queued_bytes.saturating_sub(write.queued_len());
                self.space.notify_all();
                return Some(write);
            }

            if guard.closed {
                return None;
            }

            guard = self
                .available
                .wait(guard)
                .unwrap_or_else(|e| e.into_inner());
        }
    }

    fn close_input(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.closed = true;
        self.available.notify_all();
        self.space.notify_all();
    }

    fn abort(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.closed = true;
        guard.queue.clear();
        guard.queued_bytes = 0;
        self.available.notify_all();
        self.space.notify_all();
    }
}

struct BatchChild {
    child: Child,
    stdin_queue: Arc<BatchWriteQueue>,
    stdin_handle: JoinHandle<io::Result<()>>,
    stdin_done_rx: mpsc::Receiver<()>,
    stderr_handle: JoinHandle<Vec<u8>>,
    stderr_done_rx: mpsc::Receiver<()>,
    cancel: Arc<AtomicBool>,
}

impl BatchChild {
    fn spawn(use_sudo: bool) -> Result<Self, String> {
        let child = spawn_write_files_command(use_sudo)
            .map_err(|e| format!("Failed to spawn write command: {e}"))?;
        Self::from_child(child)
    }

    fn from_child(mut child: Child) -> Result<Self, String> {
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                kill_and_reap_child(child);
                return Err("missing stdin pipe".to_string());
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                kill_and_reap_child(child);
                return Err("missing stderr pipe".to_string());
            }
        };

        // Keep helper stdin writes off the connection loop, but bound queued
        // bytes so a stuck helper cannot accumulate the whole stream in memory.
        let stdin_queue = Arc::new(BatchWriteQueue::new());
        let writer_queue = Arc::clone(&stdin_queue);
        let (stdin_done_tx, stdin_done_rx) = mpsc::channel::<()>();
        let stdin_handle = match std::thread::Builder::new()
            .name(THREAD_WRITE_STDIN.to_string())
            .spawn(move || {
                let mut stdin = stdin;
                let result = (|| {
                    while let Some(write) = writer_queue.recv() {
                        if let Err(e) = write.write_to(&mut stdin) {
                            writer_queue.abort();
                            return Err(e);
                        }
                    }
                    stdin.flush()
                })();
                let _ = stdin_done_tx.send(());
                result
            }) {
            Ok(handle) => handle,
            Err(e) => {
                kill_and_reap_child(child);
                return Err(format!("Failed to spawn stdin writer thread: {e}"));
            }
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let (stderr_done_tx, stderr_done_rx) = mpsc::channel::<()>();
        let drain_cancel = cancel.clone();
        let stderr_handle = match SystemThreadSpawner.spawn_vec(
            THREAD_WRITE_STDERR,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stderr, &drain_cancel);
                let _ = stderr_done_tx.send(());
                buf
            }),
        ) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                stdin_queue.abort();
                kill_and_reap_child(child);
                let _ = stdin_handle.join();
                return Err(format!("Failed to spawn stderr drain thread: {e}"));
            }
        };

        Ok(Self {
            child,
            stdin_queue,
            stdin_handle,
            stdin_done_rx,
            stderr_handle,
            stderr_done_rx,
            cancel,
        })
    }

    fn write_bytes(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.stdin_queue.send(
            BatchWrite::Bytes(bytes),
            Duration::from_millis(u64::from(WRITE_TIMEOUT_MS)),
        )
    }

    fn write_chunk_payload(&self, payload: Vec<u8>) -> io::Result<()> {
        self.stdin_queue.send(
            BatchWrite::WriteFilesChunkPayload(payload),
            Duration::from_millis(u64::from(WRITE_TIMEOUT_MS)),
        )
    }

    fn kill(self) {
        self.cancel
            .store(true, std::sync::atomic::Ordering::Release);
        self.stdin_queue.abort();
        kill_and_reap_child(self.child);
        let _ = self.stdin_handle.join();
        let _ = await_drain_deadline(&self.stderr_done_rx, 1, &self.cancel);
        let _ = self.stderr_handle.join();
    }

    fn finish(self) -> (bool, String) {
        self.finish_with_timeout(WRITE_TIMEOUT_MS)
    }

    fn finish_with_timeout(self, timeout_ms: u32) -> (bool, String) {
        let child_pid = self.child.id();
        self.stdin_queue.close_input();
        let outcome = wait_with_kill_timeout(self.child, timeout_ms);
        if matches!(outcome, WaitOutcome::Exited(_) | WaitOutcome::WaitFailed(_))
            && matches!(
                self.stdin_done_rx.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            )
        {
            let _ = unsafe { kill_process_tree(child_pid) };
        }
        let stdin_result = match self.stdin_handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        let _ = await_drain_deadline(&self.stderr_done_rx, 1, &self.cancel);
        let stderr = self.stderr_handle.join().unwrap_or_default();
        match outcome {
            WaitOutcome::TimedOut => (false, "write timed out".to_string()),
            WaitOutcome::Cancelled => (false, "write cancelled".to_string()),
            WaitOutcome::WaitFailed(msg) => (false, format!("write wait failed: {msg}")),
            WaitOutcome::Exited(status) => {
                let exit_code = extract_exit_code(status);
                if exit_code == 0 {
                    match stdin_result {
                        Ok(()) => (true, String::new()),
                        Err(e) => (false, format!("Failed to write to stdin: {e}")),
                    }
                } else {
                    (
                        false,
                        format!("write failed: {}", String::from_utf8_lossy(&stderr)),
                    )
                }
            }
        }
    }
}

fn write_files_success_response(seq: u32, file_count: u32) -> io::Result<Vec<u8>> {
    let entries: Vec<WriteFilesResultEntry> = (0..file_count)
        .map(|file_index| WriteFilesResultEntry {
            file_index,
            success: true,
            error: String::new(),
        })
        .collect();
    let payload = vsock_proto::encode_write_files_result(&entries).map_err(to_io_error)?;
    vsock_proto::encode(MSG_WRITE_FILES_RESULT, seq, &payload).map_err(to_io_error)
}

fn error_response(seq: u32, message: impl AsRef<str>) -> io::Result<Vec<u8>> {
    let payload = vsock_proto::encode_error(message.as_ref());
    vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)
}

pub(crate) fn handle_write_files_stream<F>(
    start_msg: &RawMessage,
    mut next_msg: F,
) -> io::Result<Vec<u8>>
where
    F: FnMut() -> io::Result<Option<RawMessage>>,
{
    let start = vsock_proto::decode_write_files_start(&start_msg.payload).map_err(to_io_error)?;
    let child = match BatchChild::spawn(start.sudo) {
        Ok(child) => child,
        Err(error) => {
            return error_response(start_msg.seq, error);
        }
    };
    let mut batch_header = Vec::with_capacity(BATCH_MAGIC.len() + 4);
    if let Err(e) = write_batch_header(&mut batch_header, start.file_count)
        .and_then(|_| child.write_bytes(batch_header))
    {
        let error = e.to_string();
        child.kill();
        return error_response(start_msg.seq, error);
    }

    let mut seen = HashSet::new();
    let mut current: Option<(u32, u64)> = None;
    let mut received_total = 0u64;

    loop {
        let msg = match next_msg() {
            Ok(Some(msg)) => msg,
            Ok(None) => {
                child.kill();
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed during write_files stream",
                ));
            }
            Err(e) => {
                child.kill();
                return Err(e);
            }
        };
        if msg.seq != start_msg.seq {
            child.kill();
            return error_response(start_msg.seq, "write_files stream received wrong seq");
        }
        match msg.msg_type {
            MSG_WRITE_FILES_FILE => {
                if current.is_some() {
                    child.kill();
                    return error_response(
                        start_msg.seq,
                        "write_files file started before prior file completed",
                    );
                }
                let file = match vsock_proto::decode_write_files_file(&msg.payload) {
                    Ok(file) => file,
                    Err(e) => {
                        child.kill();
                        return error_response(start_msg.seq, e.to_string());
                    }
                };
                if file.file_index >= start.file_count {
                    child.kill();
                    return error_response(start_msg.seq, "write_files file index out of range");
                }
                if !seen.insert(file.file_index) {
                    child.kill();
                    return error_response(start_msg.seq, "write_files duplicate file index");
                }
                if received_total
                    .checked_add(file.content_len)
                    .is_none_or(|n| n > start.total_bytes)
                {
                    child.kill();
                    return error_response(
                        start_msg.seq,
                        "write_files content length exceeds total",
                    );
                }
                let mut file_header = Vec::with_capacity(14 + file.path.len());
                if let Err(e) = write_batch_file_header(
                    &mut file_header,
                    file.file_index,
                    file.path,
                    file.content_len,
                )
                .and_then(|_| child.write_bytes(file_header))
                {
                    let error = e.to_string();
                    child.kill();
                    return error_response(start_msg.seq, error);
                }
                if file.content_len > 0 {
                    current = Some((file.file_index, file.content_len));
                }
                received_total += file.content_len;
            }
            MSG_WRITE_FILES_CHUNK => {
                let chunk = match vsock_proto::decode_write_files_chunk(&msg.payload) {
                    Ok(chunk) => chunk,
                    Err(e) => {
                        child.kill();
                        return error_response(start_msg.seq, e.to_string());
                    }
                };
                let Some((file_index, remaining)) = current else {
                    child.kill();
                    return error_response(start_msg.seq, "write_files chunk without active file");
                };
                if chunk.file_index != file_index {
                    child.kill();
                    return error_response(start_msg.seq, "write_files chunk index mismatch");
                }
                let chunk_len = chunk.chunk.len() as u64;
                if chunk_len > remaining {
                    child.kill();
                    return error_response(start_msg.seq, "write_files chunk exceeds file length");
                }
                if let Err(e) = child.write_chunk_payload(msg.payload) {
                    let error = e.to_string();
                    child.kill();
                    return error_response(start_msg.seq, error);
                }
                let next_remaining = remaining - chunk_len;
                current = (next_remaining > 0).then_some((file_index, next_remaining));
            }
            MSG_WRITE_FILES_FINISH => {
                if current.is_some() {
                    child.kill();
                    return error_response(
                        start_msg.seq,
                        "write_files finish before file content complete",
                    );
                }
                if seen.len() != start.file_count as usize || received_total != start.total_bytes {
                    child.kill();
                    return error_response(
                        start_msg.seq,
                        "write_files finish before all files received",
                    );
                }
                let (success, error) = child.finish();
                if success {
                    return write_files_success_response(start_msg.seq, start.file_count);
                }
                return error_response(start_msg.seq, error);
            }
            MSG_WRITE_FILES_ABORT => {
                let _ = vsock_proto::decode_write_files_abort(&msg.payload);
                child.kill();
                return error_response(start_msg.seq, "write_files aborted");
            }
            _ => {
                child.kill();
                return error_response(start_msg.seq, "unexpected message in write_files stream");
            }
        }
    }
}

/// Handle incoming message and return the connection-loop outcome.
///
/// Legacy `MSG_EXEC` and current `MSG_SPAWN_WATCH` are handled separately in
/// `handle_connection` because they run in background threads.
pub(crate) fn handle_message(msg: &RawMessage) -> io::Result<MessageOutcome> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(MessageOutcome::Response(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_WRITE_FILE => {
            let (path, content, use_sudo) =
                vsock_proto::decode_write_file(&msg.payload).map_err(to_io_error)?;
            let (success, error) = handle_write_file(path, content, use_sudo);
            let payload = vsock_proto::encode_write_file_result(success, &error);
            Ok(MessageOutcome::Response(
                vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload)
                    .map_err(to_io_error)?,
            ))
        }
        MSG_SHUTDOWN => Ok(MessageOutcome::Shutdown(handle_shutdown(msg.seq)?)),
        _ => {
            let payload =
                vsock_proto::encode_error(&format!("Unknown message type: 0x{:02X}", msg.msg_type));
            Ok(MessageOutcome::Response(
                vsock_proto::encode(MSG_ERROR, msg.seq, &payload).map_err(to_io_error)?,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    static WRITE_FILE_CHILD_TESTS: Mutex<()> = Mutex::new(());

    struct DebugGuestWriteFilePathGuard {
        previous: Option<PathBuf>,
        dir: PathBuf,
    }

    impl Drop for DebugGuestWriteFilePathGuard {
        fn drop(&mut self) {
            *DEBUG_GUEST_WRITE_FILE_PATH
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = self.previous.take();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn install_test_guest_write_file(script: &str) -> DebugGuestWriteFilePathGuard {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vm0-vsock-guest-write-file-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("guest-write-file");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();

        let previous = {
            let mut guard = DEBUG_GUEST_WRITE_FILE_PATH
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let previous = guard.clone();
            *guard = Some(path);
            previous
        };

        DebugGuestWriteFilePathGuard { previous, dir }
    }

    fn decode_single_response(response: &[u8]) -> RawMessage {
        let mut decoder = vsock_proto::Decoder::new();
        let mut messages = decoder.decode(response).unwrap();
        assert_eq!(messages.len(), 1);
        messages.remove(0)
    }

    fn spawn_write_file_test_child(script: &str) -> Child {
        // Use a stable shell binary instead of a freshly written temp
        // executable; some CI filesystems can transiently reject immediate exec
        // of a just-created file with ETXTBSY.
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        spawn_in_own_process_group(&mut command).unwrap()
    }

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_child_starts_as_process_group_leader() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60");
        let pid = child.id();

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        let _ = unsafe { crate::process::kill_process_tree(pid) };
        let _ = wait_with_kill_timeout(child, 100);

        assert_eq!(pgid, pid as libc::pid_t);
    }

    #[test]
    fn write_file_stderr_drain_spawn_failure_kills_and_reaps_child() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60");
        let pid = child.id();

        let (success, error) = wait_write_file_child(
            child,
            b"",
            FailingThreadSpawner::fail_once(THREAD_WRITE_STDERR),
        );

        assert!(!success);
        assert!(error.contains("stderr drain thread"));
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn write_file_timeout_kills_child_while_stdin_writer_is_blocked() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60; cat >/dev/null");
        let pid = child.id();
        let content = vec![b'x'; 1024 * 1024];

        let (success, error) =
            wait_write_file_child_with_timeout(child, &content, 10, SystemThreadSpawner);

        assert!(!success);
        assert_eq!(error, "write timed out");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn write_files_batch_timeout_kills_child_while_stdin_writer_is_blocked() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60; cat >/dev/null");
        let pid = child.id();
        let batch = BatchChild::from_child(child).unwrap();

        batch.write_bytes(vec![b'x'; 1024 * 1024]).unwrap();
        let (success, error) = batch.finish_with_timeout(10);

        assert!(!success);
        assert_eq!(error, "write timed out");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn write_files_batch_kills_lingering_process_group_after_parent_exit() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60 <&0 >/dev/null 2>/dev/null & exit 0");
        let pid = child.id();
        let batch = BatchChild::from_child(child).unwrap();

        batch.write_bytes(vec![b'x'; 1024 * 1024]).unwrap();
        let (success, error) = batch.finish_with_timeout(1_000);

        assert!(!success);
        assert!(error.contains("Failed to write to stdin"), "got: {error}");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn write_files_batch_queue_is_bounded_and_abort_drops_backlog() {
        let queue = BatchWriteQueue::new();

        queue
            .send_with_limit(BatchWrite::Bytes(vec![0; 8]), Duration::ZERO, 8)
            .unwrap();
        let err = queue
            .send_with_limit(BatchWrite::Bytes(vec![1]), Duration::ZERO, 8)
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);

        queue.abort();
        assert!(queue.recv().is_none());
    }

    #[test]
    fn write_files_batch_queue_close_preserves_backlog() {
        let queue = BatchWriteQueue::new();

        queue
            .send_with_limit(BatchWrite::Bytes(vec![1, 2, 3]), Duration::ZERO, 8)
            .unwrap();
        queue.close_input();

        match queue.recv() {
            Some(BatchWrite::Bytes(bytes)) => assert_eq!(bytes, vec![1, 2, 3]),
            _ => panic!("expected queued bytes after close_input"),
        }
        assert!(queue.recv().is_none());
    }

    #[test]
    fn write_files_batch_queue_rejects_oversized_item_without_closing() {
        let queue = BatchWriteQueue::new();

        let err = queue
            .send_with_limit(BatchWrite::Bytes(vec![0; 9]), Duration::ZERO, 8)
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        queue
            .send_with_limit(BatchWrite::Bytes(vec![1]), Duration::ZERO, 8)
            .unwrap();
        queue.close_input();
        match queue.recv() {
            Some(BatchWrite::Bytes(bytes)) => assert_eq!(bytes, vec![1]),
            _ => panic!("expected queue to remain usable after oversized item rejection"),
        }
        assert!(queue.recv().is_none());
    }

    #[test]
    fn write_files_stream_malformed_file_payload_returns_error_response() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let _path_guard = install_test_guest_write_file("cat >/dev/null");
        let start_payload = vsock_proto::encode_write_files_start(false, 1, 1).unwrap();
        let start = RawMessage {
            msg_type: vsock_proto::MSG_WRITE_FILES_START,
            seq: 7,
            payload: start_payload,
        };
        let mut messages = VecDeque::from([RawMessage {
            msg_type: MSG_WRITE_FILES_FILE,
            seq: 7,
            payload: vec![0],
        }]);

        let response = handle_write_files_stream(&start, || Ok(messages.pop_front())).unwrap();
        let response = decode_single_response(&response);

        assert_eq!(response.msg_type, MSG_ERROR);
        let error = vsock_proto::decode_error(&response.payload).unwrap();
        assert!(error.contains("write_files_file too short"), "got: {error}");
    }

    #[test]
    fn write_files_stream_malformed_chunk_payload_returns_error_response() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let _path_guard = install_test_guest_write_file("cat >/dev/null");
        let start_payload = vsock_proto::encode_write_files_start(false, 1, 1).unwrap();
        let start = RawMessage {
            msg_type: vsock_proto::MSG_WRITE_FILES_START,
            seq: 8,
            payload: start_payload,
        };
        let file_payload = vsock_proto::encode_write_files_file(0, "/tmp/file", 1).unwrap();
        let mut messages = VecDeque::from([
            RawMessage {
                msg_type: MSG_WRITE_FILES_FILE,
                seq: 8,
                payload: file_payload,
            },
            RawMessage {
                msg_type: MSG_WRITE_FILES_CHUNK,
                seq: 8,
                payload: vec![0],
            },
        ]);

        let response = handle_write_files_stream(&start, || Ok(messages.pop_front())).unwrap();
        let response = decode_single_response(&response);

        assert_eq!(response.msg_type, MSG_ERROR);
        let error = vsock_proto::decode_error(&response.payload).unwrap();
        assert!(
            error.contains("write_files_chunk too short"),
            "got: {error}"
        );
    }

    #[test]
    fn write_files_stream_batch_failure_returns_single_error_response() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let _path_guard = install_test_guest_write_file(
            "cat >/dev/null; printf '%*s' 20000 '' | tr ' ' x >&2; exit 1",
        );
        let file_count = vsock_proto::MAX_WRITE_FILES_COUNT as u32;
        let start_payload = vsock_proto::encode_write_files_start(false, file_count, 0).unwrap();
        let start = RawMessage {
            msg_type: vsock_proto::MSG_WRITE_FILES_START,
            seq: 9,
            payload: start_payload,
        };
        let mut messages = VecDeque::new();
        for file_index in 0..file_count {
            let path = format!("/tmp/file-{file_index}");
            messages.push_back(RawMessage {
                msg_type: MSG_WRITE_FILES_FILE,
                seq: 9,
                payload: vsock_proto::encode_write_files_file(file_index, &path, 0).unwrap(),
            });
        }
        messages.push_back(RawMessage {
            msg_type: MSG_WRITE_FILES_FINISH,
            seq: 9,
            payload: Vec::new(),
        });

        let response = handle_write_files_stream(&start, || Ok(messages.pop_front())).unwrap();
        let response = decode_single_response(&response);

        assert_eq!(response.msg_type, MSG_ERROR);
        let error = vsock_proto::decode_error(&response.payload).unwrap();
        assert!(error.contains("write failed:"), "got: {error}");
    }

    #[test]
    fn write_file_kills_lingering_process_group_after_parent_exit() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60 <&0 >/dev/null 2>/dev/null & exit 0");
        let pid = child.id();
        let content = vec![b'x'; 1024 * 1024];

        let (success, error) =
            wait_write_file_child_with_timeout(child, &content, 1_000, SystemThreadSpawner);

        assert!(!success);
        assert!(error.contains("Failed to write to stdin"), "got: {error}");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }
}
