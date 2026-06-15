mod control;
mod output;
mod result;
mod start;
mod started_cancel;

pub use control::{
    DecodedExecControl, DecodedExecControlResult, decode_exec_control, decode_exec_control_result,
    encode_exec_control, encode_exec_control_result,
};
pub use output::{DecodedExecOutput, ExecOutputStream, decode_exec_output, encode_exec_output};
pub use result::{
    DecodedExecResult, ExecCapturedOutput, ExecTermination, decode_exec_result, encode_exec_result,
};
pub use start::{
    DecodedExecStart, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy,
    ExecStartEncodeRequest, ExecTimeoutPolicy, MAX_EXEC_STDIN_BYTES, decode_exec_start,
    encode_exec_start, encode_exec_start_with_expected_exit_codes,
};
pub use started_cancel::{
    DecodedExecStarted, decode_exec_cancel, decode_exec_started, encode_exec_cancel,
    encode_exec_started,
};

#[cfg(test)]
use crate::error::ProtocolError;
#[cfg(test)]
use crate::payloads::exec_control::EXEC_CONTROL_NONCE_LEN;
#[cfg(test)]
use crate::payloads::exec_control::ExecControlStatus;
#[cfg(test)]
use result::EXEC_TERMINATION_CANCELLED;
#[cfg(test)]
use start::{
    EXEC_LIFECYCLE_ONE_SHOT, EXEC_OUTPUT_POLICY_CAPTURE, EXEC_OUTPUT_POLICY_DISCARD,
    EXEC_TIMEOUT_DURATION, MAX_EXEC_ENV_VARS, MAX_EXEC_EXPECTED_EXIT_CODES,
};

#[cfg(test)]
mod tests;
