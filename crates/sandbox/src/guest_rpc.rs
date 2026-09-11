//! Optional Guest-to-Runner RPC with host-derived assignment and stream ownership.

use std::io;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

/// Shared ownership of one already-admitted provider operation.
///
/// The final owner releases the authoritative normal-operation reservation.
/// Retaining this guard does not admit new work, extend the assignment, or
/// replace observing [`AcceptedGuestRpc::cancelled`].
#[derive(Clone)]
#[must_use = "keep the operation guard alive until its admitted work finishes"]
pub struct GuestRpcOperation {
    _reservation: Arc<dyn Send + Sync>,
}

impl GuestRpcOperation {
    /// Wrap the provider's authoritative reservation from successful admission.
    ///
    /// Providers must retain a clone in the stream and share this same operation
    /// with handler work; constructing a guard is not an admission check.
    pub fn new(reservation: impl Send + Sync + 'static) -> Self {
        Self {
            _reservation: Arc::new(reservation),
        }
    }
}

/// Owned provider stream retaining its authoritative normal-operation guard.
pub trait GuestRpcStream: AsyncRead + AsyncWrite + Unpin + Send {
    /// Retain this stream's already-admitted operation independently of its I/O.
    ///
    /// Both the stream and returned owner must hold the same reservation. The
    /// caller must retain its guard through all detached work and continue to
    /// observe the accepted assignment's cancellation signal.
    fn retain_operation(&self) -> GuestRpcOperation;
}

/// A request connection accepted for an exact host-derived assignment.
#[must_use = "keep the stream or a retained operation alive through admitted work"]
pub struct AcceptedGuestRpc {
    /// Provider-owned identity, never taken from guest input.
    pub sandbox_id: String,
    /// Stream owning a share of its normal-operation reservation.
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
