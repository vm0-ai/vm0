pub struct ExecRequest<'a> {
    pub cmd: &'a str,
    pub timeout_ms: u32,
}

pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
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
