mod error;
mod guest;
mod pool;

pub use guest::generate_boot_args;
pub use guest::{GUEST_NETWORK, GuestNetwork};
#[allow(deprecated)]
pub use pool::{NetnsInfo, NetnsLease, NetnsPool, NetnsPoolConfig, PooledNetns};
