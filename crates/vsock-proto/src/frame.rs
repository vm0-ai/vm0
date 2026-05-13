use crate::error::ProtocolError;
use crate::read::{read_u8_at, read_u32_at};
use crate::wire::{HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE};

/// A raw decoded message.
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub msg_type: u8,
    pub seq: u32,
    pub payload: Vec<u8>,
}

/// Encode a raw message: `[4-byte length][1-byte type][4-byte seq][payload]`.
pub fn encode(msg_type: u8, seq: u32, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let body_len = 1 + 4 + payload.len();
    if body_len > MAX_MESSAGE_SIZE {
        return Err(ProtocolError::MessageTooLarge(body_len));
    }
    let mut buf = Vec::with_capacity(HEADER_SIZE + body_len);
    buf.extend_from_slice(&(body_len as u32).to_be_bytes());
    buf.push(msg_type);
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.extend_from_slice(payload);
    Ok(buf)
}

/// Buffered message decoder for streaming data.
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(64 * 1024),
        }
    }

    /// Feed data and extract complete messages.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<RawMessage>, ProtocolError> {
        self.buf.extend_from_slice(data);
        let mut messages = Vec::new();
        let mut offset = 0;

        while offset + HEADER_SIZE <= self.buf.len() {
            let length = match read_u32_at(&self.buf, offset) {
                Some(v) => v as usize,
                None => break,
            };

            if length > MAX_MESSAGE_SIZE {
                self.buf.clear();
                return Err(ProtocolError::MessageTooLarge(length));
            }
            if length < MIN_BODY_SIZE {
                self.buf.clear();
                return Err(ProtocolError::MessageTooSmall(length));
            }

            let total = HEADER_SIZE + length;
            if offset + total > self.buf.len() {
                break;
            }

            let msg_type = match read_u8_at(&self.buf, offset + HEADER_SIZE) {
                Some(v) => v,
                None => break,
            };
            let seq = match read_u32_at(&self.buf, offset + HEADER_SIZE + 1) {
                Some(v) => v,
                None => break,
            };
            let payload = self
                .buf
                .get(offset + HEADER_SIZE + MIN_BODY_SIZE..offset + total)
                .unwrap_or_default()
                .to_vec();

            messages.push(RawMessage {
                msg_type,
                seq,
                payload,
            });
            offset += total;
        }

        // Compact: remove consumed bytes once at the end
        if offset > 0 {
            self.buf.drain(..offset);
        }

        Ok(messages)
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}
