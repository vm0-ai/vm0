import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { cliTokens } from "../../db/schema/cli-tokens";
import { deviceCodes } from "../../db/schema/device-codes";
import { generateCliToken } from "../../lib/auth/sandbox-token";

// ============================================================================
// CLI Token Test Helpers
// ============================================================================

/**
 * Create a test CLI token in the database for authentication testing
 *
 * @param userId - The user ID to associate with the token
 * @param expiresAt - When the token expires (default: 1 hour from now)
 * @returns The generated token string
 */
export async function createTestCliToken(
  userId: string,
  expiresAt?: Date,
  orgId?: string,
): Promise<string> {
  const expiration = expiresAt || new Date(Date.now() + 60 * 60 * 1000); // 1 hour default
  const tokenId = randomUUID();

  // Generate CLI JWT containing userId, orgId, and tokenId for revocation checks
  const token = await generateCliToken(
    userId,
    orgId ?? `org_mock_${userId}`,
    tokenId,
  );

  await globalThis.services.db.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "Test Token",
    expiresAt: expiration,
  });

  return token;
}

/**
 * Clean up test CLI token from database
 *
 * @param token - The token string to delete
 */
export async function deleteTestCliToken(token: string): Promise<void> {
  await globalThis.services.db
    .delete(cliTokens)
    .where(eq(cliTokens.token, token));
}

/**
 * Create a test device code directly in the database.
 * Uses direct DB insert because no API route exists for creating
 * denied/expired device codes — the POST /api/cli/auth/device route
 * always creates "pending" codes with server-controlled expiration.
 *
 * @param options - Device code options
 * @param options.status - The device code status (default: "pending")
 * @param options.userId - The user ID (required for "authenticated" status)
 * @param options.expiresAt - When the code expires (default: 15 minutes from now)
 * @returns The device code string
 */
export async function createTestDeviceCode(options?: {
  status?: "pending" | "authenticated" | "expired" | "denied";
  userId?: string;
  orgId?: string;
  expiresAt?: Date;
}): Promise<string> {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = () => {
    return Array.from({ length: 4 }, () => {
      return chars[Math.floor(Math.random() * chars.length)];
    }).join("");
  };
  const code = `${part()}-${part()}`;

  const status = options?.status ?? "pending";
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000);

  await globalThis.services.db.insert(deviceCodes).values({
    code,
    status,
    userId: options?.userId ?? null,
    orgId: options?.orgId ?? null,
    expiresAt,
  });

  return code;
}

/**
 * Find a device code by its code string.
 *
 * @param code - The device code to look up
 * @returns The device code row or undefined
 */
export async function findTestDeviceCode(code: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.code, code))
    .limit(1);
  return row;
}

/**
 * Find a CLI token by its token string.
 *
 * @param token - The token to look up
 * @returns The CLI token row or undefined
 */
export async function findTestCliToken(token: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(eq(cliTokens.token, token))
    .limit(1);
  return row;
}
