import crypto from "crypto";

// Characters that are easy to read (excluding 0/O, 1/I/L)
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generate a random code using unbiased cryptographic randomness.
 * Format: XXXX-XXXX (8 characters with a dash in the middle)
 *
 * Uses crypto.randomInt() which provides unbiased sampling,
 * unlike randomBytes + modulo which introduces bias when the
 * byte range (256) is not evenly divisible by the character set size.
 */
export function generateCode(): string {
  let code = "";

  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += CHARS[crypto.randomInt(CHARS.length)];
  }

  return code;
}
