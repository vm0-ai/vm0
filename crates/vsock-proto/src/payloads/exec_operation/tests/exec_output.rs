use super::super::*;
use super::shared::{ExecOutputLayout, set_byte_at};

#[test]
fn exec_output_roundtrip_stdout() {
    let payload = encode_exec_output(ExecOutputStream::Stdout, 7, b"hello", false).unwrap();
    let decoded = decode_exec_output(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedExecOutput {
            stream: ExecOutputStream::Stdout,
            output_seq: 7,
            chunk: b"hello",
            truncated: false,
        }
    );
}
#[test]
fn exec_output_roundtrip_stderr_truncated() {
    let payload = encode_exec_output(ExecOutputStream::Stderr, 8, b"warn", true).unwrap();
    let decoded = decode_exec_output(&payload).unwrap();
    assert_eq!(decoded.stream, ExecOutputStream::Stderr);
    assert_eq!(decoded.output_seq, 8);
    assert_eq!(decoded.chunk, b"warn");
    assert!(decoded.truncated);
}
#[test]
fn exec_output_rejects_invalid_stream_flags_and_trailing_bytes() {
    let payload = encode_exec_output(ExecOutputStream::Stdout, 1, b"chunk", false).unwrap();
    let layout = ExecOutputLayout::new(b"chunk");

    let mut invalid_stream = payload.clone();
    set_byte_at(&mut invalid_stream, layout.stream_offset, 0x99);
    assert!(matches!(
        decode_exec_output(&invalid_stream),
        Err(ProtocolError::InvalidPayload("invalid exec output stream"))
    ));

    let mut unknown_flags = payload.clone();
    set_byte_at(&mut unknown_flags, layout.flags_offset, 0x80);
    assert!(matches!(
        decode_exec_output(&unknown_flags),
        Err(ProtocolError::InvalidPayload("exec output unknown flags"))
    ));

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_output(&trailing),
        Err(ProtocolError::InvalidPayload("exec output trailing bytes"))
    ));
}
#[test]
fn exec_output_rejects_truncated_fields() {
    assert!(matches!(
        decode_exec_output(&[]),
        Err(ProtocolError::InvalidPayload(
            "exec output stream truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_output(&[0]),
        Err(ProtocolError::InvalidPayload("exec output seq truncated"))
    ));

    let mut payload = encode_exec_output(ExecOutputStream::Stdout, 1, b"chunk", false).unwrap();
    let layout = ExecOutputLayout::new(b"chunk");
    payload.truncate(layout.chunk_len_offset);
    assert!(matches!(
        decode_exec_output(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec output chunk_len truncated"
        ))
    ));

    let mut payload = encode_exec_output(ExecOutputStream::Stdout, 1, b"chunk", false).unwrap();
    let layout = ExecOutputLayout::new(b"chunk");
    payload.truncate(layout.chunk_end_offset - 1);
    assert!(matches!(
        decode_exec_output(&payload),
        Err(ProtocolError::InvalidPayload("exec output chunk truncated"))
    ));
}
