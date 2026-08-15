interface PublicDestinationIpv6Policy {
  readonly globalUnicastFirstMin: number;
  readonly globalUnicastFirstMax: number;
  readonly ietfProtocolAssignmentsFirst: number;
  readonly ietfProtocolAssignmentsSecondMax: number;
  readonly documentationSecond: number;
  readonly sixToFourFirst: number;
  readonly specialExactSecond: number;
  readonly specialExactLastMin: number;
  readonly specialExactLastMax: number;
  readonly amtSecond: number;
  readonly as112Second: number;
  readonly as112Third: number;
  readonly orchidSecondMin: number;
  readonly orchidSecondMax: number;
  readonly droneRemoteIdSecondMin: number;
  readonly droneRemoteIdSecondMax: number;
  readonly expandedDocumentationFirst: number;
  readonly expandedDocumentationSecondMax: number;
}

interface PublicDestinationAddressPolicy {
  readonly ipv4NonPublicRanges: readonly (readonly [number, number])[];
  readonly ipv6: PublicDestinationIpv6Policy;
}

/**
 * Native public-unicast membership coalesced from the IANA special-purpose
 * address registries and non-unicast space. The IPv4 ranges keep the public
 * 192.0.0.9 and 192.0.0.10 exceptions outside the blocked subranges. Native
 * IPv6 public unicast is limited to 2000::/3, with reachable allocations
 * inside the otherwise non-global 2001::/23 block represented below.
 *
 * This policy is shared with the runner's generated Python binding. Parsing
 * and trust-boundary enforcement remain runtime-specific.
 */
export const PUBLIC_DESTINATION_ADDRESS_POLICY = {
  ipv4NonPublicRanges: [
    [0x00000000, 0x00ffffff],
    [0x0a000000, 0x0affffff],
    [0x64400000, 0x647fffff],
    [0x7f000000, 0x7fffffff],
    [0xa9fe0000, 0xa9feffff],
    [0xac100000, 0xac1fffff],
    [0xc0000000, 0xc0000008],
    [0xc000000b, 0xc00000ff],
    [0xc0000200, 0xc00002ff],
    [0xc0586300, 0xc05863ff],
    [0xc0a80000, 0xc0a8ffff],
    [0xc6120000, 0xc613ffff],
    [0xc6336400, 0xc63364ff],
    [0xcb007100, 0xcb0071ff],
    [0xe0000000, 0xffffffff],
  ],
  ipv6: {
    globalUnicastFirstMin: 0x2000,
    globalUnicastFirstMax: 0x3fff,
    ietfProtocolAssignmentsFirst: 0x2001,
    ietfProtocolAssignmentsSecondMax: 0x01ff,
    documentationSecond: 0x0db8,
    sixToFourFirst: 0x2002,
    specialExactSecond: 0x0001,
    specialExactLastMin: 0x0001,
    specialExactLastMax: 0x0003,
    amtSecond: 0x0003,
    as112Second: 0x0004,
    as112Third: 0x0112,
    orchidSecondMin: 0x0020,
    orchidSecondMax: 0x002f,
    droneRemoteIdSecondMin: 0x0030,
    droneRemoteIdSecondMax: 0x003f,
    expandedDocumentationFirst: 0x3fff,
    expandedDocumentationSecondMax: 0x0fff,
  },
} as const satisfies PublicDestinationAddressPolicy;
