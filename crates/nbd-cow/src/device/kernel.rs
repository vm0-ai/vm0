use std::future::Future;
use std::os::fd::OwnedFd;

use uuid::Uuid;

use crate::error::Result;
use crate::netlink;

use super::connection::{DeviceOwnership, device_ownership};
use super::create_timing::NbdNetlinkConnectTiming;

/// The kernel boundary used during creation, including unobserved-result cleanup.
/// Pool ownership, dispatch and retry policy remain outside this boundary.
pub(super) trait CreateKernel: Clone + Send + Sync + 'static {
    fn connect(
        &self,
        device_index: u32,
        client_fds: &[OwnedFd],
        size: u64,
        block_size: u64,
    ) -> (
        std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        NbdNetlinkConnectTiming,
    );

    fn verify_size(&self, device_index: u32, size: u64) -> impl Future<Output = bool> + Send;

    fn ownership(&self, device_index: u32, connection_id: Uuid) -> DeviceOwnership;

    fn disconnect(&self, device_index: u32) -> Result<()>;
}

#[derive(Clone, Copy)]
pub(super) struct NativeKernel;

impl CreateKernel for NativeKernel {
    fn connect(
        &self,
        device_index: u32,
        client_fds: &[OwnedFd],
        size: u64,
        block_size: u64,
    ) -> (
        std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        NbdNetlinkConnectTiming,
    ) {
        netlink::connect_device_with_state_timing(device_index, client_fds, size, block_size)
    }

    async fn verify_size(&self, device_index: u32, size: u64) -> bool {
        netlink::verify_device_size(device_index, size).await
    }

    fn ownership(&self, device_index: u32, connection_id: Uuid) -> DeviceOwnership {
        device_ownership(device_index, connection_id)
    }

    fn disconnect(&self, device_index: u32) -> Result<()> {
        netlink::disconnect(device_index)
    }
}
