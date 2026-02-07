mod error;
mod guest;
mod pool;
mod prerequisites;

// Re-exports: not all used internally yet, but form the public API of this module.
#[allow(unused_imports)]
pub use error::NetworkError;
#[allow(unused_imports)]
pub use guest::{GUEST_NETWORK, GuestNetwork, generate_guest_network_boot_args};
#[allow(unused_imports)]
pub use pool::{NetnsPool, NetnsPoolConfig, PooledNetns, cleanup_namespaces_by_index};
#[allow(unused_imports)]
pub use prerequisites::{PrerequisiteCheck, check_network_prerequisites};
