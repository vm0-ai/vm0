import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

export interface ResolvedFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

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

function fetchAddressIsBlocked({ address, family }: ResolvedFetchAddress) {
  return BLOCKED_IP_RANGES.check(address, family === 6 ? "ipv6" : "ipv4");
}

export async function resolveFetchHostAddresses(
  hostname: string,
): Promise<ResolvedFetchAddress[]> {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map(({ address, family }) => {
    return { address, family: family === 6 ? 6 : 4 };
  });
}

export function fetchHostHasBlockedAddress(
  addresses: readonly ResolvedFetchAddress[],
): boolean {
  return addresses.some(fetchAddressIsBlocked);
}
