//! Vsock binary protocol for host-guest communication.
//!
//! ## Wire Format
//!
//! ```text
//! [4-byte length][1-byte type][4-byte seq][payload]
//! ```
//!
//! - **length**: big-endian u32, size of (type + seq + payload)
//! - **type**: u8 message type
//! - **seq**: big-endian u32, sequence number. Request-scoped replies and
//!   lifecycle frames use the original request sequence; 0 is reserved for
//!   unsolicited frames.
//! - **payload**: type-specific binary data
//!
//! ## Message Types
//!
//! | Type | Direction | Name              | Payload |
//! |------|-----------|-------------------|---------|
//! | 0x00 | G→H       | ready             | (empty) |
//! | 0x01 | H→G       | ping              | (empty) |
//! | 0x02 | G→H       | pong              | (empty) |
//! | 0x03 | H→G       | write_file        | `[2B path_len][path][1B flags][4B content_len][content]` (flags: `SUDO=0x01`, `APPEND=0x02`) |
//! | 0x04 | G→H       | write_file_result | `[1B success][2B error_len][error]` |
//! | 0x05 | H→G       | spawn_process     | `[4B timeout_ms][1B flags][4B cmd_len][command]([4B env_count]([4B key_len][key][4B val_len][value])*)([2B log_path_len][log_path])` (flags: `SUDO=0x01`, `STREAM_STDOUT=0x02`) |
//! | 0x06 | G→H       | spawn_process_result | `[4B pid]` |
//! | 0x07 | G→H       | process_exit      | `[4B pid][4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]` (`spawn_process` uses the original request seq; pid is metadata, not the routing key) |
//! | 0x08 | H→G       | shutdown          | (empty) |
//! | 0x09 | G→H       | shutdown_ack      | (empty) |
//! | 0x0A | G→H       | stdout_chunk      | `[4B pid][data]` (`spawn_process` uses the original request seq; pid is metadata, not the routing key) |
//! | 0x0B | H→G       | exec_start     | `[4B timeout_ms][1B flags][4B cmd_len][command][4B env_count]... [2B label_len][label][stdout_policy][stderr_policy][2B expected_exit_count][4B exit_code]...` |
//! | 0x0C | G→H       | exec_output    | `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]` |
//! | 0x0D | G→H       | exec_result    | `[1B termination]...[4B duration_ms][stdout][stderr][2B diagnostic_len][diagnostic]` |
//! | 0x0E | H→G       | exec_cancel    | (empty) |
//! | 0x0F | H→G       | quiesce_operations  | (empty) |
//! | 0x10 | G→H       | operations_quiesced    | (empty) |
//! | 0x11 | H→G       | resume_operations | (empty) |
//! | 0x12 | G→H       | operations_resumed | (empty) |
//! | 0xFF | G→H       | error             | `[2B error_len][error]` |
//!
//! Exec operation messages are request-scoped; host/guest dispatch layers
//! must use a non-zero sequence number for start/output/result/cancel.
//! `exec_output.output_seq` is per exec operation and starts at 0,
//! incrementing by 1 for each output frame across stdout and stderr.
//! `exec_start.expected_exit_count` may be zero, but the count field is
//! always present.

mod error;
mod frame;
mod payloads;
mod read;
mod wire;

pub use error::ProtocolError;
pub use frame::{Decoder, RawMessage, encode};
pub use payloads::empty::decode_empty_payload;
pub use payloads::error::{decode_error, encode_error};
pub use payloads::exec_operation::{
    DecodedExecOutput, DecodedExecResult, DecodedExecStart, ExecCapturedOutput, ExecOutputPolicy,
    ExecOutputStream, ExecStartEncodeRequest, ExecTermination, decode_exec_cancel,
    decode_exec_output, decode_exec_result, decode_exec_start, encode_exec_cancel,
    encode_exec_output, encode_exec_result, encode_exec_start,
    encode_exec_start_with_expected_exit_codes,
};
pub use payloads::process::{
    ProcessExit, decode_process_exit, decode_stdout_chunk, encode_process_exit, encode_stdout_chunk,
};
pub use payloads::spawn_process::{
    DecodedSpawnProcess, decode_spawn_process, decode_spawn_process_result, encode_spawn_process,
    encode_spawn_process_result,
};
pub use payloads::write_file::{
    decode_write_file, decode_write_file_result, encode_write_file, encode_write_file_result,
};
pub use wire::{
    EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED, EXEC_FLAG_SUDO, EXEC_OUTPUT_FLAG_TRUNCATED, HEADER_SIZE,
    MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_ERROR, MSG_EXEC_CANCEL, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT,
    MSG_EXEC_START, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_PING, MSG_PONG,
    MSG_PROCESS_EXIT, MSG_QUIESCE_OPERATIONS, MSG_READY, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK, MSG_SPAWN_PROCESS, MSG_SPAWN_PROCESS_RESULT, MSG_STDOUT_CHUNK,
    MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, SPAWN_PROCESS_FLAG_STREAM_STDOUT,
    SPAWN_PROCESS_FLAG_SUDO, VSOCK_PORT, WRITE_FILE_FLAG_APPEND, WRITE_FILE_FLAG_SUDO,
};
