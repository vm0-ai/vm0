mod exec_control;
mod exec_control_result;
mod exec_output;
mod exec_result;
mod exec_start;
mod exec_started_cancel;
mod shared;

use crate::error::ProtocolError;
use crate::payloads::exec_control::ExecControlNonce;

const NONCE: ExecControlNonce = *b"0123456789abcdef";

fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
    assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
}
