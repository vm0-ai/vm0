use std::time::Duration;

pub struct ExecRequest<'a> {
    pub cmd: &'a str,
    pub timeout: Duration,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
}

impl ExecRequest<'_> {
    /// Return the timeout as whole milliseconds, saturating at `u32::MAX`.
    pub fn timeout_ms(&self) -> u32 {
        u32::try_from(self.timeout.as_millis()).unwrap_or(u32::MAX)
    }
}

pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub struct SpawnHandle {
    pub pid: u32,
}

pub struct ProcessExit {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
