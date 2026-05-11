mod error;
mod guest;
mod pool;

pub(crate) use guest::{GUEST_NETWORK, GuestNetwork};
pub(crate) use guest::{generate_boot_args, generate_boot_args_with_boot_generation};
pub use pool::{NetnsInfo, NetnsLease, NetnsPool, NetnsPoolConfig, NetnsPoolHandle};
