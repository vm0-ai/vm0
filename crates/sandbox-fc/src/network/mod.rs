mod error;
mod guest;
mod pool;
mod prerequisites;

#[allow(unused_imports)]
pub use error::NetworkError;
#[allow(unused_imports)]
pub use guest::generate_guest_network_boot_args;
pub use guest::{GUEST_NETWORK, GuestNetwork};
pub use pool::{NetnsPool, NetnsPoolConfig, PooledNetns, cleanup_namespaces_by_index};
#[allow(unused_imports)]
pub use prerequisites::{PrerequisiteCheck, check_network_prerequisites};
