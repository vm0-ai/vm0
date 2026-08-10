import { lookup, resolve4, resolve6 } from "node:dns/promises";
import { BlockList } from "node:net";

export interface ResolvedFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export function isCloudflareWorkerRuntime(): boolean {
  const runtimeNavigator: unknown = Reflect.get(globalThis, "navigator");
  return (
    runtimeNavigator !== null &&
    typeof runtimeNavigator === "object" &&
    "userAgent" in runtimeNavigator &&
    runtimeNavigator.userAgent === "Cloudflare-Workers"
  );
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
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    ranges.addSubnet(address, prefix, "ipv4");
  }
  return ranges;
})();

// IANA currently allocates globally routable IPv6 unicast from 2000::/3.
// Treat everything outside that range as non-public, then exclude the
// special-purpose ranges that sit inside it.
const PUBLIC_IPV6_RANGES: Readonly<BlockList> = (() => {
  const ranges = new BlockList();
  ranges.addSubnet("2000::", 3, "ipv6");
  return ranges;
})();

const BLOCKED_PUBLIC_IPV6_RANGES: Readonly<BlockList> = (() => {
  const ranges = new BlockList();
  ranges.addSubnet("2001::", 23, "ipv6");
  ranges.addSubnet("2001:db8::", 32, "ipv6");
  ranges.addSubnet("2002::", 16, "ipv6");
  ranges.addSubnet("3fff::", 20, "ipv6");
  return ranges;
})();

function fetchAddressIsBlocked({ address, family }: ResolvedFetchAddress) {
  if (family === 4) {
    return BLOCKED_IPV4_RANGES.check(address, "ipv4");
  }
  return (
    !PUBLIC_IPV6_RANGES.check(address, "ipv6") ||
    BLOCKED_PUBLIC_IPV6_RANGES.check(address, "ipv6")
  );
}

export async function resolveFetchHostAddresses(
  hostname: string,
): Promise<ResolvedFetchAddress[]> {
  if (isCloudflareWorkerRuntime()) {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);
    const addresses = [
      ...(ipv4.status === "fulfilled"
        ? ipv4.value.map((address) => {
            return { address, family: 4 as const };
          })
        : []),
      ...(ipv6.status === "fulfilled"
        ? ipv6.value.map((address) => {
            return { address, family: 6 as const };
          })
        : []),
    ];
    if (addresses.length === 0) {
      throw new Error(`Could not resolve ${hostname}`);
    }
    return addresses;
  }
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
