/// Header size (4-byte length prefix).
pub const HEADER_SIZE: usize = 4;

/// Maximum message body size (16 MB).
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

/// Minimum body size: type (1) + seq (4).
pub const MIN_BODY_SIZE: usize = 5;

/// Guest-to-host ready notification with an empty payload.
pub const MSG_READY: u8 = 0x00;

/// Host-to-guest ping request with an empty payload.
pub const MSG_PING: u8 = 0x01;

/// Guest-to-host pong response with an empty payload.
pub const MSG_PONG: u8 = 0x02;

/// Host-to-guest write-file request.
pub const MSG_WRITE_FILE: u8 = 0x03;

/// Guest-to-host write-file completion response.
pub const MSG_WRITE_FILE_RESULT: u8 = 0x04;

/// Host-to-guest process spawn request.
pub const MSG_SPAWN_PROCESS: u8 = 0x05;

/// Guest-to-host process spawn response containing the spawned pid.
pub const MSG_SPAWN_PROCESS_RESULT: u8 = 0x06;

/// Guest-to-host process exit notification for a spawn request.
pub const MSG_PROCESS_EXIT: u8 = 0x07;

/// Host-to-guest shutdown request with an empty payload.
pub const MSG_SHUTDOWN: u8 = 0x08;

/// Guest-to-host shutdown acknowledgement with an empty payload.
pub const MSG_SHUTDOWN_ACK: u8 = 0x09;

/// Guest-to-host stdout stream chunk for a spawn request.
pub const MSG_STDOUT_CHUNK: u8 = 0x0A;

/// Host-to-guest exec operation start request.
pub const MSG_EXEC_START: u8 = 0x0B;

/// Guest-to-host exec operation output chunk.
pub const MSG_EXEC_OUTPUT: u8 = 0x0C;

/// Guest-to-host exec operation terminal result.
pub const MSG_EXEC_RESULT: u8 = 0x0D;

/// Host-to-guest exec operation cancellation request.
pub const MSG_EXEC_CANCEL: u8 = 0x0E;

/// Host-to-guest request to fence new guest operations.
pub const MSG_QUIESCE_OPERATIONS: u8 = 0x0F;

/// Guest-to-host acknowledgement that operations are quiesced.
pub const MSG_OPERATIONS_QUIESCED: u8 = 0x10;

/// Host-to-guest request to resume guest operations.
pub const MSG_RESUME_OPERATIONS: u8 = 0x11;

/// Guest-to-host acknowledgement that operations resumed.
pub const MSG_OPERATIONS_RESUMED: u8 = 0x12;

/// Host-to-guest control message for an active spawn request.
pub const MSG_PROCESS_CONTROL: u8 = 0x13;

/// Guest-to-host process control delivery result.
pub const MSG_PROCESS_CONTROL_RESULT: u8 = 0x14;

/// Guest-to-host exec operation start acknowledgement.
pub const MSG_EXEC_STARTED: u8 = 0x15;

/// Host-to-guest control message for an active exec operation.
pub const MSG_EXEC_CONTROL: u8 = 0x16;

/// Guest-to-host exec control delivery result.
pub const MSG_EXEC_CONTROL_RESULT: u8 = 0x17;

/// Guest-to-host protocol error response.
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

/// Spawn-process payload flag requesting sudo execution.
pub const SPAWN_PROCESS_FLAG_SUDO: u8 = 0x01;

/// Spawn-process payload flag requesting stdout streaming.
pub const SPAWN_PROCESS_FLAG_STREAM_STDOUT: u8 = 0x02;

/// Spawn-process payload flag indicating a control nonce is present.
pub const SPAWN_PROCESS_FLAG_CONTROL_NONCE: u8 = 0x04;

/// Spawn-process payload flag requesting a process-control sink.
pub const SPAWN_PROCESS_FLAG_CONTROL_SINK: u8 = 0x08;

/// Exec-start payload flag requesting sudo execution.
pub const EXEC_FLAG_SUDO: u8 = 0x01;

/// Exec-output payload flag indicating the emitted chunk was truncated.
pub const EXEC_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;

/// Exec-result captured-output flag indicating retained bytes were truncated.
pub const EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;

/// Write-file payload flag requesting sudo file access.
pub const WRITE_FILE_FLAG_SUDO: u8 = 0x01;

/// Write-file payload flag requesting append instead of overwrite.
pub const WRITE_FILE_FLAG_APPEND: u8 = 0x02;

pub(crate) const MAX_PAYLOAD_SIZE: usize = MAX_MESSAGE_SIZE - MIN_BODY_SIZE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_process_keeps_existing_wire_values() {
        assert_eq!(MSG_SPAWN_PROCESS, 0x05);
        assert_eq!(MSG_SPAWN_PROCESS_RESULT, 0x06);
    }

    #[test]
    fn process_control_keeps_wire_values() {
        assert_eq!(MSG_PROCESS_CONTROL, 0x13);
        assert_eq!(MSG_PROCESS_CONTROL_RESULT, 0x14);
    }

    #[test]
    fn exec_operation_keeps_existing_wire_values() {
        assert_eq!(MSG_EXEC_START, 0x0B);
        assert_eq!(MSG_EXEC_OUTPUT, 0x0C);
        assert_eq!(MSG_EXEC_RESULT, 0x0D);
        assert_eq!(MSG_EXEC_CANCEL, 0x0E);
        assert_eq!(MSG_EXEC_STARTED, 0x15);
        assert_eq!(MSG_EXEC_CONTROL, 0x16);
        assert_eq!(MSG_EXEC_CONTROL_RESULT, 0x17);
    }
}
