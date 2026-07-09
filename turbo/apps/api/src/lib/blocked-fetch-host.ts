import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

export interface ResolvedFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

// Non-public and address-translation ranges we must never fetch from.
const BLOCKED_IPV4_RANGES: Readonly<BlockList> = (() => {
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
  return ranges;
})();

const BLOCKED_IPV6_RANGES: Readonly<BlockList> = (() => {
  const ranges = new BlockList();
  ranges.addAddress("::1", "ipv6");
  ranges.addAddress("::", "ipv6");
  ranges.addSubnet("::ffff:0:0", 96, "ipv6");
  ranges.addSubnet("64:ff9b::", 96, "ipv6");
  ranges.addSubnet("64:ff9b:1::", 48, "ipv6");
  ranges.addSubnet("100::", 64, "ipv6");
  ranges.addSubnet("2001::", 23, "ipv6");
  ranges.addSubnet("2001:db8::", 32, "ipv6");
  ranges.addSubnet("2002::", 16, "ipv6");
  ranges.addSubnet("fc00::", 7, "ipv6");
  ranges.addSubnet("fe80::", 10, "ipv6");
  ranges.addSubnet("ff00::", 8, "ipv6");
  return ranges;
})();

function fetchAddressIsBlocked({ address, family }: ResolvedFetchAddress) {
  if (family === 4) {
    return BLOCKED_IPV4_RANGES.check(address, "ipv4");
  }
  return BLOCKED_IPV6_RANGES.check(address, "ipv6");
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
