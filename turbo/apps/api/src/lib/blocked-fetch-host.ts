import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

// Loopback, private, link-local and CGNAT ranges we must never fetch from.
const BLOCKED_IP_RANGES: Readonly<BlockList> = (() => {
  const ranges = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
  ] as const) {
    ranges.addSubnet(address, prefix, "ipv4");
  }
  ranges.addAddress("::1", "ipv6");
  ranges.addSubnet("fc00::", 7, "ipv6");
  ranges.addSubnet("fe80::", 10, "ipv6");
  return ranges;
})();

/**
 * SSRF guard for server-side fetches of user-supplied URLs. Resolves the host
 * and returns true if any resolved address is loopback/private/link-local — so
 * a public hostname cannot be pointed at an internal IP (e.g. cloud metadata at
 * 169.254.169.254). IP literals and localhost resolve to themselves and go
 * through the same check. Throws if the host cannot be resolved.
 */
export async function hostResolvesToBlockedAddress(
  hostname: string,
): Promise<boolean> {
  const addresses = await lookup(hostname, { all: true });
  return addresses.some(({ address, family }) => {
    return BLOCKED_IP_RANGES.check(address, family === 6 ? "ipv6" : "ipv4");
  });
}
