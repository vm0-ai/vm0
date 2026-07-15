//! Bounded record reader for Firecracker process output.
//!
//! Normal records retain at most [`PROCESS_LOG_RECORD_MAX_BYTES`]. Oversized
//! records produce one [`ProcessLogRecord::Truncated`] event while the reader
//! continues discarding through the next delimiter or EOF.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) const PROCESS_LOG_RECORD_MAX_BYTES: usize = 16 * 1024;
pub(crate) const PROCESS_LOG_RECORD_TRUNCATED: &str =
    "firecracker log record omitted: exceeded 16 KiB limit";

const PROCESS_LOG_READ_BUFFER_BYTES: usize = 8 * 1024;

pub(crate) enum ProcessLogRecord<'a> {
    Line(&'a str),
    Truncated,
}

pub(crate) async fn read_process_log_records<R, F>(
    mut reader: R,
    mut on_record: F,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    F: for<'a> FnMut(ProcessLogRecord<'a>),
{
    let mut buffer = [0u8; PROCESS_LOG_READ_BUFFER_BYTES];
    let mut line = Vec::with_capacity(PROCESS_LOG_RECORD_MAX_BYTES.min(1024));
    let mut discarding = false;
    let mut pending_cr_at_limit = false;

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }

        for &byte in buffer.iter().take(read) {
            if discarding {
                if byte == b'\n' {
                    discarding = false;
                }
                continue;
            }

            if pending_cr_at_limit {
                pending_cr_at_limit = false;
                if byte == b'\n' {
                    emit_line(&line, &mut on_record)?;
                    line.clear();
                } else {
                    on_record(ProcessLogRecord::Truncated);
                    line.clear();
                    discarding = true;
                }
                continue;
            }

            if byte == b'\n' {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                emit_line(&line, &mut on_record)?;
                line.clear();
            } else if line.len() < PROCESS_LOG_RECORD_MAX_BYTES {
                line.push(byte);
            } else if byte == b'\r' {
                pending_cr_at_limit = true;
            } else {
                on_record(ProcessLogRecord::Truncated);
                line.clear();
                discarding = true;
            }
        }
    }

    if pending_cr_at_limit {
        on_record(ProcessLogRecord::Truncated);
    } else if !discarding {
        emit_line(&line, &mut on_record)?;
    }

    Ok(())
}

fn emit_line<F>(line: &[u8], on_record: &mut F) -> io::Result<()>
where
    F: for<'a> FnMut(ProcessLogRecord<'a>),
{
    if line.is_empty() {
        return Ok(());
    }

    let line = std::str::from_utf8(line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    on_record(ProcessLogRecord::Line(line));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;

    use super::*;

    #[derive(Debug, Eq, PartialEq)]
    enum OwnedProcessLogRecord {
        Line(String),
        Truncated,
    }

    impl From<ProcessLogRecord<'_>> for OwnedProcessLogRecord {
        fn from(record: ProcessLogRecord<'_>) -> Self {
            match record {
                ProcessLogRecord::Line(line) => Self::Line(line.to_owned()),
                ProcessLogRecord::Truncated => Self::Truncated,
            }
        }
    }

    async fn collect_records(input: &[u8]) -> io::Result<Vec<OwnedProcessLogRecord>> {
        let mut records = Vec::new();
        read_process_log_records(input, |record| records.push(record.into())).await?;
        Ok(records)
    }

    #[tokio::test]
    async fn reads_lf_crlf_and_final_partial_records() {
        let records = collect_records(b"first\nsecond\r\n\nfinal\r")
            .await
            .unwrap();

        assert_eq!(
            records,
            [
                OwnedProcessLogRecord::Line("first".to_string()),
                OwnedProcessLogRecord::Line("second".to_string()),
                OwnedProcessLogRecord::Line("final\r".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn accepts_records_at_the_payload_limit() {
        let mut input = vec![b'a'; PROCESS_LOG_RECORD_MAX_BYTES];
        input.push(b'\n');
        input.extend(std::iter::repeat_n(b'b', PROCESS_LOG_RECORD_MAX_BYTES));
        input.extend_from_slice(b"\r\n");
        input.extend(std::iter::repeat_n(b'c', PROCESS_LOG_RECORD_MAX_BYTES));

        let records = collect_records(&input).await.unwrap();

        assert_eq!(records.len(), 3);
        assert_eq!(
            records[0],
            OwnedProcessLogRecord::Line("a".repeat(PROCESS_LOG_RECORD_MAX_BYTES))
        );
        assert_eq!(
            records[1],
            OwnedProcessLogRecord::Line("b".repeat(PROCESS_LOG_RECORD_MAX_BYTES))
        );
        assert_eq!(
            records[2],
            OwnedProcessLogRecord::Line("c".repeat(PROCESS_LOG_RECORD_MAX_BYTES))
        );
    }

    #[tokio::test]
    async fn replaces_each_oversized_record_and_resumes_after_newline() {
        let mut input = vec![b'a'; PROCESS_LOG_RECORD_MAX_BYTES + 1];
        input.extend_from_slice(b"\nafter-first\n");
        input.extend(std::iter::repeat_n(b'b', PROCESS_LOG_RECORD_MAX_BYTES));
        input.extend_from_slice(b"\rx\nafter-second\n");
        input.extend(std::iter::repeat_n(b'c', PROCESS_LOG_RECORD_MAX_BYTES));
        input.push(b'\r');

        let records = collect_records(&input).await.unwrap();

        assert_eq!(
            records,
            [
                OwnedProcessLogRecord::Truncated,
                OwnedProcessLogRecord::Line("after-first".to_string()),
                OwnedProcessLogRecord::Truncated,
                OwnedProcessLogRecord::Line("after-second".to_string()),
                OwnedProcessLogRecord::Truncated,
            ]
        );
    }

    #[tokio::test]
    async fn drains_continuous_oversized_output_without_waiting_for_eof() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let (record_tx, mut record_rx) = tokio::sync::mpsc::unbounded_channel();
        let reader_task = tokio::spawn(async move {
            read_process_log_records(reader, |record| {
                record_tx.send(record.into()).unwrap();
            })
            .await
        });

        tokio::time::timeout(
            Duration::from_secs(1),
            writer.write_all(&vec![b'x'; PROCESS_LOG_RECORD_MAX_BYTES * 4]),
        )
        .await
        .expect("reader should keep draining oversized output")
        .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), record_rx.recv())
                .await
                .expect("truncation record should be emitted before EOF"),
            Some(OwnedProcessLogRecord::Truncated)
        );

        writer.write_all(b"\nafter\n").await.unwrap();
        drop(writer);
        reader_task.await.unwrap().unwrap();

        let mut remaining = Vec::new();
        while let Some(record) = record_rx.recv().await {
            remaining.push(record);
        }
        assert_eq!(
            remaining,
            [OwnedProcessLogRecord::Line("after".to_string())]
        );
    }

    #[tokio::test]
    async fn preserves_invalid_utf8_failure() {
        let error = collect_records(b"valid\n\xff\n").await.unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
