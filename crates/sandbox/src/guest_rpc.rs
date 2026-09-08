//! Optional Guest-to-Runner RPC with host-derived assignment and stream ownership.

use std::io;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

/// Owned provider stream. Implementations must hold the authoritative normal
/// operation reservation until this stream is dropped, including during
/// handler work that does not read or write the guest connection.
pub trait GuestRpcStream: AsyncRead + AsyncWrite + Unpin + Send {}

/// A request connection accepted for an exact host-derived assignment.
#[must_use = "dropping the accepted stream releases its park reservation"]
pub struct AcceptedGuestRpc {
    /// Provider-owned identity, never taken from guest input.
    pub sandbox_id: String,
    /// Inseparable stream and normal-operation reservation.
    pub stream: Box<dyn GuestRpcStream>,
    /// The handler must select this during external handler work as well as guest I/O.
    /// Cancellation does not prove that a remote command had no effects.
    pub cancelled: CancellationToken,
}

/// Assignment-bound accept capability. A stale capability never follows reuse.
#[async_trait]
pub trait GuestRpcAcceptor: Send + Sync {
    async fn accept(&self) -> io::Result<AcceptedGuestRpc>;
}
