/// Fixed guest-facing network configuration inside each namespace.
///
/// Every namespace uses the same values — isolation guarantees no conflicts.
/// These must match the Firecracker VM's network configuration.
pub struct GuestNetwork {
    /// TAP device name inside namespace (must match Firecracker config).
    pub tap_name: &'static str,
    /// Guest MAC address (locally administered, fixed for all VMs).
    pub guest_mac: &'static str,
    /// Guest IP inside the VM.
    pub guest_ip: &'static str,
    /// Gateway IP (TAP device in namespace).
    pub gateway_ip: &'static str,
    /// Netmask for /29 subnet (dotted decimal for kernel boot args).
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

/// Generate kernel boot args for guest network configuration.
pub(crate) fn generate_guest_network_boot_args() -> String {
    format!(
        "ip={}::{}:{}:vm0-guest:eth0:off",
        GUEST_NETWORK.guest_ip, GUEST_NETWORK.gateway_ip, GUEST_NETWORK.netmask,
    )
}

/// Generate the full kernel boot args string (base flags + network config).
pub fn generate_boot_args() -> String {
    format!(
        "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on \
         quiet loglevel=0 nokaslr audit=0 numa=off mitigations=off noresume \
         init=/sbin/guest-init {}",
        generate_guest_network_boot_args(),
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
