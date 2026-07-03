use std::io::{Read, Write};

use vsock_proto::{
    self, ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR,
    MSG_EXEC_CANCEL, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START,
};

pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
pub(crate) const LONG_RUNNING_EXEC_TIMEOUT_MS: u32 = 60_000;
pub(crate) const LARGE_ENV_COMMAND: &str =
    "printf '%s:%s:%s:%s:%s\\n' \"$SMALL\" \"${#BIG_A}\" \"${#BIG_B}\" \"${#BIG_C}\" \"${#BIG_D}\"";

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

pub(crate) fn send_exec_start(
    stream: &mut impl Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
) {
    send_exec_start_with_env(stream, seq, command, timeout_ms, &[], stdout, stderr);
}

pub(crate) fn send_exec_start_with_env(
    stream: &mut impl Write,
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
    stream: &mut impl Write,
    seq: u32,
    request: vsock_proto::ExecStartEncodeRequest<'_>,
) {
    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(request).unwrap();
    let msg = vsock_proto::encode(MSG_EXEC_START, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_exec_cancel(stream: &mut impl Write, seq: u32) {
    let payload = vsock_proto::encode_exec_cancel();
    let msg = vsock_proto::encode(MSG_EXEC_CANCEL, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn read_exec_result(
    stream: &mut impl Read,
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

pub(crate) fn read_exec_output_chunk(stream: &mut impl Read, seq: u32) -> ExecOutputChunk {
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

fn read_retry_eintr(stream: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    loop {
        match stream.read(buf) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}
