import crypto from "crypto";

// Characters that are easy to read (excluding 0/O, 1/I/L)
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generate a random code using unbiased cryptographic randomness.
 *
 * Format: groups of 4 characters joined by "-" (e.g. "XXXX-XXXX" for the
 * default 8-char length, "XXXX-XXXX-XXXX-XXXX" for 16, …).
 *
 * Uses crypto.randomInt() which provides unbiased sampling, unlike
 * randomBytes + modulo which introduces bias when the byte range (256)
 * is not evenly divisible by the character set size.
 */
export function generateCode(length: number = 8): string {
  let code = "";

  for (let i = 0; i < length; i++) {
    if (i > 0 && i % 4 === 0) code += "-";
    code += CHARS[crypto.randomInt(CHARS.length)];
  }

  return code;
}
