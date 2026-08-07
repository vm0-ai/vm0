import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

export interface ResolvedFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface DnsJsonAnswer {
  readonly data: string;
  readonly type: number;
}

interface DnsJsonResponse {
  readonly Answer?: readonly DnsJsonAnswer[];
}

export function isCloudflareWorkerRuntime(): boolean {
  return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

function isDnsJsonResponse(value: unknown): value is DnsJsonResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const answer = (value as { readonly Answer?: unknown }).Answer;
  return (
    answer === undefined ||
    (Array.isArray(answer) &&
      answer.every((entry) => {
        return (
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.data === "string" &&
          typeof entry.type === "number"
        );
      }))
  );
}

async function resolveWithDnsOverHttps(
  hostname: string,
  type: "A" | "AAAA",
): Promise<ResolvedFetchAddress[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`DNS over HTTPS returned ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isDnsJsonResponse(payload)) {
    throw new Error("DNS over HTTPS returned an invalid response");
  }
  const expectedType = type === "A" ? 1 : 28;
  return (payload.Answer ?? [])
    .filter((answer) => {
      return answer.type === expectedType;
    })
    .map((answer) => {
      return { address: answer.data, family: type === "A" ? 4 : 6 };
    });
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
    const [ipv4, ipv6] = await Promise.all([
      resolveWithDnsOverHttps(hostname, "A"),
      resolveWithDnsOverHttps(hostname, "AAAA"),
    ]);
    return [...ipv4, ...ipv6];
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
