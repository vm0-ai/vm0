import { createHash } from "node:crypto";

export const PREFLIGHT_SCHEMA_VERSION =
  "vm0.agent-compose-consolidation-preflight.v6";

// Keep the accepted Stage 0 aggregate digests stable while the output schema
// grows additively. New sets use their own domain strings at each call site.
const FINGERPRINT_DOMAIN = "vm0:agent-compose-consolidation-preflight:v1";

export interface SetFingerprint {
  readonly count: number;
  readonly digest: string;
}

/**
 * Fingerprint a sorted opaque-member set with domain separation and
 * byte-length framing. Empty sets use the SHA-256 of the framed empty domain,
 * so every output field always has a deterministic 64-character digest.
 */
export function fingerprintSortedSet(
  domain: string,
  members: readonly string[],
): SetFingerprint {
  const uniqueMembers = [...new Set(members)].sort();
  const hash = createHash("sha256");
  hash.update(FINGERPRINT_DOMAIN);
  hash.update("\0");
  hash.update(domain);
  hash.update("\0");
  for (const member of uniqueMembers) {
    hash.update(Buffer.byteLength(member, "utf8").toString());
    hash.update(":");
    hash.update(member);
    hash.update("\0");
  }
  return { count: uniqueMembers.length, digest: hash.digest("hex") };
}

export function fingerprintMember(domain: string, member: string): string {
  return fingerprintSortedSet(domain, [member]).digest;
}
