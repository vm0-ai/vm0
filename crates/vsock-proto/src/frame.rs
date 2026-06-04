use crate::error::ProtocolError;
use crate::read::{read_u8_at, read_u32_at};
use crate::wire::{HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE};
use std::convert::Infallible;

/// A raw decoded message.
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub msg_type: u8,
    pub seq: u32,
    pub payload: Vec<u8>,
}

impl RawMessage {
    pub fn as_borrowed(&self) -> BorrowedRawMessage<'_> {
        BorrowedRawMessage {
            msg_type: self.msg_type,
            seq: self.seq,
            payload: &self.payload,
        }
    }
}

/// A raw decoded message that borrows its payload from a decoder buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BorrowedRawMessage<'a> {
    pub msg_type: u8,
    pub seq: u32,
    pub payload: &'a [u8],
}

impl BorrowedRawMessage<'_> {
    pub fn to_owned_message(self) -> RawMessage {
        RawMessage {
            msg_type: self.msg_type,
            seq: self.seq,
            payload: self.payload.to_vec(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum DecodeWithError<E> {
    Protocol(ProtocolError),
    Visitor(E),
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
        let mut messages = Vec::new();
        let result = self.decode_with(data, |msg| {
            messages.push(msg.to_owned_message());
            Ok::<(), Infallible>(())
        });

        match result {
            Ok(()) => Ok(messages),
            Err(DecodeWithError::Protocol(error)) => Err(error),
            Err(DecodeWithError::Visitor(error)) => match error {},
        }
    }

    /// Feed data and visit complete messages while they still borrow the decoder buffer.
    pub fn decode_with<E>(
        &mut self,
        data: &[u8],
        mut visitor: impl FnMut(BorrowedRawMessage<'_>) -> Result<(), E>,
    ) -> Result<(), DecodeWithError<E>> {
        #[derive(Clone, Copy)]
        struct CompleteFrame {
            msg_type: u8,
            seq: u32,
            payload_start: usize,
            payload_end: usize,
            next_offset: usize,
        }

        self.buf.extend_from_slice(data);
        let mut offset = 0;
        let mut frames = Vec::new();

        while offset + HEADER_SIZE <= self.buf.len() {
            let length = match read_u32_at(&self.buf, offset) {
                Some(v) => v as usize,
                None => break,
            };

            if length > MAX_MESSAGE_SIZE {
                self.buf.clear();
                return Err(DecodeWithError::Protocol(ProtocolError::MessageTooLarge(
                    length,
                )));
            }
            if length < MIN_BODY_SIZE {
                self.buf.clear();
                return Err(DecodeWithError::Protocol(ProtocolError::MessageTooSmall(
                    length,
                )));
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
            let next_offset = offset + total;
            let payload_start = offset + HEADER_SIZE + MIN_BODY_SIZE;
            let payload_end = next_offset;
            frames.push(CompleteFrame {
                msg_type,
                seq,
                payload_start,
                payload_end,
                next_offset,
            });
            offset = next_offset;
        }

        for frame in frames {
            let payload = self
                .buf
                .get(frame.payload_start..frame.payload_end)
                .unwrap_or_default();
            let result = visitor(BorrowedRawMessage {
                msg_type: frame.msg_type,
                seq: frame.seq,
                payload,
            });
            if let Err(error) = result {
                self.buf.drain(..frame.next_offset);
                return Err(DecodeWithError::Visitor(error));
            }
        }

        // Compact: remove consumed bytes once at the end
        if offset > 0 {
            self.buf.drain(..offset);
        }

        Ok(())
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{MSG_PING, MSG_PONG, MSG_READY};

    #[test]
    fn encode_decode_roundtrip_empty_payload() {
        let data = encode(MSG_PING, 1, &[]).unwrap();
        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_PING);
        assert_eq!(msgs[0].seq, 1);
        assert!(msgs[0].payload.is_empty());
    }

    #[test]
    fn encode_decode_roundtrip_with_payload() {
        let data = encode(MSG_PING, 42, b"hello world").unwrap();
        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_PING);
        assert_eq!(msgs[0].seq, 42);
        assert_eq!(msgs[0].payload, b"hello world");
    }

    #[test]
    fn decoder_handles_partial_reads() {
        let data = encode(MSG_PONG, 7, &[]).unwrap();
        let mut dec = Decoder::new();

        // Feed first 4 bytes (header only)
        let msgs = dec.decode(&data[..4]).unwrap();
        assert!(msgs.is_empty());

        // Feed the rest
        let msgs = dec.decode(&data[4..]).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_PONG);
        assert_eq!(msgs[0].seq, 7);
    }

    #[test]
    fn decoder_handles_multiple_messages() {
        let mut data = encode(MSG_PING, 1, &[]).unwrap();
        data.extend_from_slice(&encode(MSG_PONG, 1, &[]).unwrap());
        data.extend_from_slice(&encode(MSG_READY, 0, &[]).unwrap());

        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].msg_type, MSG_PING);
        assert_eq!(msgs[1].msg_type, MSG_PONG);
        assert_eq!(msgs[2].msg_type, MSG_READY);
    }

    #[test]
    fn decoder_rejects_too_large() {
        // Craft a header claiming 17MB body
        let bad = (17 * 1024 * 1024_u32).to_be_bytes();
        let mut dec = Decoder::new();
        let err = dec.decode(&bad).unwrap_err();
        assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    }

    #[test]
    fn decoder_rejects_too_small() {
        // Body length 2 (less than MIN_BODY_SIZE=5)
        let bad = 2_u32.to_be_bytes();
        let mut dec = Decoder::new();
        let err = dec.decode(&bad).unwrap_err();
        assert!(matches!(err, ProtocolError::MessageTooSmall(2)));
    }

    #[test]
    fn decoder_byte_by_byte() {
        let data = encode(MSG_PING, 1, &[]).unwrap();
        let mut dec = Decoder::new();

        for (i, &byte) in data.iter().enumerate() {
            let msgs = dec.decode(&[byte]).unwrap();
            if i < data.len() - 1 {
                assert!(msgs.is_empty());
            } else {
                assert_eq!(msgs.len(), 1);
                assert_eq!(msgs[0].msg_type, MSG_PING);
            }
        }
    }

    #[test]
    fn decode_with_visits_borrowed_message() {
        let data = encode(MSG_PING, 42, b"hello world").unwrap();
        let mut dec = Decoder::new();
        let mut visited = Vec::new();

        dec.decode_with(&data, |msg| {
            visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
            Ok::<(), Infallible>(())
        })
        .unwrap();

        assert_eq!(visited, vec![(MSG_PING, 42, b"hello world".to_vec())]);
    }

    #[test]
    fn decode_with_handles_partial_reads() {
        let data = encode(MSG_PONG, 7, b"later").unwrap();
        let mut dec = Decoder::new();
        let mut visited = Vec::new();

        dec.decode_with(&data[..4], |msg| {
            visited.push(msg.to_owned_message());
            Ok::<(), Infallible>(())
        })
        .unwrap();
        assert!(visited.is_empty());

        dec.decode_with(&data[4..], |msg| {
            visited.push(msg.to_owned_message());
            Ok::<(), Infallible>(())
        })
        .unwrap();
        assert_eq!(visited.len(), 1);
        assert_eq!(visited[0].msg_type, MSG_PONG);
        assert_eq!(visited[0].seq, 7);
        assert_eq!(visited[0].payload, b"later");
    }

    #[test]
    fn decode_with_handles_multiple_messages() {
        let mut data = encode(MSG_PING, 1, b"a").unwrap();
        data.extend_from_slice(&encode(MSG_PONG, 2, b"b").unwrap());
        data.extend_from_slice(&encode(MSG_READY, 3, b"c").unwrap());
        let mut dec = Decoder::new();
        let mut visited = Vec::new();

        dec.decode_with(&data, |msg| {
            visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
            Ok::<(), Infallible>(())
        })
        .unwrap();

        assert_eq!(
            visited,
            vec![
                (MSG_PING, 1, b"a".to_vec()),
                (MSG_PONG, 2, b"b".to_vec()),
                (MSG_READY, 3, b"c".to_vec()),
            ]
        );
    }

    #[test]
    fn decode_with_preserves_protocol_errors() {
        let mut dec = Decoder::new();
        let err = dec
            .decode_with::<()>(&(17 * 1024 * 1024_u32).to_be_bytes(), |_| {
                panic!("visitor should not run for oversized frame")
            })
            .unwrap_err();
        assert!(matches!(
            err,
            DecodeWithError::Protocol(ProtocolError::MessageTooLarge(_))
        ));

        let err = dec
            .decode_with::<()>(&2_u32.to_be_bytes(), |_| {
                panic!("visitor should not run for too-small frame")
            })
            .unwrap_err();
        assert!(matches!(
            err,
            DecodeWithError::Protocol(ProtocolError::MessageTooSmall(2))
        ));
    }

    #[test]
    fn decode_with_rejects_protocol_error_before_visiting_prior_frames() {
        let mut data = encode(MSG_PING, 1, b"valid").unwrap();
        data.extend_from_slice(&(17 * 1024 * 1024_u32).to_be_bytes());
        let mut dec = Decoder::new();
        let mut visited = false;

        let err = dec
            .decode_with(&data, |_msg| {
                visited = true;
                Ok::<(), Infallible>(())
            })
            .unwrap_err();

        assert!(matches!(
            err,
            DecodeWithError::Protocol(ProtocolError::MessageTooLarge(_))
        ));
        assert!(!visited);

        dec.decode_with(&[], |_msg| {
            visited = true;
            Ok::<(), Infallible>(())
        })
        .unwrap();
        assert!(!visited);
    }

    #[test]
    fn decode_with_propagates_visitor_error() {
        #[derive(Debug, Clone, PartialEq, Eq)]
        enum VisitorError {
            Stop,
        }

        let mut data = encode(MSG_PING, 1, b"first").unwrap();
        data.extend_from_slice(&encode(MSG_PONG, 2, b"second").unwrap());
        let mut dec = Decoder::new();
        let err = dec
            .decode_with(&data, |_msg| Err(VisitorError::Stop))
            .unwrap_err();
        assert!(matches!(err, DecodeWithError::Visitor(VisitorError::Stop)));

        let mut visited = Vec::new();
        dec.decode_with(&[], |msg| {
            visited.push(msg.to_owned_message());
            Ok::<(), Infallible>(())
        })
        .unwrap();
        assert_eq!(visited.len(), 1);
        assert_eq!(visited[0].msg_type, MSG_PONG);
        assert_eq!(visited[0].payload, b"second");
    }
}
