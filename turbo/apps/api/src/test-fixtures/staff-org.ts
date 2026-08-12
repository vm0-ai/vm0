import { randomUUID } from "node:crypto";

import { STAFF_ORG_ID_HASHES, fnv1a } from "@vm0/core/identity-hash";

const FNV_PRIME = 16_777_619;
// Multiplicative inverse of FNV_PRIME modulo 2^32.
const FNV_PRIME_INVERSE = 899_433_627;
const COLLISION_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function advanceFnv1a(hash: number, character: string): number {
  return Math.imul(hash ^ character.charCodeAt(0), FNV_PRIME) >>> 0;
}

function reverseFnv1a(hash: number, character: string): number {
  return (Math.imul(hash, FNV_PRIME_INVERSE) ^ character.charCodeAt(0)) >>> 0;
}

function staffCollisionSuffix(
  prefix: string,
  targetHash: number,
): string | null {
  // Meet in the middle over two three-character halves instead of scanning
  // all 62^6 suffixes. FNV-1a is reversible one character at a time.
  const prefixHash = Number.parseInt(fnv1a(prefix), 16);
  const firstHalves = new Map<number, string>();
  for (const first of COLLISION_ALPHABET) {
    for (const second of COLLISION_ALPHABET) {
      for (const third of COLLISION_ALPHABET) {
        const hash = advanceFnv1a(
          advanceFnv1a(advanceFnv1a(prefixHash, first), second),
          third,
        );
        firstHalves.set(hash, `${first}${second}${third}`);
      }
    }
  }

  for (const fourth of COLLISION_ALPHABET) {
    for (const fifth of COLLISION_ALPHABET) {
      for (const sixth of COLLISION_ALPHABET) {
        const precedingHash = reverseFnv1a(
          reverseFnv1a(reverseFnv1a(targetHash, sixth), fifth),
          fourth,
        );
        const firstHalf = firstHalves.get(precedingHash);
        if (firstHalf) {
          return `${firstHalf}${fourth}${fifth}${sixth}`;
        }
      }
    }
  }
  return null;
}

/**
 * Creates a unique organization that exercises the production staff hash gate
 * without using a production organization identity.
 */
export function createUniqueStaffOrgIdFixture(): string {
  const targetHashHex = STAFF_ORG_ID_HASHES[0];
  if (!targetHashHex) {
    throw new Error("Expected at least one configured staff organization hash");
  }
  const targetHash = Number.parseInt(targetHashHex, 16);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const prefix = `org_${randomUUID()}_`;
    const suffix = staffCollisionSuffix(prefix, targetHash);
    if (suffix) {
      return `${prefix}${suffix}`;
    }
  }
  throw new Error("Failed to generate a unique staff organization fixture");
}
