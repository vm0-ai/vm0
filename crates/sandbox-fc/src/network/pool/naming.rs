/// Namespace name prefix.
pub(super) const NS_PREFIX: &str = "vm0-ns-";
/// Host-side device name prefix.
const HOST_PREFIX: &str = "vm0-ve-";
/// First two octets shared by all veth IP addresses.
const IP_PREFIX: &str = "10.200";

/// Maximum pool index (0x00–0x3f), ensuring IPs stay within `10.200.0.0/16`.
pub(super) const MAX_POOLS: u32 = 64;
/// Maximum namespaces a single pool can own (index 0x00–0xff).
pub(super) const MAX_NAMESPACES: u32 = 256;

// Compile-time check: all /30 subnets fit within `10.200.0.0/16`.
// 64 pools × 256 ns × 4 addresses per /30 = 65536 = exactly 2^16.
const _: () = assert!(MAX_POOLS * MAX_NAMESPACES * 4 <= 65536);

/// Parsed Firecracker network namespace name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedNetnsName {
    /// Network namespace pool index.
    pub pool_index: u32,
    /// Namespace index within the pool.
    pub namespace_index: u32,
}

pub(super) fn format_hex_index(index: u32) -> String {
    format!("{index:02x}")
}

pub(super) fn make_ns_name(pool_idx: &str, ns_idx: &str) -> String {
    format!("{NS_PREFIX}{pool_idx}-{ns_idx}")
}

pub(super) fn make_host_device(pool_idx: &str, ns_idx: &str) -> String {
    format!("{HOST_PREFIX}{pool_idx}-{ns_idx}")
}

/// Generate a unique /30 IP pair for a veth link.
///
/// Each namespace gets a /30 subnet from the `10.200.0.0/16` range:
///
/// ```text
///   octet3     = pool_idx × 4 + ns_idx / 64
///   octet4_base = (ns_idx % 64) × 4
///   host_ip    = 10.200.{octet3}.{octet4_base + 1}
///   peer_ip    = 10.200.{octet3}.{octet4_base + 2}
/// ```
///
/// | pool | ns  | host_ip          | peer_ip          |
/// |------|-----|------------------|------------------|
/// | 0    | 0   | `10.200.0.1`     | `10.200.0.2`     |
/// | 0    | 1   | `10.200.0.5`     | `10.200.0.6`     |
/// | 0    | 64  | `10.200.1.1`     | `10.200.1.2`     |
/// | 1    | 0   | `10.200.4.1`     | `10.200.4.2`     |
/// | 63   | 255 | `10.200.255.253` | `10.200.255.254` |
///
/// Capacity: 64 pools × 256 ns × 4 addr = 65536 = `10.200.0.0/16`.
pub(super) fn generate_veth_ip_pair(pool_idx: u32, ns_idx: u32) -> (String, String) {
    // 64 /30 subnets per octet3 value (64 × 4 = 256 addresses)
    let octet3 = pool_idx * 4 + ns_idx / 64;
    let octet4_base = (ns_idx % 64) * 4;
    let host_ip = format!("{IP_PREFIX}.{octet3}.{}", octet4_base + 1);
    let peer_ip = format!("{IP_PREFIX}.{octet3}.{}", octet4_base + 2);
    (host_ip, peer_ip)
}

/// Parse a Firecracker network namespace name.
///
/// Returns `None` if the name doesn't match the expected format
/// `vm0-ns-{xx}-{xx}` where each index is exactly 2 lowercase hex
/// characters, or if either index is outside the supported bounds.
pub fn parse_netns_name(name: &str) -> Option<ParsedNetnsName> {
    let suffix = name.strip_prefix(NS_PREFIX)?;
    let (pool_hex, namespace_hex) = suffix.split_once('-')?;
    if !is_lower_hex2(pool_hex) || !is_lower_hex2(namespace_hex) {
        return None;
    }

    let pool_index = u32::from_str_radix(pool_hex, 16).ok()?;
    let namespace_index = u32::from_str_radix(namespace_hex, 16).ok()?;
    if pool_index >= MAX_POOLS || namespace_index >= MAX_NAMESPACES {
        return None;
    }

    Some(ParsedNetnsName {
        pool_index,
        namespace_index,
    })
}

