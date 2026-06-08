use super::super::*;

#[test]
fn exec_cancel_roundtrip_empty_payload() {
    let payload = encode_exec_cancel();
    assert!(payload.is_empty());
    decode_exec_cancel(&payload).unwrap();
}
#[test]
fn exec_started_roundtrip_and_rejects_malformed_payloads() {
    let payload = encode_exec_started(42).unwrap();
    assert_eq!(decode_exec_started(&payload).unwrap().pid, 42);

    assert!(matches!(
        encode_exec_started(0),
        Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero"
        ))
    ));
    assert!(matches!(
        decode_exec_started(&[0, 0, 0]),
        Err(ProtocolError::InvalidPayload("exec started pid truncated"))
    ));
    assert!(matches!(
        decode_exec_started(&[0, 0, 0, 0]),
        Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero"
        ))
    ));
    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_started(&trailing),
        Err(ProtocolError::InvalidPayload("exec started trailing bytes"))
    ));
}
#[test]
fn exec_cancel_rejects_non_empty_payload() {
    let err = decode_exec_cancel(&[0]).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec cancel payload must be empty")
    ));
}
