/// Fixed guest-facing network configuration inside each namespace.
///
/// Every namespace uses the same values — isolation guarantees no conflicts.
/// These must match the Firecracker VM's network configuration.
pub struct GuestNetwork {
    /// TAP device name inside namespace (must match Firecracker config).
    pub tap_name: &'static str,
    /// Guest MAC address (locally administered, fixed for all VMs).
    #[allow(dead_code)]
    pub guest_mac: &'static str,
    /// Guest IP inside the VM.
    #[allow(dead_code)]
    pub guest_ip: &'static str,
    /// Gateway IP (TAP device in namespace).
    pub gateway_ip: &'static str,
    /// Netmask for /29 subnet (dotted decimal for kernel boot args).
    #[allow(dead_code)]
    pub netmask: &'static str,
    /// CIDR prefix length (for ip commands).
    pub prefix_len: u8,
}

pub const GUEST_NETWORK: GuestNetwork = GuestNetwork {
    tap_name: "vm0-tap",
    guest_mac: "02:00:00:00:00:01",
    guest_ip: "192.168.241.2",
    gateway_ip: "192.168.241.1",
    netmask: "255.255.255.248",
    prefix_len: 29,
};

#[allow(dead_code)]
/// Generate kernel boot args for guest network configuration.
pub fn generate_guest_network_boot_args() -> String {
    format!(
        "ip={}::{}:{}:vm0-guest:eth0:off",
        GUEST_NETWORK.guest_ip, GUEST_NETWORK.gateway_ip, GUEST_NETWORK.netmask,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_network_boot_args_format() {
        let args = generate_guest_network_boot_args();
        assert_eq!(
            args,
            "ip=192.168.241.2::192.168.241.1:255.255.255.248:vm0-guest:eth0:off"
        );
    }

    #[test]
    fn guest_network_prefix_len_matches_netmask() {
        // /29 = 255.255.255.248 (8 addresses, 6 usable)
        assert_eq!(GUEST_NETWORK.prefix_len, 29);
        assert_eq!(GUEST_NETWORK.netmask, "255.255.255.248");
    }
}