/// Check that a string is exactly 2 lowercase hex characters.
fn is_lower_hex2(s: &str) -> bool {
    s.len() == 2
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_hex_index_zero() {
        assert_eq!(format_hex_index(0), "00");
    }

    #[test]
    fn format_hex_index_single_digit() {
        assert_eq!(format_hex_index(10), "0a");
    }

    #[test]
    fn format_hex_index_two_digits() {
        assert_eq!(format_hex_index(63), "3f");
    }

    #[test]
    fn make_ns_name_formats_correctly() {
        assert_eq!(make_ns_name("00", "0a"), "vm0-ns-00-0a");
    }

    #[test]
    fn make_host_device_formats_correctly() {
        assert_eq!(make_host_device("01", "ff"), "vm0-ve-01-ff");
    }

    #[test]
    fn generate_veth_ip_pair_first_namespace() {
        let (host, peer) = generate_veth_ip_pair(0, 0);
        assert_eq!(host, "10.200.0.1");
        assert_eq!(peer, "10.200.0.2");
    }

    #[test]
    fn generate_veth_ip_pair_second_namespace() {
        let (host, peer) = generate_veth_ip_pair(0, 1);
        assert_eq!(host, "10.200.0.5");
        assert_eq!(peer, "10.200.0.6");
    }

    #[test]
    fn generate_veth_ip_pair_crosses_octet3_boundary() {
        // ns_index=64 → octet3 bumps by 1
        let (host, peer) = generate_veth_ip_pair(0, 64);
        assert_eq!(host, "10.200.1.1");
        assert_eq!(peer, "10.200.1.2");
    }

    #[test]
    fn generate_veth_ip_pair_second_pool() {
        let (host, peer) = generate_veth_ip_pair(1, 0);
        assert_eq!(host, "10.200.4.1");
        assert_eq!(peer, "10.200.4.2");
    }

    #[test]
    fn generate_veth_ip_pair_max_values() {
        let (host, peer) = generate_veth_ip_pair(63, 255);
        assert_eq!(host, "10.200.255.253");
        assert_eq!(peer, "10.200.255.254");
    }

    #[test]
    fn generate_veth_ip_pair_no_overlap_across_pools() {
        let (host_0_last, _) = generate_veth_ip_pair(0, 255);
        let (host_1_first, _) = generate_veth_ip_pair(1, 0);
        assert_ne!(host_0_last, host_1_first);
    }

    #[test]
    fn generate_veth_ip_pair_no_overlap_within_pool() {
        let mut seen = std::collections::HashSet::new();
        for ns in 0..MAX_NAMESPACES {
            let (host, peer) = generate_veth_ip_pair(0, ns);
            assert!(seen.insert(host.clone()), "duplicate host IP: {host}");
            assert!(seen.insert(peer.clone()), "duplicate peer IP: {peer}");
        }
    }

    #[test]
    fn parse_netns_name_valid() {
        assert_eq!(
            parse_netns_name("vm0-ns-00-0a"),
            Some(ParsedNetnsName {
                pool_index: 0,
                namespace_index: 10,
            })
        );
        assert_eq!(
            parse_netns_name("vm0-ns-3f-ff"),
            Some(ParsedNetnsName {
                pool_index: 63,
                namespace_index: 255,
            })
        );
        assert_eq!(
            parse_netns_name("vm0-ns-0a-00"),
            Some(ParsedNetnsName {
                pool_index: 10,
                namespace_index: 0,
            })
        );
    }

    #[test]
    fn parse_netns_name_wrong_prefix() {
        assert_eq!(parse_netns_name("not-a-ns"), None);
        assert_eq!(parse_netns_name("other-00-0a"), None);
    }

    #[test]
    fn parse_netns_name_missing_or_malformed_parts() {
        assert_eq!(parse_netns_name("vm0-ns-"), None);
        assert_eq!(parse_netns_name("vm0-ns-00"), None);
        assert_eq!(parse_netns_name("vm0-ns-000a"), None);
        assert_eq!(parse_netns_name("vm0-ns-00-0a-extra"), None);
    }

    #[test]
    fn parse_netns_name_empty_parts() {
        assert_eq!(parse_netns_name("vm0-ns--0a"), None);
        assert_eq!(parse_netns_name("vm0-ns-00-"), None);
    }

    #[test]
    fn parse_netns_name_invalid_hex() {
        assert_eq!(parse_netns_name("vm0-ns-zz-00"), None);
        assert_eq!(parse_netns_name("vm0-ns-00-zz"), None);
        assert_eq!(parse_netns_name("vm0-ns-0A-00"), None);
        assert_eq!(parse_netns_name("vm0-ns-00-0A"), None);
    }

    #[test]
    fn parse_netns_name_rejects_out_of_range_pool() {
        assert_eq!(parse_netns_name("vm0-ns-40-00"), None);
        assert_eq!(parse_netns_name("vm0-ns-ff-00"), None);
    }

    #[test]
    fn names_roundtrip() {
        let pool_idx = format_hex_index(5);
        let ns_idx = format_hex_index(42);
        let name = make_ns_name(&pool_idx, &ns_idx);
        let parsed = parse_netns_name(&name).expect("should parse");
        assert_eq!(parsed.pool_index, 5);
        assert_eq!(parsed.namespace_index, 42);
        let parsed_pool_idx = format_hex_index(parsed.pool_index);
        let parsed_ns_idx = format_hex_index(parsed.namespace_index);
        assert_eq!(
            make_host_device(&parsed_pool_idx, &parsed_ns_idx),
            "vm0-ve-05-2a"
        );
    }

    #[test]
    fn generate_veth_ip_pair_no_overlap_all_pools() {
        let mut seen = std::collections::HashSet::new();
        for pool in 0..MAX_POOLS {
            for ns in 0..MAX_NAMESPACES {
                let (host, peer) = generate_veth_ip_pair(pool, ns);
                assert!(
                    seen.insert(host.clone()),
                    "dup host: {host} (pool={pool}, ns={ns})"
                );
                assert!(
                    seen.insert(peer.clone()),
                    "dup peer: {peer} (pool={pool}, ns={ns})"
                );
            }
        }
        // 64 pools × 256 ns × 2 addrs = 32768 unique IPs
        assert_eq!(seen.len(), 32768);
    }

    #[test]
    fn generate_veth_ip_pair_valid_slash30_alignment() {
        // In a /30 subnet: base is divisible by 4, host=base+1, peer=base+2
        for pool in [0, 1, 31, 63] {
            for ns in [0, 1, 63, 64, 127, 128, 255] {
                let (host, peer) = generate_veth_ip_pair(pool, ns);
                let host_octet4: u32 = host.rsplit('.').next().unwrap().parse().unwrap();
                let peer_octet4: u32 = peer.rsplit('.').next().unwrap().parse().unwrap();
                assert_eq!(
                    host_octet4 % 4,
                    1,
                    "host octet4 {host_octet4} not base+1 (pool={pool}, ns={ns})"
                );
                assert_eq!(
                    peer_octet4 % 4,
                    2,
                    "peer octet4 {peer_octet4} not base+2 (pool={pool}, ns={ns})"
                );
                assert_eq!(peer_octet4, host_octet4 + 1);
            }
        }
    }

    #[test]
    fn generate_veth_ip_pair_octets_in_range() {
        for pool in 0..MAX_POOLS {
            for ns in 0..MAX_NAMESPACES {
                let (host, _) = generate_veth_ip_pair(pool, ns);
                let octets: Vec<u32> = host.split('.').map(|o| o.parse().unwrap()).collect();
                assert_eq!(octets[0], 10);
                assert_eq!(octets[1], 200);
                assert!(
                    octets[2] <= 255,
                    "octet3 out of range: {} (pool={pool}, ns={ns})",
                    octets[2]
                );
                assert!(
                    octets[3] <= 255,
                    "octet4 out of range: {} (pool={pool}, ns={ns})",
                    octets[3]
                );
            }
        }
    }

    #[test]
    fn parse_netns_name_extra_hyphens_rejected() {
        // Rejects malformed names that could produce device names exceeding IFNAMSIZ
        assert_eq!(parse_netns_name("vm0-ns-00-0a-extra"), None);
    }

    #[test]
    fn parse_netns_name_bare_prefix() {
        assert_eq!(parse_netns_name("vm0-ns-"), None);
    }
}
