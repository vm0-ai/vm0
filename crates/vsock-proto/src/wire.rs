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

/// Host-to-guest shutdown request with an empty payload.
pub const MSG_SHUTDOWN: u8 = 0x05;

/// Guest-to-host shutdown acknowledgement with an empty payload.
pub const MSG_SHUTDOWN_ACK: u8 = 0x06;

/// Host-to-guest exec operation start request.
pub const MSG_EXEC_START: u8 = 0x07;

/// Guest-to-host exec operation output chunk.
pub const MSG_EXEC_OUTPUT: u8 = 0x08;

/// Guest-to-host exec operation terminal result.
pub const MSG_EXEC_RESULT: u8 = 0x09;

/// Host-to-guest exec operation cancellation request.
pub const MSG_EXEC_CANCEL: u8 = 0x0A;

/// Host-to-guest request to fence new guest operations.
pub const MSG_QUIESCE_OPERATIONS: u8 = 0x0B;

/// Guest-to-host acknowledgement that operations are quiesced.
pub const MSG_OPERATIONS_QUIESCED: u8 = 0x0C;

/// Host-to-guest request to resume guest operations.
pub const MSG_RESUME_OPERATIONS: u8 = 0x0D;

/// Guest-to-host acknowledgement that operations resumed.
pub const MSG_OPERATIONS_RESUMED: u8 = 0x0E;

/// Guest-to-host exec operation start acknowledgement.
pub const MSG_EXEC_STARTED: u8 = 0x0F;

/// Host-to-guest control message for an active exec operation.
pub const MSG_EXEC_CONTROL: u8 = 0x10;

/// Guest-to-host exec control delivery result.
pub const MSG_EXEC_CONTROL_RESULT: u8 = 0x11;

/// Guest-to-host protocol error response.
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

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
    fn message_type_wire_values_are_compact() {
        assert_eq!(MSG_SHUTDOWN, 0x05);
        assert_eq!(MSG_SHUTDOWN_ACK, 0x06);
        assert_eq!(MSG_EXEC_START, 0x07);
        assert_eq!(MSG_EXEC_OUTPUT, 0x08);
        assert_eq!(MSG_EXEC_RESULT, 0x09);
        assert_eq!(MSG_EXEC_CANCEL, 0x0A);
        assert_eq!(MSG_QUIESCE_OPERATIONS, 0x0B);
        assert_eq!(MSG_OPERATIONS_QUIESCED, 0x0C);
        assert_eq!(MSG_RESUME_OPERATIONS, 0x0D);
        assert_eq!(MSG_OPERATIONS_RESUMED, 0x0E);
        assert_eq!(MSG_EXEC_STARTED, 0x0F);
        assert_eq!(MSG_EXEC_CONTROL, 0x10);
        assert_eq!(MSG_EXEC_CONTROL_RESULT, 0x11);
    }
}
