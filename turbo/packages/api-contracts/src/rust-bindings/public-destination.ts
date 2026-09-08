import { writeFile } from "node:fs/promises";
import { PUBLIC_DESTINATION_ADDRESS_POLICY } from "@okouai/connectors/public-destination-policy";

export async function generatePublicDestinationPolicy(): Promise<void> {
  const { ipv4NonPublicRanges, ipv6 } = PUBLIC_DESTINATION_ADDRESS_POLICY;
  const lines = [
    "//! Generated from the authoritative TypeScript public destination policy.",
    "//! Regenerate with `pnpm -F @okouai/api-contracts generate:rust`.",
    "",
    "pub const IPV4_NON_PUBLIC_RANGES: &[(u32, u32)] = &[",
    ...ipv4NonPublicRanges.map(([start, end]) => {
      return `    (${start}, ${end}),`;
    }),
    "];",
    "",
    ...Object.entries(ipv6).map(([name, value]) => {
      return `pub const IPV6_${name.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}: u16 = ${value};`;
    }),
    "",
  ];
  await writeFile(
    new URL(
      "../../../../../crates/api-contracts/src/generated/public_destination_policy.rs",
      import.meta.url,
    ),
    lines.join("\n"),
  );
}
