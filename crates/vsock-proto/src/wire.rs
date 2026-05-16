/// Header size (4-byte length prefix).
pub const HEADER_SIZE: usize = 4;

/// Maximum message body size (16 MB).
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

/// Minimum body size: type (1) + seq (4).
pub const MIN_BODY_SIZE: usize = 5;

// Message type constants.
pub const MSG_READY: u8 = 0x00;
pub const MSG_PING: u8 = 0x01;
pub const MSG_PONG: u8 = 0x02;
pub const MSG_WRITE_FILE: u8 = 0x03;
pub const MSG_WRITE_FILE_RESULT: u8 = 0x04;
pub const MSG_SPAWN_PROCESS: u8 = 0x05;
pub const MSG_SPAWN_PROCESS_RESULT: u8 = 0x06;
pub const MSG_PROCESS_EXIT: u8 = 0x07;
pub const MSG_SHUTDOWN: u8 = 0x08;
pub const MSG_SHUTDOWN_ACK: u8 = 0x09;
pub const MSG_STDOUT_CHUNK: u8 = 0x0A;
pub const MSG_EXEC_START: u8 = 0x0B;
pub const MSG_EXEC_OUTPUT: u8 = 0x0C;
pub const MSG_EXEC_RESULT: u8 = 0x0D;
pub const MSG_EXEC_CANCEL: u8 = 0x0E;
pub const MSG_QUIESCE_OPERATIONS: u8 = 0x0F;
pub const MSG_OPERATIONS_QUIESCED: u8 = 0x10;
pub const MSG_RESUME_OPERATIONS: u8 = 0x11;
pub const MSG_OPERATIONS_RESUMED: u8 = 0x12;
pub const MSG_PROCESS_CONTROL: u8 = 0x13;
pub const MSG_PROCESS_CONTROL_RESULT: u8 = 0x14;
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

// Spawn-process payload flags.
pub const SPAWN_PROCESS_FLAG_SUDO: u8 = 0x01;
pub const SPAWN_PROCESS_FLAG_STREAM_STDOUT: u8 = 0x02;
pub const SPAWN_PROCESS_FLAG_CONTROL_NONCE: u8 = 0x04;
pub const SPAWN_PROCESS_FLAG_CONTROL_SINK: u8 = 0x08;

// Exec operation payload flags.
pub const EXEC_FLAG_SUDO: u8 = 0x01;
pub const EXEC_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;
pub const EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;

// Write-file payload flags.
pub const WRITE_FILE_FLAG_SUDO: u8 = 0x01;
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
    }
}
