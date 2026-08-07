use std::fs::File;
use std::io::{self, Read as _, Seek as _, Write as _};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);

pub(super) struct CommandExecution {
    child: Option<Child>,
    stdout: File,
    stderr: File,
}

impl CommandExecution {
    pub(super) fn spawn(command: &mut Command, stdin: Option<&[u8]>) -> io::Result<Self> {
        let stdout = tempfile::tempfile()?;
        let stderr = tempfile::tempfile()?;
        command
            .stdin(stdin_file(stdin)?)
            .stdout(Stdio::from(stdout.try_clone()?))
            .stderr(Stdio::from(stderr.try_clone()?));

        Ok(Self {
            child: Some(command.spawn()?),
            stdout,
            stderr,
        })
    }

    #[cfg(unix)]
    pub(super) fn id(&self) -> io::Result<u32> {
        self.child
            .as_ref()
            .map(Child::id)
            .ok_or_else(|| io::Error::other("command execution lost its child"))
    }

    pub(super) fn wait(self) -> io::Result<Output> {
        self.wait_with_timeout(RUN_TIMEOUT)
    }

    pub(super) fn wait_with_timeout(mut self, timeout: Duration) -> io::Result<Output> {
        let mut child = self
            .child
            .take()
            .ok_or_else(|| io::Error::other("command execution lost its child"))?;
        let deadline = Instant::now() + timeout;

        loop {
            match child.try_wait() {
                Ok(Some(status)) => return self.read_output(status),
                Ok(None) => {}
                Err(error) => {
                    let cleanup = terminate_and_reap(child);
                    let diagnostics = self.read_diagnostics();
                    return Err(io::Error::other(format!(
                        "failed to observe guest-download completion: {error}; cleanup: {cleanup}; \
                         {diagnostics}"
                    )));
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
        }

        let cleanup = terminate_and_reap(child);
        let diagnostics = self.read_diagnostics();
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "guest-download timed out after {timeout:?}; cleanup: {cleanup}; {diagnostics}"
            ),
        ))
    }

    fn read_output(&mut self, status: ExitStatus) -> io::Result<Output> {
        let (stdout, stderr) = self.read_streams()?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }

    fn read_diagnostics(&mut self) -> String {
        match self.read_streams() {
            Ok((stdout, stderr)) => format!(
                "stdout={:?}; stderr={:?}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            ),
            Err(error) => format!("failed to read captured output: {error}"),
        }
    }

    fn read_streams(&mut self) -> io::Result<(Vec<u8>, Vec<u8>)> {
        Ok((
            read_captured_stream(&mut self.stdout, "stdout")?,
            read_captured_stream(&mut self.stderr, "stderr")?,
        ))
    }
}

impl Drop for CommandExecution {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = terminate_and_reap(child);
        }
    }
}

pub(super) fn run(command: &mut Command) -> io::Result<Output> {
    CommandExecution::spawn(command, None)?.wait()
}

fn stdin_file(stdin: Option<&[u8]>) -> io::Result<Stdio> {
    let Some(stdin) = stdin else {
        return Ok(Stdio::null());
    };

    let mut file = tempfile::tempfile()?;
    file.write_all(stdin)?;
    file.rewind()?;
    Ok(Stdio::from(file))
}

fn read_captured_stream(file: &mut File, name: &str) -> io::Result<Vec<u8>> {
    file.rewind()
        .map_err(|error| io::Error::new(error.kind(), format!("rewind {name}: {error}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io::Error::new(error.kind(), format!("read {name}: {error}")))?;
    Ok(bytes)
}

fn terminate_and_reap(mut child: Child) -> String {
    let kill = match child.kill() {
        Ok(()) => "signal sent".to_owned(),
        Err(error) => format!("failed: {error}"),
    };
    let reap = match reap_child_with_timeout(child, CLEANUP_TIMEOUT) {
        Ok(status) => format!("completed with {status}"),
        Err(error) => format!("failed: {error}"),
    };
    format!("kill={kill}, reap={reap}")
}

fn reap_child_with_timeout(mut child: Child, timeout: Duration) -> Result<ExitStatus, String> {
    let (status_tx, status_rx) = mpsc::channel();
    let reaper = std::thread::spawn(move || {
        let _ = status_tx.send(child.wait());
    });

    match status_rx.recv_timeout(timeout) {
        Ok(status) => {
            reaper
                .join()
                .map_err(|_| "child reaper panicked".to_owned())?;
            status.map_err(|error| format!("wait failed: {error}"))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            drop(reaper);
            Err(format!("child was not reaped within {timeout:?}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            drop(reaper);
            Err("child reaper exited without a status".to_owned())
        }
    }
}
