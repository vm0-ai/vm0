mod error;
mod pool;

pub use error::OverlayError;
pub use pool::{Ext4Creator, OverlayCreator, OverlayPool, OverlayPoolConfig};
