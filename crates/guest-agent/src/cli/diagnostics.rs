//! Raw CLI stderr diagnostic tail collection.
//!
//! This module keeps stderr collection bounded and intentionally leaves final
//! secret masking to the `execute_cli` caller.

use std::collections::VecDeque;
use tokio::io::{AsyncRead, AsyncReadExt};

const STDERR_RESULT_MAX_LINES: usize = 200;
const STDERR_RESULT_MAX_LINE_BYTES: usize = 16 * 1024;
const STDERR_READ_BUFFER_BYTES: usize = 8 * 1024;
const STDERR_OMITTED_LONG_LINE: &str = "[stderr line omitted: exceeded diagnostic size limit]";

fn push_stderr_result_line(lines: &mut VecDeque<String>, line: String) {
    if lines.len() == STDERR_RESULT_MAX_LINES {
        lines.pop_front();
    }
    lines.push_back(line);
}

fn push_decoded_stderr_result_line(lines: &mut VecDeque<String>, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    if line.len() > STDERR_RESULT_MAX_LINE_BYTES {
        push_stderr_result_line(lines, STDERR_OMITTED_LONG_LINE.to_string());
    } else {
        push_stderr_result_line(lines, line.into_owned());
    }
}

fn finish_stderr_result_line(
    lines: &mut VecDeque<String>,
    line: &mut Vec<u8>,
    line_omitted: &mut bool,
    strip_trailing_cr: bool,
) {
    if *line_omitted {
        push_stderr_result_line(lines, STDERR_OMITTED_LONG_LINE.to_string());
    } else {
        if strip_trailing_cr && line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > STDERR_RESULT_MAX_LINE_BYTES {
            push_stderr_result_line(lines, STDERR_OMITTED_LONG_LINE.to_string());
        } else {
            push_decoded_stderr_result_line(lines, line);
        }
    }
    line.clear();
    *line_omitted = false;
}

pub(super) async fn collect_stderr_result_tail<R>(mut stderr: R) -> Vec<String>
where
    R: AsyncRead + Unpin,
{
    let mut lines = VecDeque::with_capacity(STDERR_RESULT_MAX_LINES);
    let mut line = Vec::with_capacity(STDERR_RESULT_MAX_LINE_BYTES.min(1024));
    let mut line_omitted = false;
    let mut buffer = [0u8; STDERR_READ_BUFFER_BYTES];

    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };

        for &byte in buffer.iter().take(read) {
            if byte == b'\n' {
                finish_stderr_result_line(&mut lines, &mut line, &mut line_omitted, true);
                continue;
            }

            if line_omitted {
                continue;
            }

            if line.len() < STDERR_RESULT_MAX_LINE_BYTES
                || (byte == b'\r' && line.len() == STDERR_RESULT_MAX_LINE_BYTES)
            {
                line.push(byte);
            } else {
                line.clear();
                line_omitted = true;
            }
        }
    }

    if !line.is_empty() || line_omitted {
        finish_stderr_result_line(&mut lines, &mut line, &mut line_omitted, false);
    }

    lines.into_iter().collect()
}
