import { toASCII, type ToASCIIOptions } from "tr46";

/**
 * Hostname identity accepted by the API before firewall values cross to a
 * runner. The policy version changes only after a deliberate Unicode-data and
 * runner-compatibility review.
 */
export const FIREWALL_HOSTNAME_POLICY_VERSION = "vm0-uts46-16.0-v1";

const FIREWALL_HOSTNAME_TO_ASCII_OPTIONS = {
  checkBidi: true,
  checkHyphens: false,
  checkJoiners: true,
  ignoreInvalidPunycode: false,
  transitionalProcessing: false,
  useSTD3ASCIIRules: false,
  verifyDNSLength: true,
} as const satisfies ToASCIIOptions;

/**
 * Return the fixed-policy ASCII identity for a dot-separated DNS hostname.
 * Callers remain responsible for vm0's stricter raw-input and IP-literal
 * checks before invoking this UTS #46 mapping step.
 */
export function canonicalizeFirewallDnsHostname(
  hostname: string,
): string | null {
  return toASCII(hostname, FIREWALL_HOSTNAME_TO_ASCII_OPTIONS);
}
