import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { cliTokens } from "../../db/schema/cli-tokens";
import { deviceCodes } from "../../db/schema/device-codes";
import { generateCliToken } from "../../lib/auth/sandbox-token";

/**
 * Create a test CLI token in the database for authentication testing.
 * @why-db-direct Creates CLI token with specific expiry and org binding; no API route for test token creation
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
 * Clean up test CLI token from database.
 * @why-db-direct Deletes CLI token for cleanup; no API route for token deletion
 */
export async function deleteTestCliToken(token: string): Promise<void> {
  await globalThis.services.db
    .delete(cliTokens)
    .where(eq(cliTokens.token, token));
}

/**
 * Create a test device code directly in the database.
 * @why-db-direct Creates device code with specific status/expiry; POST /api/cli/auth/device only creates pending codes with server-controlled expiration
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
