use std::io;

use vsock_proto::ProtocolError;

/// Convert a ProtocolError to an io::Error
pub(crate) fn to_io_error(e: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}
